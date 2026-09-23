// Simulation engine tests. Usage: node tools/simtest.mjs [--verbose]
// Exits 1 if any assertion fails.
import { Sim } from '../src/sim/game.js';
import { TOWERS } from '../src/data/towers/index.js';
import { HEROES } from '../src/data/heroes.js';
import { MAPS } from '../src/data/maps.js';
import { ENEMIES, familyMass } from '../src/data/enemies.js';
import { priceFor, SELL_RATE, heroXpForWave, heroXpNeed, TICK, incomeFactor, BASE_SPEED } from '../src/data/economy.js';
import { payWaveIncome } from '../src/sim/economy.js';
import { Path } from '../src/sim/path.js';
import { Rng } from '../src/core/rng.js';
import { buildWave } from '../src/sim/wavegen.js';
import { MAW_SPIT_EVERY, mawSpitType } from '../src/sim/enemies.js';
import { EVENT_CAP } from '../src/sim/game.js';
import { computeBaseStats, finalizeStats } from '../src/sim/towers.js';
import { titanHp } from '../src/data/economy.js';

const verbose = process.argv.includes('--verbose');
let passed = 0, failed = 0;
const failures = [];
function ok(cond, msg) {
  if (cond) { passed++; if (verbose) console.log('  ok   ' + msg); }
  else { failed++; failures.push(msg); console.log('  FAIL ' + msg); }
}
function eq(a, b, msg) { ok(a === b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }
function near(a, b, msg, eps = 1e-6) { ok(Math.abs(a - b) <= eps, `${msg} (got ${a}, want ${b})`); }
function section(name, fn) {
  console.log(name);
  try { fn(); } catch (e) { failed++; failures.push(name + ': ' + e.message); console.log('  FAIL threw ' + (e.stack || e)); }
}

// helpers -----------------------------------------------------------------------------------
function newSim(opts = {}) { return new Sim({ mapId: 'crater', difficulty: 'pilot', seed: 11, ...opts }); }
// Legal spots near the path, deterministic order.
function spots(sim, type = 'pulse', maxDist = 140) {
  const out = [];
  for (let y = 30; y < 980; y += 22) for (let x = 30; x < 1480; x += 22) {
    if (sim.canPlace(type, x, y).spotOk && sim.nearestPathPoint(x, y).dist < maxDist) out.push([x, y]);
  }
  return out;
}
function place(sim, type, i = 0) {
  const s = spots(sim, type);
  for (let k = i; k < s.length; k++) {
    const r = sim.placeTower(type, s[k][0], s[k][1]);
    if (r.ok) return r.id;
  }
  throw new Error('no spot for ' + type);
}
function runWave(sim, max = 60 * 900) {
  const r = sim.startWave();
  if (!r.ok) throw new Error('startWave: ' + r.reason);
  let n = 0;
  while (sim.state.phase === 'wave' && n++ < max) sim.step();
  sim.drainEvents();
}
function findNaN(obj, path = 'state', seen = new Set(), depth = 0) {
  if (obj === null || typeof obj !== 'object' || seen.has(obj) || depth > 6) return null;
  seen.add(obj);
  for (const k of Object.keys(obj)) {
    if (k === 'def' || k === 'src' || k === 'atk' || k === 'baseStats' || k === 'stats') continue;
    const v = obj[k];
    if (typeof v === 'number' && Number.isNaN(v)) return path + '.' + k;
    if (v && typeof v === 'object') { const r = findNaN(v, path + '.' + k, seen, depth + 1); if (r) return r; }
  }
  return null;
}
const SRC = (dtype, extra = {}) => ({ dtype, ...extra });

// -------------------------------------------------------------------------------------------
section('rng and path', () => {
  const a = new Rng(42), b = new Rng(42);
  let same = true;
  for (let i = 0; i < 100; i++) if (a.next() !== b.next()) same = false;
  ok(same, 'same seed gives same sequence');
  const st = a.getState(); const x1 = a.next(); a.setState(st); ok(a.next() === x1, 'rng state restore');
  const p = new Path([[0, 0], [100, 0], [200, 100]], { step: 2 });
  ok(p.length > 200 && p.length < 260, 'path length plausible: ' + p.length.toFixed(1));
  const q = p.pointAt(p.length / 2);
  ok(Number.isFinite(q.x) && Number.isFinite(q.y) && Number.isFinite(q.angle), 'pointAt finite');
  const e = p.pointAt(p.length + 50); near(e.x, 200, 'pointAt clamps to end x', 1e-6); near(e.y, 100, 'pointAt clamps to end y', 1e-6);
  ok(p.within(50, 5, 10) && !p.within(50, 40, 10), 'within()');
  ok(Math.abs(p.distance(50, 20) - 20) < 5, 'distance() ~20: ' + p.distance(50, 20).toFixed(2));
  // successive samples are ~step apart
  let maxGap = 0; for (let i = 1; i < p.n - 1; i++) maxGap = Math.max(maxGap, Math.hypot(p.xs[i] - p.xs[i - 1], p.ys[i] - p.ys[i - 1]));
  ok(maxGap <= 2.001, 'arc-length samples every 2 units (max gap ' + maxGap.toFixed(4) + ')');
});

section('placement rules', () => {
  const sim = newSim();
  const P = sim.paths[0];
  const mid = P.pointAt(1000);
  eq(sim.canPlace('pulse', mid.x, mid.y).reason, 'On the channel', 'on channel rejected');
  eq(sim.canPlace('pulse', 5, 500).reason, 'Out of bounds', 'bounds margin');
  const b = MAPS.crater.blockers[0];
  eq(sim.canPlace('pulse', b.x, b.y).reason, 'Blocked by terrain', 'blocker rejected');
  const core = MAPS.crater.core;
  const coreChk = sim.canPlace('pulse', core.x - 50, core.y + 50);
  ok(coreChk.reason === 'Too close to the Core' || coreChk.reason === 'On the channel', 'core keep-out: ' + coreChk.reason);
  const [x, y] = spots(sim)[0];
  ok(sim.placeTower('pulse', x, y).ok, 'legal placement');
  eq(sim.canPlace('pulse', x + 10, y).reason, 'Too close to another tower', 'tower overlap rejected');
  eq(sim.canPlace('nope', x, y).reason, 'Unknown tower', 'unknown tower');
  sim.state.cash = 0;
  const far = spots(sim)[5];
  const c = sim.canPlace('pulse', far[0], far[1]);
  ok(!c.ok && c.spotOk && c.reason === 'Not enough credits', 'affordability separate from spot validity');
});

section('crosspath rules', () => {
  const sim = newSim(); sim.state.cash = 1e7;
  const id = place(sim, 'pulse');
  const up = (p) => sim.upgrade(id, p).ok;
  ok(up(0) && up(0) && up(0), 'path A to 3');
  ok(up(1) && up(1), 'path B to 2 (3-2-0)');
  ok(!up(1), '3-3-0 rejected');
  eq(sim.upgradeInfo(id, 1).state, 'locked', 'upgradeInfo shows locked');
  ok(!up(2), '3-2-1 rejected (third path)');
  ok(up(0) && up(0), '5-2-0 legal');
  eq(sim.upgradeInfo(id, 0).state, 'maxed', 'maxed state');
  const id2 = place(sim, 'pulse', 3);
  ok(sim.upgrade(id2, 0).ok && sim.upgrade(id2, 1).ok, '1-1-0 ok');
  ok(!sim.upgrade(id2, 2).ok, '1-1-1 rejected');
  const id3 = place(sim, 'missile', 6);
  ok([1, 1, 2, 2, 2, 2].every((p) => sim.upgrade(id3, p).ok), '0-2-4 legal');
  const id4 = place(sim, 'missile', 12);
  ok([0, 0, 2, 2, 2].every((p) => sim.upgrade(id4, p).ok), '2-0-3 legal');
});

section('tier 5 uniqueness', () => {
  const sim = newSim(); sim.state.cash = 1e7;
  const a = place(sim, 'pulse'), b = place(sim, 'pulse', 4);
  for (let i = 0; i < 5; i++) sim.upgrade(a, 0);
  for (let i = 0; i < 4; i++) sim.upgrade(b, 0);
  eq(sim.state.t5Owned['pulse:0'], a, 't5Owned records owner');
  const info = sim.upgradeInfo(b, 0);
  ok(info.state === 'locked' && /Only one/.test(info.reason), 'second T5 locked: ' + info.reason);
  sim.sell(a);
  ok(sim.state.t5Owned['pulse:0'] === undefined, 'selling frees the T5');
  ok(sim.upgrade(b, 0).ok, 'other tower can now take the T5');
  const c = place(sim, 'pulse', 8);
  for (let i = 0; i < 4; i++) sim.upgrade(c, 1);
  ok(sim.upgrade(c, 1).ok, 'a different path T5 is independent');
});

section('sell and undo', () => {
  const sim = newSim(); sim.state.cash = 5000;
  const price = priceFor(TOWERS.pulse.cost, 'pilot');
  const c0 = sim.state.cash;
  const id = place(sim, 'pulse');
  eq(sim.state.cash, c0 - price, 'paid price');
  eq(sim.sellValue(id), price, 'undo value = 100% in same build phase');
  sim.sell(id);
  eq(sim.state.cash, c0, 'undo refunds fully');
  const id2 = place(sim, 'pulse');
  const up = sim.upgrade(id2, 0);
  eq(sim.sellValue(id2), price + up.cost, 'upgrade in same build phase is undoable too');
  runWave(sim);
  eq(sim.sellValue(id2), Math.floor((price + up.cost) * SELL_RATE + 1e-9), 'after a wave launched: 70%');
  const up2 = sim.upgrade(id2, 0);
  eq(sim.sellValue(id2), Math.floor((price + up.cost) * SELL_RATE + 1e-9) + up2.cost, 'new build-phase upgrade undoable, older spend 70%');
  // purchases during a wave are never undoable
  sim.startWave();
  const id3 = place(sim, 'pulse', 5);
  eq(sim.sellValue(id3), Math.floor(price * SELL_RATE), 'bought mid-wave: 70%');
  // no arbitrage: buy+sell never increases cash
  const cash = sim.state.cash;
  const id4 = place(sim, 'missile', 9); sim.upgrade(id4, 0); sim.sell(id4);
  ok(sim.state.cash <= cash + 1e-9, 'buy/upgrade/sell never creates credits');
});

section('discounts never apply to rigs or beacons', () => {
  const saved = { beacon: TOWERS.beacon, rig: TOWERS.rig };
  TOWERS.beacon = { id: 'beacon', name: 'Test Beacon', cost: 900, radius: 22, base: { range: 200, attacks: {}, aura: { radius: 400, discount: 0.15 } }, paths: [] };
  TOWERS.rig = { id: 'rig', name: 'Test Rig', cost: 1000, radius: 22, base: { range: 0, attacks: {}, income: { perWave: 100 } }, paths: [] };
  try {
    const sim = newSim(); sim.state.cash = 1e6;
    const bid = place(sim, 'beacon');
    const bt = sim.getTower(bid);
    const s = spots(sim).find(([x, y]) => Math.hypot(x - bt.x, y - bt.y) < 300 && sim.canPlace('pulse', x, y).ok);
    ok(!!s, 'found a spot inside the beacon aura');
    const base = sim.priceOf('pulse');
    ok(sim.priceAt('pulse', s[0], s[1]) < base, `pulse discounted near beacon (${sim.priceAt('pulse', s[0], s[1])} < ${base})`);
    eq(sim.priceAt('rig', s[0], s[1]), sim.priceOf('rig'), 'rig never discounted');
    eq(sim.priceAt('beacon', s[0], s[1]), sim.priceOf('beacon'), 'beacon never discounted');
    const pid = sim.placeTower('pulse', s[0], s[1]).id;
    const info = sim.upgradeInfo(pid, 0);
    ok(info.cost < priceFor(TOWERS.pulse.paths[0].upgrades[0].cost, 'pilot'), 'upgrade discounted near beacon');
    // a second beacon does not stack
    const b2 = sim.placeTower('beacon', ...spots(sim).find(([x, y]) => Math.hypot(x - bt.x, y - bt.y) < 250 && sim.canPlace('beacon', x, y).ok)).id;
    ok(!!b2, 'second beacon placed');
    eq(sim.priceAt('pulse', s[0] + 0.1, s[1]), sim.priceAt('pulse', s[0], s[1]), 'discounts do not stack');
    // rig income paid at wave clear, x c(w)
    const rid = place(sim, 'rig', 20);
    const cash0 = sim.state.cash;
    runWave(sim);
    ok(sim.getTower(rid).cashEarned >= 100 - 1e-9, 'rig paid its income at wave clear');
    ok(sim.state.cash > cash0, 'cash rose');
  } finally {
    if (saved.beacon) TOWERS.beacon = saved.beacon; else delete TOWERS.beacon;
    if (saved.rig) TOWERS.rig = saved.rig; else delete TOWERS.rig;
  }
});

section('vault interest is capped', () => {
  const saved = TOWERS.rig;
  TOWERS.rig = { id: 'rig', name: 'Test Rig', cost: 1000, radius: 22, base: { range: 0, attacks: {}, income: { perWave: 100, vault: { rate: 0.1, cap: 500 } } }, paths: [] };
  try {
    const sim = newSim(); sim.state.cash = 1e5; sim.state.lives = 1e9;
    const rid = place(sim, 'rig');
    for (let i = 0; i < 8; i++) runWave(sim);
    const t = sim.getTower(rid);
    near(t.data.vault, 500, 'vault stops at cap');
    ok(t.cashEarned > 0, 'overflow above cap paid out');
    const c = sim.state.cash;
    ok(sim.withdraw(rid).ok && Math.abs(sim.state.cash - c - 500) < 1e-9, 'withdraw pays the balance');
    ok(!sim.withdraw(rid).ok, 'empty vault withdraw fails');
  } finally { if (saved) TOWERS.rig = saved; else delete TOWERS.rig; }
});

section('vault interest follows c(w)', () => {
  const saved = TOWERS.rig;
  TOWERS.rig = { id: 'rig', name: 'Test Rig', cost: 1000, radius: 22, base: { range: 0, attacks: {}, income: { perWave: 0, vault: { rate: 0.1, cap: 1000 } } }, paths: [] };
  try {
    for (const w of [30, 50, 80, 120]) {
      const sim = newSim(); sim.state.cash = 1e5;
      const rid = place(sim, 'rig');
      const t = sim.getTower(rid);
      t.data.vault = 500;
      payWaveIncome(sim, w);
      near(t.data.vault, 500 + 50 * incomeFactor(w), `wave ${w}: interest = rate x balance x c(w)`);
    }
  } finally { if (saved) TOWERS.rig = saved; else delete TOWERS.rig; }
});

section('ship stuns do not chain', () => {
  const sim = newSim(); sim.state.lives = 1e9;
  const e = sim.spawnEnemy('hauler', { d: 300 });
  const fx = { stun: { t: 1, shipT: 0.5 } };
  sim.applyEffects(e, fx, SRC('ENERGY'));
  near(e.stunT, 0.5, 'first stun lands');
  sim.applyEffects(e, { stun: { t: 1, shipT: 2 } }, SRC('ENERGY'));
  near(e.stunT, 0.5, 'a running stun is not extended on a ship');
  for (let i = 0; i < Math.round(0.55 / TICK); i++) sim.step();
  ok(e.stunT <= 0 && e.stunImmT > 0, 'immunity window after the stun');
  sim.applyEffects(e, fx, SRC('ENERGY'));
  ok(e.stunT <= 0, 'no stun during the immunity window');
  for (let i = 0; i < Math.round(1.05 / TICK); i++) sim.step();
  sim.applyEffects(e, fx, SRC('ENERGY'));
  near(e.stunT, 0.5, 'stuns again after the window');
  // a meteor still takes the longest stun
  const m = sim.spawnEnemy('rose', { d: 200 });
  sim.applyEffects(m, { stun: { t: 1 } }, SRC('ENERGY'));
  sim.applyEffects(m, { stun: { t: 2 } }, SRC('ENERGY'));
  near(m.stunT, 2, 'meteor stuns refresh to the longest');
});

section('a ship stops a penetrating rail slug', () => {
  // Siege Rail (4-0-0): a line of 5; the first ship in the line stops the slug
  const sim = newSim(); sim.state.cash = 1e6; sim.state.lives = 1e9;
  const id = place(sim, 'rail');
  for (let k = 0; k < 4; k++) sim.upgrade(id, 0);
  const t = sim.getTower(id);
  const a = t.stats.attacks.main;
  ok(a.line && a.pierce === 5, 'Siege Rail fires a 5-target line');
  const p = sim.pathPoint(0, 400);
  const ships = [0, 1, 2].map(() => sim.spawnEnemy('hauler', { d: 400 }));
  const hp0 = ships.map((e) => e.hp);
  t.cd.main = 0; t.targeting = 'first';
  for (let i = 0; i < 3 && ships.every((e) => e.hp === e.maxHp); i++) sim.step();
  const hitShips = ships.filter((e, i) => e.hp < hp0[i]).length;
  eq(hitShips, 1, 'three stacked Haulers: one slug damages one hull');
  const s2 = newSim(); s2.state.cash = 1e6; s2.state.lives = 1e9;
  const id2 = place(s2, 'rail');
  for (let k = 0; k < 4; k++) s2.upgrade(id2, 0);
  const t2 = s2.getTower(id2);
  const mets = [0, 1, 2, 3].map(() => s2.spawnEnemy('obsidian', { d: 400 }));
  t2.cd.main = 0;
  for (let i = 0; i < 3 && mets.every((e) => e.hp === e.maxHp && !e.dead); i++) s2.step();
  ok(mets.filter((e) => e.dead || e.hp < e.maxHp).length >= 2, 'the same slug still punches through stacked meteors');
  void p;
});

section('rig cap', () => {
  const saved = TOWERS.rig;
  TOWERS.rig = { id: 'rig', name: 'Test Rig', cost: 100, radius: 16, base: { range: 0, attacks: {}, income: { perWave: 1 } }, paths: [] };
  try {
    const sim = newSim(); sim.state.cash = 1e6;
    let n = 0;
    const free = spots(sim, 'rig', 400);
    for (const [x, y] of free) { if (sim.placeTower('rig', x, y).ok) n++; if (n >= 12) break; }
    eq(n, 10, 'only 10 rigs can exist');
    eq(sim.state.rigCount, 10, 'rigCount tracked');
    ok(/limit/.test(sim.canPlace('rig', ...free[free.length - 1]).reason), 'rig limit reason');
  } finally { if (saved) TOWERS.rig = saved; else delete TOWERS.rig; }
});

section('immunity and bypass', () => {
  const sim = newSim();
  const iron = sim.spawnEnemy('iron', { d: 500 });
  let r = sim.damage(iron, 5, 'KINETIC', SRC('KINETIC'));
  ok(r.dealt === 0 && r.blocked && !iron.dead, 'iron blocks KINETIC');
  r = sim.damage(iron, 1, 'KINETIC', SRC('KINETIC', { bypass: ['KINETIC'] }));
  ok(iron.dead && r.pops === 1, 'dtype bypass hits iron');
  const iron2 = sim.spawnEnemy('iron', { d: 500 });
  sim.damage(iron2, 1, 'KINETIC', SRC('KINETIC', { bypass: ['iron'] }));
  ok(iron2.dead, 'enemy-type bypass hits iron');
  const magma = sim.spawnEnemy('magma', { d: 500 });
  ok(sim.damage(magma, 3, 'BLAST', SRC('BLAST')).dealt === 0, 'magma blocks BLAST');
  const prism = sim.spawnEnemy('prism', { d: 500 });
  ok(sim.damage(prism, 3, 'ENERGY', SRC('ENERGY')).dealt === 0 && sim.damage(prism, 3, 'THERMAL', SRC('THERMAL')).dealt === 0, 'prism blocks ENERGY and THERMAL');
  const geode = sim.spawnEnemy('geode', { d: 500 });
  ok(sim.damage(geode, 1, 'VOID', SRC('VOID')).pops === 1, 'VOID damages everything');
  const spec = sim.spawnEnemy('specter', { d: 500 });
  ok(spec.phantom && sim.damage(spec, 5, 'BLAST', SRC('BLAST')).dealt === 0, 'specter is phantom and immune to BLAST');
});

section('frozen and KINETIC', () => {
  const sim = newSim();
  const e = sim.spawnEnemy('jade', { d: 500 });
  sim.applyEffects(e, { freeze: { t: 2 } }, { dtype: 'CRYO' });
  ok(e.frozenT > 0, 'jade frozen');
  ok(sim.damage(e, 1, 'KINETIC', SRC('KINETIC')).dealt === 0, 'KINETIC blocked on frozen');
  ok(sim.damage(e, 1, 'KINETIC', SRC('KINETIC', { bypass: ['FROZEN'] })).pops === 1, 'FROZEN bypass cracks it');
  const e2 = sim.spawnEnemy('jade', { d: 500 });
  sim.applyEffects(e2, { freeze: { t: 2 } }, { dtype: 'CRYO' });
  ok(sim.damage(e2, 1, 'BLAST', SRC('BLAST')).pops === 1, 'BLAST hits frozen');
  const d0 = e2.dead ? 0 : e2.d;
  const c = sim.spawnEnemy('comet', { d: 500 });
  sim.applyEffects(c, { freeze: { t: 2 }, slow: { mult: 0.5, t: 2 } }, { dtype: 'CRYO' });
  ok(c.frozenT === 0 && c.slowMult === 1, 'comet cannot be frozen or CRYO-slowed');
  const h = sim.spawnEnemy('hauler', { d: 500 });
  sim.applyEffects(h, { freeze: { t: 2 } }, { dtype: 'CRYO' });
  ok(h.frozenT === 0 && Math.abs(h.slowMult - 0.6) < 1e-9, 'ship freeze becomes a 0.6 slow');
  // frozen enemies do not move
  const f = sim.spawnEnemy('rust', { d: 300 });
  sim.applyEffects(f, { freeze: { t: 1 } }, { dtype: 'CRYO' });
  const fd = f.d; for (let i = 0; i < 30; i++) sim.step();
  eq(f.d, fd, 'frozen rust did not move');
  for (let i = 0; i < 60; i++) sim.step();
  ok(f.d > fd, 'rust moves again after thaw');
  void d0;
});

section('overflow into children', () => {
  const sim = newSim();
  const pops0 = sim.state.stats.pops;
  const r = sim.spawnEnemy('rose', { d: 800 });
  const res = sim.damage(r, 3, 'VOID', SRC('VOID'));
  eq(res.pops, 3, 'rose hit for 3 pops 3 shells');
  sim.step();
  const alive = sim.state.enemies.filter((e) => !e.dead);
  ok(alive.length === 1 && alive[0].type === 'cobalt', 'one cobalt remains');
  eq(sim.state.stats.pops - pops0, 3, 'pops counted');
  const sim2 = newSim();
  const iron = sim2.spawnEnemy('iron', { d: 800 });
  const r2 = sim2.damage(iron, 3, 'VOID', SRC('VOID'));
  eq(r2.pops, 5, 'iron hit for 3: iron + 2 roses x 2 layers');
  const kids = sim2.state.enemies.filter((e) => !e.dead);
  ok(kids.length === 2 && kids.every((k) => k.type === 'jade'), 'two jades remain');
  // overflow respects child immunity: geode -> magma + comet, BLAST overflow stops at magma
  const sim3 = newSim();
  const aurora = sim3.spawnEnemy('aurora', { d: 800 });
  sim3.damage(aurora, 3, 'BLAST', SRC('BLAST'));
  const k3 = sim3.state.enemies.filter((e) => !e.dead);
  ok(k3.length === 2 && k3.every((k) => k.type === 'geode'), 'BLAST overflow blocked by geode immunity');
  // cash: 1 per shell at c(w)=1
  const sim4 = newSim(); const c0 = sim4.state.cash;
  sim4.damage(sim4.spawnEnemy('rose', { d: 800, wave: 5 }), 5, 'VOID', SRC('VOID'));
  near(sim4.state.cash - c0, 5, 'bounty 1 per shell at wave 5');
  const sim5 = newSim(); const c5 = sim5.state.cash;
  sim5.damage(sim5.spawnEnemy('rust', { d: 800, wave: 100 }), 1, 'VOID', SRC('VOID'));
  near(sim5.state.cash - c5, incomeFactor(100), 'bounty scaled by c(100) = ' + incomeFactor(100));
});

section('no overflow into ship children', () => {
  const sim = newSim();
  const h = sim.spawnEnemy('hauler', { d: 800 });
  const r = sim.damage(h, 5000, 'VOID', SRC('VOID'));
  eq(r.pops, 1, 'only the hull popped');
  const kids = sim.state.enemies.filter((e) => !e.dead);
  ok(kids.length === 4 && kids.every((k) => k.type === 'obsidian' && k.hp === 10), '4 full-HP obsidians');
  const w = sim.spawnEnemy('warbarge', { d: 1200, hullMult: 2 });
  eq(w.hp, 1400, 'hullMult applies to ship hull');
  sim.damage(w, 1e6, 'VOID', SRC('VOID'));
  const haulers = sim.state.enemies.filter((e) => !e.dead && e.type === 'hauler');
  ok(haulers.length === 4 && haulers.every((k) => k.hp === 400), 'child ships inherit hullMult and take no overflow');
  const p = sim.spawnEnemy('obsidian', { d: 900, plated: true });
  eq(p.hp, 20, 'plated doubles shell HP');
  sim.damage(p, 20, 'VOID', SRC('VOID'));
  ok(sim.state.enemies.filter((e) => !e.dead && e.type === 'aurora').every((a) => !a.plated), 'plated not inherited');
});

section('nanite regrow', () => {
  const sim = newSim();
  const e = sim.spawnEnemy('rust', { d: 100, nanite: true, origType: 'jade' });
  e.speedMult = 0.01;
  for (let i = 0; i < Math.round(3 / TICK) + 2; i++) sim.step();
  eq(e.type, 'cobalt', 'rust regrows to cobalt after 3 s');
  for (let i = 0; i < Math.round(3 / TICK) + 2; i++) sim.step();
  eq(e.type, 'jade', 'then to jade');
  for (let i = 0; i < Math.round(4 / TICK); i++) sim.step();
  eq(e.type, 'jade', 'never above origType');
  const e2 = sim.spawnEnemy('rust', { d: 100, nanite: true, origType: 'jade' });
  e2.speedMult = 0.01;
  for (let i = 0; i < 150; i++) { sim.step(); if (i % 60 === 0) sim.damage(e2, 0.01, 'VOID', SRC('VOID')); }
  eq(e2.type, 'rust', 'damage resets the regrow timer');
  const e3 = sim.spawnEnemy('rose', { d: 100, nanite: true, origType: 'iron' });
  e3.speedMult = 0.01;
  for (let i = 0; i < Math.round(3 / TICK) + 2; i++) sim.step();
  eq(e3.type, 'iron', 'special origType: rose regrows straight to iron');
  const e4 = sim.spawnEnemy('magma', { d: 100, nanite: true, origType: 'geode' });
  e4.speedMult = 0.01;
  for (let i = 0; i < Math.round(3 / TICK) + 2; i++) sim.step();
  eq(e4.type, 'geode', 'special current type returns to origType directly');
  // children of a nanite parent inherit nanite + origType
  const par = sim.spawnEnemy('jade', { d: 200, nanite: true });
  sim.damage(par, 1, 'VOID', SRC('VOID'));
  const kid = sim.state.enemies.find((x) => !x.dead && x.type === 'cobalt' && x.d > 150 && x.d < 250);
  ok(kid && kid.nanite && kid.origType === 'jade', 'children inherit nanite and origType');
  // phantom inheritance
  const ph = sim.spawnEnemy('jade', { d: 600, phantom: true });
  sim.damage(ph, 1, 'VOID', SRC('VOID'));
  ok(sim.state.enemies.some((x) => !x.dead && x.type === 'cobalt' && x.phantom), 'children inherit phantom');
});

section('specter scout (wave 50 debut)', () => {
  const sim = newSim(); sim.state.lives = 1e6;
  const L = sim.pathLength(0);
  const e = sim.spawnEnemy('specter', { d: L - 1, mods: { scout: true } });
  eq(e.hp, 80, 'scout Specter hull is a fifth of 400');
  eq(familyMass('specter', 1, false, true), 80, 'familyMass(specter, scout) = 80');
  for (let i = 0; i < 10; i++) sim.step();
  eq(1e6 - sim.state.lives, 80, 'a leaked scout costs 80 Integrity (a full Specter costs 816)');
  const s2 = newSim();
  const k = s2.spawnEnemy('specter', { d: 200, mods: { scout: true } });
  s2.damage(k, 1000, 'VOID', SRC('VOID'));
  eq(s2.state.enemies.filter((x) => !x.dead).length, 0, 'a destroyed scout drops no cargo');
  const w50 = buildWave(50);
  ok(w50.groups.some((g) => g.type === 'specter' && g.mods.scout), 'wave 50 debuts the Specter as a scout');
  ok(!buildWave(53).groups.some((g) => g.mods.scout), 'later Specters are full');
});

section('leak mass', () => {
  const sim = newSim();
  const L = sim.pathLength(0);
  const l0 = sim.state.lives;
  sim.spawnEnemy('cobalt', { d: L - 5 });
  for (let i = 0; i < 10; i++) sim.step();
  eq(l0 - sim.state.lives, 2, 'cobalt leak removes 2');
  const l1 = sim.state.lives;
  sim.spawnEnemy('obsidian', { d: L - 5, plated: true });
  for (let i = 0; i < 10; i++) sim.step();
  eq(l1 - sim.state.lives, 20 + 2 * 47, 'plated obsidian leaks 114');
  const sim2 = newSim(); sim2.state.lives = 1e6;
  const L2 = sim2.pathLength(0);
  sim2.spawnEnemy('hauler', { d: L2 - 1, hullMult: 2 });
  for (let i = 0; i < 10; i++) sim2.step();
  eq(1e6 - sim2.state.lives, familyMass('hauler', 2, false), 'hauler with H=2 leaks its H mass (816)');
  eq(familyMass('hauler', 2, false), 816, 'familyMass(hauler, 2) = 816');
  const h = sim2.spawnEnemy('hauler', { d: L2 - 1 });
  sim2.damage(h, 150, 'VOID', SRC('VOID'));
  const lb = sim2.state.lives;
  for (let i = 0; i < 10; i++) sim2.step();
  eq(lb - sim2.state.lives, 50 + 4 * 104, 'damaged hauler leaks remaining mass');
  const sim3 = newSim();
  sim3.spawnEnemy('titan', { d: sim3.pathLength(0) - 1, titan: { kind: 'maw', tier: 1, hp: 3000 } });
  for (let i = 0; i < 30; i++) sim3.step();
  eq(sim3.state.phase, 'over', 'titan leak ends the game');
  ok(sim3.drainEvents().some((e) => e.t === 'gameOver'), 'gameOver event');
});

// Exploit regressions (out/exploits/): bounty is paid once per shell the storm sent, and no
// pop-and-regrow cycle can refresh a family's rewind budget.
section('bounty conservation (exploit regressions)', () => {
  // regrow farm: hold a nanite Iron family frozen and chip it every 4 s so it keeps regrowing
  const sim = newSim();
  const fam = sim.spawnEnemy('iron', { d: 300, nanite: true, wave: 32 });
  const shells = fam.def.shells;
  let paid = 0;
  const orig = sim._onPop.bind(sim);
  sim._onPop = (e, c, t) => { if (e.wave === 32) paid += c; orig(e, c, t); };
  const pops0 = sim.state.stats.pops;
  for (let s = 0; s < Math.round(30 / TICK); s++) {
    for (const e of sim.state.enemies) if (!e.dead && e.wave === 32) e.frozenT = 1;
    if (s % Math.round(4 / TICK) === 0) for (const e of sim.state.enemies.slice()) if (!e.dead && e.wave === 32) sim.damage(e, 1, 'BLAST', SRC('BLAST'));
    sim.step();
  }
  ok(sim.state.stats.pops - pops0 > shells, 'the held nanite family regrew (pops exceed its shells)');
  ok(paid <= shells * incomeFactor(32) + 1e-9, `a regrowing nanite family pays at most its own ${shells} shells (paid ${paid})`);
  // a nanite family destroyed without regrowing pays every shell, as before
  const s2 = newSim();
  const c0 = s2.state.stats.cashEarned;
  const f2 = s2.spawnEnemy('iron', { d: 300, nanite: true, wave: 60 });
  const n2 = f2.def.shells;
  for (let k = 0; k < 40 && s2.state.enemies.some((e) => !e.dead); k++) for (const e of s2.state.enemies.slice()) if (!e.dead) s2.damage(e, 1e4, 'VOID', SRC('VOID'));
  near(s2.state.stats.cashEarned - c0, n2 * incomeFactor(60), 'an unregrown nanite family pays all of its shells', 1e-9);
  // regrown shells: partial bounty survives regrowth exactly once
  const s3 = newSim();
  const r = s3.spawnEnemy('rose', { d: 100, nanite: true, origType: 'iron', wave: 30 });
  r.speedMult = 0.01;
  for (let i = 0; i < Math.round(3 / TICK) + 2; i++) s3.step();
  eq(r.type, 'iron', 'rose regrew to iron');
  eq(r.owed, ENEMIES.rose.shells, 'a regrown shell still owes only the shells it had');
  const c3 = s3.state.stats.cashEarned;
  for (let k = 0; k < 40 && s3.state.enemies.some((e) => !e.dead); k++) for (const e of s3.state.enemies.slice()) if (!e.dead) s3.damage(e, 1e4, 'VOID', SRC('VOID'));
  near(s3.state.stats.cashEarned - c3, ENEMIES.rose.shells * incomeFactor(30), 'the regrown family pays what the rose was worth', 1e-9);
  // Maw: volleys past one full-speed crossing pay nothing
  const s4 = newSim();
  const maw = s4.spawnEnemy('titan', { d: 600, titan: { kind: 'maw', tier: 2, hp: 1e9 } });
  const cross = (s4.pathLength(0) - 600) / (maw.def.speed * BASE_SPEED);
  eq(maw.titan.paidVolleys, Math.ceil(cross / MAW_SPIT_EVERY), 'the Maw pays for the volleys of one unslowed crossing');
  maw.titan.paidVolleys = 1;
  maw.speedMult = 0.001; // a stalled Maw
  for (let i = 0; i < Math.round((2 * MAW_SPIT_EVERY + 0.2) / TICK); i++) s4.step();
  const spat = s4.state.enemies.filter((e) => !e.dead && !e.titan);
  ok(spat.some((e) => e.owed === -1) && spat.some((e) => e.owed === 0), 'first volley paid, second volley unpaid');
  const unpaid = spat.filter((e) => e.owed === 0);
  const c4 = s4.state.stats.cashEarned;
  for (let k = 0; k < 40 && unpaid.some((e) => !e.dead); k++) for (const e of unpaid) if (!e.dead) s4.damage(e, 1e4, 'VOID', SRC('VOID'));
  for (let k = 0; k < 40; k++) for (const e of s4.state.enemies.slice()) if (!e.dead && !e.titan && e.owed === 0) s4.damage(e, 1e4, 'VOID', SRC('VOID'));
  eq(s4.state.stats.cashEarned - c4, 0, 'meteors of an unpaid Maw volley (and their children) pay nothing');
  // rewind budgets are per family: children inherit Undertow and tractor budgets
  const s5 = newSim();
  const j = s5.spawnEnemy('jade', { d: 400 });
  j.gRew = 120; j._towed = 70;
  s5.damage(j, 1, 'VOID', SRC('VOID'));
  const kids = s5.state.enemies.filter((e) => !e.dead && e.type === 'cobalt');
  ok(kids.length > 0 && kids.every((k) => k.gRew === 120 && k._towed === 70), 'children inherit the rewind budget their parent used');
});

section('storm titans', () => {
  const sim = newSim();
  const t = sim.spawnEnemy('titan', { d: 400, titan: { kind: 'aegis', tier: 1, hp: 3000 } });
  sim.step();
  ok(sim.state.titan && sim.state.titan.maxShield === 750, 'aegis shield = 25% of hull, exposed in state.titan');
  ok(Math.abs(sim.damage(t, 100, 'KINETIC', SRC('KINETIC')).dealt - 20) < 1e-9 && Math.abs(t.titan.shield - 730) < 1e-9, 'KINETIC deals a fifth of its damage to the shield');
  sim.damage(t, 800, 'BLAST', SRC('BLAST'));
  ok(t.titan.shield === 0 && Math.abs(t.hp - 2930) < 1e-9, 'BLAST breaks shield, overflow hits hull');
  ok(sim.damage(t, 10, 'KINETIC', SRC('KINETIC')).dealt === 10, 'KINETIC hits hull once shield is down');
  for (let i = 0; i < Math.round(8.2 / TICK); i++) sim.step();
  eq(t.titan.shield, 750, 'shield restores after 8 s without damage');
  // rift
  const s2 = newSim(); s2.state.cash = 1e6;
  const spot = spots(s2).find(([x, y]) => { const n = s2.nearestPathPoint(x, y); return n.d > 800 && n.d < 3000 && n.dist < 90; });
  const tw = s2.placeTower('pulse', spot[0], spot[1]).id;
  const tower = s2.getTower(tw);
  const np = s2.nearestPathPoint(tower.x, tower.y);
  const rift = s2.spawnEnemy('titan', { d: Math.max(0, np.d - 250), titan: { kind: 'rift', tier: 1, hp: 3000 } });
  const d0 = rift.d;
  s2.damage(rift, 800, 'VOID', SRC('VOID'));
  s2.step();
  ok(rift.d > d0 + 240, 'rift blinks forward at 75%');
  ok(tower.disabledT > 1.3, 'rift stuns towers within 150');
  ok(s2.drainEvents().some((e) => e.t === 'titanBlink'), 'titanBlink event');
  // maw spits meteors
  const s3 = newSim();
  s3.spawnEnemy('titan', { d: 600, titan: { kind: 'maw', tier: 2, hp: 5000 } });
  const n0 = s3.state.enemies.length;
  for (let i = 0; i < Math.round(3.5 / TICK); i++) s3.step();
  ok(s3.state.enemies.length > n0, 'maw spits meteors');
  const ev = s3.drainEvents();
  ok(ev.some((e) => e.t === 'titanSpit') && ev.some((e) => e.t === 'titan'), 'titan + titanSpit events');
  // titan down
  const tt = s3.state.enemies.find((e) => e.titan);
  s3.damage(tt, 1e9, 'VOID', SRC('VOID'));
  s3.step();
  ok(s3.drainEvents().some((e) => e.t === 'titanDown') && s3.state.titan === null, 'titanDown and state.titan cleared');
  // wave 20 includes a titan
  const s4 = newSim(); s4.state.wave = 19; s4.startWave();
  ok(s4._runs.get(20).queue.some((q) => q.titan), 'wave 20 schedules a Storm Titan');
});

section('targeting and detection', () => {
  const sim = newSim(); sim.state.cash = 1e6;
  const id = place(sim, 'pulse');
  const t = sim.getTower(id);
  const np = sim.nearestPathPoint(t.x, t.y);
  const a = sim.spawnEnemy('rust', { d: np.d - 20 });
  const b = sim.spawnEnemy('obsidian', { d: np.d });
  const c = sim.spawnEnemy('cobalt', { d: np.d + 20 });
  for (const e of [a, b, c]) e.speedMult = 0.001;
  sim.step();
  eq(sim.findTarget(t, t.stats.range, 'first').id, c.id, 'first = furthest along');
  eq(sim.findTarget(t, t.stats.range, 'last').id, a.id, 'last = least along');
  eq(sim.findTarget(t, t.stats.range, 'strong').id, b.id, 'strong = most remaining mass');
  const ship = sim.spawnEnemy('hauler', { d: np.d - 20 });
  sim.step();
  eq(sim.findTarget(t, t.stats.range, 'strong').id, ship.id, 'strong prefers ships');
  const s2 = newSim(); s2.state.cash = 1e6;
  const id2 = place(s2, 'pulse'); const t2 = s2.getTower(id2);
  const np2 = s2.nearestPathPoint(t2.x, t2.y);
  const ph = s2.spawnEnemy('jade', { d: np2.d, phantom: true });
  s2.step();
  eq(s2.findTarget(t2, t2.stats.range, 'first'), null, 'no detection: phantom not targetable');
  s2.upgrade(id2, 2); s2.upgrade(id2, 2);
  ok(t2.stats.detection && s2.findTarget(t2, t2.stats.range, 'first') === ph, 'detection upgrade can target phantom');
  ok(s2.setTargeting(id2, 'strong').ok && !s2.setTargeting(id2, 'weird').ok, 'setTargeting validates modes');
  const iron = s2.spawnEnemy('iron', { d: np2.d + 5 });
  ph.dead = true; s2.step();
  ok(s2.findTarget(t2, t2.stats.range, 'first', t2.stats.attacks.main) !== iron, 'immunity-aware skipping (KINETIC ignores iron)');
});

section('attack kinds', () => {
  // projectile + splash + split + homing are exercised by the reference towers
  const sim = newSim(); sim.state.cash = 1e7; sim.state.lives = 1e9;
  const m = place(sim, 'missile');
  [1, 1, 1].forEach((p) => sim.upgrade(m, p));
  const mt = sim.getTower(m);
  ok(mt.stats.attacks.main.split && mt.stats.attacks.main.split.count === 8, 'missile cluster split configured');
  const np = sim.nearestPathPoint(mt.x, mt.y);
  for (let i = 0; i < 30; i++) sim.spawnEnemy('rose', { d: Math.max(0, np.d - 200 + i * 6) });
  const pops0 = sim.state.stats.pops;
  for (let i = 0; i < 240; i++) sim.step();
  ok(sim.state.stats.pops > pops0 + 20, 'missiles + bomblets popped meteors: ' + (sim.state.stats.pops - pops0));
  const ev = sim.drainEvents();
  ok(ev.some((e) => e.t === 'explode') && ev.some((e) => e.t === 'shot'), 'explode and shot events');

  // generic attack kinds through a synthetic tower
  const saved = TOWERS.testkinds;
  TOWERS.testkinds = {
    id: 'testkinds', name: 'Test Kinds', cost: 100, radius: 20,
    base: {
      range: 220, detection: true,
      attacks: {
        rail: { kind: 'hitscan', cooldown: 0.5, damage: 2, dtype: 'KINETIC', line: true, pierce: 3, shrapnel: { count: 3, damage: 1, pierce: 1, range: 100 } },
        arc: { kind: 'chain', cooldown: 0.6, damage: 1, dtype: 'ENERGY', jumps: 4, jumpRange: 120 },
        laser: { kind: 'beam', dps: 10, beams: 2, ramp: 1, rampMax: 3, dtype: 'THERMAL' },
        nova: { kind: 'pulse', cooldown: 1, damage: 1, pierce: 20, dtype: 'CRYO', radius: 120, onHit: { freeze: { t: 0.5 } } },
        well: { kind: 'field', radius: 150, slow: { mult: 0.5, shipMult: 0.8 }, dps: 2, dtype: 'ENERGY', pull: 10, expose: { mult: 1.2 } },
        shell: { kind: 'mortar', cooldown: 0.8, dtype: 'BLAST', splash: { radius: 60, damage: 2, pierce: 20 }, onHit: null },
        bay: { kind: 'drone', count: 2, patrol: 300, weapon: { kind: 'projectile', cooldown: 0.3, damage: 1, pierce: 2, speed: 800 } },
        odd: { kind: 'custom', update(s, tower, atk, dt) { tower.data.customTicks = (tower.data.customTicks || 0) + 1; } },
        burn: { kind: 'projectile', cooldown: 0.7, damage: 1, dtype: 'THERMAL', onHit: { burn: { dps: 2, t: 2 }, brittle: { add: 1, mult: 1.5, t: 2 }, knockback: { dist: 10 }, stun: { t: 0.2 } }, bounce: 2 },
      },
    },
    paths: [],
  };
  try {
    const s = newSim(); s.state.cash = 1e6; s.state.lives = 1e9;
    const id = place(s, 'testkinds');
    const t = s.getTower(id);
    const n2 = s.nearestPathPoint(t.x, t.y);
    for (let i = 0; i < 40; i++) s.spawnEnemy(i % 5 === 0 ? 'hauler' : 'obsidian', { d: Math.max(0, n2.d - 150 + i * 8) });
    s.startWave();
    const seen = new Set();
    let beamSeen = false, dronesSeen = 0;
    for (let i = 0; i < 300; i++) {
      s.step();
      for (const e of s.drainEvents()) seen.add(e.t);
      if (t.data.beams && t.data.beams.length) beamSeen = true;
      dronesSeen = Math.max(dronesSeen, s.state.drones.filter((d) => d.towerId === id).length);
    }
    ok(seen.has('zap'), 'chain emits zap');
    ok(seen.has('pulse') && seen.has('freeze'), 'pulse emits pulse + freeze');
    ok(beamSeen, 'beam writes tower.data.beams');
    eq(dronesSeen, 2, 'drone attack keeps 2 drones');
    ok(t.data.customTicks > 250, 'custom attack update runs');
    ok(t.damage > 0 && t.pops > 0, 'synthetic tower dealt damage: ' + Math.round(t.damage));
    ok(!findNaN(s.state), 'no NaN after all attack kinds');
    ok(s.sell(id).ok && s.state.drones.every((d) => d.towerId !== id), 'selling removes drones');
  } finally { if (saved) TOWERS.testkinds = saved; else delete TOWERS.testkinds; }
});

section('abilities', () => {
  const sim = newSim(); sim.state.cash = 1e7;
  const id = place(sim, 'pulse');
  for (let i = 0; i < 5; i++) sim.upgrade(id, 1);
  const bar = sim.abilityBar();
  ok(bar.length === 1 && bar[0].id === 'hurricane' && !bar[0].ready, 'ability bar lists Hurricane, starts recharging');
  near(sim.getTower(id).abilityCd.hurricane, 50 / 3, 'new ability starts at 1/3 cooldown');
  ok(!sim.useAbility('hurricane').ok, 'abilities cannot fire in the build phase');
  sim.state.lives = 1e9;
  for (let i = 0; i < Math.round(17 / TICK); i++) { if (sim.state.phase === 'build') sim.startWave(); sim.step(); }
  if (sim.state.phase === 'build') sim.startWave();
  ok(sim.abilityBar()[0].ready && sim.abilityBar()[0].usable, 'ready after cooldown');
  const cd0 = sim.getTower(id).stats.attacks.main.cooldown;
  ok(sim.useAbility('hurricane').ok, 'useAbility');
  sim.step();
  ok(Math.abs(sim.getTower(id).stats.attacks.main.cooldown - cd0 / 3) < 1e-9, 'Hurricane triples fire rate');
  ok(!sim.useAbility('hurricane').ok, 'cannot reuse while recharging');
  for (let i = 0; i < Math.round(8.5 / TICK); i++) sim.step();
  ok(Math.abs(sim.getTower(id).stats.attacks.main.cooldown - cd0) < 1e-9, 'buff expires after 8 s');
});

section('commander support', () => {
  const lv = [];
  for (let i = 0; i < 19; i++) lv.push((s) => { s.range += 5; });
  HEROES.testhero = { id: 'testhero', name: 'Test Commander', cost: 500, radius: 20, hero: { maxLevel: 20, levels: lv },
    base: { range: 150, attacks: { main: { kind: 'projectile', cooldown: 0.5, damage: 1, pierce: 2, speed: 900 } }, aura: { radius: 150, rangeMult: 1.1 } }, paths: [] };
  try {
    const sim = newSim({ heroId: 'testhero' }); sim.state.cash = 1e6;
    const h = place(sim, 'testhero');
    const ht = sim.getTower(h);
    eq(ht.hero.level, 1, 'commander starts at level 1');
    eq(sim.canPlace('testhero', ...spots(sim)[10]).reason, 'Only one Commander per game', 'one commander limit');
    const p = place(sim, 'pulse', 1);
    const pt = sim.getTower(p);
    const inAura = Math.hypot(pt.x - ht.x, pt.y - ht.y) <= 150;
    if (inAura) ok(Math.abs(pt.stats.range - 165) < 1e-9, 'commander aura buffs nearby range');
    runWave(sim);
    ok(ht.hero.level >= 1 && (ht.hero.xp > 0 || ht.hero.level > 1), 'commander gains XP on wave clear');
    const needed = heroXpNeed(1);
    ok(heroXpForWave(1) + sim.state.stats.pops * 0.1 >= needed ? ht.hero.level >= 2 : ht.hero.level === 1, 'levels follow xpNeed');
    sim._addHeroXp(ht, 1e9);
    eq(ht.hero.level, 20, 'caps at level 20');
    near(ht.stats.range, 150 + 19 * 5, 'all 19 level functions applied');
    const save = JSON.parse(JSON.stringify(sim.serialize()));
    const s2 = Sim.fromSave(save);
    eq(s2.getTower(h).hero.level, 20, 'commander level saved');
  } finally { delete HEROES.testhero; }
});

section('waves, early send, autostart', () => {
  const sim = newSim(); sim.state.cash = 1e6; sim.state.lives = 1e9;
  for (let i = 0; i < 6; i++) place(sim, 'pulse', i * 3);
  ok(sim.canStartWave(), 'can start in build');
  sim.startWave();
  eq(sim.state.phase, 'wave', 'phase wave');
  ok(!sim.startWave().ok, 'cannot early send while spawning');
  let n = 0;
  while (!sim.canStartWave() && n++ < 60 * 60) sim.step();
  ok(sim.startWave().ok && sim.state.wave === 2, 'early send once spawning finished');
  eq(sim.state.activeWaves.length, 2, 'two waves active');
  const cleared = [];
  n = 0;
  while (sim.state.phase === 'wave' && n++ < 60 * 600) { sim.step(); for (const e of sim.drainEvents()) if (e.t === 'waveCleared') cleared.push(e.wave); }
  ok(cleared.includes(1) && cleared.includes(2), 'both waves cleared: ' + cleared.join(','));
  eq(sim.state.cleared, 2, 'cleared counter');
  eq(sim.state.phase, 'build', 'back to build');
  sim.setAutoStart(true);
  for (let i = 0; i < Math.round(1.2 / TICK); i++) sim.step();
  eq(sim.state.wave, 3, 'autostart launched the next wave');
  const pv = sim.wavePreview(4);
  ok(Array.isArray(pv) && pv.length > 0 && pv[0].type, 'wavePreview');
});

section('lanes', () => {
  const multi = Object.values(MAPS).filter((m) => m.paths.length > 1);
  if (!multi.length) { console.log('  (no multi-lane map yet, skipped)'); return; }
  for (const m of multi) {
    const sim = new Sim({ mapId: m.id, seed: 3 });
    ok(sim.lanes === m.paths.length, `${m.id}: ${sim.lanes} lanes`);
    sim.state.lives = 1e9;
    if (m.laneOpen) {
      // the second lane opens later: wave 1 uses lane 0 only, then from laneOpen.full both
      const s0 = new Sim({ mapId: m.id, seed: 3 }); s0.state.lives = 1e9; s0.startWave();
      for (let i = 0; i < 60 * 12; i++) s0.step();
      ok(s0.state.enemies.every((e) => e.lane === 0), `${m.id}: before wave ${m.laneOpen.wave} every spawn uses lane 0`);
      eq(s0.laneShare(m.laneOpen.wave - 1), 0, `${m.id}: lane share 0 before opening`);
      ok(s0.laneShare(m.laneOpen.wave) > 0 && s0.laneShare(m.laneOpen.full - 1) < 0.5, `${m.id}: lane share ramps`);
      sim.skipTo(m.laneOpen.full);
    }
    sim.startWave();
    for (let i = 0; i < 60 * 12; i++) sim.step();
    const lanes = new Set(sim.state.enemies.map((e) => e.lane));
    ok(lanes.size > 1 || sim.state.enemies.length < 2, `${m.id}: spawns use several lanes (${[...lanes].join(',')})`);
    ok(sim.state.enemies.every((e) => e.lane < sim.lanes), `${m.id}: lane indexes valid`);
    const e = sim.spawnEnemy('rust', { lane: 7, d: 10 });
    ok(Number.isFinite(e.x), 'out-of-range lane does not crash');
  }
});

section('events', () => {
  const sim = newSim();
  for (let i = 0; i < 5000; i++) sim.emit({ t: 'hit', x: i, y: 0 });
  ok(sim.events.length <= 4000, 'event buffer capped at 4000');
  ok(sim.events[sim.events.length - 1].x === 4999, 'newest kept, oldest dropped');
  eq(sim.drainEvents().length > 0 && sim.events.length, 0, 'drain clears');
});

// Scripted deterministic play (public commands only) used by determinism tests.
let SCRIPT_SPOTS = null;
function script(sim, rng) {
  const st = sim.state;
  if (st.phase !== 'build') return;
  const types = ['pulse', 'missile'];
  for (let k = 0; k < 6; k++) {
    if (rng.next() < 0.5 && st.towers.length) {
      const t = st.towers[rng.int(st.towers.length)];
      sim.upgrade(t.id, rng.int(3));
    } else {
      const type = types[rng.int(2)];
      const s = SCRIPT_SPOTS || (SCRIPT_SPOTS = spots(newSim(), 'missile', 110));
      const [x, y] = s[rng.int(s.length)];
      sim.placeTower(type, x, y);
    }
  }
  if (st.towers.length && rng.next() < 0.3) sim.setTargeting(st.towers[0].id, ['first', 'last', 'strong', 'close'][rng.int(4)]);
}
function playTo(sim, rng, toWave, onBuild) {
  while (sim.state.cleared < toWave && sim.state.phase !== 'over') {
    if (sim.state.phase === 'build') {
      if (onBuild && onBuild(sim) === 'stop') return;
      script(sim, rng);
      sim.startWave();
    }
    sim.step();
    for (const a of sim.abilityBar()) if (a.ready) sim.useAbility(a.id);
    sim.drainEvents();
  }
}

section('determinism', () => {
  const run = (seed) => {
    const sim = new Sim({ mapId: 'crater', seed }); sim.state.lives = 1e9; sim.state.cash = 20000;
    playTo(sim, new Rng(99), 30);
    return sim;
  };
  const a = run(5), b = run(5), c = run(6);
  eq(a.hash(), b.hash(), 'same seed and commands: identical state hash after 30 waves');
  ok(a.hash() !== c.hash(), 'different seed: different hash');
  ok(!findNaN(a.state), 'no NaN in state after 30 waves' + (findNaN(a.state) ? ': ' + findNaN(a.state) : ''));
});

section('save/load roundtrip determinism', () => {
  const mk = () => { const s = new Sim({ mapId: 'crater', seed: 21 }); s.state.lives = 1e9; s.state.cash = 30000; return s; };
  const rngA = new Rng(7);
  const A = mk();
  let save = null, rngState = null;
  playTo(A, rngA, 12, (sim) => {
    if (sim.state.cleared === 10 && !save) {
      save = JSON.parse(JSON.stringify(sim.serialize()));
      rngState = rngA.getState();
    }
  });
  ok(!!save, 'saved at build phase of wave 10');
  // continue A from its current point is not comparable; restart both from the save point
  const B = Sim.fromSave(save);
  const C = Sim.fromSave(JSON.parse(JSON.stringify(save)));
  const rb = new Rng(1); rb.setState(rngState);
  const rc = new Rng(1); rc.setState(rngState);
  // Reference: a fresh run replayed to wave 10 then continued must match the loaded run.
  const R = mk(); const rr = new Rng(7);
  playTo(R, rr, 10);
  eq(R.hash(), Sim.fromSave(save).hash(), 'loaded state hash equals the live state at the save point');
  playTo(R, rr, 30);
  playTo(B, rb, 30);
  playTo(C, rc, 30);
  eq(B.hash(), C.hash(), 'two loads of one save stay identical');
  eq(B.hash(), R.hash(), 'loaded run matches the uninterrupted run 20 waves later');
  ok(!findNaN(B.state), 'no NaN after load');
  // mid-wave serialize returns the pre-launch snapshot
  const D = mk(); D.startWave(); D.step();
  const snap = D.serialize();
  ok(snap && snap.wave === 0, 'mid-wave serialize returns the last build-phase snapshot');
});

section('save/load with every tower type, a Commander and abilities', () => {
  // Every tower at a crosspath that turns on its custom behaviours (blades, burn stoker, orbs,
  // lances, tractors, burning ground, crusher, radar, refinery, vault) plus a levelled Commander.
  const PLAN = {
    pulse: [0, 5, 2], scatter: [5, 0, 2], rail: [2, 0, 5], missile: [2, 5, 0], cryo: [5, 0, 2], tesla: [0, 5, 2],
    laser: [2, 0, 5], drone: [0, 2, 5], mortar: [0, 2, 5], gravity: [5, 0, 2], rig: [0, 5, 2], beacon: [5, 2, 0],
  };
  const setup = () => {
    const sim = new Sim({ mapId: 'frost', seed: 77, heroId: 'nova' });
    sim.state.lives = 1e12; sim.state.maxLives = 1e12; sim.state.cash = 5e6;
    const ids = {};
    const spot = (type, maxd, mind) => {
      for (let r = 0; r < 8000; r++) {
        const x = 40 + ((r * 97) % 1420), y = 40 + ((r * 61) % 920);
        const n = sim.nearestPathPoint(x, y);
        if (n.dist < maxd && n.dist > mind && sim.canPlace(type, x, y).ok) return [x, y];
      }
      return null;
    };
    for (const type of Object.keys(PLAN)) {
      const p = spot(type, type === 'rig' ? 400 : 110, type === 'rig' ? 140 : 0);
      const r = sim.placeTower(type, p[0], p[1]);
      ids[type] = r.id;
      PLAN[type].forEach((n, path) => { for (let k = 0; k < n; k++) sim.upgrade(r.id, path); });
    }
    const hp = spot('nova', 110, 0);
    ids.hero = sim.placeHero(hp[0], hp[1]).id;
    sim._addHeroXp(sim.getTower(ids.hero), 4000);
    return { sim, ids };
  };
  // Play `n` waves; fire every usable ability at fixed ticks so both runs make the same calls.
  const play = (sim, n) => {
    const target = sim.state.cleared + n;
    let guard = 0;
    while (sim.state.cleared < target && sim.state.phase !== 'over' && guard++ < 60 * 60 * 40 * n) {
      if (sim.state.phase === 'build') { sim.startWave(); }
      sim.step();
      if (sim.state.tick % 240 === 0) for (const g of sim.abilityBar()) if (g.usable) sim.useAbility(g.id);
      sim.drainEvents();
    }
  };
  const { sim: A, ids } = setup();
  eq(Object.keys(ids).length, 13, 'all 12 towers and the Commander placed');
  const levelsOk = Object.keys(PLAN).every((t) => A.getTower(ids[t]).levels.join('') === PLAN[t].join(''));
  ok(levelsOk, 'every tower reached its crosspath');
  A.skipTo(38);
  play(A, 3); // 38..40 (Aegis Titan) with abilities
  ok(A.state.phase === 'build', 'in the build phase after wave 40');
  const save = JSON.parse(JSON.stringify(A.serialize()));
  const B = Sim.fromSave(save);
  eq(B.hash(), A.hash(), 'loaded state hash equals the live state');
  eq(B.state.towers.length, A.state.towers.length, 'tower count survives the save');
  ok(B.getTower(ids.hero).hero.level === A.getTower(ids.hero).hero.level, 'Commander level survives the save');
  ok(Math.abs((B.getTower(ids.rig).data.vault || 0) - (A.getTower(ids.rig).data.vault || 0)) < 1e-9, 'vault balance survives the save');
  play(A, 4);
  play(B, 4);
  eq(B.hash(), A.hash(), 'loaded run matches the uninterrupted run 4 waves later (abilities fired in both)');
  ok(!findNaN(B.state), 'no NaN after load');
});

section('long run sanity (solid-ish play to wave 60, no NaN)', () => {
  const sim = new Sim({ mapId: 'crater', seed: 4 }); sim.state.lives = 1e12; sim.state.cash = 3e5;
  const orig = sim._gameOver.bind(sim);
  sim._gameOver = () => { sim.state.lives = 1e12; }; // keep going past titans for coverage
  playTo(sim, new Rng(3), 60);
  ok(sim.state.cleared >= 60, 'reached wave 60');
  const bad = findNaN(sim.state);
  ok(!bad, 'no NaN anywhere' + (bad ? ': ' + bad : ''));
  void orig;
});

section('QA regressions (engine, 2026-09 review)', () => {
  const SRCV = { dtype: 'VOID' };
  // engine-logic-01: nanite regrow climbs exactly one grade through the family tree
  const grow = (type, origType) => {
    const s = newSim();
    const e = s.spawnEnemy(type, { d: 300, nanite: true, origType });
    e.speedMult = 0.0001;
    for (let i = 0; i < Math.round(3.05 / TICK); i++) s.step();
    return e.type;
  };
  eq(grow('rose', 'obsidian'), 'magma', 'nanite Rose in an Obsidian family regrows one grade (Magma)');
  eq(grow('magma', 'obsidian'), 'geode', 'nanite Magma regrows into Geode');
  eq(grow('comet', 'obsidian'), 'geode', 'nanite Comet regrows into Geode');
  eq(grow('geode', 'obsidian'), 'aurora', 'nanite Geode regrows into Aurora');
  eq(grow('aurora', 'obsidian'), 'obsidian', 'nanite Aurora regrows into Obsidian');
  eq(grow('rust', 'obsidian'), 'cobalt', 'nanite Rust in a special family climbs the Rust chain first');
  eq(grow('rose', 'prism'), 'prism', 'nanite Rose of a Prism family regrows into Prism');
  {
    // a Specter's nanite Obsidian cargo: a Rose shard left alone regrows to Magma, not Obsidian
    const s = newSim();
    const e = s.spawnEnemy('rose', { d: 300, nanite: true, origType: 'obsidian', phantom: true });
    e.speedMult = 0.0001;
    for (let i = 0; i < Math.round(3.05 / TICK); i++) s.step();
    ok(e.type === 'magma' && e.owed === ENEMIES.rose.shells, 'regrown shell keeps paying only for the shells it had');
  }

  // engine-logic-02: CRYO slows never pass to CRYO-immune children; ship slows stay on ships
  {
    const s = newSim();
    const a = s.spawnEnemy('aurora', { d: 500 });
    s.applyEffects(a, { slow: { mult: 0.5, t: 3 } }, { dtype: 'CRYO' });
    s.damage(a, 1, 'VOID', SRCV);
    const kids = s.state.enemies.filter((e) => !e.dead && e.type === 'geode');
    ok(kids.length === 2 && kids.every((k) => k.slowMult === 1), 'CRYO slow on an Aurora does not pass to its Geodes');
    const s2 = newSim();
    const a2 = s2.spawnEnemy('aurora', { d: 500 });
    s2.applyEffects(a2, { slow: { mult: 0.5, t: 3 } }, { dtype: 'ENERGY' });
    s2.damage(a2, 1, 'VOID', SRCV);
    ok(s2.state.enemies.filter((e) => !e.dead && e.type === 'geode').every((k) => k.slowMult === 0.5), 'a non-CRYO slow still passes down');
    const s3 = newSim();
    const h = s3.spawnEnemy('hauler', { d: 500 });
    s3.applyEffects(h, { slow: { mult: 0.9, shipMult: 0.25, t: 3 } }, { dtype: 'CRYO' });
    s3.damage(h, 1e6, 'VOID', SRCV);
    ok(s3.state.enemies.filter((e) => !e.dead).every((k) => k.slowMult === 1), 'a ship-strength slow does not pass to meteor cargo');
  }

  // engine-logic-03: a hit the Aegis shield absorbs in full never applies on-hit effects
  {
    const fx = { stun: { t: 1, shipT: 1 }, slow: { mult: 0.5, shipMult: 0.5, t: 2 }, burn: { dps: 5, t: 2 } };
    let leaks = 0;
    for (const d of [0.3, 0.7, 1, 2.1, 43, 81, 86, 91, 0.1 * 3]) {
      const s = newSim();
      const t = s.spawnEnemy('titan', { d: 400, titan: { kind: 'aegis', tier: 2, hp: 10000 } });
      s.damage(t, d, 'KINETIC', { dtype: 'KINETIC' }, { onHit: fx });
      if (t.stunT > 0 || t.slowMult < 1 || t.burn || t.hp !== t.maxHp) leaks++;
    }
    eq(leaks, 0, 'fully absorbed KINETIC hits on the Aegis leave hull and statuses untouched');
    const s = newSim();
    const t = s.spawnEnemy('titan', { d: 400, titan: { kind: 'aegis', tier: 2, hp: 10000 } });
    s.damage(t, 2500 + 10, 'VOID', SRCV, { onHit: fx });
    ok(t.titan.shield === 0 && Math.abs(t.hp - 9990) < 1e-6 && t.slowMult < 1, 'a hit that breaks through reaches the hull and applies its effects');
  }

  // engine-logic-04: a 1 s burn deals its full dps x t
  for (const bt of [0.5, 1, 1.5, 2]) {
    const s = newSim();
    const e = s.spawnEnemy('obsidian', { d: 400 });
    e.speedMult = 0.0001;
    s.applyEffects(e, { burn: { dps: 4, t: bt } }, { dtype: 'THERMAL' });
    for (let i = 0; i < Math.round((bt + 1) / TICK); i++) s.step();
    near(e.maxHp - e.hp, 4 * bt, `a ${bt} s burn deals dps x t`);
  }

  // engine-logic-05: children spawned mid-tick are visible to the same tick's area queries
  {
    const s = newSim();
    const r = s.spawnEnemy('rose', { d: 800 });
    r.speedMult = 0.0001;
    s.step();
    s.damage(r, 1, 'BLAST', { dtype: 'BLAST' });
    const kid = s.state.enemies.find((e) => !e.dead);
    s.explode(kid.x, kid.y, { radius: 80, damage: 5, pierce: 40, dtype: 'BLAST' });
    ok(kid.dead, 'an explosion in the same tick reaches the children of the shell it just popped');
    // a knocked-back enemy is found at its new spot and only once
    const s2 = newSim();
    const e2 = s2.spawnEnemy('obsidian', { d: 900 });
    e2.speedMult = 0.0001;
    s2.step();
    s2.applyEffects(e2, { knockback: { dist: 300 } }, { dtype: 'KINETIC' });
    const found = s2.enemiesInRange(e2.x, e2.y, 5);
    eq(found.filter((x) => x === e2).length, 1, 'a knocked-back enemy is filed once at its new position');
  }

  // engine-logic-06: exact-damage hits break the shell (no 1e-16 HP sliver)
  for (const [type, per, n] of [['rust', 0.1, 10], ['rust', 0.2, 5], ['rust', 1 / 3, 3], ['obsidian', 0.1, 100]]) {
    const s = newSim();
    const e = s.spawnEnemy(type, { d: 400 });
    let hits = 0;
    while (e.type === type && !e.dead && hits < n + 5) { s.damage(e, per, 'VOID', SRCV); hits++; }
    eq(hits, n, `${type} breaks after ${n} hits of ${per.toFixed(3)}`);
  }

  // engine-logic-07: the sell breakdown adds up and the undo flags agree
  {
    const s = newSim(); s.state.cash = 1e5;
    const id = place(s, 'pulse');
    s.startWave(); for (let i = 0; i < 5; i++) s.step();
    let n = 0; while (s.state.phase === 'wave' && n++ < 60 * 600) s.step();
    s.upgrade(id, 0);
    const info = s.towerInfo(id), parts = s.sellParts(id), t = s.getTower(id);
    eq(parts.undo + parts.refund70 + parts.vault, s.sellValue(id), 'sellParts adds up to sellValue');
    eq(info.sellParts.total, info.sellValue, 'towerInfo carries the same breakdown');
    ok(parts.undo === t.undoPaid && parts.undo > 0 && parts.refund70 === Math.floor((t.paid - t.undoPaid) * SELL_RATE + 1e-9), 'this build phase\'s upgrade refunds in full, the rest at 70%');
    ok(info.undoable === t.undoable && info.undoable === false && info.partialUndo === true, 'towerInfo.undoable matches tower.undoable; partialUndo flags the upgrade refund');
  }

  // engine-logic-08: brittle merging keeps the best of each field and every brittle's own timer
  {
    const railBr = { add: 3, mult: 1, t: 3 }, cryoBr = { add: 2, mult: 1.5, t: 3 };
    const dealt = [];
    for (const order of [[railBr, cryoBr], [cryoBr, railBr]]) {
      const s = newSim();
      const e = s.spawnEnemy('obsidian', { d: 500 });
      for (const b of order) s.applyEffects(e, { brittle: b }, { dtype: 'CRYO' });
      const hp0 = e.hp; s.damage(e, 1, 'VOID', SRCV); dealt.push(hp0 - e.hp);
    }
    ok(dealt[0] === dealt[1] && Math.abs(dealt[0] - 6) < 1e-9, 'brittle outcome does not depend on hit order: ' + dealt.join(' / '));
    const s = newSim();
    const e = s.spawnEnemy('obsidian', { d: 500 });
    e.speedMult = 0.0001;
    s.applyEffects(e, { brittle: { add: 3, mult: 2, t: 0.5 } }, { dtype: 'CRYO' });
    s.applyEffects(e, { brittle: { add: 1, mult: 1, t: 6 } }, { dtype: 'CRYO' });
    for (let i = 0; i < Math.round(1 / TICK); i++) s.step();
    ok(e.brittle && e.brittle.add === 1 && e.brittle.mult === 1, 'a strong short brittle expires on time under a weak long one');
    for (let i = 0; i < Math.round(5.2 / TICK); i++) s.step();
    ok(e.brittle === null, 'brittle clears when its last entry expires');
  }

  // engine-logic-09: the Rift never blinks backward
  {
    const s = newSim();
    const L = s.pathLength(0);
    const rift = s.spawnEnemy('titan', { d: L - 60, titan: { kind: 'rift', tier: 3, hp: 10000 } });
    rift.speedMult = 0.0001;
    const d0 = rift.d;
    s.damage(rift, 2600, 'VOID', SRCV);
    s.step();
    ok(rift.d >= d0 && rift.titan.blinks === 1, 'a Rift near the Core does not move back when it blinks');
  }

  // engine-logic-10: the Maw's spit grade rises every appearance
  eq([1, 4, 7, 10, 13, 16].map(mawSpitType).join(','), 'rose,iron,geode,aurora,obsidian,obsidian', 'Maw spit ladder by appearance');
  {
    const s = newSim();
    const m = s.spawnEnemy('titan', { d: 100, titan: { kind: 'maw', tier: 4, hp: 1e6 } });
    eq(m.titan.spitType, 'iron', 'the wave 80 Maw spits Iron');
  }

  // engine-logic-11: Titan hulls stay finite at any tier
  {
    let bad = null;
    for (let t = 1; t <= 150; t++) { const hp = titanHp(t); if (!Number.isFinite(hp) || hp < 100) { bad = t; break; } }
    ok(bad === null, 'titanHp is finite for tiers 1..150' + (bad ? ' (tier ' + bad + ')' : ''));
    const spec = buildWave(1240, { lanes: 1 });
    ok(spec.titan && Number.isFinite(spec.titan.hp), 'wave 1240 Titan hull is finite');
  }

  // engine-logic-12: no Commander can be placed when none was chosen
  {
    const s = newSim(); s.state.cash = 1e5;
    const hero = Object.keys(HEROES)[0];
    const sp = spots(s, 'pulse')[0];
    const r = s.canPlace(hero, sp[0], sp[1]);
    ok(!r.ok && /No Commander/.test(r.reason), 'canPlace refuses a Commander in a match without one');
  }

  // ui-desktop-4: auto-start only fires after a wave is cleared in this session
  {
    const s = newSim(); s.setAutoStart(true);
    for (let i = 0; i < Math.round(5 / TICK); i++) s.step();
    eq(s.state.wave, 0, 'auto-start does not launch wave 1 of a new run');
    place(s, 'pulse'); place(s, 'pulse', 5);
    s.startWave();
    let n = 0; while (s.state.phase === 'wave' && n++ < 60 * 600) s.step();
    const save = JSON.parse(JSON.stringify(s.serialize()));
    for (let i = 0; i < Math.round(1.2 / TICK); i++) s.step();
    eq(s.state.wave, 2, 'auto-start launches the next wave after a clear');
    const B = Sim.fromSave(save);
    for (let i = 0; i < Math.round(5 / TICK); i++) B.step();
    ok(B.state.autoStart && B.state.wave === 1 && B.state.phase === 'build', 'auto-start stays idle right after a save is restored');
  }

  // RP-2: invalid saves are rejected cleanly
  {
    const s = newSim(); s.state.cash = 1e5; place(s, 'pulse');
    const good = JSON.parse(JSON.stringify(s.serialize()));
    eq(Sim.validateSave(good), null, 'a real save validates');
    const mut = (f) => { const c = JSON.parse(JSON.stringify(good)); f(c); return c; };
    const bad = {
      empty: {}, nullSave: null, noCash: mut((c) => { delete c.cash; }), cashStr: mut((c) => { c.cash = '500'; }),
      livesZero: mut((c) => { c.lives = 0; }), waveStr: mut((c) => { c.wave = '12'; }), future: mut((c) => { c.v = 99; }),
      unknownTower: mut((c) => { c.towers[0].type = 'nuke'; }), paidMissing: mut((c) => { delete c.towers[0].paid; }),
      levels9: mut((c) => { c.towers[0].levels = [9, 0, 0]; }), crosspath: mut((c) => { c.towers[0].levels = [3, 3, 0]; }),
      nanPos: mut((c) => { c.towers[0].x = null; }), badMap: mut((c) => { c.mapId = 'nowhere'; }),
    };
    const accepted = [];
    for (const [k, v] of Object.entries(bad)) {
      let threw = false;
      try { Sim.fromSave(v); } catch (e) { threw = /Invalid save/.test(e.message) || k === 'badMap'; }
      if (!threw || Sim.validateSave(v) === null) accepted.push(k);
    }
    eq(accepted.join(','), '', 'every invalid save is rejected with an Invalid save error');
  }

  // RP-5: the event cap never drops critical events
  {
    const s = newSim();
    s.emit({ t: 'waveCleared', wave: 1 });
    for (let i = 0; i < EVENT_CAP * 2; i++) s.emit({ t: 'pop', x: 0, y: 0 });
    s.emit({ t: 'titanDown', wave: 1 });
    const evs = s.drainEvents();
    ok(evs.length <= EVENT_CAP && evs[0].t === 'waveCleared' && evs[evs.length - 1].t === 'titanDown', 'critical events survive the cap, cosmetic ones are trimmed');
  }

  // RP-6 and RP-11: drones hash and look the same after a load
  {
    const s = newSim(); s.state.cash = 1e6;
    const a = place(s, 'drone');
    const b = place(s, 'drone', 8);
    s.upgrade(b, 0); s.upgrade(a, 2); s.upgrade(a, 2); s.upgrade(a, 2); s.upgrade(a, 2);
    s.startWave();
    let n = 0; while (s.state.phase === 'wave' && n++ < 60 * 600) s.step();
    s.upgrade(a, 0);
    const save = JSON.parse(JSON.stringify(s.serialize()));
    const B = Sim.fromSave(save);
    eq(B.hash(), s.hash(), 'hash ignores drone array order after a load');
    const looks = (sim) => sim.state.drones.filter((d) => d.towerId === a).map((d) => d.visual + '/' + d.color).sort().join(',');
    eq(looks(B), looks(s), 'restored drones keep the Drone Bay look');
  }

  // beacon-pierce-buff-kind-whitelist: aura pierce raises a mortar blast's pierce
  {
    const base = computeBaseStats(TOWERS.mortar, [0, 0, 0]);
    const plain = finalizeStats(base, null).attacks.main.splash.pierce;
    const buffed = finalizeStats(base, { rateMult: 1, rangeMult: 1, pierceAdd: 2, damageAdd: 0, detection: false, bypass: [], discount: 0, shipDamageAdd: 0 }).attacks.main.splash.pierce;
    eq(buffed, plain + 2, 'aura pierceAdd applies to mortar splash pierce');
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log('Failures:\n  ' + failures.join('\n  ')); process.exit(1); }
