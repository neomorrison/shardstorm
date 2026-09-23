// Uniform grid spatial hash for enemies, rebuilt once per tick (counting sort, no per-tick
// allocation once the buffers are large enough). Pure.
//
// Between rebuilds the hash stays exact for enemies created or teleported mid-tick: insert()
// files them in an overflow list per cell, and each enemy remembers its one live slot
// (e._gs), so an enemy is never returned twice or from a cell it has left. Small same-tick
// moves that do not call insert() (pulls and tows of a few units) are covered by MOVE_SLACK.
//
// Big bodies (radius > BIG_RADIUS: ships and Titans) are kept in a short separate list that
// every query scans, so one Titan (radius 80) does not widen every query on the field by 80
// units. Queries over the grid only pad by the largest meteor radius.
export const MOVE_SLACK = 8;
export const BIG_RADIUS = 24;

export class SpatialHash {
  constructor(cell = 64, x0 = -448, y0 = -448, w = 2400, h = 1900) {
    this.cell = cell;
    this.x0 = x0; this.y0 = y0;
    this.gw = Math.ceil(w / cell);
    this.gh = Math.ceil(h / cell);
    this.cells = this.gw * this.gh;
    this.start = new Int32Array(this.cells + 1);
    this.fill = new Int32Array(this.cells);
    this.items = new Int32Array(1024);
    this.cellOf = new Int32Array(1024);
    this.list = [];
    this.count = 0;
    this.maxRadius = 0;       // largest radius filed in the grid cells (big bodies excluded)
    // overflow: enemies filed after the last build (linked list per cell)
    this.xHead = new Int32Array(this.cells).fill(-1);
    this.xNext = new Int32Array(256);
    this.xItems = [];
    // big bodies, scanned by every query
    this.big = [];
    this.stamp = 0;
  }

  // File `e` at its current position (a child spawned or an enemy teleported mid-tick). Its old
  // slot, if any, stops matching and is skipped by query().
  insert(e) {
    if (e.radius > BIG_RADIUS) {
      if (e._gb !== this.stamp) { e._gb = this.stamp; this.big.push(e); }
      return;
    }
    const c = this._cellIndex(e.x, e.y);
    if (e._gc === c && e._gs !== undefined && e._gs >= 0) return; // still filed in this cell
    const k = this.xItems.length;
    if (k >= this.xNext.length) {
      const nx = new Int32Array(this.xNext.length * 2);
      nx.set(this.xNext);
      this.xNext = nx;
    }
    this.xItems.push(e);
    this.xNext[k] = this.xHead[c];
    this.xHead[c] = k;
    e._gs = this.count + k; e._gc = c;
    if (e.radius > this.maxRadius) this.maxRadius = e.radius;
  }

  _cellIndex(x, y) {
    let cx = Math.floor((x - this.x0) / this.cell);
    let cy = Math.floor((y - this.y0) / this.cell);
    if (cx < 0) cx = 0; else if (cx >= this.gw) cx = this.gw - 1;
    if (cy < 0) cy = 0; else if (cy >= this.gh) cy = this.gh - 1;
    return cy * this.gw + cx;
  }

  build(enemies) {
    const n = enemies.length;
    if (this.items.length < n) {
      let cap = this.items.length;
      while (cap < n) cap *= 2;
      this.items = new Int32Array(cap);
      this.cellOf = new Int32Array(cap);
    }
    this.list = enemies;
    if (this.xItems.length) { this.xHead.fill(-1); this.xItems.length = 0; }
    const stamp = ++this.stamp;
    const big = this.big;
    big.length = 0;
    const start = this.start;
    start.fill(0);
    let maxR = 0;
    for (let i = 0; i < n; i++) {
      const e = enemies[i];
      if (e.dead) { this.cellOf[i] = -1; continue; }
      if (e.radius > BIG_RADIUS) { this.cellOf[i] = -1; e._gb = stamp; big.push(e); continue; }
      const c = this._cellIndex(e.x, e.y);
      this.cellOf[i] = c;
      start[c + 1]++;
      if (e.radius > maxR) maxR = e.radius;
    }
    for (let c = 0; c < this.cells; c++) start[c + 1] += start[c];
    this.fill.set(start.subarray(0, this.cells));
    for (let i = 0; i < n; i++) {
      const c = this.cellOf[i];
      if (c >= 0) { const k = this.fill[c]++; this.items[k] = i; enemies[i]._gs = k; enemies[i]._gc = c; }
    }
    this.count = n;
    this.maxRadius = maxR;
  }

  // Fill `out` (cleared first) with live enemies whose body touches the circle (x, y, r).
  query(x, y, r, out) {
    out.length = 0;
    const list = this.list;
    const reach = r + this.maxRadius + MOVE_SLACK;
    const cell = this.cell;
    let cx0 = Math.floor((x - reach - this.x0) / cell), cx1 = Math.floor((x + reach - this.x0) / cell);
    let cy0 = Math.floor((y - reach - this.y0) / cell), cy1 = Math.floor((y + reach - this.y0) / cell);
    if (cx0 < 0) cx0 = 0; if (cy0 < 0) cy0 = 0;
    if (cx1 >= this.gw) cx1 = this.gw - 1; if (cy1 >= this.gh) cy1 = this.gh - 1;
    const start = this.start, items = this.items;
    const xs = this.xItems, xHead = this.xHead, xNext = this.xNext, n0 = this.count;
    const hasX = xs.length > 0;
    for (let cy = cy0; cy <= cy1; cy++) {
      const row = cy * this.gw;
      for (let cx = cx0; cx <= cx1; cx++) {
        const c = row + cx;
        for (let k = start[c], end = start[c + 1]; k < end; k++) {
          const e = list[items[k]];
          if (e.dead || e._gs !== k) continue;
          const dx = e.x - x, dy = e.y - y, rr = r + e.radius;
          if (dx * dx + dy * dy <= rr * rr) out.push(e);
        }
        if (hasX) {
          for (let k = xHead[c]; k >= 0; k = xNext[k]) {
            const e = xs[k];
            if (e.dead || e._gs !== n0 + k) continue;
            const dx = e.x - x, dy = e.y - y, rr = r + e.radius;
            if (dx * dx + dy * dy <= rr * rr) out.push(e);
          }
        }
      }
    }
    const big = this.big;
    for (let k = 0; k < big.length; k++) {
      const e = big[k];
      if (e.dead) continue;
      const dx = e.x - x, dy = e.y - y, rr = r + e.radius;
      if (dx * dx + dy * dy <= rr * rr) out.push(e);
    }
    return out;
  }
}
