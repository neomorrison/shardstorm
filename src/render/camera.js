// Camera: fits the 1500 x 1000 world into the canvas with `contain` scaling, centered.
// Handles devicePixelRatio (capped at 2), canvas backing-store sizing and screen shake.
//
// Coordinate spaces:
//   world   : 0..1500 x 0..1000 world units (the sim)
//   css     : CSS pixels relative to the canvas top-left (what mouse offsetX/offsetY give)
//   device  : backing-store pixels (css * dpr)
//
// The renderer draws in world space by calling camera.apply(ctx), which sets
// ctx.setTransform(k, 0, 0, k, ox, oy) with k = device pixels per world unit.

export const WORLD_W = 1500;
export const WORLD_H = 1000;
const MAX_DPR = 2;

export class Camera {
  constructor(canvas) {
    this.canvas = canvas;
    this.cssW = 0; this.cssH = 0;       // canvas size in CSS px
    this.dpr = 1;
    this.w = 0; this.h = 0;             // backing store size (device px)
    this.scale = 1;                     // CSS px per world unit
    this.k = 1;                         // device px per world unit (scale * dpr)
    this.offX = 0; this.offY = 0;       // CSS px offset of world origin
    this.ox = 0; this.oy = 0;           // device px offset of world origin (without shake)
    this.shakeX = 0; this.shakeY = 0;   // device px
    this.trauma = 0;
    this.version = 0;                   // bumps whenever the transform changes (cache key)
    // CSS px kept clear of world content (HUD bars, drawers); terrain still fills them.
    this.insets = { top: 0, right: 0, bottom: 0, left: 0 };
    this._insetsDirty = false;
    this._rectCache = null;
    this._rectT = 0;
    // Visible world rectangle (may extend beyond the world on non 3:2 screens).
    this.view = { x0: 0, y0: 0, x1: WORLD_W, y1: WORLD_H };
  }

  // Measure the canvas and resize the backing store if needed. Returns true if changed.
  sync() {
    const c = this.canvas;
    let cssW = c.clientWidth, cssH = c.clientHeight;
    if (!cssW || !cssH) {
      // Not laid out yet (or detached): fall back to the attribute size.
      cssW = c.width / (this.dpr || 1) || 300;
      cssH = c.height / (this.dpr || 1) || 200;
    }
    const dpr = Math.min(MAX_DPR, Math.max(1, (typeof window !== 'undefined' && window.devicePixelRatio) || 1));
    const w = Math.max(1, Math.round(cssW * dpr));
    const h = Math.max(1, Math.round(cssH * dpr));
    if (!this._insetsDirty && w === this.w && h === this.h && dpr === this.dpr && cssW === this.cssW && cssH === this.cssH) return false;
    this._insetsDirty = false;
    this.cssW = cssW; this.cssH = cssH; this.dpr = dpr; this.w = w; this.h = h;
    if (c.width !== w) c.width = w;
    if (c.height !== h) c.height = h;
    // Fit the world into the area left after insets (never less than half the canvas).
    const I = this.insets;
    const availW = Math.max(cssW * 0.5, cssW - I.left - I.right);
    const availH = Math.max(cssH * 0.5, cssH - I.top - I.bottom);
    const padL = Math.min(I.left, cssW - availW), padT = Math.min(I.top, cssH - availH);
    this.scale = Math.min(availW / WORLD_W, availH / WORLD_H);
    this.k = this.scale * dpr;
    this.offX = padL + (availW - WORLD_W * this.scale) / 2;
    this.offY = padT + (availH - WORLD_H * this.scale) / 2;
    this.ox = this.offX * dpr;
    this.oy = this.offY * dpr;
    this.view = {
      x0: -this.offX / this.scale,
      y0: -this.offY / this.scale,
      x1: (cssW - this.offX) / this.scale,
      y1: (cssH - this.offY) / this.scale,
    };
    this.version++;
    this._rectCache = null;
    return true;
  }

  // Reserve CSS px on each side for overlaid UI. Returns true if anything changed.
  setInsets({ top = 0, right = 0, bottom = 0, left = 0 } = {}) {
    const I = this.insets;
    const n = { top: Math.max(0, +top || 0), right: Math.max(0, +right || 0), bottom: Math.max(0, +bottom || 0), left: Math.max(0, +left || 0) };
    if (n.top === I.top && n.right === I.right && n.bottom === I.bottom && n.left === I.left) return false;
    this.insets = n;
    this._insetsDirty = true;
    return true;
  }

  // Add screen shake trauma (0..1). Shake offset = trauma^2 * max.
  addTrauma(a) { this.trauma = Math.min(1, this.trauma + a); }

  updateShake(dt, enabled, time) {
    if (!enabled) { this.trauma = 0; this.shakeX = 0; this.shakeY = 0; return; }
    this.trauma = Math.max(0, this.trauma - dt * 1.6);
    const s = this.trauma * this.trauma;
    if (s <= 0.0001) { this.shakeX = 0; this.shakeY = 0; return; }
    const max = 14 * this.dpr;
    // Smooth pseudo-noise so the shake reads as a rumble, not jitter.
    this.shakeX = max * s * (Math.sin(time * 71.3) * 0.6 + Math.sin(time * 37.1 + 1.3) * 0.4);
    this.shakeY = max * s * (Math.sin(time * 63.7 + 2.1) * 0.6 + Math.sin(time * 29.3 + 0.4) * 0.4);
  }

  // World transform (device px), including shake.
  apply(ctx) {
    ctx.setTransform(this.k, 0, 0, this.k, this.ox + this.shakeX, this.oy + this.shakeY);
  }

  // Identity transform in device px (for screen-space overlays).
  applyScreen(ctx) { ctx.setTransform(1, 0, 0, 1, 0, 0); }

  // CSS px relative to canvas -> world.
  screenToWorld(px, py) {
    return { x: (px - this.offX) / this.scale, y: (py - this.offY) / this.scale };
  }

  // World -> CSS px relative to canvas.
  worldToScreen(x, y) {
    return { x: this.offX + x * this.scale, y: this.offY + y * this.scale };
  }

  // Client (viewport) coordinates, e.g. MouseEvent.clientX/Y -> world.
  clientToWorld(cx, cy) {
    const now = (typeof performance !== 'undefined') ? performance.now() : 0;
    if (!this._rectCache || now - this._rectT > 250) {
      this._rectCache = this.canvas.getBoundingClientRect();
      this._rectT = now;
    }
    const r = this._rectCache;
    // Account for CSS scaling of the canvas element itself (rect vs client size).
    const sx = r.width ? this.cssW / r.width : 1;
    const sy = r.height ? this.cssH / r.height : 1;
    return this.screenToWorld((cx - r.left) * sx, (cy - r.top) * sy);
  }

  // Is a world-space circle inside the visible area (with margin)?
  visible(x, y, r) {
    const v = this.view;
    return x + r >= v.x0 && x - r <= v.x1 && y + r >= v.y0 && y - r <= v.y1;
  }
}
