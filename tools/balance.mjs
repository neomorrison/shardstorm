// SHARDSTORM economic soundness suite (docs/BALANCE.md, docs/ECONOMY.md section 7).
//
// Usage:
//   node tools/balance.mjs                 all sections, reads the cached bot sweep
//   node tools/balance.mjs --sweep         also (re)runs the bot sweep (long: every map, every bot)
//   node tools/balance.mjs --only arbitrage,passive,threat,bench,sweep
//   node tools/balance.mjs --quick         shorter bench windows and fewer arbitrage trials
//   node tools/balance.mjs --json out/balance/report.json
//   node tools/balance.mjs --sweep-file out/balance/sweep.jsonl   (default path shown)
//   node tools/balance.mjs --worker map bot seed waves hero difficulty   (internal: one bot run)
//
// Sections (each prints a table and its verdict):
//   1. arbitrage  property tests: buy/sell/undo loops, Beacon discount loops, Rig and vault
//                 loops, ability timing and save/load never raise credits + asset value above
//                 what the storm paid in (bounty, wave bonus, Rig income, supply drops).
//   2. passive    maximum passive income per wave (10 fully upgraded Rigs, vaults at cap, every
//                 supply drop a full map of Rail Snipers could make) against pop income, waves
//                 1..160, plus an engine check that no payout exceeds the analytic bound.
//   3. threat     B(w) strictly increasing (1..600) and log-convex after the surge, wave masses
//                 inside their bands (1..200), Titan hulls increasing, speed ramp monotone.
//   4. bench      tools/bench.mjs pass rate by tower and tier (graded as in docs/ECONOMY.md 3.2),
//                 plus the utility, support and income contracts.
//   5. sweep      bot results against docs/ECONOMY.md section 7: novice 25..55, solid 70..110,
//                 eco >= solid, nobody past 160, difficulty ordering, late-game tower mix.
// Exits 1 on any violation.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Sim } from '../src/sim/game.js';
import { Rng } from '../src/core/rng.js';
import { buildWave, AUTHORED_COUNT, AUTHORED_TOLERANCE, PROC_TOLERANCE } from '../src/sim/wavegen.js';
import { payWaveIncome } from '../src/sim/economy.js';
import { computeBaseStats, finalizeStats, crosspathReason } from '../src/sim/towers.js';
import { TOWERS, TOWER_LIST, NO_DISCOUNT } from '../src/data/towers/index.js';
import { HEROES } from '../src/data/heroes.js';
import { MAPS, MAP_ORDER } from '../src/data/maps.js';
import { ENEMIES } from '../src/data/enemies.js';
import {
  budget, incomeFactor, waveBonus, titanHp, speedRamp, spawnDuration, priceFor, RIG_CAP, SELL_RATE,
  SURGE_START, SURGE_CAP, TITAN_EVERY, ETA0, TIER_EFFICIENCY, EFFICIENCY_TOLERANCE, START_CASH,
} from '../src/data/economy.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SELF = fileURLToPath(import.meta.url);
const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] !== undefined && !args[i + 1].startsWith('--') ? args[i + 1] : d; };
const has = (n) => args.includes('--' + n);

// ============================================================================================
// Shared: one bot run (worker mode) and the sweep plan
// ============================================================================================
export const SWEEP_PLAN = {
  maps: MAP_ORDER,
  seeds: [1, 2, 3, 4, 5],
  waves: 200,                                   // uncapped in practice: every run must end by 160
  runs: [
    { bot: 'novice' }, { bot: 'solid' }, { bot: 'eco' },
    { bot: 'solid', hero: 'vega' }, { bot: 'solid', hero: 'nova' }, { bot: 'solid', hero: 'brick' },
  ],
  difficulty: { maps: ['crater', 'dock'], seeds: [1, 2, 3], bots: ['solid', 'novice'], list: ['cadet', 'veteran', 'nightmare'] },
};
// eco >= solid is judged per map within ECO_TOL waves (seed noise: rig profit is a few percent of
// a late defense, a fraction of one surge wave, docs/BALANCE.md 4) and strictly on the pooled median
export const TARGETS = { novice: [25, 55], solid: [70, 110], ceiling: 160, ecoTol: 2 };

async function runOne(map, bot, seed, waves, hero, difficulty) {
  const { runGame } = await import('./headless.mjs');
  const t0 = Date.now();
  const leaks = {};
  let leakWave = 0;
  const onEvent = (ev, sim) => {
    if (ev.t !== 'leak') return;
    if (sim.state.wave !== leakWave) { leakWave = sim.state.wave; for (const k in leaks) delete leaks[k]; }
    const k = ev.titan ? 'TITAN' : ev.type;
    leaks[k] = (leaks[k] || 0) + ev.mass;
  };
  try {
    const { summary, sim } = runGame({ map, bot, seed, waves, quiet: true, hero: hero || null, difficulty, onEvent });
    const mix = {}, credits = {}, damage = {}, configs = {};
    for (const t of sim.state.towers) {
      const k = t.hero ? 'hero' : t.type;
      mix[k] = (mix[k] || 0) + 1;
      credits[k] = (credits[k] || 0) + (t.paid || 0);
      damage[k] = (damage[k] || 0) + (t.damage || 0);
      if (!t.hero) { const c = t.type + ':' + t.levels.join(''); configs[c] = (configs[c] || 0) + 1; }
    }
    return { map, bot, seed, hero: hero || null, difficulty, cleared: summary.cleared, over: summary.over, towers: summary.towers, lives: summary.lives, mix, credits, damage, configs, lastLeaks: leaks, leakWave, ms: Date.now() - t0 };
  } catch (e) {
    return { map, bot, seed, hero: hero || null, difficulty, error: String((e && e.message) || e), ms: Date.now() - t0 };
  }
}

if (has('worker')) {
  const i = args.indexOf('--worker');
  const [map, bot, seed, waves, hero, difficulty] = args.slice(i + 1);
  const r = await runOne(map, bot, Number(seed), Number(waves), hero && hero !== '-' ? hero : null, difficulty || 'pilot');
  process.stdout.write(JSON.stringify(r) + '\n');
  process.exit(0);
}

// ============================================================================================
// Reporting helpers
// ============================================================================================
const violations = [];
const report = { sections: {} };
function violate(section, msg) { violations.push(`[${section}] ${msg}`); console.log(`  VIOLATION ${msg}`); }
function header(t) { console.log('\n' + '='.repeat(96) + '\n' + t + '\n' + '='.repeat(96)); }
const pad = (s, n) => { s = String(s); return s.length >= n ? s : s + ' '.repeat(n - s.length); };
const padL = (s, n) => { s = String(s); return s.length >= n ? s : ' '.repeat(n - s.length) + s; };
const fmtK = (x) => (x >= 1e9 ? (x / 1e9).toFixed(2) + 'G' : x >= 1e6 ? (x / 1e6).toFixed(2) + 'M' : x >= 1e4 ? (x / 1e3).toFixed(1) + 'k' : x >= 100 ? x.toFixed(0) : x.toFixed(2));
const median = (a) => { const b = a.slice().sort((x, y) => x - y); return b.length ? b[(b.length - 1) >> 1] : NaN; };

// ============================================================================================
// 1. No-arbitrage property tests
// ============================================================================================
// Wealth W = credits + the sell value of every tower (vault balances included). Income E = every
// credit the storm paid in (stats.cashEarned) plus vault deposits, minus vault withdrawals (a
// withdrawal moves credits from a vault to cash and is counted by cashEarned a second time).
// Claim: W - E never increases, whatever the player does and whenever abilities fire.
function wealth(sim) {
  let w = sim.state.cash;
  // a vault balance counts in full (selling rounds it down, withdrawing does not)
  for (const t of sim.state.towers) { const v = t.data.vault || 0; w += sim.sellValue(t.id) - Math.floor(v + 1e-9) + v; }
  return w;
}
class Ledger {
  constructor(sim) { this.sim = sim; this.vaultIn = 0; this.vaultOut = 0; this.base = wealth(sim) - this.income(); this.worst = 0; this.checks = 0; }
  income() { return this.sim.state.stats.cashEarned + this.vaultIn - this.vaultOut; }
  events() {
    for (const ev of this.sim.drainEvents()) {
      if (ev.t === 'vault') this.vaultIn += ev.amount;
      else if (ev.t === 'cash' && ev.reason === 'vault') this.vaultOut += ev.amount;
    }
  }
  check(what) {
    this.events();
    this.checks++;
    const d = wealth(this.sim) - this.income();
    const gain = d - this.base;
    if (gain > this.worst) this.worst = gain;
    if (gain > 1e-6) return `${what}: credits + assets rose by ${gain.toFixed(4)} above income`;
    this.base = Math.min(this.base, d);
    return null;
  }
}

function legalSpots(sim, type, n, rng, near = 170) {
  const out = [];
  for (let k = 0; k < 400 && out.length < n; k++) {
    const x = 30 + rng.next() * 1440, y = 30 + rng.next() * 940;
    const c = sim.canPlace(type, x, y);
    if (c.spotOk && sim.nearestPathPoint(x, y).dist < near) out.push([x, y]);
  }
  return out;
}

function arbitrage(quick) {
  header('1. No arbitrage: credits + asset value never rise above what the storm paid in');
  const errs = [];
  const note = (e) => { if (e) errs.push(e); };

  // 1a. undo loop: a purchase undone in the same build phase is refunded exactly
  {
    const sim = new Sim({ mapId: 'crater', seed: 5 });
    sim.state.cash = 1e6;
    const rng = new Rng(9);
    for (const type of TOWER_LIST) {
      const [s] = legalSpots(sim, type, 1, rng);
      const c0 = sim.state.cash;
      const r = sim.placeTower(type, s[0], s[1]);
      if (!r.ok) { note(`undo: could not place ${type}`); continue; }
      for (let p = 0; p < 3; p++) sim.upgrade(r.id, p === 1 ? 0 : p);
      const v = sim.sell(r.id).value;
      if (Math.abs(sim.state.cash - c0) > 1e-9) note(`undo: ${type} place+upgrade+sell changed credits by ${sim.state.cash - c0}`);
      if (!(v > 0)) note(`undo: ${type} sold for nothing`);
    }
  }
  // 1b. after a wave launches, selling returns at most 70% of what was paid
  {
    const sim = new Sim({ mapId: 'frost', seed: 6 });
    sim.state.cash = 1e6; sim.state.lives = 1e9;
    const rng = new Rng(3);
    const ids = [];
    for (const type of TOWER_LIST) { const [s] = legalSpots(sim, type, 1, rng); const r = sim.placeTower(type, s[0], s[1]); if (r.ok) { sim.upgrade(r.id, 0); ids.push(r.id); } }
    sim.startWave();
    for (const id of ids) {
      const t = sim.getTower(id);
      const v = sim.sellValue(id);
      if (v > Math.floor(t.paid * SELL_RATE + 1e-9) + Math.floor((t.data.vault || 0) + 1e-9)) note(`sell: ${t.type} sells for ${v} after a wave launched, paid ${t.paid}`);
    }
  }
  // 1c. Rigs and Beacons are never discounted; a used discount spends the Beacon's undo refund
  {
    const sim = new Sim({ mapId: 'crater', seed: 7 });
    sim.state.cash = 1e6;
    const c0 = sim.state.cash;
    const rng = new Rng(4);
    const [bs] = legalSpots(sim, 'beacon', 1, rng, 120);
    const b = sim.placeTower('beacon', bs[0], bs[1]).id;
    for (let k = 0; k < 3; k++) sim.upgrade(b, 2);
    const beacon = sim.getTower(b);
    const disc = beacon.stats.aura.discount;
    if (!(disc > 0)) note('discount: Supply Beacon 0-0-3 gives no discount');
    const r = beacon.stats.aura.radius;
    for (const type of NO_DISCOUNT) {
      if (sim.priceAt(type, beacon.x + r * 0.4, beacon.y) !== sim.priceOf(type)) note(`discount: ${type} is discounted inside a Supply Beacon`);
    }
    const paidB = beacon.paid;
    let listValue = 0, spot = null;
    for (let k = 0; k < 40 && !spot; k++) {
      const a = rng.next() * Math.PI * 2, d = 40 + rng.next() * (r - 50);
      const x = beacon.x + Math.cos(a) * d, y = beacon.y + Math.sin(a) * d;
      if (sim.canPlace('laser', x, y).ok) spot = [x, y];
    }
    if (!spot) note('discount: no spot inside the Beacon radius');
    else {
      const id = sim.placeTower('laser', spot[0], spot[1]).id;
      listValue += sim.priceOf('laser');
      for (let k = 0; k < 2; k++) { listValue += priceFor(TOWERS.laser.paths[0].upgrades[k].cost, 'pilot'); sim.upgrade(id, 0); }
      const tw = sim.getTower(id);
      if (!(tw.paid < listValue)) note('discount: purchase inside the Beacon was not discounted');
      const vb = sim.sell(b).value;
      if (vb > Math.floor(paidB * SELL_RATE + 1e-9)) note(`discount: Beacon undo refund survived a used discount (${vb} of ${paidB})`);
      // the loop "place Beacon, buy discounted, undo Beacon" must cost at least 30% of the Beacon
      const spent = c0 - sim.state.cash;
      if (spent + 1e-9 < tw.paid + (paidB - vb)) note('discount: loop accounting mismatch');
      if (listValue - tw.paid > (paidB - vb) + 1e-9 && tw.paid + (paidB - vb) < listValue * (1 - disc)) note('discount: loop bought towers below the discounted price');
    }
  }
  // 1d. vault interest never exceeds rate x cap x c(w); a full vault cannot grow its own payout
  {
    const sim = new Sim({ mapId: 'crater', seed: 8 });
    sim.state.cash = 1e7;
    const rng = new Rng(8);
    const [s] = legalSpots(sim, 'rig', 1, rng, 2000);
    const id = sim.placeTower('rig', s[0], s[1]).id;
    for (let k = 0; k < 5; k++) sim.upgrade(id, 1);
    for (let k = 0; k < 2; k++) sim.upgrade(id, 0);
    const t = sim.getTower(id);
    const inc = t.stats.income;
    for (const w of [10, 50, 80, 120, 160]) {
      t.data.vault = inc.vault.cap;
      sim.state.cash = 0; const cash0 = 0;
      payWaveIncome(sim, w);
      const got = sim.state.cash - cash0 + (t.data.vault - inc.vault.cap);
      const bound = (inc.perWave + inc.vault.rate * inc.vault.cap) * incomeFactor(w);
      if (got > bound + 1e-6) note(`vault: wave ${w} paid ${got.toFixed(2)} > bound ${bound.toFixed(2)}`);
    }
    sim.drainEvents();
  }
  // 1e. save and load keep every credit and every sell value
  {
    const sim = new Sim({ mapId: 'dock', seed: 12 });
    sim.state.cash = 1e5;
    const rng = new Rng(12);
    for (const type of ['pulse', 'rig', 'beacon', 'laser']) { const [s] = legalSpots(sim, type, 1, rng, 400); const r = sim.placeTower(type, s[0], s[1]); if (r.ok) sim.upgrade(r.id, 1); }
    const w0 = wealth(sim);
    const b = Sim.fromSave(JSON.parse(JSON.stringify(sim.serialize())));
    if (Math.abs(wealth(b) - w0) > 1e-6) note(`save/load: wealth ${w0} became ${wealth(b)}`);
  }

  // 1f. ability timing: every activated ability in the game (tower tiers 4 and 5, Commanders at
  // level 20), fired at the first usable tick, at random ticks, or late in the wave, never lets
  // W - E rise. Abilities only destroy meteors (bounty is income) or buff towers.
  let abilityUses = 0;
  const abilityIds = new Set();
  {
    const cfgs = [];
    for (const type of TOWER_LIST) {
      const seen = new Set();
      for (const lv of allConfigs()) {
        const st = finalizeStats(computeBaseStats(TOWERS[type], lv), null, null);
        for (const a of st.abilities || []) if (!seen.has(a.id)) { seen.add(a.id); cfgs.push({ type, lv, id: a.id }); }
      }
    }
    const policies = ['first', 'random', 'late'];
    for (let trial = 0; trial < (quick ? 3 : 6); trial++) {
      const hero = ['vega', 'nova', 'brick'][trial % 3];
      const policy = policies[trial % 3];
      const sim = new Sim({ mapId: MAP_ORDER[trial % MAP_ORDER.length], seed: 300 + trial, heroId: hero });
      sim.state.cash = 5e6; sim.state.lives = 1e12; sim.state.maxLives = 1e12;
      const rng = new Rng(700 + trial);
      const placedT5 = new Set();
      for (const c of cfgs) {
        const key = c.type + ':' + c.lv.map((x) => (x === 5 ? 5 : 0)).join('');
        if (c.lv.includes(5) && placedT5.has(key)) continue;
        const s = legalSpots(sim, c.type, 1, rng, 220)[0];
        if (!s) continue;
        const r = sim.placeTower(c.type, s[0], s[1]);
        if (!r.ok) continue;
        for (let t = 1; t <= 5; t++) for (let p = 0; p < 3; p++) if (c.lv[p] >= t) sim.upgrade(r.id, p);
        placedT5.add(key);
      }
      const hs = legalSpots(sim, hero, 1, rng, 200)[0];
      if (hs) { const r = sim.placeTower(hero, hs[0], hs[1]); if (r.ok) sim._addHeroXp(sim.getTower(r.id), 1e9); }
      sim.skipTo(30 + trial * 12);
      sim.state.cash = 2e4 + trial * 1e4;
      const L = new Ledger(sim);
      for (let wv = 0; wv < 3 && sim.state.phase !== 'over'; wv++) {
        sim.startWave();
        note(L.check(`ability trial ${trial} (${policy}): start wave`));
        let n = 0;
        while (sim.state.phase === 'wave' && n++ < 60 * 300) {
          sim.step();
          const fire = policy === 'first' || (policy === 'random' && rng.next() < 0.02) || (policy === 'late' && n > 60 * 20);
          if (fire) for (const g of sim.abilityBar()) if (g.usable && sim.useAbility(g.id).ok) { abilityUses++; abilityIds.add(g.id); note(L.check(`ability trial ${trial} (${policy}): ${g.id}`)); }
          if ((n & 15) === 0) note(L.check(`ability trial ${trial} (${policy}) tick ${n}`));
        }
        note(L.check(`ability trial ${trial} (${policy}) after wave ${sim.state.wave}`));
      }
    }
    const want = new Set(cfgs.map((c) => c.id));
    const missing = [...want].filter((id) => !abilityIds.has(id));
    console.log(`  ability timing: ${abilityUses} uses of ${abilityIds.size} distinct abilities (${[...abilityIds].sort().join(', ')}) under first-usable, random and late firing`);
    if (missing.length) note(`ability timing: never fired ${missing.join(', ')}`);
  }

  // 1g. random play: thousands of commands, waves and ability uses; W - E never rises
  const trials = quick ? 6 : 16;
  let commands = 0, steps = 0, worst = 0, abilities = 0;
  const kinds = ['place', 'place', 'upgrade', 'upgrade', 'upgrade', 'sell', 'withdraw', 'target', 'aim', 'ability', 'wave'];
  for (let trial = 0; trial < trials; trial++) {
    const map = MAP_ORDER[trial % MAP_ORDER.length];
    const diffs = ['cadet', 'pilot', 'veteran', 'nightmare'];
    const heroes = [null, 'vega', 'nova', 'brick'];
    const sim = new Sim({ mapId: map, difficulty: diffs[trial % 4], seed: 100 + trial, heroId: heroes[trial % 4] });
    sim.state.cash = trial < 4 ? 3000 + trial * 4000 : 60000 * trial;
    sim.state.lives = 1e12; sim.state.maxLives = 1e12;
    const rng = new Rng(500 + trial);
    const L = new Ledger(sim);
    const spotsOf = new Map();
    const spotFor = (type) => {
      let list = spotsOf.get(type);
      if (!list || !list.length) { list = legalSpots(sim, type, 30, rng, type === 'rig' ? 2000 : 180); spotsOf.set(type, list); }
      return list.pop();
    };
    const waves = quick ? 6 : 10;
    for (let wv = 0; wv < waves && sim.state.phase !== 'over'; wv++) {
      // build phase: a burst of random commands
      for (let k = 0; k < 30; k++) {
        const kind = kinds[rng.int(kinds.length)];
        const towers = sim.state.towers;
        const t = towers.length ? towers[rng.int(towers.length)] : null;
        let what = kind;
        if (kind === 'place') {
          const pool = rng.next() < 0.25 ? ['beacon', 'rig'] : TOWER_LIST;
          const type = heroes[trial % 4] && rng.next() < 0.1 ? heroes[trial % 4] : pool[rng.int(pool.length)];
          const s = spotFor(type);
          if (s) sim.placeTower(type, s[0], s[1]);
          what = 'place ' + type;
        } else if (kind === 'upgrade' && t) {
          // mostly push the tower's main path, so tier 4 and 5 abilities show up
          const main = t.levels.indexOf(Math.max(...t.levels));
          const p = t.type === 'beacon' && rng.next() < 0.6 ? 2 : rng.next() < 0.7 ? main : rng.int(3);
          sim.upgrade(t.id, p); what = `upgrade ${t.type} path ${p}`;
        }
        else if (kind === 'sell' && t) { sim.sell(t.id); what = 'sell ' + t.type; }
        else if (kind === 'withdraw' && t) sim.withdraw(t.id);
        else if (kind === 'target' && t) sim.setTargeting(t.id, t.stats.targetModes[rng.int(t.stats.targetModes.length)]);
        else if (kind === 'aim' && t) sim.setAim(t.id, rng.next() * 1500, rng.next() * 1000);
        commands++;
        note(L.check(`trial ${trial} build: ${what}`));
      }
      sim.startWave();
      note(L.check(`trial ${trial}: start wave`));
      // wave: step, fire every ready ability as soon as it is usable, trade now and then
      let n = 0;
      while (sim.state.phase === 'wave' && n++ < 60 * 400) {
        sim.step(); steps++;
        if ((n & 7) === 0) {
          for (const g of sim.abilityBar()) if (g.usable && sim.useAbility(g.id).ok) abilities++;
          note(L.check(`trial ${trial} wave ${sim.state.wave} tick ${n}`));
        }
        if (n % 97 === 0 && sim.state.towers.length) {
          const t = sim.state.towers[rng.int(sim.state.towers.length)];
          const r = rng.next();
          if (r < 0.3) sim.upgrade(t.id, rng.int(3)); else if (r < 0.45) sim.sell(t.id); else if (r < 0.6) sim.withdraw(t.id);
          else if (r < 0.75 && sim.canStartWave()) sim.startWave();
          commands++;
          note(L.check(`trial ${trial} wave ${sim.state.wave} mid-wave trade`));
        }
      }
      note(L.check(`trial ${trial} after wave ${sim.state.wave}`));
    }
    worst = Math.max(worst, L.worst);
  }
  console.log(`  targeted tests: undo loop, sell after a wave, Beacon discount loop, Rig/Beacon never discounted, vault bound, save/load`);
  console.log(`  random play: ${trials} runs, ${commands} commands, ${steps} sim ticks, ${abilities} ability uses, worst rise of credits + assets above income: ${worst.toExponential(2)}`);
  const unique = [...new Set(errs)];
  for (const e of unique.slice(0, 12)) violate('arbitrage', e);
  if (!unique.length) console.log('  PASS: no loop creates credits');
  report.sections.arbitrage = { trials, commands, steps, abilities: abilities + abilityUses, abilityIds: [...abilityIds], worst, errors: unique };
}

// ============================================================================================
// 2. Bounded passive income
// ============================================================================================
function allConfigs() {
  const out = [];
  for (let a = 0; a <= 5; a++) for (let b = 0; b <= 5; b++) for (let c = 0; c <= 5; c++) {
    const lv = [a, b, c];
    if (lv.filter((x) => x > 0).length > 2 || lv.filter((x) => x > 2).length > 1) continue;
    out.push(lv);
  }
  return out;
}
function rigIncome(lv) {
  const inc = finalizeStats(computeBaseStats(TOWERS.rig, lv), null, null).income;
  return inc;
}
function rigPassive(inc) {
  // ore per wave plus a full vault's interest, at c = 1
  return (inc.ownPerWave !== undefined ? inc.ownPerWave : inc.perWave) + (inc.vault ? inc.vault.rate * inc.vault.cap : 0);
}
// Best 10-Rig fleet: each tier 5 at most once per game (T5 uniqueness), the rest tier 4 at most.
export function maxRigFleet() {
  const cfgs = allConfigs().map((lv) => ({ lv, inc: rigIncome(lv) }));
  const t5 = (p) => cfgs.filter((c) => c.lv[p] === 5);
  const t4 = cfgs.filter((c) => Math.max(...c.lv) <= 4);
  const best = (list) => list.reduce((b, c) => (!b || rigPassive(c.inc) > rigPassive(b.inc) ? c : b), null);
  const bestT4 = best(t4);
  let top = null;
  for (let mask = 0; mask < 8; mask++) {
    const fleet = [];
    for (let p = 0; p < 3; p++) if (mask & (1 << p)) {
      // for the Trade Hub path pick the crosspath with the most own passive income
      fleet.push(best(t5(p)));
    }
    while (fleet.length < RIG_CAP) fleet.push(bestT4);
    let own = 0, total = 0;
    for (const f of fleet) { own += f.inc.ownPerWave !== undefined ? f.inc.ownPerWave : f.inc.perWave; total += rigPassive(f.inc); }
    for (const f of fleet) if (f.inc.hubBoost) total += f.inc.hubBoost * (own - f.inc.ownPerWave);
    if (!top || total > top.total) top = { total, fleet: fleet.map((f) => f.lv.join('-')) };
  }
  return top;
}
// Most Rail Snipers any map can hold (hex packing at the tower's spacing), an upper bound on
// how many supply-dropping Rails can exist.
function maxTowersOnMap(mapId, type) {
  const sim = new Sim({ mapId });
  const r = TOWERS[type].radius || 22;
  const dx = 2 * r + 0.01, dy = dx * Math.sqrt(3) / 2;
  let n = 0;
  for (let row = 0, y = r + 11; y < 1000 - r - 10; y += dy, row++) {
    for (let x = r + 11 + (row % 2 ? dx / 2 : 0); x < 1500 - r - 10; x += dx) {
      if (sim.canPlace(type, x, y).spotOk) { sim.state.cash = 1e12; if (sim.placeTower(type, x, y).ok) n++; }
    }
  }
  return n;
}
export function supplyBound() {
  let drops = null, qm = null;
  for (const lv of allConfigs()) {
    const inc = finalizeStats(computeBaseStats(TOWERS.rail, lv), null, null).income;
    if (!inc || !inc.supply) continue;
    const v = inc.supply.drops * inc.supply.value;
    if (lv[2] === 5) { if (!qm || v > qm) qm = v; } else if (!drops || v > drops) drops = v;
  }
  let maxRails = 0, mapMax = null;
  for (const m of MAP_ORDER) { const n = maxTowersOnMap(m, 'rail'); if (n > maxRails) { maxRails = n; mapMax = m; } }
  return { perRail: drops || 0, quartermaster: qm || 0, maxRails, mapMax, total: (maxRails - 1) * (drops || 0) + (qm || 0) };
}
export function popIncome(w) {
  const s = buildWave(w);
  let shells = 0;
  for (const g of s.groups) shells += g.count * ENEMIES[g.type].shells;
  return { shells, pop: shells * incomeFactor(w), bonus: waveBonus(w), mass: s.mass };
}

function passive() {
  header('2. Bounded passive income: 10 maxed Rigs and every possible supply drop vs pop income');
  const fleet = maxRigFleet();
  const sup = supplyBound();
  console.log(`  best 10-Rig fleet (T5s unique): ${fleet.fleet.join(', ')} -> ${fmtK(fleet.total)} per wave at c = 1 (ore + full vault interest + Trade Hub)`);
  console.log(`  supply drops: ${sup.perRail} per Supply Drop rail, ${sup.quartermaster} for the one Quartermaster, at most ${sup.maxRails} Rails fit (${sup.mapMax}) -> ${fmtK(sup.total)} per wave at c = 1`);
  // refinery and payback contracts
  let minP = Infinity, maxK = 0;
  for (const lv of allConfigs()) {
    const inc = rigIncome(lv);
    if (inc.refinery) maxK = Math.max(maxK, inc.refinery.k);
    let cost = TOWERS.rig.cost;
    for (let p = 0; p < 3; p++) for (let k = 0; k < lv[p]; k++) cost += TOWERS.rig.paths[p].upgrades[k].cost;
    if (inc.perWave > 0) minP = Math.min(minP, cost / inc.perWave);
  }
  console.log(`  Rig payback floor: min P = ${minP.toFixed(2)} waves over all 64 combos (contract >= 8); Refinery k max = ${maxK} (contract <= 0.25)`);
  if (minP < 8) violate('passive', `a Rig combo pays back in ${minP.toFixed(2)} < 8 waves`);
  if (maxK > 0.25 + 1e-12) violate('passive', `Refinery k ${maxK} > 0.25`);

  // engine check: place the fleet, fill every vault, pay a wave, compare with the analytic bound
  const sim = new Sim({ mapId: 'crater', seed: 2 });
  sim.state.cash = 1e12;
  const rng = new Rng(2);
  const spots = legalSpots(sim, 'rig', 40, rng, 5000);
  const placed = [];
  for (const cfg of fleet.fleet) {
    const lv = cfg.split('-').map(Number);
    let s; while ((s = spots.pop())) { const r = sim.placeTower('rig', s[0], s[1]); if (r.ok) { placed.push(r.id); for (let p = 0; p < 3; p++) for (let k = 0; k < lv[p]; k++) sim.upgrade(r.id, p); break; } }
  }
  for (let k = 0; k < 60; k++) sim.step(); // Trade Hub bookkeeping runs as a per-tick custom attack
  const rows = [];
  let bad = 0;
  for (let w = 1; w <= 160; w++) {
    for (const id of placed) { const t = sim.getTower(id); if (t.stats.income.vault) t.data.vault = t.stats.income.vault.cap; }
    sim.state.cash = 0; const cash0 = 0;
    let v0 = 0; for (const id of placed) v0 += sim.getTower(id).data.vault || 0;
    payWaveIncome(sim, w);
    let v1 = 0; for (const id of placed) v1 += sim.getTower(id).data.vault || 0;
    sim.drainEvents();
    const paid = sim.state.cash - cash0 + v1 - v0;
    const bound = fleet.total * incomeFactor(w);
    if (paid > bound * (1 + 1e-9) + 1e-6) { if (!bad) console.log(`  engine payout ${paid} vs bound ${bound} at wave ${w}: ` + placed.map((id) => sim.getTower(id).levels.join('-')).join(' ')); bad++; }
    const pi = popIncome(w);
    rows.push({ w, pop: pi.pop + pi.bonus, rigs: paid, rigBound: bound, supply: sup.total * incomeFactor(w), mass: pi.mass });
  }
  if (bad) violate('passive', `engine paid more than the analytic Rig bound on ${bad} waves`);
  console.log('\n  ' + pad('wave', 6) + padL('B(w)', 10) + padL('pop+bonus', 11) + padL('10 Rigs', 10) + padL('supply max', 12) + padL('passive/pop', 13) + padL('c(w)', 8));
  for (const r of rows) {
    if (!(r.w === 1 || r.w % 10 === 0)) continue;
    const ratio = (r.rigs + r.supply) / r.pop;
    console.log('  ' + pad(r.w, 6) + padL(fmtK(r.mass), 10) + padL(fmtK(r.pop), 11) + padL(fmtK(r.rigs), 10) + padL(fmtK(r.supply), 12) + padL(ratio.toFixed(2), 13) + padL(incomeFactor(r.w).toFixed(3), 8));
  }
  // passive income is c(w) x constant: from C_START on its share of the threat only falls, to 0
  let rising = 0;
  const share = (r) => (r.rigs + r.supply) / r.mass;
  for (let i = 1; i < rows.length; i++) if (rows[i].w > 50 && share(rows[i]) > share(rows[i - 1]) * 1.1) rising++;
  const end = share(rows[rows.length - 1]);
  console.log(`\n  passive income per wave is at most ${fmtK(fleet.total + sup.total)} x c(w) (the supply column assumes a map packed with Supply Drop rails);`);
  console.log(`  its share of the wave's mass after wave 50 falls from ${(share(rows[50]) * 100).toFixed(0)}% (wave 51) to ${(end * 100).toFixed(3)}% (wave 160)`);
  if (rising > 3) violate('passive', `passive share of the threat rises on ${rising} waves after wave 50`);
  if (!(end < 0.01)) violate('passive', `passive income is still ${(end * 100).toFixed(2)}% of wave mass at wave 160`);
  // supply drops are an investment like Rigs: payback at c = 1
  let supP = Infinity;
  for (const lv of allConfigs()) {
    const inc = finalizeStats(computeBaseStats(TOWERS.rail, lv), null, null).income;
    if (!inc || !inc.supply) continue;
    let cost = TOWERS.rail.cost;
    for (let p = 0; p < 3; p++) for (let k = 0; k < lv[p]; k++) cost += TOWERS.rail.paths[p].upgrades[k].cost;
    supP = Math.min(supP, cost / (inc.supply.drops * inc.supply.value));
  }
  console.log(`  cheapest supply drops pay back their Rail in ${supP.toFixed(1)} waves at c = 1 (a combat tower first, income second)`);
  if (supP < 8) violate('passive', `a Supply Drop rail pays back in ${supP.toFixed(1)} < 8 waves`);
  report.supplyPayback = supP;
  if (!bad) console.log('  PASS: passive income is bounded by a constant times c(w)');
  report.sections.passive = { fleet, supply: sup, minP, maxK, rows };
}

// ============================================================================================
// 3. Monotone threat
// ============================================================================================
function threat() {
  header('3. Monotone threat: B(w), wave masses, Titans, speed');
  let errs = 0;
  const e = (m) => { if (errs++ < 12) violate('threat', m); };
  for (let w = 1; w < 600; w++) {
    const a = budget(w), b = budget(w + 1);
    if (!(Number.isFinite(b) && b > a)) e(`B(${w + 1}) = ${b} is not above B(${w}) = ${a}`);
  }
  // log-convex from the surge start to the surge cap: the growth rate itself keeps rising
  for (let w = SURGE_START + 1; w < SURGE_START + SURGE_CAP; w++) {
    const g0 = Math.log(budget(w) / budget(w - 1)), g1 = Math.log(budget(w + 1) / budget(w));
    if (g1 < g0 - 1e-12) e(`growth rate of B falls at wave ${w}`);
  }
  let authoredMax = 0, procMax = 0;
  for (let w = 1; w <= 200; w++) {
    const s = buildWave(w);
    const r = s.mass / s.budget - 1;
    if (w <= AUTHORED_COUNT) { authoredMax = Math.max(authoredMax, Math.abs(r)); if (Math.abs(r) > AUTHORED_TOLERANCE + 1e-9) e(`wave ${w} mass ${s.mass} is ${(r * 100).toFixed(1)}% off budget`); }
    else { procMax = Math.max(procMax, Math.abs(r)); if (Math.abs(r) > PROC_TOLERANCE + 1e-9) e(`wave ${w} mass is ${(r * 100).toFixed(1)}% off budget`); }
    if (!(s.hullMult >= 1)) e(`wave ${w} hull multiplier ${s.hullMult} < 1`);
    if (speedRamp(w + 1) < speedRamp(w)) e(`speed ramp falls at ${w}`);
  }
  for (let t = 1; t < 12; t++) if (!(titanHp(t + 1) > titanHp(t))) e(`Titan tier ${t + 1} hull is not above tier ${t}`);
  // required clear rate B(w) / D(w) x v(w) grows without bound
  let prev = 0, rateOk = true;
  for (let w = 45; w <= 400; w++) { const q = budget(w) / spawnDuration(w) * speedRamp(w); if (q <= prev) rateOk = false; prev = q; }
  if (!rateOk) e('required clear rate B/D x v is not increasing after wave 45');
  console.log('  ' + ['1', '10', '20', '40', '60', '80', '100', '120', '140', '160'].map((w) => `B(${w})=${fmtK(budget(+w))}`).join('  '));
  console.log(`  Titans: ${[1, 2, 3, 4, 5, 6, 7, 8].map((t) => `w${t * TITAN_EVERY}=${fmtK(titanHp(t))}`).join('  ')}`);
  console.log(`  authored waves within ${(authoredMax * 100).toFixed(1)}% of budget (limit ${AUTHORED_TOLERANCE * 100}%), procedural within ${(procMax * 100).toFixed(2)}% (limit ${PROC_TOLERANCE * 100}%)`);
  console.log(`  required clear rate B(w)/D(w) x v(w) at w = 100/140/160: ${[100, 140, 160].map((w) => fmtK(budget(w) / spawnDuration(w) * speedRamp(w))).join(' / ')} mass per second`);
  if (!errs) console.log('  PASS: threat is strictly increasing and super-exponential after the surge');
  report.sections.threat = { authoredMax, procMax, errors: errs };
}

// ============================================================================================
// 4. Bench pass rate
// ============================================================================================
async function bench(quick) {
  header('4. Upgrades are worth buying: bench efficiency by tower and tier');
  const B = await import('./bench.mjs');
  const opts = { warmup: quick ? 1 : 3, measure: quick ? 6 : 30, seed: 1 };
  const byTower = {};
  const rowsAll = {};
  for (const type of TOWER_LIST) {
    const meta = B.PRIMARY[type];
    if (meta.kind === 'damage') {
      const rows = B.benchDamageTower(type, B.DEFAULT_CONFIGS, { ...opts, scenarios: B.CORE_SCENARIOS });
      rowsAll[type] = rows;
      const tiers = [[0, 0], [0, 0], [0, 0], [0, 0], [0, 0], [0, 0]];
      for (const r of rows) { tiers[r.highestTier][1]++; if (r.status === 'PASS') tiers[r.highestTier][0]++; if (r.status === 'HIGH') violate('bench', `${type} ${r.levels.join('-')} reads HIGH (${r.bestEta.toFixed(1)} vs target ${r.target.toFixed(1)} on ${r.gradedOn})`); }
      const pass = rows.filter((r) => r.status === 'PASS').length;
      byTower[type] = { kind: 'damage', pass, n: rows.length, tiers, low: rows.filter((r) => r.status === 'LOW').map((r) => r.levels.join('-')) };
      if (pass / rows.length < 0.6) violate('bench', `${type} passes only ${pass}/${rows.length} configs`);
      // mean graded efficiency rises with tier (upgrades are worth buying)
      const mean = [0, 1, 2, 3, 4, 5].map((t) => { const s = rows.filter((r) => r.highestTier === t); return s.length ? s.reduce((a, r) => a + r.bestEta / r.target, 0) / s.length : null; });
      byTower[type].meanRatio = mean;
      const eff = [0, 1, 2, 3, 4, 5].map((t) => { const s = rows.filter((r) => r.highestTier === t); return s.length ? s.reduce((a, r) => a + r.bestEta, 0) / s.length : null; });
      byTower[type].meanEta = eff;
      if (!(eff[5] > eff[0])) violate('bench', `${type}: tier 5 is not more efficient than the base tower`);
    } else if (meta.kind === 'utility') {
      const rows = B.benchUtilityTower(type, B.DEFAULT_CONFIGS, opts);
      rowsAll[type] = rows;
      const ok = rows.filter((r) => r.leakedWith <= 0.8 * r.leakedAlone || r.gainMDS > 0.35 * r.mdsAlone).length;
      byTower[type] = { kind: 'utility', pass: ok, n: rows.length };
      if (ok < rows.length) violate('bench', `${type}: ${rows.length - ok} configs do not protect the corridor (leak not cut by 20% and no 35% MDS gain)`);
    } else if (meta.kind === 'support') {
      const rows = B.benchBeacon(B.DEFAULT_CONFIGS, opts);
      rowsAll[type] = rows;
      // pays for itself on 4 covered towers of its own value: 4 x fractional gain >= 0.75
      const pay = rows.map((r) => 4 * r.gainMDS / r.mdsAlone);
      const ok = pay.filter((p) => p >= 0.75).length;
      byTower[type] = { kind: 'support', pass: ok, n: rows.length, pay };
      if (ok < rows.length) violate('bench', `beacon: ${rows.length - ok} configs would not pay for themselves on 4 equal towers`);
    } else {
      const rows = B.benchRig(B.DEFAULT_CONFIGS);
      rowsAll[type] = rows;
      const ok = rows.filter((r) => r.P >= 8).length;
      byTower[type] = { kind: 'income', pass: ok, n: rows.length };
      if (ok < rows.length) violate('bench', `rig: ${rows.length - ok} configs pay back in under 8 waves`);
    }
  }
  console.log('  ' + pad('tower', 10) + pad('kind', 9) + padL('pass', 8) + '   by highest tier (pass/configs)             mean eta by tier (target 10, 10.5, 11.2, 13, 16, 25)');
  for (const [type, b] of Object.entries(byTower)) {
    const tierStr = b.tiers ? b.tiers.map((t, i) => `T${i} ${t[0]}/${t[1]}`).join('  ') : '';
    const eff = b.meanEta ? b.meanEta.map((x) => (x === null ? '-' : x.toFixed(1))).join(' ') : '';
    console.log('  ' + pad(type, 10) + pad(b.kind, 9) + padL(`${b.pass}/${b.n}`, 8) + '   ' + pad(tierStr, 44) + eff);
  }
  const low = Object.entries(byTower).filter(([, b]) => b.low && b.low.length).map(([t, b]) => `${t} ${b.low.join(' ')}`);
  if (low.length) console.log('  LOW (reported, not violations): ' + low.join('; '));
  const dmg = Object.values(byTower).filter((b) => b.kind === 'damage');
  const tot = dmg.reduce((a, b) => a + b.pass, 0), n = dmg.reduce((a, b) => a + b.n, 0);
  console.log(`  damage towers: ${tot}/${n} configs pass (${(100 * tot / n).toFixed(0)}%)`);
  report.sections.bench = { byTower, rows: rowsAll, meta: opts };
}

// ============================================================================================
// 5. Bot sweep
// ============================================================================================
async function runSweep(file) {
  const jobs = [];
  for (const s of SWEEP_PLAN.seeds) for (const m of SWEEP_PLAN.maps) for (const r of SWEEP_PLAN.runs) jobs.push([m, r.bot, s, SWEEP_PLAN.waves, r.hero || '-', 'pilot']);
  const D = SWEEP_PLAN.difficulty;
  for (const d of D.list) for (const m of D.maps) for (const s of D.seeds) for (const b of D.bots) jobs.push([m, b, s, SWEEP_PLAN.waves, '-', d]);
  // warm the bot profile cache once so the workers do not all measure it at the same time
  const { runGame } = await import('./headless.mjs');
  runGame({ map: 'crater', bot: 'solid', waves: 1, quiet: true });
  const par = Math.max(1, Math.min(jobs.length, (os.cpus().length || 4) - 2));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '');
  let next = 0, done = 0;
  const t0 = Date.now();
  await new Promise((resolve) => {
    let running = 0;
    const launch = () => {
      while (running < par && next < jobs.length) {
        const j = jobs[next++]; running++;
        const p = spawn(process.execPath, [SELF, '--worker', ...j.map(String)], { stdio: ['ignore', 'pipe', 'pipe'] });
        let buf = '', err = '';
        p.stdout.on('data', (d) => (buf += d));
        p.stderr.on('data', (d) => (err += d));
        p.on('close', () => {
          running--; done++;
          let r;
          try { r = JSON.parse(buf.trim().split('\n').pop()); } catch { r = { map: j[0], bot: j[1], seed: j[2], hero: j[4] === '-' ? null : j[4], difficulty: j[5], error: 'worker crashed: ' + err.slice(0, 200) }; }
          fs.appendFileSync(file, JSON.stringify(r) + '\n');
          process.stdout.write(`\r  sweep ${done}/${jobs.length} (${Math.round((Date.now() - t0) / 1000)} s)   `);
          if (done === jobs.length) { process.stdout.write('\n'); resolve(); } else launch();
        });
      }
    };
    launch();
  });
}

function sweep(file) {
  header('5. Skill expression: bot sweep against docs/ECONOMY.md section 7');
  if (!fs.existsSync(file)) { violate('sweep', `no sweep results at ${path.relative(ROOT, file)} (run with --sweep)`); return; }
  const runs = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  console.log(`  ${runs.length} runs from ${path.relative(ROOT, file)} (${fs.statSync(file).mtime.toISOString().slice(0, 16)})`);
  for (const r of runs) if (r.error) violate('sweep', `${r.bot} ${r.map} seed ${r.seed}${r.hero ? ' ' + r.hero : ''} ${r.difficulty}: ${r.error}`);
  const ok = runs.filter((r) => !r.error);
  const sel = (f) => ok.filter(f);
  const pilot = sel((r) => r.difficulty === 'pilot');
  const key = (r) => r.bot + (r.hero ? '+' + r.hero : '');
  const groups = [...new Set(pilot.map(key))];
  console.log('\n  ' + pad('bot', 14) + MAP_ORDER.map((m) => pad(m, 20)).join('') + 'all');
  const med = {};
  for (const g of groups) {
    med[g] = {};
    let line = pad(g, 14);
    const all = [];
    for (const m of MAP_ORDER) {
      const c = pilot.filter((r) => key(r) === g && r.map === m).map((r) => r.cleared);
      all.push(...c);
      med[g][m] = median(c);
      line += pad(c.length ? `${median(c)} [${c.sort((a, b) => a - b).join('/')}]` : '-', 20);
    }
    med[g].all = median(all);
    console.log('  ' + line + median(all));
  }
  // targets
  for (const m of MAP_ORDER) {
    const n = med.novice && med.novice[m], s = med.solid && med.solid[m], e = med.eco && med.eco[m];
    if (n !== undefined && !(n >= TARGETS.novice[0] && n <= TARGETS.novice[1])) violate('sweep', `${m}: novice median ${n} outside ${TARGETS.novice.join('..')}`);
    if (s !== undefined && !(s >= TARGETS.solid[0] && s <= TARGETS.solid[1])) violate('sweep', `${m}: solid median ${s} outside ${TARGETS.solid.join('..')}`);
    if (e !== undefined && s !== undefined && !(e >= s - TARGETS.ecoTol)) violate('sweep', `${m}: eco median ${e} more than ${TARGETS.ecoTol} waves below solid median ${s}`);
    for (const h of ['vega', 'nova', 'brick']) {
      const v = med['solid+' + h] && med['solid+' + h][m];
      if (v !== undefined && !(v >= TARGETS.solid[0] && v <= TARGETS.solid[1] + 20)) violate('sweep', `${m}: solid with ${h} median ${v} outside ${TARGETS.solid[0]}..${TARGETS.solid[1] + 20}`);
    }
  }
  if (med.eco && med.solid && !(med.eco.all >= med.solid.all)) violate('sweep', `eco pooled median ${med.eco.all} below solid pooled median ${med.solid.all}`);
  const maxC = Math.max(...ok.map((r) => r.cleared));
  const alive = ok.filter((r) => !r.over);
  console.log(`\n  furthest run: wave ${maxC} cleared; runs still alive at the cap: ${alive.length}`);
  if (maxC > TARGETS.ceiling) violate('sweep', `a bot cleared wave ${maxC} > ${TARGETS.ceiling}`);
  if (alive.length) violate('sweep', `${alive.length} runs never ended`);
  // difficulty ordering (solid and novice, pooled over the difficulty maps and seeds)
  const D = SWEEP_PLAN.difficulty;
  const dline = [];
  for (const b of D.bots) {
    const vals = ['cadet', 'pilot', 'veteran', 'nightmare'].map((d) => median(ok.filter((r) => r.bot === b && !r.hero && r.difficulty === d && D.maps.includes(r.map) && D.seeds.includes(r.seed)).map((r) => r.cleared)));
    dline.push(`${b}: cadet ${vals[0]} / pilot ${vals[1]} / veteran ${vals[2]} / nightmare ${vals[3]}`);
    if (vals.every(Number.isFinite)) {
      if (!(vals[0] >= vals[1] && vals[1] >= vals[2] && vals[2] >= vals[3])) violate('sweep', `${b}: difficulty medians are not ordered (${vals.join(' / ')})`);
    }
  }
  console.log('  difficulty (median wave, ' + D.maps.join('+') + '): ' + dline.join('   '));
  // late-game tower mix of the solid bot
  console.log('\n  solid bot final defense, share of credits invested by tower type (median over seeds):');
  const mix = {};
  for (const m of MAP_ORDER) {
    const rs = pilot.filter((r) => r.bot === 'solid' && !r.hero && r.map === m);
    if (!rs.length) continue;
    const shares = {};
    for (const r of rs) {
      const tot = Object.entries(r.credits).filter(([k]) => k !== 'hero').reduce((a, [, v]) => a + v, 0) || 1;
      for (const [k, v] of Object.entries(r.credits)) if (k !== 'hero') (shares[k] = shares[k] || []).push(v / tot);
    }
    const med2 = Object.fromEntries(Object.entries(shares).map(([k, v]) => [k, median(v.concat(Array(rs.length - v.length).fill(0)))]));
    mix[m] = med2;
    const top = Object.entries(med2).sort((a, b) => b[1] - a[1]);
    console.log('  ' + pad(m, 8) + top.slice(0, 7).map(([k, v]) => `${k} ${(v * 100).toFixed(0)}%`).join('  '));
    if (top[0][1] > 0.5) violate('sweep', `${m}: ${top[0][0]} holds ${(top[0][1] * 100).toFixed(0)}% of the solid bot's credits (dominant tower)`);
  }
  // how runs end
  const causes = {};
  for (const r of pilot.filter((x) => x.bot !== 'novice')) { const c = r.lastLeaks && r.lastLeaks.TITAN ? 'Titan' : 'flood'; causes[c] = (causes[c] || 0) + 1; }
  console.log('  solid/eco runs end by: ' + Object.entries(causes).map(([k, v]) => `${k} ${v}`).join(', '));
  report.sections.sweep = { runs: ok.length, medians: med, maxCleared: maxC, mix, causes };
}

// ============================================================================================
// main
// ============================================================================================
const only = flag('only', 'arbitrage,passive,threat,bench,sweep').split(',');
const quick = has('quick');
const sweepFile = path.resolve(ROOT, flag('sweep-file', 'out/balance/sweep.jsonl'));
const t0 = Date.now();
console.log(`SHARDSTORM balance suite  (start credits ${START_CASH}, target curve eta0 ${ETA0} x [${TIER_EFFICIENCY.join(', ')}] +-${EFFICIENCY_TOLERANCE * 100}%)`);
if (only.includes('arbitrage')) arbitrage(quick);
if (only.includes('passive')) passive();
if (only.includes('threat')) threat();
if (only.includes('bench')) await bench(quick);
if (only.includes('sweep')) {
  if (has('sweep')) await runSweep(sweepFile);
  sweep(sweepFile);
}
header(violations.length ? `FAIL: ${violations.length} violation(s)` : 'PASS: every soundness check holds');
for (const v of violations) console.log('  ' + v);
console.log(`  (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
const jsonOut = flag('json', null);
if (jsonOut) {
  report.violations = violations;
  const p = path.resolve(ROOT, jsonOut);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(report, null, 1));
  console.log('  wrote ' + path.relative(ROOT, p));
}
process.exit(violations.length ? 1 : 0);
