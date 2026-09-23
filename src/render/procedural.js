// Procedural vector art: meteors, ships, titans, towers, core, portal, projectiles, fx sprites.
// Every function draws at the origin in WORLD units into a context that is already scaled
// (sprites.js makeSprite sets that up). These run once per sprite key, never per frame,
// so they are free to use gradients, shadowBlur and ctx.filter.
//
// Art direction: bright cartoon sci-fi, bold dark outlines, saturated crystal colors,
// light from the top-left.

export const INK = '#0b0d18';
export const LIGHT_ANGLE = Math.atan2(-0.8, -0.6); // light comes from the top-left
// Upgrade path colors, shared with the upgrade panel (src/ui/ui.js): teal, violet, amber.
export const PATH_COLORS = ['#3ef0d8', '#b494ff', '#ffb547'];
const TAU = Math.PI * 2;

// ---------------------------------------------------------------------------
// Color helpers
// ---------------------------------------------------------------------------

const _rgb = new Map();
export function parseColor(c) {
  if (Array.isArray(c)) return c;
  let v = _rgb.get(c);
  if (v) return v;
  let r = 255, g = 255, b = 255;
  if (typeof c === 'string') {
    if (c[0] === '#') {
      let h = c.slice(1);
      if (h.length === 3 || h.length === 4) h = h.slice(0, 3).split('').map((x) => x + x).join('');
      const n = parseInt(h.slice(0, 6), 16);
      if (!Number.isNaN(n)) { r = (n >> 16) & 255; g = (n >> 8) & 255; b = n & 255; }
    } else {
      const m = c.match(/rgba?\(([^)]+)\)/i);
      if (m) {
        const p = m[1].split(',').map((s) => parseFloat(s));
        r = p[0] || 0; g = p[1] || 0; b = p[2] || 0;
      } else {
        const hm = c.match(/hsla?\(([^)]+)\)/i);
        if (hm) {
          const p = hm[1].split(',').map((s) => parseFloat(s));
          const rgb = hslToRgb(p[0] || 0, (p[1] || 0) / 100, (p[2] || 0) / 100);
          r = rgb[0]; g = rgb[1]; b = rgb[2];
        }
      }
    }
  }
  v = [r, g, b];
  _rgb.set(c, v);
  return v;
}
function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360 / 360;
  const f = (n) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return [f(0), f(8), f(4)];
}
const clamp255 = (x) => Math.max(0, Math.min(255, Math.round(x)));
const hex2 = (x) => clamp255(x).toString(16).padStart(2, '0');
export function toHex(rgb) { return '#' + hex2(rgb[0]) + hex2(rgb[1]) + hex2(rgb[2]); }
export function mix(a, b, t) {
  const A = parseColor(a), B = parseColor(b);
  return toHex([A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t]);
}
// t in -1..1: negative darkens toward black, positive lightens toward white.
export function shade(c, t) { return t >= 0 ? mix(c, '#ffffff', t) : mix(c, '#000000', -t); }
export function rgba(c, a) { const [r, g, b] = parseColor(c); return `rgba(${r},${g},${b},${a})`; }
export function hsl(h, s, l) { return toHex(hslToRgb(h, s / 100, l / 100)); }
export function luminance(c) { const [r, g, b] = parseColor(c); return (0.299 * r + 0.587 * g + 0.114 * b) / 255; }
// Saturate/brighten a color so it reads as a glowing light.
export function glowColor(c) { return luminance(c) < 0.35 ? mix(c, '#ffffff', 0.35) : c; }

// ---------------------------------------------------------------------------
// Seeded randomness for deterministic art (visual only)
// ---------------------------------------------------------------------------

export function hashStr(s) {
  let h = 2166136261 >>> 0;
  s = String(s);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
export function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Shape helpers
// ---------------------------------------------------------------------------

export function polyPath(ctx, pts) {
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
}
function regular(n, r, rot = 0) {
  const pts = [];
  for (let i = 0; i < n; i++) { const a = rot + (i / n) * TAU; pts.push([Math.cos(a) * r, Math.sin(a) * r]); }
  return pts;
}
function circlePath(ctx, x, y, r) { ctx.beginPath(); ctx.arc(x, y, Math.max(0.01, r), 0, TAU); }
function roundRect(ctx, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function strokeInk(ctx, lw) { ctx.lineWidth = lw; ctx.strokeStyle = INK; ctx.stroke(); }
function pxScale(ctx) { const t = ctx.getTransform(); return Math.hypot(t.a, t.b) || 1; }
function withBlur(ctx, worldPx, fn) {
  const k = pxScale(ctx);
  const prev = ctx.filter;
  try { ctx.filter = `blur(${Math.max(0.5, worldPx * k).toFixed(2)}px)`; } catch { /* unsupported */ }
  fn();
  ctx.filter = prev || 'none';
}
// Soft light blob, drawn with a radial gradient (no shadowBlur).
export function drawGlow(ctx, r, color, inner = 0.0, alpha = 1) {
  const g = ctx.createRadialGradient(0, 0, r * inner, 0, 0, r);
  g.addColorStop(0, rgba(color, alpha));
  g.addColorStop(0.35, rgba(color, alpha * 0.45));
  g.addColorStop(0.7, rgba(color, alpha * 0.12));
  g.addColorStop(1, rgba(color, 0));
  ctx.fillStyle = g;
  circlePath(ctx, 0, 0, r);
  ctx.fill();
}

// ---------------------------------------------------------------------------
// Meteors
// ---------------------------------------------------------------------------

export const METEOR_FRAMES = 24;
export const METEOR_STEP = TAU / METEOR_FRAMES;

// n: vertex count, jit: radius jitter, spin: roll multiplier, table: top facet size.
const METEOR_CFG = {
  rust:     { n: 6,  jit: 0.18, spin: 1.2, table: 0.5 },
  cobalt:   { n: 6,  jit: 0.14, spin: 1.1, table: 0.5 },
  jade:     { n: 7,  jit: 0.14, spin: 1.0, table: 0.5 },
  amber:    { n: 7,  jit: 0.12, spin: 0.8, table: 0.52 },
  rose:     { n: 8,  jit: 0.12, spin: 0.8, table: 0.52 },
  iron:     { n: 9,  jit: 0.07, spin: 0.9, table: 0.55, contrast: 0.8 },
  magma:    { n: 8,  jit: 0.16, spin: 0.8, table: 0.48, contrast: 0.45 },
  comet:    { n: 7,  jit: 0.12, spin: 0.7, table: 0.5 },
  prism:    { n: 6,  jit: 0.03, spin: 0.9, table: 0.36 },
  geode:    { n: 11, jit: 0.2,  spin: 0.6, table: 0.62 },
  aurora:   { n: 8,  jit: 0.1,  spin: 0.6, table: 0.5 },
  obsidian: { n: 7,  jit: 0.14, spin: 0.35, table: 0.46, contrast: 0.6 },
};
export function meteorSpin(type) { return (METEOR_CFG[type] || METEOR_CFG.rust).spin; }

const _shapes = new Map();
export function meteorShape(type) {
  let s = _shapes.get(type);
  if (s) return s;
  const cfg = METEOR_CFG[type] || { n: 7, jit: 0.14, table: 0.5 };
  const R = rng(hashStr('meteor:' + type));
  const verts = [];
  for (let i = 0; i < cfg.n; i++) {
    const a = (i / cfg.n) * TAU + (R() - 0.5) * (TAU / cfg.n) * 0.55;
    verts.push([a, 1 - cfg.jit + R() * cfg.jit]);
  }
  const seeds = [];
  for (let i = 0; i < 16; i++) seeds.push(R());
  s = { verts, cfg, seeds };
  _shapes.set(type, s);
  return s;
}

function meteorPoints(type, r, rot) {
  const { verts } = meteorShape(type);
  return verts.map(([a, rr]) => [Math.cos(a + rot) * rr * r, Math.sin(a + rot) * rr * r]);
}

// Base colors for each meteor look (def.color is the identity color; these tune the facets).
function meteorColors(type, color) {
  switch (type) {
    case 'iron': return { base: '#8a94a6', light: '#eef3fb', dark: '#343a48' };
    case 'magma': return { base: '#4a2420', light: '#8a4a38', dark: '#140808' };
    case 'comet': return { base: '#cfeaff', light: '#ffffff', dark: '#5f8fbf' };
    case 'prism': return { base: '#a45bff', light: '#f0d8ff', dark: '#3d1680' };
    case 'geode': return { base: '#666c7c', light: '#aab0bf', dark: '#262a35' };
    case 'aurora': return { base: '#ffffff', light: '#ffffff', dark: '#8a9ad0' };
    case 'obsidian': return { base: '#2a1c44', light: '#9a6fe0', dark: '#07040e' };
    default: return { base: color, light: shade(color, 0.6), dark: shade(color, -0.6) };
  }
}

// Draw a meteor at the origin. o: { rot, phantom, nanite, plated, hue, color, silhouette }
export function drawMeteor(ctx, type, r, o = {}) {
  const rot = o.rot || 0;
  const shape = meteorShape(type);
  const cfg = shape.cfg;
  const col = meteorColors(type, o.color || '#ff4d4d');
  const P = meteorPoints(type, r, rot);
  const n = P.length;
  const lw = 1.25 + r * 0.085;

  if (o.silhouette) {
    polyPath(ctx, P);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.lineWidth = lw;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
    return;
  }

  // Drop shadow (fixed down-right in screen space).
  if (!o.phantom) {
    ctx.save();
    ctx.translate(r * 0.16 + 1, r * 0.26 + 1.5);
    withBlur(ctx, r * 0.1, () => {
      polyPath(ctx, P);
      ctx.fillStyle = 'rgba(0,0,0,0.38)';
      ctx.fill();
    });
    ctx.restore();
  }

  ctx.save();
  if (o.phantom) ctx.globalAlpha = 0.42;

  // Table (top facet), shifted toward the light so the gem reads as raised.
  const tf = cfg.table;
  const tcx = -0.1 * r, tcy = -0.12 * r;
  const T = P.map(([x, y]) => [tcx + x * tf, tcy + y * tf]);
  const contrast = cfg.contrast || 0.62;

  // Facets
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const mx = (P[i][0] + P[j][0]) / 2, my = (P[i][1] + P[j][1]) / 2;
    const phi = Math.atan2(my, mx);
    const b = Math.cos(phi - LIGHT_ANGLE);
    let fc;
    if (type === 'aurora') {
      const h = ((o.hue || 0) + (i / n) * 360) % 360;
      const c = hsl(h, 95, 68);
      fc = b >= 0 ? mix(c, '#ffffff', b * 0.45) : mix(c, '#3a3a80', -b * 0.35);
    } else {
      fc = b >= 0 ? mix(col.base, col.light, b * contrast) : mix(col.base, col.dark, -b * contrast);
    }
    ctx.beginPath();
    ctx.moveTo(P[i][0], P[i][1]);
    ctx.lineTo(P[j][0], P[j][1]);
    ctx.lineTo(T[j][0], T[j][1]);
    ctx.lineTo(T[i][0], T[i][1]);
    ctx.closePath();
    ctx.fillStyle = fc;
    ctx.fill();
    ctx.lineWidth = Math.max(0.35, r * 0.035);
    ctx.strokeStyle = fc;
    ctx.stroke(); // seal hairline gaps between facets
  }

  // Table face
  polyPath(ctx, T);
  if (type === 'geode') {
    // Cavity with cyan crystal interior
    const g = ctx.createRadialGradient(tcx, tcy, 0, tcx, tcy, r * tf * 1.1);
    g.addColorStop(0, '#0f2a33');
    g.addColorStop(1, '#141722');
    ctx.fillStyle = g;
    ctx.fill();
    ctx.save();
    polyPath(ctx, T);
    ctx.clip();
    const R = rng(hashStr('geode-in'));
    ctx.shadowColor = '#7ff';
    ctx.shadowBlur = r * 0.35 * pxScale(ctx);
    for (let i = 0; i < n; i++) {
      const [x, y] = T[i];
      const [x2, y2] = T[(i + 1) % n];
      const ex = (x + x2) / 2, ey = (y + y2) / 2;
      const len = 0.55 + R() * 0.35;
      const tx = ex + (tcx - ex) * len, ty = ey + (tcy - ey) * len;
      const ang = Math.atan2(ty - ey, tx - ex) + Math.PI / 2;
      const w = r * (0.1 + R() * 0.07);
      ctx.beginPath();
      ctx.moveTo(ex + Math.cos(ang) * w, ey + Math.sin(ang) * w);
      ctx.lineTo(tx, ty);
      ctx.lineTo(ex - Math.cos(ang) * w, ey - Math.sin(ang) * w);
      ctx.closePath();
      ctx.fillStyle = i % 2 ? '#8ffcff' : '#3fd6ea';
      ctx.fill();
    }
    ctx.shadowBlur = 0;
    circlePath(ctx, tcx - r * 0.05, tcy - r * 0.05, r * 0.1);
    ctx.fillStyle = '#e8ffff';
    ctx.fill();
    ctx.restore();
    ctx.lineWidth = Math.max(0.6, r * 0.06);
    ctx.strokeStyle = 'rgba(8,10,16,0.9)';
    polyPath(ctx, T);
    ctx.stroke();
  } else {
    let tc;
    if (type === 'aurora') {
      const g = ctx.createLinearGradient(tcx - r * tf, tcy - r * tf, tcx + r * tf, tcy + r * tf);
      g.addColorStop(0, hsl((o.hue || 0) + 40, 100, 90));
      g.addColorStop(0.5, '#ffffff');
      g.addColorStop(1, hsl((o.hue || 0) + 200, 100, 85));
      tc = g;
    } else if (type === 'magma') {
      const g = ctx.createRadialGradient(tcx, tcy, 0, tcx, tcy, r * tf);
      g.addColorStop(0, '#ffd08a');
      g.addColorStop(0.35, '#ff7a1a');
      g.addColorStop(1, '#6a2412');
      tc = g;
    } else {
      tc = mix(col.base, col.light, type === 'obsidian' ? 0.12 : 0.3);
    }
    ctx.fillStyle = tc;
    ctx.fill();
  }

  // Facet lines
  ctx.lineWidth = Math.max(0.4, r * 0.04);
  ctx.strokeStyle = type === 'obsidian' ? 'rgba(200,150,255,0.25)' : 'rgba(10,12,24,0.28)';
  ctx.beginPath();
  for (let i = 0; i < n; i++) { ctx.moveTo(P[i][0], P[i][1]); ctx.lineTo(T[i][0], T[i][1]); }
  ctx.stroke();
  if (type !== 'geode') {
    polyPath(ctx, T);
    ctx.strokeStyle = type === 'obsidian' ? 'rgba(210,170,255,0.35)' : 'rgba(255,255,255,0.35)';
    ctx.stroke();
  }

  // Type specific details
  if (type === 'iron') {
    // Rivets on the ring facets
    for (let i = 0; i < n; i += 1) {
      if (i % 2) continue;
      const j = (i + 1) % n;
      const mx = (P[i][0] + P[j][0] + T[i][0] + T[j][0]) / 4;
      const my = (P[i][1] + P[j][1] + T[i][1] + T[j][1]) / 4;
      circlePath(ctx, mx, my, r * 0.075);
      ctx.fillStyle = '#2a303c';
      ctx.fill();
      circlePath(ctx, mx - r * 0.025, my - r * 0.025, r * 0.03);
      ctx.fillStyle = '#dfe6f0';
      ctx.fill();
    }
    // Brushed streaks on the table
    ctx.save();
    polyPath(ctx, T);
    ctx.clip();
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = r * 0.04;
    for (let k = -2; k <= 2; k++) {
      ctx.beginPath();
      ctx.moveTo(tcx - r, tcy + k * r * 0.12 - r * 0.2);
      ctx.lineTo(tcx + r, tcy + k * r * 0.12 + r * 0.2);
      ctx.stroke();
    }
    ctx.restore();
  }
  if (type === 'magma' || type === 'obsidian') {
    // Glowing cracks / veins
    const R = rng(hashStr('veins:' + type));
    const glow = type === 'magma' ? '#ff6a00' : '#c77dff';
    const mid = type === 'magma' ? '#ffb347' : '#e2b6ff';
    const hot = type === 'magma' ? '#fff1c2' : '#ffffff';
    const lines = [];
    const count = type === 'magma' ? 4 : 3;
    for (let c = 0; c < count; c++) {
      const vi = Math.floor(R() * n);
      const pts = [[tcx * 0.6, tcy * 0.6]];
      const [ex, ey] = P[vi];
      const segs = 3;
      for (let s = 1; s <= segs; s++) {
        const t = s / segs;
        const jx = s < segs ? (R() - 0.5) * r * 0.28 : 0, jy = s < segs ? (R() - 0.5) * r * 0.28 : 0;
        pts.push([tcx * 0.6 * (1 - t) + ex * t * 0.92 + jx, tcy * 0.6 * (1 - t) + ey * t * 0.92 + jy]);
      }
      lines.push(pts);
    }
    ctx.save();
    polyPath(ctx, P);
    ctx.clip();
    const k = pxScale(ctx);
    const pass = (w, c, blur) => {
      ctx.lineWidth = w;
      ctx.strokeStyle = c;
      ctx.shadowColor = glow;
      ctx.shadowBlur = blur * k;
      for (const pts of lines) {
        ctx.beginPath();
        ctx.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
        ctx.stroke();
      }
    };
    pass(r * 0.2, rgba(glow, 0.55), r * 0.5);
    pass(r * 0.1, mid, r * 0.2);
    pass(r * 0.04, hot, 0);
    ctx.shadowBlur = 0;
    ctx.restore();
  }
  if (type === 'comet') {
    // Frost specks
    const R = rng(hashStr('frost'));
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    for (let i = 0; i < 7; i++) {
      const a = R() * TAU, d = R() * r * 0.75;
      circlePath(ctx, Math.cos(a) * d, Math.sin(a) * d, r * (0.04 + R() * 0.04));
      ctx.fill();
    }
  }
  if (type === 'prism') {
    // Rainbow sheen band
    ctx.save();
    polyPath(ctx, P);
    ctx.clip();
    ctx.globalCompositeOperation = 'source-atop';
    const g = ctx.createLinearGradient(-r, -r * 0.6, r, r * 0.6);
    const hues = [0, 45, 90, 170, 220, 280, 330];
    hues.forEach((h, i) => g.addColorStop(i / (hues.length - 1), rgba(hsl(h, 100, 65), 0.42)));
    ctx.fillStyle = g;
    ctx.fillRect(-r * 1.2, -r * 1.2, r * 2.4, r * 2.4);
    ctx.restore();
    // Inner prism lines
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = r * 0.05;
    ctx.beginPath();
    ctx.moveTo(T[0][0], T[0][1]); ctx.lineTo(T[3 % n][0], T[3 % n][1]);
    ctx.stroke();
  }

  // Specular glint
  if (type !== 'geode') {
    const gx = tcx - r * 0.2, gy = tcy - r * 0.18;
    ctx.fillStyle = type === 'obsidian' ? 'rgba(230,200,255,0.75)' : 'rgba(255,255,255,0.85)';
    ctx.beginPath();
    ctx.moveTo(gx - r * 0.14, gy + r * 0.02);
    ctx.lineTo(gx + r * 0.02, gy - r * 0.12);
    ctx.lineTo(gx + r * 0.1, gy - r * 0.06);
    ctx.lineTo(gx - r * 0.06, gy + r * 0.08);
    ctx.closePath();
    ctx.fill();
  }

  ctx.restore(); // phantom alpha

  // Outline
  polyPath(ctx, P);
  if (o.phantom) {
    ctx.lineWidth = lw * 1.9;
    ctx.strokeStyle = 'rgba(160,230,255,0.28)';
    ctx.stroke();
    ctx.lineWidth = lw * 0.75;
    ctx.strokeStyle = '#d8f4ff';
    ctx.setLineDash([r * 0.32, r * 0.18]);
    ctx.stroke();
    ctx.setLineDash([]);
  } else {
    strokeInk(ctx, lw);
  }

  // Modifiers
  if (o.plated) {
    const pr = r * 1.02;
    circlePath(ctx, 0, 0, pr);
    ctx.lineWidth = r * 0.3 + lw;
    ctx.strokeStyle = INK;
    ctx.stroke();
    const g = ctx.createLinearGradient(-pr, -pr, pr, pr);
    g.addColorStop(0, '#f1f5fb');
    g.addColorStop(0.45, '#a9b4c4');
    g.addColorStop(1, '#4d5666');
    ctx.lineWidth = r * 0.3;
    ctx.strokeStyle = g;
    ctx.stroke();
    ctx.lineWidth = r * 0.05;
    ctx.strokeStyle = 'rgba(20,24,34,0.5)';
    circlePath(ctx, 0, 0, pr);
    ctx.stroke();
    for (let i = 0; i < 6; i++) {
      const a = rot + (i / 6) * TAU;
      circlePath(ctx, Math.cos(a) * pr, Math.sin(a) * pr, r * 0.065);
      ctx.fillStyle = '#2b313d';
      ctx.fill();
    }
  }
  if (o.nanite) {
    const R = rng(hashStr('nanite:' + type));
    ctx.lineWidth = Math.max(0.5, r * 0.06);
    for (let i = 0; i < 4; i++) {
      const a = rot + R() * TAU;
      const d = r * (0.35 + R() * 0.4);
      const x = Math.cos(a) * d, y = Math.sin(a) * d;
      const s = r * 0.13;
      ctx.strokeStyle = '#1f7a4a';
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + Math.cos(a + 1.6) * r * 0.25, y + Math.sin(a + 1.6) * r * 0.25);
      ctx.stroke();
      ctx.fillStyle = INK;
      ctx.fillRect(x - s * 0.75, y - s * 0.75, s * 1.5, s * 1.5);
      ctx.fillStyle = '#4dff9a';
      ctx.fillRect(x - s * 0.5, y - s * 0.5, s, s);
    }
    polyPath(ctx, P);
    ctx.lineWidth = r * 0.07;
    ctx.strokeStyle = 'rgba(77,255,154,0.55)';
    ctx.setLineDash([r * 0.14, r * 0.22]);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

// Damage cracks for multi-HP meteors (obsidian). level 1..4. Drawn in the unrotated frame.
export function drawMeteorCracks(ctx, type, r, level, rot = 0) {
  ctx.rotate(rot);
  const P = meteorPoints(type, r, 0);
  const R = rng(hashStr('cracks:' + type));
  ctx.save();
  polyPath(ctx, P);
  ctx.clip();
  const k = pxScale(ctx);
  for (let c = 0; c < level * 2; c++) {
    let x = (R() - 0.5) * r * 0.5, y = (R() - 0.5) * r * 0.5;
    let a = R() * TAU;
    const pts = [[x, y]];
    for (let s = 0; s < 4; s++) {
      a += (R() - 0.5) * 1.3;
      const len = r * (0.18 + R() * 0.2);
      x += Math.cos(a) * len; y += Math.sin(a) * len;
      pts.push([x, y]);
    }
    const stroke = (w, col, blur) => {
      ctx.lineWidth = w; ctx.strokeStyle = col;
      ctx.shadowColor = '#d9a6ff'; ctx.shadowBlur = blur * k;
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      ctx.stroke();
    };
    stroke(r * 0.1, 'rgba(10,4,20,0.9)', 0);
    stroke(r * 0.045, '#f0dcff', r * 0.3);
  }
  ctx.shadowBlur = 0;
  ctx.restore();
}

export function drawCometTail(ctx, r) {
  // Tail extends toward -x (behind the direction of travel).
  const L = r * 3.4;
  const g = ctx.createLinearGradient(0, 0, -L, 0);
  g.addColorStop(0, 'rgba(230,248,255,0.95)');
  g.addColorStop(0.35, 'rgba(140,210,255,0.55)');
  g.addColorStop(1, 'rgba(120,180,255,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(r * 0.2, -r * 0.85);
  ctx.quadraticCurveTo(-L * 0.45, -r * 0.7, -L, 0);
  ctx.quadraticCurveTo(-L * 0.45, r * 0.7, r * 0.2, r * 0.85);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.beginPath();
  ctx.moveTo(0, -r * 0.35);
  ctx.quadraticCurveTo(-L * 0.4, -r * 0.2, -L * 0.75, 0);
  ctx.quadraticCurveTo(-L * 0.4, r * 0.2, 0, r * 0.35);
  ctx.closePath();
  ctx.fill();
}

export function drawIceCrust(ctx, r) {
  const R = rng(hashStr('ice'));
  const pts = [];
  const n = 8;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU + (R() - 0.5) * 0.4;
    const rr = r * (1.08 + R() * 0.22);
    pts.push([Math.cos(a) * rr, Math.sin(a) * rr]);
  }
  polyPath(ctx, pts);
  const g = ctx.createLinearGradient(-r, -r, r, r);
  g.addColorStop(0, 'rgba(235,250,255,0.8)');
  g.addColorStop(0.5, 'rgba(150,215,255,0.55)');
  g.addColorStop(1, 'rgba(90,160,230,0.6)');
  ctx.fillStyle = g;
  ctx.fill();
  ctx.lineWidth = 1 + r * 0.06;
  ctx.strokeStyle = 'rgba(20,50,90,0.9)';
  ctx.stroke();
  // Facet lines and highlights
  ctx.strokeStyle = 'rgba(255,255,255,0.7)';
  ctx.lineWidth = r * 0.05;
  ctx.beginPath();
  for (let i = 0; i < n; i += 2) { ctx.moveTo(pts[i][0] * 0.4, pts[i][1] * 0.4); ctx.lineTo(pts[i][0] * 0.9, pts[i][1] * 0.9); }
  ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.beginPath();
  ctx.moveTo(-r * 0.7, -r * 0.3); ctx.lineTo(-r * 0.3, -r * 0.75); ctx.lineTo(-r * 0.18, -r * 0.62); ctx.lineTo(-r * 0.58, -r * 0.18);
  ctx.closePath();
  ctx.fill();
}

export function drawFlame(ctx, r) {
  // Three flame tongues pointing up.
  const tongue = (x, h, w, c1, c2) => {
    const g = ctx.createLinearGradient(x, 0, x, -h);
    g.addColorStop(0, c1);
    g.addColorStop(1, c2);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(x - w, 0);
    ctx.quadraticCurveTo(x - w, -h * 0.55, x, -h);
    ctx.quadraticCurveTo(x + w, -h * 0.55, x + w, 0);
    ctx.quadraticCurveTo(x, w * 0.6, x - w, 0);
    ctx.fill();
  };
  tongue(-r * 0.45, r * 1.2, r * 0.35, 'rgba(255,90,20,0.85)', 'rgba(255,60,0,0)');
  tongue(r * 0.45, r * 1.1, r * 0.32, 'rgba(255,90,20,0.85)', 'rgba(255,60,0,0)');
  tongue(0, r * 1.6, r * 0.42, 'rgba(255,170,40,0.95)', 'rgba(255,120,0,0)');
  tongue(0, r * 0.9, r * 0.22, 'rgba(255,245,180,0.95)', 'rgba(255,220,120,0)');
}

export function drawSparkStar(ctx, r, color = '#fff27a') {
  ctx.fillStyle = color;
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * TAU;
    const rr = i % 2 ? r * 0.28 : r;
    ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
  }
  ctx.closePath();
  ctx.fill();
  circlePath(ctx, 0, 0, r * 0.25);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
}

// A streak behind a slowed enemy (points toward -x).
export function drawSlowTrail(ctx, r) {
  const L = r * 2.6;
  const g = ctx.createLinearGradient(0, 0, -L, 0);
  g.addColorStop(0, 'rgba(120,200,255,0.55)');
  g.addColorStop(1, 'rgba(120,200,255,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(0, -r * 0.8);
  ctx.lineTo(-L, -r * 0.2);
  ctx.lineTo(-L, r * 0.2);
  ctx.lineTo(0, r * 0.8);
  ctx.closePath();
  ctx.fill();
}

// ---------------------------------------------------------------------------
// Ships (drawn facing +x, centered at the origin; R = def radius)
// ---------------------------------------------------------------------------

// Engine glow positions [x, y, size] in units of R, and glow color.
export const SHIP_ENGINES = {
  hauler: { pts: [[-1.02, -0.26, 0.2], [-1.02, 0.26, 0.2]], color: '#5fd4ff' },
  warbarge: { pts: [[-1.0, -0.3, 0.18], [-1.04, 0, 0.2], [-1.0, 0.3, 0.18]], color: '#ff8a3d' },
  dreadnought: { pts: [[-1.06, -0.22, 0.2], [-1.06, 0.22, 0.2], [-0.95, -0.5, 0.12], [-0.95, 0.5, 0.12]], color: '#7dffb0' },
  specter: { pts: [[-0.66, -0.14, 0.15], [-0.66, 0.14, 0.15]], color: '#b48cff' },
  worldbreaker: { pts: [[-0.98, -0.34, 0.16], [-1.02, 0, 0.19], [-0.98, 0.34, 0.16]], color: '#ff4d6d' },
  maw: { pts: [[-1.05, 0, 0.22]], color: '#ff6a3d' },
  aegis: { pts: [[-1.0, -0.3, 0.18], [-1.0, 0.3, 0.18]], color: '#ffd166' },
  rift: { pts: [[-0.95, 0, 0.24]], color: '#d06bff' },
};

function hullGradient(ctx, R, c) {
  const g = ctx.createLinearGradient(0, -R * 0.6, 0, R * 0.6);
  g.addColorStop(0, shade(c, 0.28));
  g.addColorStop(0.5, c);
  g.addColorStop(1, shade(c, -0.35));
  return g;
}
function nozzle(ctx, x, y, w, h) {
  roundRect(ctx, x, y - h / 2, w, h, h * 0.25);
  ctx.fillStyle = '#2a2f3b';
  ctx.fill();
  strokeInk(ctx, 1.6);
  roundRect(ctx, x + w * 0.1, y - h * 0.32, w * 0.35, h * 0.64, h * 0.15);
  ctx.fillStyle = '#10131b';
  ctx.fill();
}
function turret(ctx, x, y, r, c, barrels = 2, len = 1.4) {
  // Barrels forward (+x)
  for (let b = 0; b < barrels; b++) {
    const oy = barrels === 1 ? 0 : (b - (barrels - 1) / 2) * r * 0.55;
    roundRect(ctx, x, y + oy - r * 0.16, r * len, r * 0.32, r * 0.1);
    ctx.fillStyle = '#3b4250';
    ctx.fill();
    strokeInk(ctx, 1.3);
  }
  circlePath(ctx, x, y, r);
  const g = ctx.createRadialGradient(x - r * 0.3, y - r * 0.3, r * 0.1, x, y, r);
  g.addColorStop(0, shade(c, 0.4));
  g.addColorStop(1, shade(c, -0.25));
  ctx.fillStyle = g;
  ctx.fill();
  strokeInk(ctx, 1.6);
  circlePath(ctx, x, y, r * 0.35);
  ctx.fillStyle = shade(c, -0.45);
  ctx.fill();
}
function windowStrip(ctx, x, y, w, h) {
  roundRect(ctx, x, y, w, h, h / 2);
  ctx.fillStyle = '#7fe8ff';
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = INK;
  ctx.stroke();
}
function rivetsLine(ctx, x0, y0, x1, y1, n, s) {
  ctx.fillStyle = 'rgba(10,12,20,0.55)';
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    circlePath(ctx, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, s);
    ctx.fill();
  }
}

export function drawShip(ctx, type, R, color) {
  const lw = 2.2 + R * 0.02;
  switch (type) {
    case 'hauler': {
      const c = color || '#4f6d8f';
      nozzle(ctx, -R * 1.08, -R * 0.26, R * 0.3, R * 0.26);
      nozzle(ctx, -R * 1.08, R * 0.26, R * 0.3, R * 0.26);
      // Side rails
      roundRect(ctx, -R * 0.82, -R * 0.56, R * 1.3, R * 1.12, R * 0.12);
      ctx.fillStyle = shade(c, -0.35);
      ctx.fill();
      strokeInk(ctx, lw);
      // Bow
      polyPath(ctx, [[R * 0.45, -R * 0.44], [R * 0.9, -R * 0.24], [R * 1.04, 0], [R * 0.9, R * 0.24], [R * 0.45, R * 0.44]]);
      ctx.fillStyle = hullGradient(ctx, R, shade(c, 0.1));
      ctx.fill();
      strokeInk(ctx, lw);
      // Main hull
      roundRect(ctx, -R * 0.9, -R * 0.46, R * 1.42, R * 0.92, R * 0.14);
      ctx.fillStyle = hullGradient(ctx, R, c);
      ctx.fill();
      strokeInk(ctx, lw);
      // Cockpit
      polyPath(ctx, [[R * 0.62, -R * 0.14], [R * 0.86, -R * 0.08], [R * 0.9, 0], [R * 0.86, R * 0.08], [R * 0.62, R * 0.14]]);
      ctx.fillStyle = '#8ff0ff';
      ctx.fill();
      strokeInk(ctx, 1.4);
      // Cargo containers (2 x 3)
      const cols = ['#f08a3c', '#3fb3a8', '#e6c64a', '#d9573f', '#5c8fd6', '#f08a3c'];
      let ci = 0;
      for (let row = 0; row < 2; row++) {
        for (let col = 0; col < 3; col++) {
          const x = -R * 0.8 + col * R * 0.42, y = -R * 0.38 + row * R * 0.4;
          roundRect(ctx, x, y, R * 0.38, R * 0.36, R * 0.04);
          const cc = cols[ci++ % cols.length];
          const g = ctx.createLinearGradient(0, y, 0, y + R * 0.36);
          g.addColorStop(0, shade(cc, 0.25)); g.addColorStop(1, shade(cc, -0.25));
          ctx.fillStyle = g;
          ctx.fill();
          strokeInk(ctx, 1.3);
          ctx.strokeStyle = 'rgba(0,0,0,0.3)';
          ctx.lineWidth = 0.9;
          ctx.beginPath();
          for (let k = 1; k < 4; k++) { ctx.moveTo(x + (R * 0.38 * k) / 4, y + 2); ctx.lineTo(x + (R * 0.38 * k) / 4, y + R * 0.36 - 2); }
          ctx.stroke();
        }
      }
      break;
    }
    case 'warbarge': {
      const c = color || '#8f4f4f';
      for (const y of [-0.3, 0, 0.3]) nozzle(ctx, -R * 1.08, R * y, R * 0.28, R * 0.22);
      // Sponsons
      for (const s of [-1, 1]) {
        roundRect(ctx, -R * 0.55, s > 0 ? R * 0.42 : -R * 0.7, R * 0.8, R * 0.28, R * 0.08);
        ctx.fillStyle = shade(c, -0.3);
        ctx.fill();
        strokeInk(ctx, lw);
      }
      const hull = [[-R * 0.98, -R * 0.52], [R * 0.5, -R * 0.56], [R * 0.9, -R * 0.3], [R * 1.08, 0], [R * 0.9, R * 0.3], [R * 0.5, R * 0.56], [-R * 0.98, R * 0.52], [-R * 1.04, 0]];
      polyPath(ctx, hull);
      ctx.fillStyle = hullGradient(ctx, R, c);
      ctx.fill();
      strokeInk(ctx, lw);
      // Armor plate lines
      ctx.strokeStyle = 'rgba(0,0,0,0.35)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(-R * 0.9, -R * 0.3); ctx.lineTo(R * 0.6, -R * 0.33);
      ctx.moveTo(-R * 0.9, R * 0.3); ctx.lineTo(R * 0.6, R * 0.33);
      ctx.moveTo(R * 0.55, -R * 0.5); ctx.lineTo(R * 0.55, R * 0.5);
      ctx.moveTo(-R * 0.45, -R * 0.52); ctx.lineTo(-R * 0.45, R * 0.52);
      ctx.stroke();
      rivetsLine(ctx, -R * 0.85, -R * 0.42, R * 0.45, -R * 0.45, 8, R * 0.02);
      rivetsLine(ctx, -R * 0.85, R * 0.42, R * 0.45, R * 0.45, 8, R * 0.02);
      // Hazard stripes on the bow
      ctx.save();
      polyPath(ctx, [[R * 0.62, -R * 0.44], [R * 0.9, -R * 0.3], [R * 1.08, 0], [R * 0.9, R * 0.3], [R * 0.62, R * 0.44]]);
      ctx.clip();
      ctx.fillStyle = '#f2c230';
      ctx.fillRect(R * 0.6, -R * 0.6, R * 0.6, R * 1.2);
      ctx.fillStyle = '#1a1a1a';
      for (let i = -6; i < 6; i++) {
        ctx.beginPath();
        const x = R * 0.6 + i * R * 0.12;
        ctx.moveTo(x, -R * 0.6); ctx.lineTo(x + R * 0.06, -R * 0.6); ctx.lineTo(x + R * 0.06 + R * 0.6, R * 0.6); ctx.lineTo(x + R * 0.6, R * 0.6);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
      polyPath(ctx, [[R * 0.62, -R * 0.44], [R * 0.9, -R * 0.3], [R * 1.08, 0], [R * 0.9, R * 0.3], [R * 0.62, R * 0.44]]);
      strokeInk(ctx, lw * 0.8);
      turret(ctx, R * 0.25, 0, R * 0.2, shade(c, -0.1), 2, 1.5);
      turret(ctx, -R * 0.4, 0, R * 0.22, shade(c, -0.1), 2, 1.4);
      windowStrip(ctx, -R * 0.12, -R * 0.06, R * 0.1, R * 0.12);
      break;
    }
    case 'dreadnought': {
      const c = color || '#3f7f5a';
      for (const y of [-0.22, 0.22]) nozzle(ctx, -R * 1.12, R * y, R * 0.3, R * 0.26);
      for (const y of [-0.5, 0.5]) nozzle(ctx, -R * 1.0, R * y, R * 0.2, R * 0.16);
      // Sponsons
      for (const s of [-1, 1]) {
        polyPath(ctx, [[-R * 0.92, s * R * 0.36], [R * 0.2, s * R * 0.4], [R * 0.05, s * R * 0.62], [-R * 0.85, s * R * 0.62]]);
        ctx.fillStyle = shade(c, -0.32);
        ctx.fill();
        strokeInk(ctx, lw);
        turret(ctx, -R * 0.55, s * R * 0.5, R * 0.1, shade(c, -0.15), 1, 1.8);
        turret(ctx, -R * 0.2, s * R * 0.5, R * 0.1, shade(c, -0.15), 1, 1.8);
      }
      const hull = [[-R * 1.02, -R * 0.4], [R * 0.3, -R * 0.46], [R * 0.82, -R * 0.28], [R * 1.12, 0], [R * 0.82, R * 0.28], [R * 0.3, R * 0.46], [-R * 1.02, R * 0.4]];
      polyPath(ctx, hull);
      ctx.fillStyle = hullGradient(ctx, R, c);
      ctx.fill();
      strokeInk(ctx, lw);
      // Deck stripe
      roundRect(ctx, -R * 0.95, -R * 0.08, R * 1.75, R * 0.16, R * 0.05);
      ctx.fillStyle = shade(c, -0.28);
      ctx.fill();
      // Superstructure
      roundRect(ctx, -R * 0.42, -R * 0.26, R * 0.5, R * 0.52, R * 0.08);
      ctx.fillStyle = hullGradient(ctx, R * 0.5, shade(c, 0.18));
      ctx.fill();
      strokeInk(ctx, lw * 0.8);
      roundRect(ctx, -R * 0.3, -R * 0.16, R * 0.28, R * 0.32, R * 0.06);
      ctx.fillStyle = shade(c, 0.32);
      ctx.fill();
      strokeInk(ctx, 1.2);
      windowStrip(ctx, -R * 0.06, -R * 0.12, R * 0.05, R * 0.24);
      turret(ctx, R * 0.62, 0, R * 0.13, shade(c, -0.1), 2, 1.6);
      turret(ctx, R * 0.32, 0, R * 0.15, shade(c, -0.1), 2, 1.6);
      turret(ctx, -R * 0.72, -R * 0.2, R * 0.11, shade(c, -0.1), 2, 1.5);
      turret(ctx, -R * 0.72, R * 0.2, R * 0.11, shade(c, -0.1), 2, 1.5);
      rivetsLine(ctx, -R * 0.95, -R * 0.33, R * 0.3, -R * 0.38, 12, R * 0.015);
      rivetsLine(ctx, -R * 0.95, R * 0.33, R * 0.3, R * 0.38, 12, R * 0.015);
      break;
    }
    case 'specter': {
      const c = color || '#20242c';
      const wing = [[R * 1.08, 0], [-R * 0.18, -R * 0.96], [-R * 0.58, -R * 0.86], [-R * 0.3, -R * 0.26], [-R * 0.78, 0], [-R * 0.3, R * 0.26], [-R * 0.58, R * 0.86], [-R * 0.18, R * 0.96]];
      polyPath(ctx, wing);
      const g = ctx.createLinearGradient(-R, -R, R, R);
      g.addColorStop(0, '#3a4050');
      g.addColorStop(0.5, c);
      g.addColorStop(1, '#0c0e14');
      ctx.fillStyle = g;
      ctx.fill();
      strokeInk(ctx, lw);
      // Panel facets
      ctx.fillStyle = 'rgba(255,255,255,0.06)';
      polyPath(ctx, [[R * 1.08, 0], [-R * 0.18, -R * 0.96], [-R * 0.3, -R * 0.26], [-R * 0.1, 0]]);
      ctx.fill();
      ctx.strokeStyle = 'rgba(160,140,255,0.35)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(R * 0.9, 0); ctx.lineTo(-R * 0.3, -R * 0.26);
      ctx.moveTo(R * 0.9, 0); ctx.lineTo(-R * 0.3, R * 0.26);
      ctx.stroke();
      // Edge lights
      ctx.strokeStyle = '#a58bff';
      ctx.lineWidth = 1.4;
      ctx.shadowColor = '#a58bff';
      ctx.shadowBlur = 4 * pxScale(ctx);
      ctx.beginPath();
      ctx.moveTo(R * 0.95, -R * 0.05); ctx.lineTo(-R * 0.12, -R * 0.86);
      ctx.moveTo(R * 0.95, R * 0.05); ctx.lineTo(-R * 0.12, R * 0.86);
      ctx.stroke();
      // Cockpit slit
      ctx.strokeStyle = '#e0d4ff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(R * 0.25, 0); ctx.lineTo(R * 0.72, 0);
      ctx.stroke();
      ctx.shadowBlur = 0;
      break;
    }
    case 'worldbreaker': {
      const c = color || '#2a2d3a';
      for (const y of [-0.34, 0, 0.34]) nozzle(ctx, -R * 1.06, R * y, R * 0.26, R * 0.22);
      // Pylons on the diagonals
      for (const a of [Math.PI / 4, (3 * Math.PI) / 4, (5 * Math.PI) / 4, (7 * Math.PI) / 4]) {
        ctx.save();
        ctx.rotate(a);
        polyPath(ctx, [[R * 0.5, -R * 0.2], [R * 1.02, -R * 0.13], [R * 1.08, 0], [R * 1.02, R * 0.13], [R * 0.5, R * 0.2]]);
        ctx.fillStyle = hullGradient(ctx, R * 0.4, shade(c, 0.15));
        ctx.fill();
        strokeInk(ctx, lw);
        circlePath(ctx, R * 0.98, 0, R * 0.05);
        ctx.fillStyle = '#ff4d6d';
        ctx.fill();
        ctx.restore();
      }
      // Bow ram
      polyPath(ctx, [[R * 0.6, -R * 0.24], [R * 1.14, 0], [R * 0.6, R * 0.24]]);
      ctx.fillStyle = shade(c, 0.25);
      ctx.fill();
      strokeInk(ctx, lw);
      // Octagonal core
      const oct = regular(8, R * 0.78, Math.PI / 8);
      polyPath(ctx, oct);
      ctx.fillStyle = hullGradient(ctx, R, c);
      ctx.fill();
      strokeInk(ctx, lw * 1.1);
      // Ring
      circlePath(ctx, 0, 0, R * 0.58);
      ctx.fillStyle = shade(c, 0.12);
      ctx.fill();
      strokeInk(ctx, lw * 0.8);
      ctx.strokeStyle = 'rgba(0,0,0,0.35)';
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * TAU + Math.PI / 8;
        ctx.moveTo(Math.cos(a) * R * 0.58, Math.sin(a) * R * 0.58);
        ctx.lineTo(Math.cos(a) * R * 0.76, Math.sin(a) * R * 0.76);
      }
      ctx.stroke();
      // Turret nodes on the ring
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * TAU;
        turret(ctx, Math.cos(a) * R * 0.46, Math.sin(a) * R * 0.46, R * 0.08, '#555b6e', 1, 1.6);
      }
      // Red core dome
      const k = pxScale(ctx);
      ctx.shadowColor = '#ff2d55';
      ctx.shadowBlur = R * 0.3 * k;
      circlePath(ctx, 0, 0, R * 0.28);
      const g = ctx.createRadialGradient(-R * 0.08, -R * 0.08, 0, 0, 0, R * 0.28);
      g.addColorStop(0, '#ffd0d8');
      g.addColorStop(0.35, '#ff4d6d');
      g.addColorStop(1, '#6a0f22');
      ctx.fillStyle = g;
      ctx.fill();
      ctx.shadowBlur = 0;
      strokeInk(ctx, lw);
      break;
    }
    default: {
      // Generic ship: rounded hull in the def color.
      const c = color || '#667';
      nozzle(ctx, -R * 1.05, 0, R * 0.3, R * 0.3);
      polyPath(ctx, [[-R * 0.9, -R * 0.5], [R * 0.6, -R * 0.45], [R * 1.05, 0], [R * 0.6, R * 0.45], [-R * 0.9, R * 0.5]]);
      ctx.fillStyle = hullGradient(ctx, R, c);
      ctx.fill();
      strokeInk(ctx, lw);
      windowStrip(ctx, R * 0.4, -R * 0.1, R * 0.3, R * 0.2);
    }
  }
}

// Titans (R = enemy radius). Shield bubble and unstable glow are drawn per frame by the renderer.
export function drawTitan(ctx, kind, R) {
  const lw = 2.6 + R * 0.02;
  const k = pxScale(ctx);
  if (kind === 'maw') {
    const c = '#6a1b2c';
    // Tail
    polyPath(ctx, [[-R * 0.7, -R * 0.2], [-R * 1.15, -R * 0.08], [-R * 1.2, 0], [-R * 1.15, R * 0.08], [-R * 0.7, R * 0.2]]);
    ctx.fillStyle = shade(c, -0.25);
    ctx.fill();
    strokeInk(ctx, lw);
    // Spines
    for (let i = 0; i < 5; i++) {
      const x = -R * 0.55 + i * R * 0.24;
      for (const s of [-1, 1]) {
        polyPath(ctx, [[x - R * 0.1, s * R * 0.42], [x + R * 0.02, s * R * 0.72], [x + R * 0.1, s * R * 0.42]]);
        ctx.fillStyle = '#e8d8c0';
        ctx.fill();
        strokeInk(ctx, lw * 0.6);
      }
    }
    // Body
    ctx.beginPath();
    ctx.ellipse(-R * 0.05, 0, R * 0.78, R * 0.52, 0, 0, TAU);
    const g = ctx.createRadialGradient(-R * 0.2, -R * 0.2, R * 0.1, 0, 0, R * 0.8);
    g.addColorStop(0, shade(c, 0.35));
    g.addColorStop(0.6, c);
    g.addColorStop(1, shade(c, -0.45));
    ctx.fillStyle = g;
    ctx.fill();
    strokeInk(ctx, lw);
    // Armor plates
    ctx.strokeStyle = 'rgba(0,0,0,0.4)';
    ctx.lineWidth = 1.5;
    for (let i = 0; i < 4; i++) {
      ctx.beginPath();
      ctx.ellipse(-R * 0.05 - i * R * 0.18, 0, R * 0.2, R * (0.48 - i * 0.05), 0, -Math.PI / 2, Math.PI / 2);
      ctx.stroke();
    }
    // Throat glow
    ctx.save();
    ctx.shadowColor = '#ff7a2a';
    ctx.shadowBlur = R * 0.35 * k;
    ctx.beginPath();
    ctx.ellipse(R * 0.72, 0, R * 0.3, R * 0.26, 0, 0, TAU);
    const tg = ctx.createRadialGradient(R * 0.72, 0, 0, R * 0.72, 0, R * 0.3);
    tg.addColorStop(0, '#fff0b0');
    tg.addColorStop(0.4, '#ff8a2a');
    tg.addColorStop(1, '#8a1010');
    ctx.fillStyle = tg;
    ctx.fill();
    ctx.restore();
    // Mandibles with teeth
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(R * 0.35, s * R * 0.42);
      ctx.quadraticCurveTo(R * 1.0, s * R * 0.62, R * 1.22, s * R * 0.12);
      ctx.quadraticCurveTo(R * 0.95, s * R * 0.3, R * 0.55, s * R * 0.2);
      ctx.closePath();
      const mg = ctx.createLinearGradient(R * 0.4, 0, R * 1.2, 0);
      mg.addColorStop(0, shade(c, 0.1));
      mg.addColorStop(1, shade(c, -0.3));
      ctx.fillStyle = mg;
      ctx.fill();
      strokeInk(ctx, lw);
      for (let t = 0; t < 4; t++) {
        const tx = R * (0.62 + t * 0.14);
        const ty = s * R * (0.24 - t * 0.02);
        polyPath(ctx, [[tx - R * 0.05, ty], [tx, ty - s * R * 0.12], [tx + R * 0.05, ty]]);
        ctx.fillStyle = '#f4ead8';
        ctx.fill();
        strokeInk(ctx, 1);
      }
    }
    // Eyes
    for (const [x, y] of [[R * 0.3, -R * 0.22], [R * 0.3, R * 0.22], [R * 0.14, -R * 0.3], [R * 0.14, R * 0.3]]) {
      ctx.save();
      ctx.shadowColor = '#ffe14d';
      ctx.shadowBlur = R * 0.1 * k;
      circlePath(ctx, x, y, R * 0.055);
      ctx.fillStyle = '#ffe14d';
      ctx.fill();
      ctx.restore();
      strokeInk(ctx, 1);
    }
    return;
  }
  if (kind === 'aegis') {
    const c = '#9c8450';
    for (const y of [-0.3, 0.3]) nozzle(ctx, -R * 1.08, R * y, R * 0.28, R * 0.26);
    const hull = regular(6, R * 0.86, 0).map(([x, y]) => [x * 1.08, y * 0.85]);
    polyPath(ctx, hull);
    ctx.fillStyle = hullGradient(ctx, R, c);
    ctx.fill();
    strokeInk(ctx, lw);
    // Armor plates
    const inner = regular(6, R * 0.6, 0).map(([x, y]) => [x * 1.08, y * 0.85]);
    polyPath(ctx, inner);
    ctx.fillStyle = hullGradient(ctx, R * 0.7, shade(c, 0.12));
    ctx.fill();
    strokeInk(ctx, lw * 0.8);
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    for (let i = 0; i < 6; i++) { ctx.moveTo(inner[i][0], inner[i][1]); ctx.lineTo(hull[i][0], hull[i][1]); }
    ctx.stroke();
    // Emitter nodes
    for (let i = 0; i < 6; i++) {
      const [x, y] = hull[i];
      ctx.save();
      ctx.shadowColor = '#6ff3ff';
      ctx.shadowBlur = R * 0.12 * k;
      circlePath(ctx, x * 0.88, y * 0.88, R * 0.08);
      ctx.fillStyle = '#9ff8ff';
      ctx.fill();
      ctx.restore();
      strokeInk(ctx, 1.4);
    }
    // Core
    circlePath(ctx, 0, 0, R * 0.26);
    const g = ctx.createRadialGradient(-R * 0.08, -R * 0.08, 0, 0, 0, R * 0.26);
    g.addColorStop(0, '#ffffff');
    g.addColorStop(0.4, '#8ff0ff');
    g.addColorStop(1, '#2a6f8a');
    ctx.fillStyle = g;
    ctx.fill();
    strokeInk(ctx, lw);
    return;
  }
  if (kind === 'rift') {
    const c = '#2a1640';
    const R2 = rng(hashStr('rift'));
    // Shard ring
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * TAU + R2() * 0.2;
      const len = R * (0.85 + R2() * 0.35);
      const w = R * (0.14 + R2() * 0.08);
      ctx.save();
      ctx.rotate(a);
      polyPath(ctx, [[R * 0.3, -w], [len, 0], [R * 0.3, w]]);
      const g = ctx.createLinearGradient(R * 0.3, 0, len, 0);
      g.addColorStop(0, '#4a2a70');
      g.addColorStop(1, '#170a28');
      ctx.fillStyle = g;
      ctx.fill();
      strokeInk(ctx, lw * 0.8);
      ctx.strokeStyle = '#5ff0ff';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(R * 0.35, 0); ctx.lineTo(len * 0.85, 0);
      ctx.stroke();
      ctx.restore();
    }
    // Body
    const body = regular(7, R * 0.58, 0.3);
    polyPath(ctx, body);
    ctx.fillStyle = hullGradient(ctx, R, c);
    ctx.fill();
    strokeInk(ctx, lw);
    // Fissures
    ctx.save();
    ctx.shadowColor = '#e06bff';
    ctx.shadowBlur = R * 0.15 * k;
    ctx.strokeStyle = '#f0a8ff';
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    for (let i = 0; i < 7; i++) {
      ctx.moveTo(0, 0);
      const [x, y] = body[i];
      ctx.lineTo(x * 0.5 + (R2() - 0.5) * R * 0.1, y * 0.5 + (R2() - 0.5) * R * 0.1);
      ctx.lineTo(x * 0.92, y * 0.92);
    }
    ctx.stroke();
    // Eye
    circlePath(ctx, 0, 0, R * 0.2);
    const eg = ctx.createRadialGradient(0, 0, 0, 0, 0, R * 0.2);
    eg.addColorStop(0, '#ffffff');
    eg.addColorStop(0.45, '#ff9cf5');
    eg.addColorStop(1, '#7a1fb0');
    ctx.fillStyle = eg;
    ctx.fill();
    ctx.restore();
    strokeInk(ctx, lw);
    return;
  }
  // Unknown titan kind: a scaled-up dreadnought silhouette.
  drawShip(ctx, 'dreadnought', R, '#6b4f8f');
}

// Hexagonal energy shield bubble (aegis). Drawn per frame with alpha from shield fraction.
export function drawShieldBubble(ctx, R) {
  const g = ctx.createRadialGradient(0, 0, R * 0.6, 0, 0, R);
  g.addColorStop(0, 'rgba(120,240,255,0.02)');
  g.addColorStop(0.85, 'rgba(120,240,255,0.16)');
  g.addColorStop(1, 'rgba(180,250,255,0.55)');
  circlePath(ctx, 0, 0, R);
  ctx.fillStyle = g;
  ctx.fill();
  ctx.save();
  circlePath(ctx, 0, 0, R);
  ctx.clip();
  ctx.strokeStyle = 'rgba(160,245,255,0.35)';
  ctx.lineWidth = 1.2;
  const s = R * 0.2;
  const h = s * Math.sqrt(3) / 2;
  ctx.beginPath();
  for (let row = -8; row <= 8; row++) {
    for (let col = -8; col <= 8; col++) {
      const cx = col * s * 1.5, cy = row * h * 2 + (col % 2 ? h : 0);
      if (cx * cx + cy * cy > R * R * 1.1) continue;
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * TAU, b = ((i + 1) / 6) * TAU;
        ctx.moveTo(cx + Math.cos(a) * s * 0.95, cy + Math.sin(a) * s * 0.95);
        ctx.lineTo(cx + Math.cos(b) * s * 0.95, cy + Math.sin(b) * s * 0.95);
      }
    }
  }
  ctx.stroke();
  ctx.restore();
  circlePath(ctx, 0, 0, R);
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(200,252,255,0.85)';
  ctx.stroke();
  // Highlight arc
  ctx.beginPath();
  ctx.arc(0, 0, R * 0.86, Math.PI * 1.1, Math.PI * 1.45);
  ctx.lineWidth = R * 0.06;
  ctx.strokeStyle = 'rgba(255,255,255,0.5)';
  ctx.stroke();
}

// Crack overlay for ships (level 1..3); the caller masks it with the hull silhouette.
// Short dark fractures with a lit lower edge, scorch marks, and ember glints when badly hurt.
export function drawShipCracks(ctx, R, level, seedKey) {
  const R2 = rng(hashStr('shipcrack:' + seedKey));
  const counts = [0, 3, 6, 10];
  const n = counts[Math.min(3, level)];
  const k = pxScale(ctx);
  // Scorch blotches first (under the fractures); own RNG so fractures stay put as damage grows
  const R3 = rng(hashStr('scorch:' + seedKey));
  for (let i = 0; i < level * 2; i++) {
    const x = (R3() - 0.5) * R * 1.3, y = (R3() - 0.5) * R * 0.6;
    const rr = R * (0.1 + R3() * 0.12);
    const g = ctx.createRadialGradient(x, y, 0, x, y, rr);
    g.addColorStop(0, 'rgba(10,8,12,0.55)');
    g.addColorStop(1, 'rgba(10,8,12,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - rr, y - rr, rr * 2, rr * 2);
  }
  const embers = [];
  for (let c = 0; c < n; c++) {
    let x = (R2() - 0.5) * R * 1.5, y = (R2() - 0.5) * R * 0.75;
    let a = R2() * TAU;
    const pts = [[x, y]];
    const segs = 2 + Math.floor(R2() * 2);
    for (let s = 0; s < segs; s++) {
      a += (R2() - 0.5) * 1.6;
      const len = R * (0.05 + R2() * 0.07);
      x += Math.cos(a) * len; y += Math.sin(a) * len;
      pts.push([x, y]);
    }
    const line = (dx, dy, w, col) => {
      ctx.lineWidth = w; ctx.strokeStyle = col;
      ctx.beginPath();
      ctx.moveTo(pts[0][0] + dx, pts[0][1] + dy);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0] + dx, pts[i][1] + dy);
      ctx.stroke();
      // a short branch from the middle
      if (pts.length > 2) {
        const [mx, my] = pts[1];
        ctx.beginPath();
        ctx.moveTo(mx + dx, my + dy);
        ctx.lineTo(mx + dx + Math.cos(a + 1.2) * R * 0.05, my + dy + Math.sin(a + 1.2) * R * 0.05);
        ctx.stroke();
      }
    };
    line(R * 0.012, R * 0.012, Math.max(1, R * 0.02), 'rgba(255,255,255,0.22)');
    line(0, 0, Math.max(1.2, R * 0.032), 'rgba(8,6,10,0.92)');
    if (level >= 2 && c % 2 === 0) embers.push(pts[0]);
  }
  // Ember glints inside the worst fractures
  ctx.save();
  ctx.shadowColor = '#ff7a2a';
  ctx.shadowBlur = R * 0.06 * k;
  for (const [x, y] of embers) {
    ctx.beginPath();
    ctx.arc(x, y, R * (level >= 3 ? 0.028 : 0.02), 0, TAU);
    ctx.fillStyle = level >= 3 ? '#ffc070' : '#ff9a4a';
    ctx.fill();
  }
  ctx.restore();
  // Punctures at critical damage
  if (level >= 3) {
    for (let i = 0; i < 3; i++) {
      const x = (R3() - 0.5) * R * 1.2, y = (R3() - 0.5) * R * 0.55;
      const rr = R * (0.035 + R3() * 0.03);
      ctx.beginPath();
      ctx.arc(x, y, rr, 0, TAU);
      ctx.fillStyle = '#0a0709';
      ctx.fill();
      ctx.lineWidth = Math.max(1, R * 0.012);
      ctx.strokeStyle = 'rgba(255,140,60,0.85)';
      ctx.stroke();
    }
  }
}

// ---------------------------------------------------------------------------
// Towers
// ---------------------------------------------------------------------------

const HEAD_ALIASES = {
  pulse: 'pulse', turret: 'pulse', scatter: 'scatter', pod: 'scatter',
  rail: 'rail', sniper: 'rail', railsniper: 'rail', railgun: 'rail',
  missile: 'missile', rocket: 'missile', missilepod: 'missile',
  cryo: 'cryo', frost: 'cryo', ice: 'cryo',
  tesla: 'tesla', coil: 'tesla', laser: 'laser', beam: 'laser',
  drone: 'drone', drones: 'drone', dronebay: 'drone', bay: 'drone',
  mortar: 'mortar', orbital: 'mortar', gravity: 'gravity', well: 'gravity', gravitywell: 'gravity',
  rig: 'rig', mining: 'rig', miner: 'rig', miningrig: 'rig',
  beacon: 'beacon', command: 'beacon', commandbeacon: 'beacon',
  vega: 'vega', nova: 'nova', brick: 'brick',
};
export function headStyle(def) {
  if (!def) return 'pulse';
  if (def.art && def.art.head) return def.art.head;
  const id = String(def.id || '').toLowerCase().replace(/[^a-z]/g, '');
  if (HEAD_ALIASES[id]) return HEAD_ALIASES[id];
  for (const k of Object.keys(HEAD_ALIASES)) if (id.includes(k)) return HEAD_ALIASES[k];
  if (isHeroDef(def)) return 'vega';
  return 'pulse';
}
export function isHeroDef(def) {
  return !!(def && (def.hero || def.kind === 'hero' || def.isHero || (def.art && def.art.hero)));
}

// Map any attack visual name onto one of the drawn projectile looks.
const BASE_VISUALS = new Set(['bolt', 'shard', 'blade', 'slug', 'missile', 'shell', 'orb', 'plasmaorb', 'needle', 'plasma', 'flame', 'cryo', 'bomb', 'lance']);
const VISUAL_RULES = [
  [/blade|crescent|sickle|scythe/, 'blade'],
  [/plasma ?orb|tempest/, 'plasmaorb'],
  [/lance|phase|star|spear|javelin/, 'lance'],
  [/needle|spike|dart|pin/, 'needle'],
  [/missile|rocket|torpedo|hunter/, 'missile'],
  [/bomblet|bomb|grenade|cluster|mine|carpet/, 'bomb'],
  [/shell|mortar|artillery|howitz/, 'shell'],
  [/shard|blade|flak|shrapnel|crystal/, 'shard'],
  [/slug|rail|bullet|round|tracer|snipe/, 'slug'],
  [/orb|ball|lightning|spark|storm/, 'orb'],
  [/plasma|void|singular|dark/, 'plasma'],
  [/flame|fire|ember|napalm|burn|solar|sun/, 'flame'],
  [/cryo|ice|frost|snow|glacier|cold/, 'cryo'],
  [/bolt|pulse|laser|beam|energy/, 'bolt'],
];
const _visCache = new Map();
export function resolveVisual(v) {
  if (!v) return 'bolt';
  let r = _visCache.get(v);
  if (r) return r;
  const s = String(v).toLowerCase();
  if (BASE_VISUALS.has(s)) r = s;
  else {
    r = 'bolt';
    for (const [re, name] of VISUAL_RULES) if (re.test(s)) { r = name; break; }
  }
  _visCache.set(v, r);
  return r;
}

// Standalone modifier overlays (used on top of image meteors; procedural ones bake them in).
export function drawPlatedRing(ctx, r) {
  const pr = r * 1.02;
  circlePath(ctx, 0, 0, pr);
  ctx.lineWidth = r * 0.3 + 2;
  ctx.strokeStyle = INK;
  ctx.stroke();
  const g = ctx.createLinearGradient(-pr, -pr, pr, pr);
  g.addColorStop(0, '#f1f5fb'); g.addColorStop(0.45, '#a9b4c4'); g.addColorStop(1, '#4d5666');
  ctx.lineWidth = r * 0.3;
  ctx.strokeStyle = g;
  ctx.stroke();
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * TAU;
    circlePath(ctx, Math.cos(a) * pr, Math.sin(a) * pr, r * 0.065);
    ctx.fillStyle = '#2b313d';
    ctx.fill();
  }
}
export function drawNaniteSpecks(ctx, r) {
  const R = rng(hashStr('nanite-overlay'));
  for (let i = 0; i < 5; i++) {
    const a = R() * TAU, d = r * (0.3 + R() * 0.45);
    const x = Math.cos(a) * d, y = Math.sin(a) * d, s = r * 0.13;
    ctx.fillStyle = INK;
    ctx.fillRect(x - s * 0.75, y - s * 0.75, s * 1.5, s * 1.5);
    ctx.fillStyle = '#4dff9a';
    ctx.fillRect(x - s * 0.5, y - s * 0.5, s, s);
  }
  circlePath(ctx, 0, 0, r * 0.95);
  ctx.lineWidth = r * 0.07;
  ctx.strokeStyle = 'rgba(77,255,154,0.6)';
  ctx.setLineDash([r * 0.14, r * 0.22]);
  ctx.stroke();
  ctx.setLineDash([]);
}
export function drawPhantomRim(ctx, r) {
  circlePath(ctx, 0, 0, r * 0.95);
  ctx.lineWidth = r * 0.18;
  ctx.strokeStyle = 'rgba(160,230,255,0.3)';
  ctx.stroke();
  ctx.lineWidth = r * 0.07;
  ctx.strokeStyle = '#d8f4ff';
  ctx.setLineDash([r * 0.32, r * 0.18]);
  ctx.stroke();
  ctx.setLineDash([]);
}

// Heads that do not aim get an idle spinner layer.
export const HEAD_SPIN = { gravity: 0.7, tesla: 0.35, rig: 4.5, beacon: 1.3, scatter: 0.5, cryo: 0.25, drone: 0 };
export function headRotates(def) {
  const st = headStyle(def);
  if (def && def.art && typeof def.art.rotates === 'boolean') return def.art.rotates;
  return !['gravity', 'tesla', 'rig', 'beacon', 'drone', 'cryo', 'scatter'].includes(st);
}

// Variant: 0 base, 1..3 = path A/B/C at tier 3+.
export function towerVariant(def, levels) {
  if (def && def.art && typeof def.art.variant === 'function') {
    try { const v = def.art.variant(levels || [0, 0, 0]); if (v >= 0 && v <= 3) return v | 0; } catch { /* fall through */ }
  }
  if (!levels) return 0;
  let best = -1, bt = 2;
  for (let p = 0; p < 3; p++) if ((levels[p] || 0) > bt) { bt = levels[p]; best = p; }
  return best + 1;
}

function basePlatePoints(shape, r) {
  switch (shape) {
    case 'square': return 'square';
    case 'circle': case 'round': return 'circle';
    case 'oct': case 'octagon': return regular(8, r, Math.PI / 8);
    case 'diamond': return regular(4, r * 1.05, 0);
    case 'tri': case 'triangle': return regular(3, r * 1.12, -Math.PI / 2);
    case 'pent': case 'pentagon': return regular(5, r, -Math.PI / 2);
    case 'star': {
      const pts = [];
      for (let i = 0; i < 10; i++) {
        const a = -Math.PI / 2 + (i / 10) * TAU;
        const rr = i % 2 ? r * 0.72 : r * 1.02;
        pts.push([Math.cos(a) * rr, Math.sin(a) * rr]);
      }
      return pts;
    }
    case 'hex': default: return regular(6, r, 0);
  }
}
function platePath(ctx, shape, r) {
  const p = basePlatePoints(shape, r);
  if (p === 'circle') circlePath(ctx, 0, 0, r);
  else if (p === 'square') roundRect(ctx, -r * 0.9, -r * 0.9, r * 1.8, r * 1.8, r * 0.28);
  else polyPath(ctx, p);
}

// Base plate (static, never rotates). st: { tier, variant, hero }
export function drawTowerBase(ctx, def, r, st = {}) {
  const art = (def && def.art) || {};
  const color = art.color || '#4cc9f0';
  const shape = st.hero ? 'star' : (art.shape || 'hex');
  const tier = st.tier || 0;
  const pc = st.variant ? PATH_COLORS[st.variant - 1] : color;
  const lw = 2.2;
  // Shadow
  ctx.save();
  ctx.translate(r * 0.1, r * 0.18);
  withBlur(ctx, r * 0.08, () => {
    platePath(ctx, shape, r * 0.98);
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fill();
  });
  ctx.restore();
  // Plate
  platePath(ctx, shape, r * 0.95);
  const g = ctx.createLinearGradient(-r, -r, r, r);
  if (st.hero) {
    g.addColorStop(0, '#ffe9a8'); g.addColorStop(0.5, '#d9a93a'); g.addColorStop(1, '#7a5516');
  } else {
    g.addColorStop(0, '#5a657c'); g.addColorStop(0.5, '#394257'); g.addColorStop(1, '#1f2533');
  }
  ctx.fillStyle = g;
  ctx.fill();
  strokeInk(ctx, lw);
  // Tier 5 golden rim, tier 3-4 path-colored rim
  if (tier >= 3) {
    platePath(ctx, shape, r * 0.95);
    ctx.lineWidth = tier >= 5 ? 2.2 : 1.6;
    ctx.strokeStyle = tier >= 5 ? '#ffd76a' : pc;
    ctx.save();
    platePath(ctx, shape, r * 0.95);
    ctx.clip();
    ctx.lineWidth = tier >= 5 ? 4 : 3;
    platePath(ctx, shape, r * 0.95);
    ctx.stroke();
    ctx.restore();
  }
  // Inner well
  circlePath(ctx, 0, 0, r * 0.68);
  ctx.fillStyle = st.hero ? '#3a2a10' : '#171b25';
  ctx.fill();
  ctx.lineWidth = 1.4;
  ctx.strokeStyle = 'rgba(0,0,0,0.6)';
  ctx.stroke();
  // Colored trim ring
  circlePath(ctx, 0, 0, r * 0.76);
  ctx.lineWidth = r * 0.07;
  ctx.strokeStyle = st.hero ? '#ffe28a' : color;
  ctx.stroke();
  // Bolts
  const bolts = shape === 'circle' || shape === 'round' ? 6 : (basePlatePoints(shape, r) === 'square' ? 4 : 0);
  const boltPts = [];
  if (bolts === 4) for (const [x, y] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) boltPts.push([x * r * 0.7, y * r * 0.7]);
  else if (bolts === 6) for (let i = 0; i < 6; i++) { const a = (i / 6) * TAU + Math.PI / 6; boltPts.push([Math.cos(a) * r * 0.86, Math.sin(a) * r * 0.86]); }
  else {
    const pts = basePlatePoints(shape, r * 0.78);
    if (Array.isArray(pts)) for (let i = 0; i < pts.length; i += (pts.length > 6 ? 2 : 1)) boltPts.push(pts[i]);
  }
  for (const [x, y] of boltPts) {
    circlePath(ctx, x, y, r * 0.06);
    ctx.fillStyle = st.hero ? '#fff0c0' : '#9aa5b8';
    ctx.fill();
    ctx.lineWidth = 0.8;
    ctx.strokeStyle = INK;
    ctx.stroke();
  }
  // Tier 4+: accent corner plates
  if (tier >= 4) {
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * TAU + Math.PI / 4;
      ctx.save();
      ctx.rotate(a);
      polyPath(ctx, [[r * 0.8, -r * 0.14], [r * 1.02, 0], [r * 0.8, r * 0.14]]);
      ctx.fillStyle = tier >= 5 ? '#ffd76a' : pc;
      ctx.fill();
      strokeInk(ctx, 1.2);
      ctx.restore();
    }
  }
}

function dome(ctx, x, y, rad, color, lw = 2) {
  circlePath(ctx, x, y, rad);
  const g = ctx.createRadialGradient(x, y, rad * 0.1, x, y, rad);
  g.addColorStop(0, shade(color, 0.3));
  g.addColorStop(0.7, color);
  g.addColorStop(1, shade(color, -0.35));
  ctx.fillStyle = g;
  ctx.fill();
  strokeInk(ctx, lw);
}
function barrel(ctx, x0, x1, y, w, tip, lw = 1.6) {
  roundRect(ctx, x0, y - w / 2, x1 - x0, w, w * 0.3);
  const g = ctx.createLinearGradient(0, y - w / 2, 0, y + w / 2);
  g.addColorStop(0, '#2e3442');
  g.addColorStop(0.45, '#8390a6');
  g.addColorStop(1, '#262b37');
  ctx.fillStyle = g;
  ctx.fill();
  strokeInk(ctx, lw);
  if (tip) {
    roundRect(ctx, x1 - w * 0.9, y - w * 0.62, w * 0.9, w * 1.24, w * 0.25);
    ctx.fillStyle = tip;
    ctx.fill();
    strokeInk(ctx, lw * 0.8);
  }
}
// Directional turret housing: rounded back, tapered front (facing +x).
function turretBody(ctx, r, color, scale = 1) {
  const q = r * scale;
  ctx.beginPath();
  ctx.moveTo(-q * 0.5, -q * 0.4);
  ctx.lineTo(q * 0.15, -q * 0.44);
  ctx.quadraticCurveTo(q * 0.58, -q * 0.36, q * 0.58, 0);
  ctx.quadraticCurveTo(q * 0.58, q * 0.36, q * 0.15, q * 0.44);
  ctx.lineTo(-q * 0.5, q * 0.4);
  ctx.quadraticCurveTo(-q * 0.72, 0, -q * 0.5, -q * 0.4);
  ctx.closePath();
  const g = ctx.createRadialGradient(-q * 0.05, 0, q * 0.05, 0, 0, q * 0.62);
  g.addColorStop(0, shade(color, 0.3));
  g.addColorStop(0.65, color);
  g.addColorStop(1, shade(color, -0.4));
  ctx.fillStyle = g;
  ctx.fill();
  strokeInk(ctx, 2);
  ctx.strokeStyle = 'rgba(0,0,0,0.3)';
  ctx.lineWidth = 1.1;
  ctx.beginPath();
  ctx.moveTo(-q * 0.28, -q * 0.41); ctx.lineTo(-q * 0.28, q * 0.41);
  ctx.stroke();
  // Rear vents
  ctx.strokeStyle = 'rgba(10,12,24,0.55)';
  ctx.lineWidth = q * 0.04;
  ctx.beginPath();
  for (const y of [-0.16, 0, 0.16]) { ctx.moveTo(-q * 0.5, y * q); ctx.lineTo(-q * 0.4, y * q); }
  ctx.stroke();
}

function glowDot(ctx, x, y, rad, color) {
  ctx.save();
  ctx.shadowColor = color;
  ctx.shadowBlur = rad * 2.5 * pxScale(ctx);
  circlePath(ctx, x, y, rad);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.restore();
  circlePath(ctx, x - rad * 0.3, y - rad * 0.3, rad * 0.35);
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.fill();
}

// Head (rotating part), facing +x. st: { variant, tier, levels }
export function drawTowerHead(ctx, def, r, st = {}) {
  const art = (def && def.art) || {};
  const color = art.color || '#4cc9f0';
  const accent = art.accent || '#f9c74f';
  const v = st.variant || 0;
  const tier = st.tier || 0;
  const style = headStyle(def);
  const nb = Math.max(1, Math.min(4, art.barrels || 1));
  const big = tier >= 4 ? 1.08 : 1;
  ctx.save();
  ctx.scale(big, big);
  switch (style) {
    case 'pulse': {
      if (v === 2) {
        // Cyclone: rotary triple barrels and an ammo drum
        for (const y of [-0.19, 0, 0.19]) barrel(ctx, r * 0.2, r * 1.18, y * r, r * 0.16, null, 1.3);
        roundRect(ctx, r * 0.92, -r * 0.33, r * 0.16, r * 0.66, r * 0.06);
        ctx.fillStyle = accent; ctx.fill(); strokeInk(ctx, 1.4);
        roundRect(ctx, -r * 0.78, -r * 0.3, r * 0.3, r * 0.6, r * 0.1);
        ctx.fillStyle = shade(accent, -0.2); ctx.fill(); strokeInk(ctx, 1.6);
      } else if (v === 3) {
        // Marksman: long barrel and a scope
        barrel(ctx, r * 0.2, r * 1.55, 0, r * 0.18, accent);
      } else if (v === 1) {
        // Penetrator: heavy barrel with a spike tip
        barrel(ctx, r * 0.2, r * 1.2, 0, r * 0.3, null);
        polyPath(ctx, [[r * 1.18, -r * 0.2], [r * 1.5, 0], [r * 1.18, r * 0.2]]);
        ctx.fillStyle = accent; ctx.fill(); strokeInk(ctx, 1.6);
      } else {
        for (let b = 0; b < nb; b++) {
          const y = nb === 1 ? 0 : (b - (nb - 1) / 2) * r * 0.3;
          barrel(ctx, r * 0.2, r * 1.22, y, r * 0.24, accent);
        }
      }
      turretBody(ctx, r, color);
      if (v === 3) {
        roundRect(ctx, -r * 0.2, -r * 0.62, r * 0.66, r * 0.17, r * 0.07);
        ctx.fillStyle = '#2b3140'; ctx.fill(); strokeInk(ctx, 1.4);
        circlePath(ctx, r * 0.46, -r * 0.535, r * 0.07);
        ctx.fillStyle = '#ff4d6d'; ctx.fill();
      }
      dome(ctx, -r * 0.1, 0, r * 0.25, shade(color, 0.12), 1.6);
      circlePath(ctx, -r * 0.04, 0, r * 0.09);
      ctx.fillStyle = shade(accent, 0.2); ctx.fill();
      break;
    }
    case 'scatter': {
      const nNoz = v === 1 ? 12 : 8;
      for (let i = 0; i < nNoz; i++) {
        const a = (i / nNoz) * TAU;
        ctx.save();
        ctx.rotate(a);
        if (v === 1) {
          polyPath(ctx, [[r * 0.4, -r * 0.12], [r * 0.92, -r * 0.02], [r * 0.4, r * 0.12]]);
          ctx.fillStyle = '#d7e3f2'; ctx.fill(); strokeInk(ctx, 1.2);
        } else {
          barrel(ctx, r * 0.3, r * 0.82, 0, r * 0.16, i % 2 ? accent : null, 1.2);
        }
        ctx.restore();
      }
      const bodyC = v === 2 ? '#ff7a2a' : color;
      dome(ctx, 0, 0, r * 0.52, bodyC);
      if (v === 2) glowDot(ctx, 0, 0, r * 0.22, '#ffd28a');
      else if (v === 3) {
        for (let i = 0; i < 4; i++) {
          const a = (i / 4) * TAU + Math.PI / 4;
          circlePath(ctx, Math.cos(a) * r * 0.24, Math.sin(a) * r * 0.24, r * 0.11);
          ctx.fillStyle = accent; ctx.fill(); strokeInk(ctx, 1);
        }
      } else {
        circlePath(ctx, 0, 0, r * 0.2);
        ctx.fillStyle = shade(color, -0.4); ctx.fill(); strokeInk(ctx, 1.2);
      }
      break;
    }
    case 'rail': {
      const len = v === 1 ? 1.75 : 1.55;
      // Twin rails
      for (const s of [-1, 1]) {
        roundRect(ctx, r * 0.05, s * r * 0.12 - r * 0.07, r * len, r * 0.14, r * 0.05);
        ctx.fillStyle = '#5b6578'; ctx.fill(); strokeInk(ctx, 1.4);
      }
      // Coils
      for (let i = 0; i < 4; i++) {
        const x = r * (0.35 + i * 0.28);
        roundRect(ctx, x, -r * 0.1, r * 0.1, r * 0.2, r * 0.03);
        ctx.fillStyle = accent; ctx.fill(); strokeInk(ctx, 0.9);
      }
      if (v === 1) {
        roundRect(ctx, r * (len - 0.1), -r * 0.24, r * 0.2, r * 0.48, r * 0.06);
        ctx.fillStyle = '#3a4252'; ctx.fill(); strokeInk(ctx, 1.4);
      }
      // Chassis
      roundRect(ctx, -r * 0.62, -r * 0.34, r * 0.9, r * 0.68, r * 0.16);
      const g = ctx.createLinearGradient(0, -r * 0.34, 0, r * 0.34);
      g.addColorStop(0, shade(color, 0.25)); g.addColorStop(1, shade(color, -0.3));
      ctx.fillStyle = g; ctx.fill(); strokeInk(ctx, 2);
      // Scope
      roundRect(ctx, -r * 0.3, -r * 0.5, r * 0.56, r * 0.16, r * 0.07);
      ctx.fillStyle = '#232835'; ctx.fill(); strokeInk(ctx, 1.3);
      circlePath(ctx, r * 0.26, -r * 0.42, r * 0.06);
      ctx.fillStyle = '#7ff'; ctx.fill();
      if (v === 2) {
        circlePath(ctx, -r * 0.3, r * 0.1, r * 0.2);
        ctx.fillStyle = '#48505f'; ctx.fill(); strokeInk(ctx, 1.4);
        circlePath(ctx, -r * 0.3, r * 0.1, r * 0.08);
        ctx.fillStyle = accent; ctx.fill();
      } else if (v === 3) {
        roundRect(ctx, -r * 0.7, -r * 0.24, r * 0.3, r * 0.48, r * 0.05);
        ctx.fillStyle = '#c99a4a'; ctx.fill(); strokeInk(ctx, 1.4);
        ctx.strokeStyle = 'rgba(0,0,0,0.4)'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(-r * 0.7, 0); ctx.lineTo(-r * 0.4, 0); ctx.stroke();
      }
      break;
    }
    case 'missile': {
      const w = r * 1.0, h = r * 0.95;
      roundRect(ctx, -w * 0.55, -h / 2, w, h, r * 0.16);
      const g = ctx.createLinearGradient(0, -h / 2, 0, h / 2);
      g.addColorStop(0, shade(color, 0.25)); g.addColorStop(1, shade(color, -0.3));
      ctx.fillStyle = g; ctx.fill(); strokeInk(ctx, 2);
      // Tubes
      let grid;
      if (v === 1) grid = [[0.08, 0, 0.3]];
      else if (v === 2) grid = [];
      else grid = [[0.1, -0.22, 0.17], [0.1, 0.22, 0.17], [-0.25, -0.22, 0.17], [-0.25, 0.22, 0.17]];
      if (v === 2) for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) grid.push([0.18 - i * 0.24, (j - 1) * 0.28, 0.11]);
      for (const [x, y, s] of grid) {
        circlePath(ctx, x * r, y * r, s * r);
        ctx.fillStyle = '#1a1e28'; ctx.fill(); strokeInk(ctx, 1.1);
        circlePath(ctx, x * r + s * r * 0.15, y * r, s * r * 0.62);
        ctx.fillStyle = v === 3 ? '#ff5d5d' : accent; ctx.fill();
        strokeInk(ctx, 0.8);
      }
      if (v === 3) {
        circlePath(ctx, r * 0.42, 0, r * 0.13);
        ctx.fillStyle = '#7ff'; ctx.fill(); strokeInk(ctx, 1.2);
      }
      break;
    }
    case 'cryo': {
      const n = 6;
      const len = v === 1 ? 0.98 : 0.8;
      if (v === 3) barrel(ctx, r * 0.1, r * 1.25, 0, r * 0.22, '#bff4ff');
      for (let i = 0; i < n; i++) {
        const a = (i / n) * TAU + Math.PI / 6;
        ctx.save();
        ctx.rotate(a);
        const jag = v === 2 ? 0.1 : 0;
        polyPath(ctx, [[r * 0.3, -r * 0.13], [r * (len - 0.1), -r * (0.1 + jag)], [r * len, 0], [r * (len - 0.1), r * (0.1 - jag)], [r * 0.3, r * 0.13]]);
        const g = ctx.createLinearGradient(r * 0.3, 0, r * len, 0);
        g.addColorStop(0, '#dff8ff'); g.addColorStop(1, color);
        ctx.fillStyle = g; ctx.fill(); strokeInk(ctx, 1.3);
        ctx.restore();
      }
      dome(ctx, 0, 0, r * 0.42, shade(color, -0.1));
      glowDot(ctx, 0, 0, r * 0.2, '#e8fdff');
      break;
    }
    case 'tesla': {
      // Stacked rings seen from above
      circlePath(ctx, 0, 0, r * 0.62);
      ctx.fillStyle = '#b8743a'; ctx.fill(); strokeInk(ctx, 2);
      circlePath(ctx, 0, 0, r * 0.5);
      ctx.fillStyle = '#e39a52'; ctx.fill(); strokeInk(ctx, 1.4);
      circlePath(ctx, 0, 0, r * 0.38);
      ctx.fillStyle = '#b8743a'; ctx.fill(); strokeInk(ctx, 1.4);
      const orb = v === 2 ? '#c07dff' : (v === 3 ? '#ffe14d' : color);
      glowDot(ctx, 0, 0, r * (v === 2 ? 0.26 : 0.2), orb);
      strokeInk(ctx, 1.2);
      break;
    }
    case 'laser': {
      if (v === 1) {
        for (const y of [-0.26, 0, 0.26]) barrel(ctx, r * 0.2, r * 1.1, y * r, r * 0.15, null, 1.2);
        for (const y of [-0.26, 0, 0.26]) glowDot(ctx, r * 1.1, y * r, r * 0.07, '#ff9cf5');
      } else if (v === 2) {
        barrel(ctx, r * 0.2, r * 1.5, 0, r * 0.26, null);
        for (let i = 0; i < 3; i++) {
          roundRect(ctx, r * (0.7 + i * 0.25), -r * 0.2, r * 0.08, r * 0.4, r * 0.03);
          ctx.fillStyle = accent; ctx.fill(); strokeInk(ctx, 1);
        }
        glowDot(ctx, r * 1.5, 0, r * 0.1, '#fff6a8');
      } else {
        barrel(ctx, r * 0.2, r * 1.15, 0, r * 0.26, null);
        polyPath(ctx, [[r * 1.08, -r * 0.17], [r * 1.34, 0], [r * 1.08, r * 0.17]]);
        ctx.fillStyle = v === 3 ? '#b36bff' : '#ff6b8a'; ctx.fill(); strokeInk(ctx, 1.2);
      }
      turretBody(ctx, r, color, 1.05);
      // Lens
      circlePath(ctx, r * 0.02, 0, r * 0.27);
      const g = ctx.createRadialGradient(-r * 0.08, -r * 0.08, 0, r * 0.02, 0, r * 0.27);
      g.addColorStop(0, '#ffffff');
      g.addColorStop(0.3, v === 3 ? '#e0b3ff' : '#ffc2d0');
      g.addColorStop(1, v === 3 ? '#6b1fd6' : '#d6204a');
      ctx.fillStyle = g; ctx.fill(); strokeInk(ctx, 1.5);
      break;
    }
    case 'drone': {
      // Hangar pad with a parked drone
      roundRect(ctx, -r * 0.62, -r * 0.62, r * 1.24, r * 1.24, r * 0.18);
      ctx.fillStyle = '#2a303d'; ctx.fill(); strokeInk(ctx, 2);
      circlePath(ctx, 0, 0, r * 0.46);
      ctx.lineWidth = r * 0.06; ctx.strokeStyle = v === 2 ? '#ff9f43' : accent;
      ctx.setLineDash([r * 0.16, r * 0.1]); ctx.stroke(); ctx.setLineDash([]);
      if (v === 1) {
        for (let i = 0; i < 4; i++) {
          const a = (i / 4) * TAU + Math.PI / 4;
          roundRect(ctx, Math.cos(a) * r * 0.46 - r * 0.1, Math.sin(a) * r * 0.46 - r * 0.1, r * 0.2, r * 0.2, r * 0.04);
          ctx.fillStyle = color; ctx.fill(); strokeInk(ctx, 1);
        }
      }
      drawDroneBody(ctx, r * 0.36, v === 2 ? '#e0703a' : color, v === 3 ? 'tractor' : v === 2 ? 'bomber' : 'gun');
      break;
    }
    case 'mortar': {
      const cal = v === 1 ? 0.4 : 0.32;
      if (v === 3) {
        for (const y of [-0.24, 0.24]) {
          roundRect(ctx, r * 0.05, y * r - r * 0.17, r * 0.75, r * 0.34, r * 0.1);
          ctx.fillStyle = '#4a5364'; ctx.fill(); strokeInk(ctx, 1.6);
          circlePath(ctx, r * 0.78, y * r, r * 0.2);
          ctx.fillStyle = '#1b1f28'; ctx.fill(); strokeInk(ctx, 1.4);
        }
      } else {
        roundRect(ctx, r * 0.05, -r * cal * 0.8, r * 0.75, r * cal * 1.6, r * 0.12);
        ctx.fillStyle = '#4a5364'; ctx.fill(); strokeInk(ctx, 1.8);
        circlePath(ctx, r * 0.82, 0, r * cal);
        ctx.fillStyle = '#50596b'; ctx.fill(); strokeInk(ctx, 1.8);
        circlePath(ctx, r * 0.82, 0, r * cal * 0.66);
        ctx.fillStyle = '#12151c'; ctx.fill();
      }
      dome(ctx, -r * 0.1, 0, r * 0.46, color);
      if (v === 2) {
        for (const y of [-0.28, 0.28]) {
          roundRect(ctx, -r * 0.62, y * r - r * 0.12, r * 0.4, r * 0.24, r * 0.1);
          ctx.fillStyle = '#ff7a2a'; ctx.fill(); strokeInk(ctx, 1.2);
        }
      }
      circlePath(ctx, -r * 0.1, 0, r * 0.14);
      ctx.fillStyle = accent; ctx.fill(); strokeInk(ctx, 1);
      break;
    }
    case 'gravity': {
      const g = ctx.createRadialGradient(-r * 0.12, -r * 0.12, 0, 0, 0, r * 0.55);
      const core = v === 3 ? '#6fe7ff' : v === 1 ? '#ff5d8a' : '#b36bff';
      g.addColorStop(0, '#ffffff');
      g.addColorStop(0.25, core);
      g.addColorStop(0.7, '#2a0f4a');
      g.addColorStop(1, '#0a0514');
      circlePath(ctx, 0, 0, r * 0.52);
      ctx.fillStyle = g; ctx.fill(); strokeInk(ctx, 2);
      break;
    }
    case 'rig': {
      // Frame and ore hoppers (the drill bit is a spinner layer)
      roundRect(ctx, -r * 0.7, -r * 0.5, r * 1.4, r * 1.0, r * 0.14);
      ctx.fillStyle = '#3a4150'; ctx.fill(); strokeInk(ctx, 2);
      for (const s of [-1, 1]) {
        roundRect(ctx, s > 0 ? r * 0.3 : -r * 0.72, -r * 0.42, r * 0.42, r * 0.84, r * 0.1);
        ctx.fillStyle = color; ctx.fill(); strokeInk(ctx, 1.4);
        const ore = v === 2 ? '#ffd76a' : accent;
        for (let i = 0; i < 3; i++) {
          polyPath(ctx, regular(4, r * 0.08, i * 0.4).map(([x, y]) => [x + (s > 0 ? r * 0.51 : -r * 0.51), y + (i - 1) * r * 0.24]));
          ctx.fillStyle = ore; ctx.fill(); strokeInk(ctx, 0.8);
        }
      }
      if (v === 3) {
        for (const x of [-0.5, 0.5]) {
          circlePath(ctx, x * r, -r * 0.52, r * 0.1);
          ctx.fillStyle = '#6b7385'; ctx.fill(); strokeInk(ctx, 1.2);
        }
      }
      break;
    }
    case 'beacon': {
      roundRect(ctx, -r * 0.5, -r * 0.5, r * 1.0, r * 1.0, r * 0.2);
      ctx.fillStyle = '#3a4150'; ctx.fill(); strokeInk(ctx, 2);
      const lamp = v === 2 ? '#ff7a3d' : (v === 3 ? '#7dffb0' : accent);
      for (const [x, y] of [[-0.36, -0.36], [0.36, -0.36], [0.36, 0.36], [-0.36, 0.36]]) glowDot(ctx, x * r, y * r, r * 0.07, lamp);
      if (v === 3) {
        roundRect(ctx, -r * 0.46, r * 0.14, r * 0.3, r * 0.3, r * 0.04);
        ctx.fillStyle = '#c99a4a'; ctx.fill(); strokeInk(ctx, 1);
      }
      break;
    }
    case 'vega': {
      barrel(ctx, r * 0.15, r * 1.15, r * 0.16, r * 0.18, '#ffd76a');
      // Shoulders
      for (const s of [-1, 1]) {
        circlePath(ctx, -r * 0.05, s * r * 0.36, r * 0.22);
        ctx.fillStyle = '#2f6fd6'; ctx.fill(); strokeInk(ctx, 1.6);
      }
      dome(ctx, 0, 0, r * 0.38, '#3a86ff');
      // Visor
      ctx.beginPath();
      ctx.ellipse(r * 0.16, 0, r * 0.12, r * 0.22, 0, 0, TAU);
      ctx.fillStyle = '#9ff4ff'; ctx.fill(); strokeInk(ctx, 1.2);
      break;
    }
    case 'nova': {
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * TAU;
        ctx.beginPath();
        ctx.ellipse(0, 0, r * 0.62, r * 0.2, a, 0, TAU);
        ctx.lineWidth = 1.6; ctx.strokeStyle = '#ff9cf5'; ctx.stroke();
      }
      dome(ctx, 0, 0, r * 0.38, '#b14dff');
      glowDot(ctx, r * 0.1, 0, r * 0.16, '#ffe0ff');
      break;
    }
    case 'brick': {
      // Mech with twin cannon arms
      for (const s of [-1, 1]) {
        barrel(ctx, r * 0.0, r * 1.0, s * r * 0.42, r * 0.26, '#ff7a2a', 1.8);
        roundRect(ctx, -r * 0.3, s * r * 0.42 - r * 0.2, r * 0.4, r * 0.4, r * 0.08);
        ctx.fillStyle = '#6b7385'; ctx.fill(); strokeInk(ctx, 1.6);
      }
      roundRect(ctx, -r * 0.45, -r * 0.34, r * 0.8, r * 0.68, r * 0.14);
      const g = ctx.createLinearGradient(0, -r * 0.34, 0, r * 0.34);
      g.addColorStop(0, '#ffb35a'); g.addColorStop(1, '#b8601a');
      ctx.fillStyle = g; ctx.fill(); strokeInk(ctx, 2);
      roundRect(ctx, r * 0.12, -r * 0.14, r * 0.16, r * 0.28, r * 0.05);
      ctx.fillStyle = '#9ff4ff'; ctx.fill(); strokeInk(ctx, 1);
      break;
    }
    default: {
      barrel(ctx, r * 0.1, r * 1.0, 0, r * 0.22, accent);
      dome(ctx, 0, 0, r * 0.5, color);
    }
  }
  // Tier 5 crown ornament
  if (tier >= 5 && !['rig', 'beacon', 'drone'].includes(style)) {
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * TAU + Math.PI;
      ctx.save();
      ctx.rotate(a);
      polyPath(ctx, [[r * 0.34, -r * 0.08], [r * 0.52, 0], [r * 0.34, r * 0.08]]);
      ctx.fillStyle = '#ffd76a'; ctx.fill(); strokeInk(ctx, 1);
      ctx.restore();
    }
  }
  ctx.restore();
}

// Spinner layers for non-aiming towers (drawn rotating with time on top of the head).
export function hasSpinner(style) { return style === 'rig' || style === 'beacon' || style === 'gravity' || style === 'tesla'; }
export function drawTowerSpinner(ctx, def, r, st = {}) {
  const style = headStyle(def);
  const art = (def && def.art) || {};
  const color = art.color || '#4cc9f0';
  const accent = art.accent || '#f9c74f';
  const v = st.variant || 0;
  const big = (st.tier || 0) >= 4 ? 1.08 : 1;
  ctx.scale(big, big);
  if (style === 'rig') {
    const R = v === 1 ? r * 0.36 : r * 0.3;
    circlePath(ctx, 0, 0, R);
    ctx.fillStyle = '#8b95a8'; ctx.fill(); strokeInk(ctx, 1.6);
    ctx.strokeStyle = '#3a4150';
    ctx.lineWidth = R * 0.16;
    ctx.beginPath();
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * TAU;
      ctx.moveTo(Math.cos(a) * R * 0.15, Math.sin(a) * R * 0.15);
      ctx.quadraticCurveTo(Math.cos(a + 0.8) * R * 0.7, Math.sin(a + 0.8) * R * 0.7, Math.cos(a + 1.2) * R * 0.95, Math.sin(a + 1.2) * R * 0.95);
    }
    ctx.stroke();
    circlePath(ctx, 0, 0, R * 0.22);
    ctx.fillStyle = v === 2 ? '#ffd76a' : accent; ctx.fill(); strokeInk(ctx, 1);
  } else if (style === 'beacon') {
    // Radar dish with a feed arm
    ctx.beginPath();
    ctx.ellipse(0, 0, r * 0.2, r * (v === 1 ? 0.62 : 0.48), 0, 0, TAU);
    const g = ctx.createLinearGradient(-r * 0.2, 0, r * 0.2, 0);
    g.addColorStop(0, '#e8eef7'); g.addColorStop(1, '#7c8799');
    ctx.fillStyle = g; ctx.fill(); strokeInk(ctx, 1.6);
    ctx.lineWidth = 1.6; ctx.strokeStyle = INK;
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(r * 0.42, 0); ctx.stroke();
    glowDot(ctx, r * 0.42, 0, r * 0.08, v === 2 ? '#ff7a3d' : color);
  } else if (style === 'gravity') {
    const col = v === 3 ? '#6fe7ff' : v === 1 ? '#ff5d8a' : '#c79bff';
    for (let i = 0; i < 2; i++) {
      ctx.beginPath();
      ctx.ellipse(0, 0, r * 0.82, r * 0.28, i * Math.PI / 2 + Math.PI / 4, 0, TAU);
      ctx.lineWidth = 2.6; ctx.strokeStyle = INK; ctx.stroke();
      ctx.lineWidth = 1.4; ctx.strokeStyle = col; ctx.stroke();
    }
    for (let i = 0; i < 2; i++) {
      const a = i * Math.PI + Math.PI / 4;
      glowDot(ctx, Math.cos(a) * r * 0.82, Math.sin(a) * r * 0.82, r * 0.07, col);
    }
  } else if (style === 'tesla') {
    const n = v === 1 ? 6 : 4;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU;
      const x = Math.cos(a) * r * 0.72, y = Math.sin(a) * r * 0.72;
      circlePath(ctx, x, y, r * 0.1);
      ctx.fillStyle = '#d9dfe8'; ctx.fill(); strokeInk(ctx, 1.2);
      circlePath(ctx, x, y, r * 0.045);
      ctx.fillStyle = color; ctx.fill();
    }
  }
}

// Gloss highlight drawn unrotated over round heads so light stays top-left.
export function drawHeadGloss(ctx, r) {
  const g = ctx.createRadialGradient(-r * 0.22, -r * 0.26, 0, -r * 0.22, -r * 0.26, r * 0.4);
  g.addColorStop(0, 'rgba(255,255,255,0.55)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  circlePath(ctx, -r * 0.22, -r * 0.26, r * 0.4);
  ctx.fill();
}

export function drawDroneBody(ctx, s, color, kind = 'gun') {
  // Quadcopter seen from above, nose along +x: four arms with rotor discs, a rounded hull.
  const hull = kind === 'bomber' ? mix(color, '#ff7a5a', 0.35) : kind === 'tractor' ? mix(color, '#6dffb0', 0.3) : color;
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * TAU + Math.PI / 4;
    const x = Math.cos(a) * s * 0.72, y = Math.sin(a) * s * 0.72;
    ctx.lineWidth = s * 0.2; ctx.strokeStyle = INK;
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(x, y); ctx.stroke();
    ctx.lineWidth = s * 0.08; ctx.strokeStyle = shade(hull, -0.2);
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(x * 0.92, y * 0.92); ctx.stroke();
    // spinning rotor: dark disc, bright rim, motion-blurred blades
    circlePath(ctx, x, y, s * 0.34);
    ctx.fillStyle = 'rgba(14,20,34,0.55)'; ctx.fill();
    ctx.lineWidth = s * 0.07; ctx.strokeStyle = INK; ctx.stroke();
    ctx.lineWidth = s * 0.035; ctx.strokeStyle = 'rgba(210,235,255,0.75)';
    ctx.beginPath(); ctx.arc(x, y, s * 0.3, a + 0.3, a + 2.2); ctx.stroke();
    ctx.beginPath(); ctx.arc(x, y, s * 0.3, a + 3.4, a + 5.3); ctx.stroke();
    circlePath(ctx, x, y, s * 0.07);
    ctx.fillStyle = '#dfe8f5'; ctx.fill();
  }
  // Hull
  ctx.beginPath();
  ctx.ellipse(0, 0, s * 0.46, s * 0.34, 0, 0, TAU);
  const g = ctx.createLinearGradient(-s * 0.3, -s * 0.34, s * 0.2, s * 0.34);
  g.addColorStop(0, shade(hull, 0.4)); g.addColorStop(0.55, hull); g.addColorStop(1, shade(hull, -0.35));
  ctx.fillStyle = g; ctx.fill();
  ctx.lineWidth = Math.max(1, s * 0.1); ctx.strokeStyle = INK; ctx.stroke();
  // Payload marks
  if (kind === 'bomber') {
    for (const y of [-0.17, 0.17]) {
      roundRect(ctx, -s * 0.24, y * s - s * 0.06, s * 0.36, s * 0.12, s * 0.06);
      ctx.fillStyle = '#ff5d5d'; ctx.fill();
      ctx.lineWidth = s * 0.04; ctx.strokeStyle = INK; ctx.stroke();
    }
  } else if (kind === 'tractor') {
    circlePath(ctx, -s * 0.05, 0, s * 0.15);
    ctx.fillStyle = '#7dffb0'; ctx.fill();
    ctx.lineWidth = s * 0.04; ctx.strokeStyle = INK; ctx.stroke();
  }
  // Nose sensor light
  circlePath(ctx, s * 0.3, 0, s * 0.1);
  ctx.fillStyle = kind === 'bomber' ? '#ffd27a' : '#9ff4ff'; ctx.fill();
  ctx.lineWidth = s * 0.035; ctx.strokeStyle = INK; ctx.stroke();
}

export function drawHeroBadge(ctx, s, level) {
  // Gold star with the level number
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i / 10) * TAU;
    const rr = i % 2 ? s * 0.48 : s;
    ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
  }
  ctx.closePath();
  const g = ctx.createLinearGradient(0, -s, 0, s);
  g.addColorStop(0, '#fff2b0'); g.addColorStop(1, '#e0a020');
  ctx.fillStyle = g; ctx.fill();
  ctx.lineWidth = Math.max(1, s * 0.16); ctx.strokeStyle = INK; ctx.stroke();
  if (level != null) {
    ctx.font = `900 ${s * 0.95}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = s * 0.22;
    ctx.strokeStyle = INK;
    ctx.strokeText(String(level), 0, s * 0.1);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(String(level), 0, s * 0.1);
  }
}

// Tier pips: a dark pill with one dot per tier, grouped by path color.
export function pipLayout(levels) {
  const groups = [];
  for (let p = 0; p < 3; p++) if ((levels[p] || 0) > 0) groups.push([p, levels[p]]);
  return groups;
}
export function drawPips(ctx, levels, dot = 2.4) {
  const groups = pipLayout(levels);
  if (!groups.length) return;
  const gap = dot * 2.6, groupGap = dot * 2.2;
  let w = 0;
  for (const [, n] of groups) w += n * gap;
  w += (groups.length - 1) * groupGap;
  const h = dot * 3.2;
  roundRect(ctx, -w / 2 - dot * 1.1, -h / 2, w + dot * 2.2, h, h / 2);
  ctx.fillStyle = 'rgba(8,10,20,0.85)';
  ctx.fill();
  ctx.lineWidth = 0.8;
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.stroke();
  let x = -w / 2 + gap / 2;
  for (const [p, n] of groups) {
    for (let i = 0; i < n; i++) {
      circlePath(ctx, x, 0, dot * (i >= 4 ? 1.2 : 0.95));
      ctx.fillStyle = i >= 4 ? '#ffe28a' : PATH_COLORS[p];
      ctx.fill();
      x += gap;
    }
    x += groupGap;
  }
}

// ---------------------------------------------------------------------------
// Core and portal
// ---------------------------------------------------------------------------

// Static platform under the core (goes into the static layer).
export function drawCorePlatform(ctx, R, pal) {
  const edge = (pal && pal.edge) || '#6ee7ff';
  ctx.save();
  ctx.translate(R * 0.08, R * 0.14);
  withBlur(ctx, R * 0.06, () => {
    polyPath(ctx, regular(6, R * 1.02, Math.PI / 6));
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fill();
  });
  ctx.restore();
  polyPath(ctx, regular(6, R, Math.PI / 6));
  const g = ctx.createLinearGradient(-R, -R, R, R);
  g.addColorStop(0, '#5a657c'); g.addColorStop(0.5, '#343c50'); g.addColorStop(1, '#1b202c');
  ctx.fillStyle = g; ctx.fill(); strokeInk(ctx, 2.6);
  polyPath(ctx, regular(6, R * 0.82, Math.PI / 6));
  ctx.fillStyle = '#1a1f2b'; ctx.fill(); strokeInk(ctx, 1.4);
  // Hazard ring
  ctx.save();
  circlePath(ctx, 0, 0, R * 0.74);
  ctx.lineWidth = R * 0.08;
  ctx.strokeStyle = '#f2c230';
  ctx.setLineDash([R * 0.12, R * 0.1]);
  ctx.stroke();
  ctx.restore();
  // Pylons
  for (let i = 0; i < 3; i++) {
    const a = -Math.PI / 2 + (i / 3) * TAU;
    const x = Math.cos(a) * R * 0.86, y = Math.sin(a) * R * 0.86;
    circlePath(ctx, x, y, R * 0.13);
    ctx.fillStyle = '#6b7488'; ctx.fill(); strokeInk(ctx, 1.6);
    circlePath(ctx, x, y, R * 0.06);
    ctx.fillStyle = edge; ctx.fill();
  }
  circlePath(ctx, 0, 0, R * 0.5);
  ctx.fillStyle = '#0d1018'; ctx.fill(); strokeInk(ctx, 1.6);
}

// Rotating ring segments of the reactor.
export function drawCoreRing(ctx, R, color) {
  for (let i = 0; i < 3; i++) {
    const a0 = (i / 3) * TAU + 0.2, a1 = a0 + TAU / 3 - 0.4;
    ctx.beginPath();
    ctx.arc(0, 0, R * 0.62, a0, a1);
    ctx.lineWidth = R * 0.12;
    ctx.strokeStyle = INK;
    ctx.stroke();
    ctx.lineWidth = R * 0.07;
    ctx.strokeStyle = color;
    ctx.stroke();
  }
}

// The reactor orb (tinted by the caller: normal cyan, red when hurt).
export function drawCoreOrb(ctx, R, c1, c2) {
  const g = ctx.createRadialGradient(-R * 0.12, -R * 0.14, 0, 0, 0, R * 0.4);
  g.addColorStop(0, '#ffffff');
  g.addColorStop(0.35, c1);
  g.addColorStop(1, c2);
  circlePath(ctx, 0, 0, R * 0.38);
  ctx.fillStyle = g;
  ctx.fill();
  strokeInk(ctx, 2);
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.beginPath();
  ctx.ellipse(-R * 0.12, -R * 0.16, R * 0.1, R * 0.05, -0.6, 0, TAU);
  ctx.fill();
}

// Spiral wormhole layer.
export function drawPortalSwirl(ctx, R, c1, c2, arms = 4) {
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, R);
  g.addColorStop(0, 'rgba(4,2,10,1)');
  g.addColorStop(0.45, rgba(c2, 0.55));
  g.addColorStop(0.85, rgba(c1, 0.35));
  g.addColorStop(1, rgba(c1, 0));
  circlePath(ctx, 0, 0, R);
  ctx.fillStyle = g;
  ctx.fill();
  for (let a = 0; a < arms; a++) {
    const base = (a / arms) * TAU;
    ctx.beginPath();
    for (let t = 0; t <= 1.0001; t += 0.04) {
      const ang = base + t * 3.2;
      const rr = R * (0.12 + t * 0.85);
      const x = Math.cos(ang) * rr, y = Math.sin(ang) * rr;
      if (t === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.lineWidth = R * 0.12;
    ctx.strokeStyle = rgba(c1, 0.55);
    ctx.stroke();
    ctx.lineWidth = R * 0.04;
    ctx.strokeStyle = rgba('#ffffff', 0.55);
    ctx.stroke();
  }
}

// ---------------------------------------------------------------------------
// Projectiles (facing +x). size = world radius of the projectile.
// ---------------------------------------------------------------------------

// Tight sprite boxes per visual, in units of the projectile size s: [w, h, ax, ay]
// (ax, ay = where the projectile origin sits inside the box). Smaller boxes = less fill.
export const PROJ_BOX = {
  bolt:    { body: [3.1, 1.4, 1.95, 0.7],  glow: [6.3, 3.2, 3.15, 1.6] },
  shard:   { body: [2.8, 2.8, 1.4, 1.4],   glow: [3.4, 3.4, 1.7, 1.7] },
  blade:   { body: [3.0, 3.0, 1.5, 1.5],   glow: [3.6, 3.6, 1.8, 1.8] },
  plasmaorb: { body: [1.5, 1.5, 0.75, 0.75], glow: [6.0, 6.0, 3.0, 3.0] },
  lance:   { body: [4.9, 1.3, 2.25, 0.65], glow: [10.4, 2.9, 5.2, 1.45] },
  slug:    { body: [2.7, 1.1, 1.55, 0.55], glow: [7.2, 2.4, 3.6, 1.2] },
  needle:  { body: [3.5, 0.9, 2.05, 0.45], glow: [7.2, 2.4, 3.6, 1.2] },
  missile: { body: [3.9, 2.3, 1.95, 1.15], glow: [3.0, 3.0, 3.4, 1.5] },
  shell:   { body: [2.6, 2.6, 1.3, 1.3],   glow: [3.4, 3.4, 1.7, 1.7] },
  bomb:    { body: [2.6, 3.2, 1.3, 1.85],  glow: [3.4, 3.4, 1.7, 1.7] },
  cryo:    { body: [2.8, 1.6, 1.2, 0.8],   glow: [4.2, 4.2, 2.1, 2.1] },
  orb:     { body: [1.3, 1.3, 0.65, 0.65], glow: [5.0, 5.0, 2.5, 2.5] },
  plasma:  { body: [1.3, 1.3, 0.65, 0.65], glow: [6.2, 4.2, 3.1, 2.1] },
  flame:   { body: [1.3, 1.3, 0.65, 0.65], glow: [3.8, 3.8, 1.9, 1.9] },
};

export function drawProjectileBody(ctx, visual, color, s) {
  const c = color || '#9ef';
  switch (visual) {
    case 'shard': {
      // Spinning three-blade crystal: straight leading edges, curved trailing edges.
      const tri = (R, inner, bend) => {
        ctx.beginPath();
        for (let i = 0; i < 3; i++) {
          const a = (i * TAU) / 3;
          const tx = Math.cos(a) * R, ty = Math.sin(a) * R;
          if (i === 0) ctx.moveTo(tx, ty); else ctx.lineTo(tx, ty);
          const cx = Math.cos(a + 0.62) * R * bend, cy = Math.sin(a + 0.62) * R * bend;
          const vx = Math.cos(a + TAU / 6) * inner, vy = Math.sin(a + TAU / 6) * inner;
          ctx.quadraticCurveTo(cx, cy, vx, vy);
        }
        ctx.closePath();
      };
      tri(s * 1.25, s * 0.36, 0.72);
      const g = ctx.createLinearGradient(-s, -s, s, s);
      g.addColorStop(0, mix(c, '#ffffff', 0.55)); g.addColorStop(0.5, c); g.addColorStop(1, shade(c, -0.3));
      ctx.fillStyle = g; ctx.fill();
      ctx.lineWidth = Math.max(0.8, s * 0.2); ctx.strokeStyle = INK; ctx.stroke();
      tri(s * 0.95, s * 0.2, 0.55);
      ctx.fillStyle = 'rgba(255,255,255,0.35)'; ctx.fill();
      circlePath(ctx, 0, 0, s * 0.24);
      ctx.fillStyle = '#ffffff'; ctx.fill();
      ctx.lineWidth = Math.max(0.6, s * 0.1); ctx.strokeStyle = INK; ctx.stroke();
      break;
    }
    case 'blade': {
      // Curved crescent blade: a thick leading arc tapering to two points, spun by the renderer.
      const R = s * 1.35;
      const crescent = (outer, inner, off) => {
        ctx.beginPath();
        ctx.arc(0, 0, outer, -2.35, 2.35, false);
        ctx.arc(off, 0, inner, 2.1, -2.1, true);
        ctx.closePath();
      };
      crescent(R, R * 0.92, -R * 0.42);
      const g = ctx.createLinearGradient(-R, -R, R, R);
      g.addColorStop(0, mix(c, '#ffffff', 0.6)); g.addColorStop(0.55, c); g.addColorStop(1, shade(c, -0.35));
      ctx.fillStyle = g; ctx.fill();
      ctx.lineWidth = Math.max(0.8, s * 0.2); ctx.strokeStyle = INK; ctx.stroke();
      // bright cutting edge
      ctx.beginPath();
      ctx.arc(0, 0, R * 0.9, -1.7, 1.7, false);
      ctx.lineWidth = Math.max(0.7, s * 0.2); ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.stroke();
      circlePath(ctx, -R * 0.2, 0, s * 0.2);
      ctx.fillStyle = '#ffffff'; ctx.fill();
      ctx.lineWidth = Math.max(0.5, s * 0.08); ctx.strokeStyle = INK; ctx.stroke();
      break;
    }
    case 'plasmaorb': {
      // Tinted core (the plain orb's white core washes out under additive blending).
      circlePath(ctx, 0, 0, s * 0.6);
      const g = ctx.createRadialGradient(-s * 0.15, -s * 0.15, 0, 0, 0, s * 0.6);
      g.addColorStop(0, mix(c, '#ffffff', 0.55)); g.addColorStop(0.6, c); g.addColorStop(1, shade(c, -0.25));
      ctx.fillStyle = g; ctx.fill();
      break;
    }
    case 'lance': {
      const L = s * 4.6, w = s * 0.9;
      polyPath(ctx, [[L * 0.55, 0], [L * 0.3, -w / 2], [-L * 0.45, -w * 0.35], [-L * 0.45, w * 0.35], [L * 0.3, w / 2]]);
      ctx.fillStyle = c; ctx.fill();
      ctx.lineWidth = Math.max(0.7, s * 0.2); ctx.strokeStyle = INK; ctx.stroke();
      polyPath(ctx, [[L * 0.45, 0], [L * 0.2, -w * 0.2], [-L * 0.35, -w * 0.12], [-L * 0.35, w * 0.12], [L * 0.2, w * 0.2]]);
      ctx.fillStyle = '#ffffff'; ctx.fill();
      break;
    }
    case 'slug': case 'needle': {
      const L = visual === 'needle' ? s * 3.2 : s * 2.4;
      const w = visual === 'needle' ? s * 0.45 : s * 0.8;
      roundRect(ctx, -L * 0.6, -w / 2, L, w, w / 2);
      ctx.fillStyle = c; ctx.fill();
      ctx.lineWidth = Math.max(0.6, s * 0.2); ctx.strokeStyle = INK; ctx.stroke();
      roundRect(ctx, -L * 0.3, -w * 0.2, L * 0.6, w * 0.4, w * 0.2);
      ctx.fillStyle = '#ffffff'; ctx.fill();
      break;
    }
    case 'missile': {
      const L = s * 3.2;
      // Fins
      polyPath(ctx, [[-L * 0.35, 0], [-L * 0.55, -s * 0.9], [-L * 0.2, -s * 0.3], [-L * 0.2, s * 0.3], [-L * 0.55, s * 0.9]]);
      ctx.fillStyle = '#8a3030'; ctx.fill();
      ctx.lineWidth = Math.max(0.7, s * 0.2); ctx.strokeStyle = INK; ctx.stroke();
      // Body
      roundRect(ctx, -L * 0.5, -s * 0.45, L * 0.85, s * 0.9, s * 0.35);
      ctx.fillStyle = '#e9edf3'; ctx.fill(); ctx.stroke();
      polyPath(ctx, [[L * 0.3, -s * 0.45], [L * 0.55, 0], [L * 0.3, s * 0.45]]);
      ctx.fillStyle = c; ctx.fill(); ctx.stroke();
      break;
    }
    case 'shell': case 'bomb': {
      circlePath(ctx, 0, 0, s);
      const g = ctx.createRadialGradient(-s * 0.3, -s * 0.35, 0, 0, 0, s);
      g.addColorStop(0, visual === 'bomb' ? '#6a6f7c' : '#9aa3b3');
      g.addColorStop(1, visual === 'bomb' ? '#15171d' : '#3a4150');
      ctx.fillStyle = g; ctx.fill();
      ctx.lineWidth = Math.max(0.8, s * 0.22); ctx.strokeStyle = INK; ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, 0, s * 0.7, -0.3, 0.3);
      ctx.lineWidth = s * 0.3; ctx.strokeStyle = c; ctx.stroke();
      if (visual === 'bomb') {
        ctx.lineWidth = s * 0.2; ctx.strokeStyle = '#c9a06a';
        ctx.beginPath(); ctx.moveTo(-s * 0.4, -s * 0.8); ctx.quadraticCurveTo(-s * 0.3, -s * 1.3, s * 0.1, -s * 1.35); ctx.stroke();
      }
      break;
    }
    case 'cryo': {
      polyPath(ctx, [[s * 1.4, 0], [0, -s * 0.6], [-s * 1.0, 0], [0, s * 0.6]]);
      ctx.fillStyle = '#dff8ff'; ctx.fill();
      ctx.lineWidth = Math.max(0.7, s * 0.2); ctx.strokeStyle = '#1a4a7a'; ctx.stroke();
      polyPath(ctx, [[s * 1.1, 0], [0, -s * 0.3], [-s * 0.3, 0]]);
      ctx.fillStyle = c; ctx.fill();
      break;
    }
    case 'orb': case 'plasma': case 'flame': {
      circlePath(ctx, 0, 0, s * 0.55);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      break;
    }
    case 'bolt': default: {
      roundRect(ctx, -s * 1.8, -s * 0.55, s * 2.8, s * 1.1, s * 0.55);
      ctx.fillStyle = c; ctx.fill();
      roundRect(ctx, -s * 1.2, -s * 0.25, s * 2.0, s * 0.5, s * 0.25);
      ctx.fillStyle = '#ffffff'; ctx.fill();
    }
  }
}

// Additive glow for projectiles (drawn with 'lighter').
export function drawProjectileGlow(ctx, visual, color, s) {
  const c = glowColor(color || '#9ef');
  switch (visual) {
    case 'orb': {
      drawGlow(ctx, s * 2.4, c, 0, 0.9);
      drawGlow(ctx, s * 1.1, '#ffffff', 0, 0.9);
      // Crackle arcs
      ctx.strokeStyle = rgba('#ffffff', 0.8);
      ctx.lineWidth = s * 0.12;
      const R = rng(hashStr('orb'));
      for (let i = 0; i < 4; i++) {
        let a = R() * TAU, rr = s * 0.4;
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * rr, Math.sin(a) * rr);
        for (let k = 0; k < 3; k++) { a += (R() - 0.5) * 1.2; rr += s * 0.4; ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr); }
        ctx.stroke();
      }
      break;
    }
    case 'plasmaorb': {
      drawGlow(ctx, s * 2.8, c, 0, 0.75);
      drawGlow(ctx, s * 1.3, mix(c, '#ffffff', 0.25), 0, 0.55);
      // swirling filaments in the orb's own colour
      ctx.strokeStyle = rgba(mix(c, '#ffffff', 0.5), 0.75);
      ctx.lineWidth = s * 0.14;
      for (let i = 0; i < 3; i++) {
        const a0 = (i * TAU) / 3;
        ctx.beginPath();
        for (let k = 0; k <= 10; k++) {
          const f = k / 10, a = a0 + f * 2.4, rr = s * (0.5 + f * 1.3);
          const x = Math.cos(a) * rr, y = Math.sin(a) * rr;
          if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      break;
    }
    case 'plasma': {
      ctx.save();
      ctx.scale(1.5, 1);
      drawGlow(ctx, s * 2.0, c, 0, 0.95);
      drawGlow(ctx, s * 0.9, '#ffffff', 0, 0.9);
      ctx.restore();
      break;
    }
    case 'flame': {
      drawGlow(ctx, s * 1.8, '#ff7a1a', 0, 0.9);
      drawGlow(ctx, s * 1.0, '#ffd27a', 0, 0.9);
      break;
    }
    case 'missile': {
      ctx.save();
      ctx.translate(-s * 1.9, 0);
      drawGlow(ctx, s * 1.4, '#ff9a3a', 0, 0.9);
      drawGlow(ctx, s * 0.6, '#fff3c4', 0, 1);
      ctx.restore();
      break;
    }
    case 'shell': case 'bomb': case 'shard': case 'blade': {
      drawGlow(ctx, s * 1.6, c, 0, 0.35);
      break;
    }
    case 'cryo': {
      drawGlow(ctx, s * 2.0, '#8fe9ff', 0, 0.6);
      break;
    }
    case 'lance': {
      ctx.save();
      ctx.scale(3.0, 0.8);
      drawGlow(ctx, s * 1.7, c, 0, 0.8);
      ctx.restore();
      break;
    }
    case 'slug': case 'needle': {
      ctx.save();
      ctx.scale(2.2, 0.7);
      drawGlow(ctx, s * 1.6, c, 0, 0.7);
      ctx.restore();
      break;
    }
    case 'bolt': default: {
      ctx.save();
      ctx.scale(1.7, 0.85);
      drawGlow(ctx, s * 1.8, c, 0, 0.65);
      ctx.restore();
    }
  }
}

// ---------------------------------------------------------------------------
// Particles and small fx sprites
// ---------------------------------------------------------------------------

export function drawShardFragment(ctx, color, variant, s) {
  const shapes = [
    [[s, 0], [-s * 0.6, -s * 0.7], [-s * 0.4, s * 0.6]],
    [[s * 0.9, -s * 0.2], [0, -s * 0.8], [-s * 0.8, 0], [s * 0.1, s * 0.7]],
    [[s * 1.1, 0], [-s * 0.3, -s * 0.45], [-s * 0.9, 0.1 * s], [-s * 0.2, s * 0.5]],
  ];
  const pts = shapes[variant % shapes.length];
  polyPath(ctx, pts);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = Math.max(0.6, s * 0.22);
  ctx.strokeStyle = INK;
  ctx.stroke();
  polyPath(ctx, [pts[0], pts[1], [0, 0]]);
  ctx.fillStyle = 'rgba(255,255,255,0.45)';
  ctx.fill();
}

export function drawChunk(ctx, color, variant, s) {
  const R = rng(hashStr('chunk' + variant));
  const n = 5;
  const pts = [];
  for (let i = 0; i < n; i++) { const a = (i / n) * TAU + R() * 0.5; const rr = s * (0.6 + R() * 0.4); pts.push([Math.cos(a) * rr, Math.sin(a) * rr]); }
  polyPath(ctx, pts);
  const g = ctx.createLinearGradient(-s, -s, s, s);
  g.addColorStop(0, shade(color, 0.25)); g.addColorStop(1, shade(color, -0.4));
  ctx.fillStyle = g; ctx.fill();
  ctx.lineWidth = Math.max(0.8, s * 0.18); ctx.strokeStyle = INK; ctx.stroke();
  ctx.lineWidth = s * 0.12; ctx.strokeStyle = 'rgba(255,160,60,0.9)';
  ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]); ctx.lineTo(pts[1][0], pts[1][1]); ctx.stroke();
}

export function drawSmokePuff(ctx, s, color = '#8a8f9c') {
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, s);
  g.addColorStop(0, rgba(color, 0.55));
  g.addColorStop(0.6, rgba(color, 0.25));
  g.addColorStop(1, rgba(color, 0));
  ctx.fillStyle = g;
  circlePath(ctx, 0, 0, s);
  ctx.fill();
}

export function drawSparkStreak(ctx, s, color) {
  // A streak along +x, bright center.
  const g = ctx.createLinearGradient(-s, 0, s, 0);
  g.addColorStop(0, rgba(color, 0));
  g.addColorStop(0.7, rgba(color, 0.9));
  g.addColorStop(1, rgba('#ffffff', 1));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(-s, 0);
  ctx.lineTo(s * 0.7, -s * 0.16);
  ctx.lineTo(s, 0);
  ctx.lineTo(s * 0.7, s * 0.16);
  ctx.closePath();
  ctx.fill();
}

export function drawChevron(ctx, s, color) {
  const pts = [[-s * 0.55, -s * 0.7], [s * 0.15, 0], [-s * 0.55, s * 0.7], [-s * 0.2, s * 0.7], [s * 0.5, 0], [-s * 0.2, -s * 0.7]];
  ctx.save();
  ctx.shadowColor = color;
  ctx.shadowBlur = s * 0.6 * pxScale(ctx);
  polyPath(ctx, pts);
  ctx.fillStyle = rgba(color, 0.9);
  ctx.fill();
  ctx.restore();
  polyPath(ctx, pts);
  ctx.fillStyle = rgba('#ffffff', 0.35);
  ctx.fill();
}

// ---------------------------------------------------------------------------
// Blockers and props (static layer)
// ---------------------------------------------------------------------------

// Blockers: terrain features where towers cannot be built. Each one fills its whole footprint
// (radius r) with a clearly bounded base, a raised mound or a sunken pit with an ink rim, so the
// unbuildable area reads at a glance, and takes its ground colors from `pal` (the renderer
// samples them from the painted terrain under the blocker, so they blend with the map art).
export function drawBlocker(ctx, b, pal, seed = 1) {
  const kind = b.kind || 'rock';
  const r = b.r || 40;
  const R = rng(hashStr(kind + ':' + b.x + ',' + b.y) ^ seed);
  const P = {
    ground: (pal && pal.ground) || '#3b4356',
    ground2: (pal && pal.ground2) || '#2a303e',
    accent: (pal && pal.accent) || '#ffb347',
    edge: (pal && pal.edge) || '#6ee7ff',
  };
  switch (kind) {
    case 'crater': case 'pit': case 'lava': blockCrater(ctx, r, R, P, kind === 'lava'); break;
    case 'ice': blockIce(ctx, r, R, P); break;
    case 'crystal': blockCrystal(ctx, r, R, P, b.color); break;
    case 'container': case 'cargo': blockCargo(ctx, r, R, P); break;
    case 'vent': case 'geyser': case 'volcano': blockVent(ctx, r, R, P); break;
    case 'dome': case 'hab': blockDome(ctx, r, P); break;
    case 'wreck':
      ctx.save();
      ctx.rotate(R() * TAU);
      drawShip(ctx, 'hauler', r * 0.8, '#4a4f5c');
      drawShipCracks(ctx, r * 0.8, 3, 'wreck');
      ctx.restore();
      break;
    default: blockRocks(ctx, r, R, P);
  }
}

// Soft ambient occlusion under a feature, offset away from the top-left light.
function groundAO(ctx, r, strength = 0.42, spread = 1.28) {
  const g = ctx.createRadialGradient(r * 0.08, r * 0.12, r * 0.55, r * 0.08, r * 0.12, r * spread);
  g.addColorStop(0, `rgba(0,0,0,${strength})`);
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  circlePath(ctx, r * 0.08, r * 0.12, r * spread);
  ctx.fill();
}

// Irregular closed outline around the origin.
function blobPts(r, n, R, jit = 0.08, sy = 1) {
  const pts = [];
  const rot = R() * TAU;
  for (let i = 0; i < n; i++) {
    const a = rot + (i / n) * TAU;
    const rr = r * (1 - jit / 2 + R() * jit);
    pts.push([Math.cos(a) * rr, Math.sin(a) * rr * sy]);
  }
  return pts;
}

// A faceted boulder at (x, y) of radius s, shaded from the top-left light.
function boulder(ctx, x, y, s, base, R, squash = 0.86) {
  const n = 7 + Math.floor(R() * 3);
  const rot = R() * TAU;
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = rot + (i / n) * TAU;
    const rr = s * (0.78 + R() * 0.26);
    pts.push([x + Math.cos(a) * rr, y + Math.sin(a) * rr * squash]);
  }
  // cast shadow
  ctx.save();
  ctx.translate(s * 0.22, s * 0.3);
  polyPath(ctx, pts);
  ctx.fillStyle = 'rgba(0,0,0,0.38)';
  ctx.fill();
  ctx.restore();
  const cx = x - s * 0.18, cy = y - s * 0.24;
  for (let i = 0; i < n; i++) {
    const p1 = pts[i], p2 = pts[(i + 1) % n];
    const phi = Math.atan2((p1[1] + p2[1]) / 2 - y, (p1[0] + p2[0]) / 2 - x);
    const lb = Math.cos(phi - LIGHT_ANGLE);
    const fc = lb >= 0 ? mix(base, '#e6ecf5', lb * 0.42) : mix(base, '#07090f', -lb * 0.5);
    ctx.beginPath();
    ctx.moveTo(cx, cy); ctx.lineTo(p1[0], p1[1]); ctx.lineTo(p2[0], p2[1]); ctx.closePath();
    ctx.fillStyle = fc;
    ctx.fill();
    ctx.lineWidth = 0.7;
    ctx.strokeStyle = fc;
    ctx.stroke();
  }
  // top facet highlight
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(pts[0][0] * 0.5 + cx * 0.5, pts[0][1] * 0.5 + cy * 0.5);
  ctx.lineWidth = Math.max(0.6, s * 0.05);
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.stroke();
  polyPath(ctx, pts);
  strokeInk(ctx, Math.max(1.4, s * 0.09));
}

function rockTone(P) { return shade(mix(P.ground, '#8b93a3', 0.28), 0.04); }

function blockRocks(ctx, r, R, P) {
  groundAO(ctx, r, 0.45);
  // Rubble apron that fills the footprint.
  const apron = blobPts(r * 0.98, 18, R, 0.1);
  polyPath(ctx, apron);
  const ag = ctx.createRadialGradient(-r * 0.3, -r * 0.35, r * 0.1, 0, 0, r);
  ag.addColorStop(0, shade(P.ground, 0.1));
  ag.addColorStop(1, shade(P.ground2, -0.06));
  ctx.fillStyle = ag;
  ctx.fill();
  strokeInk(ctx, 2);
  // Gravel around the rim
  for (let i = 0; i < 16; i++) {
    const a = R() * TAU, d = r * (0.62 + R() * 0.3);
    boulder(ctx, Math.cos(a) * d, Math.sin(a) * d, r * (0.05 + R() * 0.05), rockTone(P), R);
  }
  // Main boulders, back to front
  const bs = [
    { x: -r * 0.12, y: -r * 0.12, s: r * 0.5 },
    { x: r * 0.42, y: -r * 0.3, s: r * 0.3 },
    { x: -r * 0.48, y: r * 0.22, s: r * 0.32 },
    { x: r * 0.3, y: r * 0.36, s: r * 0.34 },
  ];
  bs.sort((a, b) => a.y - b.y);
  for (const q of bs) boulder(ctx, q.x + (R() - 0.5) * r * 0.08, q.y + (R() - 0.5) * r * 0.08, q.s, rockTone(P), R);
}

function blockCrater(ctx, r, R, P, lava) {
  // Ejecta blanket
  const eg = ctx.createRadialGradient(0, 0, r * 0.9, 0, 0, r * 1.4);
  eg.addColorStop(0, rgba(shade(P.ground, 0.18), 0.5));
  eg.addColorStop(1, rgba(shade(P.ground, 0.18), 0));
  ctx.fillStyle = eg;
  circlePath(ctx, 0, 0, r * 1.4);
  ctx.fill();
  // Raised rim
  const rim = blobPts(r * 1.02, 30, R, 0.07);
  polyPath(ctx, rim);
  const rg = ctx.createLinearGradient(-r, -r, r, r);
  rg.addColorStop(0, shade(P.ground, 0.34));
  rg.addColorStop(0.5, shade(P.ground, 0.04));
  rg.addColorStop(1, shade(P.ground2, -0.3));
  ctx.fillStyle = rg;
  ctx.fill();
  strokeInk(ctx, 2.4);
  // Bowl: shadowed on the top-left inner wall, lit bottom-right
  circlePath(ctx, 0, 0, r * 0.8);
  const bg = ctx.createRadialGradient(r * 0.22, r * 0.26, r * 0.05, 0, 0, r * 0.86);
  if (lava) {
    bg.addColorStop(0, '#ffd27a'); bg.addColorStop(0.4, '#ff6a1a'); bg.addColorStop(1, '#4a0f08');
  } else {
    bg.addColorStop(0, shade(P.ground2, 0.02));
    bg.addColorStop(0.65, shade(P.ground2, -0.28));
    bg.addColorStop(1, shade(P.ground2, -0.5));
  }
  ctx.fillStyle = bg;
  ctx.fill();
  ctx.lineWidth = 1.6;
  ctx.strokeStyle = 'rgba(0,0,0,0.55)';
  ctx.stroke();
  // Inner shadow crescent (top-left) and lit wall (bottom-right)
  ctx.save();
  circlePath(ctx, 0, 0, r * 0.8);
  ctx.clip();
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.8, 0, TAU);
  ctx.arc(r * 0.14, r * 0.17, r * 0.76, 0, TAU, true);
  ctx.fillStyle = 'rgba(0,0,0,0.32)';
  ctx.fill('evenodd');
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.8, 0, TAU);
  ctx.arc(-r * 0.1, -r * 0.12, r * 0.77, 0, TAU, true);
  ctx.fillStyle = rgba(shade(P.ground, 0.3), 0.45);
  ctx.fill('evenodd');
  ctx.restore();
  // Rubble on the floor
  for (let i = 0; i < 6; i++) {
    const a = R() * TAU, d = R() * r * 0.5;
    boulder(ctx, Math.cos(a) * d, Math.sin(a) * d + r * 0.08, r * (0.05 + R() * 0.06), shade(P.ground2, 0.1), R);
  }
  if (lava) return;
  // A small vein of crystal ore catching the light
  ctx.save();
  ctx.shadowColor = P.edge;
  ctx.shadowBlur = r * 0.18 * pxScale(ctx);
  const ox = (R() - 0.5) * r * 0.5, oy = r * (0.1 + R() * 0.2);
  for (let i = 0; i < 3; i++) {
    const h = r * (0.16 + R() * 0.12), w = h * 0.36;
    ctx.save();
    ctx.translate(ox + (i - 1) * r * 0.1, oy + (i === 1 ? -r * 0.04 : 0));
    ctx.rotate((i - 1) * 0.45 + (R() - 0.5) * 0.3);
    polyPath(ctx, [[-w, 0], [-w * 0.7, -h * 0.7], [0, -h], [w * 0.7, -h * 0.7], [w, 0]]);
    const cg = ctx.createLinearGradient(-w, 0, w, 0);
    cg.addColorStop(0, mix(P.edge, '#ffffff', 0.55)); cg.addColorStop(1, shade(P.edge, -0.3));
    ctx.fillStyle = cg;
    ctx.fill();
    ctx.restore();
  }
  ctx.restore();
}

// A cluster of prism crystals growing from (0, baseY), back to front.
function crystalCluster(ctx, r, R, color, n, hMin, hMax, spread, baseY, glow) {
  const cr = [];
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0 : i / (n - 1) - 0.5;
    cr.push({
      x: t * r * spread + (R() - 0.5) * r * 0.12,
      y: baseY + (R() - 0.5) * r * 0.3,
      h: r * (hMin + R() * (hMax - hMin)) * (1 - Math.abs(t) * 0.55),
      w: r * (0.13 + R() * 0.07),
      t: t * 0.9 + (R() - 0.5) * 0.25,
    });
  }
  cr.sort((a, b) => a.y - b.y);
  const k = pxScale(ctx);
  for (const q of cr) {
    ctx.save();
    ctx.translate(q.x, q.y);
    ctx.rotate(q.t);
    const pts = [[-q.w, 0], [-q.w, -q.h * 0.72], [0, -q.h], [q.w, -q.h * 0.72], [q.w, 0]];
    if (glow) { ctx.shadowColor = color; ctx.shadowBlur = r * 0.2 * k; }
    polyPath(ctx, pts);
    ctx.fillStyle = shade(color, -0.25);
    ctx.fill();
    ctx.shadowBlur = 0;
    // left (lit) and right (shaded) facets
    polyPath(ctx, [[-q.w, 0], [-q.w, -q.h * 0.72], [0, -q.h], [0, 0]]);
    ctx.fillStyle = mix(color, '#ffffff', 0.35);
    ctx.fill();
    polyPath(ctx, [[0, 0], [0, -q.h], [q.w, -q.h * 0.72], [q.w, 0]]);
    ctx.fillStyle = shade(color, -0.18);
    ctx.fill();
    polyPath(ctx, [[-q.w, -q.h * 0.72], [0, -q.h], [q.w, -q.h * 0.72], [0, -q.h * 0.8]]);
    ctx.fillStyle = mix(color, '#ffffff', 0.7);
    ctx.fill();
    polyPath(ctx, pts);
    strokeInk(ctx, Math.max(1.2, r * 0.035));
    ctx.beginPath(); ctx.moveTo(-q.w * 0.45, -q.h * 0.15); ctx.lineTo(-q.w * 0.45, -q.h * 0.62);
    ctx.lineWidth = Math.max(0.8, q.w * 0.18); ctx.strokeStyle = 'rgba(255,255,255,0.6)'; ctx.stroke();
    ctx.restore();
  }
}

// Rocky mound that fills the footprint (base for crystal and ice formations).
function mound(ctx, r, R, top, low) {
  groundAO(ctx, r, 0.5);
  const pts = blobPts(r * 0.98, 20, R, 0.1, 0.92);
  polyPath(ctx, pts);
  const g = ctx.createLinearGradient(-r * 0.7, -r * 0.8, r * 0.6, r * 0.9);
  g.addColorStop(0, top); g.addColorStop(1, low);
  ctx.fillStyle = g;
  ctx.fill();
  strokeInk(ctx, 2.2);
  // lit upper rim
  ctx.save();
  polyPath(ctx, pts);
  ctx.clip();
  ctx.beginPath();
  ctx.ellipse(-r * 0.12, -r * 0.16, r * 0.92, r * 0.84, 0, 0, TAU);
  ctx.ellipse(r * 0.02, r * 0.02, r * 0.9, r * 0.82, 0, 0, TAU, true);
  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  ctx.fill('evenodd');
  ctx.restore();
}

function blockCrystal(ctx, r, R, P, color) {
  const c = color || P.accent;
  const base = mix(P.ground2, '#241b38', 0.35);
  mound(ctx, r, R, shade(base, 0.12), shade(base, -0.35));
  // Soft glow pooled on the mound
  const gg = ctx.createRadialGradient(0, -r * 0.1, 0, 0, -r * 0.1, r * 0.9);
  gg.addColorStop(0, rgba(c, 0.32)); gg.addColorStop(1, rgba(c, 0));
  ctx.fillStyle = gg;
  circlePath(ctx, 0, -r * 0.1, r * 0.9);
  ctx.fill();
  for (let i = 0; i < 7; i++) {
    const a = R() * TAU, d = r * (0.55 + R() * 0.3);
    boulder(ctx, Math.cos(a) * d, Math.sin(a) * d * 0.9, r * (0.07 + R() * 0.06), shade(base, 0.05), R);
  }
  crystalCluster(ctx, r, R, c, 3, 0.5, 0.75, 1.1, -r * 0.25, true);
  crystalCluster(ctx, r, R, c, 4, 0.75, 1.3, 1.05, r * 0.2, true);
}

function blockIce(ctx, r, R, P) {
  const ice = '#a8e6ff';
  mound(ctx, r, R, '#bfe2f4', '#3c6890');
  // Frost cracks on the ice sheet
  ctx.save();
  ctx.lineCap = 'round';
  for (let i = 0; i < 5; i++) {
    let a = R() * TAU, x = Math.cos(a) * r * 0.2, y = Math.sin(a) * r * 0.2;
    ctx.beginPath(); ctx.moveTo(x, y);
    for (let s = 0; s < 3; s++) { a += (R() - 0.5) * 0.9; x += Math.cos(a) * r * 0.22; y += Math.sin(a) * r * 0.22; ctx.lineTo(x, y); }
    ctx.lineWidth = 1.1; ctx.strokeStyle = 'rgba(255,255,255,0.55)'; ctx.stroke();
  }
  ctx.restore();
  crystalCluster(ctx, r, R, ice, 3, 0.45, 0.7, 1.15, -r * 0.2, false);
  crystalCluster(ctx, r, R, ice, 4, 0.7, 1.15, 1.0, r * 0.25, false);
  // Snow caps on the rim
  for (let i = 0; i < 5; i++) {
    const a = -Math.PI * 0.9 + R() * Math.PI * 0.8, d = r * (0.7 + R() * 0.2);
    ctx.beginPath();
    ctx.ellipse(Math.cos(a) * d, Math.sin(a) * d * 0.92, r * (0.1 + R() * 0.08), r * 0.06, a + Math.PI / 2, 0, TAU);
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fill();
  }
}

function blockCargo(ctx, r, R, P) {
  groundAO(ctx, r, 0.4, 1.2);
  // Square loading pad with a hazard-striped border, sized to the footprint.
  const s = r * 0.86;
  ctx.save();
  ctx.rotate((R() - 0.5) * 0.3);
  roundRect(ctx, -s, -s, s * 2, s * 2, r * 0.12);
  ctx.fillStyle = shade(P.ground2, -0.25);
  ctx.fill();
  strokeInk(ctx, 2.2);
  ctx.save();
  roundRect(ctx, -s, -s, s * 2, s * 2, r * 0.12);
  ctx.clip();
  const bw = r * 0.16;
  ctx.beginPath();
  ctx.rect(-s, -s, s * 2, s * 2);
  ctx.rect(s - bw, -s + bw, -(s * 2 - bw * 2), s * 2 - bw * 2);
  ctx.fillStyle = '#f2c230';
  ctx.fill('evenodd');
  ctx.beginPath();
  ctx.rect(-s, -s, s * 2, s * 2);
  ctx.rect(s - bw, -s + bw, -(s * 2 - bw * 2), s * 2 - bw * 2);
  ctx.clip('evenodd');
  ctx.fillStyle = '#1a1c22';
  for (let x = -s * 3; x < s * 3; x += bw * 1.6) {
    ctx.beginPath();
    ctx.moveTo(x, -s); ctx.lineTo(x + bw * 0.8, -s); ctx.lineTo(x + bw * 0.8 + s * 2, s); ctx.lineTo(x + s * 2, s);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
  roundRect(ctx, -s + bw, -s + bw, s * 2 - bw * 2, s * 2 - bw * 2, r * 0.05);
  ctx.lineWidth = 1.2; ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.stroke();
  // Containers stacked on the pad
  const cols = ['#e07a3c', '#3fa7a0', '#d9b44a', '#c9503c', '#5a86c8', '#8a6fd6'];
  const L = s * 1.2, Wd = s * 0.5;
  const boxes = [
    { x: -s * 0.05, y: -s * 0.42, a: 0.04, lvl: 0 },
    { x: s * 0.02, y: s * 0.18, a: -0.05, lvl: 0 },
    { x: -s * 0.02, y: -s * 0.12, a: 0.3, lvl: 1 },
  ];
  for (const q of boxes) {
    const c = cols[Math.floor(R() * cols.length)];
    ctx.save();
    ctx.translate(q.x, q.y - q.lvl * r * 0.1);
    ctx.rotate(q.a + (R() - 0.5) * 0.08);
    ctx.fillStyle = 'rgba(0,0,0,0.42)';
    ctx.fillRect(-L / 2 + r * 0.07 * (1 + q.lvl), -Wd / 2 + r * 0.1 * (1 + q.lvl), L, Wd);
    roundRect(ctx, -L / 2, -Wd / 2, L, Wd, r * 0.04);
    const g = ctx.createLinearGradient(0, -Wd / 2, 0, Wd / 2);
    g.addColorStop(0, shade(c, 0.28)); g.addColorStop(1, shade(c, -0.3));
    ctx.fillStyle = g;
    ctx.fill();
    strokeInk(ctx, 1.8);
    ctx.strokeStyle = 'rgba(0,0,0,0.28)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 1; i < 10; i++) { const x = -L / 2 + (L * i) / 10; ctx.moveTo(x, -Wd / 2 + 2); ctx.lineTo(x, Wd / 2 - 2); }
    ctx.stroke();
    ctx.fillStyle = shade(c, -0.45);
    ctx.fillRect(L / 2 - L * 0.08, -Wd / 2 + 1, L * 0.07, Wd - 2);
    ctx.fillStyle = 'rgba(255,255,255,0.2)';
    ctx.fillRect(-L / 2 + 2, -Wd / 2 + 2, L - 4, Wd * 0.14);
    ctx.restore();
  }
  ctx.restore();
}

function blockVent(ctx, r, R, P) {
  groundAO(ctx, r, 0.5, 1.3);
  const pts = blobPts(r, 18, R, 0.14);
  polyPath(ctx, pts);
  const basalt = mix(P.ground2, '#1c1412', 0.4);
  const g = ctx.createRadialGradient(-r * 0.3, -r * 0.3, r * 0.1, 0, 0, r);
  g.addColorStop(0, shade(P.ground, 0.16));
  g.addColorStop(0.6, shade(basalt, 0.02));
  g.addColorStop(1, shade(basalt, -0.4));
  ctx.fillStyle = g;
  ctx.fill();
  strokeInk(ctx, 2.4);
  // cone terraces
  for (const f of [0.72, 0.52]) {
    circlePath(ctx, 0, 0, r * f);
    ctx.lineWidth = 1.2; ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.stroke();
  }
  const k = pxScale(ctx);
  ctx.save();
  ctx.shadowColor = '#ff6a1a';
  ctx.shadowBlur = r * 0.25 * k;
  ctx.lineCap = 'round';
  for (let i = 0; i < 7; i++) {
    let a = R() * TAU, x = Math.cos(a) * r * 0.3, y = Math.sin(a) * r * 0.3;
    ctx.beginPath();
    ctx.moveTo(x, y);
    for (let s = 0; s < 3; s++) { a += (R() - 0.5) * 0.8; x += Math.cos(a) * r * 0.18; y += Math.sin(a) * r * 0.18; ctx.lineTo(x, y); }
    ctx.lineWidth = r * 0.06; ctx.strokeStyle = '#ff8a2a'; ctx.stroke();
    ctx.lineWidth = r * 0.02; ctx.strokeStyle = '#ffe0a0'; ctx.stroke();
  }
  ctx.restore();
  circlePath(ctx, 0, 0, r * 0.36);
  ctx.fillStyle = '#1a0a06';
  ctx.fill();
  strokeInk(ctx, 1.8);
  const mg = ctx.createRadialGradient(0, 0, 0, 0, 0, r * 0.3);
  mg.addColorStop(0, '#fff0b0'); mg.addColorStop(0.35, '#ff9a2a'); mg.addColorStop(1, 'rgba(160,30,10,0.9)');
  circlePath(ctx, 0, 0, r * 0.28);
  ctx.fillStyle = mg;
  ctx.fill();
}

function blockDome(ctx, r, P) {
  circlePath(ctx, r * 0.1, r * 0.15, r);
  ctx.fillStyle = 'rgba(0,0,0,0.4)'; ctx.fill();
  circlePath(ctx, 0, 0, r);
  ctx.fillStyle = '#4a5468'; ctx.fill(); strokeInk(ctx, 2.2);
  circlePath(ctx, 0, 0, r * 0.8);
  const g = ctx.createRadialGradient(-r * 0.3, -r * 0.3, 0, 0, 0, r * 0.8);
  g.addColorStop(0, 'rgba(210,250,255,0.9)'); g.addColorStop(1, rgba(P.edge, 0.35));
  ctx.fillStyle = g; ctx.fill(); strokeInk(ctx, 1.4);
  ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = -2; i <= 2; i++) { ctx.moveTo(i * r * 0.28, -r * 0.76); ctx.lineTo(i * r * 0.28, r * 0.76); }
  ctx.stroke();
}

// ---------------------------------------------------------------------------
// Icons for the UI (shop tiles, wave preview, codex)
// ---------------------------------------------------------------------------

// Fit a world-space drawing of radius `worldR` into a `size` box centered at (size/2, size/2).
export function iconTransform(ctx, size, worldR, pad = 0.08) {
  const s = (size * (1 - pad * 2)) / (worldR * 2);
  ctx.translate(size / 2, size / 2);
  ctx.scale(s, s);
}
