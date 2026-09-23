// Official tower benchmark (docs/ECONOMY.md section 3). Owned by the Bench agent, alongside
// docs/BENCH.md. Measures mass destroyed per second (MDS) for every tower/upgrade combo in a
// controlled arena and grades efficiency against the docs/ECONOMY.md 3.2 target curve.
//
// Usage:
//   node tools/bench.mjs                          full run, every tower, default config set
//   node tools/bench.mjs --tower pulse             one tower only
//   node tools/bench.mjs --tower pulse --config 5-2-0   one tower, one upgrade combo
//   node tools/bench.mjs --scenario SWARM          one scenario only (SWARM|DENSE|SHIP|MIXED)
//   node tools/bench.mjs --json out/bench.json     also write full results as JSON
//   node tools/bench.mjs --quick                   short warm-up/measure window (dev iteration)
//   node tools/bench.mjs --phantom                 also run the optional SWARM_PHANTOM scenario
//   node tools/bench.mjs --selftest                validate the bench itself (see docs/BENCH.md)
//
// See docs/BENCH.md for the full methodology: arena layout, the adaptive spawner, how each
// scenario fixes a flaw in the naive ECONOMY.md 3.1 spec, and how utility/income/support towers
// are graded differently from damage towers.
//
// This file and docs/BENCH.md are the only files this agent owns. It never edits src/**; all
// enemy/map data it needs that doesn't exist in the real game (a straight test channel, a
// synthetic "dense" meteor, a synthetic "ship" target) is registered at runtime into the
// imported MAPS/ENEMIES objects, inside this process only. It never touches the data files on
// disk, so it cannot collide with other agents editing src/data/**.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { Sim } from '../src/sim/game.js';
import { MAPS } from '../src/data/maps.js';
import { ENEMIES } from '../src/data/enemies.js';
import { TOWERS, TOWER_LIST } from '../src/data/towers/index.js';
import { computeBaseStats, finalizeStats } from '../src/sim/towers.js';
import { priceFor, ETA0, TIER_EFFICIENCY, EFFICIENCY_TOLERANCE } from '../src/data/economy.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TICK = 1 / 60;

// ============================================================================================
// Arena: a straight test channel, registered at runtime (never written to src/data/maps.js).
// ============================================================================================
const ARENA_ID = '__bench_arena__';
const ARENA_PATH_WIDTH = 56;
const CHANNEL_X0 = 40, CHANNEL_X1 = 1460, CHANNEL_Y = 500;   // stays inside the 1500x1000 world
// on-screen margin so every spawn is inside findTarget's onScreen() check (docs/ARCHITECTURE.md
// notes towers cannot target off-screen enemies; the channel already keeps clear of the edges)
const MAIN_TOWER_X = 750;      // single-tower scenarios: tower sits here, beside the channel
const UTIL_REF_X = 900;   // utility protection test: reference Pulse here, utility tower across the channel
const BEACON_X = 750, BEACON_REF_DX = [-135, -45, 45, 135]; // beacon + 4 reference towers

function ensureArena() {
  if (MAPS[ARENA_ID]) return;
  MAPS[ARENA_ID] = {
    id: ARENA_ID, name: 'Bench Arena', difficulty: 'Beginner', order: 0,
    background: null, palette: {},
    pathWidth: ARENA_PATH_WIDTH, lanes: 'single',
    paths: [[[CHANNEL_X0, CHANNEL_Y], [CHANNEL_X1, CHANNEL_Y]]],
    core: { x: CHANNEL_X1, y: CHANNEL_Y },
    blockers: [], props: [],
  };
}

// Synthetic bench-only enemies (docs/ECONOMY.md 3.1 fixes): a 20 HP, no-children, no-immunity
// "dense" meteor (the naive spec's Obsidian Heart chain includes BLAST/CRYO-immune children,
// which unfairly penalizes BLAST/CRYO towers in a scenario meant to test raw sustained DPS) and
// an effectively unkillable "ship" target (so the SHIP scenario measures single-target DPS +
// shipDamage bonuses without ever needing a fresh hull mid-measurement).
const DENSE_HP = 20;
const SHIP_HP = 1e9;
function ensureBenchEnemies() {
  if (!ENEMIES.__bench_dense__) {
    ENEMIES.__bench_dense__ = {
      id: '__bench_dense__', name: 'Bench Dense Target', kind: 'meteor',
      speed: 1.4, hp: DENSE_HP, immune: [], children: [], radius: 14, color: '#e5e5e5',
      mass: DENSE_HP, hullMass: 0, meteorMass: DENSE_HP, shells: 1, _derived: true,
    };
  }
  if (!ENEMIES.__bench_ship__) {
    ENEMIES.__bench_ship__ = {
      id: '__bench_ship__', name: 'Bench Ship Target', kind: 'ship',
      speed: 0.2, hp: SHIP_HP, immune: [], children: [], radius: 40, color: '#e5e5e5',
      mass: SHIP_HP, hullMass: SHIP_HP, meteorMass: 0, shells: 1, _derived: true,
    };
  }
}

// ============================================================================================
// Sim / tower setup helpers
// ============================================================================================
function newArenaSim(seed = 1) {
  ensureArena(); ensureBenchEnemies();
  const sim = new Sim({ mapId: ARENA_ID, difficulty: 'pilot', seed });
  sim.state.cash = 1e9;                 // never gate placement/upgrades on credits
  sim.state.lives = 1e18; sim.state.maxLives = 1e18; // a stray leak must never end the run
  return sim;
}

// Perpendicular offset that puts a tower of this def just outside the channel edge.
function towerY(def) {
  const r = def.radius || 22;
  const clear = ARENA_PATH_WIDTH / 2 + r + 6;
  return CHANNEL_Y - clear;
}
// The mirror spot on the other side of the channel (utility test).
function utilY(def) {
  const r = def.radius || 22;
  return CHANNEL_Y + ARENA_PATH_WIDTH / 2 + r + 6;
}

function placeConfigured(sim, type, levels, x, y) {
  const r = sim.placeTower(type, x, y);
  if (!r.ok) throw new Error(`placeTower(${type}) at ${x},${y} failed: ${r.reason}`);
  const id = r.id;
  for (let p = 0; p < 3; p++) {
    for (let k = 0; k < levels[p]; k++) {
      const u = sim.upgrade(id, p);
      if (!u.ok) throw new Error(`upgrade(${type}, path ${p}) tier ${k + 1} failed: ${u.reason} (levels ${levels})`);
    }
  }
  return sim.getTower(id);
}

function totalCostFor(def, levels) {
  let total = priceFor(def.cost, 'pilot');
  for (let p = 0; p < 3; p++) {
    const ups = (def.paths[p] && def.paths[p].upgrades) || [];
    for (let k = 0; k < levels[p]; k++) if (ups[k]) total += priceFor(ups[k].cost, 'pilot');
  }
  return total;
}

// The along-path window a tower can reach, using the perpendicular distance from the tower to
// the path it actually sits beside (works for any tower placement, not just the arena's).
// range === Infinity (or no finite hint) means "anywhere on screen": the whole channel.
function coverageWindow(sim, tower) {
  // Mortar-style towers hit around their aim point, not around the tower: the window is the
  // stretch of channel under the shells (aim +- splash radius plus a margin).
  const mortar = tower.stats._attackList.find((a) => a.kind === 'mortar');
  if (mortar) {
    const aim = tower.aim || tower.data.defaultAim;
    const na = sim.nearestPathPoint(aim.x, aim.y);
    const La = sim.pathLength(na.lane);
    const reachA = (mortar.splash ? mortar.splash.radius : 50) + (mortar.inaccuracy || 0) + 40;
    return { lane: na.lane, start: Math.max(0, na.d - reachA), end: Math.min(La, na.d + reachA), infinite: false };
  }
  const np = sim.nearestPathPoint(tower.x, tower.y);
  const L = sim.pathLength(np.lane);
  let range = tower.stats.range;
  if (!Number.isFinite(range) || range <= 0) {
    for (const a of tower.stats._attackList) {
      if (a.kind === 'drone' && Number.isFinite(a.patrol) && a.patrol > 0) { range = a.patrol; break; }
    }
  }
  if (!Number.isFinite(range) || range <= 0) return { lane: np.lane, start: 0, end: L, infinite: true };
  const reach = Math.max(30, Math.sqrt(Math.max(0, range * range - np.dist * np.dist)));
  return { lane: np.lane, start: Math.max(0, np.d - reach), end: Math.min(L, np.d + reach), infinite: false };
}

// ============================================================================================
// The adaptive spawner + measurement engine. Keeps `targetN` live enemies within reach of the
// given towers at all times (checked and topped up every tick, spawned just upstream of the
// engagement window), so no scenario is ever bottlenecked by supply, only by what the tower(s)
// can actually kill. This is what fixes the naive spec's "10 Jade/s caps SWARM at 30 mass/s"
// flaw: there is no fixed spawn rate at all.
// MDS is measured as the sum of the towers' own `damage` stat (real mass eliminated: the engine
// already clamps it to actual shell HP removed, including recursive overflow into children, and
// never counts overkill beyond a family's remaining mass), delta across the measurement window,
// divided by the window length. A warm-up window runs first (untimed) so cooldowns, beam ramps,
// drone positioning etc. settle before measurement starts.
function windowFor(sim, towers) {
  let lane = 0, start = Infinity, end = -Infinity, infinite = false;
  for (const t of towers) {
    const w = coverageWindow(sim, t);
    lane = w.lane;
    if (w.infinite) infinite = true;
    start = Math.min(start, w.start);
    end = Math.max(end, w.end);
  }
  return { lane, start, end, infinite };
}

// `win` (optional) fixes the engagement window, so two runs that differ only by a buff or a
// utility tower spawn into the same stretch of channel.
function runAdaptiveMulti(sim, towers, { warmup, measure, targetN, pick, phantom = false, win = null }) {
  const { lane, start, end, infinite } = win || windowFor(sim, towers);
  const spawnBase = infinite ? 10 : start;
  let cycle = 0;
  function topUp() {
    // Only enemies still inside (or upstream of) the engagement window count toward the
    // population: meteors that already slipped past the tower cannot be shot any more, so
    // counting them would starve short-range towers.
    let alive = 0;
    const list = sim.state.enemies;
    for (let i = 0; i < list.length; i++) { const e = list[i]; if (!e.dead && (infinite || e.d <= end)) alive++; }
    let spawned = 0;
    while (alive + spawned < targetN && spawned < 60) {
      const type = pick(cycle++);
      const d = infinite ? spawnBase : Math.min(end - 5, spawnBase + spawned * 16);
      const off = (sim.rng() - 0.5) * 40;
      sim.spawnEnemy(type, { lane, d, wave: 1, off, phantom });
      spawned++;
    }
  }
  const warmTicks = Math.max(1, Math.round(warmup / TICK));
  const measureTicks = Math.max(1, Math.round(measure / TICK));
  for (let i = 0; i < warmTicks; i++) { topUp(); sim.step(); if ((i & 255) === 0) sim.drainEvents(); }
  sim.drainEvents();
  const d0 = towers.map((t) => t.damage);
  for (let i = 0; i < measureTicks; i++) { topUp(); sim.step(); if ((i & 255) === 0) sim.drainEvents(); }
  sim.drainEvents();
  const dealt = towers.reduce((s, t, i) => s + (t.damage - d0[i]), 0);
  return dealt / measure;
}

// ============================================================================================
// Scenario definitions
// ============================================================================================
const MIXED_CYCLE = ['iron', 'magma', 'comet', 'prism', 'geode'];
const SCENARIOS = {
  // SWARM: Rose shards (mass 5, fast), not Jade. Combined with the adaptive spawner this fixes
  // the naive spec's supply cap (10 Jade/s * mass 3 = a hard 30 mass/s ceiling no tower could
  // ever exceed). Rewards pierce, area and fire rate (ECONOMY.md 3.1).
  SWARM: { targetN: 12, pick: () => 'rose' },
  // DENSE: a synthetic 20 HP, no-children, no-immunity meteor, not a real Obsidian Heart (whose
  // grandchildren include BLAST- and CRYO-immune types, unfairly penalizing those damage types
  // in what should be a clean sustained-DPS test). Rewards damage per hit and type coverage.
  DENSE: { targetN: 5, pick: () => '__bench_dense__' },
  // SHIP: a synthetic near-infinite-hull ship, not a real Dreadnought (which would eventually
  // die and force a supply-limited respawn). Single target, rewards raw DPS and shipDamage.
  SHIP: { targetN: 1, pick: () => '__bench_ship__' },
  // MIXED: the five real Iron/Magma/Comet/Prism/Geode meteors, cycled, testing damage-type
  // coverage (each is immune to at least one dtype).
  MIXED: { targetN: 8, pick: (i) => MIXED_CYCLE[i % MIXED_CYCLE.length] },
  // Optional (--phantom): SWARM but every enemy is Phantom, testing detection coverage.
  SWARM_PHANTOM: { targetN: 12, pick: () => 'rose', phantom: true },
};
const CORE_SCENARIOS = ['SWARM', 'DENSE', 'SHIP', 'MIXED'];

// ============================================================================================
// docs/ECONOMY.md 3.2 primary/secondary table, hardcoded here (this file owns the bench
// methodology; the table itself is the fixed contract in the doc).
// ============================================================================================
const PRIMARY = {
  pulse:   { primary: ['SWARM'], secondary: ['SHIP'], kind: 'damage' },
  scatter: { primary: ['SWARM'], secondary: ['DENSE'], kind: 'damage' },
  rail:    { primary: ['DENSE', 'SHIP'], secondary: [], kind: 'damage' },
  missile: { primary: ['SWARM', 'DENSE'], secondary: ['SHIP'], kind: 'damage' },
  tesla:   { primary: ['SWARM', 'MIXED'], secondary: ['SHIP'], kind: 'damage' },
  laser:   { primary: ['SHIP', 'DENSE'], secondary: [], kind: 'damage' },
  drone:   { primary: ['SWARM'], secondary: ['SHIP'], kind: 'damage' },
  mortar:  { primary: ['SWARM'], secondary: ['DENSE'], kind: 'damage' },
  cryo:    { primary: [], secondary: ['SWARM'], kind: 'utility' },
  gravity: { primary: [], secondary: ['SWARM'], kind: 'utility' },
  rig:     { primary: [], secondary: [], kind: 'income' },
  beacon:  { primary: [], secondary: [], kind: 'support' },
};

// ============================================================================================
// Config set: 0-0-0, each single path 1..5, and a representative set of crosspaths.
// ============================================================================================
function singlePathConfigs() {
  const out = [[0, 0, 0]];
  for (const t of [1, 2, 3, 4, 5]) { out.push([t, 0, 0]); out.push([0, t, 0]); out.push([0, 0, t]); }
  return out;
}
const CROSS5 = [[5, 2, 0], [5, 0, 2], [2, 5, 0], [0, 5, 2], [2, 0, 5], [0, 2, 5]];
const CROSS4 = [[4, 2, 0], [0, 4, 2], [2, 0, 4]]; // representative "4-2-0 style" crosspaths
const DEFAULT_CONFIGS = [...singlePathConfigs(), ...CROSS5, ...CROSS4];

function cfgLabel(levels) { return levels.join('-'); }

// ============================================================================================
// Damage towers: run every scenario, grade the best primary-scenario efficiency.
// ============================================================================================
function benchDamageTower(type, configs, opts) {
  const def = TOWERS[type];
  const meta = PRIMARY[type] || { primary: [], secondary: [] };
  const scenarios = opts.scenarios;
  const rows = [];
  for (const levels of configs) {
    const totalCost = totalCostFor(def, levels);
    const mds = {};
    for (const scen of scenarios) {
      const scenDef = SCENARIOS[scen];
      const sim = newArenaSim(opts.seed);
      const tower = placeConfigured(sim, type, levels, MAIN_TOWER_X, towerY(def));
      mds[scen] = runAdaptiveMulti(sim, [tower], { warmup: opts.warmup, measure: opts.measure, targetN: scenDef.targetN, pick: scenDef.pick, phantom: !!scenDef.phantom });
    }
    const highestTier = Math.max(...levels);
    const target = ETA0 * TIER_EFFICIENCY[highestTier];
    const primaryRan = meta.primary.filter((s) => mds[s] !== undefined);
    let bestEta = null, status = 'INFO';
    if (def.stub) status = 'STUB';
    else if (primaryRan.length) {
      bestEta = Math.max(...primaryRan.map((s) => (mds[s] / totalCost) * 1000));
      const lo = target * (1 - EFFICIENCY_TOLERANCE), hi = target * (1 + EFFICIENCY_TOLERANCE);
      status = bestEta < lo ? 'LOW' : bestEta > hi ? 'HIGH' : 'PASS';
    }
    rows.push({ type, levels, totalCost, mds, highestTier, target, bestEta, status });
  }
  return rows;
}

// ============================================================================================
// Utility towers (Cryo, Gravity): protection factor. A reference Pulse Turret 2-0-0 sits
// downstream; the utility tower (at the config under test) sits upstream feeding the same
// adaptively-saturated SWARM stream through both. The "protection value" is the extra mass/s
// the corridor destroys with the utility tower helping (its own kills plus whatever the slow/
// freeze/expose lets the Pulse turret do better), benchmarked in the same mass-per-cost currency
// as every other tower so it can be graded against the same target curve (ECONOMY.md 3.3).
// massLeaked is also reported as a secondary, more literal "protection" signal.
function benchUtilityTower(type, configs, opts) {
  const def = TOWERS[type];
  const rows = [];
  for (const levels of configs) {
    const totalCost = totalCostFor(def, levels);
    const refDef = TOWERS.pulse;
    // The utility tower sits across the channel from the reference Pulse (same x), so its
    // field / pulse / lens overlaps the stretch the Pulse covers. Both runs spawn into the same
    // window, computed from the unassisted Pulse.
    const run = (phantom) => {
      const simA = newArenaSim(opts.seed);
      const pulseA = placeConfigured(simA, 'pulse', [2, 0, 0], UTIL_REF_X, towerY(refDef));
      const win = windowFor(simA, [pulseA]);
      const leaked0A = simA.state.stats.massLeaked;
      const alone = runAdaptiveMulti(simA, [pulseA], { warmup: opts.warmup, measure: opts.measure, targetN: 12, pick: () => 'rose', phantom, win });
      const leakedA = simA.state.stats.massLeaked - leaked0A;
      const simB = newArenaSim(opts.seed);
      const utilT = placeConfigured(simB, type, levels, UTIL_REF_X, utilY(def));
      const pulseB = placeConfigured(simB, 'pulse', [2, 0, 0], UTIL_REF_X, towerY(refDef));
      const leaked0B = simB.state.stats.massLeaked;
      const withU = runAdaptiveMulti(simB, [utilT, pulseB], { warmup: opts.warmup, measure: opts.measure, targetN: 12, pick: () => 'rose', phantom, win });
      const leakedW = simB.state.stats.massLeaked - leaked0B;
      return { alone, withU, leakedA, leakedW };
    };
    const plain = run(false);
    const ph = run(true);
    const mdsAlone = plain.alone, mdsWith = plain.withU, leakedAlone = plain.leakedA, leakedWith = plain.leakedW;
    // Graded on the better of the plain and the Phantom stream (Lens exists to expose Phantoms).
    const gainPhantom = ph.withU - ph.alone;
    const gainMDS = Math.max(mdsWith - mdsAlone, gainPhantom);
    const etaGain = totalCost > 0 ? (gainMDS / totalCost) * 1000 : 0;
    const highestTier = Math.max(...levels);
    const target = ETA0 * TIER_EFFICIENCY[highestTier];
    const lo = target * (1 - EFFICIENCY_TOLERANCE), hi = target * (1 + EFFICIENCY_TOLERANCE);
    const status = def.stub ? 'STUB' : (etaGain < lo ? 'LOW' : etaGain > hi ? 'HIGH' : 'PASS');
    rows.push({ type, levels, totalCost, mdsAlone, mdsWith, gainMDS, gainPhantom, etaGain, leakedAlone, leakedWith, target, status });
  }
  return rows;
}

// ============================================================================================
// Command Beacon: buff effect on 4 reference Pulse Turrets (2-0-0) clustered in its radius.
// Same mass-per-cost methodology as the utility test.
function benchBeacon(configs, opts) {
  const def = TOWERS.beacon;
  const refDef = TOWERS.pulse;
  const rows = [];
  for (const levels of configs) {
    const totalCost = totalCostFor(def, levels);
    // Both runs spawn into the window of the UNBUFFED reference towers (a range aura would
    // otherwise move the spawns upstream and change the test), and the population is large
    // enough that four Pulse Turrets are never supply-bound.
    const simA = newArenaSim(opts.seed);
    const refsA = BEACON_REF_DX.map((dx) => placeConfigured(simA, 'pulse', [2, 0, 0], BEACON_X + dx, towerY(refDef)));
    const win = windowFor(simA, refsA);
    const mdsAlone = runAdaptiveMulti(simA, refsA, { warmup: opts.warmup, measure: opts.measure, targetN: 30, pick: () => 'rose', win });

    const simB = newArenaSim(opts.seed);
    const refsB = BEACON_REF_DX.map((dx) => placeConfigured(simB, 'pulse', [2, 0, 0], BEACON_X + dx, towerY(refDef)));
    placeConfigured(simB, 'beacon', levels, BEACON_X, towerY(def) - 90);
    const mdsWith = runAdaptiveMulti(simB, refsB, { warmup: opts.warmup, measure: opts.measure, targetN: 30, pick: () => 'rose', win });

    const gainMDS = mdsWith - mdsAlone;
    const etaGain = totalCost > 0 ? (gainMDS / totalCost) * 1000 : 0;
    const highestTier = Math.max(...levels);
    const target = ETA0 * TIER_EFFICIENCY[highestTier];
    const lo = target * (1 - EFFICIENCY_TOLERANCE), hi = target * (1 + EFFICIENCY_TOLERANCE);
    const status = def.stub ? 'STUB' : (etaGain < lo ? 'LOW' : etaGain > hi ? 'HIGH' : 'PASS');
    rows.push({ type: 'beacon', levels, totalCost, mdsAlone, mdsWith, gainMDS, etaGain, target, status });
  }
  return rows;
}

// ============================================================================================
// Mining Rig: payback period P = totalCost / incomePerWave (at c(w) = 1), analytical, no sim run
// needed (ECONOMY.md 1.3). Target band [9, 14] waves, floor 8.
const RIG_TARGET_LO = 8, RIG_TARGET_BAND = [9, 14];
function benchRig(configs) {
  const def = TOWERS.rig;
  const rows = [];
  for (const levels of configs) {
    const stats = finalizeStats(computeBaseStats(def, levels), null, null);
    const inc = stats.income;
    const totalCost = totalCostFor(def, levels);
    if (!inc || !(inc.perWave > 0)) { rows.push({ type: 'rig', levels, totalCost, note: def.stub ? 'STUB (no income)' : 'no income' }); continue; }
    const P = totalCost / inc.perWave;
    const status = P < RIG_TARGET_LO ? 'LOW' : (P < RIG_TARGET_BAND[0] || P > RIG_TARGET_BAND[1]) ? 'WATCH' : 'PASS';
    rows.push({ type: 'rig', levels, totalCost, perWave: inc.perWave, P, vault: inc.vault || null, status });
  }
  return rows;
}

// ============================================================================================
// Self-test: validates the bench harness itself (not any tower's balance).
// ============================================================================================
function selfTest(opts) {
  console.log('\n=== bench self-test ===');
  let ok = true;
  const check = (cond, msg) => { console.log((cond ? '  ok   ' : '  FAIL ') + msg); if (!cond) ok = false; };

  // 1. determinism: same seed -> same MDS, bit for bit.
  const a = benchDamageTower('pulse', [[0, 0, 0]], { ...opts, scenarios: ['SWARM'], seed: 7 })[0].mds.SWARM;
  const b = benchDamageTower('pulse', [[0, 0, 0]], { ...opts, scenarios: ['SWARM'], seed: 7 })[0].mds.SWARM;
  check(a === b, `determinism: same seed gives identical SWARM MDS (${a} vs ${b})`);

  // 2. doubling damage roughly doubles SWARM and DENSE MDS. A shallow clone of the real Pulse
  // def with its main attack's damage doubled, registered under a throwaway id and removed
  // again right after (paths/upgrades are untouched, config stays 0-0-0, so only the base hit
  // damage changes).
  const base = TOWERS.pulse;
  const cloneDef = { ...base, paths: base.paths };
  cloneDef.base = { ...base.base, attacks: { main: { ...base.base.attacks.main, damage: base.base.attacks.main.damage * 2 } } };
  const benchId = '__bench_double__';
  TOWERS[benchId] = cloneDef;
  const normalSwarm = benchDamageTower('pulse', [[0, 0, 0]], { ...opts, scenarios: ['SWARM', 'DENSE'], seed: 3 })[0];
  const doubleSwarm = benchDamageTower(benchId, [[0, 0, 0]], { ...opts, scenarios: ['SWARM', 'DENSE'], seed: 3 })[0];
  delete TOWERS[benchId];
  // DENSE has no children (a flat 20 HP shell), so doubling damage should roughly double MDS
  // exactly. SWARM's Rose shards are a 5-layer chain of 1 HP shells: doubling damage lets one
  // hit's overflow cascade through an extra layer (docs/ARCHITECTURE.md 6, "Overflow"), so its
  // MDS can legitimately grow faster than 2x. Both are reported; only DENSE is a hard gate.
  {
    const ratio = doubleSwarm.mds.DENSE / normalSwarm.mds.DENSE;
    check(ratio > 1.6 && ratio < 2.4, `doubling damage roughly doubles DENSE MDS (ratio ${ratio.toFixed(2)}, base ${normalSwarm.mds.DENSE.toFixed(1)} -> ${doubleSwarm.mds.DENSE.toFixed(1)})`);
  }
  {
    const ratio = doubleSwarm.mds.SWARM / normalSwarm.mds.SWARM;
    check(ratio > 1.3, `doubling damage increases SWARM MDS (ratio ${ratio.toFixed(2)}, base ${normalSwarm.mds.SWARM.toFixed(1)} -> ${doubleSwarm.mds.SWARM.toFixed(1)}; >2x is expected and fine, it is 1 HP overflow cascading through Rose's child chain)`);
  }

  // 3. SHIP scenario is not supply-capped: a single almost-infinite-hull target keeps a base
  // Pulse Turret firing at essentially its own cooldown-limited rate for the whole window.
  const shipRow = benchDamageTower('pulse', [[0, 0, 0]], { ...opts, scenarios: ['SHIP'], seed: 5 })[0];
  const mainAtk = TOWERS.pulse.base.attacks.main;
  const theoreticalDps = mainAtk.damage / mainAtk.cooldown; // pierce 2 but only 1 target exists
  const frac = shipRow.mds.SHIP / theoreticalDps;
  check(frac > 0.75, `SHIP MDS (${shipRow.mds.SHIP.toFixed(2)}/s) is close to the tower's own cooldown-limited rate (${theoreticalDps.toFixed(2)}/s), not supply-limited (frac ${frac.toFixed(2)})`);

  console.log(ok ? 'RESULT: PASS' : 'RESULT: FAIL');
  return ok;
}

// ============================================================================================
// Printing
// ============================================================================================
function pad(s, n) { s = String(s); return s.length >= n ? s : s + ' '.repeat(n - s.length); }
function padL(s, n) { s = String(s); return s.length >= n ? s : ' '.repeat(n - s.length) + s; }
function fmt(n) { return Number.isFinite(n) ? n.toFixed(1) : String(n); }

function printDamageTable(type, rows, scenarios) {
  const def = TOWERS[type];
  console.log(`\n${def.name} (${type})${def.stub ? '  [STUB - placeholder data]' : ''}`);
  const header = pad('config', 9) + padL('cost', 8) + scenarios.map((s) => padL(s, 10)).join('') + padL('eta', 8) + padL('target', 8) + '  status';
  console.log('  ' + header);
  for (const r of rows) {
    let line = pad(cfgLabel(r.levels), 9) + padL(Math.round(r.totalCost), 8);
    for (const s of scenarios) line += padL(fmt(r.mds[s]), 10);
    line += padL(r.bestEta === null ? '-' : fmt(r.bestEta), 8) + padL(fmt(r.target), 8) + '  ' + r.status;
    console.log('  ' + line);
  }
}

function printUtilityTable(type, rows) {
  const def = TOWERS[type];
  console.log(`\n${def.name} (${type}) - protection factor${def.stub ? '  [STUB - placeholder data]' : ''}`);
  console.log('  ' + pad('config', 9) + padL('cost', 8) + padL('MDSalone', 10) + padL('MDSwith', 10) + padL('gain', 8) + padL('etaGain', 9) + padL('target', 8) + padL('leakA', 8) + padL('leakW', 8) + '  status');
  for (const r of rows) {
    console.log('  ' + pad(cfgLabel(r.levels), 9) + padL(Math.round(r.totalCost), 8) + padL(fmt(r.mdsAlone), 10) + padL(fmt(r.mdsWith), 10)
      + padL(fmt(r.gainMDS), 8) + padL(fmt(r.etaGain), 9) + padL(fmt(r.target), 8) + padL(fmt(r.leakedAlone), 8) + padL(fmt(r.leakedWith), 8) + '  ' + r.status);
  }
}

function printBeaconTable(rows) {
  const def = TOWERS.beacon;
  console.log(`\nCommand Beacon (beacon) - buff on 4 reference Pulse Turrets (2-0-0)${def.stub ? '  [STUB - placeholder data]' : ''}`);
  console.log('  ' + pad('config', 9) + padL('cost', 8) + padL('MDSalone', 10) + padL('MDSwith', 10) + padL('gain', 8) + padL('etaGain', 9) + padL('target', 8) + '  status');
  for (const r of rows) {
    console.log('  ' + pad(cfgLabel(r.levels), 9) + padL(Math.round(r.totalCost), 8) + padL(fmt(r.mdsAlone), 10) + padL(fmt(r.mdsWith), 10)
      + padL(fmt(r.gainMDS), 8) + padL(fmt(r.etaGain), 9) + padL(fmt(r.target), 8) + '  ' + r.status);
  }
}

function printRigTable(rows) {
  const def = TOWERS.rig;
  console.log(`\nMining Rig (rig) - payback period P = totalCost / incomePerWave${def.stub ? '  [STUB - placeholder data]' : ''}`);
  console.log('  ' + pad('config', 9) + padL('cost', 8) + padL('perWave', 9) + padL('P(waves)', 10) + '  status/note');
  for (const r of rows) {
    if (r.note) { console.log('  ' + pad(cfgLabel(r.levels), 9) + padL(Math.round(r.totalCost), 8) + '        -         -  ' + r.note); continue; }
    console.log('  ' + pad(cfgLabel(r.levels), 9) + padL(Math.round(r.totalCost), 8) + padL(fmt(r.perWave), 9) + padL(fmt(r.P), 10) + '  ' + r.status);
  }
}

// ============================================================================================
// CLI
// ============================================================================================
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const flag = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] !== undefined && !args[i + 1].startsWith('--') ? args[i + 1] : d; };
  const has = (n) => args.includes('--' + n);

  if (has('selftest')) {
    const ok = selfTest({ warmup: 1, measure: 4 });
    process.exit(ok ? 0 : 1);
  }

  const quick = has('quick');
  const opts = { warmup: quick ? 1 : 3, measure: quick ? 6 : 30, seed: Number(flag('seed', 1)) };
  const towerFilter = flag('tower', null);
  const configFlag = flag('config', null);
  const scenarioFlag = flag('scenario', null);
  const jsonPath = flag('json', null);
  const includePhantom = has('phantom');

  if (towerFilter && !TOWERS[towerFilter]) { console.error('Unknown tower: ' + towerFilter); process.exit(1); }
  if (scenarioFlag && !SCENARIOS[scenarioFlag]) { console.error('Unknown scenario: ' + scenarioFlag + ' (expected one of ' + Object.keys(SCENARIOS).join(', ') + ')'); process.exit(1); }

  let configs = DEFAULT_CONFIGS;
  if (configFlag) {
    const levels = configFlag.split('-').map(Number);
    if (levels.length !== 3 || levels.some((n) => !Number.isInteger(n) || n < 0 || n > 5)) { console.error('Invalid --config, expected a-b-c with each 0..5'); process.exit(1); }
    configs = [levels];
  }

  let scenarios = scenarioFlag ? [scenarioFlag] : CORE_SCENARIOS.slice();
  if (includePhantom && !scenarioFlag) scenarios.push('SWARM_PHANTOM');

  const towers = towerFilter ? [towerFilter] : TOWER_LIST;
  const t0 = performance.now();
  const allResults = { towers: {}, meta: { warmup: opts.warmup, measure: opts.measure, seed: opts.seed, configs: configs.map(cfgLabel), scenarios } };

  for (const type of towers) {
    const meta = PRIMARY[type] || { kind: 'damage' };
    if (meta.kind === 'utility') {
      const rows = benchUtilityTower(type, configs, opts);
      printUtilityTable(type, rows);
      allResults.towers[type] = { kind: 'utility', rows };
    } else if (type === 'beacon') {
      const rows = benchBeacon(configs, opts);
      printBeaconTable(rows);
      allResults.towers[type] = { kind: 'support', rows };
    } else if (type === 'rig') {
      const rows = benchRig(configs);
      printRigTable(rows);
      allResults.towers[type] = { kind: 'income', rows };
    } else {
      const rows = benchDamageTower(type, configs, { ...opts, scenarios });
      printDamageTable(type, rows, scenarios);
      allResults.towers[type] = { kind: 'damage', rows };
    }
  }

  const ms = performance.now() - t0;
  console.log(`\n${towers.length} tower(s), ${configs.length} config(s) each, ${scenarios.length} scenario(s), ${ms.toFixed(0)} ms`);

  if (jsonPath) {
    const outPath = path.isAbsolute(jsonPath) ? jsonPath : path.join(ROOT, jsonPath);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(allResults, null, 2));
    console.log('wrote ' + path.relative(ROOT, outPath));
  }
}

export { benchDamageTower, benchUtilityTower, benchBeacon, benchRig, selfTest, DEFAULT_CONFIGS, SCENARIOS, PRIMARY, runAdaptiveMulti, windowFor, newArenaSim, placeConfigured, towerY, totalCostFor, MAIN_TOWER_X };
