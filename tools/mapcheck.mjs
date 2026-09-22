// Map validator + SVG preview generator (owned by the Maps agent, docs/DESIGN.md section 7).
//
// Smoothing: if src/sim/path.js exists and exports a `Path` class, this script imports and
// uses it (so the check matches the real engine exactly). Otherwise it falls back to its own
// centripetal Catmull-Rom (alpha = 0.5) sampled every 2 world units by arc length, which is the
// algorithm the sim's Path class should implement (endpoint tangents via reflection, not
// duplication, so the first/last segments do not degenerate). Whoever writes src/sim/path.js
// should match this so map lengths do not shift between this tool and the live game.
//
// Usage: node tools/mapcheck.mjs [mapId ...]   (default: all maps in MAP_ORDER)
//   Prints a pass/fail report for every constraint in docs/DESIGN.md's MAPS task, and writes
//   an SVG preview per map to out/maps/<id>.svg.
//
// Render a preview to PNG for visual review with:
//   node tools/snap.mjs --path "/out/maps/<id>.svg" --wait 300 --shot out/maps/<id>.png

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAPS, MAP_ORDER } from '../src/data/maps.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// If the engine's own Path class exists, use it so this check matches the live game exactly.
let EnginePath = null;
try {
  const enginePathUrl = new URL('../src/sim/path.js', import.meta.url);
  if (fs.existsSync(fileURLToPath(enginePathUrl))) {
    const mod = await import(enginePathUrl);
    if (mod && typeof mod.Path === 'function') EnginePath = mod.Path;
  }
} catch (e) {
  console.error('note: src/sim/path.js exists but failed to import, using the built-in smoother:', e.message);
}

// ---------- geometry: centripetal Catmull-Rom, sampled by arc length ----------

const ALPHA = 0.5;
const SEG_SAMPLES = 28;   // dense samples per control-point segment before arc-length resample
const STEP = 2;           // world units between resampled points (matches ARCHITECTURE.md 2-unit path cache)

function dist(a, b) { return Math.hypot(b[0] - a[0], b[1] - a[1]); }
function lerp2(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]; }

function extendEndpoints(points) {
  const n = points.length;
  const p0 = points[0], p1 = points[1];
  const pre = [p0[0] - (p1[0] - p0[0]), p0[1] - (p1[1] - p0[1])];
  const pn = points[n - 1], pn1 = points[n - 2];
  const post = [pn[0] + (pn[0] - pn1[0]), pn[1] + (pn[1] - pn1[1])];
  return [pre, ...points, post];
}

function catmullSegment(p0, p1, p2, p3, samples) {
  const t0 = 0;
  const t1 = t0 + Math.pow(Math.max(dist(p0, p1), 1e-6), ALPHA);
  const t2 = t1 + Math.pow(Math.max(dist(p1, p2), 1e-6), ALPHA);
  const t3 = t2 + Math.pow(Math.max(dist(p2, p3), 1e-6), ALPHA);
  const out = [];
  for (let i = 0; i < samples; i++) {
    const t = t1 + (t2 - t1) * (i / samples);
    const A1 = lerp2(p0, p1, (t - t0) / (t1 - t0));
    const A2 = lerp2(p1, p2, (t - t1) / (t2 - t1));
    const A3 = lerp2(p2, p3, (t - t2) / (t3 - t2));
    const B1 = lerp2(A1, A2, (t - t0) / (t2 - t0));
    const B2 = lerp2(A2, A3, (t - t1) / (t3 - t1));
    out.push(lerp2(B1, B2, (t - t1) / (t2 - t1)));
  }
  return out;
}

// Dense smoothed polyline through all control points.
function smoothDense(points) {
  const ext = extendEndpoints(points);
  const n = points.length;
  const dense = [];
  for (let k = 0; k < n - 1; k++) {
    dense.push(...catmullSegment(ext[k], ext[k + 1], ext[k + 2], ext[k + 3], SEG_SAMPLES));
  }
  dense.push(points[n - 1]);
  return dense;
}

// Resample a dense polyline to even arc-length spacing. Returns { points, cum, length }.
function resampleByArcLength(dense, step = STEP) {
  const cumRaw = [0];
  for (let i = 1; i < dense.length; i++) cumRaw.push(cumRaw[i - 1] + dist(dense[i - 1], dense[i]));
  const total = cumRaw[cumRaw.length - 1];
  const points = [];
  const cum = [];
  let seg = 0;
  for (let d = 0; d <= total; d += step) {
    while (seg < cumRaw.length - 2 && cumRaw[seg + 1] < d) seg++;
    const segLen = cumRaw[seg + 1] - cumRaw[seg];
    const t = segLen > 1e-9 ? (d - cumRaw[seg]) / segLen : 0;
    points.push(lerp2(dense[seg], dense[seg + 1], t));
    cum.push(d);
  }
  if (cum[cum.length - 1] < total - 1e-6) { points.push(dense[dense.length - 1]); cum.push(total); }
  return { points, cum, length: total };
}

// Adapt src/sim/path.js's Path class (constructor(points), .length, .pointAt(d) -> {x,y,angle})
// to this tool's { points, cum, length } shape. Falls back to the built-in smoother if the
// class does not exist yet or its interface does not match what ARCHITECTURE.md describes.
function smoothPathViaEngine(controlPoints) {
  const p = new EnginePath(controlPoints);
  if (typeof p.length !== 'number' || typeof p.pointAt !== 'function') return null;
  const total = p.length;
  const points = [], cum = [];
  for (let d = 0; d <= total; d += STEP) {
    const pt = p.pointAt(d);
    points.push([pt.x, pt.y]);
    cum.push(d);
  }
  if (cum[cum.length - 1] < total - 1e-6) {
    const pt = p.pointAt(total);
    points.push([pt.x, pt.y]);
    cum.push(total);
  }
  return { points, cum, length: total };
}

function smoothPath(controlPoints) {
  if (EnginePath) {
    try {
      const viaEngine = smoothPathViaEngine(controlPoints);
      if (viaEngine) return viaEngine;
    } catch (e) {
      console.error('note: src/sim/path.js Path threw, using the built-in smoother:', e.message);
    }
  }
  return resampleByArcLength(smoothDense(controlPoints), STEP);
}

// Nearest distance from a point to a resampled polyline (point-set approximation at STEP res).
function distToPolyline(pt, poly) {
  let best = Infinity;
  for (let i = 0; i < poly.points.length - 1; i++) {
    const a = poly.points[i], b = poly.points[i + 1];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    let t = len2 > 1e-9 ? ((pt[0] - a[0]) * dx + (pt[1] - a[1]) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const px = a[0] + dx * t, py = a[1] + dy * t;
    const d = Math.hypot(pt[0] - px, pt[1] - py);
    if (d < best) best = d;
  }
  return best;
}

// ---------- constraints ----------

const WORLD_W = 1500, WORLD_H = 1000;
const EDGE_MARGIN = 60;
const LENGTH_BANDS = {
  Beginner: [3600, 4200],
  Intermediate: [3000, 3500],
  Advanced: [2400, 3000],
  Expert: [1800, 2300],
};
const ADJACENCY_ARC = 320; // min arc-length gap before two samples count as "non-adjacent"
const CORE_EXCLUDE = 170;  // radius around the core where lanes are allowed to converge

function pointOutsideByMargin(p) {
  return p[0] <= -EDGE_MARGIN || p[0] >= WORLD_W + EDGE_MARGIN || p[1] <= -EDGE_MARGIN || p[1] >= WORLD_H + EDGE_MARGIN;
}
function pointInsideWithMargin(p) {
  return p[0] >= EDGE_MARGIN && p[0] <= WORLD_W - EDGE_MARGIN && p[1] >= EDGE_MARGIN && p[1] <= WORLD_H - EDGE_MARGIN;
}

// Find self-intersection clusters in one lane's resampled polyline: pairs of samples far apart
// in arc length but closer than `sep` in space. Returns cluster count and offending points.
function findSelfCrossings(poly, sep) {
  const { points, cum } = poly;
  const n = points.length;
  const hits = [];
  // stride to keep this O(n^2 / stride^2) cheap at 2-unit resolution over ~2000 samples
  const stride = 3;
  for (let i = 0; i < n; i += stride) {
    for (let j = i + 1; j < n; j += stride) {
      if (cum[j] - cum[i] < ADJACENCY_ARC) continue;
      const d = dist(points[i], points[j]);
      if (d < sep) hits.push([i, j, d]);
    }
  }
  // cluster by i-index proximity
  hits.sort((a, b) => a[0] - b[0]);
  const clusters = [];
  for (const h of hits) {
    const last = clusters[clusters.length - 1];
    if (last && h[0] - last.iMax < ADJACENCY_ARC) { last.iMax = h[0]; last.minD = Math.min(last.minD, h[2]); last.pts.push(h); }
    else clusters.push({ iMax: h[0], iMin: h[0], minD: h[2], pts: [h] });
  }
  return clusters;
}

// Cross-lane closeness (dock/ember): pairs of samples (one per lane) closer than `sep`.
// `limitA`/`limitB` cap how many leading samples of each lane are checked at all (used to
// exclude a shared tail after a merge point entirely, rather than by radius, since two lanes
// riding the same curve are close at every offset pairing, not just near one point).
function findCrossLane(polyA, polyB, sep, excludeZones, limitA, limitB) {
  const hits = [];
  const stride = 4;
  const nearZone = (p) => (excludeZones || []).some((z) => dist(p, z.pt) < z.r);
  const nA = limitA ?? polyA.points.length;
  const nB = limitB ?? polyB.points.length;
  for (let i = 0; i < nA; i += stride) {
    const pa = polyA.points[i];
    if (nearZone(pa)) continue;
    for (let j = 0; j < nB; j += stride) {
      const pb = polyB.points[j];
      if (nearZone(pb)) continue;
      const d = dist(pa, pb);
      if (d < sep) hits.push([i, j, d]);
    }
  }
  return hits;
}

// Index of the resampled point nearest a given world point (used to find where a lane's
// polyline reaches a landmark, e.g. the merge point, so later samples can be excluded).
function nearestIndex(poly, target) {
  let best = 0, bestD = Infinity;
  for (let i = 0; i < poly.points.length; i++) {
    const d = dist(poly.points[i], target);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

// Index of the last sample at least `buffer` arc-length units before a given index (two lanes
// converging on the same merge point are expected to draw close in the final short approach).
const MERGE_APPROACH = 130;
function indexBefore(poly, atIndex, buffer) {
  const targetCum = poly.cum[atIndex] - buffer;
  let i = atIndex;
  while (i > 0 && poly.cum[i] > targetCum) i--;
  return i;
}

function fmt(n) { return Math.round(n * 10) / 10; }

function checkMap(id) {
  const map = MAPS[id];
  const problems = [];
  const notes = [];
  if (!map) { problems.push(`map '${id}' not found`); return { id, problems, notes, lanes: [] }; }

  const pathWidth = map.pathWidth ?? 56;
  const sep = pathWidth + 40;
  const band = LENGTH_BANDS[map.difficulty];
  if (!band) problems.push(`unknown difficulty '${map.difficulty}', no length band`);

  const lanes = map.paths.map((cps) => ({ cps, poly: smoothPath(cps) }));

  // per-lane checks
  lanes.forEach((lane, i) => {
    const cps = lane.cps;
    const entry = cps[0];
    if (!pointOutsideByMargin(entry)) {
      problems.push(`lane ${i}: entry point ${entry} is not >= ${EDGE_MARGIN}u outside the world edge`);
    }
    for (let k = 1; k < cps.length; k++) {
      if (!pointInsideWithMargin(cps[k])) {
        problems.push(`lane ${i}: control point ${k} ${cps[k]} is within ${EDGE_MARGIN}u of a world edge`);
      }
    }
    const len = lane.poly.length;
    if (band && (len < band[0] || len > band[1])) {
      problems.push(`lane ${i}: length ${fmt(len)} outside ${map.difficulty} band [${band[0]}, ${band[1]}]`);
    } else {
      notes.push(`lane ${i}: length ${fmt(len)}`);
    }
    const last = cps[cps.length - 1];
    if (dist(last, [map.core.x, map.core.y]) > 1) {
      problems.push(`lane ${i}: last control point ${last} does not match core (${map.core.x}, ${map.core.y})`);
    }
    const crossings = findSelfCrossings(lane.poly, sep);
    const allowed = map.crossings ?? 0;
    if (crossings.length !== allowed) {
      problems.push(`lane ${i}: found ${crossings.length} self-crossing region(s), expected ${allowed} ` +
        (crossings.length ? `(min gap ${fmt(Math.min(...crossings.map(c => c.minD)))}u, need >= ${sep}u)` : ''));
    } else if (allowed) {
      notes.push(`lane ${i}: ${allowed} intended self-crossing confirmed`);
    }
  });

  // cross-lane checks
  const coreZone = { pt: [map.core.x, map.core.y], r: CORE_EXCLUDE };
  if (map.lanes === 'merge' && lanes.length === 2) {
    // find shared tail: longest common suffix of control points (by value)
    const a = lanes[0].cps, b = lanes[1].cps;
    let shared = 0;
    while (shared < Math.min(a.length, b.length) &&
      a[a.length - 1 - shared][0] === b[b.length - 1 - shared][0] &&
      a[a.length - 1 - shared][1] === b[b.length - 1 - shared][1]) shared++;
    if (shared < 2) {
      problems.push(`merge map: paths must share a literal tail of control points after the merge (found ${shared})`);
    } else {
      notes.push(`merge point confirmed, shared tail = ${shared} control points`);
    }
    const mergePt = a[a.length - shared];
    const limitA = indexBefore(lanes[0].poly, nearestIndex(lanes[0].poly, mergePt), MERGE_APPROACH);
    const limitB = indexBefore(lanes[1].poly, nearestIndex(lanes[1].poly, mergePt), MERGE_APPROACH);
    const hits = findCrossLane(lanes[0].poly, lanes[1].poly, sep, null, limitA, limitB);
    if (hits.length) {
      problems.push(`lanes 0/1: ${hits.length} sample pairs closer than ${sep}u before the merge ` +
        `(min ${fmt(Math.min(...hits.map(h => h[2])))}u)`);
    }
  } else if (map.lanes === 'alternate' && lanes.length === 2) {
    const hits = findCrossLane(lanes[0].poly, lanes[1].poly, sep, [coreZone]);
    if (hits.length) {
      problems.push(`lanes 0/1: ${hits.length} sample pairs closer than ${sep}u outside the core convergence zone ` +
        `(min ${fmt(Math.min(...hits.map(h => h[2])))}u)`);
    }
  }

  // blockers
  (map.blockers || []).forEach((b, i) => {
    let minD = Infinity;
    for (const lane of lanes) minD = Math.min(minD, distToPolyline([b.x, b.y], lane.poly));
    const need = pathWidth / 2 + b.r + 10;
    if (minD < need) problems.push(`blocker ${i} (${b.kind} @ ${b.x},${b.y}, r=${b.r}): ${fmt(minD)}u from path, needs >= ${fmt(need)}u`);
  });
  if (!map.blockers || !map.blockers.length) problems.push('no blockers defined');

  return { id, map, problems, notes, lanes };
}

// ---------- SVG preview ----------

function svgForMap(result) {
  const { map, lanes } = result;
  const pal = map.palette || {};
  const pw = map.pathWidth ?? 56;
  const pad = 80;
  const vb = `${-pad} ${-pad} ${WORLD_W + pad * 2} ${WORLD_H + pad * 2}`;
  let s = `<svg viewBox="${vb}" xmlns="http://www.w3.org/2000/svg" font-family="sans-serif">\n`;
  s += `<rect x="${-pad}" y="${-pad}" width="${WORLD_W + pad * 2}" height="${WORLD_H + pad * 2}" fill="#0a0c10"/>\n`;
  s += `<rect x="0" y="0" width="${WORLD_W}" height="${WORLD_H}" fill="${pal.ground2 || '#222'}"/>\n`;
  s += `<rect x="${EDGE_MARGIN}" y="${EDGE_MARGIN}" width="${WORLD_W - 2 * EDGE_MARGIN}" height="${WORLD_H - 2 * EDGE_MARGIN}" fill="${pal.ground || '#333'}" opacity="0.6"/>\n`;
  s += `<rect x="0.5" y="0.5" width="${WORLD_W - 1}" height="${WORLD_H - 1}" fill="none" stroke="#555" stroke-width="2"/>\n`;

  for (const lane of lanes) {
    const d = lane.poly.points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${fmt(p[0])} ${fmt(p[1])}`).join(' ');
    s += `<path d="${d}" fill="none" stroke="${pal.glow || 'rgba(255,255,255,0.25)'}" stroke-width="${pw + 22}" stroke-linecap="round" stroke-linejoin="round"/>\n`;
    s += `<path d="${d}" fill="none" stroke="${pal.channel || '#141925'}" stroke-width="${pw}" stroke-linecap="round" stroke-linejoin="round"/>\n`;
    s += `<path d="${d}" fill="none" stroke="${pal.edge || '#6ee7ff'}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" opacity="0.85"/>\n`;
  }
  for (const lane of lanes) {
    for (const cp of lane.cps) {
      s += `<circle cx="${cp[0]}" cy="${cp[1]}" r="4" fill="#ffffff" opacity="0.5"/>\n`;
    }
    const entry = lane.cps[0];
    s += `<circle cx="${entry[0]}" cy="${entry[1]}" r="14" fill="none" stroke="${pal.accent || '#fff'}" stroke-width="3"/>\n`;
  }
  for (const b of map.blockers || []) {
    s += `<circle cx="${b.x}" cy="${b.y}" r="${b.r}" fill="#000" opacity="0.35" stroke="#e94" stroke-width="2"/>\n`;
    s += `<text x="${b.x}" y="${b.y}" font-size="11" fill="#fff" text-anchor="middle" dominant-baseline="middle">${b.kind}</text>\n`;
  }
  s += `<circle cx="${map.core.x}" cy="${map.core.y}" r="26" fill="${pal.accent || '#ffb347'}" opacity="0.85" stroke="#fff" stroke-width="2"/>\n`;
  s += `<text x="${map.core.x}" y="${map.core.y}" font-size="12" fill="#111" text-anchor="middle" dominant-baseline="middle">CORE</text>\n`;
  s += `<text x="0" y="-50" font-size="28" fill="#fff">${map.name} (${map.difficulty})</text>\n`;
  const lens = lanes.map((l) => fmt(l.poly.length)).join(' / ');
  s += `<text x="0" y="-20" font-size="16" fill="#aaa">lanes: ${map.lanes}  path length: ${lens}</text>\n`;
  s += `</svg>\n`;
  return s;
}

// ---------- main ----------

const ids = process.argv.slice(2).length ? process.argv.slice(2) : MAP_ORDER;
const outDir = path.join(ROOT, 'out', 'maps');
fs.mkdirSync(outDir, { recursive: true });

let anyFail = false;
for (const id of ids) {
  const result = checkMap(id);
  const ok = result.problems.length === 0;
  if (!ok) anyFail = true;
  console.log(`\n=== ${id} ${ok ? 'PASS' : 'FAIL'} ===`);
  for (const n of result.notes) console.log('  note: ' + n);
  for (const p of result.problems) console.log('  FAIL: ' + p);
  if (result.map) {
    fs.writeFileSync(path.join(outDir, `${id}.svg`), svgForMap(result));
    console.log(`  wrote out/maps/${id}.svg`);
  }
}
if (MAP_ORDER.length !== new Set(MAP_ORDER).size) { console.log('\nFAIL: MAP_ORDER has duplicates'); anyFail = true; }
console.log(anyFail ? '\nRESULT: FAIL' : '\nRESULT: PASS');
process.exit(anyFail ? 1 : 0);
