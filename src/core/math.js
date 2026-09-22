// Small vector and geometry helpers. Pure.

export const TAU = Math.PI * 2;

export function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
export function lerp(a, b, t) { return a + (b - a) * t; }
export function dist2(ax, ay, bx, by) { const dx = bx - ax, dy = by - ay; return dx * dx + dy * dy; }
export function dist(ax, ay, bx, by) { return Math.sqrt(dist2(ax, ay, bx, by)); }
export function angleTo(ax, ay, bx, by) { return Math.atan2(by - ay, bx - ax); }

// Wrap an angle into (-PI, PI].
export function wrapAngle(a) {
  a = a % TAU;
  if (a > Math.PI) a -= TAU;
  else if (a <= -Math.PI) a += TAU;
  return a;
}
export function angleDiff(from, to) { return wrapAngle(to - from); }
// Rotate `a` toward `target` by at most `maxStep` radians.
export function turnToward(a, target, maxStep) {
  const d = wrapAngle(target - a);
  if (Math.abs(d) <= maxStep) return target;
  return a + Math.sign(d) * maxStep;
}

// Squared distance from point P to segment AB, plus the parameter t along AB (0..1).
export function segPointDist2(ax, ay, bx, by, px, py) {
  const vx = bx - ax, vy = by - ay;
  const len2 = vx * vx + vy * vy;
  let t = len2 > 0 ? ((px - ax) * vx + (py - ay) * vy) / len2 : 0;
  if (t < 0) t = 0; else if (t > 1) t = 1;
  const cx = ax + vx * t - px, cy = ay + vy * t - py;
  return cx * cx + cy * cy;
}
export function segParam(ax, ay, bx, by, px, py) {
  const vx = bx - ax, vy = by - ay;
  const len2 = vx * vx + vy * vy;
  let t = len2 > 0 ? ((px - ax) * vx + (py - ay) * vy) / len2 : 0;
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

// FNV-1a style running hash over numbers (exact float bits) and strings.
const f64 = new Float64Array(1);
const u32 = new Uint32Array(f64.buffer);
export class Hasher {
  constructor() { this.h = 0x811c9dc5 >>> 0; }
  _mix(x) { this.h = Math.imul(this.h ^ (x >>> 0), 0x01000193) >>> 0; }
  num(v) { f64[0] = v; this._mix(u32[0]); this._mix(u32[1]); return this; }
  str(s) { s = String(s); for (let i = 0; i < s.length; i++) this._mix(s.charCodeAt(i)); this._mix(0xff); return this; }
  bool(b) { this._mix(b ? 1 : 2); return this; }
  hex() { return (this.h >>> 0).toString(16).padStart(8, '0'); }
}
