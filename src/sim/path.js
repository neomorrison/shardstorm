// Path: smooths a control polyline with centripetal Catmull-Rom, samples it by arc length
// every `step` units into typed arrays (x, y, angle), and answers O(1) pointAt(d) plus
// grid-accelerated distance queries (placement checks, coverage for bots).
// Pure: no DOM, no randomness.

const GRID_CELL = 32;

function catmullRomSegment(p0, p1, p2, p3, out, stepsHint) {
  // Centripetal (alpha = 0.5) Catmull-Rom between p1 and p2 (Barry-Goldman pyramid).
  const eps = 1e-4;
  const tj = (a, b) => Math.max(eps, Math.sqrt(Math.hypot(b[0] - a[0], b[1] - a[1])));
  const t0 = 0, t1 = t0 + tj(p0, p1), t2 = t1 + tj(p1, p2), t3 = t2 + tj(p2, p3);
  const n = Math.max(2, stepsHint);
  for (let i = 0; i < n; i++) {
    const t = t1 + (t2 - t1) * (i / n);
    const a1x = ((t1 - t) * p0[0] + (t - t0) * p1[0]) / (t1 - t0);
    const a1y = ((t1 - t) * p0[1] + (t - t0) * p1[1]) / (t1 - t0);
    const a2x = ((t2 - t) * p1[0] + (t - t1) * p2[0]) / (t2 - t1);
    const a2y = ((t2 - t) * p1[1] + (t - t1) * p2[1]) / (t2 - t1);
    const a3x = ((t3 - t) * p2[0] + (t - t2) * p3[0]) / (t3 - t2);
    const a3y = ((t3 - t) * p2[1] + (t - t2) * p3[1]) / (t3 - t2);
    const b1x = ((t2 - t) * a1x + (t - t0) * a2x) / (t2 - t0);
    const b1y = ((t2 - t) * a1y + (t - t0) * a2y) / (t2 - t0);
    const b2x = ((t3 - t) * a2x + (t - t1) * a3x) / (t3 - t1);
    const b2y = ((t3 - t) * a2y + (t - t1) * a3y) / (t3 - t1);
    out.push(((t2 - t) * b1x + (t - t1) * b2x) / (t2 - t1), ((t2 - t) * b1y + (t - t1) * b2y) / (t2 - t1));
  }
}

export function smoothPolyline(points) {
  const pts = [];
  // drop consecutive duplicates
  for (const p of points) {
    const last = pts[pts.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > 1e-6) pts.push([p[0], p[1]]);
  }
  if (pts.length < 2) throw new Error('path needs at least 2 distinct points');
  const n = pts.length;
  const first = [2 * pts[0][0] - pts[1][0], 2 * pts[0][1] - pts[1][1]];
  const last = [2 * pts[n - 1][0] - pts[n - 2][0], 2 * pts[n - 1][1] - pts[n - 2][1]];
  const ext = [first, ...pts, last];
  const dense = [];
  for (let i = 1; i < ext.length - 2; i++) {
    const segLen = Math.hypot(ext[i + 1][0] - ext[i][0], ext[i + 1][1] - ext[i][1]);
    catmullRomSegment(ext[i - 1], ext[i], ext[i + 1], ext[i + 2], dense, Math.ceil(segLen / 3));
  }
  dense.push(pts[n - 1][0], pts[n - 1][1]);
  return dense; // flat [x0, y0, x1, y1, ...]
}

export class Path {
  constructor(points, { step = 2, width = 56 } = {}) {
    this.points = points.map((p) => [p[0], p[1]]);
    this.step = step;
    this.width = width;
    const dense = smoothPolyline(points);

    // arc-length resampling
    const xs = [], ys = [];
    let px = dense[0], py = dense[1];
    xs.push(px); ys.push(py);
    let carry = 0; // distance travelled since the last emitted sample
    for (let i = 2; i < dense.length; i += 2) {
      const nx = dense[i], ny = dense[i + 1];
      let segLen = Math.hypot(nx - px, ny - py);
      let sx = px, sy = py;
      while (carry + segLen >= step) {
        const need = step - carry;
        const f = need / segLen;
        sx = sx + (nx - sx) * f;
        sy = sy + (ny - sy) * f;
        xs.push(sx); ys.push(sy);
        segLen -= need;
        carry = 0;
      }
      carry += segLen;
      px = nx; py = ny;
    }
    // final exact endpoint
    const lx = dense[dense.length - 2], ly = dense[dense.length - 1];
    if (carry > 1e-6) { xs.push(lx); ys.push(ly); }
    const n = xs.length;
    this.n = n;
    this.xs = Float64Array.from(xs);
    this.ys = Float64Array.from(ys);
    this.as = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const j = Math.min(n - 1, i + 1), k = Math.max(0, j - 1);
      this.as[i] = Math.atan2(this.ys[j] - this.ys[k], this.xs[j] - this.xs[k]);
    }
    // total length: (n - 2) full steps + the last partial one
    this.length = (n - 2) * step + (carry > 1e-6 ? carry : step);
    if (n < 2) this.length = 0;
    this._lastPartial = carry > 1e-6 ? carry : step;
    this._buildGrid();
  }

  // Position at arc length d (clamped). Writes into `out` if given.
  pointAt(d, out) {
    const o = out || { x: 0, y: 0, angle: 0 };
    const n = this.n;
    if (d <= 0) { o.x = this.xs[0]; o.y = this.ys[0]; o.angle = this.as[0]; return o; }
    if (d >= this.length) { o.x = this.xs[n - 1]; o.y = this.ys[n - 1]; o.angle = this.as[n - 1]; return o; }
    const f = d / this.step;
    let i = Math.floor(f);
    if (i >= n - 1) i = n - 2;
    let t;
    if (i === n - 2) t = (d - i * this.step) / this._lastPartial; else t = f - i;
    if (t > 1) t = 1;
    o.x = this.xs[i] + (this.xs[i + 1] - this.xs[i]) * t;
    o.y = this.ys[i] + (this.ys[i + 1] - this.ys[i]) * t;
    o.angle = this.as[i];
    return o;
  }

  _buildGrid() {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < this.n; i++) {
      const x = this.xs[i], y = this.ys[i];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    this.gx0 = Math.floor(minX) - GRID_CELL;
    this.gy0 = Math.floor(minY) - GRID_CELL;
    this.gw = Math.ceil((maxX - this.gx0 + GRID_CELL) / GRID_CELL) + 1;
    this.gh = Math.ceil((maxY - this.gy0 + GRID_CELL) / GRID_CELL) + 1;
    const cells = this.gw * this.gh;
    const counts = new Int32Array(cells + 1);
    const cellOf = new Int32Array(this.n);
    for (let i = 0; i < this.n; i++) {
      const cx = Math.floor((this.xs[i] - this.gx0) / GRID_CELL);
      const cy = Math.floor((this.ys[i] - this.gy0) / GRID_CELL);
      const c = cy * this.gw + cx;
      cellOf[i] = c;
      counts[c + 1]++;
    }
    for (let c = 0; c < cells; c++) counts[c + 1] += counts[c];
    this.gStart = counts;
    this.gItems = new Int32Array(this.n);
    const fill = counts.slice(0, cells);
    for (let i = 0; i < this.n; i++) this.gItems[fill[cellOf[i]]++] = i;
  }

  // Visit every sample index within the square around (x, y) +- r. Callback returns true to stop.
  _scan(x, y, r, fn) {
    const cx0 = Math.max(0, Math.floor((x - r - this.gx0) / GRID_CELL));
    const cy0 = Math.max(0, Math.floor((y - r - this.gy0) / GRID_CELL));
    const cx1 = Math.min(this.gw - 1, Math.floor((x + r - this.gx0) / GRID_CELL));
    const cy1 = Math.min(this.gh - 1, Math.floor((y + r - this.gy0) / GRID_CELL));
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const c = cy * this.gw + cx;
        for (let k = this.gStart[c], e = this.gStart[c + 1]; k < e; k++) {
          if (fn(this.gItems[k])) return true;
        }
      }
    }
    return false;
  }

  // True if any sample of the path lies within r of (x, y).
  within(x, y, r) {
    const r2 = r * r, xs = this.xs, ys = this.ys;
    return this._scan(x, y, r, (i) => {
      const dx = xs[i] - x, dy = ys[i] - y;
      return dx * dx + dy * dy <= r2;
    });
  }

  // Distance from (x, y) to the path, searching up to maxR (returns Infinity beyond).
  distance(x, y, maxR = 250) {
    let best = maxR * maxR, found = false;
    const xs = this.xs, ys = this.ys;
    this._scan(x, y, maxR, (i) => {
      const dx = xs[i] - x, dy = ys[i] - y;
      const d2 = dx * dx + dy * dy;
      if (d2 <= best) { best = d2; found = true; }
      return false;
    });
    return found ? Math.sqrt(best) : Infinity;
  }

  // Path length within radius r of (x, y) (sample count x step). Used for coverage heuristics.
  coverage(x, y, r) {
    let count = 0;
    const r2 = r * r, xs = this.xs, ys = this.ys;
    this._scan(x, y, r, (i) => {
      const dx = xs[i] - x, dy = ys[i] - y;
      if (dx * dx + dy * dy <= r2) count++;
      return false;
    });
    return count * this.step;
  }

  // Nearest point on the path to (x, y): { d, x, y, dist }. Exhaustive (used rarely).
  nearest(x, y) {
    let bi = 0, best = Infinity;
    const xs = this.xs, ys = this.ys;
    for (let i = 0; i < this.n; i++) {
      const dx = xs[i] - x, dy = ys[i] - y;
      const d2 = dx * dx + dy * dy;
      if (d2 < best) { best = d2; bi = i; }
    }
    return { d: Math.min(this.length, bi * this.step), x: xs[bi], y: ys[bi], dist: Math.sqrt(best) };
  }
}
