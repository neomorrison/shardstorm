// Wave generator check: prints a table of wave specs and asserts the wave contract.
//
// Usage:
//   node tools/wavecheck.mjs                 table for waves 1..200 plus all assertions
//   node tools/wavecheck.mjs --to 120        table up to wave 120 (assertions still cover 1..200)
//   node tools/wavecheck.mjs --quiet         assertions and summary only
//   node tools/wavecheck.mjs --wave 57       dump the full spec (groups) of one wave
//   node tools/wavecheck.mjs --preview 57    dump previewWave(57)
//
// Asserts (docs/ECONOMY.md 4, docs/ARCHITECTURE.md 7):
//   authored waves within +-20% of budget(w), procedural within +-5%
//   top-level spawns <= MAX_SPAWNS_PER_WAVE, hull multiplier H >= 1, and H > 1 only when the cap binds
//   budget strictly increasing, no NaN or Infinity anywhere in a spec
//   deterministic: identical output from a second module instance built in reverse order
//   unlock schedule respected; authored waves debut each enemy and modifier on its unlock wave
//   titans exactly on every TITAN_EVERY-th wave with the right kind, tier and hp
//   group sanity (types, counts, times, lanes), procedural duration = spawnDuration(w)
//   both lanes of a two-lane map get real pressure
//   speed: building one spec at w = 200 takes < 2 ms
import { performance } from 'node:perf_hooks';
import * as WG from '../src/sim/wavegen.js';
import { budget, spawnDuration, speedRamp, MAX_SPAWNS_PER_WAVE, TITAN_EVERY, titanHp } from '../src/data/economy.js';
import { ENEMIES, familyMass } from '../src/data/enemies.js';
import { UNLOCK, MOD_UNLOCK } from '../src/data/waves.js';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const has = (n) => args.includes('--' + n);
const LAST = 200;

if (flag('wave')) {
  const s = WG.buildWave(Number(flag('wave')), { lanes: Number(flag('lanes', 2)) });
  console.log(JSON.stringify(s, null, 1));
  process.exit(0);
}
if (flag('preview')) {
  console.log(WG.previewWave(Number(flag('preview'))));
  process.exit(0);
}

const fails = [];
const fail = (w, msg) => { fails.push(`w${w}: ${msg}`); };
const fin = (x) => typeof x === 'number' && Number.isFinite(x);

// ---- build everything
const specs1 = [], specs2 = [];
for (let w = 1; w <= LAST; w++) {
  specs1[w] = WG.buildWave(w, { lanes: 1 });
  specs2[w] = WG.buildWave(w, { lanes: 2 });
}

// ---- table
const fmt = (x) => {
  if (x >= 1e9) return (x / 1e9).toFixed(2) + 'G';
  if (x >= 1e6) return (x / 1e6).toFixed(2) + 'M';
  if (x >= 1e4) return (x / 1e3).toFixed(1) + 'k';
  return String(Math.round(x));
};
const pad = (s, n) => String(s).padStart(n);
const padR = (s, n) => String(s).padEnd(n);

function laneShares(spec) {
  const lm = [0, 0];
  for (const g of spec.groups) {
    const u = familyMass(g.type, spec.hullMult, g.mods.plated, !!g.mods.scout);
    if (g.lane === -1) { lm[0] += Math.ceil(g.count / 2) * u; lm[1] += Math.floor(g.count / 2) * u; }
    else lm[g.lane] += g.count * u;
  }
  const t = lm[0] + lm[1] || 1;
  return [lm[0] / t, lm[1] / t];
}
function topTypes(spec) {
  const m = new Map();
  for (const g of spec.groups) m.set(g.type, (m.get(g.type) || 0) + g.count * familyMass(g.type, spec.hullMult, g.mods.plated, !!g.mods.scout));
  return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([t, v]) => `${t}${Math.round((100 * v) / spec.mass)}%`).join(' ');
}

if (!has('quiet')) {
  const to = Math.min(LAST, Number(flag('to', LAST)));
  console.log(
    padR('w', 4) + padR('name', 20) + pad('budget', 9) + pad('mass', 9) + pad('ratio', 7) + pad('spawn', 6) + pad('grp', 4) +
    pad('H', 9) + pad('dur', 6) + pad('D(w)', 6) + pad('spd', 5) + '  ' + padR('titan', 20) + padR('lanes', 8) + 'mass by type'
  );
  for (let w = 1; w <= to; w++) {
    const s = specs2[w];
    const spawns = s.groups.reduce((a, g) => a + g.count, 0);
    const ls = laneShares(s);
    const titan = s.titan ? `${s.titan.kind} t${s.titan.tier} ${fmt(s.titan.hp)}@${s.titan.start}s` : '';
    console.log(
      padR(w, 4) + padR((s.name || '').slice(0, 19), 20) + pad(fmt(s.budget), 9) + pad(fmt(s.mass), 9) +
      pad((s.mass / s.budget).toFixed(3), 7) + pad(spawns, 6) + pad(s.groups.length, 4) +
      pad(s.hullMult < 1000 ? s.hullMult.toFixed(2) : fmt(s.hullMult), 9) + pad(s.duration.toFixed(1), 6) +
      pad(spawnDuration(w).toFixed(1), 6) + pad(s.speedMult.toFixed(2), 5) + '  ' + padR(titan, 20) +
      padR(`${Math.round(ls[0] * 100)}/${Math.round(ls[1] * 100)}`, 8) + topTypes(s)
    );
  }
}

// ---- per-wave assertions
const firstSeen = {};
const firstMod = {};
for (let w = 1; w <= LAST; w++) {
  const s = specs2[w], s1 = specs1[w];
  const B = budget(w);
  const tol = w <= WG.AUTHORED_COUNT ? WG.AUTHORED_TOLERANCE : WG.PROC_TOLERANCE;

  // numbers
  for (const k of ['budget', 'mass', 'duration', 'hullMult', 'speedMult']) if (!fin(s[k])) fail(w, `${k} not finite (${s[k]})`);
  if (Math.abs(s.budget - B) > 1e-9 * B) fail(w, 'spec.budget != budget(w)');
  const ratio = s.mass / B;
  if (!(Math.abs(ratio - 1) <= tol + 1e-12)) fail(w, `mass ratio ${ratio.toFixed(3)} outside +-${tol * 100}%`);
  const wm = WG.waveMass(s);
  if (Math.abs(wm - s.mass) > 1e-9 * s.mass) fail(w, `waveMass ${wm} != spec.mass ${s.mass}`);
  if (s.hullMult < 1) fail(w, `hullMult ${s.hullMult} < 1`);
  if (Math.abs(s.speedMult - speedRamp(w)) > 1e-12) fail(w, 'speedMult != speedRamp(w)');
  if (s.wave !== w) fail(w, 'spec.wave mismatch');

  // spawns and groups
  const spawns = s.groups.reduce((a, g) => a + g.count, 0);
  if (spawns > MAX_SPAWNS_PER_WAVE) fail(w, `${spawns} spawns > cap`);
  if (s.hullMult > 1 + 1e-9 && spawns !== MAX_SPAWNS_PER_WAVE) fail(w, `H = ${s.hullMult} while spawns ${spawns} < cap`);
  if (!s.groups.length) fail(w, 'no groups');
  let lastSpawn = 0;
  s.groups.forEach((g, i) => {
    const d = ENEMIES[g.type];
    if (!d) { fail(w, `group ${i}: unknown type ${g.type}`); return; }
    if (!Number.isInteger(g.count) || g.count < 1) fail(w, `group ${i}: bad count ${g.count}`);
    if (!fin(g.start) || g.start < 0) fail(w, `group ${i}: bad start ${g.start}`);
    if (!fin(g.spacing) || g.spacing < 0) fail(w, `group ${i}: bad spacing ${g.spacing}`);
    if (g.count > 1 && g.spacing < 0.05 - 1e-9) fail(w, `group ${i}: spacing ${g.spacing} below 3 ticks`);
    if (![-1, 0, 1].includes(g.lane)) fail(w, `group ${i}: bad lane ${g.lane} (lanes=2)`);
    if (s1.groups[i].lane !== 0) fail(w, `group ${i}: lanes=1 spec has lane ${s1.groups[i].lane}`);
    for (const m of ['phantom', 'nanite', 'plated']) if (typeof g.mods[m] !== 'boolean') fail(w, `group ${i}: mods.${m} not boolean`);
    if (d.kind === 'ship' && (g.mods.phantom || g.mods.nanite)) fail(w, `group ${i}: ship with phantom/nanite mod`);
    lastSpawn = Math.max(lastSpawn, g.start + (g.count - 1) * g.spacing);
    // unlocks
    if (!(w >= UNLOCK[g.type])) fail(w, `${g.type} before its unlock wave ${UNLOCK[g.type]}`);
    for (const m of ['phantom', 'nanite', 'plated']) {
      if (g.mods[m] && w < MOD_UNLOCK[m]) fail(w, `${m} before its unlock wave ${MOD_UNLOCK[m]}`);
      if (g.mods[m] && firstMod[m] === undefined) firstMod[m] = w;
    }
    if (firstSeen[g.type] === undefined) firstSeen[g.type] = w;
  });
  if (lastSpawn > s.duration + 1e-6) fail(w, `last spawn ${lastSpawn} after duration ${s.duration}`);
  if (w > WG.AUTHORED_COUNT) {
    if (Math.abs(s.duration - spawnDuration(w)) > 1e-9) fail(w, `duration ${s.duration} != D(w) ${spawnDuration(w)}`);
    if (lastSpawn < s.duration - 0.05) fail(w, `last spawn ${lastSpawn} well before D(w)`);
  } else if (Math.abs(s.duration - lastSpawn) > 1e-6) fail(w, 'authored duration != last spawn time');

  // lanes=1 and lanes=2 must describe the same wave
  const strip = (x) => JSON.stringify({ ...x, groups: x.groups.map((g) => ({ ...g, lane: 0 })) });
  if (strip(s) !== strip(s1)) fail(w, 'lanes option changed wave content');

  // two-lane pressure (a single hull that outweighs the rest of the wave cannot be split)
  const ls = laneShares(s);
  const biggest = Math.max(...s.groups.map((g) => familyMass(g.type, s.hullMult, g.mods.plated, !!g.mods.scout))) / s.mass;
  if (Math.min(ls[0], ls[1]) < 0.25 && biggest < 0.5) fail(w, `lane split ${ls.map((x) => x.toFixed(2)).join('/')} leaves a lane idle`);
  if (Math.min(ls[0], ls[1]) < 0.9 * (1 - biggest) * 0.5 && biggest >= 0.5) fail(w, `lane split ${ls.map((x) => x.toFixed(2)).join('/')} does not offset the big hull`);

  // titans
  const tw = w % TITAN_EVERY === 0;
  if (tw !== !!s.titan) fail(w, tw ? 'missing titan' : 'unexpected titan');
  if (s.titan) {
    const tier = w / TITAN_EVERY;
    const kind = ['maw', 'aegis', 'rift'][(tier - 1) % 3];
    if (s.titan.tier !== tier) fail(w, 'titan tier');
    if (s.titan.kind !== kind) fail(w, `titan kind ${s.titan.kind} != ${kind}`);
    const hp = Math.min(1e300, titanHp(tier));
    if (!fin(s.titan.hp) || Math.abs(s.titan.hp - hp) > 1e-9 * hp) fail(w, `titan hp ${s.titan.hp} != ${hp}`);
    if (!fin(s.titan.start) || s.titan.start <= 0 || s.titan.start > s.duration) fail(w, `titan start ${s.titan.start}`);
  }

  // preview totals match
  const pv = WG.previewWave(w, { lanes: 2 });
  const pvCount = pv.reduce((a, e) => a + e.count, 0);
  if (pvCount !== spawns) fail(w, `preview count ${pvCount} != spawns ${spawns}`);
  const keys = new Set(pv.map((e) => e.type + JSON.stringify(e.mods)));
  if (keys.size !== pv.length) fail(w, 'preview has duplicate type+mods entries');
}

// ---- copy: user-facing strings (banner names and tips) never use em or en dashes
const warns = [];
for (let w = 1; w <= LAST; w++) {
  const s = specs2[w];
  for (const [k, v] of [['name', s.name], ['tip', s.tip]]) {
    if (v != null && typeof v !== 'string') fail(w, `${k} is not a string`);
    if (typeof v === 'string' && /[\u2013\u2014]/.test(v)) fail(w, `${k} contains a long dash: ${v}`);
  }
  if (typeof s.name !== 'string' || !s.name.length) fail(w, 'missing name');
  if (w <= WG.AUTHORED_COUNT) {
    const r = s.duration / spawnDuration(w);
    if (r < 0.7 || r > 1.3) warns.push(`w${w}: authored duration ${s.duration.toFixed(1)}s vs D(w) ${spawnDuration(w).toFixed(1)}s`);
  }
}

// ---- purity: the sim and data modules never touch the browser, clocks or Math.random
{
  const fs = await import('node:fs');
  const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').replace(/'(?:[^'\\\n]|\\.)*'/g, "''");
  for (const f of ['src/sim/wavegen.js', 'src/data/waves.js']) {
    const src = strip(fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8'));
    for (const bad of ['window', 'document', 'Math.random', 'Date', 'performance', 'localStorage', 'globalThis']) {
      if (new RegExp('\\b' + bad.replace('.', '\\.') + '\\b').test(src)) fails.push(`purity: ${f} references ${bad}`);
    }
  }
}

// ---- schedule debuts
for (const [t, u] of Object.entries(UNLOCK)) {
  if (firstSeen[t] !== u) fails.push(`schedule: ${t} first appears at wave ${firstSeen[t]}, expected ${u}`);
}
for (const [m, u] of Object.entries(MOD_UNLOCK)) {
  if (firstMod[m] !== u) fails.push(`schedule: ${m} first appears at wave ${firstMod[m]}, expected ${u}`);
}

// ---- monotone budget
for (let w = 1; w < 400; w++) if (!(budget(w + 1) > budget(w))) fails.push(`budget not increasing at w${w}`);

// ---- determinism: second module instance, built in reverse order, cache cleared
const WG2 = await import('../src/sim/wavegen.js?instance=2');
let detOk = true;
for (let w = LAST; w >= 1; w--) {
  const a = JSON.stringify(WG2.buildWave(w, { lanes: 2 }));
  if (a !== JSON.stringify(specs2[w])) { fails.push(`w${w}: not deterministic across module instances`); detOk = false; }
}
WG.clearWaveCache();
for (let w = 1; w <= LAST; w++) {
  if (JSON.stringify(WG.buildWave(w, { lanes: 2 })) !== JSON.stringify(specs2[w])) { fails.push(`w${w}: changed after cache clear`); detOk = false; }
}
// returned specs are independent copies
const m1 = WG.buildWave(77, { lanes: 2 });
m1.groups[0].count = 9999; m1.groups[0].mods.phantom = 'x';
if (WG.buildWave(77, { lanes: 2 }).groups[0].count === 9999) fails.push('buildWave returns shared objects');

// ---- far range: no NaN, still within tolerance
for (let w = LAST + 1; w <= 600; w += 7) {
  const s = WG.buildWave(w, { lanes: 2 });
  const vals = [s.mass, s.budget, s.hullMult, s.duration, s.speedMult, ...(s.titan ? [s.titan.hp] : [])];
  if (vals.some((v) => !fin(v))) fails.push(`w${w}: non-finite value in far range`);
  else if (Math.abs(s.mass / s.budget - 1) > WG.PROC_TOLERANCE) fails.push(`w${w}: far-range ratio ${(s.mass / s.budget).toFixed(3)}`);
}

// ---- speed
WG.clearWaveCache();
let t0 = performance.now();
const N = 200;
for (let i = 0; i < N; i++) { WG.clearWaveCache(); WG.buildWave(200, { lanes: 2 }); }
const per200 = (performance.now() - t0) / N;
WG.clearWaveCache();
t0 = performance.now();
for (let w = 1; w <= LAST; w++) WG.buildWave(w, { lanes: 2 });
const all = performance.now() - t0;
if (per200 >= 2) fails.push(`buildWave(200) takes ${per200.toFixed(3)} ms (limit 2 ms)`);

// ---- summary
const themes = {};
for (let w = WG.AUTHORED_COUNT + 1; w <= LAST; w++) themes[specs2[w].theme] = (themes[specs2[w].theme] || 0) + 1;
const firstH = specs2.findIndex((s, w) => w > 0 && s && s.hullMult > 1);
let worstA = 0, worstP = 0;
for (let w = 1; w <= LAST; w++) {
  const d = Math.abs(specs2[w].mass / specs2[w].budget - 1);
  if (w <= WG.AUTHORED_COUNT) worstA = Math.max(worstA, d); else worstP = Math.max(worstP, d);
}
console.log('');
console.log(`themes 41..${LAST}: ` + Object.entries(themes).map(([k, v]) => `${k} ${v}`).join(', '));
console.log(`first wave with H > 1: ${firstH > 0 ? firstH : 'none'}; H at ${LAST}: ${fmt(specs2[LAST].hullMult)}`);
console.log(`worst deviation: authored ${(worstA * 100).toFixed(1)}%, procedural ${(worstP * 100).toFixed(2)}%`);
console.log(`speed: buildWave(200) uncached ${per200.toFixed(3)} ms; waves 1..${LAST} ${all.toFixed(1)} ms; deterministic ${detOk}`);
for (const w of warns) console.log('warning: ' + w);
if (fails.length) {
  console.log(`\nFAIL (${fails.length})`);
  for (const f of fails.slice(0, 60)) console.log('  ' + f);
  if (fails.length > 60) console.log(`  ... ${fails.length - 60} more`);
  process.exit(1);
}
console.log('\nPASS: all wave checks');
