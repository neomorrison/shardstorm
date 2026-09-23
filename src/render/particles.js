// Visual particle system (render-only, may use Math.random).
// Struct-of-arrays storage, no per-particle allocation, sprites pre-rendered per type.
// Two draw passes: normal blend, then additive ('lighter').

import {
  drawShardFragment, drawChunk, drawSmokePuff, drawSparkStreak, drawGlow, drawSparkStar,
  glowColor, mix, shade, hsl,
} from './procedural.js';

// Particle quality tiers: pool cap, emission multiplier and ring cap.
const QUALITY = {
  low: { cap: 700, emit: 0.45, rings: 30 },
  medium: { cap: 1300, emit: 0.7, rings: 55 },
  high: { cap: 2200, emit: 1, rings: 90 },
};
const F_ALIGN = 1;    // rotation follows velocity
const F_LINEAR = 2;   // linear fade (else hold then fade over the last 35%)
const F_FADEIN = 4;   // quick fade in
const F_GROW = 8;     // ease-out size curve

const MAX = 4000;

export class Particles {
  constructor() {
    this.cap = 2500;
    this.n = 0;
    const f = () => new Float32Array(MAX);
    this.x = f(); this.y = f(); this.vx = f(); this.vy = f();
    this.life = f(); this.max = f(); this.s0 = f(); this.s1 = f();
    this.rot = f(); this.vrot = f(); this.drag = f(); this.grav = f(); this.a0 = f();
    this.kind = new Uint16Array(MAX);
    this.flags = new Uint8Array(MAX);
    this.types = [];
    this.typeIndex = new Map();
    this.rings = [];
    this.texts = [];
    this.quality = 'high';
  }

  // q: 'low' | 'medium' | 'high'; scale (0..1) lets the renderer's load governor shrink the pool.
  setQuality(q, scale = 1) {
    this.quality = QUALITY[q] ? q : 'high';
    this.cap = Math.max(150, Math.round(QUALITY[this.quality].cap * scale));
  }

  // Emission budget multiplier: lower quality and a full pool both thin the effects.
  get budget() {
    const fill = this.n / this.cap;
    let b = QUALITY[this.quality].emit;
    if (fill > 0.55) b *= Math.max(0.1, (1 - fill) / 0.45);
    return b;
  }
  count(n) {
    const v = n * this.budget;
    const i = Math.floor(v);
    return i + (Math.random() < v - i ? 1 : 0);
  }

  // size: nominal world size the sprite is drawn at (scale 1). w, h: sprite box (default square).
  // frames > 1: the sprite is pre-rotated into that many frames (for spinning or aligned kinds).
  type(key, size, add, draw, w = size * 2, h = size * 2, frames = 1) {
    let i = this.typeIndex.get(key);
    if (i === undefined) {
      i = this.types.length;
      this.types.push({ key, size, add, draw, w, h, frames, spr: null });
      this.typeIndex.set(key, i);
    }
    return i;
  }

  spawn(t, x, y, vx, vy, life, s0, s1, rot = 0, vrot = 0, drag = 0, grav = 0, a0 = 1, flags = 0) {
    if (this.n >= this.cap) return -1;
    const i = this.n++;
    this.kind[i] = t; this.x[i] = x; this.y[i] = y; this.vx[i] = vx; this.vy[i] = vy;
    this.life[i] = life; this.max[i] = life; this.s0[i] = s0; this.s1[i] = s1;
    this.rot[i] = rot; this.vrot[i] = vrot; this.drag[i] = drag; this.grav[i] = grav;
    this.a0[i] = a0; this.flags[i] = flags;
    return i;
  }

  clear() { this.n = 0; this.rings.length = 0; this.texts.length = 0; }

  update(dt) {
    if (dt <= 0) return;
    let n = this.n;
    const { x, y, vx, vy, life, drag, grav, rot, vrot } = this;
    for (let i = 0; i < n; i++) {
      life[i] -= dt;
      if (life[i] <= 0) {
        n--;
        if (i !== n) this._move(n, i);
        i--;
        continue;
      }
      const dr = drag[i];
      if (dr > 0) { const f = Math.max(0, 1 - dr * dt); vx[i] *= f; vy[i] *= f; }
      vy[i] += grav[i] * dt;
      x[i] += vx[i] * dt;
      y[i] += vy[i] * dt;
      rot[i] += vrot[i] * dt;
    }
    this.n = n;
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i];
      r.life -= dt;
      if (r.life <= 0) { this.rings[i] = this.rings[this.rings.length - 1]; this.rings.pop(); }
    }
    for (let i = this.texts.length - 1; i >= 0; i--) {
      const t = this.texts[i];
      t.life -= dt;
      t.y -= dt * 34 * (t.life / t.max + 0.2);
      if (t.life <= 0) { this.texts[i] = this.texts[this.texts.length - 1]; this.texts.pop(); }
    }
  }

  _move(from, to) {
    this.x[to] = this.x[from]; this.y[to] = this.y[from]; this.vx[to] = this.vx[from]; this.vy[to] = this.vy[from];
    this.life[to] = this.life[from]; this.max[to] = this.max[from]; this.s0[to] = this.s0[from]; this.s1[to] = this.s1[from];
    this.rot[to] = this.rot[from]; this.vrot[to] = this.vrot[from]; this.drag[to] = this.drag[from]; this.grav[to] = this.grav[from];
    this.a0[to] = this.a0[from]; this.kind[to] = this.kind[from]; this.flags[to] = this.flags[from];
  }

  // Draw all particles. cam: Camera, cache: SpriteCache. Leaves globalAlpha at 1.
  // Rotating particles use pre-rotated frames so every draw is a plain drawImage in the
  // world transform (no per-particle setTransform).
  draw(ctx, cam, cache) {
    const types = this.types;
    const k = cam.k, ox = cam.ox + cam.shakeX, oy = cam.oy + cam.shakeY;
    const v = cam.view;
    const n = this.n;
    const TAU = Math.PI * 2;
    if (this._cacheGen !== cache.gen) { this._cacheGen = cache.gen; for (const T of types) T.spr = null; }
    ctx.setTransform(k, 0, 0, k, ox, oy);
    for (let pass = 0; pass < 2; pass++) {
      ctx.globalCompositeOperation = pass ? 'lighter' : 'source-over';
      for (let i = 0; i < n; i++) {
        const t = this.kind[i];
        const T = types[t];
        if ((T.add ? 1 : 0) !== pass) continue;
        const x = this.x[i], y = this.y[i];
        if (x < v.x0 - 40 || x > v.x1 + 40 || y < v.y0 - 40 || y > v.y1 + 40) continue;
        const fr = this.life[i] / this.max[i];
        const fl = this.flags[i];
        let a;
        if (fl & F_LINEAR) a = fr;
        else a = fr < 0.35 ? fr / 0.35 : 1;
        if ((fl & F_FADEIN) && fr > 0.85) a *= (1 - fr) / 0.15;
        a *= this.a0[i];
        if (a <= 0.01) continue;
        let g = 1 - fr;
        if (fl & F_GROW) g = 1 - (1 - g) * (1 - g);
        const s = this.s0[i] + (this.s1[i] - this.s0[i]) * g;
        const sc = s / T.size;
        let sp;
        if (T.frames > 1) {
          const r = (fl & F_ALIGN) ? Math.atan2(this.vy[i], this.vx[i]) : this.rot[i];
          let f = Math.round((r * T.frames) / TAU) % T.frames;
          if (f < 0) f += T.frames;
          if (!T.spr) T.spr = new Array(T.frames);
          sp = T.spr[f];
          if (!sp) {
            const side = Math.hypot(T.w, T.h);
            const ang = (f * TAU) / T.frames;
            sp = T.spr[f] = cache.get('p|' + T.key + '|' + f, side, side, (c) => { c.rotate(ang); T.draw(c); });
          }
        } else {
          sp = T.spr || (T.spr = cache.get('p|' + T.key, T.w, T.h, T.draw));
        }
        ctx.globalAlpha = a > 1 ? 1 : a;
        ctx.drawImage(sp.c, sp.sx, sp.sy, sp.sw, sp.sh, x - sp.ax * sc, y - sp.ay * sc, sp.w * sc, sp.h * sc);
      }
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    // Rings (stroked arcs)
    if (this.rings.length) {
      cam.apply(ctx);
      for (const r of this.rings) {
        const fr = r.life / r.max;
        const g = 1 - fr;
        const e = 1 - (1 - g) * (1 - g) * (1 - g);
        const rad = r.r0 + (r.r1 - r.r0) * e;
        ctx.globalAlpha = Math.max(0, Math.min(1, fr * r.a));
        if (r.add) ctx.globalCompositeOperation = 'lighter';
        ctx.beginPath();
        ctx.arc(r.x, r.y, Math.max(0.1, rad), 0, Math.PI * 2);
        ctx.lineWidth = r.w * (0.4 + fr * 0.6);
        ctx.strokeStyle = r.color;
        ctx.stroke();
        ctx.globalCompositeOperation = 'source-over';
      }
      ctx.globalAlpha = 1;
    }
  }

  drawTexts(ctx, cam) {
    if (!this.texts.length) return;
    cam.apply(ctx);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    for (const t of this.texts) {
      const fr = t.life / t.max;
      const a = fr < 0.3 ? fr / 0.3 : 1;
      const pop = fr > 0.85 ? 1 + (fr - 0.85) * 2.5 : 1;
      ctx.globalAlpha = a;
      ctx.font = `800 ${(t.size * pop).toFixed(1)}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
      ctx.lineWidth = 3.2;
      ctx.strokeStyle = 'rgba(10,8,20,0.9)';
      ctx.strokeText(t.text, t.x, t.y);
      ctx.fillStyle = t.color;
      ctx.fillText(t.text, t.x, t.y);
    }
    ctx.globalAlpha = 1;
  }

  // ------------------------------------------------------------------------
  // Emitters
  // ------------------------------------------------------------------------

  ring(x, y, r0, r1, life, color, w = 3, a = 1, add = false) {
    if (this.rings.length > QUALITY[this.quality].rings) return;
    this.rings.push({ x, y, r0, r1, life, max: life, color, w, a, add });
  }

  text(x, y, text, color = '#ffe66d', size = 15, life = 1.0) {
    if (this.texts.length >= 40) this.texts.shift();
    this.texts.push({ x, y, text, color, size, life, max: life });
  }

  glow(x, y, size, color, life = 0.2, a = 1, grow = 1.4) {
    const c = glowColor(color);
    const t = this.type('glow|' + c, 16, true, (ctx) => drawGlow(ctx, 16, c, 0, 1));
    this.spawn(t, x, y, 0, 0, life, size, size * grow, 0, 0, 0, 0, a, F_LINEAR | F_GROW);
  }

  // Crystal shatter burst in an enemy's colors.
  shatter(x, y, colors, n = 6, speed = 150, size = 4.5) {
    const m = this.count(n);
    for (let i = 0; i < m; i++) {
      const c = colors[i % colors.length];
      const v = (Math.random() * 3) | 0;
      const t = this.type('shard|' + c + '|' + v, 6, false, (ctx) => drawShardFragment(ctx, c, v, 6), 13, 13, 8);
      const a = Math.random() * Math.PI * 2;
      const sp = speed * (0.35 + Math.random() * 0.8);
      const s = size * (0.6 + Math.random() * 0.7);
      this.spawn(t, x, y, Math.cos(a) * sp, Math.sin(a) * sp, 0.35 + Math.random() * 0.35, s, s * 0.5,
        Math.random() * 6.28, (Math.random() - 0.5) * 18, 3.2, 0, 1, 0);
    }
  }

  sparks(x, y, color, n = 4, speed = 220, len = 7, life = 0.22) {
    const c = glowColor(color);
    const t = this.type('spark|' + c, 8, true, (ctx) => drawSparkStreak(ctx, 8, c), 16.5, 3.4, 16);
    const m = this.count(n);
    for (let i = 0; i < m; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = speed * (0.4 + Math.random() * 0.8);
      this.spawn(t, x, y, Math.cos(a) * sp, Math.sin(a) * sp, life * (0.6 + Math.random() * 0.6), len, len * 0.4, 0, 0, 4, 0, 1, F_ALIGN | F_LINEAR);
    }
  }

  // Directional spark cone (muzzle, impacts).
  sparkCone(x, y, angle, spread, color, n = 3, speed = 260, len = 6) {
    const c = glowColor(color);
    const t = this.type('spark|' + c, 8, true, (ctx) => drawSparkStreak(ctx, 8, c), 16.5, 3.4, 16);
    const m = this.count(n);
    for (let i = 0; i < m; i++) {
      const a = angle + (Math.random() - 0.5) * spread;
      const sp = speed * (0.5 + Math.random() * 0.7);
      this.spawn(t, x, y, Math.cos(a) * sp, Math.sin(a) * sp, 0.12 + Math.random() * 0.1, len, len * 0.3, 0, 0, 5, 0, 1, F_ALIGN | F_LINEAR);
    }
  }

  smoke(x, y, size = 8, life = 0.8, color = '#8a8f9c', vx = 0, vy = -12, a = 0.8) {
    const t = this.type('smoke|' + color, 12, false, (ctx) => drawSmokePuff(ctx, 12, color));
    this.spawn(t, x, y, vx + (Math.random() - 0.5) * 10, vy + (Math.random() - 0.5) * 10, life * (0.8 + Math.random() * 0.4),
      size * 0.6, size * 1.8, Math.random() * 6.28, (Math.random() - 0.5) * 1.5, 1.2, 0, a, F_FADEIN | F_GROW);
  }

  embers(x, y, n = 4, speed = 90, color = '#ffb347') {
    const t = this.type('ember|' + color, 4, true, (ctx) => drawGlow(ctx, 4, color, 0, 1));
    const m = this.count(n);
    for (let i = 0; i < m; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = speed * (0.3 + Math.random() * 0.9);
      this.spawn(t, x, y, Math.cos(a) * sp, Math.sin(a) * sp - 20, 0.4 + Math.random() * 0.6, 3.5, 1.2, 0, 0, 2.2, 40, 1, F_LINEAR);
    }
  }

  chunks(x, y, color, n = 8, speed = 160, size = 7) {
    const m = this.count(n);
    for (let i = 0; i < m; i++) {
      const v = (Math.random() * 4) | 0;
      const t = this.type('chunk|' + color + '|' + v, 8, false, (ctx) => drawChunk(ctx, color, v, 8), 18, 18, 8);
      const a = Math.random() * Math.PI * 2;
      const sp = speed * (0.3 + Math.random() * 0.9);
      const s = size * (0.6 + Math.random() * 0.8);
      this.spawn(t, x, y, Math.cos(a) * sp, Math.sin(a) * sp, 0.6 + Math.random() * 0.6, s, s * 0.7,
        Math.random() * 6.28, (Math.random() - 0.5) * 10, 2.4, 0, 1, 0);
    }
  }

  snow(x, y, r, n = 10) {
    const t = this.type('snow', 4, true, (ctx) => drawSparkStar(ctx, 4, '#dff8ff'));
    const m = this.count(n);
    for (let i = 0; i < m; i++) {
      const a = Math.random() * Math.PI * 2;
      const d = r * Math.sqrt(Math.random());
      this.spawn(t, x + Math.cos(a) * d, y + Math.sin(a) * d, Math.cos(a) * 20, Math.sin(a) * 20 - 10,
        0.5 + Math.random() * 0.5, 3 + Math.random() * 2, 1, Math.random() * 6, (Math.random() - 0.5) * 4, 1, 0, 0.9, F_LINEAR);
    }
  }

  stars(x, y, n, color, speed = 120, size = 5) {
    const c = glowColor(color);
    const t = this.type('star|' + c, 5, true, (ctx) => drawSparkStar(ctx, 5, c));
    const m = this.count(n);
    for (let i = 0; i < m; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = speed * (0.3 + Math.random() * 0.8);
      this.spawn(t, x, y, Math.cos(a) * sp, Math.sin(a) * sp - 30, 0.5 + Math.random() * 0.5, size, size * 0.3,
        Math.random() * 6, (Math.random() - 0.5) * 8, 2, 30, 1, F_LINEAR);
    }
  }

  // Explosion: flash + shock ring + fireballs + sparks + smoke.
  explosion(x, y, r, dtype) {
    const pal = EXPLOSION_COLORS[dtype] || EXPLOSION_COLORS.BLAST;
    this.glow(x, y, r * 1.1, pal.flash, 0.16, 1, 1.3);
    this.glow(x, y, r * 0.7, '#ffffff', 0.08, 0.9, 1.2);
    this.ring(x, y, r * 0.25, r * 1.05, 0.3, pal.ring, Math.max(2, r * 0.08), 0.9, true);
    const fb = this.count(Math.min(8, 3 + r / 18));
    const ft = this.type('glow|' + pal.fire, 16, true, (ctx) => drawGlow(ctx, 16, pal.fire, 0, 1));
    for (let i = 0; i < fb; i++) {
      const a = Math.random() * Math.PI * 2, d = r * 0.45 * Math.random();
      const s = r * (0.35 + Math.random() * 0.3);
      this.spawn(ft, x + Math.cos(a) * d, y + Math.sin(a) * d, Math.cos(a) * r * 0.8, Math.sin(a) * r * 0.8 - 10,
        0.25 + Math.random() * 0.2, s, s * 1.5, 0, 0, 3, 0, 0.8, F_LINEAR | F_GROW);
    }
    this.sparks(x, y, pal.spark, Math.min(10, 4 + r / 12), 180 + r * 3, 8, 0.3);
    if (pal.smoke) {
      const sm = Math.min(5, 1 + r / 30);
      for (let i = 0; i < this.count(sm); i++) {
        const a = Math.random() * Math.PI * 2, d = r * 0.4 * Math.random();
        this.smoke(x + Math.cos(a) * d, y + Math.sin(a) * d, r * 0.45, 0.9, pal.smoke, Math.cos(a) * 15, -18, 0.55);
      }
    }
  }
}

export const EXPLOSION_COLORS = {
  BLAST: { flash: '#ffb347', ring: '#ffe0a0', fire: '#ff7a1a', spark: '#ffd27a', smoke: '#5a5560' },
  THERMAL: { flash: '#ff6a2a', ring: '#ffb08a', fire: '#ff4a1a', spark: '#ffb347', smoke: '#4a4048' },
  ENERGY: { flash: '#7fe9ff', ring: '#c8f6ff', fire: '#3fc8ff', spark: '#e0fbff', smoke: null },
  CRYO: { flash: '#bff4ff', ring: '#e8fcff', fire: '#8fe0ff', spark: '#ffffff', smoke: null },
  VOID: { flash: '#c77dff', ring: '#f0d0ff', fire: '#8a3dff', spark: '#f5c2ff', smoke: null },
  KINETIC: { flash: '#fff2c4', ring: '#ffffff', fire: '#ffd27a', spark: '#ffffff', smoke: '#6a6670' },
};

// Shard colors per enemy type (pop bursts).
const SHARD_COLORS = {
  iron: ['#aeb7c6', '#6b7486', '#e6ecf5'],
  magma: ['#4a2420', '#ff7a1a', '#2b1410'],
  comet: ['#e8f6ff', '#9fd6ff', '#ffffff'],
  prism: ['#b57bff', '#ff8fd8', '#7fd8ff'],
  geode: ['#6a7080', '#7ff8ff', '#3a3f4c'],
  obsidian: ['#2a1c44', '#c77dff', '#120a20'],
};
const AURORA_SHARDS = [0, 50, 110, 180, 230, 290].map((h) => hsl(h, 95, 65));
export function shardColors(type, color) {
  if (type === 'aurora') {
    const i = (Math.random() * 6) | 0;
    return [AURORA_SHARDS[i], AURORA_SHARDS[(i + 2) % 6], AURORA_SHARDS[(i + 4) % 6], '#ffffff'];
  }
  if (SHARD_COLORS[type]) return SHARD_COLORS[type];
  const c = color || '#ff4d4d';
  return [c, shade(c, 0.35), mix(c, '#ffffff', 0.6)];
}
