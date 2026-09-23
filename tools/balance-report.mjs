// SHARDSTORM balance report generator: turns real runs into the charts and tables of
// docs/BALANCE.md, so the document is reproducible.
//
//   node tools/balance.mjs --sweep --json out/balance/report.json    (runs the suite and the bot sweep)
//   node tools/balance-report.mjs                                     (writes docs/balance/*.svg and
//                                                                      refreshes the generated tables)
// Options: --report out/balance/report.json  --sweep-file out/balance/sweep.jsonl  --doc docs/BALANCE.md
//          --check (exit 1 if the doc's generated blocks are out of date, write nothing)
//
// Charts (inline SVG, light and dark via prefers-color-scheme, a <title> tooltip on every mark):
//   docs/balance/threat.svg      B(w) vs cumulative pop income vs pop income per wave vs the
//                                maximum passive income per wave, log scale, waves 1..160
//   docs/balance/survival.svg    wave reached per bot per map (every seed, median marked), with
//                                the docs/ECONOMY.md 7 target bands
//   docs/balance/efficiency.svg  bench efficiency / target by highest tier, one panel per tower
// Tables: every `<!-- gen:NAME -->` ... `<!-- /gen:NAME -->` block in docs/BALANCE.md is replaced.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWave } from '../src/sim/wavegen.js';
import { ENEMIES } from '../src/data/enemies.js';
import { TOWERS } from '../src/data/towers/index.js';
import { MAP_ORDER, MAPS } from '../src/data/maps.js';
import {
  budget, incomeFactor, waveBonus, titanHp, spawnDuration, speedRamp, START_CASH, C_START, C_EXP,
  K_SURGE, SURGE_START, TITAN_K, TITAN_EVERY, TITAN_SURGE_EXP, ETA0, TIER_EFFICIENCY, EFFICIENCY_TOLERANCE, GLOBAL_SHIP_FACTOR,
} from '../src/data/economy.js';
import { SCOUT_HULL } from '../src/data/enemies.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const reportFile = path.resolve(ROOT, flag('report', 'out/balance/report.json'));
const sweepFile = path.resolve(ROOT, flag('sweep-file', 'out/balance/sweep.jsonl'));
const docFile = path.resolve(ROOT, flag('doc', 'docs/BALANCE.md'));
const outDir = path.join(ROOT, 'docs/balance');
const CHECK = args.includes('--check');

const report = fs.existsSync(reportFile) ? JSON.parse(fs.readFileSync(reportFile, 'utf8')) : null;
if (!report) console.log(`note: ${path.relative(ROOT, reportFile)} missing; run node tools/balance.mjs --json ${path.relative(ROOT, reportFile)} first (bench and passive sections are skipped)`);
const runs = fs.existsSync(sweepFile) ? fs.readFileSync(sweepFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => !r.error) : [];
if (!runs.length) console.log(`note: no sweep at ${path.relative(ROOT, sweepFile)}; survival chart and tables are skipped`);

// ------------------------------------------------------------------ shared numbers
const median = (a) => { const b = a.slice().sort((x, y) => x - y); return b.length ? b[(b.length - 1) >> 1] : NaN; };
const fmt = (x) => {
  if (!Number.isFinite(x)) return '-';
  const a = Math.abs(x);
  if (a >= 1e13) return x.toExponential(1).replace('e+', 'e');
  if (a >= 1e12) return (x / 1e12).toFixed(1) + 'T';
  if (a >= 1e9) return (x / 1e9).toFixed(1) + 'G';
  if (a >= 1e6) return (x / 1e6).toFixed(1) + 'M';
  if (a >= 1e4) return (x / 1e3).toFixed(0) + 'k';
  if (a >= 1e3) return (x / 1e3).toFixed(1) + 'k';
  if (a >= 10) return x.toFixed(0);
  return x.toFixed(2);
};
const W_MAX = 160;
const econ = [];
let cum = START_CASH;
for (let w = 1; w <= W_MAX; w++) {
  const s = buildWave(w);
  let shells = 0;
  for (const g of s.groups) shells += g.count * ENEMIES[g.type].shells;
  const pop = shells * incomeFactor(w);
  const inc = pop + waveBonus(w);
  cum += inc;
  econ.push({ w, B: budget(w), mass: s.mass, shells, pop, inc, cum, c: incomeFactor(w), H: s.hullMult });
}
const passiveConst = report && report.sections.passive
  ? { rigs: report.sections.passive.fleet.total, supply: report.sections.passive.supply.total, qm: report.sections.passive.supply.quartermaster, perRail: report.sections.passive.supply.perRail, maxRails: report.sections.passive.supply.maxRails, fleet: report.sections.passive.fleet.fleet }
  : null;

// ------------------------------------------------------------------ SVG helpers
// Reference palette (dataviz skill, references/palette.md): categorical slots in fixed order,
// chrome and ink for light and dark surfaces.
const STYLE = `
  .bg{fill:#fcfcfb} .t1{fill:#0b0b0b} .t2{fill:#52514e} .tm{fill:#898781}
  .grid{stroke:#e1e0d9;stroke-width:1} .axis{stroke:#c3c2b7;stroke-width:1}
  .band{fill:#2a78d6;fill-opacity:.08} .band2{fill:#eb6834;fill-opacity:.08} .limit{stroke:#d03b3b;stroke-width:1.5;stroke-dasharray:4 3}
  .s1{stroke:#2a78d6} .s2{stroke:#eb6834} .s3{stroke:#1baf7a} .s4{stroke:#eda100} .s5{stroke:#e87ba4}
  .d1{fill:#2a78d6} .d2{fill:#eb6834} .d3{fill:#1baf7a} .d4{fill:#eda100} .d5{fill:#e87ba4}
  polyline{fill:none} .ring{stroke:#fcfcfb} .bgfill{fill:#fcfcfb} .hit{fill:transparent;stroke:none}
  text{font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
  @media (prefers-color-scheme: dark){
    .bg{fill:#1a1a19} .t1{fill:#ffffff} .t2{fill:#c3c2b7}
    .grid{stroke:#2c2c2a} .axis{stroke:#383835} .ring{stroke:#1a1a19} .bgfill{fill:#1a1a19}
    .s1{stroke:#3987e5} .s2{stroke:#d95926} .s3{stroke:#199e70} .s4{stroke:#c98500} .s5{stroke:#d55181}
    .d1{fill:#3987e5} .d2{fill:#d95926} .d3{fill:#199e70} .d4{fill:#c98500} .d5{fill:#d55181}
  }`;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function svgDoc(w, h, title, desc, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-labelledby="t d">
<title id="t">${esc(title)}</title><desc id="d">${esc(desc)}</desc>
<style>${STYLE}</style>
<rect class="bg" x="0" y="0" width="${w}" height="${h}" rx="8"/>
${body}
</svg>
`;
}
const txt = (x, y, s, cls = 't2', size = 12, anchor = 'start', extra = '') => `<text class="${cls}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-size="${size}" text-anchor="${anchor}"${extra}>${esc(s)}</text>`;
const line = (x1, y1, x2, y2, cls) => `<line class="${cls}" x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"/>`;

// ------------------------------------------------------------------ chart 1: threat vs income
function threatChart() {
  const W = 820, H = 470, L = 64, R = 170, T = 58, Bm = 44;
  const pw = W - L - R, ph = H - T - Bm;
  const series = [
    { key: 'B', name: 'Threat budget B(w)', cls: 's1', get: (e) => e.B },
    { key: 'cum', name: 'Cumulative income', cls: 's2', get: (e) => e.cum },
    { key: 'inc', name: 'Pop income per wave', cls: 's3', get: (e) => e.inc },
  ];
  if (passiveConst) series.push({ key: 'pas', name: 'Max passive per wave', cls: 's4', get: (e) => (passiveConst.rigs + passiveConst.supply) * e.c });
  let lo = Infinity, hi = 0;
  for (const s of series) for (const e of econ) { const v = s.get(e); lo = Math.min(lo, v); hi = Math.max(hi, v); }
  const d0 = Math.floor(Math.log10(lo)), d1 = Math.ceil(Math.log10(hi));
  const X = (w) => L + (w - 1) / (W_MAX - 1) * pw;
  const Y = (v) => T + ph - (Math.log10(v) - d0) / (d1 - d0) * ph;
  let b = '';
  b += txt(L, 24, 'Threat grows past every income source after the surge', 't1', 15, 'start', ' font-weight="600"');
  b += txt(L, 42, 'Credits or mass per wave, log scale. Pop income assumes every shell of the wave is destroyed.', 't2', 12);
  const step = Math.max(1, Math.ceil((d1 - d0) / 8));
  for (let d = d0; d <= d1; d += step) {
    b += line(L, Y(10 ** d), L + pw, Y(10 ** d), 'grid');
    b += txt(L - 8, Y(10 ** d) + 4, d <= 3 ? String(10 ** d) : d <= 5 ? (10 ** (d - 3)) + 'k' : '1e' + d, 'tm', 11, 'end');
  }
  for (let w = 20; w <= W_MAX; w += 20) { b += line(X(w), T, X(w), T + ph, 'grid'); b += txt(X(w), T + ph + 18, String(w), 'tm', 11, 'middle'); }
  b += txt(X(1), T + ph + 18, '1', 'tm', 11, 'middle');
  b += txt(L + pw / 2, H - 8, 'wave', 'tm', 11, 'middle');
  b += line(L, T + ph, L + pw, T + ph, 'axis');
  // surge start and c(w) start markers
  b += `<line class="axis" x1="${X(SURGE_START).toFixed(1)}" y1="${T}" x2="${X(SURGE_START).toFixed(1)}" y2="${T + ph}" stroke-dasharray="3 3"/>` + txt(X(SURGE_START) + 4, T + 12, `surge from ${SURGE_START}`, 'tm', 10);
  b += `<line class="axis" x1="${X(C_START).toFixed(1)}" y1="${T}" x2="${X(C_START).toFixed(1)}" y2="${T + ph}" stroke-dasharray="3 3"/>` + txt(X(C_START) - 4, T + 12, `c(w) falls from ${C_START}`, 'tm', 10, 'end');
  const lastY = [];
  for (const s of series) {
    const pts = econ.map((e) => `${X(e.w).toFixed(1)},${Y(s.get(e)).toFixed(1)}`).join(' ');
    b += `<polyline class="${s.cls}" fill="none" stroke-width="2" stroke-linejoin="round" points="${pts}"/>`;
    // hover targets every 5 waves
    for (const e of econ) if (e.w === 1 || e.w % 5 === 0) b += `<circle class="hit" cx="${X(e.w).toFixed(1)}" cy="${Y(s.get(e)).toFixed(1)}" r="6"><title>${esc(`${s.name}, wave ${e.w}: ${fmt(s.get(e))}`)}</title></circle>`;
    lastY.push({ s, y: Y(s.get(econ[econ.length - 1])) });
  }
  // direct labels at the right edge, nudged apart
  lastY.sort((a, b2) => a.y - b2.y);
  for (let i = 1; i < lastY.length; i++) if (lastY[i].y - lastY[i - 1].y < 15) lastY[i].y = lastY[i - 1].y + 15;
  for (const { s, y } of lastY) {
    b += `<circle class="${s.cls.replace('s', 'd')} ring" cx="${(L + pw).toFixed(1)}" cy="${Y(s.get(econ[econ.length - 1])).toFixed(1)}" r="4" stroke-width="2"/>`;
    b += txt(L + pw + 10, y + 4, s.name, 't2', 12);
  }
  const cross = econ.find((e) => e.w > C_START && e.B > e.cum);
  if (cross) {
    b += `<circle class="d1 ring" cx="${X(cross.w).toFixed(1)}" cy="${Y(cross.B).toFixed(1)}" r="4" stroke-width="2"/>`;
    b += txt(X(cross.w) - 8, Y(cross.B) - 12, `wave ${cross.w}: one wave outweighs all income ever earned`, 't1', 11, 'end');
  }
  return svgDoc(W, H, 'Threat budget versus income, waves 1 to 160',
    `Log-scale line chart. B(w) rises from ${fmt(econ[0].B)} to ${fmt(econ[W_MAX - 1].B)}; cumulative income reaches ${fmt(econ[W_MAX - 1].cum)} by wave ${W_MAX}; maximum passive income falls with c(w) after wave ${C_START}.`, b);
}

// ------------------------------------------------------------------ chart 2: survival
const BOTS = [
  { key: 'novice', name: 'Novice', cls: 's3' },
  { key: 'solid', name: 'Solid', cls: 's1' },
  { key: 'eco', name: 'Eco', cls: 's2' },
  { key: 'hero', name: 'Solid + Commander', cls: 's5' },
];
const botKey = (r) => (r.bot === 'solid' && r.hero ? 'hero' : r.bot);
function survivalChart() {
  const pilot = runs.filter((r) => (r.difficulty || 'pilot') === 'pilot');
  const W = 820, rowH = 64, T = 80, L = 96, R = 24, Bm = 46;
  const H = T + rowH * MAP_ORDER.length + Bm;
  const pw = W - L - R;
  const xMax = 170;
  const X = (w) => L + w / xMax * pw;
  let b = '';
  b += txt(16, 24, 'Wave reached by each bot on each map (Pilot)', 't1', 15, 'start', ' font-weight="600"');
  // legend row
  let lx = 16;
  for (const bt of BOTS) { b += `<circle class="${bt.cls.replace('s', 'd')}" cx="${lx + 5}" cy="44" r="5"/>` + txt(lx + 14, 48, bt.name, 't2', 12); lx += 30 + bt.name.length * 7; }
  b += `<rect class="band" x="${lx + 2}" y="38" width="16" height="12"/>` + txt(lx + 24, 48, 'solid target 70..110', 't2', 12); lx += 150;
  b += `<rect class="band2" x="${lx + 2}" y="38" width="16" height="12"/>` + txt(lx + 24, 48, 'novice target 25..55', 't2', 12); lx += 156;
  b += line(lx + 2, 44, lx + 18, 44, 'limit') + txt(lx + 24, 48, 'ceiling 160', 't2', 12);
  b += `<circle class="s1 bgfill" cx="${21}" cy="62" r="4" stroke-width="1.8"/>` + txt(30, 66, 'hollow dot: the run ended on a Storm Titan leak; tick: median', 't2', 11);
  const y0 = T, y1 = T + rowH * MAP_ORDER.length;
  b += `<rect class="band2" x="${X(25).toFixed(1)}" y="${y0}" width="${(X(55) - X(25)).toFixed(1)}" height="${y1 - y0}"/>`;
  b += `<rect class="band" x="${X(70).toFixed(1)}" y="${y0}" width="${(X(110) - X(70)).toFixed(1)}" height="${y1 - y0}"/>`;
  for (let w = 0; w <= 160; w += 20) { b += line(X(w), y0, X(w), y1, 'grid'); b += txt(X(w), y1 + 18, String(w), 'tm', 11, 'middle'); }
  b += `<line class="limit" x1="${X(160).toFixed(1)}" y1="${y0}" x2="${X(160).toFixed(1)}" y2="${y1}"/>`;
  b += txt(L + pw / 2, H - 10, 'highest wave cleared', 'tm', 11, 'middle');
  MAP_ORDER.forEach((m, i) => {
    const cy = y0 + rowH * i + rowH / 2;
    b += txt(L - 10, cy + 4, MAPS[m].name, 't2', 12, 'end');
    if (i) b += line(L, y0 + rowH * i, L + pw, y0 + rowH * i, 'axis');
    BOTS.forEach((bt, k) => {
      const yy = cy - 18 + k * 12;
      const rs = pilot.filter((r) => r.map === m && botKey(r) === bt.key);
      if (!rs.length) return;
      const med = median(rs.map((r) => r.cleared));
      b += `<line class="${bt.cls}" x1="${X(med).toFixed(1)}" y1="${(yy - 7).toFixed(1)}" x2="${X(med).toFixed(1)}" y2="${(yy + 7).toFixed(1)}" stroke-width="2.5"><title>${esc(`${bt.name} on ${MAPS[m].name}: median wave ${med} over ${rs.length} runs`)}</title></line>`;
      for (const r of rs) {
        const how = r.lastLeaks && r.lastLeaks.TITAN ? 'a Storm Titan leaked' : r.over ? 'Core Integrity ran out' : 'still alive at the cap';
        const titanEnd = !!(r.lastLeaks && r.lastLeaks.TITAN);
        b += `<circle class="${titanEnd ? bt.cls + ' bgfill' : bt.cls.replace('s', 'd') + ' ring'}" cx="${X(r.cleared).toFixed(1)}" cy="${yy.toFixed(1)}" r="4" fill-opacity="0.8" stroke-width="${titanEnd ? 1.8 : 1}"><title>${esc(`${bt.name}${r.hero ? ' + ' + r.hero : ''}, ${MAPS[m].name}, seed ${r.seed}: cleared wave ${r.cleared} (${how})`)}</title></circle>`;
      }
    });
  });
  return svgDoc(W, H, 'Survival waves per bot per map',
    'Strip chart: one row per map, one dot per seeded run, a tick at the median, for the novice, solid, eco and solid-with-Commander bots on Pilot. Shaded bands mark the novice and solid targets; the dashed line is the wave 160 ceiling.', b);
}

// ------------------------------------------------------------------ chart 3: efficiency by tier
function efficiencyChart() {
  const rowsAll = report && report.sections.bench && report.sections.bench.rows;
  if (!rowsAll) return null;
  const types = Object.keys(rowsAll).filter((t) => report.sections.bench.byTower[t].kind === 'damage');
  const cols = 4, pwp = 180, php = 130, gapX = 24, gapY = 52, L = 50, T = 112;
  const W = L + cols * pwp + (cols - 1) * gapX + 20;
  const rowsN = Math.ceil(types.length / cols);
  const H = T + rowsN * (php + gapY) + 10;
  const yMax = 2.0;
  let b = '';
  b += txt(16, 24, 'Bench efficiency divided by its tier target, by highest tier', 't1', 15, 'start', ' font-weight="600"');
  b += txt(16, 42, `Each dot is one default config (graded scenario); the line joins the tier means. Band: target +-${EFFICIENCY_TOLERANCE * 100}%.`, 't2', 12);
  b += txt(16, 58, `Target eta = ${ETA0} x [${TIER_EFFICIENCY.join(', ')}] mass per second per 1000 credits, so a flat line at 1.0`, 't2', 12);
  b += txt(16, 74, 'means efficiency rises with tier exactly as designed.', 't2', 12);
  types.forEach((type, i) => {
    const ox = L + (i % cols) * (pwp + gapX), oy = T + Math.floor(i / cols) * (php + gapY);
    const X = (t) => ox + 10 + t / 5 * (pwp - 20);
    const Y = (r) => oy + php - Math.min(r, yMax) / yMax * php;
    b += txt(ox, oy - 8, TOWERS[type].name, 't1', 12, 'start', ' font-weight="600"');
    b += `<rect class="band" x="${ox}" y="${Y(1 + EFFICIENCY_TOLERANCE).toFixed(1)}" width="${pwp}" height="${(Y(1 - EFFICIENCY_TOLERANCE) - Y(1 + EFFICIENCY_TOLERANCE)).toFixed(1)}"/>`;
    for (const r of [0, 0.5, 1, 1.5, 2]) { b += line(ox, Y(r), ox + pwp, Y(r), r === 1 ? 'axis' : 'grid'); if (i % cols === 0) b += txt(ox - 6, Y(r) + 4, r.toFixed(1), 'tm', 10, 'end'); }
    for (let t = 0; t <= 5; t++) b += txt(X(t), oy + php + 14, 'T' + t, 'tm', 10, 'middle');
    const rows = rowsAll[type];
    const means = [];
    for (let t = 0; t <= 5; t++) {
      const s = rows.filter((r) => r.highestTier === t && r.bestEta !== null);
      if (s.length) means.push([t, s.reduce((a, r) => a + r.bestEta / r.target, 0) / s.length]);
    }
    b += `<polyline class="s1" fill="none" stroke-width="2" points="${means.map(([t, m]) => `${X(t).toFixed(1)},${Y(m).toFixed(1)}`).join(' ')}"/>`;
    rows.forEach((r, k) => {
      if (r.bestEta === null) return;
      const ratio = r.bestEta / r.target;
      const jx = ((k * 37) % 9 - 4) * 1.6;
      b += `<circle class="d1 ring" cx="${(X(r.highestTier) + jx).toFixed(1)}" cy="${Y(ratio).toFixed(1)}" r="3.5" fill-opacity="0.55" stroke-width="1"><title>${esc(`${TOWERS[type].name} ${r.levels.join('-')}: eta ${r.bestEta.toFixed(1)} vs ${r.target.toFixed(1)} on ${r.gradedOn} (${r.status})`)}</title></circle>`;
    });
  });
  return svgDoc(W, H, 'Bench efficiency by tier per tower',
    'Small multiples, one per damage tower: efficiency divided by the tier target for every default bench config, grouped by highest tier, with the mean per tier joined by a line and the tolerance band shaded.', b);
}

// ------------------------------------------------------------------ tables
const T = {};
T.constants = () => [
  '| Constant | Value | Where |',
  '|---|---|---|',
  `| Starting credits | ${START_CASH} | ECONOMY 1.4 |`,
  `| c(w) | 1 up to wave ${C_START}, then (${C_START}/w)^${C_EXP} | ECONOMY 1.1 |`,
  `| Wave bonus | ${waveBonus(0)} + w | ECONOMY 1.2 |`,
  `| Surge | exp(${K_SURGE} x max(0, w - ${SURGE_START})^2) | ECONOMY 4.1 |`,
  `| Titan hull | ${TITAN_K} x sqrt(tier) x B(w) / S(w)^${(1 - TITAN_SURGE_EXP).toFixed(1)}, w = ${TITAN_EVERY} x tier | ECONOMY 4.6 |`,
  `| Global-range SHIP grading | ${GLOBAL_SHIP_FACTOR} x target | ECONOMY 3.2 |`,
  `| Specter scout hull | ${SCOUT_HULL} x hull, empty hold | ECONOMY 4.8 |`,
].join('\n');
T.economy = () => {
  const out = ['| Wave | B(w) | Wave mass | Shells | c(w) | Pop + bonus | Cumulative income | B / cumulative | H | Titan |', '|---|---|---|---|---|---|---|---|---|---|'];
  for (const w of [1, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160]) {
    const e = econ[w - 1];
    out.push(`| ${w} | ${fmt(e.B)} | ${fmt(e.mass)} | ${fmt(e.shells)} | ${e.c.toFixed(3)} | ${fmt(e.inc)} | ${fmt(e.cum)} | ${e.B / e.cum < 10 ? (e.B / e.cum).toFixed(3) : fmt(e.B / e.cum)} | ${e.H < 10 ? e.H.toFixed(2) : fmt(e.H)} | ${w % TITAN_EVERY === 0 ? fmt(titanHp(w / TITAN_EVERY)) : ''} |`);
  }
  return out.join('\n');
};
T.passive = () => {
  if (!passiveConst) return '_(run node tools/balance.mjs --json out/balance/report.json)_';
  const p = report.sections.passive;
  const out = [
    `Best legal 10-Rig fleet (each tier 5 at most once): ${passiveConst.fleet.join(', ')}, paying ${fmt(passiveConst.rigs)} per wave at c = 1 (ore, full vaults and Trade Hub).`,
    `Supply drops: ${passiveConst.perRail} per Supply Drop Rail, ${passiveConst.qm} for the one Quartermaster; at most ${passiveConst.maxRails} Rails fit on any map, so every drop the game could ever pay is at most ${fmt(passiveConst.supply)} per wave at c = 1.`,
    '',
    '| Wave | c(w) | Pop + bonus | 10 Rigs (engine) | Supply bound | Passive / pop |',
    '|---|---|---|---|---|---|',
  ];
  for (const r of p.rows) if (r.w === 1 || r.w % 20 === 0) out.push(`| ${r.w} | ${incomeFactor(r.w).toFixed(3)} | ${fmt(r.pop)} | ${fmt(r.rigs)} | ${fmt(r.supply)} | ${((r.rigs + r.supply) / r.pop).toFixed(2)} |`);
  return out.join('\n');
};
T.bench = () => {
  const bt = report && report.sections.bench && report.sections.bench.byTower;
  if (!bt) return '_(run node tools/balance.mjs --json out/balance/report.json)_';
  const out = ['| Tower | Kind | Pass | T0 | T1 | T2 | T3 | T4 | T5 | Mean eta by tier |', '|---|---|---|---|---|---|---|---|---|---|'];
  for (const [type, b] of Object.entries(bt)) {
    const tiers = b.tiers ? b.tiers.map((t) => `${t[0]}/${t[1]}`) : ['', '', '', '', '', ''];
    const eff = b.meanEta ? b.meanEta.map((x) => (x === null ? '-' : x.toFixed(1))).join(', ') : '';
    out.push(`| ${TOWERS[type].name} | ${b.kind} | ${b.pass}/${b.n} | ${tiers.join(' | ')} | ${eff} |`);
  }
  out.push('', `Targets by tier: ${TIER_EFFICIENCY.map((m) => (ETA0 * m).toFixed(1)).join(', ')} (+-${EFFICIENCY_TOLERANCE * 100}%). Utility, support and income rows count configs that meet their own contract (section 4 of docs/BENCH.md).`);
  return out.join('\n');
};
const cell = (rs) => (rs.length ? `${median(rs.map((r) => r.cleared))} (${rs.map((r) => r.cleared).sort((a, b) => a - b).join(', ')})` : '-');
T.survival = () => {
  if (!runs.length) return '_(run node tools/balance.mjs --sweep)_';
  const pilot = runs.filter((r) => (r.difficulty || 'pilot') === 'pilot');
  const keys = [...new Set(pilot.map((r) => r.bot + (r.hero ? '+' + r.hero : '')))].sort((a, b) => ['novice', 'solid', 'eco'].indexOf(a.split('+')[0]) - ['novice', 'solid', 'eco'].indexOf(b.split('+')[0]) || a.localeCompare(b));
  const out = ['| Bot | ' + MAP_ORDER.map((m) => MAPS[m].name).join(' | ') + ' | All |', '|---|' + MAP_ORDER.map(() => '---').join('|') + '|---|'];
  for (const k of keys) {
    const sel = pilot.filter((r) => r.bot + (r.hero ? '+' + r.hero : '') === k);
    out.push(`| ${k} | ` + MAP_ORDER.map((m) => cell(sel.filter((r) => r.map === m))).join(' | ') + ` | ${median(sel.map((r) => r.cleared))} |`);
  }
  const maxC = Math.max(...runs.map((r) => r.cleared));
  const titan = pilot.filter((r) => r.bot !== 'novice' && r.lastLeaks && r.lastLeaks.TITAN).length;
  const strong = pilot.filter((r) => r.bot !== 'novice').length;
  out.push('', `Median wave cleared (every seed in brackets). ${runs.length} runs; the furthest cleared wave ${maxC}; ${titan} of ${strong} solid and eco runs ended on a Storm Titan leak, the rest on Core Integrity.`);
  return out.join('\n');
};
T.difficulty = () => {
  const ds = ['cadet', 'pilot', 'veteran', 'nightmare'];
  const other = runs.filter((r) => r.difficulty && r.difficulty !== 'pilot');
  if (!other.length) return '_(no difficulty runs in the sweep)_';
  const maps = [...new Set(other.map((r) => r.map))], seeds = [...new Set(other.map((r) => r.seed))];
  const out = ['| Bot | ' + ds.map((d) => d[0].toUpperCase() + d.slice(1)).join(' | ') + ' |', '|---|---|---|---|---|'];
  for (const b of [...new Set(other.map((r) => r.bot))]) {
    out.push(`| ${b} | ` + ds.map((d) => cell(runs.filter((r) => r.bot === b && !r.hero && (r.difficulty || 'pilot') === d && maps.includes(r.map) && seeds.includes(r.seed)))).join(' | ') + ' |');
  }
  out.push('', `Pooled over ${maps.map((m) => MAPS[m].name).join(' and ')}, seeds ${seeds.join(', ')}.`);
  return out.join('\n');
};
T.mix = () => {
  const pilot = runs.filter((r) => (r.difficulty || 'pilot') === 'pilot' && r.bot === 'solid' && !r.hero);
  if (!pilot.length) return '_(run node tools/balance.mjs --sweep)_';
  const out = ['| Map | Towers at the end (median) | Share of credits invested, by tower (median over seeds) |', '|---|---|---|'];
  for (const m of MAP_ORDER) {
    const rs = pilot.filter((r) => r.map === m);
    if (!rs.length) continue;
    const shares = {};
    for (const r of rs) {
      const tot = Object.entries(r.credits).filter(([k]) => k !== 'hero').reduce((a, [, v]) => a + v, 0) || 1;
      for (const k of Object.keys(TOWERS)) (shares[k] = shares[k] || []).push((r.credits[k] || 0) / tot);
    }
    const top = Object.entries(shares).map(([k, v]) => [k, median(v)]).filter(([, v]) => v > 0.005).sort((a, b) => b[1] - a[1]);
    out.push(`| ${MAPS[m].name} | ${median(rs.map((r) => r.towers))} | ${top.map(([k, v]) => `${TOWERS[k].name} ${(v * 100).toFixed(0)}%`).join(', ')} |`);
  }
  return out.join('\n');
};
T.checks = () => {
  if (!report) return '_(run node tools/balance.mjs --json out/balance/report.json)_';
  const a = report.sections.arbitrage, th = report.sections.threat;
  const out = ['| Check | Result |', '|---|---|'];
  if (a) out.push(`| No arbitrage (random play) | ${a.trials} runs, ${a.commands} commands, ${a.steps} ticks, ${a.abilities} ability uses; worst rise of credits + assets above income ${Number(a.worst).toExponential(1)} |`);
  if (th) out.push(`| Threat bands | authored waves within ${(th.authoredMax * 100).toFixed(1)}% of B(w), procedural within ${(th.procMax * 100).toFixed(2)}% |`);
  out.push(`| Violations | ${report.violations && report.violations.length ? report.violations.map(esc).join('; ') : 'none'} |`);
  return out.join('\n');
};

// ------------------------------------------------------------------ write
const files = [['threat.svg', threatChart()]];
if (runs.length) files.push(['survival.svg', survivalChart()]);
const eff = efficiencyChart();
if (eff) files.push(['efficiency.svg', eff]);
let stale = 0;
if (!CHECK) fs.mkdirSync(outDir, { recursive: true });
for (const [n, svg] of files) {
  const p = path.join(outDir, n);
  const old = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
  if (old !== svg) { stale++; if (!CHECK) { fs.writeFileSync(p, svg); console.log('wrote docs/balance/' + n); } else console.log('stale docs/balance/' + n); }
}
if (fs.existsSync(docFile)) {
  let doc = fs.readFileSync(docFile, 'utf8');
  const next = doc.replace(/<!-- gen:(\w+) -->[\s\S]*?<!-- \/gen:\1 -->/g, (m, name) => (T[name] ? `<!-- gen:${name} -->\n${T[name]()}\n<!-- /gen:${name} -->` : m));
  if (next !== doc) { stale++; if (!CHECK) { fs.writeFileSync(docFile, next); console.log('refreshed generated tables in ' + path.relative(ROOT, docFile)); } else console.log('stale tables in ' + path.relative(ROOT, docFile)); }
}
if (CHECK) process.exit(stale ? 1 : 0);
