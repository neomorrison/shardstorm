// Uniform grid spatial hash for enemies, rebuilt once per tick (counting sort, no per-tick
// allocation once the buffers are large enough). Pure.

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
    this.maxRadius = 0;
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
    const start = this.start;
    start.fill(0);
    let maxR = 0;
    for (let i = 0; i < n; i++) {
      const e = enemies[i];
      if (e.dead) { this.cellOf[i] = -1; continue; }
      const c = this._cellIndex(e.x, e.y);
      this.cellOf[i] = c;
      start[c + 1]++;
      if (e.radius > maxR) maxR = e.radius;
    }
    for (let c = 0; c < this.cells; c++) start[c + 1] += start[c];
    this.fill.set(start.subarray(0, this.cells));
    for (let i = 0; i < n; i++) {
      const c = this.cellOf[i];
      if (c >= 0) this.items[this.fill[c]++] = i;
    }
    this.count = n;
    this.maxRadius = maxR;
  }

  // Fill `out` (cleared first) with live enemies whose body touches the circle (x, y, r).
  query(x, y, r, out) {
    out.length = 0;
    const list = this.list;
    const reach = r + this.maxRadius;
    const cell = this.cell;
    let cx0 = Math.floor((x - reach - this.x0) / cell), cx1 = Math.floor((x + reach - this.x0) / cell);
    let cy0 = Math.floor((y - reach - this.y0) / cell), cy1 = Math.floor((y + reach - this.y0) / cell);
    if (cx0 < 0) cx0 = 0; if (cy0 < 0) cy0 = 0;
    if (cx1 >= this.gw) cx1 = this.gw - 1; if (cy1 >= this.gh) cy1 = this.gh - 1;
    if (cx0 > cx1 || cy0 > cy1) return out;
    const start = this.start, items = this.items;
    for (let cy = cy0; cy <= cy1; cy++) {
      const row = cy * this.gw;
      for (let cx = cx0; cx <= cx1; cx++) {
        const c = row + cx;
        for (let k = start[c], end = start[c + 1]; k < end; k++) {
          const e = list[items[k]];
          if (e.dead) continue;
          const dx = e.x - x, dy = e.y - y, rr = r + e.radius;
          if (dx * dx + dy * dy <= rr * rr) out.push(e);
        }
      }
    }
    return out;
  }
}
