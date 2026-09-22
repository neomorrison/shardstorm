// Static layer: terrain (procedural or map image), the gravity channel (path), blockers,
// props and the core platform, pre-rendered once per map + canvas size into one offscreen
// canvas at device resolution (plus a margin so screen shake never shows an edge).
// Also owns lane geometry (sampled path polylines) used for chevrons and the portal.

import { WORLD_W, WORLD_H } from './camera.js';
import { makeCanvas } from './sprites.js';
import {
  INK, mix, shade, rgba, rng, hashStr, drawBlocker, drawCorePlatform, parseColor,
} from './procedural.js';

export const DEFAULT_PALETTE = {
  ground: '#3b4356', ground2: '#2a303e', channel: '#141925', edge: '#6ee7ff',
  glow: 'rgba(110,231,255,0.30)', accent: '#ffb347',
};

// ---------------------------------------------------------------------------
// Lane geometry
// ---------------------------------------------------------------------------

const STEP = 2; // world units between samples

export class Lane {
  constructor(xs, ys, step) {
    this.xs = xs; this.ys = ys; this.step = step;
    this.n = xs.length;
    this.length = (this.n - 1) * step;
    this.start = 0; // arc length where the visible channel starts (portal position)
  }
  // Writes { x, y, angle } into out for arc length d.
  point(d, out) {
    const f = Math.max(0, Math.min(this.n - 1.0001, d / this.step));
    const i = Math.floor(f), t = f - i;
    const x0 = this.xs[i], y0 = this.ys[i], x1 = this.xs[i + 1], y1 = this.ys[i + 1];
    out.x = x0 + (x1 - x0) * t;
    out.y = y0 + (y1 - y0) * t;
    out.angle = Math.atan2(y1 - y0, x1 - x0);
    return out;
  }
}

function fromSimPath(p) {
  if (!p) return null;
  // Fast path: the sim's Path already holds evenly spaced samples.
  if (p.xs && p.ys && p.xs.length > 1 && p.ys.length === p.xs.length && Number.isFinite(p.step) && p.step > 0) {
    return new Lane(p.xs, p.ys, p.step);
  }
  const len =[p.length, p.total, p.len, p.totalLength].find((v) => typeof v === 'number' && Number.isFinite(v) && v > 0);
  if (typeof p.pointAt === 'function' && len) {
    const n = Math.floor(len / STEP) + 1;
    const xs = new Float32Array(n + 1), ys = new Float32Array(n + 1);
    for (let i = 0; i <= n; i++) {
      const q = p.pointAt(Math.min(len, i * STEP));
      if (!q || !Number.isFinite(q.x)) return null;
      xs[i] = q.x; ys[i] = q.y;
    }
    return new Lane(xs, ys, STEP);
  }
  return null;
}

// Centripetal Catmull-Rom (alpha 0.5) with reflected endpoints, resampled by arc length.
// Matches tools/mapcheck.mjs so the fallback lines up with the sim's Path class.
function smoothControl(points) {
  if (!points || points.length < 2) return null;
  const P = points.map((p) => (Array.isArray(p) ? p : [p.x, p.y]));
  const n = P.length;
  const ext = [
    [2 * P[0][0] - P[1][0], 2 * P[0][1] - P[1][1]],
    ...P,
    [2 * P[n - 1][0] - P[n - 2][0], 2 * P[n - 1][1] - P[n - 2][1]],
  ];
  const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
  const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  const dense = [];
  const SEG = 28;
  for (let k = 0; k < n - 1; k++) {
    const p0 = ext[k], p1 = ext[k + 1], p2 = ext[k + 2], p3 = ext[k + 3];
    const t0 = 0;
    const t1 = t0 + Math.pow(Math.max(dist(p0, p1), 1e-6), 0.5);
    const t2 = t1 + Math.pow(Math.max(dist(p1, p2), 1e-6), 0.5);
    const t3 = t2 + Math.pow(Math.max(dist(p2, p3), 1e-6), 0.5);
    for (let i = 0; i < SEG; i++) {
      const t = t1 + (t2 - t1) * (i / SEG);
      const A1 = lerp(p0, p1, (t - t0) / (t1 - t0));
      const A2 = lerp(p1, p2, (t - t1) / (t2 - t1));
      const A3 = lerp(p2, p3, (t - t2) / (t3 - t2));
      const B1 = lerp(A1, A2, (t - t0) / (t2 - t0));
      const B2 = lerp(A2, A3, (t - t1) / (t3 - t1));
      dense.push(lerp(B1, B2, (t - t1) / (t2 - t1)));
    }
  }
  dense.push(P[n - 1]);
  const cum = [0];
  for (let i = 1; i < dense.length; i++) cum.push(cum[i - 1] + dist(dense[i - 1], dense[i]));
  const total = cum[cum.length - 1];
  const m = Math.floor(total / STEP) + 1;
  const xs = new Float32Array(m + 1), ys = new Float32Array(m + 1);
  let seg = 0;
  for (let i = 0; i <= m; i++) {
    const d = Math.min(total, i * STEP);
    while (seg < cum.length - 2 && cum[seg + 1] < d) seg++;
    const span = cum[seg + 1] - cum[seg] || 1;
    const t = (d - cum[seg]) / span;
    xs[i] = dense[seg][0] + (dense[seg + 1][0] - dense[seg][0]) * t;
    ys[i] = dense[seg][1] + (dense[seg + 1][1] - dense[seg][1]) * t;
  }
  return new Lane(xs, ys, STEP);
}

export function buildLanes(sim, map) {
  const lanes = [];
  const simPaths = sim && (sim.paths || (sim.map && sim.map.paths_) || null);
  const ctrl = (map && map.paths) || [];
  const count = Math.max(Array.isArray(simPaths) ? simPaths.length : 0, ctrl.length);
  for (let i = 0; i < count; i++) {
    let lane = null;
    try { lane = fromSimPath(Array.isArray(simPaths) ? simPaths[i] : null); } catch { lane = null; }
    if (!lane) lane = smoothControl(ctrl[i]);
    if (lane) lanes.push(lane);
  }
  return lanes;
}

// Set lane.start to the first point that sits comfortably inside the visible area.
export function placePortals(lanes, view, pad) {
  const out = [];
  for (const lane of lanes) {
    let idx = 0;
    for (let i = 0; i < lane.n; i++) {
      const x = lane.xs[i], y = lane.ys[i];
      if (x >= view.x0 + pad && x <= view.x1 - pad && y >= view.y0 + pad && y <= view.y1 - pad) { idx = i; break; }
    }
    lane.start = idx * lane.step;
    const p = lane.point(lane.start, {});
    out.push({ x: p.x, y: p.y, angle: p.angle, d: lane.start });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Noise (value noise + fbm), deterministic
// ---------------------------------------------------------------------------

function hash2(x, y, seed) {
  let h = (x * 374761393 + y * 668265263 + seed * 2246822519) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
function vnoise(x, y, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi, seed), b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed), d = hash2(xi + 1, yi + 1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm(x, y, seed, oct = 4) {
  let s = 0, amp = 0.5, f = 1, norm = 0;
  for (let i = 0; i < oct; i++) {
    s += amp * vnoise(x * f, y * f, seed + i * 17);
    norm += amp;
    amp *= 0.5; f *= 2.03;
  }
  return s / norm;
}

// ---------------------------------------------------------------------------
// Static layer
// ---------------------------------------------------------------------------

function lanePath(ctx, lane, dx = 0, dy = 0, from = lane.start, to = lane.length) {
  const i0 = Math.max(0, Math.floor(from / lane.step));
  const i1 = Math.min(lane.n - 1, Math.ceil(to / lane.step));
  ctx.moveTo(lane.xs[i0] + dx, lane.ys[i0] + dy);
  for (let i = i0 + 1; i <= i1; i++) ctx.lineTo(lane.xs[i] + dx, lane.ys[i] + dy);
}
function strokeLanes(ctx, lanes, width, style, dx = 0, dy = 0) {
  ctx.beginPath();
  for (const lane of lanes) lanePath(ctx, lane, dx, dy);
  ctx.lineWidth = width;
  ctx.strokeStyle = style;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.stroke();
}

// Coarse sample list for distance tests.
function coarsePoints(lanes, every = 6) {
  const pts = [];
  for (const lane of lanes) {
    const i0 = Math.floor(lane.start / lane.step);
    for (let i = i0; i < lane.n; i += every) pts.push(lane.xs[i], lane.ys[i]);
  }
  return pts;
}
function distToLanes(pts, x, y) {
  let best = Infinity;
  for (let i = 0; i < pts.length; i += 2) {
    const dx = pts[i] - x, dy = pts[i + 1] - y;
    const d = dx * dx + dy * dy;
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

const filterOK = (() => {
  try {
    const c = typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null;
    return !!(c && 'filter' in c);
  } catch { return false; }
})();

// Build the static layer. Returns { canvas, k, ox, oy, m }.
export function buildStaticLayer({ map, lanes, camera, assets, portals }) {
  const m = Math.round(24 * camera.dpr);
  const W = camera.w + m * 2, H = camera.h + m * 2;
  const canvas = makeCanvas(W, H);
  const ctx = canvas.getContext('2d');
  const k = camera.k;
  const ox = camera.ox + m, oy = camera.oy + m;
  const pal = { ...DEFAULT_PALETTE, ...((map && map.palette) || {}) };
  const seed = hashStr((map && map.id) || 'map');
  const view = {
    x0: (0 - ox) / k, y0: (0 - oy) / k, x1: (W - ox) / k, y1: (H - oy) / k,
  };
  const world = () => ctx.setTransform(k, 0, 0, k, ox, oy);
  const screen = () => ctx.setTransform(1, 0, 0, 1, 0, 0);
  const pathW = (map && map.pathWidth) || 56;
  const blockers = (map && map.blockers) || [];
  const core = (map && map.core) || { x: WORLD_W - 100, y: 100 };
  const coarse = coarsePoints(lanes);

  // --- Ground -------------------------------------------------------------
  const bgSpec = assets && map && assets.get && assets.get('map_' + map.id);
  screen();
  ctx.fillStyle = pal.ground2;
  ctx.fillRect(0, 0, W, H);
  if (bgSpec && bgSpec.img) {
    const img = bgSpec.img;
    const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
    // Cover the whole canvas, centered on the world center.
    const s = Math.max(W / iw, H / ih);
    const cx = ox + (WORLD_W / 2) * k, cy = oy + (WORLD_H / 2) * k;
    let dx = cx - (iw * s) / 2, dy = cy - (ih * s) / 2;
    dx = Math.min(0, Math.max(W - iw * s, dx));
    dy = Math.min(0, Math.max(H - ih * s, dy));
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, dx, dy, iw * s, ih * s);
  } else {
    paintTerrain(ctx, { view, k, ox, oy, W, H, pal, seed, coarse, pathW, blockers, core, world, screen, flavor: terrainFlavor(map) });
  }

  // Darken outside the playable world rectangle (soft edge).
  world();
  const fade = 60;
  const dark = 'rgba(4,6,12,0.30)';
  const clear = 'rgba(4,6,12,0)';
  const band = (x0, y0, x1, y1, gx0, gy0, gx1, gy1) => {
    const g = ctx.createLinearGradient(gx0, gy0, gx1, gy1);
    g.addColorStop(0, clear); g.addColorStop(1, dark);
    ctx.fillStyle = g;
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
  };
  if (view.x0 < 0) band(view.x0, view.y0, 0, view.y1, 0, 0, -fade, 0);
  if (view.x1 > WORLD_W) band(WORLD_W, view.y0, view.x1, view.y1, WORLD_W, 0, WORLD_W + fade, 0);
  if (view.y0 < 0) band(Math.max(0, view.x0), view.y0, Math.min(WORLD_W, view.x1), 0, 0, 0, 0, -fade);
  if (view.y1 > WORLD_H) band(Math.max(0, view.x0), WORLD_H, Math.min(WORLD_W, view.x1), view.y1, 0, WORLD_H, 0, WORLD_H + fade);

  // --- Channel --------------------------------------------------------------
  world();
  paintChannel(ctx, { lanes, pal, pathW, k, W, H, ox, oy, portals });

  // Portal scorch marks (under the animated portal)
  for (const p of portals || []) {
    const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, pathW * 1.35);
    g.addColorStop(0, 'rgba(8,4,16,0.85)');
    g.addColorStop(0.55, 'rgba(40,16,70,0.45)');
    g.addColorStop(1, 'rgba(40,16,70,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(p.x, p.y, pathW * 1.35, 0, Math.PI * 2);
    ctx.fill();
  }

  // --- Blockers and props ---------------------------------------------------
  const props = (map && map.props) || [];
  for (const b of [...blockers, ...props]) {
    if (!b || !Number.isFinite(b.x)) continue;
    const spec = assets && assets.get && assets.get('blocker_' + (b.kind || 'rock'));
    ctx.save();
    ctx.translate(b.x, b.y);
    if (spec && spec.img) {
      const s = (b.r || 40) * 2.3;
      ctx.drawImage(spec.img, -s / 2, -s / 2, s, s);
    } else {
      drawBlocker(ctx, b, pal, seed);
    }
    ctx.restore();
  }

  // --- Core platform ----------------------------------------------------------
  ctx.save();
  ctx.translate(core.x, core.y);
  drawCorePlatform(ctx, CORE_R, pal);
  ctx.restore();

  // --- Screen vignette -------------------------------------------------------
  screen();
  const vg = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.45, W / 2, H / 2, Math.hypot(W, H) * 0.62);
  vg.addColorStop(0, 'rgba(0,0,0,0)');
  vg.addColorStop(1, 'rgba(0,0,0,0.38)');
  ctx.fillStyle = vg;
  ctx.fillRect(0, 0, W, H);

  return { canvas, k, ox, oy, m };
}

export const CORE_R = 46;

// Terrain flavors: each map gets its own ground treatment on top of the shared noise base.
// Counts are per million square world units.
const FLAVORS = {
  regolith: { craters: 70, rays: 4, rocks: 150, crystals: 26, drifts: 14 },
  ice:      { craters: 20, rays: 0, rocks: 60, crystals: 20, drifts: 26, cracks: 46, snow: true },
  deck:     { craters: 0, rays: 0, rocks: 18, crystals: 4, drifts: 6, plates: true },
  lava:     { craters: 38, rays: 0, rocks: 170, crystals: 6, drifts: 8, veins: 30 },
  crystal:  { craters: 26, rays: 2, rocks: 80, crystals: 90, drifts: 10 },
};
const MAP_FLAVOR = { crater: 'regolith', frost: 'ice', dock: 'deck', ember: 'lava', prism: 'crystal' };
export function terrainFlavor(map) {
  const f = (map && (map.terrain || MAP_FLAVOR[map.id])) || 'regolith';
  return FLAVORS[f] ? f : 'regolith';
}

function paintTerrain(ctx, o) {
  const { view, k, W, H, pal, seed, coarse, pathW, blockers, core, world, screen } = o;
  const FL = FLAVORS[o.flavor] || FLAVORS.regolith;
  const R = rng(seed ^ 0x51f15e);
  const vw = view.x1 - view.x0, vh = view.y1 - view.y0;

  // 1) Mottled regolith from layered noise, rendered small and upscaled smoothly.
  const cell = 6;
  const nw = Math.max(2, Math.ceil(vw / cell) + 1), nh = Math.max(2, Math.ceil(vh / cell) + 1);
  const small = makeCanvas(nw, nh);
  const sctx = small.getContext('2d');
  const img = sctx.createImageData(nw, nh);
  const g1 = parseColor(pal.ground), g2 = parseColor(pal.ground2);
  const hi = parseColor(shade(pal.ground, 0.12));
  const warm = parseColor(mix(pal.ground, pal.accent, 0.35));
  const cool = parseColor(mix(pal.ground2, pal.edge, 0.22));
  const data = img.data;
  for (let j = 0; j < nh; j++) {
    for (let i = 0; i < nw; i++) {
      const x = view.x0 + i * cell, y = view.y0 + j * cell;
      const base = fbm(x / 260, y / 260, seed, 4);          // broad variation
      const mare = fbm(x / 700 + 11, y / 700 + 7, seed + 3, 3); // large dark basins
      const fine = fbm(x / 60, y / 60, seed + 9, 2);          // grit
      let t = base * 0.85 + fine * 0.25 - 0.1;
      t -= Math.max(0, mare - 0.52) * 1.4;
      t = Math.max(0, Math.min(1.15, t));
      let r, g, b;
      if (t <= 1) { r = g2[0] + (g1[0] - g2[0]) * t; g = g2[1] + (g1[1] - g2[1]) * t; b = g2[2] + (g1[2] - g2[2]) * t; }
      else { const u = (t - 1) / 0.15; r = g1[0] + (hi[0] - g1[0]) * u; g = g1[1] + (hi[1] - g1[1]) * u; b = g1[2] + (hi[2] - g1[2]) * u; }
      // Broad warm and cool tint regions so the ground is not one flat hue.
      const tint = fbm(x / 900 + 31, y / 900 + 17, seed + 21, 3);
      const wf = Math.max(0, Math.min(1, (tint - 0.56) / 0.18)) * 0.16;
      const cf = Math.max(0, Math.min(1, (0.44 - tint) / 0.18)) * 0.14;
      r += (warm[0] - r) * wf + (cool[0] - r) * cf;
      g += (warm[1] - g) * wf + (cool[1] - g) * cf;
      b += (warm[2] - b) * wf + (cool[2] - b) * cf;
      const p = (j * nw + i) * 4;
      data[p] = r; data[p + 1] = g; data[p + 2] = b; data[p + 3] = 255;
    }
  }
  sctx.putImageData(img, 0, 0);
  world();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(small, view.x0, view.y0, nw * cell, nh * cell);

  // 2) Fine grain in device pixels.
  screen();
  const tile = makeCanvas(160, 160);
  const tctx = tile.getContext('2d');
  const gr = rng(seed ^ 0xabc);
  for (let i = 0; i < 2600; i++) {
    const light = gr() < 0.45;
    tctx.fillStyle = light ? `rgba(255,255,255,${0.02 + gr() * 0.05})` : `rgba(0,0,0,${0.04 + gr() * 0.08})`;
    const s = gr() < 0.9 ? 1 : 2;
    tctx.fillRect(Math.floor(gr() * 160), Math.floor(gr() * 160), s, s);
  }
  ctx.fillStyle = ctx.createPattern(tile, 'repeat');
  ctx.fillRect(0, 0, W, H);

  world();
  const clearOf = (x, y, r) => {
    if (distToLanes(coarse, x, y) < pathW / 2 + r + 10) return false;
    for (const b of blockers) if (Math.hypot(b.x - x, b.y - y) < (b.r || 40) + r + 12) return false;
    if (Math.hypot(core.x - x, core.y - y) < CORE_R + r + 14) return false;
    return true;
  };

  if (FL.plates) deckPlates(ctx, view, pal, R, clearOf);

  // 3) Dust drifts (very soft light patches; snow on icy maps)
  const driftCol = FL.snow ? '#eaf8ff' : shade(pal.ground, 0.35);
  for (let i = 0; i < FL.drifts; i++) {
    const x = view.x0 + R() * vw, y = view.y0 + R() * vh;
    const rx = 120 + R() * 260, ry = rx * (0.35 + R() * 0.3);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(-0.5 + R() * 0.3);
    ctx.scale(1, ry / rx);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
    g.addColorStop(0, rgba(driftCol, FL.snow ? 0.1 : 0.07));
    g.addColorStop(1, rgba(driftCol, 0));
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(0, 0, rx, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  // 4) Craters (shallow, decorative). Power-law radii: many small, few large.
  const area = vw * vh;
  if (FL.cracks) iceCracks(ctx, view, R, clearOf, Math.round((area / 1e6) * FL.cracks));
  const nCraters = Math.round((area / 1e6) * FL.craters);
  const big = [];
  for (let i = 0; i < nCraters; i++) {
    const r = 5 + 60 * Math.pow(R(), 3.2);
    const x = view.x0 + R() * vw, y = view.y0 + R() * vh;
    if (!clearOf(x, y, r)) continue;
    if (r > 30) big.push([x, y, r]);
    crater(ctx, x, y, r, pal);
  }
  // Bright ejecta rays around the largest craters (classic lunar look), drawn under them.
  big.sort((a, b) => b[2] - a[2]);
  for (const [x, y, r] of big.slice(0, FL.rays)) {
    const n = 9 + Math.floor(R() * 7);
    for (let k = 0; k < n; k++) {
      const a = R() * Math.PI * 2;
      const len = r * (2.2 + R() * 3.2);
      const w = r * (0.08 + R() * 0.12);
      const x0 = x + Math.cos(a) * r * 1.05, y0 = y + Math.sin(a) * r * 1.05;
      const x1 = x + Math.cos(a) * len, y1 = y + Math.sin(a) * len;
      const nx = -Math.sin(a), ny = Math.cos(a);
      const g = ctx.createLinearGradient(x0, y0, x1, y1);
      g.addColorStop(0, rgba(shade(pal.ground, 0.4), 0.13));
      g.addColorStop(1, rgba(shade(pal.ground, 0.4), 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(x0 + nx * w, y0 + ny * w);
      ctx.lineTo(x1, y1);
      ctx.lineTo(x0 - nx * w, y0 - ny * w);
      ctx.closePath();
      ctx.fill();
    }
    crater(ctx, x, y, r, pal); // redraw the bowl on top of its rays
  }

  if (FL.veins) lavaVeins(ctx, view, R, clearOf, Math.round((area / 1e6) * FL.veins));

  // 5) Pebbles and rocks
  const nRocks = Math.round((area / 1e6) * FL.rocks);
  for (let i = 0; i < nRocks; i++) {
    const s = 1.8 + 5.5 * Math.pow(R(), 2.2);
    const x = view.x0 + R() * vw, y = view.y0 + R() * vh;
    if (!clearOf(x, y, s)) continue;
    pebble(ctx, x, y, s, pal, R);
  }

  // 6) Crystal glints embedded in the ground
  const nCrys = Math.round((area / 1e6) * FL.crystals);
  const crysBig = o.flavor === 'crystal' ? 1.6 : 1;
  for (let i = 0; i < nCrys; i++) {
    const x = view.x0 + R() * vw, y = view.y0 + R() * vh;
    const s = (3 + R() * 5) * crysBig;
    if (!clearOf(x, y, s + 4)) continue;
    const c = R() < 0.55 ? pal.edge : pal.accent;
    const gg = ctx.createRadialGradient(x, y, 0, x, y, s * 3);
    gg.addColorStop(0, rgba(c, 0.28));
    gg.addColorStop(1, rgba(c, 0));
    ctx.fillStyle = gg;
    ctx.beginPath(); ctx.arc(x, y, s * 3, 0, Math.PI * 2); ctx.fill();
    const n = 2 + Math.floor(R() * 3);
    for (let q = 0; q < n; q++) {
      const a = -Math.PI / 2 + (R() - 0.5) * 1.4;
      const h = s * (0.7 + R() * 0.8), w = h * 0.32;
      ctx.save();
      ctx.translate(x + (R() - 0.5) * s, y + (R() - 0.5) * s * 0.5);
      ctx.rotate(a + Math.PI / 2);
      ctx.beginPath();
      ctx.moveTo(-w, 0); ctx.lineTo(0, -h); ctx.lineTo(w, 0); ctx.lineTo(0, h * 0.2);
      ctx.closePath();
      ctx.fillStyle = mix(c, '#ffffff', 0.25);
      ctx.fill();
      ctx.lineWidth = 0.9; ctx.strokeStyle = INK; ctx.stroke();
      ctx.restore();
    }
  }
}

// Orbital dock: riveted deck plates with seams, hazard markings and oil stains.
function deckPlates(ctx, view, pal, R, clearOf) {
  const cell = 96;
  const x0 = Math.floor(view.x0 / cell) * cell, y0 = Math.floor(view.y0 / cell) * cell;
  for (let y = y0; y < view.y1; y += cell) {
    for (let x = x0; x < view.x1; x += cell) {
      const t = R();
      ctx.fillStyle = t < 0.5 ? rgba('#ffffff', 0.012 + R() * 0.03) : rgba('#000000', 0.03 + R() * 0.06);
      ctx.fillRect(x + 1, y + 1, cell - 2, cell - 2);
      if (R() < 0.35) {
        ctx.fillStyle = rgba('#000000', 0.05);
        if (R() < 0.5) ctx.fillRect(x + 1, y + cell / 2, cell - 2, 1.5); else ctx.fillRect(x + cell / 2, y + 1, 1.5, cell - 2);
      }
    }
  }
  const seams = (dx, dy, col, w) => {
    ctx.beginPath();
    for (let x = x0; x <= view.x1 + cell; x += cell) { ctx.moveTo(x + dx, view.y0); ctx.lineTo(x + dx, view.y1); }
    for (let y = y0; y <= view.y1 + cell; y += cell) { ctx.moveTo(view.x0, y + dy); ctx.lineTo(view.x1, y + dy); }
    ctx.strokeStyle = col; ctx.lineWidth = w; ctx.stroke();
  };
  seams(0, 0, 'rgba(0,0,0,0.42)', 2.2);
  seams(1.6, 1.6, 'rgba(255,255,255,0.05)', 1);
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  for (let y = y0; y <= view.y1 + cell; y += cell) {
    for (let x = x0; x <= view.x1 + cell; x += cell) {
      for (const [dx, dy] of [[7, 7], [-7, 7], [7, -7], [-7, -7]]) {
        ctx.beginPath(); ctx.arc(x + dx, y + dy, 1.6, 0, Math.PI * 2); ctx.fill();
      }
    }
  }
  // Hazard stripe markings
  const vw = view.x1 - view.x0, vh = view.y1 - view.y0;
  for (let i = 0, placed = 0; i < 40 && placed < 6; i++) {
    const w = 90 + R() * 70, h = 18;
    const x = view.x0 + R() * vw, y = view.y0 + R() * vh;
    if (!clearOf(x + w / 2, y + h / 2, w / 2 + 6)) continue;
    placed++;
    ctx.save();
    ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
    ctx.fillStyle = rgba('#f2c230', 0.5);
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = rgba('#15181c', 0.6);
    for (let sx = -h; sx < w + h; sx += 18) {
      ctx.beginPath();
      ctx.moveTo(x + sx, y + h); ctx.lineTo(x + sx + 9, y + h); ctx.lineTo(x + sx + 9 + h, y); ctx.lineTo(x + sx + h, y);
      ctx.closePath(); ctx.fill();
    }
    ctx.restore();
    ctx.strokeStyle = 'rgba(0,0,0,0.4)'; ctx.lineWidth = 1.2; ctx.strokeRect(x, y, w, h);
  }
  // Oil stains and scorch
  for (let i = 0; i < 12; i++) {
    const x = view.x0 + R() * vw, y = view.y0 + R() * vh, r = 20 + R() * 50;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, 'rgba(8,10,14,0.22)'); g.addColorStop(1, 'rgba(8,10,14,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  }
}

// Frostline: hairline ice fractures with a dark lower edge.
function iceCracks(ctx, view, R, clearOf, n) {
  const vw = view.x1 - view.x0, vh = view.y1 - view.y0;
  const walk = (x, y, a, segs, depth) => {
    const pts = [[x, y]];
    for (let s = 0; s < segs; s++) {
      a += (R() - 0.5) * 1.1;
      const len = 8 + R() * 16;
      x += Math.cos(a) * len; y += Math.sin(a) * len;
      if (!clearOf(x, y, 4)) break;
      pts.push([x, y]);
      if (depth < 2 && R() < 0.18) walk(x, y, a + (R() < 0.5 ? 1 : -1) * (0.6 + R() * 0.6), 3 + Math.floor(R() * 5), depth + 1);
    }
    if (pts.length < 2) return;
    const line = (dx, dy, col, w) => {
      ctx.beginPath(); ctx.moveTo(pts[0][0] + dx, pts[0][1] + dy);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0] + dx, pts[i][1] + dy);
      ctx.strokeStyle = col; ctx.lineWidth = w; ctx.stroke();
    };
    line(1, 1.2, 'rgba(0,16,32,0.3)', 1.6);
    line(0, 0, 'rgba(215,245,255,0.28)', 1.1);
  };
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  for (let i = 0; i < n; i++) {
    const x = view.x0 + R() * vw, y = view.y0 + R() * vh;
    if (!clearOf(x, y, 6)) continue;
    walk(x, y, R() * Math.PI * 2, 5 + Math.floor(R() * 8), 0);
  }
}

// Ember Rift: glowing magma veins in dark basalt.
function lavaVeins(ctx, view, R, clearOf, n) {
  const vw = view.x1 - view.x0, vh = view.y1 - view.y0;
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  for (let i = 0; i < n; i++) {
    let x = view.x0 + R() * vw, y = view.y0 + R() * vh;
    if (!clearOf(x, y, 10)) continue;
    let a = R() * Math.PI * 2;
    const pts = [[x, y]];
    const segs = 6 + Math.floor(R() * 12);
    for (let s = 0; s < segs; s++) {
      a += (R() - 0.5) * 1.2;
      const len = 10 + R() * 18;
      x += Math.cos(a) * len; y += Math.sin(a) * len;
      if (!clearOf(x, y, 10)) break;
      pts.push([x, y]);
    }
    if (pts.length < 3) continue;
    const line = (col, w) => {
      ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
      for (let q = 1; q < pts.length; q++) ctx.lineTo(pts[q][0], pts[q][1]);
      ctx.strokeStyle = col; ctx.lineWidth = w; ctx.stroke();
    };
    line('rgba(10,4,2,0.55)', 6);
    line('rgba(255,90,20,0.16)', 12);
    line('rgba(255,110,40,0.7)', 2.8);
    line('rgba(255,214,140,0.95)', 1);
  }
}

function crater(ctx, x, y, r, pal) {
  const dark = shade(pal.ground2, -0.35);
  const lite = shade(pal.ground, 0.22);
  const TAU = Math.PI * 2;
  // Ejecta halo
  const eg = ctx.createRadialGradient(x, y, r * 0.9, x, y, r * 1.6);
  eg.addColorStop(0, rgba(lite, 0.12));
  eg.addColorStop(1, rgba(lite, 0));
  ctx.fillStyle = eg;
  ctx.beginPath(); ctx.arc(x, y, r * 1.6, 0, TAU); ctx.fill();
  // Bowl
  ctx.beginPath(); ctx.arc(x, y, r, 0, TAU);
  ctx.fillStyle = rgba(dark, 0.42);
  ctx.fill();
  ctx.save();
  ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.clip();
  // Shadowed inner wall (top-left): bowl minus a circle shifted to the bottom-right.
  ctx.beginPath();
  ctx.rect(x - r * 2, y - r * 2, r * 4, r * 4);
  ctx.arc(x + r * 0.22, y + r * 0.26, r * 0.98, 0, TAU);
  ctx.fillStyle = rgba('#000000', 0.28);
  ctx.fill('evenodd');
  // Lit inner wall (bottom-right)
  ctx.beginPath();
  ctx.rect(x - r * 2, y - r * 2, r * 4, r * 4);
  ctx.arc(x - r * 0.16, y - r * 0.18, r * 0.98, 0, TAU);
  ctx.fillStyle = rgba(lite, 0.35);
  ctx.fill('evenodd');
  ctx.restore();
  // Rim: light on the top-left outer slope, dark on the bottom-right
  const rg = ctx.createLinearGradient(x - r, y - r, x + r, y + r);
  rg.addColorStop(0, rgba(lite, 0.55));
  rg.addColorStop(0.5, rgba(lite, 0.05));
  rg.addColorStop(1, rgba('#000000', 0.35));
  ctx.beginPath(); ctx.arc(x, y, r * 1.04, 0, TAU);
  ctx.lineWidth = Math.max(1, r * 0.12);
  ctx.strokeStyle = rg;
  ctx.stroke();
}

function pebble(ctx, x, y, s, pal, R) {
  const n = 5 + Math.floor(R() * 3);
  const pts = [];
  const rot = R() * Math.PI * 2;
  for (let i = 0; i < n; i++) {
    const a = rot + (i / n) * Math.PI * 2;
    const rr = s * (0.75 + R() * 0.25);
    pts.push([x + Math.cos(a) * rr, y + Math.sin(a) * rr * 0.8]);
  }
  const poly = (dx, dy) => {
    ctx.beginPath();
    ctx.moveTo(pts[0][0] + dx, pts[0][1] + dy);
    for (let i = 1; i < n; i++) ctx.lineTo(pts[i][0] + dx, pts[i][1] + dy);
    ctx.closePath();
  };
  poly(s * 0.25, s * 0.35);
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.fill();
  poly(0, 0);
  const g = ctx.createLinearGradient(x - s, y - s, x + s, y + s);
  g.addColorStop(0, shade(pal.ground, 0.32));
  g.addColorStop(1, shade(pal.ground2, -0.3));
  ctx.fillStyle = g;
  ctx.fill();
  if (s > 3) {
    ctx.lineWidth = Math.min(1.4, s * 0.22);
    ctx.strokeStyle = 'rgba(8,10,18,0.75)';
    ctx.stroke();
  }
}

function paintChannel(ctx, o) {
  const { lanes, pal, pathW: Wd, k, W, H, ox, oy } = o;
  if (!lanes.length) return;
  const edge = pal.edge;
  const world = () => ctx.setTransform(k, 0, 0, k, ox, oy);
  world();

  // Outer glow
  if (filterOK) {
    ctx.save();
    ctx.filter = `blur(${(12 * k).toFixed(1)}px)`;
    strokeLanes(ctx, lanes, Wd + 30, rgba(edge, 0.32));
    ctx.restore();
  } else {
    strokeLanes(ctx, lanes, Wd + 44, rgba(edge, 0.05));
    strokeLanes(ctx, lanes, Wd + 30, rgba(edge, 0.08));
    strokeLanes(ctx, lanes, Wd + 18, rgba(edge, 0.12));
  }
  // Raised berm of displaced soil around the cut
  strokeLanes(ctx, lanes, Wd + 20, rgba(shade(pal.ground, 0.1), 0.55));
  // Glowing rim
  strokeLanes(ctx, lanes, Wd + 8, INK);
  strokeLanes(ctx, lanes, Wd + 5, edge);
  strokeLanes(ctx, lanes, Wd + 1.5, INK);
  // Trench walls and floor
  const wall = mix(pal.channel, pal.ground2, 0.45);
  strokeLanes(ctx, lanes, Wd, wall);
  strokeLanes(ctx, lanes, Wd - 12, pal.channel);
  strokeLanes(ctx, lanes, Wd - 13, pal.channel);

  // Bevel lighting via offset masks: shadow on the top-left inner wall, light on the bottom-right.
  const d = 5;
  const tmp = makeCanvas(W, H);
  const t = tmp.getContext('2d');
  const tw = () => t.setTransform(k, 0, 0, k, ox, oy);
  tw();
  strokeLanes(t, lanes, Wd, 'rgba(0,0,0,0.62)');
  t.globalCompositeOperation = 'destination-out';
  strokeLanes(t, lanes, Wd, '#000', d, d);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(tmp, 0, 0);
  t.setTransform(1, 0, 0, 1, 0, 0);
  t.globalCompositeOperation = 'source-over';
  t.clearRect(0, 0, W, H);
  tw();
  strokeLanes(t, lanes, Wd, rgba(mix(edge, '#ffffff', 0.5), 0.22));
  t.globalCompositeOperation = 'destination-out';
  strokeLanes(t, lanes, Wd, '#000', -d * 0.8, -d * 0.8);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(tmp, 0, 0);
  world();

  // Floor energy stripe and segment plates
  strokeLanes(ctx, lanes, Wd * 0.42, rgba(edge, 0.05));
  strokeLanes(ctx, lanes, 2, rgba(edge, 0.12));
  ctx.beginPath();
  const half = (Wd - 14) / 2;
  for (const lane of lanes) {
    const p = {};
    for (let s = lane.start + 20; s < lane.length - 30; s += 30) {
      lane.point(s, p);
      const nx = -Math.sin(p.angle), ny = Math.cos(p.angle);
      ctx.moveTo(p.x + nx * half, p.y + ny * half);
      ctx.lineTo(p.x - nx * half, p.y - ny * half);
    }
  }
  ctx.lineWidth = 1.2;
  ctx.strokeStyle = 'rgba(255,255,255,0.035)';
  ctx.stroke();
  // Rim studs: small lights along both edges
  ctx.fillStyle = rgba(mix(edge, '#ffffff', 0.6), 0.9);
  for (const lane of lanes) {
    const p = {};
    for (let s = lane.start + 40; s < lane.length - 40; s += 80) {
      lane.point(s, p);
      const nx = -Math.sin(p.angle), ny = Math.cos(p.angle);
      for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.arc(p.x + nx * side * (Wd / 2 + 1.8), p.y + ny * side * (Wd / 2 + 1.8), 1.6, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}
