// Menu screens: title, map select, difficulty + commander select, pause, settings, game over,
// codex and records. Screens are rebuilt every time they are shown so they always reflect
// fresh records and settings. A small history stack gives every screen a Back action.

import {
  esc, int, short, dec, clock, duration, credits, glyph, icon, dtypeLabel, dtypeChip, clean, DTYPE_INFO,
} from './format.js';
import { priceFor, BASE_SPEED, TITAN_EVERY, RIG_CAP } from '../data/economy.js';
import * as pathMod from '../sim/path.js';
import * as storage from '../persist/storage.js';
import { UNLOCK, MOD_UNLOCK } from '../data/waves.js';
import { PATH_COLORS } from './ui.js';

const DIFF_ORDER = ['cadet', 'pilot', 'veteran', 'nightmare'];
const DIFF_BLURB = {
  cadet: 'Cheaper towers and a sturdy Core. A good first storm.',
  pilot: 'The standard storm. Balanced costs and armor.',
  veteran: 'Pricier towers and a thinner Core.',
  nightmare: 'A single leak ends the run. Towers cost the most.',
};
const MAP_TAG = { Beginner: 'teal', Intermediate: 'blue', Advanced: 'orange', Expert: 'red' };
const MAP_BLURB = {
  crater: 'One long winding channel. A good place to learn the storm.',
  frost: 'A single channel with a wide loop that passes the center twice.',
  dock: 'Two lanes that merge halfway to the Core.',
  ember: 'Two lanes from opposite edges. Waves alternate between them.',
  prism: 'A short channel that crosses itself. Little time to react.',
};
const LANE_TEXT = { single: 'Single channel', merge: 'Two lanes, merging', alternate: 'Two lanes, alternating' };
function laneText(m) {
  if (LANE_TEXT[m.lanes]) return LANE_TEXT[m.lanes];
  const n = (m.paths || []).length;
  return n > 1 ? `${n} lanes` : 'Single channel';
}
const FIRST_SEEN = UNLOCK;   // first wave each enemy appears in (src/data/waves.js)
const TITANS = [
  { kind: 'maw', name: 'Maw', waves: 'Waves 20, 80, 140', desc: 'Spits meteors behind itself as it advances. The grade of what it spits rises every appearance.' },
  { kind: 'aegis', name: 'Aegis', waves: 'Waves 40, 100, 160', desc: 'Carries a regenerating shield worth a quarter of its hull. Kinetic hits deal only a fifth of their damage to it, and it restores after 8 s without being hit.' },
  { kind: 'rift', name: 'Rift', waves: 'Waves 60, 120, 180', desc: 'At 75, 50 and 25% hull it blinks forward along the channel and stuns towers within 150 units for 1.5 s.' },
];
const MODIFIERS = [
  { key: 'phantom', name: 'Phantom', desc: 'Only towers with detection can target it. Area damage still hits it. Children stay Phantom.' },
  { key: 'nanite', name: 'Nanite', desc: 'Regrows one grade after 3 s without damage, up to its original type. Children inherit it.' },
  { key: 'plated', name: 'Plated', desc: 'Double shell HP on the outer layer. Children are not plated.' },
];

function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
}

function prefersReducedMotion() {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}

function hash(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h;
}
function seeded(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

// =========================================================================== map preview

/** Map card art: the renderer's real map render when available, else the vector sketch. */
function paintMapPreview(g, canvas, map, cssW, cssH) {
  if (g.renderMapPreview) {
    try { if (g.renderMapPreview(canvas, map, cssW, cssH, g.assets)) return; } catch (err) { console.warn('[shardstorm] map preview failed', err); }
  }
  drawMapPreview(canvas, map, cssW, cssH, g.images['map_' + map.id] || null);
}

export function drawMapPreview(canvas, map, cssW, cssH, image = null) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  const ctx = canvas.getContext('2d');
  const k = Math.max(cssW / 1500, cssH / 1000) * dpr;
  const ox = (canvas.width - 1500 * k) / 2, oy = (canvas.height - 1000 * k) / 2;
  const pal = map.palette || {};
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (image) {
    const s = Math.max(canvas.width / image.width, canvas.height / image.height);
    ctx.drawImage(image, (canvas.width - image.width * s) / 2, (canvas.height - image.height * s) / 2, image.width * s, image.height * s);
  } else {
    const g = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
    g.addColorStop(0, pal.ground || '#39425a');
    g.addColorStop(1, pal.ground2 || '#232a3a');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.setTransform(k, 0, 0, k, ox, oy);
  if (!image) {
    // speckle and small craters so the ground reads as terrain
    const rnd = seeded(hash(map.id || 'map'));
    for (let i = 0; i < 90; i++) {
      const x = rnd() * 1500, y = rnd() * 1000, r = 4 + rnd() * 26;
      ctx.fillStyle = `rgba(0,0,0,${0.06 + rnd() * 0.1})`;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = `rgba(255,255,255,${0.02 + rnd() * 0.04})`;
      ctx.beginPath(); ctx.arc(x - r * 0.25, y - r * 0.25, r * 0.6, 0, Math.PI * 2); ctx.fill();
    }
    for (const b of map.blockers || []) {
      const rg = ctx.createRadialGradient(b.x - b.r * 0.3, b.y - b.r * 0.3, b.r * 0.1, b.x, b.y, b.r);
      rg.addColorStop(0, 'rgba(0,0,0,0.55)');
      rg.addColorStop(1, 'rgba(0,0,0,0.15)');
      ctx.fillStyle = rg;
      ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.12)';
      ctx.lineWidth = 5;
      ctx.beginPath(); ctx.arc(b.x, b.y, b.r, Math.PI * 0.9, Math.PI * 1.9); ctx.stroke();
    }
  }
  const width = map.pathWidth || 56;
  const lines = [];
  for (const pts of map.paths || []) {
    let dense = null;
    try { dense = pathMod.smoothPolyline ? pathMod.smoothPolyline(pts) : null; } catch { dense = null; }
    if (!dense) { dense = []; for (const p of pts) dense.push(p[0], p[1]); }
    lines.push(dense);
  }
  const trace = (d) => {
    ctx.beginPath();
    ctx.moveTo(d[0], d[1]);
    for (let i = 2; i < d.length; i += 2) ctx.lineTo(d[i], d[i + 1]);
  };
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const d of lines) { trace(d); ctx.strokeStyle = pal.glow || 'rgba(110,231,255,0.3)'; ctx.lineWidth = width * 1.9; ctx.stroke(); }
  for (const d of lines) { trace(d); ctx.strokeStyle = pal.edge || '#6ee7ff'; ctx.lineWidth = width + 10; ctx.stroke(); }
  for (const d of lines) { trace(d); ctx.strokeStyle = pal.channel || '#141925'; ctx.lineWidth = width; ctx.stroke(); }
  ctx.setLineDash([18, 26]);
  for (const d of lines) { trace(d); ctx.strokeStyle = 'rgba(255,255,255,0.22)'; ctx.lineWidth = 5; ctx.stroke(); }
  ctx.setLineDash([]);
  if (map.core) {
    const c = map.core;
    const rg = ctx.createRadialGradient(c.x, c.y, 4, c.x, c.y, 90);
    rg.addColorStop(0, 'rgba(255,255,255,0.9)');
    rg.addColorStop(0.25, pal.accent || '#ffb347');
    rg.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = rg;
    ctx.beginPath(); ctx.arc(c.x, c.y, 90, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#0b1020';
    ctx.strokeStyle = pal.accent || '#ffb347';
    ctx.lineWidth = 8;
    ctx.beginPath();
    for (let i = 0; i < 6; i++) { const a = Math.PI / 6 + i * Math.PI / 3; ctx.lineTo(c.x + Math.cos(a) * 34, c.y + Math.sin(a) * 34); }
    ctx.closePath(); ctx.fill(); ctx.stroke();
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

// =========================================================================== starfield

const METEOR_COLORS = [
  ['#ff6b6b', '#8f1d2c'], ['#5aa2ff', '#16307a'], ['#44f09a', '#0d6b3d'], ['#ffe066', '#9a6a00'],
  ['#ff86d3', '#8a2166'], ['#b98cff', '#4a2396'], ['#8ff3ff', '#1c6e86'],
];

class Sky {
  constructor(canvas, game) {
    this.canvas = canvas;
    this.game = game;
    this.ctx = canvas.getContext('2d');
    this.running = false;
    this.stars = [];
    this.meteors = [];
    this.w = 0; this.h = 0; this.dpr = 1;
    this.bake = null;
    this.last = 0;
    this.spawnT = 0;
    this.image = null;
    this._raf = 0;
    this._frame = (t) => this.frame(t);
    this._onResize = () => { if (this.running) { this.resize(); if (this.reduced) this.draw(0, 0); } };
    window.addEventListener('resize', this._onResize);
  }

  setImage(img) { this.image = img; this.w = 0; }

  get reduced() { return this.game.reducedMotion; }

  resize() {
    const c = this.canvas;
    const w = c.clientWidth || window.innerWidth, h = c.clientHeight || window.innerHeight;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (w === this.w && h === this.h && dpr === this.dpr && this.bake) return;
    this.w = w; this.h = h; this.dpr = dpr;
    c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
    const rnd = seeded(1234567);
    const n = Math.round(Math.min(420, (w * h) / 3200));
    this.stars = [];
    for (let i = 0; i < n; i++) {
      const layer = rnd() < 0.7 ? 0 : rnd() < 0.8 ? 1 : 2;
      this.stars.push({
        x: rnd() * w, y: rnd() * h * 0.92, r: [0.6, 1.0, 1.6][layer] * (0.7 + rnd() * 0.6),
        a: 0.35 + rnd() * 0.6, tw: 0.6 + rnd() * 2.2, ph: rnd() * 6.28, v: [2, 5, 10][layer],
        c: rnd() < 0.15 ? '#bfe9ff' : rnd() < 0.1 ? '#ffd9f2' : '#ffffff',
      });
    }
    this.bakeStatic();
    if (!this.meteors.length) for (let i = 0; i < 5; i++) this.spawnMeteor(true);
  }

  bakeStatic() {
    const w = this.w, h = this.h, dpr = this.dpr;
    const c = document.createElement('canvas');
    c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
    const g = c.getContext('2d');
    g.scale(dpr, dpr);
    if (this.image) {
      const img = this.image;
      const s = Math.max(w / img.width, h / img.height);
      g.drawImage(img, (w - img.width * s) / 2, (h - img.height * s) / 2, img.width * s, img.height * s);
      const v = g.createLinearGradient(0, 0, 0, h);
      v.addColorStop(0, 'rgba(4,6,14,0.45)');
      v.addColorStop(0.5, 'rgba(4,6,14,0.25)');
      v.addColorStop(1, 'rgba(4,6,14,0.8)');
      g.fillStyle = v;
      g.fillRect(0, 0, w, h);
      // darker pool behind the wordmark and menu so text stays readable over busy art
      const rg = g.createRadialGradient(w / 2, h * 0.5, 0, w / 2, h * 0.5, Math.max(w, h) * 0.55);
      rg.addColorStop(0, 'rgba(4,6,14,0.62)');
      rg.addColorStop(0.55, 'rgba(4,6,14,0.3)');
      rg.addColorStop(1, 'rgba(4,6,14,0)');
      g.fillStyle = rg;
      g.fillRect(0, 0, w, h);
      this.bake = c;
      return;
    }
    const bg = g.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, '#04060f');
    bg.addColorStop(0.55, '#0a0f26');
    bg.addColorStop(1, '#1a1033');
    g.fillStyle = bg;
    g.fillRect(0, 0, w, h);
    // nebulae
    const neb = (x, y, r, col) => {
      const rg = g.createRadialGradient(x, y, 0, x, y, r);
      rg.addColorStop(0, col);
      rg.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = rg;
      g.fillRect(x - r, y - r, r * 2, r * 2);
    };
    neb(w * 0.18, h * 0.22, Math.max(w, h) * 0.45, 'rgba(62,240,216,0.10)');
    neb(w * 0.82, h * 0.3, Math.max(w, h) * 0.5, 'rgba(155,123,255,0.14)');
    neb(w * 0.6, h * 0.05, Math.max(w, h) * 0.3, 'rgba(255,110,199,0.07)');
    // moon horizon
    const R = Math.max(w * 1.15, h * 1.3);
    const cx = w * 0.5, cy = h * 0.84 + R;
    const top = cy - R;
    const glow = g.createRadialGradient(cx, top, 0, cx, top, Math.max(w, h) * 0.45);
    glow.addColorStop(0, 'rgba(62,240,216,0.22)');
    glow.addColorStop(1, 'rgba(62,240,216,0)');
    g.fillStyle = glow;
    g.fillRect(0, 0, w, h);
    const mg = g.createLinearGradient(0, top, 0, h);
    mg.addColorStop(0, '#1e2742');
    mg.addColorStop(0.3, '#121829');
    mg.addColorStop(1, '#090c16');
    g.fillStyle = mg;
    g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.fill();
    g.strokeStyle = 'rgba(120,240,255,0.55)';
    g.lineWidth = 1.5;
    g.beginPath(); g.arc(cx, cy, R, Math.PI * 1.15, Math.PI * 1.85); g.stroke();
    // craters on the moon rim
    const rnd = seeded(99);
    for (let i = 0; i < 26; i++) {
      const a = Math.PI * (1.2 + rnd() * 0.6);
      const rr = R - 8 - rnd() * Math.min(160, h * 0.15);
      const x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr;
      if (y > h + 20) continue;
      const cr = 4 + rnd() * 18;
      g.fillStyle = 'rgba(0,0,0,0.28)';
      g.beginPath(); g.ellipse(x, y, cr, cr * 0.38, 0, 0, Math.PI * 2); g.fill();
    }
    // colony silhouette around the Core
    const baseY = (x) => cy - Math.sqrt(Math.max(0, R * R - (x - cx) * (x - cx)));
    g.fillStyle = '#070a14';
    const domes = [[-0.2, 26], [-0.13, 16], [-0.07, 34], [0.08, 22], [0.14, 30], [0.21, 14]];
    for (const [dx, r] of domes) {
      const x = cx + dx * w, y = baseY(x) + 3;
      g.beginPath(); g.arc(x, y, r, Math.PI, 0); g.fill();
      g.fillStyle = 'rgba(255,190,90,0.8)';
      for (let j = 0; j < 3; j++) g.fillRect(x - r * 0.5 + j * r * 0.4, y - r * 0.35, 2, 2);
      g.fillStyle = '#070a14';
    }
    const towers = [[-0.16, 70], [-0.1, 46], [0.11, 58], [0.18, 40]];
    for (const [dx, th] of towers) {
      const x = cx + dx * w, y = baseY(x) + 2;
      g.fillRect(x - 3, y - th, 6, th);
      g.fillRect(x - 9, y - th * 0.55, 18, 4);
      g.fillStyle = '#ff5d6c';
      g.fillRect(x - 1.5, y - th - 4, 3, 3);
      g.fillStyle = '#070a14';
    }
    // the Core
    const coreY = baseY(cx) - 18;
    const cg = g.createRadialGradient(cx, coreY, 0, cx, coreY, 120);
    cg.addColorStop(0, 'rgba(255,255,255,0.95)');
    cg.addColorStop(0.12, 'rgba(120,255,240,0.8)');
    cg.addColorStop(0.4, 'rgba(155,123,255,0.25)');
    cg.addColorStop(1, 'rgba(155,123,255,0)');
    g.fillStyle = cg;
    g.fillRect(cx - 120, coreY - 120, 240, 240);
    const beam = g.createLinearGradient(0, coreY, 0, 0);
    beam.addColorStop(0, 'rgba(120,255,240,0.22)');
    beam.addColorStop(1, 'rgba(120,255,240,0)');
    g.fillStyle = beam;
    g.beginPath(); g.moveTo(cx - 6, coreY); g.lineTo(cx + 6, coreY); g.lineTo(cx + 40, 0); g.lineTo(cx - 40, 0); g.closePath(); g.fill();
    this.bake = c;
  }

  spawnMeteor(initial = false) {
    const w = this.w, h = this.h;
    const size = 6 + Math.random() * Math.random() * 26;
    const speed = 40 + Math.random() * 80 + (26 - size) * 2;
    const ang = Math.PI * (0.62 + Math.random() * 0.12); // down-left
    const col = METEOR_COLORS[Math.floor(Math.random() * METEOR_COLORS.length)];
    const x = initial ? Math.random() * w * 1.1 : w + 40 + Math.random() * w * 0.3;
    const y = initial ? Math.random() * h * 0.6 : -40 - Math.random() * h * 0.4;
    const m = {
      x, y, vx: Math.cos(ang) * speed, vy: Math.sin(ang) * speed, size, rot: Math.random() * 6.28,
      vr: (Math.random() - 0.5) * 1.6, col, sprite: null, trail: 40 + size * 5,
    };
    m.sprite = this.crystalSprite(size, col);
    this.meteors.push(m);
  }

  crystalSprite(size, [light, dark]) {
    const dpr = this.dpr;
    const pad = size * 1.2;
    const s = Math.ceil((size * 2 + pad * 2) * dpr);
    const c = document.createElement('canvas');
    c.width = c.height = s;
    const g = c.getContext('2d');
    g.scale(dpr, dpr);
    const cx = size + pad, cy = size + pad;
    const glow = g.createRadialGradient(cx, cy, 0, cx, cy, size * 2);
    glow.addColorStop(0, light + '66');
    glow.addColorStop(1, light + '00');
    g.fillStyle = glow;
    g.fillRect(0, 0, s, s);
    const n = 6 + Math.floor(Math.random() * 3);
    const pts = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + (Math.random() - 0.5) * 0.4;
      const r = size * (0.72 + Math.random() * 0.34);
      pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
    }
    const fill = g.createLinearGradient(cx - size, cy - size, cx + size, cy + size);
    fill.addColorStop(0, '#ffffff');
    fill.addColorStop(0.25, light);
    fill.addColorStop(1, dark);
    g.fillStyle = fill;
    g.beginPath(); pts.forEach((p, i) => (i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]))); g.closePath(); g.fill();
    // facets
    const hub = [cx - size * 0.15, cy - size * 0.2];
    for (let i = 0; i < n; i++) {
      const p = pts[i], q = pts[(i + 1) % n];
      g.fillStyle = i % 2 ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.16)';
      g.beginPath(); g.moveTo(hub[0], hub[1]); g.lineTo(p[0], p[1]); g.lineTo(q[0], q[1]); g.closePath(); g.fill();
    }
    g.strokeStyle = 'rgba(10,8,30,0.7)';
    g.lineWidth = Math.max(1, size * 0.09);
    g.beginPath(); pts.forEach((p, i) => (i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]))); g.closePath(); g.stroke();
    return { c, half: (size + pad) };
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.resize();
    this.last = performance.now();
    if (this.reduced) { this.draw(0, 0); return; }
    this._raf = requestAnimationFrame(this._frame);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this._raf);
  }

  frame(now) {
    if (!this.running) return;
    this._raf = requestAnimationFrame(this._frame);
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    this.resize();
    this.draw(dt, now / 1000);
  }

  draw(dt, t) {
    const g = this.ctx, w = this.w, h = this.h, dpr = this.dpr;
    g.setTransform(1, 0, 0, 1, 0, 0);
    if (this.bake) g.drawImage(this.bake, 0, 0);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!this.image) {
      for (const s of this.stars) {
        s.x -= s.v * dt;
        if (s.x < -2) s.x += w + 4;
        const a = s.a * (0.65 + 0.35 * Math.sin(t * s.tw + s.ph));
        g.globalAlpha = a;
        g.fillStyle = s.c;
        g.fillRect(s.x - s.r / 2, s.y - s.r / 2, s.r, s.r);
      }
      g.globalAlpha = 1;
    }
    // meteors
    this.spawnT -= dt;
    const target = this.image ? 3 : Math.max(4, Math.round(w / 260));
    if (this.spawnT <= 0 && this.meteors.length < target && dt > 0) {
      this.spawnMeteor();
      this.spawnT = 0.5 + Math.random() * 1.4;
    }
    g.globalCompositeOperation = 'lighter';
    for (const m of this.meteors) {
      m.x += m.vx * dt; m.y += m.vy * dt; m.rot += m.vr * dt;
      const sp = Math.hypot(m.vx, m.vy) || 1;
      const tx = m.x - (m.vx / sp) * m.trail, ty = m.y - (m.vy / sp) * m.trail;
      const tg = g.createLinearGradient(m.x, m.y, tx, ty);
      tg.addColorStop(0, m.col[0] + 'aa');
      tg.addColorStop(1, m.col[0] + '00');
      g.strokeStyle = tg;
      g.lineWidth = m.size * 0.9;
      g.lineCap = 'round';
      g.beginPath(); g.moveTo(m.x, m.y); g.lineTo(tx, ty); g.stroke();
    }
    g.globalCompositeOperation = 'source-over';
    for (const m of this.meteors) {
      g.save();
      g.translate(m.x, m.y);
      g.rotate(m.rot);
      g.drawImage(m.sprite.c, -m.sprite.half, -m.sprite.half, m.sprite.half * 2, m.sprite.half * 2);
      g.restore();
    }
    this.meteors = this.meteors.filter((m) => m.x > -120 && m.y < h + 120);
  }
}

// =========================================================================== screens

export class Screens {
  constructor(game) {
    this.game = game;
    this.root = document.getElementById('screens');
    this.root.innerHTML = '<canvas class="sky" aria-hidden="true"></canvas><div class="screens__layer"></div>';
    this.layer = this.root.querySelector('.screens__layer');
    this.sky = new Sky(this.root.querySelector('.sky'), game);
    this.stack = [];
    this.current = null;
    this.currentEl = null;
    this.codexTab = 'enemies';
    this.codexTower = null;
    this.root.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (b && !b.disabled && b.getAttribute('aria-disabled') !== 'true') this.game.uiClick();
    });
    this.root.addEventListener('keydown', (e) => this._menuKeys(e));
  }

  get isOpen() { return !!this.current; }
  get isModal() { return !!this.current && this.game.inGame; }

  /** Show a screen. opts.replace swaps the top of the stack instead of pushing. */
  show(name, params = {}, opts = {}) {
    if (opts.reset) this.stack = [];
    else if (opts.replace) this.stack.pop();
    this.stack.push({ name, params });
    this._render();
  }

  back() {
    const top = this.stack[this.stack.length - 1];
    if (!top) return;
    if (top.name === 'title') return;
    if (top.name === 'pause') { this.game.resume(); return; }
    if (top.name === 'gameover') return;
    this.stack.pop();
    if (!this.stack.length) {
      if (this.game.inGame) { this.closeAll(); this.game.resume(); return; }
      this.stack.push({ name: 'title', params: {} });
    }
    this._render();
  }

  closeAll() {
    this.stack = [];
    this.current = null;
    const old = this.currentEl;
    this.currentEl = null;
    if (old) this._dismiss(old);
    this.root.classList.remove('is-open', 'is-menu', 'is-modal');
    this._setInert(false);
    this.sky.stop();
  }

  /** While a screen is open, the game layer behind it cannot take focus or clicks. */
  _setInert(on) {
    const gameEl = this.game.gameEl;
    if (!gameEl) return;
    try { gameEl.inert = !!on; } catch { /* old browsers */ }
    if (on) gameEl.setAttribute('aria-hidden', 'true');
    else gameEl.removeAttribute('aria-hidden');
  }

  refresh() {
    if (this.current) this._render(true);
  }

  _render(instant = false) {
    const top = this.stack[this.stack.length - 1];
    if (!top) { this.closeAll(); return; }
    const builder = this['_' + top.name];
    if (!builder) { console.error('unknown screen', top.name); return; }
    const inGame = this.game.inGame;
    const node = el('section', `screen screen--${top.name} ${inGame ? 'screen--modal' : 'screen--full'}`);
    node.setAttribute('role', inGame ? 'dialog' : 'region');
    node.setAttribute('aria-modal', inGame ? 'true' : 'false');
    builder.call(this, node, top.params || {});
    const old = this.currentEl;
    this.current = top.name;
    this.currentEl = node;
    this.root.classList.add('is-open');
    this.root.classList.toggle('is-menu', !inGame);
    this.root.classList.toggle('is-modal', inGame);
    this._setInert(true);
    this.layer.appendChild(node);
    if (!inGame) this.sky.start(); else this.sky.stop();
    if (old) this._dismiss(old, instant);
    if (instant || this.game.reducedMotion) node.classList.add('in');
    else requestAnimationFrame(() => requestAnimationFrame(() => node.classList.add('in')));
    // focus the first primary action for keyboard players
    node.tabIndex = -1;
    const f = node.querySelector('[data-autofocus]') || node.querySelector('.btn--primary') || node;
    try { f.focus({ preventScroll: true }); } catch { /* ignore */ }
  }

  _dismiss(node, instant = false) {
    if (instant || this.game.reducedMotion) { node.remove(); return; }
    node.classList.remove('in');
    node.classList.add('out');
    setTimeout(() => node.remove(), 220);
  }

  _menuKeys(e) {
    if (!['ArrowDown', 'ArrowUp'].includes(e.key)) return;
    const menu = e.target.closest?.('.menu');
    if (!menu) return;
    const items = [...menu.querySelectorAll('button:not([disabled])')];
    const i = items.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    const n = items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length];
    n.focus();
  }

  _header(node, title, sub = '', { back = true } = {}) {
    const h = el('header', 'screen__head');
    h.innerHTML = `
      ${back ? `<button type="button" class="btn btn--ghost btn--back" data-act="back" aria-label="Back (Esc)">${icon('back')}<span>Back</span></button>` : '<span></span>'}
      <div class="screen__titles"><h1 class="screen__title">${esc(title)}</h1>${sub ? `<p class="screen__sub">${esc(sub)}</p>` : ''}</div>
      <span class="screen__head-end"></span>`;
    h.querySelector('[data-act="back"]')?.addEventListener('click', () => this.back());
    node.appendChild(h);
    return h;
  }

  // ------------------------------------------------------------------------- title

  _title(node) {
    const g = this.game;
    const save = storage.loadRun();
    const rec = storage.loadRecords();
    const { MAPS, DIFFICULTIES } = g.data;
    let contSub = '';
    if (save) {
      const m = save.meta || {};
      const map = MAPS[m.mapId];
      const d = DIFFICULTIES[m.difficulty];
      contSub = [map?.name, d?.name, m.cleared != null ? `Wave ${m.cleared + 1}` : null].filter(Boolean).join(' · ');
    }
    const logo = g.images.logo;
    node.innerHTML = `
      <div class="title">
        <div class="title__brand">
          ${logo ? `<img class="title__logo" src="${esc(logo.src)}" alt="SHARDSTORM">` : `
          <div class="emblem" aria-hidden="true">
            <svg viewBox="0 0 80 84">
              <defs>
                <linearGradient id="emA" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#d6fffa"/><stop offset=".4" stop-color="#3ef0d8"/><stop offset="1" stop-color="#5a3dff"/></linearGradient>
                <linearGradient id="emB" x1="1" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#efe6ff"/><stop offset=".5" stop-color="#9b7bff"/><stop offset="1" stop-color="#ff6ec7"/></linearGradient>
              </defs>
              <path d="M17 30 26 36 24 66 16 70 10 44z" fill="url(#emB)" opacity=".92"/>
              <path d="M17 30 20 48 16 70 10 44z" fill="rgba(255,255,255,.22)"/>
              <path d="M63 30 70 44 64 70 56 66 54 36z" fill="url(#emB)" opacity=".92"/>
              <path d="M63 30 60 48 64 70 70 44z" fill="rgba(0,0,0,.18)"/>
              <path d="M40 2 55 26 47 80 40 74 33 80 25 26z" fill="url(#emA)"/>
              <path d="M40 2 47 26 40 74 33 26z" fill="rgba(255,255,255,.34)"/>
              <path d="M40 2 55 26 47 26z" fill="rgba(255,255,255,.2)"/>
              <path d="M25 26h30" stroke="rgba(6,10,30,.4)" stroke-width="1.4"/>
            </svg>
          </div>
          <h1 class="wordmark" aria-label="Shardstorm"><span class="wordmark__a">SHARD</span><span class="wordmark__b">STORM</span></h1>`}
          <p class="title__tag">Hold the Core. The storm never ends.</p>
        </div>
        <nav class="menu title__menu" aria-label="Main menu">
          ${save ? `<button type="button" class="btn btn--primary btn--xl" data-act="continue" data-autofocus>
            ${icon('play')}<span class="btn__stack"><span>Continue</span><span class="btn__sub">${esc(contSub)}</span></span></button>` : ''}
          <button type="button" class="btn ${save ? 'btn--glass' : 'btn--primary'} btn--xl" data-act="play" ${save ? '' : 'data-autofocus'}>
            ${icon(save ? 'map' : 'play')}<span>Play</span></button>
          <div class="menu__row">
            <button type="button" class="btn btn--glass" data-act="codex">${icon('book')}<span>Codex</span></button>
            <button type="button" class="btn btn--glass" data-act="records">${icon('trophy')}<span>Records</span></button>
            <button type="button" class="btn btn--glass" data-act="settings">${icon('gear')}<span>Settings</span></button>
          </div>
        </nav>
        <footer class="title__foot">
          <span>${rec.highest ? `${icon('star')} Best wave ${int(rec.highest)}` : 'An endless tower defense'}</span>
          <span class="title__ver">v1.0</span>
        </footer>
      </div>`;
    node.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-act]');
      if (!b) return;
      const a = b.dataset.act;
      if (a === 'continue') g.continueRun();
      else if (a === 'play') this.show('maps');
      else if (a === 'codex') this.show('codex');
      else if (a === 'records') this.show('records');
      else if (a === 'settings') this.show('settings');
    });
  }

  // ------------------------------------------------------------------------- map select

  _maps(node) {
    const g = this.game;
    const { MAPS, MAP_ORDER, DIFFICULTIES } = g.data;
    const rec = storage.loadRecords();
    this._header(node, 'Choose a map', 'Every map is endless. Your best wave is your score.');
    const grid = el('div', 'map-grid');
    const order = MAP_ORDER.filter((id) => MAPS[id]);
    for (const id of order) {
      const m = MAPS[id];
      const tagColor = MAP_TAG[m.difficulty] || 'teal';
      const best = DIFF_ORDER.filter((d) => DIFFICULTIES[d]).map((d) => {
        const v = rec.best?.[id]?.[d] || 0;
        return `<span class="best-chip ${v ? 'has' : ''}" title="${esc(DIFFICULTIES[d].name)}: best wave ${v || 'none yet'}"><span class="best-chip__k">${esc(DIFFICULTIES[d].name.charAt(0))}</span><span class="best-chip__v">${v || '·'}</span></span>`;
      }).join('');
      const b = el('button', 'map-card');
      b.type = 'button';
      b.dataset.map = id;
      if (g.settings.lastMap === id) b.setAttribute('data-autofocus', '');
      b.setAttribute('aria-label', `${m.name}, ${m.difficulty}`);
      b.innerHTML = `
        <span class="map-card__art"><canvas></canvas><span class="tag tag--${tagColor} map-card__tag">${esc(m.difficulty || '')}</span></span>
        <span class="map-card__body">
          <span class="map-card__name">${esc(m.name)}</span>
          <span class="map-card__meta">${esc(laneText(m))}</span>
          <span class="map-card__best"><span class="map-card__best-l">Best</span>${best}</span>
        </span>`;
      grid.appendChild(b);
    }
    node.appendChild(grid);
    // draw previews after layout so they match the card size
    requestAnimationFrame(() => {
      for (const b of grid.querySelectorAll('.map-card')) {
        const m = MAPS[b.dataset.map];
        const art = b.querySelector('.map-card__art');
        const w = Math.max(200, Math.round(art.clientWidth || 300));
        paintMapPreview(g, b.querySelector('canvas'), m, w, Math.round(w / 1.5));
      }
    });
    grid.addEventListener('click', (e) => {
      const b = e.target.closest('.map-card');
      if (!b) return;
      g.updateSettings({ lastMap: b.dataset.map });
      this.show('difficulty', { mapId: b.dataset.map });
    });
  }

  // ------------------------------------------------------------------------- difficulty + commander

  _difficulty(node, params) {
    const g = this.game;
    const { MAPS, DIFFICULTIES, HEROES, HERO_ORDER } = g.data;
    const map = MAPS[params.mapId] || MAPS[g.data.MAP_ORDER[0]];
    const rec = storage.loadRecords();
    let diff = DIFFICULTIES[g.settings.lastDifficulty] ? g.settings.lastDifficulty : 'pilot';
    const heroIds = (HERO_ORDER || []).filter((id) => HEROES[id]);
    let hero = heroIds.includes(g.settings.lastHero) ? g.settings.lastHero : null;

    this._header(node, 'New run', 'Choose a difficulty' + (heroIds.length ? ' and a commander' : ''));
    let coreSrc = null;
    try { coreSrc = g.assets?.image?.('ui_integrity')?.src || null; } catch { coreSrc = null; }
    const coreArt = coreSrc ? `<img class="dstat__art" src="${esc(coreSrc)}" width="22" height="22" alt="" draggable="false">` : icon('core');
    const body = el('div', 'setup');
    const bestChips = DIFF_ORDER.filter((d) => DIFFICULTIES[d]).map((d) => {
      const v = rec.best?.[map.id]?.[d] || 0;
      return `<span class="best-chip ${v ? 'has' : ''}" title="${esc(DIFFICULTIES[d].name)}: best wave ${v || 'none yet'}"><span class="best-chip__k">${esc(DIFFICULTIES[d].name.charAt(0))}</span><span class="best-chip__v">${v || '·'}</span></span>`;
    }).join('');
    body.innerHTML = `
      <aside class="map-strip">
        <span class="map-strip__art"><canvas></canvas><span class="tag tag--${MAP_TAG[map.difficulty] || 'teal'} map-card__tag">${esc(map.difficulty || '')}</span></span>
        <div class="map-strip__body">
          <h2 class="map-strip__name">${esc(map.name)}</h2>
          <span class="map-card__meta">${esc(laneText(map))}</span>
          <p class="map-strip__desc">${esc(MAP_BLURB[map.id] || '')}</p>
          <span class="map-card__best"><span class="map-card__best-l">Best</span>${bestChips}</span>
          <button type="button" class="btn btn--ghost btn--sm map-strip__change" data-act="maps">${icon('map')}<span>Change map</span></button>
        </div>
      </aside>
      <div class="setup__main">
      <div class="diff-grid" role="radiogroup" aria-label="Difficulty">
        ${DIFF_ORDER.filter((d) => DIFFICULTIES[d]).map((d) => {
          const D = DIFFICULTIES[d];
          const pctv = Math.round((D.costMult - 1) * 100);
          const best = rec.best?.[map.id]?.[d] || 0;
          return `<button type="button" class="diff-card diff-card--${d}" role="radio" data-diff="${d}" aria-checked="false">
            <span class="diff-card__name">${esc(D.name)}</span>
            <span class="diff-card__blurb">${esc(DIFF_BLURB[d] || '')}</span>
            <span class="diff-card__stats">
              <span class="dstat"><span class="dstat__top"><span class="dstat__i">${coreArt}</span><span class="dstat__v">${int(D.lives)}</span></span><span class="dstat__k">Core</span></span>
              <span class="dstat"><span class="dstat__top"><span class="dstat__i">${glyph()}</span><span class="dstat__v">${pctv === 0 ? 'x1.00' : 'x' + D.costMult.toFixed(2)}</span></span><span class="dstat__k">${pctv === 0 ? 'Standard costs' : pctv < 0 ? `${-pctv}% cheaper` : `${pctv}% pricier`}</span></span>
            </span>
            <span class="diff-card__best">${best ? `${icon('star')} Best wave ${best}` : 'No record yet'}</span>
          </button>`;
        }).join('')}
      </div>
      ${heroIds.length ? `
      <div class="setup__section">
        <h2 class="section-title">Commander</h2>
        <p class="section-sub">One per run. Levels up automatically as waves fall.</p>
        <div class="hero-grid" role="radiogroup" aria-label="Commander">
          <button type="button" class="hero-card hero-card--none" role="radio" data-hero="" aria-checked="false">
            <span class="hero-card__art hero-card__art--none">${icon('close')}</span>
            <span class="hero-card__body"><span class="hero-card__name">No commander</span><span class="hero-card__blurb">Spend every credit on towers.</span></span>
          </button>
          ${heroIds.map((id) => {
            const H = HEROES[id];
            return `<button type="button" class="hero-card" role="radio" data-hero="${esc(id)}" aria-checked="false">
              <span class="hero-card__art"><canvas></canvas></span>
              <span class="hero-card__body">
                <span class="hero-card__name">${esc(H.name)}</span>
                <span class="hero-card__blurb">${esc(clean(H.blurb || H.role || H.desc || ''))}</span>
                <span class="hero-card__price" data-hero-price="${esc(id)}"></span>
              </span>
            </button>`;
          }).join('')}
        </div>
      </div>` : ''}
      <div class="setup__foot">
        <p class="setup__note">${storage.hasRun() ? `${icon('info')} Starting a new run replaces your saved run.` : ''}</p>
        <button type="button" class="btn btn--primary btn--xl setup__start" data-act="start" data-autofocus>${icon('play')}<span>Start run</span></button>
      </div>
      </div>`;
    node.appendChild(body);
    requestAnimationFrame(() => {
      const art = body.querySelector('.map-strip__art');
      const w = Math.max(200, Math.round(art.clientWidth || 360));
      paintMapPreview(g, art.querySelector('canvas'), map, w, Math.round(w / 1.5));
    });
    for (const c of body.querySelectorAll('.hero-card canvas')) {
      const id = c.closest('.hero-card').dataset.hero;
      g.icons.hero(c, HEROES[id], 52);
    }
    const sync = () => {
      for (const b of body.querySelectorAll('[data-diff]')) b.setAttribute('aria-checked', String(b.dataset.diff === diff));
      for (const b of body.querySelectorAll('[data-hero]')) b.setAttribute('aria-checked', String((b.dataset.hero || null) === hero));
      for (const p of body.querySelectorAll('[data-hero-price]')) {
        const H = HEROES[p.dataset.heroPrice];
        p.innerHTML = credits(priceFor(H.cost || 0, diff));
      }
    };
    sync();
    body.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.diff) { diff = b.dataset.diff; g.updateSettings({ lastDifficulty: diff }); sync(); }
      else if (b.dataset.hero !== undefined) { hero = b.dataset.hero || null; g.updateSettings({ lastHero: hero }); sync(); }
      else if (b.dataset.act === 'start') g.startNew({ mapId: map.id, difficulty: diff, heroId: hero });
      else if (b.dataset.act === 'maps') this.back();
    });
  }

  // ------------------------------------------------------------------------- pause

  _pause(node) {
    const g = this.game;
    const s = g.sim?.state;
    const map = g.data.MAPS[s?.mapId];
    const diff = g.data.DIFFICULTIES[s?.difficulty];
    node.innerHTML = `
      <div class="modal modal--pause">
        <h1 class="modal__title">Paused</h1>
        <p class="modal__sub">${esc([map?.name, diff?.name, s ? `Wave ${s.wave}` : null].filter(Boolean).join(' · '))}</p>
        <nav class="menu modal__menu" aria-label="Pause menu">
          <button type="button" class="btn btn--primary btn--lg" data-act="resume" data-autofocus>${icon('play')}<span>Resume</span></button>
          <button type="button" class="btn btn--glass btn--lg" data-act="restart">${icon('restart')}<span>Restart</span></button>
          <button type="button" class="btn btn--glass btn--lg" data-act="settings">${icon('gear')}<span>Settings</span></button>
          <button type="button" class="btn btn--glass btn--lg" data-act="codex">${icon('book')}<span>Codex</span></button>
          <button type="button" class="btn btn--glass btn--lg btn--quiet" data-act="quit">${icon('home')}<span>Quit to title</span></button>
        </nav>
        <p class="modal__note">${storage.persistent() ? 'Your run saves after every cleared wave.' : 'Saving is unavailable in this browser.'}</p>
      </div>`;
    let armed = false;
    node.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-act]');
      if (!b) return;
      const a = b.dataset.act;
      if (a === 'resume') g.resume();
      else if (a === 'settings') this.show('settings');
      else if (a === 'codex') this.show('codex');
      else if (a === 'quit') g.quitToTitle();
      else if (a === 'restart') {
        if (!armed) {
          armed = true;
          b.classList.add('is-armed');
          b.querySelector('span').textContent = 'Confirm restart';
          setTimeout(() => { if (b.isConnected) { armed = false; b.classList.remove('is-armed'); b.querySelector('span').textContent = 'Restart'; } }, 3000);
        } else g.restart();
      }
    });
  }

  // ------------------------------------------------------------------------- settings

  _settings(node) {
    const g = this.game;
    const s = g.settings;
    this._header(node, 'Settings', '');
    const pctText = (v) => `${Math.round(v * 100)}%`;
    const toggle = (key, label, sub = '') => `
      <div class="set-row">
        <div class="set-row__text"><span class="set-row__label" id="lbl-${key}">${esc(label)}</span>${sub ? `<span class="set-row__sub">${esc(sub)}</span>` : ''}</div>
        <button type="button" class="switch" role="switch" data-key="${key}" aria-checked="${s[key] ? 'true' : 'false'}" aria-labelledby="lbl-${key}"><span class="switch__knob"></span></button>
      </div>`;
    const slider = (key, label) => `
      <div class="set-row">
        <div class="set-row__text"><label class="set-row__label" for="rng-${key}">${esc(label)}</label></div>
        <div class="range"><input type="range" id="rng-${key}" min="0" max="100" step="1" value="${Math.round(s[key] * 100)}" data-key="${key}" style="--v:${Math.round(s[key] * 100)}%"><output class="range__out" for="rng-${key}">${pctText(s[key])}</output></div>
      </div>`;
    const keys = g.controls();
    const body = el('div', 'settings');
    body.innerHTML = `
      <section class="set-group">
        <h2 class="section-title">${icon('sound')} Audio</h2>
        ${slider('sfx', 'Sound effects')}
        ${slider('music', 'Music')}
      </section>
      <section class="set-group">
        <h2 class="section-title">${icon('wave')} Gameplay</h2>
        ${toggle('autoStart', 'Auto-start waves', 'Launch the next wave as soon as one is cleared.')}
      </section>
      <section class="set-group">
        <h2 class="section-title">${icon('eye')} Visuals</h2>
        <div class="set-row">
          <div class="set-row__text"><span class="set-row__label" id="lbl-particles">Particle quality</span><span class="set-row__sub">Lower it if late waves stutter.</span></div>
          <div class="seg seg--set" role="radiogroup" aria-labelledby="lbl-particles">
            ${['low', 'medium', 'high'].map((q) => `<button type="button" class="seg__btn ${s.particles === q ? 'is-on' : ''}" role="radio" aria-checked="${s.particles === q}" data-particles="${q}">${q.charAt(0).toUpperCase() + q.slice(1)}</button>`).join('')}
          </div>
        </div>
        ${toggle('shake', 'Screen shake', 'Explosions and Titans rattle the camera.')}
        ${toggle('floatText', 'Floating credit text', 'Show +credits where income appears.')}
        ${toggle('showFps', 'Show FPS', '')}
      </section>
      <section class="set-group set-group--keys">
        <h2 class="section-title">${icon('grid')} Controls</h2>
        <dl class="keys">${keys.map(([k, v]) => `<div class="keys__row"><dt>${k.map((x) => `<kbd>${esc(x)}</kbd>`).join(' ')}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>
      </section>
      <div class="settings__foot"><button type="button" class="btn btn--primary btn--lg" data-act="done" data-autofocus>${icon('check')}<span>Done</span></button></div>`;
    node.appendChild(body);
    body.addEventListener('input', (e) => {
      const r = e.target.closest('input[type="range"]');
      if (!r) return;
      const v = Number(r.value) / 100;
      r.style.setProperty('--v', r.value + '%');
      r.parentElement.querySelector('output').textContent = pctText(v);
      g.updateSettings({ [r.dataset.key]: v });
    });
    body.addEventListener('change', (e) => {
      const r = e.target.closest('input[type="range"]');
      if (r && r.dataset.key === 'sfx') g.uiClick();
    });
    body.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.classList.contains('switch')) {
        const key = b.dataset.key;
        const v = !(b.getAttribute('aria-checked') === 'true');
        b.setAttribute('aria-checked', String(v));
        g.updateSettings({ [key]: v });
      } else if (b.dataset.particles) {
        for (const x of body.querySelectorAll('[data-particles]')) {
          const on = x === b;
          x.classList.toggle('is-on', on);
          x.setAttribute('aria-checked', String(on));
        }
        g.updateSettings({ particles: b.dataset.particles });
      } else if (b.dataset.act === 'done') this.back();
    });
  }

  // ------------------------------------------------------------------------- game over

  _gameover(node, p) {
    const g = this.game;
    const map = g.data.MAPS[p.mapId];
    const diff = g.data.DIFFICULTIES[p.difficulty];
    const st = p.stats || {};
    const rows = [
      ['Waves cleared', int(p.cleared || 0)],
      ['Shells shattered', short(st.pops || 0)],
      ['Damage dealt', short(st.damage || 0)],
      ['Credits earned', short(st.cashEarned || 0)],
      ['Mass leaked', short(st.massLeaked || 0)],
      ['Time', clock(p.time || 0)],
    ];
    node.innerHTML = `
      <div class="modal modal--over ${p.newBest ? 'is-record' : ''}">
        <p class="over__kicker">Core lost</p>
        <h1 class="over__wave"><span class="over__wave-l">Wave</span><span class="over__wave-n">${int(p.wave || 0)}</span></h1>
        ${p.newBest ? `<div class="record-banner">${icon('star')}<span>New record</span>${icon('star')}</div>` : ''}
        <p class="over__best">${esc([map?.name, diff?.name].filter(Boolean).join(' · '))} <span class="dot"></span> Best ${int(p.best || 0)}</p>
        <dl class="over__stats">${rows.map(([k, v]) => `<div class="over__stat"><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>
        <nav class="menu over__menu" aria-label="Game over">
          <button type="button" class="btn btn--primary btn--lg" data-act="retry" data-autofocus>${icon('restart')}<span>Retry</span></button>
          <button type="button" class="btn btn--glass btn--lg" data-act="maps">${icon('map')}<span>Maps</span></button>
          <button type="button" class="btn btn--glass btn--lg" data-act="title">${icon('home')}<span>Title</span></button>
        </nav>
      </div>`;
    node.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-act]');
      if (!b) return;
      const a = b.dataset.act;
      if (a === 'retry') g.restart();
      else if (a === 'maps') g.quitToTitle('maps');
      else if (a === 'title') g.quitToTitle();
    });
  }

  // ------------------------------------------------------------------------- records

  _records(node) {
    const g = this.game;
    const { MAPS, MAP_ORDER, DIFFICULTIES } = g.data;
    const rec = storage.loadRecords();
    const t = rec.totals;
    this._header(node, 'Records', 'Best wave cleared on each map and difficulty.');
    const diffs = DIFF_ORDER.filter((d) => DIFFICULTIES[d]);
    const body = el('div', 'records');
    body.innerHTML = `
      <div class="records__table-wrap">
        <table class="records__table">
          <thead><tr><th scope="col">Map</th>${diffs.map((d) => `<th scope="col">${esc(DIFFICULTIES[d].name)}</th>`).join('')}</tr></thead>
          <tbody>${MAP_ORDER.filter((id) => MAPS[id]).map((id) => `
            <tr><th scope="row"><span class="records__map">${esc(MAPS[id].name)}</span><span class="records__mapd">${esc(MAPS[id].difficulty || '')}</span></th>
            ${diffs.map((d) => { const v = rec.best?.[id]?.[d] || 0; return `<td class="${v ? 'has' : ''}">${v ? int(v) : '·'}</td>`; }).join('')}</tr>`).join('')}
          </tbody>
        </table>
      </div>
      <h2 class="section-title">Lifetime</h2>
      <div class="totals">
        ${[
          ['Runs', int(t.runs)], ['Waves cleared', int(t.waves)], ['Shells shattered', short(t.pops)],
          ['Titans destroyed', int(t.titans)], ['Highest wave', int(rec.highest || 0)], ['Time played', duration(t.time)],
        ].map(([k, v]) => `<div class="total"><span class="total__v">${esc(v)}</span><span class="total__k">${esc(k)}</span></div>`).join('')}
      </div>
      ${storage.persistent() ? '' : '<p class="records__note">Saving is unavailable in this browser, so records last for this session only.</p>'}`;
    node.appendChild(body);
  }

  // ------------------------------------------------------------------------- codex

  _codex(node) {
    const g = this.game;
    const heroes = (g.data.HERO_ORDER || []).filter((id) => g.data.HEROES[id]);
    this._header(node, 'Codex', 'Know the storm. Know your arsenal.');
    const tabs = [['enemies', 'Meteors and ships'], ['towers', 'Towers'], ['types', 'Damage types']];
    if (heroes.length) tabs.push(['heroes', 'Commanders']);
    if (!tabs.some(([k]) => k === this.codexTab)) this.codexTab = 'enemies';
    const bar = el('div', 'tabs');
    bar.setAttribute('role', 'tablist');
    bar.innerHTML = tabs.map(([k, v]) => `<button type="button" class="tab" role="tab" data-tab="${k}" aria-selected="${k === this.codexTab}">${esc(v)}</button>`).join('');
    node.appendChild(bar);
    const panel = el('div', 'codex');
    panel.setAttribute('role', 'tabpanel');
    node.appendChild(panel);
    const render = () => {
      for (const b of bar.querySelectorAll('.tab')) b.setAttribute('aria-selected', String(b.dataset.tab === this.codexTab));
      panel.innerHTML = '';
      panel.scrollTop = 0;
      if (this.codexTab === 'enemies') this._codexEnemies(panel);
      else if (this.codexTab === 'towers') this._codexTowers(panel);
      else if (this.codexTab === 'types') this._codexTypes(panel);
      else if (this.codexTab === 'heroes') this._codexHeroes(panel);
    };
    bar.addEventListener('click', (e) => {
      const b = e.target.closest('.tab');
      if (!b) return;
      this.codexTab = b.dataset.tab;
      render();
    });
    bar.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const items = [...bar.querySelectorAll('.tab')];
      const i = items.findIndex((x) => x.dataset.tab === this.codexTab);
      const n = items[(i + (e.key === 'ArrowRight' ? 1 : -1) + items.length) % items.length];
      this.codexTab = n.dataset.tab;
      render();
      n.focus();
    });
    render();
  }

  _enemyCard(id, def) {
    const g = this.game;
    const ship = def.kind === 'ship';
    const kids = (def.children || []).map(([c, n]) => `${n} ${g.data.ENEMIES[c]?.name || c}`).join(', ');
    const imm = def.immune || [];
    const card = el('article', `ecard ${ship ? 'ecard--ship' : ''}`);
    const notes = [];
    if (def.phantom) notes.push('Phantom: needs detection.');
    if (def.childMods?.phantom || def.childMods?.nanite) notes.push(`Releases ${[def.childMods.phantom ? 'Phantom' : '', def.childMods.nanite ? 'Nanite' : ''].filter(Boolean).join(' ')} meteors.`);
    if (ship) notes.push('Cannot be frozen. Overflow damage stops at the hull.');
    if (id === 'comet') notes.push('Ignores Cryo slows.');
    card.innerHTML = `
      <div class="ecard__art"><canvas></canvas></div>
      <div class="ecard__body">
        <h3 class="ecard__name">${esc(def.name)}</h3>
        <div class="ecard__kind">${ship ? 'Ship' : 'Meteor'}${FIRST_SEEN[id] ? `<span class="dot"></span>From wave ${FIRST_SEEN[id]}` : ''}</div>
        <dl class="ecard__stats">
          <div><dt>Speed</dt><dd>${dec(def.speed, 2)}x</dd></div>
          <div><dt>${ship ? 'Hull' : 'Shell'} HP</dt><dd>${int(def.hp)}</dd></div>
          <div><dt>Mass</dt><dd>${short(def.mass || def.hp)}</dd></div>
        </dl>
        <div class="ecard__imm">${imm.length ? `<span class="ecard__imm-l">Immune</span>${imm.map((t) => dtypeChip(t)).join('')}` : '<span class="ecard__imm-l ecard__imm-l--none">No immunities</span>'}</div>
        ${kids ? `<p class="ecard__kids">${icon('right')}<span>Splits into ${esc(kids)}</span></p>` : '<p class="ecard__kids ecard__kids--none">Final shell</p>'}
        ${notes.length ? `<p class="ecard__note">${esc(notes.join(' '))}</p>` : ''}
      </div>`;
    g.icons.enemy(card.querySelector('canvas'), id, ship ? 64 : 52, def.phantom ? { phantom: true } : {});
    return card;
  }

  _codexEnemies(panel) {
    const { ENEMIES } = this.game.data;
    const ids = Object.keys(ENEMIES);
    const meteors = ids.filter((id) => ENEMIES[id].kind !== 'ship');
    const ships = ids.filter((id) => ENEMIES[id].kind === 'ship');
    const sec = (title, sub) => { const h = el('div', 'codex__sec'); h.innerHTML = `<h2 class="section-title">${esc(title)}</h2>${sub ? `<p class="section-sub">${esc(sub)}</p>` : ''}`; panel.appendChild(h); };
    sec('Meteors', 'Crack a shell and the meteor shatters into the next grade. Every shell pays 1 credit (less after wave 50).');
    const g1 = el('div', 'ecards');
    for (const id of meteors) g1.appendChild(this._enemyCard(id, ENEMIES[id]));
    panel.appendChild(g1);
    sec('Modifiers', 'Any meteor can carry these. Look for the badges in the next wave preview.');
    const gm = el('div', 'mods');
    for (const m of MODIFIERS) {
      const c = el('article', 'mcard');
      c.innerHTML = `<div class="mcard__art"><canvas></canvas><i class="mod mod--${m.key}">${m.key === 'phantom' ? 'P' : m.key === 'nanite' ? 'N' : '+'}</i></div><div><h3 class="mcard__name">${esc(m.name)}</h3>${MOD_UNLOCK[m.key] ? `<div class="mcard__first">From wave ${MOD_UNLOCK[m.key]}</div>` : ''}<p class="mcard__desc">${esc(m.desc)}</p></div>`;
      this.game.icons.enemy(c.querySelector('canvas'), 'jade', 44, { [m.key]: true });
      gm.appendChild(c);
    }
    panel.appendChild(gm);
    sec('Ships', 'Armored carriers with a health bar. They crack open and spill their cargo.');
    const g2 = el('div', 'ecards');
    for (const id of ships) g2.appendChild(this._enemyCard(id, ENEMIES[id]));
    panel.appendChild(g2);
    sec('Storm Titans', `Every ${TITAN_EVERY}th wave brings a Titan. Leaking one ends the run.`);
    const g3 = el('div', 'tcards');
    for (const t of TITANS) {
      const c = el('article', `tcard tcard--${t.kind}`);
      c.innerHTML = `<div class="tcard__art"><canvas></canvas></div><div><h3 class="tcard__name">${esc(t.name)}</h3><div class="tcard__waves">${esc(t.waves)}</div><p class="tcard__desc">${esc(t.desc)}</p></div>`;
      this.game.icons.titan(c.querySelector('canvas'), t.kind, 64);
      g3.appendChild(c);
    }
    panel.appendChild(g3);
  }

  _codexTowers(panel) {
    const g = this.game;
    const { TOWERS, TOWER_ORDER, DIFFICULTIES } = g.data;
    const ids = TOWER_ORDER.filter((id) => TOWERS[id]);
    if (!ids.length) { panel.appendChild(el('p', 'empty', 'The arsenal is still being assembled.')); return; }
    if (!ids.includes(this.codexTower)) this.codexTower = ids[0];
    let diff = DIFFICULTIES[g.settings.codexDifficulty] ? g.settings.codexDifficulty : (g.sim?.state?.difficulty || 'pilot');
    const wrap = el('div', 'ctow');
    const list = el('div', 'ctow__list');
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', 'Towers');
    for (const id of ids) {
      const b = el('button', 'ctow__item');
      b.type = 'button';
      b.dataset.tower = id;
      b.setAttribute('role', 'option');
      b.innerHTML = `<canvas></canvas><span>${esc(TOWERS[id].name)}</span>`;
      g.icons.tower(b.querySelector('canvas'), TOWERS[id], 30, 0);
      list.appendChild(b);
    }
    const detail = el('div', 'ctow__detail');
    wrap.append(list, detail);
    panel.appendChild(wrap);
    const draw = () => {
      for (const b of list.querySelectorAll('.ctow__item')) b.setAttribute('aria-selected', String(b.dataset.tower === this.codexTower));
      const def = TOWERS[this.codexTower];
      const atks = Object.values(def.base?.attacks || {}).filter((a) => a && a.needsTarget !== false && !(a.kind === 'field' && !(a.dps > 0)));
      const dts = [...new Set(atks.map((a) => a.dtype).filter(Boolean))];
      const range = def.base?.range;
      const aura = def.base?.aura?.radius;
      const isRig = /rig/i.test(def.id || this.codexTower);
      const facts = [
        `<span class="fact"><span class="fact__k">Cost</span><span class="fact__v">${credits(priceFor(def.cost || 0, diff))}</span></span>`,
        def.hotkey ? `<span class="fact"><span class="fact__k">Hotkey</span><span class="fact__v"><kbd>${esc(def.hotkey.toUpperCase())}</kbd></span></span>` : '',
        range === Infinity || Number.isFinite(range) ? `<span class="fact"><span class="fact__k">Range</span><span class="fact__v">${range >= 5000 ? 'Global' : int(range)}</span></span>` : '',
        Number.isFinite(aura) && aura > 0 ? `<span class="fact"><span class="fact__k">Aura</span><span class="fact__v">${int(aura)}</span></span>` : '',
        `<span class="fact"><span class="fact__k">Damage</span><span class="fact__v">${dts.length ? dts.map((t) => dtypeChip(t)).join('') : '<span class="muted">None</span>'}</span></span>`,
        `<span class="fact"><span class="fact__k">Detection</span><span class="fact__v">${def.base?.detection ? 'Yes' : 'No'}</span></span>`,
        isRig ? `<span class="fact"><span class="fact__k">Limit</span><span class="fact__v">${RIG_CAP} per run</span></span>` : '',
      ].join('');
      const paths = (def.paths || []).slice(0, 3);
      detail.innerHTML = `
        <header class="ctow__head">
          <span class="ctow__art"><canvas></canvas></span>
          <div class="ctow__id"><h2 class="ctow__name">${esc(def.name)}</h2><p class="ctow__blurb">${esc(clean(def.blurb || ''))}</p></div>
        </header>
        <div class="facts">${facts}</div>
        <div class="ctow__diff"><span class="ctow__diff-l">Prices at</span>
          <div class="seg seg--sm" role="radiogroup" aria-label="Difficulty for prices">
            ${DIFF_ORDER.filter((d) => DIFFICULTIES[d]).map((d) => `<button type="button" class="seg__btn ${d === diff ? 'is-on' : ''}" role="radio" aria-checked="${d === diff}" data-cdiff="${d}">${esc(DIFFICULTIES[d].name)}</button>`).join('')}
          </div>
        </div>
        <div class="cpaths">
          ${paths.map((p, i) => {
            let total = 0;
            return `<section class="cpath" style="--path:${PATH_COLORS[i]}">
              <h3 class="cpath__name"><span class="cpath__n">${['A', 'B', 'C'][i]}</span>${esc(p.name || '')}</h3>
              <ol class="cpath__list">${(p.upgrades || []).map((u, k) => {
                const price = priceFor(u.cost || 0, diff);
                total += price;
                return `<li class="cup"><span class="cup__tier">${k + 1}</span><span class="cup__body"><span class="cup__name">${esc(clean(u.name))}</span><span class="cup__desc">${esc(clean(u.desc || ''))}</span></span><span class="cup__price">${credits(price)}</span></li>`;
              }).join('')}</ol>
              <div class="cpath__total"><span>Full path</span>${credits(total)}</div>
            </section>`;
          }).join('')}
        </div>
        <p class="ctow__rule">${icon('info')} Only one path can go past tier 2, and at most two paths can be upgraded. Each tier 5 can be owned by one tower at a time.</p>`;
      g.icons.tower(detail.querySelector('.ctow__art canvas'), def, 72, 0);
    };
    list.addEventListener('click', (e) => {
      const b = e.target.closest('.ctow__item');
      if (!b) return;
      this.codexTower = b.dataset.tower;
      draw();
      if (window.matchMedia('(max-width: 899px)').matches) detail.scrollIntoView({ block: 'nearest' });
    });
    detail.addEventListener('click', (e) => {
      const b = e.target.closest('[data-cdiff]');
      if (!b) return;
      diff = b.dataset.cdiff;
      g.updateSettings({ codexDifficulty: diff });
      draw();
    });
    draw();
  }

  _codexTypes(panel) {
    const { ENEMIES } = this.game.data;
    const wrap = el('div', 'dtypes');
    for (const [k, info] of Object.entries(DTYPE_INFO)) {
      const immune = Object.values(ENEMIES).filter((e) => (e.immune || []).includes(k)).map((e) => e.name);
      const c = el('article', 'dcard');
      c.style.setProperty('--chip', info.color);
      c.innerHTML = `<h3 class="dcard__name">${esc(dtypeLabel(k))}</h3><p class="dcard__blurb">${esc(info.blurb)}</p>
        <p class="dcard__imm">${immune.length ? `<span class="dcard__imm-l">Blocked by</span> ${esc(immune.join(', '))}` : '<span class="dcard__imm-l">Blocked by</span> nothing'}</p>`;
      wrap.appendChild(c);
    }
    panel.appendChild(wrap);
    const n = el('p', 'codex__foot', `${icon('info')} Blocked hits still use up pierce, so a Kinetic volley into Iron wastes shots. Phantoms can only be targeted by towers with detection, but explosions and fields still hit them.`);
    panel.appendChild(n);
  }

  _codexHeroes(panel) {
    const g = this.game;
    const { HEROES, HERO_ORDER } = g.data;
    const diff = g.sim?.state?.difficulty || g.settings.lastDifficulty || 'pilot';
    const wrap = el('div', 'hcards');
    for (const id of HERO_ORDER.filter((x) => HEROES[x])) {
      const H = HEROES[id];
      const abil = H.abilities || H.skills || [];
      const c = el('article', 'hcard');
      c.innerHTML = `
        <div class="hcard__art"><canvas></canvas></div>
        <div class="hcard__body">
          <h3 class="hcard__name">${esc(H.name)}</h3>
          <div class="hcard__price">${credits(priceFor(H.cost || 0, diff))}</div>
          <p class="hcard__blurb">${esc(clean(H.blurb || H.role || H.desc || ''))}</p>
          ${abil.length ? `<ul class="hcard__abil">${abil.map((a) => `<li><span class="hero-abil__lvl">L${esc(a.level ?? a.unlock ?? '')}</span><span><b>${esc(clean(a.name || ''))}</b>${a.desc ? ` ${esc(clean(a.desc))}` : ''}</span></li>`).join('')}</ul>` : ''}
        </div>`;
      g.icons.hero(c.querySelector('canvas'), H, 72);
      wrap.appendChild(c);
    }
    panel.appendChild(wrap);
  }
}
