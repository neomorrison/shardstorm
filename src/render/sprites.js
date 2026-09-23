// Sprite infrastructure: manifest loading, image lookup, and the offscreen-canvas cache
// that every procedural and image sprite goes through.
//
// Manifest (assets/manifest.json), all keys optional, file may be missing entirely:
//   { "sprites": { "tower_pulse_0": { "src": "img/towers/pulse_0.png", "size": 64,
//                                     "rotates": true, "facing": "up" } } }
// `src` is relative to assets/. `size` is the drawn diameter in world units.
// `facing` is the direction the art points in the image: up | right | down | left (default up).

const ASSET_BASE = new URL('../../assets/', import.meta.url);

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

export class Assets {
  constructor(sprites = {}) {
    this.sprites = sprites;   // key -> { img, src, size, rotates, facing, ... }
    this.version = 0;         // bumps when an image arrives late
  }
  has(key) { return !!(this.sprites[key] && this.sprites[key].img); }
  get(key) { const s = this.sprites[key]; return s && s.img ? s : null; }
  image(key) { const s = this.sprites[key]; return s && s.img ? s.img : null; }
  keys() { return Object.keys(this.sprites).filter((k) => this.sprites[k].img); }
}

export const EMPTY_ASSETS = new Assets({});

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image failed: ' + url));
    img.src = String(url);
  });
}

async function fetchJson(url, timeout) {
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = setTimeout(() => ctrl && ctrl.abort(), timeout);
  try {
    const res = await fetch(String(url), { signal: ctrl ? ctrl.signal : undefined, cache: 'no-cache' });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Fetch assets/manifest.json and preload every image it lists. Never throws: a missing
// manifest, bad JSON, missing keys or broken images all degrade to procedural art.
// Resolves after all images load or `timeout` ms, whichever is first. Images that finish
// after the timeout are still added (assets.version bumps so the renderer refreshes).
// onProgress(loaded, total) is optional.
export async function loadAssets({ timeout = 8000, onProgress = null, manifestUrl = null } = {}) {
  const assets = new Assets({});
  const mUrl = manifestUrl ? new URL(manifestUrl, (typeof document !== 'undefined' ? document.baseURI : ASSET_BASE)) : new URL('manifest.json', ASSET_BASE);
  const manifest = await fetchJson(mUrl, Math.min(timeout, 5000));
  const specs = manifest && typeof manifest === 'object' && manifest.sprites && typeof manifest.sprites === 'object' ? manifest.sprites : {};
  const entries = Object.entries(specs).filter(([, s]) => s && typeof s.src === 'string');
  const total = entries.length;
  if (!total) { if (onProgress) onProgress(0, 0); return assets; }
  let loaded = 0;
  let timedOut = false;
  const base = new URL('.', mUrl);
  const jobs = entries.map(([key, spec]) =>
    loadImage(new URL(spec.src, base)).then((img) => {
      assets.sprites[key] = {
        size: 64, rotates: false, facing: 'up', ...spec, img,
      };
      if (timedOut) assets.version++;
    }).catch(() => { /* missing image: procedural fallback */ }).finally(() => {
      loaded++;
      if (onProgress) { try { onProgress(loaded, total); } catch { /* ignore */ } }
    }));
  await Promise.race([
    Promise.all(jobs),
    new Promise((r) => setTimeout(r, timeout)),
  ]);
  timedOut = true;
  return assets;
}

// Rotation offset so an image whose art points `facing` ends up pointing along angle 0 (+x).
export function facingOffset(facing) {
  switch (facing) {
    case 'right': return 0;
    case 'down': return -Math.PI / 2;
    case 'left': return Math.PI;
    case 'up':
    default: return Math.PI / 2;
  }
}

// ---------------------------------------------------------------------------
// Offscreen canvases and the sprite cache
// ---------------------------------------------------------------------------

export function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(w));
  c.height = Math.max(1, Math.ceil(h));
  return c;
}

// A Sprite is a source image region plus the world-space box it covers:
//   c: canvas | ImageBitmap | atlas page canvas, (sx, sy, sw, sh): source rect in pixels,
//   w, h: world size, ax, ay: world-space anchor inside the box.
// Always draw with drawSprite() (9-argument drawImage) so atlas regions work.
export class Sprite {
  constructor(c, w, h, ax, ay) {
    this.c = c; this.sx = 0; this.sy = 0; this.sw = c.width; this.sh = c.height;
    this.w = w; this.h = h; this.ax = ax; this.ay = ay;
    this.page = null;
  }
}

// Draw sprite s with its anchor at world (x, y) in the current transform, scaled by `scale`.
export function drawSprite(ctx, s, x, y, scale = 1) {
  ctx.drawImage(s.c, s.sx, s.sy, s.sw, s.sh, x - s.ax * scale, y - s.ay * scale, s.w * scale, s.h * scale);
}

// Render `draw(ctx)` into a new sprite. `w`,`h` are world units; `k` = pixels per world unit.
// The drawing origin is the anchor (default: center).
export function makeSprite(k, w, h, draw, ax = w / 2, ay = h / 2) {
  const pw = Math.max(2, Math.ceil(w * k) + 2);
  const ph = Math.max(2, Math.ceil(h * k) + 2);
  const c = makeCanvas(pw, ph);
  const ctx = c.getContext('2d');
  // Map world box (with 1px border) exactly onto the canvas.
  const sx = (pw - 2) / w, sy = (ph - 2) / h;
  ctx.setTransform(sx, 0, 0, sy, 1 + ax * sx, 1 + ay * sy);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  draw(ctx);
  // World box including the 1px border.
  const bw = pw / sx, bh = ph / sy;
  return new Sprite(c, bw, bh, ax + 1 / sx, ay + 1 / sy);
}

// Quantize pixel density so small resizes reuse cached sprites (steps of about 4.4%).
export function quantizeK(k) {
  return Math.pow(2, Math.round(Math.log2(Math.max(0.05, k)) * 16) / 16);
}

// ---------------------------------------------------------------------------
// Atlas pages
// ---------------------------------------------------------------------------
// GPU canvases batch draws that share a texture. Thousands of sprites drawn from separate
// small canvases each become their own GPU draw call, which roughly halves frame rate past
// about 3,000 draws. So sprites are packed into a few large atlas pages (one per group:
// enemies, projectiles, particles, misc) with a simple shelf packer.

const GUTTER = 2;
const MAX_ATLAS_SPRITE = 300; // pixels; bigger sprites stay standalone

class AtlasPage {
  // size: 1024 at normal pixel densities (4 MB each), 2048 on high-DPI screens.
  constructor(group, size) {
    this.group = group;
    this.size = size;
    this.canvas = makeCanvas(size, size);
    this.ctx = this.canvas.getContext('2d');
    this.shelves = [];
    this.nextY = 0;
    this.full = false;
  }
  alloc(w, h) {
    w += GUTTER; h += GUTTER;
    for (const s of this.shelves) {
      if (h <= s.h && h >= s.h * 0.6 && s.x + w <= this.size) { const x = s.x; s.x += w; return { x, y: s.y }; }
    }
    if (this.nextY + h > this.size || w > this.size) return null;
    const shelf = { y: this.nextY, h, x: w };
    this.shelves.push(shelf);
    this.nextY += h;
    return { x: 0, y: shelf.y };
  }
}

function groupOf(key) {
  const c0 = key.charCodeAt(0), c1 = key.charCodeAt(1);
  if (c0 === 109 && c1 === 124) return 'enemy';                 // 'm|'
  if (key.startsWith('pj|')) return 'proj';
  if (c0 === 112 && c1 === 124) return 'fx';                    // 'p|'
  if (key.startsWith('rot|mc|') || key.startsWith('wimg|') || key.startsWith('mods|')) return 'enemy';
  return 'misc';
}

// Keyed sprite cache bound to a pixel density. Changing density clears it.
// New sprites are drawn into their own canvas and usable at once; flush() (called by the
// renderer at the start of each frame, before any drawing) then copies them into atlas pages.
// Doing the copies at frame start means a page is never modified while the GPU still holds
// a snapshot from the current frame. Oversized sprites stay standalone and are swapped for
// an ImageBitmap.
export class SpriteCache {
  constructor() {
    this.k = 0; this.map = new Map(); this.count = 0; this.gen = 0;
    this.pages = [];
    this.pending = [];
    this.atlas = typeof document !== 'undefined';
    this.bitmaps = typeof createImageBitmap === 'function';
  }
  setK(k) {
    const q = quantizeK(k);
    if (q !== this.k) { this.k = q; this.clear(); }
    return this.k;
  }
  clear() { this.map.clear(); this.gen++; this.pages = []; this.pending = []; }
  get(key, w, h, draw, ax, ay) {
    let s = this.map.get(key);
    if (s === undefined) {
      s = makeSprite(this.k, w, h, draw, ax, ay);
      this.map.set(key, s);
      this.count++;
      if (this.atlas && s.sw <= MAX_ATLAS_SPRITE && s.sh <= MAX_ATLAS_SPRITE) { s.group = groupOf(key); this.pending.push(s); }
      else if (this.bitmaps) this._toBitmap(s);
    }
    return s;
  }
  // Move pending sprites into atlas pages. `budget` caps the copies per frame.
  flush(budget = 400) {
    const pend = this.pending;
    if (!pend.length) return 0;
    const n = Math.min(budget, pend.length);
    for (let i = 0; i < n; i++) {
      const s = pend[i];
      let page = null, slot = null;
      for (const p of this.pages) {
        if (p.group !== s.group || p.full) continue;
        slot = p.alloc(s.sw, s.sh);
        if (slot) { page = p; break; }
        p.full = s.sh < 24; // a page that cannot fit even small sprites is done
      }
      if (!page) {
        page = new AtlasPage(s.group, this.k > 1.3 ? 2048 : 1024);
        this.pages.push(page);
        slot = page.alloc(s.sw, s.sh);
        if (!slot) { if (this.bitmaps) this._toBitmap(s); continue; }
      }
      const src = s.c;
      page.ctx.drawImage(src, 0, 0, s.sw, s.sh, slot.x, slot.y, s.sw, s.sh);
      s.c = page.canvas; s.sx = slot.x; s.sy = slot.y; s.page = page;
      if (src && src.width) { src.width = 1; src.height = 1; } // free the scratch canvas
    }
    pend.splice(0, n);
    return n;
  }
  _toBitmap(s) {
    const gen = this.gen;
    try {
      createImageBitmap(s.c).then((bmp) => {
        if (gen === this.gen && !s.page) { s.c = bmp; s.sx = 0; s.sy = 0; s.sw = bmp.width; s.sh = bmp.height; }
        else if (bmp.close) bmp.close();
      }, () => { /* keep the canvas */ });
    } catch { /* keep the canvas */ }
  }
  peek(key) { return this.map.get(key); }
  put(key, s) { this.map.set(key, s); return s; }
  stats() { return { sprites: this.map.size, pages: this.pages.length, pending: this.pending.length }; }
}

// Pre-scale a loaded image into a sprite of `size` world units (longest side) at density k.
// `pivot` ({ x, y } as fractions of the image, default the center) becomes the sprite anchor,
// so rotation and placement happen about that point.
export function imageSprite(cache, key, spec, sizeOverride, pivot = null) {
  const size = sizeOverride || spec.size || 64;
  const img = spec.img;
  const iw = img.naturalWidth || img.width || 1, ih = img.naturalHeight || img.height || 1;
  const aspect = iw / ih;
  const w = aspect >= 1 ? size : size * aspect;
  const h = aspect >= 1 ? size / aspect : size;
  const px = pivot ? pivot.x : 0.5, py = pivot ? pivot.y : 0.5;
  const pk = pivot ? '|' + px.toFixed(3) + ',' + py.toFixed(3) : '';
  return cache.get('img|' + key + '|' + size + pk, w, h, (ctx) => {
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, -w * px, -h * py, w, h);
  }, w * px, h * py);
}

// Soft drop shadow of an image: its silhouette, blurred, in translucent black. Same box and
// anchor as imageSprite(cache, key, spec, size, pivot) so it rotates with the art.
export function imageShadow(cache, key, spec, size, pivot = null, alpha = 0.5, blur = 0.045) {
  const img = spec.img;
  const iw = img.naturalWidth || img.width || 1, ih = img.naturalHeight || img.height || 1;
  const aspect = iw / ih;
  const w = aspect >= 1 ? size : size * aspect;
  const h = aspect >= 1 ? size / aspect : size;
  const px = pivot ? pivot.x : 0.5, py = pivot ? pivot.y : 0.5;
  const pad = size * blur * 2.5;
  const k = pivot ? '|' + px.toFixed(3) + ',' + py.toFixed(3) : '';
  return cache.get('ishd|' + key + '|' + size + k + '|' + alpha, w + pad * 2, h + pad * 2, (ctx) => {
    drawSoftSilhouette(ctx, img, -w * px, -h * py, w, h, size * blur, alpha);
  }, w * px + pad, h * py + pad);
}

// Draw a blurred black silhouette of `img` at world rect (x, y, w, h). The blur comes from
// rendering the silhouette at low resolution and scaling it up with smoothing, which works in
// every browser (canvas `filter` is not universal). blur is in world units.
export function drawSoftSilhouette(ctx, img, x, y, w, h, blur, alpha) {
  const kk = Math.hypot(ctx.getTransform().a, ctx.getTransform().b) || 1;
  const bpx = Math.max(1, blur * kk);                 // blur radius in device px
  const f = Math.min(1, 1 / (1.5 * bpx));             // downscale: upscaling by 1/f softens ~bpx
  const pad = Math.ceil(bpx * 2 * f) + 2;
  const sw = Math.max(2, Math.round(w * kk * f)), sh = Math.max(2, Math.round(h * kk * f));
  const c = makeCanvas(sw + pad * 2, sh + pad * 2);
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.drawImage(img, pad, pad, sw, sh);
  g.globalCompositeOperation = 'source-in';
  g.fillStyle = `rgba(0,0,0,${alpha})`;
  g.fillRect(0, 0, c.width, c.height);
  const sx = w / sw, sy = h / sh;
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(c, x - pad * sx, y - pad * sy, c.width * sx, c.height * sy);
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Image analysis: where the "body" of a sprite is.
// ---------------------------------------------------------------------------
// Towers are drawn from single images that include long barrels, antennae and spikes, and
// Commanders stand on pedestals. imageMeta measures the opaque silhouette once per image:
//   pivot : centroid of the thick core (pixels far from any edge), as image fractions. Thin
//           barrels do not move it, so turrets rotate about their base.
//   foot  : center of the lowest part of the silhouette (a pedestal or base), as fractions.
//   bodyR : radius of a disc with the silhouette's area, as a fraction of the longest side.
//   box   : opaque bounding box [x0, y0, x1, y1] as fractions.
// Falls back to a centered disc when pixels cannot be read.
const META_N = 96;
export function imageMeta(spec) {
  if (!spec || !spec.img) return FALLBACK_META;
  if (spec._meta) return spec._meta;
  let meta = FALLBACK_META;
  try { meta = measure(spec.img); } catch { meta = FALLBACK_META; }
  spec._meta = meta;
  return meta;
}
const FALLBACK_META = Object.freeze({ pivot: { x: 0.5, y: 0.5 }, foot: { x: 0.5, y: 0.9 }, bodyR: 0.4, box: [0.05, 0.05, 0.95, 0.95] });

function measure(img) {
  const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
  if (!iw || !ih) return FALLBACK_META;
  const s = META_N / Math.max(iw, ih);
  const w = Math.max(4, Math.round(iw * s)), h = Math.max(4, Math.round(ih * s));
  const c = makeCanvas(w, h);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0, w, h);
  const data = g.getImageData(0, 0, w, h).data;
  const n = w * h;
  const mask = new Uint8Array(n);
  let area = 0, bx0 = w, by0 = h, bx1 = -1, by1 = -1;
  for (let i = 0; i < n; i++) {
    if (data[i * 4 + 3] > 96) {
      mask[i] = 1; area++;
      const x = i % w, y = (i / w) | 0;
      if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y;
    }
  }
  if (area < 8) return FALLBACK_META;
  // Chamfer distance to the nearest transparent pixel (3-4 metric, two passes).
  const D = new Float32Array(n);
  const BIG = 1e6;
  for (let i = 0; i < n; i++) D[i] = mask[i] ? BIG : 0;
  const at = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : D[y * w + x]);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!D[i]) continue;
      D[i] = Math.min(D[i], at(x - 1, y) + 3, at(x, y - 1) + 3, at(x - 1, y - 1) + 4, at(x + 1, y - 1) + 4);
    }
  }
  let dmax = 0;
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (!D[i]) continue;
      D[i] = Math.min(D[i], at(x + 1, y) + 3, at(x, y + 1) + 3, at(x + 1, y + 1) + 4, at(x - 1, y + 1) + 4);
      if (D[i] > dmax) dmax = D[i];
    }
  }
  let sx = 0, sy = 0, cn = 0;
  const thr = dmax * 0.55;
  for (let i = 0; i < n; i++) if (D[i] >= thr) { sx += i % w; sy += (i / w) | 0; cn++; }
  // Foot: silhouette pixels in the bottom 12% of the box.
  const fy0 = by1 - Math.max(1, (by1 - by0) * 0.12);
  let fx = 0, fyS = 0, fn = 0;
  for (let y = Math.max(0, Math.floor(fy0)); y <= by1; y++) for (let x = bx0; x <= bx1; x++) if (mask[y * w + x]) { fx += x; fyS += y; fn++; }
  return {
    pivot: { x: (sx / cn + 0.5) / w, y: (sy / cn + 0.5) / h },
    foot: { x: fn ? (fx / fn + 0.5) / w : 0.5, y: fn ? (fyS / fn + 0.5) / h : 0.9 },
    bodyR: Math.sqrt(area / Math.PI) / Math.max(w, h),
    box: [bx0 / w, by0 / h, (bx1 + 1) / w, (by1 + 1) / h],
  };
}
