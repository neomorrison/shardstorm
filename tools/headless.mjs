// Headless simulation runner with bots (public Sim commands only).
//
// Usage:
//   node tools/headless.mjs --map crater --difficulty pilot --bot solid --waves 80 --seed 1 [--quiet] [--hash] [--hero vega]
//   node tools/headless.mjs --perf [--enemies 1500 --towers 40 --ticks 600 --projectiles 800 --ships 60 --titan]
//   Test-only overrides: --god (practically infinite Core Integrity), --cash N (starting credits).
//   --verbose prints the final tower list; --abilities off stops the bots from firing abilities.
//
// Bots:
//   novice  cheap damage towers at random legal spots near the path, never above tier 2,
//           never uses abilities
//   solid   greedy: picks the purchase (new tower, upgrade, Beacon, slowing field) with the best
//           marginal defensive value per credit, saves up for big upgrades, fires abilities
//   eco     solid plus Mining Rigs (saved for, upgraded while they still pay back) and vault
//           withdrawals
//
// How the solid bot values a purchase: every tower configuration gets an empirical power
// profile, the mass it destroys per second in six small arena scenarios (the tools/bench.mjs
// arena: SWARM, DENSE, SHIP, IRON, SPECIAL (Magma/Comet/Prism/Geode) and PHANTOM), measured
// once and cached. Upcoming waves are turned into a demand per scenario category (mass per
// second of shells behind each gate: ship hulls, Obsidian shells, Iron families, other special
// families, Phantom families, plain shards) per lane. Team capacity per lane and category is the
// sum of each tower's profile scaled by how much of that lane it covers (and by Beacon buffs and
// nearby slowing fields). The value of the defense is a saturating function of capacity against
// demand, so the bot buys what the next waves lack (detection, anti-Iron, ship damage) and stops
// stacking what is already covered. Custom attacks, abilities-free passives and every tower's
// real targeting are measured rather than modelled, so the bots follow the tower files as the
// balance pass changes them.
//
// Prints one line per cleared wave: wave, cash, lives, towers, mass, leaked, ms.
// Exits 1 on exceptions or NaN state.
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { Sim } from '../src/sim/game.js';
import { buildWave } from '../src/sim/wavegen.js';
import { TOWERS, TOWER_LIST } from '../src/data/towers/index.js';
import { HEROES } from '../src/data/heroes.js';
import { computeBaseStats, finalizeStats, crosspathReason } from '../src/sim/towers.js';
import { Rng } from '../src/core/rng.js';
import { ENEMIES, familyMass, SCOUT_HULL } from '../src/data/enemies.js';
import { titanHp, TITAN_EVERY, incomeFactor, BASE_SPEED, priceFor } from '../src/data/economy.js';
import { TITAN_ORDER } from '../src/sim/enemies.js';
import { runAdaptiveMulti, newArenaSim, placeConfigured, towerY, MAIN_TOWER_X } from './bench.mjs';

// ------------------------------------------------------------------ empirical power profiles
export const CATS = ['SWARM', 'DENSE', 'SHIP', 'IRON', 'SPECIAL', 'PHANTOM', 'SPECTER'];
const NC = CATS.length;
const C_SWARM = 0, C_DENSE = 1, C_SHIP = 2, C_IRON = 3, C_SPECIAL = 4, C_PHANTOM = 5, C_SPECTER = 6;
// Specter hulls are Phantom and immune to KINETIC and BLAST, and a leaked Specter costs 816
// Integrity, so they get their own category (with a bench-only near-infinite Specter target) and
// extra weight in the demand.
const SPECTER_WEIGHT = 3;
function ensureBotEnemies() {
  if (ENEMIES.__bench_specter__) return;
  ENEMIES.__bench_specter__ = {
    id: '__bench_specter__', name: 'Bench Specter Target', kind: 'ship', phantom: true,
    speed: 0.6, hp: 1e9, immune: ['KINETIC', 'BLAST'], children: [], radius: 30, color: '#20242c',
    mass: 1e9, hullMass: 1e9, meteorMass: 0, shells: 1, _derived: true,
  };
}
const SPECIAL_CYCLE = ['magma', 'comet', 'prism', 'geode'];
const PROFILE_SCEN = [
  { n: 12, pick: () => 'rose' },
  { n: 5, pick: () => '__bench_dense__' },
  { n: 1, pick: () => '__bench_ship__' },
  { n: 8, pick: () => 'iron' },
  { n: 8, pick: (i) => SPECIAL_CYCLE[i % SPECIAL_CYCLE.length] },
  { n: 12, pick: () => 'rose', phantom: true },
  { n: 1, pick: () => '__bench_specter__', phantom: true },
];
const PROFILE_WARMUP = 1, PROFILE_MEASURE = 5;
const PLAN_CONFIGS = [[1, 0, 0], [0, 1, 0], [0, 0, 1], [2, 0, 0], [0, 2, 0], [0, 0, 2], [3, 0, 0], [0, 3, 0], [0, 0, 3]];
const SHIP_REF = 250; // channel length one bench tower covers, for the ship pass requirement
const ARENA_D0 = 56 / 2 + 6; // arena channel half width + margin; plus the tower radius

// Profiles are cached in memory and on disk (out/botprofiles.json, gitignored). The disk cache is
// keyed by a hash of every tower, enemy, economy and engine source file, so any balance or
// engine change re-measures automatically.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_FILE = path.join(ROOT, 'out', 'botprofiles.json');
const profileCache = new Map();
let cacheSig = null, cacheDirty = 0;
function sourceSignature() {
  const h = crypto.createHash('sha1');
  const dirs = ['src/data', 'src/data/towers', 'src/sim', 'src/core'];
  for (const d of dirs) {
    const abs = path.join(ROOT, d);
    let names = [];
    try { names = fs.readdirSync(abs).filter((n) => n.endsWith('.js')).sort(); } catch { continue; }
    for (const n of names) { h.update(d + '/' + n); h.update(fs.readFileSync(path.join(abs, n))); }
  }
  h.update('profile-v2:' + PROFILE_WARMUP + ':' + PROFILE_MEASURE + ':' + NC);
  return h.digest('hex');
}
function loadProfileCache() {
  if (cacheSig !== null) return;
  cacheSig = sourceSignature();
  try {
    const j = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (j && j.sig === cacheSig && j.profiles) for (const [k, v] of Object.entries(j.profiles)) profileCache.set(k, Float64Array.from(v));
  } catch { /* no cache yet */ }
}
export function saveProfileCache() {
  if (!cacheDirty || cacheSig === null) return;
  try {
    const profiles = {};
    for (const [k, v] of profileCache) profiles[k] = Array.from(v, (x) => Math.round(x * 1000) / 1000);
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ sig: cacheSig, profiles }));
    cacheDirty = 0;
  } catch { /* read-only checkout: keep going without the disk cache */ }
}
// Mass destroyed per second by one tower of `type` at `levels` in each category (Float64Array(6)).
export function profileOf(type, levels) {
  loadProfileCache();
  ensureBotEnemies();
  const key = type + ':' + levels.join('');
  let p = profileCache.get(key);
  if (p) return p;
  p = new Float64Array(NC);
  const def = TOWERS[type];
  const hasAttack = def && Object.keys((def.base && def.base.attacks) || {}).length > 0;
  if (hasAttack || levels.some((v) => v > 0)) {
    for (let c = 0; c < NC; c++) {
      const sc = PROFILE_SCEN[c];
      const sim = newArenaSim(1);
      const t = placeConfigured(sim, type, levels, MAIN_TOWER_X, towerY(def));
      if (!t.stats._attackList.length) { p[c] = 0; continue; }
      p[c] = runAdaptiveMulti(sim, [t], { warmup: PROFILE_WARMUP, measure: PROFILE_MEASURE, targetN: sc.n, pick: sc.pick, phantom: !!sc.phantom });
    }
  }
  // disk values are rounded to 3 decimals: round fresh ones the same way so a run behaves the
  // same with or without the cache
  for (let c = 0; c < NC; c++) p[c] = Math.round(p[c] * 1000) / 1000;
  profileCache.set(key, p);
  if (++cacheDirty >= 25) saveProfileCache();
  return p;
}

// How a tower configuration reaches the channel: 'global' (anywhere), 'aim' (mortar, one point
// anywhere) or a radius.
const statsCache = new Map();
function statsFor(type, levels) {
  const key = type + ':' + levels.join('');
  let s = statsCache.get(key);
  if (!s) { s = finalizeStats(computeBaseStats(TOWERS[type] || HEROES[type], levels), null, null); statsCache.set(key, s); }
  return s;
}
function reachOf(stats) {
  let r = 0, aim = false, global = false;
  for (const a of stats._attackList) {
    if (a.kind === 'mortar') { aim = true; continue; }
    let ar = a.kind === 'drone' ? a.patrol : (a.kind === 'pulse' || a.kind === 'field') ? a.radius : a.range;
    if (a.kind === 'custom') ar = Math.min(a.range || 0, stats.range || 0) || stats.range || 0;
    if (!Number.isFinite(ar) || ar >= 1400) { global = true; continue; }
    if (ar > r) r = ar;
  }
  if (Number.isFinite(stats.range) && stats.range >= 1400) global = true;
  if (!r && Number.isFinite(stats.range) && stats.range > 0 && stats.range < 1400) r = stats.range;
  return { r, aim, global };
}
// Strength (0..1) and radius of the slowing effect a tower spreads around itself. `freeze` marks
// freezing pulses: frozen meteors cannot be hurt by KINETIC, so they help other damage types and
// hinder KINETIC towers.
function slowOf(stats) {
  let s = 0, radius = 0, freeze = false;
  for (const a of stats._attackList) {
    if (a.kind === 'field' && a.slow) { const v = 1 - a.slow.mult; if (v > s) { s = v; radius = a.radius; } }
    const oh = a.onHit;
    if (oh && a.kind === 'pulse') {
      if (oh.freeze) { freeze = true; if (0.35 > s) { s = 0.35; radius = a.radius; } }
      else if (oh.slow && oh.slow.mult < 1) { const v = 1 - oh.slow.mult; if (v > s) { s = v; radius = a.radius; } }
    }
  }
  return { s: Math.min(0.7, s), radius, freeze };
}
// Does this configuration deal only KINETIC damage that frozen targets (and the Aegis shield) stop?
const kineticCache = new Map();
function kineticOnly(type, levels) {
  const key = type + ':' + levels.join('');
  let k = kineticCache.get(key);
  if (k === undefined) {
    const st = statsFor(type, levels);
    k = st._attackList.length > 0 && st._attackList.every((a) => {
      if (a.kind === 'custom' && !(a.damage > 0)) return true;
      const w = a.kind === 'drone' ? a.weapon : a;
      return w.dtype === 'KINETIC' && !(w.bypass && w.bypass.indexOf('FROZEN') >= 0);
    });
    kineticCache.set(key, k);
  }
  return k;
}
// Does this configuration deal only KINETIC damage that the Aegis Titan's shield blocks?
const shieldCache = new Map();
function shieldBlocked(type, levels) {
  const key = type + ':' + levels.join('');
  let k = shieldCache.get(key);
  if (k === undefined) {
    const st = statsFor(type, levels);
    k = st._attackList.length > 0 && st._attackList.every((a) => {
      if (a.kind === 'custom' && !(a.damage > 0)) return true;
      const w = a.kind === 'drone' ? a.weapon : a;
      return w.dtype === 'KINETIC' && !(w.bypass && w.bypass.indexOf('SHIELD') >= 0) && !(w.splash && w.splash.dtype && w.splash.dtype !== 'KINETIC');
    });
    shieldCache.set(key, k);
  }
  return k;
}
function benchCoverage(r, towerRadius) {
  const d0 = ARENA_D0 + towerRadius;
  return r > d0 ? 2 * Math.sqrt(r * r - d0 * d0) : 0;
}

// ------------------------------------------------------------------ wave demand
// Mass of an enemy family split by the category of the gate it sits behind.
function catMass(type, H, plated, phantom, out, mult, scout = false) {
  const d = ENEMIES[type];
  if (!d) return;
  const ph = phantom || !!d.phantom;
  if (d.kind === 'ship') {
    out[type === 'specter' ? C_SPECTER : C_SHIP] += d.hp * H * (plated ? 2 : 1) * (scout ? SCOUT_HULL : 1) * mult * (type === 'specter' ? SPECTER_WEIGHT : 1);
    if (scout) return; // empty hold
    const cm = d.childMods || null;
    for (const [c, n] of d.children) catMass(c, H, !!(cm && cm.plated), ph || !!(cm && cm.phantom), out, mult * n);
    return;
  }
  const fam = familyMass(type, H, plated) * mult;
  if (ph) { out[C_PHANTOM] += fam; return; }
  if (type === 'iron') { out[C_IRON] += fam; return; }
  if (d.immune.length) { out[C_SPECIAL] += fam; return; }
  if (type === 'obsidian') {
    out[C_DENSE] += d.hp * (plated ? 2 : 1) * mult;
    for (const [c, n] of d.children) catMass(c, H, false, false, out, mult * n);
    return;
  }
  if (type === 'aurora') {
    out[C_SWARM] += d.hp * mult;
    for (const [c, n] of d.children) catMass(c, H, false, false, out, mult * n);
    return;
  }
  out[C_SWARM] += fam;
}

const demandCache = new Map();
// { cat: Float64Array (mass per second per category), lanes, titan, mass, duration }
export function waveDemand(sim, w) {
  const key = sim.map.id + ':' + sim.lanes + ':' + w;
  let dm = demandCache.get(key);
  if (dm) return dm;
  const spec = buildWave(w, { lanes: sim.lanes });
  const cat = new Float64Array(NC);
  let mass = 0;
  for (const g of spec.groups) {
    if (!ENEMIES[g.type]) continue;
    const mods = g.mods || {};
    catMass(g.type, spec.hullMult || 1, !!mods.plated, !!mods.phantom, cat, g.count, !!mods.scout);
    mass += familyMass(g.type, spec.hullMult || 1, !!mods.plated, !!mods.scout) * g.count;
  }
  const dur = Math.max(8, (spec.duration || 12) * (sim.paceAt ? sim.paceAt(w) : 1));
  for (let c = 0; c < NC; c++) cat[c] /= dur;
  // Ships must also be broken during one pass: sum over towers of (MDS x channel covered) has to
  // reach hull x speed. In bench-tower units (SHIP_REF units of channel each) that is the
  // pass requirement below, for the biggest single ship of each kind.
  const vm = BASE_SPEED * (spec.speedMult || 1);
  let shipPass = 0, specterPass = 0;
  for (const g of spec.groups) {
    const d = ENEMIES[g.type];
    if (!d || d.kind !== 'ship') continue;
    const need = d.hp * (spec.hullMult || 1) * (g.mods && g.mods.plated ? 2 : 1) * (g.mods && g.mods.scout ? SCOUT_HULL : 1) * d.speed * vm / SHIP_REF;
    if (g.type === 'specter') specterPass = Math.max(specterPass, need);
    else shipPass = Math.max(shipPass, need);
  }
  let titanKind = null;
  if (w % TITAN_EVERY === 0) {
    titanKind = spec.titan ? spec.titan.kind : TITAN_ORDER[(w / TITAN_EVERY - 1) % TITAN_ORDER.length];
    const hp = spec.titan ? spec.titan.hp : titanHp(w / TITAN_EVERY);
    // Titans stun towers, blink or shield: ask for a margin on top
    shipPass = Math.max(shipPass, 1.3 * hp * 0.2 * vm / SHIP_REF);
  }
  dm = { cat, shipPass, specterPass, titanKind, mass, duration: dur, speedMult: spec.speedMult || 1 };
  if (demandCache.size > 2000) demandCache.clear();
  demandCache.set(key, dm);
  return dm;
}

// Legacy helpers kept for scratch scripts: a coarse wave environment and tower power estimate.
export function waveEnv(sim, w) {
  const dm = waveDemand(sim, w);
  let total = 0;
  for (let c = 0; c < NC; c++) total += dm.cat[c];
  return { supply: total, shipFrac: total > 0 ? dm.cat[C_SHIP] / total : 0, phantomFrac: total > 0 ? dm.cat[C_PHANTOM] / total : 0, demand: dm };
}
export function towerPower(sim, stats, x, y, env, type = null, levels = null) {
  if (!type) return 0;
  const p = profileOf(type, levels);
  const e = env || waveEnv(sim, sim.state.wave + 1);
  let v = 0, tot = 0;
  for (let c = 0; c < NC; c++) { v += p[c] * e.demand.cat[c]; tot += e.demand.cat[c]; }
  return tot > 0 ? v / tot : 0;
}

// ------------------------------------------------------------------ spots
function buildSpots(sim, step = 18) {
  const spots = [];
  for (let y = step; y < 1000; y += step) {
    for (let x = step; x < 1500; x += step) {
      const np = sim.nearestPathPoint(x, y);
      spots.push({ x, y, dist: np.dist, lane: np.lane || 0 });
    }
  }
  return spots;
}

class BaseBot {
  constructor(sim, seed) {
    this.sim = sim;
    this.rng = new Rng(seed * 7919 + 13);
    this.spots = buildSpots(sim);
    this.near = this.spots.filter((s) => s.dist < 320);
    this.covCache = new Map();
    this.lastIncome = 200;
    this.leakStreak = 0;
    this.useAbilities = true;
  }
  // Path length within r of spot i, per lane (Float64Array).
  laneCov(i, r) {
    const key = i * 8192 + Math.round(r);
    let c = this.covCache.get(key);
    if (!c) {
      const s = this.spots[i];
      c = new Float64Array(this.sim.lanes);
      for (let l = 0; l < this.sim.lanes; l++) c[l] = this.sim.paths[l].coverage(s.x, s.y, r);
      this.covCache.set(key, c);
    }
    return c;
  }
  coverage(i, r) { const c = this.laneCov(i, r); let s = 0; for (const v of c) s += v; return s; }
  onWaveCleared(income, leaked) {
    this.lastIncome = Math.max(100, income);
    this.leakStreak = leaked > 0 ? this.leakStreak + 1 : 0;
    this.calm = leaked > 0 ? 0 : (this.calm || 0) + 1; // waves since the last leak
  }
  statsFor(type, levels) { return statsFor(type, levels); }
  act() {}
}

class NoviceBot extends BaseBot {
  constructor(sim, seed) {
    super(sim, seed);
    this.near = this.spots.filter((s) => s.dist < 110 && s.dist > 30);
    // the four cheapest damage towers (Pulse, Scatter, Rail, Missile at the moment)
    this.types = TOWER_LIST.filter((t) => t !== 'rig' && t !== 'beacon' && t !== 'gravity' && t !== 'cryo')
      .sort((a, b) => sim.priceOf(a) - sim.priceOf(b)).slice(0, 4);
    this.useAbilities = false;
  }
  act(inWave) {
    if (inWave) return;
    const sim = this.sim;
    // a novice still builds beside the lanes meteors actually use, in proportion to the
    // share each lane carries (maps can open their second lane later, map.laneOpen)
    const share1 = sim.lanes === 2 && sim.laneShare ? sim.laneShare(sim.state.wave + 1) : 0.5;
    if (!this.nearL) this.nearL = [this.near.filter((s) => s.lane === 0), this.near.filter((s) => s.lane === 1)];
    const pickNear = () => (sim.lanes === 2 && share1 !== 0.5 && this.nearL[1].length ? (this.rng.next() < share1 ? this.nearL[1] : this.nearL[0]) : this.near);
    for (let guard = 0; guard < 30; guard++) {
      const st = sim.state;
      const wantPlace = this.rng.next() < 0.55 || st.towers.length < 2;
      if (wantPlace) {
        let type = this.types[this.rng.int(this.types.length)];
        if (st.cash < sim.priceOf(type)) {
          // fall back to something affordable instead of stopping
          const cheap = this.types.filter((t) => st.cash >= sim.priceOf(t));
          if (!cheap.length) break;
          type = cheap[this.rng.int(cheap.length)];
        }
        let ok = false;
        for (let k = 0; k < 40 && !ok; k++) {
          const near = pickNear();
          const s = near[this.rng.int(near.length)];
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

// Saturating value of capacity x against demand D (both mass per second).
function sat(x, D) { return D > 0 ? D * (1 - Math.exp(-x / D)) : 0; }

class SolidBot extends BaseBot {
  constructor(sim, seed, opts = {}) {
    super(sim, seed);
    this.types = TOWER_LIST.filter((t) => t !== 'rig' && TOWERS[t] && !TOWERS[t].stub);
    this.spotOrder = new Map();
    this.heroId = sim.state.heroId || null;
    this.aimPoint = null;
    this.K = 2.6;
  }

  // ---------------------------------------------------------------- demand
  // Demand per lane and category: the peak of the next three waves, times a safety factor
  // that rises while the defense keeps leaking.
  demand() {
    const sim = this.sim;
    const w = sim.state.wave + 1;
    const lanes = sim.lanes;
    const D = new Float64Array(NC);
    this.aegisSoon = false;
    let shipPass = 0, specterPass = 0;
    for (let k = 0; k < 3; k++) {
      const dm = waveDemand(sim, w + k);
      if (dm.titanKind === 'aegis') this.aegisSoon = true;
      const f = k === 0 ? 1 : 0.85;
      for (let c = 0; c < NC; c++) D[c] = Math.max(D[c], dm.cat[c] * f);
      shipPass = Math.max(shipPass, dm.shipPass * f);
      specterPass = Math.max(specterPass, dm.specterPass * f);
    }
    // a Specter or a Titan is a hard gate: start preparing six waves ahead
    for (let k = 3; k < 6; k++) {
      const dm = waveDemand(sim, w + k);
      if (k < 5) shipPass = Math.max(shipPass, dm.shipPass * 0.7);
      specterPass = Math.max(specterPass, dm.specterPass * 0.7);
    }
    // lane weights: maps can open their second lane gradually (map.laneOpen), so the demand
    // per lane follows the share of spawns each lane will actually carry over the horizon
    const lw = new Float64Array(lanes).fill(1 / lanes);
    if (lanes === 2 && sim.laneShare) {
      let lo = 1, hi = 0;
      for (let k = 0; k < 3; k++) { const s = sim.laneShare(w + k); lo = Math.min(lo, s); hi = Math.max(hi, s); }
      lw[0] = 1 - lo; lw[1] = hi;
    }
    const boost = 1 + 0.45 * Math.min(4, this.leakStreak);
    // early waves arrive sparse and fast relative to the tiny defense: ask for more headroom
    // a one-life run (Nightmare) cannot learn from a leak, so it builds with more headroom
    // from the start, as a careful player would (the leak streak can never kick in there)
    const risk = sim.state.maxLives <= 20 ? 1.8 : 1;
    const K = (this.K + 2 * Math.max(0, (20 - w) / 20)) * boost * risk;
    const out = [];
    for (let l = 0; l < lanes; l++) {
      const a = new Float64Array(NC);
      for (let c = 0; c < NC; c++) a[c] = D[c] * K * lw[l];
      // every lane that carries spawns must be able to break its own ships in one pass
      if (lw[l] > 0) {
        a[C_SHIP] = Math.max(a[C_SHIP], shipPass * 1.4 * boost);
        a[C_SPECTER] = Math.max(a[C_SPECTER], specterPass * 1.6 * boost);
      }
      out.push(a);
    }
    return out;
  }

  // ---------------------------------------------------------------- per-tower contribution
  // Contribution vector per lane for a tower config at (x, y) with an aura buff and slow factor.
  contribution(type, levels, x, y, spotIdx, buffs, slowF, out) {
    const sim = this.sim;
    const stats = statsFor(type, levels);
    const prof = profileOf(type, levels);
    const reach = reachOf(stats);
    const lanes = sim.lanes;
    for (let l = 0; l < lanes; l++) out[l].fill(0);
    let rangeMult = 1, rate = 1, detect = false, iron = false, dmgAdd = 0;
    if (buffs) {
      rangeMult = buffs.rangeMult || 1; rate = buffs.rateMult || 1; detect = !!buffs.detection;
      iron = !!(buffs.bypass && buffs.bypass.indexOf('iron') >= 0); dmgAdd = buffs.damageAdd || 0;
    }
    const k = rate * (1 + 0.2 * dmgAdd) * (slowF || 1);
    const laneF = new Float64Array(lanes);
    const laneLin = new Float64Array(lanes); // ship categories: time in range grows with coverage
    // a global tower covers every lane, but it fires one slug at a time: its ship damage is shared
    // between the lanes like its meteor damage (counting it in full on each lane double counted it)
    if (reach.global) { laneF.fill(1 / lanes); for (let l = 0; l < lanes; l++) laneLin[l] = sim.pathLength(l) / SHIP_REF / lanes; }
    else if (reach.aim) {
      const lane = this.aimLane();
      laneF[lane] = 1;
      laneLin[lane] = 0.6;
    } else {
      const r = reach.r * rangeMult;
      const radius = (TOWERS[type] || HEROES[type]).radius || 22;
      const bc = benchCoverage(reach.r, radius);
      const cov = spotIdx >= 0 ? this.laneCov(spotIdx, r) : null;
      for (let l = 0; l < lanes; l++) {
        const cv = cov ? cov[l] : sim.paths[l].coverage(x, y, r);
        laneF[l] = bc > 0 ? Math.min(2.2, Math.sqrt(cv / bc)) : (cv > 0 ? 1 : 0);
        laneLin[l] = Math.min(5, cv / SHIP_REF);
      }
    }
    // KINETIC hits deal a fifth of their damage to the Aegis shield (a quarter of its hull), so
    // a KINETIC-only tower needs 2.25x hull / 1.25x hull = 1.8x as long against it
    const shipK = this.aegisSoon && shieldBlocked(type, levels) ? 0.55 : 1;
    for (let l = 0; l < lanes; l++) {
      if (!laneF[l] && !laneLin[l]) continue;
      const o = out[l];
      for (let c = 0; c < NC; c++) o[c] = prof[c] * k * laneF[l];
      o[C_SHIP] = prof[C_SHIP] * k * laneLin[l] * shipK;
      o[C_SPECTER] = prof[C_SPECTER] * k * laneLin[l];
      if (detect && o[C_PHANTOM] < o[C_SWARM] * 0.9) o[C_PHANTOM] = o[C_SWARM] * 0.9;
      if (iron && o[C_IRON] < o[C_SWARM] * 0.6) o[C_IRON] = o[C_SWARM] * 0.6;
    }
    return out;
  }

  // Current team: capacity per lane/category plus each tower's own contribution (for upgrades).
  team() {
    const sim = this.sim;
    const lanes = sim.lanes;
    const cap = [];
    for (let l = 0; l < lanes; l++) cap.push(new Float64Array(NC));
    const per = new Map();
    const slows = [];
    for (const t of sim.state.towers) {
      if (t.type === 'rig' || t.type === 'beacon') continue;
      const sl = slowOf(t.stats);
      if (sl.s > 0) slows.push({ x: t.x, y: t.y, s: sl.s, r: sl.radius, id: t.id, freeze: sl.freeze });
    }
    for (const t of sim.state.towers) {
      if (t.type === 'rig' || t.type === 'beacon' || t.hero) continue;
      if (!TOWERS[t.type]) continue;
      const v = [];
      for (let l = 0; l < lanes; l++) v.push(new Float64Array(NC));
      this.contribution(t.type, t.levels, t.x, t.y, -1, t.buffs, this.slowFactorAt(t.x, t.y, t.stats.range, slows, t.id, kineticOnly(t.type, t.levels)), v);
      per.set(t.id, v);
      for (let l = 0; l < lanes; l++) for (let c = 0; c < NC; c++) cap[l][c] += v[l][c];
    }
    // the Commander counts as a modest pulse-like tower
    const hero = sim.state.towers.find((t) => t.hero);
    if (hero) {
      const lvl = hero.hero.level;
      for (let l = 0; l < lanes; l++) for (let c = 0; c < NC; c++) cap[l][c] += (1 + lvl * 0.9) * (c === C_IRON || c === C_PHANTOM ? 0.5 : 1) / lanes;
    }
    return { cap, per, slows };
  }

  slowFactorAt(x, y, range, slows, selfId = -1, kinetic = false) {
    let best = 0, frozen = false;
    const rr = Number.isFinite(range) ? range : 0;
    for (const s of slows) {
      if (s.id === selfId) continue;
      const dx = s.x - x, dy = s.y - y;
      if (dx * dx + dy * dy > (s.r + rr * 0.6) * (s.r + rr * 0.6)) continue;
      if (s.freeze && kinetic) { frozen = true; continue; }
      if (s.s > best) best = s.s;
    }
    return (1 + 0.6 * best) * (frozen ? 0.8 : 1);
  }

  value(cap, D) {
    let v = 0;
    for (let l = 0; l < cap.length; l++) for (let c = 0; c < NC; c++) v += sat(cap[l][c], D[l][c]);
    return v;
  }

  // Value gained by adding `add` (and removing `sub`) from capacity.
  gain(cap, D, add, sub) {
    let g = 0;
    for (let l = 0; l < cap.length; l++) {
      for (let c = 0; c < NC; c++) {
        const x0 = cap[l][c];
        const x1 = x0 + (add ? add[l][c] : 0) - (sub ? sub[l][c] : 0);
        g += sat(x1, D[l][c]) - sat(x0, D[l][c]);
      }
    }
    return g;
  }

  // ---------------------------------------------------------------- spots
  // Spot indices ordered by total coverage at radius r (cached per 10-unit bucket).
  orderFor(r) {
    const key = Math.round(r / 10);
    let order = this.spotOrder.get(key);
    if (!order) {
      const rr = key * 10;
      order = [];
      for (let i = 0; i < this.spots.length; i++) if (this.spots[i].dist < rr * 0.92) order.push(i);
      const cov = order.map((i) => this.coverage(i, rr));
      const idx = order.map((_, k) => k).sort((a, b) => cov[b] - cov[a]);
      order = idx.map((k) => order[k]);
      this.spotOrder.set(key, order);
    }
    return order;
  }

  // Legal spots for a tower of `type`: the best-covered ones for ranged towers, far-away ones for
  // global/aimed towers (keeping the good spots free).
  candidateSpots(type, stats, n = 10) {
    const sim = this.sim;
    const reach = reachOf(stats);
    const out = [];
    if (reach.global || reach.aim) {
      if (!this.farOrder) this.farOrder = this.spots.map((s, i) => i).filter((i) => this.spots[i].dist > 70).sort((a, b) => this.spots[b].dist - this.spots[a].dist || a - b);
      for (const i of this.farOrder) {
        const s = this.spots[i];
        if (sim.canPlace(type, s.x, s.y).spotOk) { out.push(i); if (out.length >= 2) break; }
      }
      if (!out.length) for (const i of this.orderFor(300)) { const s = this.spots[i]; if (sim.canPlace(type, s.x, s.y).spotOk) { out.push(i); break; } }
      return out;
    }
    const order = this.orderFor(Math.max(40, reach.r));
    // take the best spots, but only one per coverage pattern so multi-lane maps get both lanes
    const seen = new Set();
    for (const i of order) {
      const s = this.spots[i];
      if (!sim.canPlace(type, s.x, s.y).spotOk) continue;
      const lc = this.laneCov(i, reach.r);
      let sig = '';
      for (const v of lc) sig += (v > 0 ? 1 : 0);
      const key = sig + ':' + Math.round(this.coverage(i, reach.r) / 40);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(i);
      if (out.length >= n) break;
    }
    return out;
  }

  aimLane() {
    this.bestAim();
    return this.aimPoint.lane;
  }
  // The channel point with the most channel around it (where a mortar shell does the most).
  bestAim() {
    if (this.aimPoint) return this.aimPoint;
    const sim = this.sim;
    let best = null, bv = -1;
    for (let l = 0; l < sim.lanes; l++) {
      const L = sim.pathLength(l);
      for (let d = L * 0.15; d < L * 0.9; d += 20) {
        const p = sim.pathPoint(l, d);
        const v = sim.pathCoverage(p.x, p.y, 90) + d * 0.02;
        if (v > bv) { bv = v; best = { x: p.x, y: p.y, lane: l }; }
      }
    }
    this.aimPoint = best || { x: 750, y: 500, lane: 0 };
    return this.aimPoint;
  }

  // ---------------------------------------------------------------- options
  options(team, D) {
    const sim = this.sim;
    const lanes = sim.lanes;
    const opts = [];
    const tmp = [];
    for (let l = 0; l < lanes; l++) tmp.push(new Float64Array(NC));
    const counts = {};
    for (const t of sim.state.towers) counts[t.type] = (counts[t.type] || 0) + 1;
    // new towers: the best spot for the bare tower, then the best short plan for it (the bare
    // tower or the tower plus up to three tiers on one path), valued per total credit, so a
    // tower whose worth only shows at tier 2 or 3 (detection, a damage type switch) gets bought
    for (const type of this.types) {
      if (type === 'beacon') continue;
      const stats = statsFor(type, [0, 0, 0]);
      const spots = this.candidateSpots(type, stats);
      let best = null;
      for (const i of spots) {
        const s = this.spots[i];
        const g = this.placeGain(team, D, type, [0, 0, 0], s.x, s.y, i, tmp);
        const cost = sim.priceAt(type, s.x, s.y);
        const v = (g / cost) * Math.pow(0.985, counts[type] || 0);
        if (!best || v > best.value) best = { kind: 'place', type, x: s.x, y: s.y, cost, value: v, gain: g, spot: i, plan: [0, 0, 0] };
      }
      if (!best) continue;
      const base = best.cost;
      for (const lv of PLAN_CONFIGS) {
        const g = this.placeGain(team, D, type, lv, best.x, best.y, -1, tmp);
        const total = base + this.planCost(type, [0, 0, 0], lv);
        const steps = lv[0] + lv[1] + lv[2];
        const v = (g / total) * Math.pow(0.985, counts[type] || 0) * Math.pow(0.95, steps);
        if (v > best.value) { best.value = v; best.gain = g; best.plan = lv; }
      }
      opts.push(best);
    }
    // upgrades, looking up to three tiers ahead on the path
    for (const t of sim.state.towers) {
      if (!TOWERS[t.type] || t.type === 'rig') continue;
      for (let p = 0; p < 3; p++) {
        const info = sim.upgradeInfo(t.id, p);
        if (info.state === 'locked' || info.state === 'maxed') continue;
        let bestV = -Infinity, bestG = 0;
        const lv = t.levels.slice();
        let total = 0;
        for (let k = 1; k <= 3; k++) {
          if (lv[p] >= 5 || crosspathReason(lv, p)) break;
          total += k === 1 ? info.cost : this.planCost(t.type, lv, [...lv.slice(0, p), lv[p] + 1, ...lv.slice(p + 1)]);
          lv[p]++;
          const g = this.upgradeGain(team, D, t, lv, tmp);
          const v = (g / total) * 1.05 * Math.pow(0.95, k - 1);
          if (v > bestV) { bestV = v; bestG = g; }
        }
        opts.push({ kind: 'upgrade', id: t.id, path: p, cost: info.cost, value: bestV, gain: bestG, tier: info.tier });
      }
    }
    // a Command Beacon beside the most valuable cluster
    if (this.types.indexOf('beacon') >= 0 && sim.state.towers.length >= 6 && (counts.beacon || 0) < 3) {
      const b = this.bestBeaconSpot(team, D);
      if (b) opts.push(b);
    }
    return opts;
  }

  // Value of a new tower of `type` at `levels` placed at (x, y).
  placeGain(team, D, type, levels, x, y, spotIdx, tmp) {
    const stats = statsFor(type, levels);
    const sf = this.slowFactorAt(x, y, stats.range, team.slows, -1, kineticOnly(type, levels));
    this.contribution(type, levels, x, y, spotIdx, null, sf, tmp);
    let g = this.gain(team.cap, D, tmp, null);
    const sl = slowOf(stats);
    if (sl.s > 0) g += this.slowGain(team, D, x, y, sl);
    return g;
  }

  // Value of tower t moving to `lv`.
  upgradeGain(team, D, t, lv, tmp) {
    if (t.type === 'beacon') return this.beaconGain(team, D, t.x, t.y, statsFor('beacon', lv).aura, t.id);
    const cur = team.per.get(t.id);
    const sf = this.slowFactorAt(t.x, t.y, t.stats.range, team.slows, t.id, kineticOnly(t.type, lv));
    this.contribution(t.type, lv, t.x, t.y, -1, t.buffs, sf, tmp);
    let g = this.gain(team.cap, D, tmp, cur);
    const s0 = slowOf(t.stats), s1 = slowOf(statsFor(t.type, lv));
    if (s1.s > s0.s + 0.01 || s1.radius > s0.radius + 5) g += this.slowGain(team, D, t.x, t.y, s1, t.id) - this.slowGain(team, D, t.x, t.y, s0, t.id);
    if (statsFor(t.type, lv).abilities.length > t.stats.abilities.length) g *= 1.15;
    return g;
  }

  // Credits to go from levels `a` to levels `b` on one tower (difficulty prices, no discount).
  planCost(type, a, b) {
    const def = TOWERS[type];
    let c = 0;
    for (let p = 0; p < 3; p++) for (let k = a[p]; k < b[p]; k++) c += priceFor(def.paths[p].upgrades[k].cost, this.sim.state.difficulty);
    return c;
  }

  // Extra value of a slowing field: covered towers kill more while meteors crawl through.
  slowGain(team, D, x, y, sl, selfId = -1) {
    if (!(sl.s > 0)) return 0;
    const sim = this.sim;
    const lanes = sim.lanes;
    const add = [];
    for (let l = 0; l < lanes; l++) add.push(new Float64Array(NC));
    for (const t of sim.state.towers) {
      if (t.id === selfId) continue;
      const v = team.per.get(t.id);
      if (!v) continue;
      const kin = kineticOnly(t.type, t.levels);
      const cur = this.slowFactorAt(t.x, t.y, t.stats.range, team.slows, t.id, kin);
      const dx = t.x - x, dy = t.y - y, rr = sl.radius + (Number.isFinite(t.stats.range) ? t.stats.range : 0) * 0.6;
      if (dx * dx + dy * dy > rr * rr) continue;
      const nw = sl.freeze && kin ? Math.min(cur, cur * 0.8) : Math.max(cur, 1 + 0.6 * sl.s);
      if (nw === cur) continue;
      const f = nw / cur - 1;
      for (let l = 0; l < lanes; l++) for (let c = 0; c < NC; c++) add[l][c] += v[l][c] * f;
    }
    return this.gain(team.cap, D, add, null);
  }

  // Value of an aura at (x, y) over what the covered towers already get.
  beaconGain(team, D, x, y, au, selfId = -1) {
    if (!au) return 0;
    const sim = this.sim;
    const lanes = sim.lanes;
    const add = [];
    for (let l = 0; l < lanes; l++) add.push(new Float64Array(NC));
    const tmp = [];
    for (let l = 0; l < lanes; l++) tmp.push(new Float64Array(NC));
    const r2 = (au.radius || 0) * (au.radius || 0);
    for (const t of sim.state.towers) {
      if (t.type === 'rig' || t.type === 'beacon' || t.hero || !TOWERS[t.type]) continue;
      const dx = t.x - x, dy = t.y - y;
      if (dx * dx + dy * dy > r2) continue;
      const cur = team.per.get(t.id);
      if (!cur) continue;
      const b0 = t.buffs || {};
      // what this tower's buffs become with the new aura merged in (best value per field)
      const nb = {
        rateMult: Math.max(b0.rateMult || 1, au.rateMult || 1),
        rangeMult: Math.max(b0.rangeMult || 1, au.rangeMult || 1),
        damageAdd: Math.max(b0.damageAdd || 0, au.damageAdd || 0),
        detection: !!(b0.detection || au.detection || au.strip),
        bypass: [...((b0.bypass) || []), ...((au.bypass) || [])],
      };
      // a beacon being upgraded: its old aura is part of b0 already (best-of), fine for a gain
      const sf = this.slowFactorAt(t.x, t.y, t.stats.range, team.slows, t.id, kineticOnly(t.type, t.levels));
      this.contribution(t.type, t.levels, t.x, t.y, -1, nb, sf, tmp);
      for (let l = 0; l < lanes; l++) for (let c = 0; c < NC; c++) add[l][c] += Math.max(0, tmp[l][c] - cur[l][c]);
    }
    return this.gain(team.cap, D, add, null);
  }

  bestBeaconSpot(team, D) {
    const sim = this.sim;
    const au = statsFor('beacon', [0, 0, 0]).aura;
    if (!au) return null;
    let best = null;
    // candidate spots: around each damage tower
    const tried = new Set();
    for (const t of sim.state.towers) {
      if (t.type === 'rig' || t.type === 'beacon' || t.hero) continue;
      for (let k = 0; k < 8; k++) {
        const g = (k / 8) * Math.PI * 2;
        const x = Math.round((t.x + Math.cos(g) * 60) / 6) * 6, y = Math.round((t.y + Math.sin(g) * 60) / 6) * 6;
        const key = x * 10000 + y;
        if (tried.has(key)) continue;
        tried.add(key);
        if (!sim.canPlace('beacon', x, y).spotOk) continue;
        const gn = this.beaconGain(team, D, x, y, au);
        const cost = sim.priceAt('beacon', x, y);
        const v = gn / cost;
        if (!best || v > best.value) best = { kind: 'place', type: 'beacon', x, y, cost, value: v, gain: gn };
      }
    }
    return best;
  }

  // ---------------------------------------------------------------- acting
  fireAbilities() {
    const sim = this.sim;
    if (!this.useAbilities || sim.state.phase !== 'wave') return;
    const bar = sim.abilityBar();
    if (!bar.length) return;
    let ships = 0, n = 0;
    for (const e of sim.state.enemies) { if (e.dead) continue; n++; if (e.ship) ships++; }
    const titan = !!sim.state.titan;
    for (const g of bar) {
      if (!g.usable) continue;
      if (titan || ships > 0 || n > 60) sim.useAbility(g.id);
    }
  }

  placeHero() {
    const sim = this.sim;
    if (!this.heroId || sim._heroTower || this.heroPlaced) return;
    const def = HEROES[this.heroId];
    if (!def || sim.state.cash < sim.priceOf(this.heroId)) return;
    const stats = statsFor(this.heroId, [0, 0, 0]);
    const r = Number.isFinite(stats.range) ? stats.range : 200;
    for (const i of this.orderFor(r)) {
      const s = this.spots[i];
      if (sim.canPlace(this.heroId, s.x, s.y).ok) { if (sim.placeTower(this.heroId, s.x, s.y).ok) this.heroPlaced = true; return; }
    }
  }

  reserve() { return 0; }

  // Share of the coming demand the current defense covers (0..1, saturating value / demand).
  readiness(D, team) {
    let tot = 0;
    for (const a of D) for (const v of a) tot += v;
    return tot > 0 ? this.value((team || this.team()).cap, D) / tot : 1;
  }

  act(inWave) {
    const sim = this.sim;
    this.fireAbilities();
    if (sim.state.wave >= 1 || sim.state.towers.length >= 2) this.placeHero();
    const D = this.demand();
    this.ready = this.readiness(D);
    for (let guard = 0; guard < 40; guard++) {
      const cash = sim.state.cash - this.reserve();
      const horizon = cash + this.lastIncome * 1.5;
      const team = this.team();
      const opts = this.options(team, D).filter((o) => o.cost <= horizon && o.value > 1e-7);
      if (!opts.length) break;
      opts.sort((a, b) => b.value - a.value);
      let best = opts[0];
      if (best.cost > cash) {
        // Save up only while the defense is holding and the purchase is clearly better.
        const affordable = opts.filter((o) => o.cost <= cash);
        const holding = (this.calm || 0) >= 3 && sim.state.wave >= 6 && this.ready >= 0.95;
        const soon = best.cost - cash <= this.lastIncome * 1.1 && (!affordable.length || best.value > affordable[0].value * 1.25);
        // a one-life run does not save up during the opening while the next waves are not covered
        const exposed = sim.state.maxLives <= 20 && sim.state.wave < 10 && this.ready < 1;
        if (((holding || soon) && !exposed) || !affordable.length) break;
        best = affordable[0];
      }
      let r;
      if (best.kind === 'place') {
        r = sim.placeTower(best.type, best.x, best.y);
        if (r.ok && TOWERS[best.type] && statsFor(best.type, [0, 0, 0])._attackList.some((a) => a.kind === 'mortar')) {
          const a = this.bestAim();
          sim.setAim(r.id, a.x, a.y);
        }
      } else r = sim.upgrade(best.id, best.path);
      if (!r.ok) break;
    }
  }
}

class EcoBot extends SolidBot {
  maxRigs() {
    const w = this.sim.state.wave;
    return Math.min(10, 1 + Math.floor(w / 5));
  }
  wantRig() {
    const sim = this.sim;
    const w = sim.state.wave;
    if (!(TOWERS.rig && w >= 3 && w <= 40 && sim.state.rigCount < this.maxRigs() && (w < 8 || (this.calm || 0) >= 2))) return false;
    // only while the defense already covers the coming waves
    if (this.ready === undefined) this.ready = this.readiness(this.demand());
    return this.ready >= 0.92;
  }
  // Keep credits back for the next Rig (and pending Rig upgrades) while the defense holds.
  reserve() {
    if (!this.wantRig()) return 0;
    return Math.min(this.sim.priceOf('rig'), this.sim.state.cash * 0.7);
  }
  act(inWave) {
    const sim = this.sim;
    if (TOWERS.rig) {
      this.ready = this.readiness(this.demand());
      for (const t of sim.state.towers) {
        if (t.type === 'rig' && (t.data.vault || 0) > 0 && t.stats.income && t.stats.income.vault && t.data.vault >= t.stats.income.vault.cap * 0.95) sim.withdraw(t.id);
      }
      const w = sim.state.wave;
      if (!inWave && this.wantRig() && sim.state.cash >= sim.priceOf('rig')) {
        // far from the path: rigs do not need coverage
        if (!this.rigOrder) this.rigOrder = this.spots.map((s, i) => i).filter((i) => this.spots[i].dist > 90).sort((a, b) => this.spots[b].dist - this.spots[a].dist || a - b);
        for (const i of this.rigOrder) { const s = this.spots[i]; if (sim.canPlace('rig', s.x, s.y).ok) { sim.placeTower('rig', s.x, s.y); break; } }
      }
      // Deep Drill upgrades while they still pay back before ore prices fall (wave 50+),
      // plus a Compound Ledger crosspath once a Rig reaches Deep Shaft.
      if (!inWave && w >= 6 && (this.calm || 0) >= 2 && this.ready >= 0.92) {
        const left = Math.max(0, 48 - w);
        const rigs = sim.state.towers.filter((t) => t.type === 'rig').sort((a, b) => a.levels[0] - b.levels[0] || a.id - b.id);
        for (const t of rigs) {
          const cur = t.stats.income ? t.stats.income.perWave : 0;
          for (const p of [0, 1]) {
            const info = sim.upgradeInfo(t.id, p);
            if (info.state !== 'available') continue;
            if (p === 1 && (t.levels[0] < 3 || t.levels[1] >= 2)) continue;
            const lv = t.levels.slice(); lv[p]++;
            const nx = statsFor('rig', lv).income;
            const extra = (nx ? nx.perWave : 0) - cur + (nx && nx.vault ? nx.vault.rate * Math.min(nx.vault.cap, 2000) * 0.5 : 0);
            if (extra <= 0) continue;
            const payback = info.cost / extra;
            if (payback < left * 0.55 && sim.state.cash >= info.cost * 1.3) sim.upgrade(t.id, p);
          }
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
  for (const t of st.towers) if (bad(t.damage) || bad(t.x) || bad(t.cashEarned)) throw new Error(`NaN tower ${t.type} ${t.id}`);
}

export function runGame({ map = 'crater', difficulty = 'pilot', bot = 'solid', waves = 80, seed = 1, quiet = false, log = console.log, maxTicksPerWave = 60 * 600, god = false, cash = null, hero = null, abilities = true, onEvent = null } = {}) {
  const sim = new Sim({ mapId: map, difficulty, seed, heroId: hero });
  // test-only overrides (stress the engine at high waves)
  if (god) { sim.state.lives = 1e15; sim.state.maxLives = 1e15; }
  if (cash !== null) sim.state.cash = cash;
  const Bot = BOTS[bot];
  if (!Bot) throw new Error('unknown bot ' + bot);
  const b = new Bot(sim, seed);
  if (!abilities) b.useAbilities = false;
  const lanes = sim.lanes;
  let waveT0 = performance.now();
  let leaked0 = 0, cash0 = 0, ticksThisWave = 0;
  const t0 = performance.now();
  const abilityUses = {};
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
    else if (ticksThisWave % 30 === 0) b.fireAbilities && b.fireAbilities();
    if (ticksThisWave > maxTicksPerWave) throw new Error(`wave ${sim.state.wave} did not finish in ${maxTicksPerWave} ticks`);
    const evs = sim.drainEvents();
    for (const ev of evs) {
      if (onEvent) onEvent(ev, sim);
      if (ev.t === 'ability') abilityUses[ev.id] = (abilityUses[ev.id] || 0) + 1;
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
  checkFinite(sim);
  saveProfileCache();
  const st = sim.state;
  const summary = {
    bot, map, difficulty, seed, hero,
    cleared: st.cleared, over: st.phase === 'over', towers: st.towers.length,
    levels: st.towers.map((t) => t.type + ':' + t.levels.join('')).join(' '),
    cash: Math.floor(st.cash), lives: Math.ceil(st.lives), ms: Math.round(performance.now() - t0), ticks: st.tick, hash: sim.hash(),
    abilityUses,
  };
  return { sim, summary };
}

// ------------------------------------------------------------------ perf benchmark
// ships: keep this many Haulers alive among the enemies, titan: keep one Storm Titan on the field
// (late waves always have ships, and every 20th wave a Titan; both are big bodies for the grid).
export function runPerf({ enemies = 1500, towers = 40, ticks = 600, seed = 3, projectiles = 0, ships = 0, titan = false, log = console.log } = {}) {
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
    if (titan && !sim._titans.some((e) => !e.dead)) {
      sim.spawnEnemy('titan', { d: L * 0.3, titan: { kind: 'aegis', tier: 5, hp: 1e12 } });
      live++;
    }
    if (ships > 0) {
      let n = 0;
      for (const e of sim.state.enemies) if (!e.dead && e.ship && e.titan === null) n++;
      while (n < ships) {
        sim.spawnEnemy('hauler', { d: rng.next() * L * 0.9, wave: 30, hullMult: 50 });
        n++; live++;
      }
    }
    while (live < enemies) {
      const type = rng.next() < 0.1 ? 'obsidian' : rng.next() < 0.5 ? 'rose' : 'geode';
      sim.spawnEnemy(type, { d: rng.next() * L * 0.9, wave: 30, off: (rng.next() - 0.5) * 18, nanite: rng.next() < 0.2 });
      live++;
    }
  };
  topUp();
  for (let i = 0; i < 60; i++) { sim.step(); topUp(); sim.drainEvents(); }
  let tSim = 0, eSum = 0, pSum = 0, shots = 0, worst = 0;
  const pops0 = sim.state.stats.pops;
  for (let i = 0; i < ticks; i++) {
    topUp();
    const a = performance.now();
    sim.step();
    const d = performance.now() - a;
    tSim += d; if (d > worst) worst = d;
    eSum += sim.state.enemies.length; pSum += sim.state.projectiles.length;
    for (const ev of sim.drainEvents()) if (ev.t === 'shot') shots++;
  }
  const tps = ticks / (tSim / 1000);
  log(`perf: ${placed} towers${ships ? ', ' + ships + ' ships' : ''}${titan ? ', a Titan' : ''}, avg ${Math.round(eSum / ticks)} enemies, avg ${Math.round(pSum / ticks)} projectiles, ${Math.round(shots / (ticks / 60))} shots/s, ${Math.round((sim.state.stats.pops - pops0) / (ticks / 60))} pops/s, ${ticks} ticks in ${tSim.toFixed(0)} ms = ${Math.round(tps)} ticks/s (${(tSim / ticks).toFixed(3)} ms/tick, worst ${worst.toFixed(2)} ms; 3x speed needs 180 ticks/s)`);
  return tps;
}

// ------------------------------------------------------------------ CLI
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const flag = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] !== undefined && !args[i + 1].startsWith('--') ? args[i + 1] : d; };
  const has = (n) => args.includes('--' + n);
  if (has('help') || has('h')) {
    console.log(`node tools/headless.mjs [options]
  --map crater|frost|dock|ember|prism   (default crater)
  --difficulty cadet|pilot|veteran|nightmare (default pilot)
  --bot novice|solid|eco                (default solid)
  --waves N       stop after N cleared waves (default 80)
  --seed N        run seed (default 1)
  --hero vega|nova|brick   place this Commander (solid/eco bots)
  --abilities off never fire abilities
  --god           practically infinite Core Integrity (engine stress tests)
  --cash N        starting credits override
  --quiet         no per-wave lines;  --hash  print the final state hash;  --verbose  list towers
  --perf [--enemies N --towers N --ticks N --projectiles N --ships N --titan]   engine performance benchmark`);
    process.exit(0);
  }
  try {
    if (has('perf')) {
      runPerf({ enemies: Number(flag('enemies', 1500)), towers: Number(flag('towers', 40)), ticks: Number(flag('ticks', 600)), projectiles: Number(flag('projectiles', 0)), ships: Number(flag('ships', 0)), titan: has('titan') });
    } else {
      const { summary } = runGame({
        map: flag('map', 'crater'), difficulty: flag('difficulty', 'pilot'), bot: flag('bot', 'solid'),
        waves: Number(flag('waves', 80)), seed: Number(flag('seed', 1)), quiet: has('quiet'),
        god: has('god'), cash: flag('cash', null) !== null ? Number(flag('cash', 0)) : null,
        hero: flag('hero', null), abilities: flag('abilities', 'on') !== 'off',
      });
      console.log(`${summary.over ? 'GAME OVER' : 'SURVIVED'}: bot=${summary.bot} map=${summary.map} difficulty=${summary.difficulty} seed=${summary.seed}${summary.hero ? ' hero=' + summary.hero : ''} cleared=${summary.cleared} towers=${summary.towers} cash=${summary.cash} lives=${summary.lives} ticks=${summary.ticks} time=${summary.ms}ms`);
      if (has('hash')) console.log('hash ' + summary.hash);
      if (has('verbose')) { console.log('towers: ' + summary.levels); console.log('abilities used: ' + JSON.stringify(summary.abilityUses)); }
    }
  } catch (e) {
    console.error('ERROR: ' + (e && e.stack || e));
    process.exit(1);
  }
}
