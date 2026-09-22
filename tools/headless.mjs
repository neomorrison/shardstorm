// Headless simulation runner with bots (public Sim commands only).
//
// Usage:
//   node tools/headless.mjs --map crater --difficulty pilot --bot solid --waves 80 --seed 1 [--quiet] [--hash]
//   node tools/headless.mjs --perf [--enemies 1500 --towers 40 --ticks 600 --projectiles 800]
//   Test-only overrides: --god (practically infinite Core Integrity), --cash N (starting credits).
//
// Bots:
//   novice  cheap towers at random legal spots near the path, never above tier 2
//   solid   greedy: best estimated power per credit, saves up for big upgrades, keeps some cash
//   eco     solid plus Mining Rigs (when the 'rig' tower exists) and vault withdrawals
//
// Prints one line per cleared wave: wave, cash, lives, towers, mass, leaked, ms.
// Exits 1 on exceptions or NaN state.
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Sim } from '../src/sim/game.js';
import { buildWave } from '../src/sim/wavegen.js';
import { TOWERS, TOWER_LIST } from '../src/data/towers/index.js';
import { computeBaseStats, finalizeStats } from '../src/sim/towers.js';
import { Rng } from '../src/core/rng.js';
import { ENEMIES, familyMass } from '../src/data/enemies.js';

// ------------------------------------------------------------------ power heuristics
// A small analytic model of how much mass a tower destroys per second against the upcoming
// waves: stream density limits pierce and splash, shell layers limit useful damage per hit,
// immunities and Phantom remove part of the stream, and a tower cannot destroy more than the
// stream supplies. Bots only read public data (wave previews, tower stats) for this.
const envCache = new Map();
export function waveEnv(sim, w) {
  const key = sim.lanes * 100000 + w;
  let env = envCache.get(key);
  if (env) return env;
  const spec = buildWave(w, { lanes: sim.lanes });
  let count = 0, speedSum = 0, mass = 0, shipMass = 0, phantomMass = 0;
  const immuneMass = {};
  for (const g of spec.groups) {
    const d = ENEMIES[g.type];
    if (!d) continue;
    const m = familyMass(g.type, spec.hullMult || 1, !!(g.mods && g.mods.plated)) * g.count;
    count += g.count; speedSum += g.count * d.speed; mass += m;
    if (d.kind === 'ship') shipMass += m;
    if ((g.mods && g.mods.phantom) || d.phantom) phantomMass += m;
    // immune share: the top shell plus, roughly, half of its family
    for (const dt of d.immune) immuneMass[dt] = (immuneMass[dt] || 0) + m * 0.6;
    if (d.children.length) {
      for (const [c] of d.children) for (const dt of ENEMIES[c].immune) immuneMass[dt] = (immuneMass[dt] || 0) + m * 0.25;
    }
  }
  const dur = Math.max(6, spec.duration || 12);
  const v = Math.max(20, (speedSum / Math.max(1, count)) * 90 * (spec.speedMult || 1));
  env = {
    rho: count / dur / v,                  // top-level enemies per unit of path
    layers: Math.max(1, mass / Math.max(1, count)),
    supply: mass / dur,                    // mass per second entering the map
    shipFrac: mass > 0 ? shipMass / mass : 0,
    phantomFrac: mass > 0 ? phantomMass / mass : 0,
    immuneFrac: (dt) => (mass > 0 ? Math.min(1, (immuneMass[dt] || 0) / mass) : 0),
  };
  if (envCache.size > 400) envCache.clear();
  envCache.set(key, env);
  return env;
}

function hitsAlong(p, env) { return Math.min(p, 1 + env.rho * 70); }
function hitsSplash(sp, env) { return Math.min(sp.pierce, 1 + env.rho * sp.radius * 2.6); }
function dmgUse(d, env) { return Math.min(Math.max(0, d), env.layers); }

function perShot(a, env) {
  const crit = a.crit ? 1 + a.crit.chance * (a.crit.mult - 1) : 1;
  const count = a.count || 1;
  let v = 0;
  switch (a.kind) {
    case 'projectile':
      v = dmgUse(a.damage * crit, env) * hitsAlong(a.pierce, env) * count * (a.radial ? 0.45 : 1);
      if (a.splash) v += dmgUse(a.splash.damage, env) * hitsSplash(a.splash, env) * count;
      if (a.split) v += 0.5 * count * a.split.count * perShot(a.split.attack, env);
      break;
    case 'hitscan':
      v = dmgUse(a.damage * crit, env) * (a.line ? hitsAlong(a.pierce, env) : 1) * count;
      if (a.splash) v += dmgUse(a.splash.damage, env) * hitsSplash(a.splash, env);
      if (a.shrapnel) v += 0.5 * a.shrapnel.count * dmgUse(a.shrapnel.damage, env);
      break;
    case 'chain': v = dmgUse(a.damage, env) * (1 + Math.min(a.jumps, env.rho * a.jumpRange * 3)) * count; break;
    case 'pulse': v = dmgUse(a.damage, env) * Math.min(a.pierce, 1 + env.rho * a.radius * 2); break;
    case 'mortar': v = dmgUse(a.splash.damage, env) * hitsSplash(a.splash, env) * count; break;
    default: v = 0;
  }
  v += (a.shipDamage || 0) * env.shipFrac * count;
  return v;
}

function attackPower(a, env) {
  switch (a.kind) {
    case 'beam': return a.dps * a.beams * (1 + Math.min(a.rampMax, 4)) / 2;
    case 'field': return (a.dps || 0) * Math.min(8, 1 + env.rho * a.radius * 2) + (a.slow ? (1 - a.slow.mult) * env.supply * 0.3 : 0);
    case 'drone': return a.count * attackPower(a.weapon, env);
    case 'custom': return 0;
    default: return perShot(a, env) / Math.max(0.02, a.cooldown);
  }
}

export function towerPower(sim, stats, x, y, env) {
  if (!env) env = waveEnv(sim, sim.state.wave + 1);
  let p = 0;
  for (const a of stats._attackList) {
    let cov;
    if (a.kind === 'mortar') cov = 1.3;
    else if (a.range === Infinity) cov = 1.5;
    else {
      const r = a.kind === 'drone' ? a.patrol : (a.radius ?? a.range);
      cov = Math.pow(Math.max(0.02, sim.pathCoverage(x, y, r) / 300), 0.3);
    }
    let q = attackPower(a, env) * cov;
    const byp = a.bypass || [];
    if (byp.indexOf(a.dtype) < 0) q *= 1 - env.immuneFrac(a.dtype);
    if (!stats.detection && !a.detection) q *= 1 - env.phantomFrac * 0.9;
    p += q;
  }
  // a single tower cannot destroy more than the stream supplies
  const cap = Math.max(1, env.supply * 0.9);
  return p <= cap ? p : cap + (p - cap) * 0.15;
}

// ------------------------------------------------------------------ spots
function buildSpots(sim, step = 18) {
  const spots = [];
  for (let y = step; y < 1000; y += step) {
    for (let x = step; x < 1500; x += step) {
      const np = sim.nearestPathPoint(x, y);
      if (np.dist > 320) continue;
      spots.push({ x, y, dist: np.dist });
    }
  }
  return spots;
}

class BaseBot {
  constructor(sim, seed) {
    this.sim = sim;
    this.rng = new Rng(seed * 7919 + 13);
    this.spots = buildSpots(sim);
    this.covCache = new Map();
    this.lastIncome = 200;
    this.cashAtWaveStart = sim.state.cash;
  }
  coverage(i, r) {
    const key = i * 4096 + Math.round(r);
    let c = this.covCache.get(key);
    if (c === undefined) { const s = this.spots[i]; c = this.sim.pathCoverage(s.x, s.y, r); this.covCache.set(key, c); }
    return c;
  }
  onWaveCleared() {}
  statsFor(type, levels) {
    return finalizeStats(computeBaseStats(TOWERS[type], levels), null, null);
  }
}

class NoviceBot extends BaseBot {
  constructor(sim, seed) {
    super(sim, seed);
    this.near = this.spots.filter((s) => s.dist < 110 && s.dist > 30);
    this.types = TOWER_LIST.filter((t) => t !== 'rig' && t !== 'beacon')
      .sort((a, b) => sim.priceOf(a) - sim.priceOf(b)).slice(0, 2);
  }
  act(inWave) {
    if (inWave) return;
    const sim = this.sim;
    for (let guard = 0; guard < 30; guard++) {
      const st = sim.state;
      const wantPlace = this.rng.next() < 0.55 || st.towers.length < 2;
      if (wantPlace) {
        const type = this.types[this.rng.int(this.types.length)];
        if (st.cash < sim.priceOf(type)) break;
        let ok = false;
        for (let k = 0; k < 40 && !ok; k++) {
          const s = this.near[this.rng.int(this.near.length)];
          if (sim.canPlace(type, s.x, s.y).ok) ok = sim.placeTower(type, s.x, s.y).ok;
        }
        if (!ok) break;
      } else {
        if (!st.towers.length) break;
        const t = st.towers[this.rng.int(st.towers.length)];
        const p = this.rng.int(3);
        const info = sim.upgradeInfo(t.id, p);
        if (info.tier > 2 || info.state !== 'available') { if (info.state === 'unaffordable') break; continue; }
        sim.upgrade(t.id, p);
      }
    }
  }
}

class SolidBot extends BaseBot {
  constructor(sim, seed) {
    super(sim, seed);
    this.types = TOWER_LIST.filter((t) => t !== 'rig' && t !== 'beacon');
    this.rangeOrder = new Map();
  }

  bestSpot(type, range) {
    const sim = this.sim;
    const key = Math.round(range);
    let order = this.rangeOrder.get(key);
    if (!order) {
      order = this.spots.map((s, i) => i).filter((i) => this.spots[i].dist < range * 0.9)
        .sort((a, b) => this.coverage(b, range) - this.coverage(a, range));
      this.rangeOrder.set(key, order);
    }
    for (const i of order) {
      const s = this.spots[i];
      if (sim.canPlace(type, s.x, s.y).spotOk) return { x: s.x, y: s.y, i };
    }
    return null;
  }

  // What the upcoming waves require that the current defense lacks (uses the public preview).
  needs() {
    const sim = this.sim;
    const w = sim.state.wave + 1;
    const dtypes = new Set();
    let detectPower = 0, total = 0, shipDmg = 0;
    const byType = {};
    for (const t of sim.state.towers) {
      const p = towerPower(sim, t.stats, t.x, t.y);
      total += p;
      if (t.stats.detection) detectPower += p;
      const share = p / Math.max(1, t.stats._attackList.length);
      for (const a of t.stats._attackList) {
        dtypes.add(a.dtype);
        byType[a.dtype] = (byType[a.dtype] || 0) + share;
        shipDmg += (a.shipDamage || 0) / Math.max(0.05, a.cooldown || 1);
      }
    }
    let shipsSoon = false, phantomSoon = false;
    const immuneFrac = {};
    for (let k = 0; k < 3; k++) {
      const spec = buildWave(w + k, { lanes: sim.lanes });
      if (spec.titan || (w + k) % 20 === 0 || spec.groups.some((g) => ENEMIES[g.type] && ENEMIES[g.type].kind === 'ship')) shipsSoon = true;
      const env = waveEnv(sim, w + k);
      if (env.phantomFrac > 0) phantomSoon = true;
      for (const d of ['KINETIC', 'BLAST', 'THERMAL', 'CRYO', 'ENERGY']) immuneFrac[d] = Math.max(immuneFrac[d] || 0, env.immuneFrac(d));
    }
    // A damage type is lacking when too little of the defense can hurt the enemies immune to it.
    const lacksType = [];
    for (const d of Object.keys(immuneFrac)) {
      const f = immuneFrac[d];
      if (f <= 0 || total <= 0) continue;
      const capable = 1 - (byType[d] || 0) / total;
      if (capable < Math.min(0.85, 2.2 * f + 0.1)) lacksType.push(d);
    }
    return { w, dtypes, detectShare: total > 0 ? detectPower / total : 0, wantPhantom: phantomSoon, lacksType, shipDmg, shipsSoon };
  }

  weight(stats, need) {
    let m = 1;
    if (need.wantPhantom && need.detectShare < 0.25 && stats.detection) m *= 2;
    if (need.lacksType.length && stats._attackList.some((a) => need.lacksType.indexOf(a.dtype) < 0)) m *= 1.8;
    if (need.shipsSoon && stats._attackList.some((a) => (a.shipDamage || 0) > 0 || a.damage >= 4 || (a.bonus && a.bonus.titan))) m *= 1.6;
    return m;
  }

  unmet(need) { return (need.wantPhantom && need.detectShare < 0.25) || need.lacksType.length > 0; }

  options() {
    const sim = this.sim;
    const need = this.needs();
    const opts = [];
    for (const type of this.types) {
      const def = TOWERS[type];
      const stats = this.statsFor(type, [0, 0, 0]);
      const spot = this.bestSpot(type, stats.range);
      if (!spot) continue;
      const cost = sim.priceAt(type, spot.x, spot.y);
      const p = towerPower(sim, stats, spot.x, spot.y) * this.weight(stats, need);
      // diminishing returns on spamming one tower type
      const same = sim.state.towers.filter((t) => t.type === type).length;
      opts.push({ kind: 'place', type, x: spot.x, y: spot.y, cost, value: (p / cost) * Math.pow(0.985, same), def, fixes: this.weight(stats, need) > 1 });
    }
    for (const t of sim.state.towers) {
      if (!TOWERS[t.type]) continue;
      const cur = towerPower(sim, t.baseStatsFinal || this.statsFor(t.type, t.levels), t.x, t.y);
      for (let p = 0; p < 3; p++) {
        const info = sim.upgradeInfo(t.id, p);
        if (info.state === 'locked' || info.state === 'maxed') continue;
        const lv = t.levels.slice(); lv[p]++;
        const ns = this.statsFor(t.type, lv);
        let gain = towerPower(sim, ns, t.x, t.y) - cur;
        gain *= this.weight(ns, need) / Math.max(1, this.weight(t.stats, need));
        if (ns.detection && !t.stats.detection && need.wantPhantom && need.detectShare < 0.25) gain += cur * 0.8;
        if (ns.abilities.length > t.stats.abilities.length) gain *= 1.2;
        opts.push({ kind: 'upgrade', id: t.id, path: p, cost: info.cost, value: gain / info.cost * 1.05, tier: info.tier, fixes: (ns.detection && !t.stats.detection && need.wantPhantom && need.detectShare < 0.25) });
      }
    }
    return opts;
  }

  act(inWave) {
    const sim = this.sim;
    for (let guard = 0; guard < 40; guard++) {
      const cash = sim.state.cash - this.reserve();
      const horizon = cash + this.lastIncome * 1.5;
      const opts = this.options().filter((o) => o.cost <= horizon && o.value > 0);
      if (!opts.length) break;
      opts.sort((a, b) => b.value - a.value);
      let best = opts[0];
      if (best.cost > cash) {
        // Save up only while the defense is holding and the purchase is clearly better.
        const affordable = opts.filter((o) => o.cost <= cash);
        const holding = this.leakStreak === 0 && sim.state.wave >= 6 && !this.unmet(this.needs());
        const soon = best.cost - cash <= this.lastIncome * 1.1 && (!affordable.length || best.value > affordable[0].value * 1.25);
        if (holding || soon || best.fixes || !affordable.length) break;
        best = affordable[0];
      }
      let r;
      if (best.kind === 'place') r = sim.placeTower(best.type, best.x, best.y);
      else r = sim.upgrade(best.id, best.path);
      if (!r.ok) break;
    }
  }

  reserve() { return 0; }

  onWaveCleared(income, leaked) {
    this.lastIncome = Math.max(100, income);
    this.leakStreak = leaked > 0 ? (this.leakStreak || 0) + 1 : 0;
  }
}

class EcoBot extends SolidBot {
  act(inWave) {
    const sim = this.sim;
    if (TOWERS.rig) {
      for (const t of sim.state.towers) if (t.type === 'rig' && (t.data.vault || 0) > 0 && t.stats.income && t.stats.income.vault && t.data.vault >= t.stats.income.vault.cap * 0.95) sim.withdraw(t.id);
      const w = sim.state.wave;
      const maxRigs = Math.min(10, 1 + Math.floor(w / 5));
      if (!inWave && w >= 3 && w <= 70 && sim.state.rigCount < maxRigs) {
        const price = sim.priceOf('rig');
        if (sim.state.cash >= price + 100) {
          // far from the path: rigs do not need coverage
          const cand = this.spots.filter((s) => s.dist > 90).sort((a, b) => b.dist - a.dist);
          for (const s of cand) { if (sim.canPlace('rig', s.x, s.y).ok) { sim.placeTower('rig', s.x, s.y); break; } }
        }
      }
      if (!inWave && w >= 8) {
        for (const t of sim.state.towers) {
          if (t.type !== 'rig') continue;
          const info = sim.upgradeInfo(t.id, 0);
          if (info.state === 'available' && info.tier <= 3 && sim.state.cash >= info.cost * 1.6) sim.upgrade(t.id, 0);
        }
      }
    }
    super.act(inWave);
  }
}

export const BOTS = { novice: NoviceBot, solid: SolidBot, eco: EcoBot };

// ------------------------------------------------------------------ runner
function checkFinite(sim) {
  const st = sim.state;
  const bad = (v) => typeof v !== 'number' || Number.isNaN(v);
  if (bad(st.cash) || bad(st.lives)) throw new Error(`NaN in state: cash=${st.cash} lives=${st.lives}`);
  for (const e of st.enemies) if (bad(e.hp) || bad(e.d) || bad(e.x) || bad(e.y)) throw new Error(`NaN enemy ${e.type} ${e.id}`);
  for (const p of st.projectiles) if (bad(p.x) || bad(p.y)) throw new Error('NaN projectile');
}

export function runGame({ map = 'crater', difficulty = 'pilot', bot = 'solid', waves = 80, seed = 1, quiet = false, log = console.log, maxTicksPerWave = 60 * 600, god = false, cash = null } = {}) {
  const sim = new Sim({ mapId: map, difficulty, seed });
  // test-only overrides (stress the engine at high waves)
  if (god) { sim.state.lives = 1e15; sim.state.maxLives = 1e15; }
  if (cash !== null) sim.state.cash = cash;
  const Bot = BOTS[bot];
  if (!Bot) throw new Error('unknown bot ' + bot);
  const b = new Bot(sim, seed);
  const lanes = sim.lanes;
  let waveT0 = performance.now();
  let leaked0 = 0, cash0 = 0, ticksThisWave = 0;
  const t0 = performance.now();
  while (sim.state.phase !== 'over' && sim.state.cleared < waves) {
    if (sim.state.phase === 'build') {
      b.act(false);
      const r = sim.startWave();
      if (!r.ok) throw new Error('startWave failed: ' + r.reason);
      waveT0 = performance.now();
      ticksThisWave = 0;
      leaked0 = sim.state.stats.massLeaked;
      cash0 = sim.state.stats.cashEarned;
    }
    sim.step();
    ticksThisWave++;
    if (ticksThisWave % 90 === 0) b.act(true);
    if (ticksThisWave > maxTicksPerWave) throw new Error(`wave ${sim.state.wave} did not finish in ${maxTicksPerWave} ticks`);
    const evs = sim.drainEvents();
    for (const ev of evs) {
      if (ev.t === 'waveCleared') {
        checkFinite(sim);
        const st = sim.state;
        const income = st.stats.cashEarned - cash0;
        b.onWaveCleared(income, st.stats.massLeaked - leaked0);
        if (!quiet) {
          const mass = Math.round(buildWave(ev.wave, { lanes }).mass);
          const ms = performance.now() - waveT0;
          log(`wave ${String(ev.wave).padStart(3)} | cash ${String(Math.floor(st.cash)).padStart(7)} | lives ${String(Math.ceil(st.lives)).padStart(4)} | towers ${String(st.towers.length).padStart(3)} | mass ${String(mass).padStart(8)} | leaked ${String(Math.round(st.stats.massLeaked - leaked0)).padStart(6)} | ${ms.toFixed(0)}ms`);
        }
      }
    }
  }
  const st = sim.state;
  const summary = {
    bot, map, difficulty, seed,
    cleared: st.cleared, over: st.phase === 'over', towers: st.towers.length,
    levels: st.towers.map((t) => t.type[0] + t.levels.join('')).join(' '),
    cash: Math.floor(st.cash), lives: Math.ceil(st.lives), ms: Math.round(performance.now() - t0), ticks: st.tick, hash: sim.hash(),
  };
  return { sim, summary };
}

// ------------------------------------------------------------------ perf benchmark
export function runPerf({ enemies = 1500, towers = 40, ticks = 600, seed = 3, projectiles = 0, log = console.log } = {}) {
  const sim = new Sim({ mapId: 'crater', difficulty: 'pilot', seed });
  sim.state.cash = 1e9;
  const types = TOWER_LIST.filter((t) => t !== 'rig' && t !== 'beacon');
  const bot = new SolidBot(sim, seed);
  let placed = 0;
  const order = bot.spots.map((s, i) => i).filter((i) => bot.spots[i].dist < 130).sort((a, b) => bot.coverage(b, 160) - bot.coverage(a, 160));
  const rng = new Rng(seed);
  for (const i of order) {
    if (placed >= towers) break;
    const s = bot.spots[i];
    const type = types[placed % types.length];
    if (!sim.canPlace(type, s.x, s.y).ok) continue;
    const r = sim.placeTower(type, s.x, s.y);
    if (!r.ok) continue;
    placed++;
    // mixed upgrades: some mid tier, a few tier 4/5
    const main = rng.int(3), second = (main + 1 + rng.int(2)) % 3;
    const top = placed % 8 === 0 ? 5 : placed % 3 === 0 ? 4 : 3;
    for (let k = 0; k < top; k++) sim.upgrade(r.id, main);
    for (let k = 0; k < 2; k++) sim.upgrade(r.id, second);
  }
  sim.state.lives = 1e12;
  sim.startWave();
  const L = sim.pathLength(0);
  const topUp = () => {
    // optional extra projectile load (long-lived piercing bolts) to reach the budget's 800
    if (projectiles > 0) {
      const t0 = sim.state.towers[0];
      while (sim.state.projectiles.length < projectiles) {
        sim.spawnProjectile({ x: 100 + rng.next() * 1300, y: 100 + rng.next() * 800, angle: rng.next() * Math.PI * 2, speed: 300, damage: 1, pierce: 1000, lifetime: 3, dtype: 'VOID', tower: t0 });
      }
    }
    let live = sim._liveEnemies;
    while (live < enemies) {
      const type = rng.next() < 0.1 ? 'obsidian' : rng.next() < 0.5 ? 'rose' : 'geode';
      sim.spawnEnemy(type, { d: rng.next() * L * 0.9, wave: 30, off: (rng.next() - 0.5) * 18, nanite: rng.next() < 0.2 });
      live++;
    }
  };
  topUp();
  for (let i = 0; i < 60; i++) { sim.step(); topUp(); sim.drainEvents(); }
  let tSim = 0, eSum = 0, pSum = 0, shots = 0;
  const pops0 = sim.state.stats.pops;
  for (let i = 0; i < ticks; i++) {
    topUp();
    const a = performance.now();
    sim.step();
    tSim += performance.now() - a;
    eSum += sim.state.enemies.length; pSum += sim.state.projectiles.length;
    for (const ev of sim.drainEvents()) if (ev.t === 'shot') shots++;
  }
  const tps = ticks / (tSim / 1000);
  log(`perf: ${placed} towers, avg ${Math.round(eSum / ticks)} enemies, avg ${Math.round(pSum / ticks)} projectiles, ${Math.round(shots / (ticks / 60))} shots/s, ${Math.round((sim.state.stats.pops - pops0) / (ticks / 60))} pops/s, ${ticks} ticks in ${tSim.toFixed(0)} ms = ${Math.round(tps)} ticks/s (${(tSim / ticks).toFixed(3)} ms/tick; 3x speed needs 180 ticks/s)`);
  return tps;
}

// ------------------------------------------------------------------ CLI
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const flag = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] !== undefined && !args[i + 1].startsWith('--') ? args[i + 1] : d; };
  const has = (n) => args.includes('--' + n);
  try {
    if (has('perf')) {
      runPerf({ enemies: Number(flag('enemies', 1500)), towers: Number(flag('towers', 40)), ticks: Number(flag('ticks', 600)), projectiles: Number(flag('projectiles', 0)) });
    } else {
      const { summary } = runGame({
        map: flag('map', 'crater'), difficulty: flag('difficulty', 'pilot'), bot: flag('bot', 'solid'),
        waves: Number(flag('waves', 80)), seed: Number(flag('seed', 1)), quiet: has('quiet'),
        god: has('god'), cash: flag('cash', null) !== null ? Number(flag('cash', 0)) : null,
      });
      console.log(`${summary.over ? 'GAME OVER' : 'SURVIVED'}: bot=${summary.bot} map=${summary.map} difficulty=${summary.difficulty} seed=${summary.seed} cleared=${summary.cleared} towers=${summary.towers} cash=${summary.cash} lives=${summary.lives} ticks=${summary.ticks} time=${summary.ms}ms`);
      if (has('hash')) console.log('hash ' + summary.hash);
      if (has('verbose')) console.log('towers: ' + summary.levels);
    }
  } catch (e) {
    console.error('ERROR: ' + (e && e.stack || e));
    process.exit(1);
  }
}
