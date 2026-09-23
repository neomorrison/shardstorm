// Renderer: draws a Sim state onto a canvas (docs/ARCHITECTURE.md section 8).
//
//   const r = new Renderer(canvas, assets);   // assets from loadAssets() (optional)
//   r.setMap(sim);                             // pre-renders terrain + channel
//   r.onEvents(sim.drainEvents());             // once per frame, before render
//   r.render(sim, frameDt, uiState);           // uiState = { hoverTowerId, selectedTowerId,
//                                              //   placing: { type, x, y, valid, def?, range? } | null,
//                                              //   showAllRanges, aimingTowerId,
//                                              //   settings: { particles, shake, floatText, reducedMotion } }
//   r.setSettings({ particles: 'low'|'medium'|'high', shake, floatText, reducedMotion })
//   r.setInsets({ top, right, bottom, left })  // CSS px covered by overlaid UI (HUD bar, drawer)
//   r.zoomAt(factor, px, py) / r.setZoom(z, px, py) / r.panBy(dx, dy) / r.resetView()
//   r.zoom, r.maxZoom                           // view control (pinch, wheel, drag), clamped to the world
//   r.screenToWorld(px, py) / r.worldToScreen(x, y)   // CSS px relative to the canvas
//   r.clientToWorld(clientX, clientY)                 // viewport coords (MouseEvent.clientX/Y)
//   r.stats                                           // { enemies, projectiles, particles, drawMs, governor }
//
// UI helpers (draw into any 2D context, centered in a size x size box):
//   drawTowerIcon(ctx, towerDef, size, variant = 0, assets?), drawHeroIcon(ctx, heroDef, size, assets?),
//   drawEnemyIcon(ctx, type, size, mods = {}, assets?), drawTitanIcon(ctx, kind, size, assets?)
//   renderMapPreview(canvas, map, cssW, cssH, assets?)   // map card art from the real static layer
//
// Performance: every entity is drawn from pre-rendered sprites packed into atlas pages (so the
// GPU can batch), pre-rotated into frames where they spin or aim (so draws need no transform
// change), no shadowBlur at draw time, pooled and capped particles, off-screen culling, and a
// load governor that thins effects when frames get expensive.

import { Camera, WORLD_W, WORLD_H } from './camera.js';
import { SpriteCache, EMPTY_ASSETS, imageSprite, imageShadow, imageMeta, facingOffset, drawSprite, quantizeK } from './sprites.js';
import * as P from './procedural.js';
import { Particles, shardColors, EXPLOSION_COLORS } from './particles.js';
import { buildLanes, placePortals, buildStaticLayer, CORE_R } from './channel.js';
import { ENEMIES } from '../data/enemies.js';
import { CORE_KEEPOUT, BOUNDS_MARGIN } from '../sim/game.js';

export { loadAssets } from './sprites.js';

const TAU = Math.PI * 2;
// Governor thresholds (ms of renderer time per frame) and the particle pool scale per level.
const GOV_UP = [11, 17];
const GOV_DOWN = [6, 10];
const GOV_PARTICLES = [1, 0.55, 0.3];
const PROJ_FRAMES = 32;
// Visual scale over sim radii (hitboxes are unchanged).
const METEOR_VIS = 1.3;
const TOWER_VIS = 1.12;
// Zoom: sprite density cap (device px per world unit; the art has no more detail than this),
// static layer pixel budget, and how long after the last zoom step caches stay frozen.
const SPRITE_K_MAX = 3.2;
const STATIC_BUDGET = 8.5e6;
const STATIC_BUDGET_SMALL = 5.5e6;
const ZOOM_SETTLE_MS = 180;
// Image towers: silhouette area radius as a multiple of the footprint radius.
const TOWER_ART_R = 1.3;
// Commanders: silhouette area radius as a multiple of the footprint radius (the figure stands
// taller than a turret, its pedestal on the footprint).
const HERO_ART_R = 1.3;

// Optional registries for placement ghosts (tower type -> def). Loaded lazily; main.js can
// also pass them with renderer.setDefs({ towers, heroes }).
let TOWER_DEFS = null;
let HERO_DEFS = null;
import('../data/towers/index.js').then((m) => { TOWER_DEFS = TOWER_DEFS || m.TOWERS || m.default || null; }).catch(() => {});
import('../data/heroes.js').then((m) => { HERO_DEFS = HERO_DEFS || m.HEROES || m.default || null; }).catch(() => {});

const DTYPE_COLORS = {
  KINETIC: '#fff2c4', BLAST: '#ffb347', THERMAL: '#ff7a3d', CRYO: '#bff4ff', ENERGY: '#7fe9ff', VOID: '#c77dff',
};
const HITSCAN_VISUALS = new Set(['slug', 'rail', 'hitscan', 'tracer', 'snipe', 'railslug']);
const ADD_ONLY_VISUALS = new Set(['orb', 'plasma', 'flame', 'plasmaorb']);
// Stroke width multipliers for chain lightning looks (zap events may also carry `width`).
const ZAP_WIDTH = { arcweb: 1.1, stormcrown: 1.55, overload: 1.35, zeus: 2.4 };
// Colours for ability flourishes (abilityFx ids; a trailing level digit is ignored).
const ABILITY_FX_COLORS = {
  hurricane: '#8ee6ff', maelstrom: '#c9f2ff', carpet: '#ff9f43', absolutezero: '#dff8ff', zeus: '#fff6c2',
  bombingrun: '#ff9a3a', barrage: '#ff6b5d', blackhole: '#b86bff', warcouncil: '#ffd76a',
  overcharge: '#ffe28a', orbital: '#9ff4ff', emp: '#8ff0ff', supernova: '#ffffff', rocketbarrage: '#ffb347', punch: '#ff8c2a',
};
const TITAN_KINDS = new Set(['maw', 'aegis', 'rift']);
// RP-10: ship health bars. A ship within this many world units of the core (regardless of HP)
// still earns a bar, since it is about to leak; everything else needs to be damaged. Once more
// than SHIP_BAR_MAX non-titan bars would be eligible in one frame, only the most urgent survive.
const SHIP_BAR_FRONT_DIST = 300;
const SHIP_BAR_MAX = 40;
// Manifest keys that differ from the tower id (the art pipeline names the Rail Sniper 'sniper').
const SPRITE_ALIAS = { rail: 'tower_sniper' };
const ROUND_HEADS = new Set(['pulse', 'scatter', 'laser', 'cryo', 'mortar', 'vega', 'nova', 'gravity']);

// Nearest of n evenly spaced rotation frames for an angle.
function frameOf(angle, n) {
  let f = Math.round((angle * n) / TAU) % n;
  if (f < 0) f += n;
  return f;
}

// Real seconds (drives debounces that must run while the game is paused).
function rnow() { return ((typeof performance !== 'undefined') ? performance.now() : Date.now()) / 1000; }

function qualityOf(q) { return q === 'low' || q === 'medium' ? q : 'high'; }

function idHash(id) {
  if (typeof id === 'number') { let h = Math.imul(id | 0, 2654435761) >>> 0; h ^= h >>> 15; return h / 4294967296; }
  return P.hashStr(String(id)) / 4294967296;
}

export class Renderer {
  constructor(canvas, assets) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false }) || canvas.getContext('2d');
    this.assets = assets || EMPTY_ASSETS;
    this.assetVersion = this.assets.version || 0;
    this.camera = new Camera(canvas);
    this.cache = new SpriteCache();
    this.particles = new Particles();
    this.sim = null;
    this.map = null;
    this.lanes = [];
    this.portals = [];
    this.shared = [];          // per lane: Uint8Array of samples shared with an earlier lane
    this.static = null;
    this.staticDirty = true;
    this.staticDirtyAt = 0;
    this.time = 0;             // real seconds
    this.lastSimTime = null;
    this.frame = 0;
    this.settings = { particles: 'high', shake: true, floatText: true };
    this.zaps = [];
    this.tracers = [];
    this.persist = [];         // timed ground effects (black holes)
    this.coreHurt = 0;
    this.leakFlash = 0;
    this.whiteFlash = 0;
    this.lastLives = null;
    this.hpTrack = new Map();
    this.towerSnap = new Map();
    this.recoil = new Map();
    this.shellRec = new WeakMap();
    this.enemyById = null;
    this.stats = { enemies: 0, projectiles: 0, particles: 0, drawMs: 0, governor: 0 };
    this.governor = 0;           // 0 full, 1 lighter particles, 2 minimal effects
    this.autoQuality = true;
    this._pt = { x: 0, y: 0, angle: 0 };
    this._mSpr = new Map();
    this._pjSpr = new Map();
    this._rotSpr = new Map();
    this._tfWorld = false;
    this._sprK = 0;
    this._needsSync = true;
    this._defs = { towers: null, heroes: null };
    if (typeof ResizeObserver !== 'undefined') {
      try {
        this._ro = new ResizeObserver(() => { this._needsSync = true; });
        this._ro.observe(canvas);
      } catch { this._ro = null; }
    }
    this.camera.sync();
  }

  // ------------------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------------------

  setAssets(assets) {
    this.assets = assets || EMPTY_ASSETS;
    this.assetVersion = this.assets.version || 0;
    this.cache.clear();
    this._mSpr.clear();
    this._pjSpr.clear();
    this._rotSpr.clear();
    if (this._timg) this._timg.clear();
    if (this._tart) this._tart.clear();
    if (this._eimg) this._eimg.clear();
    this.staticDirty = true;
  }

  // s: { particles: 'low'|'medium'|'high', shake: bool, floatText: bool, reducedMotion: bool }
  setSettings(s = {}) {
    if (!s) return;
    if ('particles' in s) this.settings.particles = qualityOf(s.particles);
    if ('shake' in s) this.settings.shake = s.shake !== false && s.shake !== 0;
    if ('floatText' in s) this.settings.floatText = s.floatText !== false && s.floatText !== 0;
    if ('reducedMotion' in s) this.settings.reducedMotion = !!s.reducedMotion;
    if (this.settings.reducedMotion) this.settings.shake = false;
    this.particles.setQuality(this.settings.particles);
  }

  // Keep world content clear of overlaid UI (CSS px), e.g. { top: hudHeight, bottom: drawerHeight }.
  // The terrain still covers the whole canvas; only the world fit changes.
  setInsets(insets) {
    if (this.camera.setInsets(insets)) this._needsSync = true;
  }

  setDefs({ towers, heroes } = {}) {
    if (towers) { this._defs.towers = towers; TOWER_DEFS = towers; }
    if (heroes) { this._defs.heroes = heroes; HERO_DEFS = heroes; }
  }

  setMap(sim) {
    this.sim = sim;
    this.map = (sim && sim.map) || null;
    this.lanes = buildLanes(sim, this.map);
    this.particles.clear();
    this.zaps.length = 0;
    this.tracers.length = 0;
    this.persist.length = 0;
    this.hpTrack.clear();
    this.recoil.clear();
    this.towerSnap.clear();
    this.coreHurt = 0; this.leakFlash = 0; this.whiteFlash = 0;
    this.lastLives = null;
    this.lastSimTime = null;
    this.camera.trauma = 0;
    this.camera.resetView();
    this._computeShared();
    this.camera.sync();
    this._rebuildStatic();
  }

  // View control (pinch, wheel and drag). px, py are CSS px relative to the canvas. The
  // camera clamps so the world always fills the view; zoom 1 is the plain fit.
  zoomAt(factor, px, py) { this._syncNow(); return this.camera.zoomBy(factor, px, py); }
  setZoom(z, px, py) { this._syncNow(); return this.camera.setZoom(z, px, py); }
  panBy(dx, dy) { return this.camera.panBy(dx, dy); }
  resetView() { return this.camera.resetView(); }
  get zoom() { return this.camera.zoom; }
  get maxZoom() { return this.camera.maxZoom; }
  _syncNow() {
    if (this._needsSync) { this._needsSync = false; if (this.camera.sync()) { this.staticDirty = true; this.staticDirtyAt = rnow(); } }
  }

  screenToWorld(px, py) { return this.camera.screenToWorld(px, py); }
  worldToScreen(x, y) { return this.camera.worldToScreen(x, y); }
  clientToWorld(cx, cy) { return this.camera.clientToWorld(cx, cy); }
  // Pixel size of one world unit in CSS px (for UI overlays).
  get scale() { return this.camera.scale; }

  onEvents(events) {
    if (!events || !events.length) return;
    const sim = this.sim;
    const pt = this.particles;
    let hits = 0, shots = 0, pops = 0, blocked = 0, explodes = 0, pulses = 0;
    const floatText = this.settings.floatText !== false;
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      if (!e) continue;
      switch (e.t) {
        case 'pop': {
          if (pops++ > 160) break;
          if (e.ship) {
            const def = ENEMIES[e.type];
            const col = (def && def.color) || e.color || '#667';
            const R = (def && def.radius) || 40;
            pt.chunks(e.x, e.y, P.shade(col, 0.1), 6 + R / 6, 140 + R * 2, R * 0.2);
            pt.explosion(e.x, e.y, R * 1.2, 'BLAST');
            pt.embers(e.x, e.y, 10, 160);
            pt.ring(e.x, e.y, R * 0.4, R * 1.8, 0.45, '#ffe0a0', 4, 0.9, true);
            this.shake(Math.min(0.45, 0.12 + R / 250));
          } else {
            const def = ENEMIES[e.type];
            const n = Math.min(12, 4 + (e.count || 1));
            const r = (def && def.radius) || 12;
            pt.shatter(e.x, e.y, shardColors(e.type, e.color || (def && def.color)), n, 120 + r * 4, 2.8 + r * 0.16);
            pt.glow(e.x, e.y, r * 1.2, (def && (def.glow || def.color)) || e.color || '#fff', 0.12, 0.55, 1.3);
            if (e.type === 'obsidian' || e.type === 'aurora' || e.type === 'geode') {
              pt.ring(e.x, e.y, r * 0.5, r * 2.2, 0.3, P.glowColor((def && (def.glow || def.color)) || '#fff'), 2.5, 0.8, true);
            }
            if (e.type === 'magma') pt.embers(e.x, e.y, 5, 110);
          }
          break;
        }
        case 'hit': {
          if (hits++ > 50) break;
          const c = DTYPE_COLORS[e.dtype] || '#ffffff';
          pt.sparks(e.x, e.y, c, 2, 160, 5, 0.14);
          break;
        }
        case 'blocked': {
          if (blocked++ > 18) break;
          pt.ring(e.x, e.y, 3, 14, 0.2, '#cfd6e4', 2, 0.9);
          pt.sparks(e.x, e.y, '#cfd6e4', 2, 120, 4, 0.12);
          break;
        }
        case 'explode': {
          if (e.visual === 'blackhole' && Number.isFinite(e.x)) {
            const r = e.r || 110;
            pt.ring(e.x, e.y, r * 1.4, r * 0.1, 0.45, '#b86bff', 6, 1, true);
            pt.glow(e.x, e.y, r, '#7b2cff', 0.5, 0.6, 0.5);
            pt.sparks(e.x, e.y, '#e2c8ff', 14, 260, 10, 0.35);
            this.shake(0.3);
            break;
          }
          if (explodes++ > 24) break;
          const r = e.r || 40;
          // Many blasts on one spot (a rapid mortar, a barrage) would stack their additive
          // flashes into a white blob: repeats within 0.25 s draw only a ring and sparks.
          const rec = this._expRecent || (this._expRecent = []);
          let repeat = false;
          for (let k = rec.length - 1; k >= 0; k--) {
            const q = rec[k];
            if (this.time - q.t > 0.25) { rec.splice(k, 1); continue; }
            const dx = q.x - e.x, dy = q.y - e.y, rr = Math.max(q.r, r) * 0.6;
            if (dx * dx + dy * dy < rr * rr) { repeat = true; break; }
          }
          if (repeat) {
            const pal = EXPLOSION_COLORS[e.dtype] || EXPLOSION_COLORS.BLAST;
            pt.ring(e.x, e.y, r * 0.3, r, 0.25, pal.ring, Math.max(2, r * 0.06), 0.6, true);
            pt.sparks(e.x, e.y, pal.spark, 3, 160 + r * 2, 6, 0.25);
            break;
          }
          rec.push({ x: e.x, y: e.y, r, t: this.time });
          if (rec.length > 32) rec.shift();
          pt.explosion(e.x, e.y, r, e.dtype || 'BLAST');
          if (r >= 70) this.shake(Math.min(0.35, r / 500));
          break;
        }
        case 'zap': this._addZap(e.points, e.color, e.width || ZAP_WIDTH[e.visual] || 1); break;
        case 'freeze': {
          const r = e.r || 80;
          pt.ring(e.x, e.y, r * 0.15, r, 0.45, '#dff8ff', 4, 0.95, true);
          pt.glow(e.x, e.y, r * 0.9, '#8fe9ff', 0.3, 0.35, 1.15);
          pt.snow(e.x, e.y, r * 0.8, 10);
          break;
        }
        case 'shot': {
          if (shots++ > 90) break;
          this._onShot(e);
          break;
        }
        case 'leak': {
          this.coreHurt = 1;
          const lives = sim && sim.state ? sim.state.maxLives || 100 : 100;
          const bump = e.titan ? 1 : 0.3 + Math.min(0.5, ((e.mass || 1) / Math.max(10, lives)) * 3);
          this.leakFlash = Math.min(0.9, Math.max(this.leakFlash, bump));
          // Throttle the core burst so a stream of leaks reads as an alarm, not a white-out.
          const c = this.map && this.map.core;
          if (c && this.time - (this._leakFxT || -1) > 0.25) {
            this._leakFxT = this.time;
            pt.glow(c.x, c.y, CORE_R * 1.8, '#ff3b4d', 0.35, 0.7, 1.3);
            pt.ring(c.x, c.y, CORE_R * 0.5, CORE_R * 2.4, 0.5, '#ff5d6d', 5, 1, true);
            pt.sparks(c.x, c.y, '#ff8a8a', 8, 260, 9, 0.35);
            this.shake(0.25);
          }
          break;
        }
        case 'cash': {
          if (!floatText) break;
          if (!Number.isFinite(e.x) || !Number.isFinite(e.y)) break;
          const reason = String(e.reason || '');
          if (/pop|bounty|kill|shell/.test(reason)) break;
          this._cashText(e.x, e.y, e.amount || 0, reason);
          break;
        }
        case 'waveStart': {
          for (const p of this.portals) {
            pt.ring(p.x, p.y, 20, 110, 0.6, '#d8b0ff', 5, 0.9, true);
            pt.glow(p.x, p.y, 90, '#b86bff', 0.45, 0.7, 1.3);
          }
          break;
        }
        case 'waveCleared': {
          const c = this.map && this.map.core;
          if (c) {
            pt.ring(c.x, c.y, CORE_R * 0.6, CORE_R * 3, 0.8, '#9ff4ff', 5, 0.9, true);
            pt.stars(c.x, c.y, 10, '#9ff4ff', 140, 6);
          }
          break;
        }
        case 'titan': {
          for (const p of this.portals) {
            pt.ring(p.x, p.y, 30, 220, 0.9, '#ff5d6d', 8, 1, true);
            pt.glow(p.x, p.y, 160, '#ff3b4d', 0.6, 0.8, 1.4);
          }
          this.shake(0.5);
          break;
        }
        case 'titanDown': {
          const x = e.x, y = e.y;
          if (!Number.isFinite(x)) break;
          pt.glow(x, y, 260, '#ffffff', 0.35, 1, 1.5);
          pt.glow(x, y, 180, '#ffb347', 0.6, 0.9, 1.6);
          pt.ring(x, y, 30, 320, 0.8, '#ffe0a0', 10, 1, true);
          pt.ring(x, y, 20, 220, 0.6, '#ffffff', 6, 1, true);
          pt.ring(x, y, 10, 420, 1.1, '#ff8a3d', 5, 0.7, true);
          pt.chunks(x, y, '#6a5a70', 30, 380, 16);
          pt.shatter(x, y, ['#c77dff', '#ffb347', '#6ee7ff', '#ffffff'], 40, 420, 9);
          pt.embers(x, y, 30, 320);
          pt.sparks(x, y, '#fff2c4', 24, 520, 16, 0.5);
          for (let s = 0; s < 8; s++) pt.smoke(x + (Math.random() - 0.5) * 120, y + (Math.random() - 0.5) * 80, 60, 1.6, '#4a4550', 0, -14, 0.6);
          this.whiteFlash = 0.85;
          this.shake(1);
          break;
        }
        case 'pulse': {
          if (events[i + 1] && events[i + 1].t === 'freeze') break; // the frost ring covers it
          if (!Number.isFinite(e.x)) break;
          const r = e.r || 60;
          const col = e.color || DTYPE_COLORS[e.dtype] || '#bff4ff';
          switch (e.visual) {
            case 'fire': {
              // burning ground: a low orange glow with embers and licks of smoke, no thin ring
              if (pulses++ > 24) break;
              // overlapping patches on one spot keep their embers but share one glow
              const fr = this._fireRecent || (this._fireRecent = []);
              let lit = false;
              for (let k = fr.length - 1; k >= 0; k--) {
                const q = fr[k];
                if (this.time - q.t > 0.6) { fr.splice(k, 1); continue; }
                const dx = q.x - e.x, dy = q.y - e.y;
                if (dx * dx + dy * dy < r * r * 0.36) { lit = true; break; }
              }
              if (!lit) {
                fr.push({ x: e.x, y: e.y, t: this.time });
                if (fr.length > 24) fr.shift();
                pt.glow(e.x, e.y, r * 1.1, '#ff6a1a', 0.8, 0.24, 1.05);
                pt.glow(e.x, e.y, r * 0.6, '#ffc36a', 0.55, 0.2, 1.1);
              }
              pt.embers(e.x, e.y, Math.max(3, Math.round(r / 14)), 70, '#ffb347');
              if (Math.random() < 0.6) pt.smoke(e.x + (Math.random() - 0.5) * r, e.y + (Math.random() - 0.5) * r * 0.6, r * 0.25, 0.9, '#4a3a36', 0, -18, 0.35);
              break;
            }
            case 'implode': {
              pt.ring(e.x, e.y, r, r * 0.12, 0.4, col, 4, 0.95, true);
              pt.glow(e.x, e.y, r * 0.5, col, 0.3, 0.45, 0.6);
              break;
            }
            case 'surge': {
              pt.ring(e.x, e.y, r, r * 0.2, 0.55, '#4de8e0', 6, 0.9, true);
              pt.ring(e.x, e.y, r * 0.8, r * 0.1, 0.45, '#b8fff9', 2.5, 0.8, true);
              break;
            }
            case 'blackhole': {
              // the black hole itself is drawn as a persistent ground effect; add inward sparks
              pt.ring(e.x, e.y, r * 1.6, r * 0.3, 0.3, '#9b5cff', 2, 0.6, true);
              break;
            }
            case 'radar': {
              pt.ring(e.x, e.y, r * 0.1, r, 0.5, '#7dfcff', 2, 0.55, true);
              break;
            }
            case 'refinery': {
              pt.ring(e.x, e.y, r * 0.4, r, 0.45, '#ffd76a', 2.5, 0.8, true);
              pt.stars(e.x, e.y, 3, '#ffe28a', 70, 4);
              break;
            }
            default:
              pt.ring(e.x, e.y, r * 0.2, r, 0.35, col, 3, 0.8, true);
              pt.glow(e.x, e.y, r * 0.8, col, 0.22, 0.25, 1.15);
          }
          break;
        }
        case 'abilityFx': {
          if (!Number.isFinite(e.x)) break;
          const r = e.r || 160;
          const id = String(e.id || '').replace(/\d+$/, '');
          const col = ABILITY_FX_COLORS[id] || '#ffe28a';
          if (id === 'blackhole') {
            this.persist.push({ kind: 'blackhole', x: e.x, y: e.y, r, life: 3.1, max: 3.1, seed: Math.random() * 6 });
            pt.glow(e.x, e.y, r * 1.2, '#7b2cff', 0.6, 0.7, 0.4);
            this.shake(0.25);
            break;
          }
          pt.ring(e.x, e.y, 10, r, 0.8, col, 6, 1, true);
          pt.ring(e.x, e.y, 10, r * 0.6, 0.6, '#ffffff', 3, 0.8, true);
          pt.glow(e.x, e.y, Math.min(260, r * 0.7), col, 0.45, 0.6, 1.3);
          pt.stars(e.x, e.y, 16, col, 240, 7);
          this.shake(0.15);
          break;
        }
        case 'titanBlink': {
          if (Number.isFinite(e.x0)) {
            pt.glow(e.x0, e.y0, 150, '#d06bff', 0.4, 0.8, 0.6);
            pt.ring(e.x0, e.y0, 120, 10, 0.4, '#e8a8ff', 6, 1, true);
          }
          if (Number.isFinite(e.x)) {
            pt.glow(e.x, e.y, 200, '#d06bff', 0.5, 0.9, 1.4);
            pt.ring(e.x, e.y, 20, e.r || 150, 0.6, '#f0c8ff', 7, 1, true);
            pt.sparks(e.x, e.y, '#f0c8ff', 16, 380, 12, 0.4);
          }
          this.shake(0.45);
          break;
        }
        case 'shieldBreak': {
          if (!Number.isFinite(e.x)) break;
          pt.ring(e.x, e.y, 60, 190, 0.5, '#9ff8ff', 7, 1, true);
          pt.shatter(e.x, e.y, ['#9ff8ff', '#e8ffff', '#5fd4ff'], 26, 320, 7);
          pt.glow(e.x, e.y, 180, '#7ff4ff', 0.3, 0.8, 1.3);
          this.shake(0.3);
          break;
        }
        case 'shieldUp': {
          if (!Number.isFinite(e.x)) break;
          pt.ring(e.x, e.y, 200, 100, 0.5, '#9ff8ff', 5, 1, true);
          break;
        }
        case 'titanSpit': {
          if (!Number.isFinite(e.x)) break;
          pt.glow(e.x, e.y, 110, '#ff7a2a', 0.3, 0.8, 1.3);
          pt.embers(e.x, e.y, 10, 180);
          break;
        }
        case 'regrow': {
          if (!Number.isFinite(e.x)) break;
          if (hits++ > 50) break;
          pt.ring(e.x, e.y, 4, 22, 0.3, '#4dff9a', 2.5, 0.9, true);
          break;
        }
        case 'crit': {
          if (!Number.isFinite(e.x)) break;
          if (hits++ > 50) break;
          pt.stars(e.x, e.y, 2, '#fff27a', 140, 6);
          pt.glow(e.x, e.y, 22, '#fff27a', 0.12, 0.8, 1.4);
          break;
        }
        case 'heroLevel': {
          const tp = this._towerPos(e.tower);
          const x = tp ? tp.x : e.x, y = tp ? tp.y : e.y;
          if (!Number.isFinite(x)) break;
          pt.ring(x, y, 10, 90, 0.7, '#ffe28a', 5, 1, true);
          pt.stars(x, y, 16, '#ffe28a', 180, 7);
          pt.glow(x, y, 80, '#ffd76a', 0.4, 0.8, 1.3);
          if (floatText) pt.text(x, y - 36, 'LEVEL ' + (e.level || ''), '#ffe28a', 14, 1.3);
          break;
        }
        case 'vault': {
          if (!floatText || !Number.isFinite(e.x) || !(e.amount > 0)) break;
          // sits above the rig's own payout text (a full vault pays the overflow as cash)
          this._cashText(e.x, e.y - 44, e.amount, 'vault');
          break;
        }
        case 'ability': {
          const x = Number.isFinite(e.x) ? e.x : this._towerPos(e.tower)?.x;
          const y = Number.isFinite(e.y) ? e.y : this._towerPos(e.tower)?.y;
          if (!Number.isFinite(x)) break;
          pt.ring(x, y, 10, 160, 0.7, '#ffe28a', 6, 1, true);
          pt.glow(x, y, 120, '#ffd76a', 0.4, 0.7, 1.4);
          pt.stars(x, y, 14, '#ffe28a', 200, 7);
          break;
        }
        case 'upgrade': {
          const tp = this._towerPos(e.tower);
          if (!tp) break;
          const col = P.PATH_COLORS[e.path | 0] || '#ffe28a';
          pt.ring(tp.x, tp.y, tp.r * 0.6, tp.r * 2.2, 0.5, col, 4, 1, true);
          pt.stars(tp.x, tp.y, 10, col, 130, 6);
          pt.glow(tp.x, tp.y, tp.r * 2, col, 0.3, 0.6, 1.3);
          break;
        }
        case 'place': {
          const tp = this._towerPos(e.tower);
          const x = tp ? tp.x : e.x, y = tp ? tp.y : e.y;
          if (!Number.isFinite(x)) break;
          const r = tp ? tp.r : 22;
          pt.ring(x, y, r * 0.8, r * 2.0, 0.4, '#e8eef7', 3, 0.8);
          for (let s = 0; s < 4; s++) pt.smoke(x + (Math.random() - 0.5) * r * 2, y + r * 0.4, r * 0.5, 0.6, '#9aa0ae', (Math.random() - 0.5) * 40, -8, 0.45);
          break;
        }
        case 'sell': {
          const tp = this._towerPos(e.tower);
          const x = tp ? tp.x : e.x, y = tp ? tp.y : e.y;
          if (!Number.isFinite(x)) break;
          pt.stars(x, y, 12, '#ffe66d', 160, 6);
          for (let s = 0; s < 4; s++) pt.smoke(x + (Math.random() - 0.5) * 30, y, 16, 0.7, '#9aa0ae', 0, -14, 0.5);
          if (floatText && Number.isFinite(e.value)) this._cashText(x, y - 10, e.value, 'sell');
          break;
        }
        default: break;
      }
    }
  }

  shake(amount) {
    if (this.settings.shake === false) return;
    this.camera.addTrauma(amount);
  }

  // ------------------------------------------------------------------------
  // Frame
  // ------------------------------------------------------------------------

  render(sim, frameDt = 1 / 60, ui = {}) {
    const t0 = (typeof performance !== 'undefined') ? performance.now() : 0;
    ui = ui || {};
    const dt = Math.max(0, Math.min(0.1, frameDt || 0));
    const rn = rnow();
    this._rdt = this._rlast ? Math.max(0, Math.min(0.1, rn - this._rlast)) : 0;
    this._rlast = rn;
    this.time += dt;
    this.frame++;
    if (ui.settings) {
      const s = ui.settings;
      if (s.particles !== undefined) this.settings.particles = qualityOf(s.particles);
      if (s.shake !== undefined) this.settings.shake = s.shake !== false && s.shake !== 0;
      const ft = s.floatText ?? s.cashText ?? s.floatingText ?? s.damageNumbers;
      if (ft !== undefined) this.settings.floatText = ft !== false && ft !== 0;
      if (s.reducedMotion !== undefined) this.settings.reducedMotion = !!s.reducedMotion;
      if (this.settings.reducedMotion) this.settings.shake = false;
    }
    // Particle pool shrinks with on-field density (a screen with 1500 meteors is already busy)
    // and with the load governor level.
    const load = sim && sim.state ? (sim.state.enemies.length + sim.state.projectiles.length) : 0;
    const density = load > 600 ? Math.max(0.4, 1 - (load - 600) / 2600) : 1;
    this.particles.setQuality(this.settings.particles, GOV_PARTICLES[this.governor] * density);

    if (sim && (sim !== this.sim || (sim.map && sim.map !== this.map))) this.setMap(sim);
    const st = sim && sim.state;

    // Sim-time delta drives effects so they freeze on pause and speed up at 2x/3x.
    let simDt = dt;
    if (st && Number.isFinite(st.time)) {
      if (this.lastSimTime !== null) simDt = Math.max(0, Math.min(0.3, st.time - this.lastSimTime));
      this.lastSimTime = st.time;
    }
    this.simDt = simDt;
    this.simT = st && Number.isFinite(st.time) ? st.time : this.time;

    // Camera and caches
    const cam = this.camera;
    const dprNow = Math.min(2, Math.max(1, (typeof window !== 'undefined' && window.devicePixelRatio) || 1));
    if (this._needsSync || !this._ro || dprNow !== cam.dpr) {
      this._needsSync = false;
      if (cam.sync()) { this.staticDirty = true; this.staticDirtyAt = rnow(); }
    }
    // Sprite density follows the camera, but holds still while a zoom gesture is in flight
    // (sprites just scale until it settles) and stops growing where the art runs out of
    // pixels, so zooming never re-rasterizes every sprite per frame.
    const nowMs = (typeof performance !== 'undefined') ? performance.now() : 0;
    const zooming = nowMs - cam.zoomedAt < ZOOM_SETTLE_MS;
    if (!zooming || !this._kWant) this._kWant = Math.min(cam.k, SPRITE_K_MAX);
    // The static layer (terrain + channel) is rebuilt at the new zoom once the gesture settles.
    if (this.static && !zooming && Math.abs(this._staticK() - this.static.k) > 0.01 * this.static.k) {
      if (!this.staticDirty) { this.staticDirty = true; this.staticDirtyAt = -1; }
    }
    const kq = this.cache.setK(this._kWant);
    // Pack sprites created last frame into the atlas before anything draws this frame.
    this.cache.flush();
    if (kq !== this._sprK) { this._sprK = kq; this._mSpr.clear(); this._pjSpr.clear(); this._rotSpr.clear(); }
    if ((this.assets.version || 0) !== this.assetVersion) {
      this.assetVersion = this.assets.version || 0;
      this.cache.clear(); this._mSpr.clear(); this._pjSpr.clear(); this._rotSpr.clear();
      if (this._timg) this._timg.clear();
      if (this._tart) this._tart.clear();
      if (this._eimg) this._eimg.clear();
      this.staticDirty = true; this.staticDirtyAt = -1;
    }
    // Debounced on real time (a resize while paused still settles).
    if (this.staticDirty && (!this.static || rnow() - this.staticDirtyAt > 0.12)) this._rebuildStatic();

    // Lives tracking for the core flicker
    if (st) {
      if (this.lastLives !== null && st.lives < this.lastLives) this.coreHurt = 1;
      this.lastLives = st.lives;
    }
    this.coreHurt = Math.max(0, this.coreHurt - dt * 1.2);
    this.leakFlash = Math.max(0, this.leakFlash - dt * 1.8);
    this.whiteFlash = Math.max(0, this.whiteFlash - dt * 1.6);
    cam.updateShake(dt, this.settings.shake, this.time);
    this._ambient(simDt);
    this.particles.update(simDt);
    this._updateFx(simDt);
    this._updateSnapshots(st);
    this.enemyById = null;

    const ctx = this.ctx;
    this.k = cam.k; this.ox = cam.ox + cam.shakeX; this.oy = cam.oy + cam.shakeY;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    this._tfWorld = false;
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.imageSmoothingEnabled = true;

    const prof = this.profile ? (this.stats.layers = {}) : null;
    let tp = prof ? performance.now() : 0;
    const mark = prof ? (name) => { const n = performance.now(); prof[name] = +(n - tp).toFixed(2); tp = n; } : null;
    this._drawBackground(ctx);
    if (!st) { this.stats.drawMs = 0; return; }
    if (mark) mark('background');
    this._drawChevrons(ctx);
    this._drawPortals(ctx);
    this._drawCore(ctx, st);
    this._drawNoBuild(ctx, st, ui);
    this._drawRanges(ctx, st, ui);
    if (mark) mark('channelCore');
    this._drawTowers(ctx, st, ui);
    this._drawGroundFx(ctx, st, ui);
    if (mark) mark('towers');
    const bars = this._drawEnemies(ctx, st);
    if (mark) mark('enemies');
    this._drawDrones(ctx, st);
    this._drawProjectiles(ctx, st);
    if (mark) mark('projectiles');
    this._drawBeams(ctx, st);
    this._drawZaps(ctx);
    if (mark) mark('beamsZaps');
    this.particles.draw(ctx, cam, this.cache);
    this._tfWorld = false;
    if (mark) mark('particles');
    this._drawBars(ctx, bars);
    if (this.settings.floatText) { this.particles.drawTexts(ctx, cam); this._tfWorld = false; }
    this._drawGhost(ctx, st, ui);
    this._drawScreenFx(ctx, st);
    if (mark) mark('overlays');

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    this.stats.particles = this.particles.n;
    this.stats.drawMs = ((typeof performance !== 'undefined') ? performance.now() : 0) - t0;
    this._govern(this.stats.drawMs);
  }

  // Load governor: when drawing gets expensive (weak GPU, huge waves), thin particles and
  // drop projectile glows; restore them when there is headroom again.
  _govern(ms) {
    if (!this.autoQuality) { this.governor = 0; return; }
    if (!(ms >= 0) || ms > 250) return;
    this._ema = this._ema === undefined ? ms : this._ema * 0.92 + ms * 0.08;
    this._govT = (this._govT || 0) + 1;
    if (this._govT < 45) return;
    const g = this.governor;
    if (g < 2 && this._ema > GOV_UP[g]) { this.governor = g + 1; this._govT = 0; }
    else if (g > 0 && this._ema < GOV_DOWN[g - 1]) { this.governor = g - 1; this._govT = 0; }
    this.stats.governor = this.governor;
  }

  // ------------------------------------------------------------------------
  // Internals: setup
  // ------------------------------------------------------------------------

  _computeShared() {
    this.shared = this.lanes.map(() => null);
    for (let j = 1; j < this.lanes.length; j++) {
      const L = this.lanes[j];
      const flags = new Uint8Array(L.n);
      for (let i = 0; i < L.n; i += 4) {
        const x = L.xs[i], y = L.ys[i];
        let near = false;
        for (let q = 0; q < j && !near; q++) {
          const M = this.lanes[q];
          for (let s = 0; s < M.n; s += 3) {
            const dx = M.xs[s] - x, dy = M.ys[s] - y;
            if (dx * dx + dy * dy < 64) { near = true; break; }
          }
        }
        if (near) for (let z = i; z < Math.min(L.n, i + 4); z++) flags[z] = 1;
      }
      this.shared[j] = flags;
    }
  }

  // The static layer covers the whole zoom-1 view (plus a shake margin), so panning never
  // rebuilds it. Its density matches the camera, capped by a pixel budget when zoomed in.
  _staticFrame() {
    const cam = this.camera;
    const f = cam.fitView, m = 24 / Math.max(1e-6, cam.fitScale);
    return { x0: f.x0 - m, y0: f.y0 - m, x1: f.x1 + m, y1: f.y1 + m };
  }

  _staticK() {
    const cam = this.camera;
    if (!cam.zoomed) return cam.k;
    const r = this._staticFrame();
    const fitK = cam.fitScale * cam.dpr;
    // Phones get a smaller budget (canvas memory is tight there).
    const budget = cam.cssW * cam.cssH < 700000 ? STATIC_BUDGET_SMALL : STATIC_BUDGET;
    return Math.max(fitK, Math.min(cam.k, Math.sqrt(budget / ((r.x1 - r.x0) * (r.y1 - r.y0)))));
  }

  _rebuildStatic() {
    this.staticDirty = false;
    const cam = this.camera;
    if (!cam.w || !cam.h) return;
    const pad = ((this.map && this.map.pathWidth) || 56) * 0.9;
    this.portals = placePortals(this.lanes, cam.fitView, pad);
    const frame = { ...this._staticFrame(), k: this._staticK(), dpr: cam.dpr };
    try {
      const s = buildStaticLayer({ map: this.map, lanes: this.lanes, frame, assets: this.assets, portals: this.portals });
      if (this.static && this.static.canvas && this.static.canvas !== s.canvas) { this.static.canvas.width = 1; this.static.canvas.height = 1; }
      this.static = s;
      this._noBuild = null;
    } catch (err) {
      console.error('static layer failed', err);
      this.static = null;
    }
  }

  _updateSnapshots(st) {
    if (!st || !st.towers) return;
    const snap = this.towerSnap;
    const f = this.frame;
    for (const t of st.towers) {
      let s = snap.get(t.id);
      if (!s) { s = { x: t.x, y: t.y, r: t.radius || 22, type: t.type, seen: f }; snap.set(t.id, s); }
      s.x = t.x; s.y = t.y; s.r = t.radius || (t.def && t.def.radius) || 22; s.type = t.type; s.seen = f; s.t = t;
    }
    if (f % 120 === 0) for (const [id, s] of snap) if (f - s.seen > 600) snap.delete(id);
  }

  _towerPos(id) {
    const s = this.towerSnap.get(id);
    if (s) return s;
    const st = this.sim && this.sim.state;
    if (st && st.towers) for (const t of st.towers) if (t.id === id) return { x: t.x, y: t.y, r: t.radius || 22, t };
    return null;
  }

  _enemy(id) {
    if (!this.enemyById) {
      this.enemyById = new Map();
      const st = this.sim && this.sim.state;
      if (st && st.enemies) for (const e of st.enemies) if (!e.dead) this.enemyById.set(e.id, e);
    }
    return this.enemyById.get(id);
  }

  towerDef(type) {
    if (!type) return null;
    const td = this._defs.towers || TOWER_DEFS;
    const hd = this._defs.heroes || HERO_DEFS;
    return (td && td[type]) || (hd && hd[type]) || null;
  }

  // ------------------------------------------------------------------------
  // Internals: effects bookkeeping
  // ------------------------------------------------------------------------

  _onShot(e) {
    const pt = this.particles;
    const tp = this._towerPos(e.tower);
    const ang = Number.isFinite(e.angle) ? e.angle : (tp && tp.t ? tp.t.angle || 0 : 0);
    const r = tp ? tp.r : 20;
    const bx = Number.isFinite(e.x) ? e.x : tp ? tp.x : NaN;
    const by = Number.isFinite(e.y) ? e.y : tp ? tp.y : NaN;
    if (!Number.isFinite(bx)) return;
    // If the event is at the tower center, move the flash to the muzzle.
    let mx = bx, my = by;
    if (tp && Math.hypot(bx - tp.x, by - tp.y) < r * 0.8) { mx = tp.x + Math.cos(ang) * r * 1.35; my = tp.y + Math.sin(ang) * r * 1.35; }
    const col = DTYPE_COLORS[e.dtype] || '#fff2c4';
    if (e.tower != null && !e.drone) this.recoil.set(e.tower, 1);
    const raw = e.visual || '';
    const vis = P.resolveVisual(raw);
    const hitscan = Number.isFinite(e.x2) || HITSCAN_VISUALS.has(raw);
    if (vis !== 'flame' && vis !== 'cryo') pt.glow(mx, my, e.drone ? 8 : r * 0.55, col, 0.07, 0.9, 1.1);
    if (hitscan) {
      // Tracer to the hit point (x2, y2), else the tower's target, else a long ray.
      let tx = mx + Math.cos(ang) * 900, ty = my + Math.sin(ang) * 900;
      if (Number.isFinite(e.x2)) { tx = e.x2; ty = e.y2; }
      else {
        const tw = tp && tp.t;
        const target = tw && tw.target != null ? this._enemy(tw.target) : null;
        if (target) { tx = target.x; ty = target.y; }
      }
      const tc = e.dtype === 'VOID' ? '#d9a6ff' : e.dtype === 'ENERGY' ? '#9ff4ff' : '#fff2c4';
      this.tracers.push({ x1: mx, y1: my, x2: tx, y2: ty, life: 0.16, max: 0.16, color: tc, w: e.drone ? 1.8 : 3 });
      if (this.tracers.length > 60) this.tracers.shift();
      pt.sparkCone(mx, my, ang, 0.6, '#fff2c4', 4, 320, 8);
      pt.sparks(tx, ty, '#fff2c4', 3, 200, 6, 0.16);
    } else if (vis === 'shell') {
      for (let s = 0; s < 2; s++) pt.smoke(mx, my, 10, 0.6, '#8a8f9c', Math.cos(ang) * 30, Math.sin(ang) * 30, 0.6);
    } else if (vis === 'missile') {
      pt.smoke(mx, my, 9, 0.5, '#9aa0ae', 0, -10, 0.6);
    } else if (vis !== 'flame') {
      pt.sparkCone(mx, my, ang, 0.5, col, 2, 240, 6);
    }
  }

  _addZap(points, color, width = 1) {
    if (!Array.isArray(points) || points.length < 2) return;
    const jag = (pts) => {
      const out = [];
      for (let i = 0; i < pts.length - 1; i++) {
        const [x1, y1] = pts[i], [x2, y2] = pts[i + 1];
        const dx = x2 - x1, dy = y2 - y1;
        const len = Math.hypot(dx, dy) || 1;
        const nx = -dy / len, ny = dx / len;
        const segs = Math.max(2, Math.round(len / 16));
        if (i === 0) out.push(x1, y1);
        for (let s = 1; s < segs; s++) {
          const t = s / segs;
          const j = (Math.random() - 0.5) * Math.min(18, len * 0.25);
          out.push(x1 + dx * t + nx * j, y1 + dy * t + ny * j);
        }
        out.push(x2, y2);
      }
      return out;
    };
    const pts = points.map((p) => (Array.isArray(p) ? p : [p.x, p.y]));
    const life = width >= 2 ? 0.34 : 0.22;
    this.zaps.push({ a: jag(pts), b: jag(pts), nodes: pts, life, max: life, color: color || '#9ff4ff', w: width });
    if (this.zaps.length > 90) this.zaps.shift();
    const last = pts[pts.length - 1];
    this.particles.sparks(last[0], last[1], '#bff8ff', 2, 160, 5, 0.14);
  }

  // Ambient map life: volcanic vents smoke and spit embers.
  _ambient(dt) {
    const bl = this.map && this.map.blockers;
    if (!bl || dt <= 0) return;
    for (const b of bl) {
      if (b.kind !== 'vent' && b.kind !== 'geyser' && b.kind !== 'volcano') continue;
      const r = b.r || 40;
      if (Math.random() < dt * 4) this.particles.smoke(b.x + (Math.random() - 0.5) * r * 0.4, b.y - r * 0.1, r * 0.35, 1.8, '#3a3034', (Math.random() - 0.5) * 8, -26, 0.5);
      if (Math.random() < dt * 2.5) this.particles.embers(b.x, b.y, 1, 70, '#ffb347');
    }
  }

  _cashText(x, y, amount, reason) {
    const texts = this.particles.texts;
    for (const t of texts) {
      if (t.reason === reason && t.life > t.max * 0.6 && Math.abs(t.x - x) < 40 && Math.abs(t.y - y) < 40) {
        t.amount += amount;
        t.text = '+' + fmtCash(t.amount);
        return;
      }
    }
    if (Math.abs(amount) < 0.5 && !/sell|rig|supply|vault|bonus|wave/.test(reason)) return;
    this.particles.text(x, y - 16, '+' + fmtCash(amount), '#ffe66d', 15, 1.1);
    const tt = texts[texts.length - 1];
    tt.amount = amount; tt.reason = reason;
  }

  _updateFx(dt) {
    for (let i = this.persist.length - 1; i >= 0; i--) {
      const f = this.persist[i];
      f.life -= dt;
      if (f.life <= 0) this.persist.splice(i, 1);
    }
    for (let i = this.zaps.length - 1; i >= 0; i--) {
      const z = this.zaps[i];
      z.life -= dt;
      if (z.life <= 0) this.zaps.splice(i, 1);
    }
    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const z = this.tracers[i];
      z.life -= dt;
      if (z.life <= 0) this.tracers.splice(i, 1);
    }
    for (const [id, v] of this.recoil) {
      const nv = v - dt * 9;
      if (nv <= 0) this.recoil.delete(id); else this.recoil.set(id, nv);
    }
  }

  // ------------------------------------------------------------------------
  // Internals: drawing helpers
  // ------------------------------------------------------------------------

  // Draw sprite s centered (anchor) at world x,y with rotation and uniform scale.
  // Unrotated draws reuse the world transform (no per-draw setTransform): Chrome's canvas
  // gets much slower per call once a frame records a few thousand transform changes.
  _spr(ctx, s, x, y, rot = 0, scale = 1) {
    if (rot === 0) {
      if (!this._tfWorld) { ctx.setTransform(this.k, 0, 0, this.k, this.ox, this.oy); this._tfWorld = true; }
      if (scale === 1) ctx.drawImage(s.c, s.sx, s.sy, s.sw, s.sh, x - s.ax, y - s.ay, s.w, s.h);
      else ctx.drawImage(s.c, s.sx, s.sy, s.sw, s.sh, x - s.ax * scale, y - s.ay * scale, s.w * scale, s.h * scale);
      return;
    }
    const k = this.k * scale;
    const c = Math.cos(rot) * k, sn = Math.sin(rot) * k;
    ctx.setTransform(c, sn, -sn, c, this.ox + x * this.k, this.oy + y * this.k);
    this._tfWorld = false;
    ctx.drawImage(s.c, s.sx, s.sy, s.sw, s.sh, -s.ax, -s.ay, s.w, s.h);
  }

  _world(ctx) { ctx.setTransform(this.k, 0, 0, this.k, this.ox, this.oy); this._tfWorld = true; }

  // Sprite pre-rotated to frame f of n (angle f * TAU / n), in a square box of half-size ext.
  _rot(key, n, f, ext, draw) {
    let arr = this._rotSpr.get(key);
    if (!arr) { arr = new Array(n); this._rotSpr.set(key, arr); }
    let s = arr[f];
    if (!s) {
      s = this.cache.get('rot|' + key + '|' + n + '|' + f, ext * 2, ext * 2, (g) => { g.rotate((f * TAU) / n); draw(g); });
      arr[f] = s;
    }
    return s;
  }

  _glowSprite(color, size = 32) {
    const c = P.glowColor(color);
    return this.cache.get('glow|' + c + '|' + size, size * 2, size * 2, (g) => P.drawGlow(g, size, c, 0, 1));
  }

  // ------------------------------------------------------------------------
  // Layers
  // ------------------------------------------------------------------------

  _drawBackground(ctx) {
    const cam = this.camera;
    const s = this.static;
    if (!s) {
      const pal = (this.map && this.map.palette) || {};
      ctx.fillStyle = pal.ground2 || '#2a303e';
      ctx.fillRect(0, 0, cam.w, cam.h);
      return;
    }
    // Layer pixel = s.ox + x * s.k; screen pixel = cam.ox + shake + x * cam.k.
    const f = cam.k / s.k;
    const tx = cam.ox + cam.shakeX - s.ox * f, ty = cam.oy + cam.shakeY - s.oy * f;
    const cw = s.canvas.width, ch = s.canvas.height;
    if (Math.abs(f - 1) < 1e-6) {
      const ix = Math.round(tx), iy = Math.round(ty);
      if (ix > 0 || iy > 0 || ix + cw < cam.w || iy + ch < cam.h) this._fillGround(ctx);
      ctx.drawImage(s.canvas, ix, iy);
    } else {
      // Zoomed (or a stale layer during a resize or zoom gesture): blit only the visible part.
      const sx0 = Math.max(0, -tx / f), sy0 = Math.max(0, -ty / f);
      const sx1 = Math.min(cw, (cam.w - tx) / f), sy1 = Math.min(ch, (cam.h - ty) / f);
      if (sx0 > 0.5 || sy0 > 0.5 || tx + cw * f < cam.w - 0.5 || ty + ch * f < cam.h - 0.5) this._fillGround(ctx);
      if (sx1 > sx0 && sy1 > sy0) ctx.drawImage(s.canvas, sx0, sy0, sx1 - sx0, sy1 - sy0, tx + sx0 * f, ty + sy0 * f, (sx1 - sx0) * f, (sy1 - sy0) * f);
    }
    // Screen vignette (a small cached gradient stretched over the canvas).
    const vg = this._vignette || (this._vignette = makeVignette());
    ctx.drawImage(vg, 0, 0, cam.w, cam.h);
  }

  _fillGround(ctx) {
    const pal = (this.map && this.map.palette) || {};
    ctx.fillStyle = pal.ground2 || '#2a303e';
    ctx.fillRect(0, 0, this.camera.w, this.camera.h);
  }

  _drawChevrons(ctx) {
    if (!this.lanes.length) return;
    const pal = (this.map && this.map.palette) || {};
    const edge = pal.edge || '#6ee7ff';
    const chevDraw = (g) => P.drawChevron(g, 9, edge);
    const t = this.time;
    const spacing = 58;
    const speed = 46;
    const off = (t * speed) % spacing;
    const p = this._pt;
    const v = this.camera.view;
    ctx.globalCompositeOperation = 'lighter';
    for (let li = 0; li < this.lanes.length; li++) {
      const L = this.lanes[li];
      const shared = this.shared[li];
      const end = L.length - 34;
      for (let s = L.start + off; s < end; s += spacing) {
        if (shared && shared[Math.min(L.n - 1, Math.round(s / L.step))]) continue;
        L.point(s, p);
        if (p.x < v.x0 - 20 || p.x > v.x1 + 20 || p.y < v.y0 - 20 || p.y > v.y1 + 20) continue;
        const ds = s - L.start, de = end - s;
        let a = Math.min(1, ds / 90, de / 70);
        // A brighter pulse travels down the channel toward the core.
        const wave = 0.5 + 0.5 * Math.sin((s - t * 260) / 150);
        a *= 0.22 + 0.5 * wave * wave;
        if (a <= 0.02) continue;
        ctx.globalAlpha = a;
        this._spr(ctx, this._rot('chev|' + edge, 32, frameOf(p.angle, 32), 11, chevDraw), p.x, p.y);
      }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  _drawPortals(ctx) {
    if (!this.portals.length) return;
    const pal = (this.map && this.map.palette) || {};
    const c1 = pal.portal || '#b86bff';
    const c2 = pal.edge || '#6ee7ff';
    const R = ((this.map && this.map.pathWidth) || 56) * 0.78;
    const swirl = this.cache.get('portal|' + c1 + c2 + R, R * 2.2, R * 2.2, (g) => P.drawPortalSwirl(g, R, c1, c2, 4));
    const swirl2 = this.cache.get('portal2|' + c1 + c2 + R, R * 2.2, R * 2.2, (g) => P.drawPortalSwirl(g, R * 0.7, '#ffffff', c1, 3));
    const glow = this._glowSprite(c1);
    const imgSpec = this.assets.get && this.assets.get('portal');
    const t = this.time;
    for (const p of this.portals) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.55 + 0.15 * Math.sin(t * 2.3);
      this._spr(ctx, glow, p.x, p.y, 0, (R * 1.9) / 32);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      if (imgSpec) {
        const s = imageSprite(this.cache, 'portal', imgSpec, R * 2.4);
        this._spr(ctx, s, p.x, p.y, t * 0.9);
        continue;
      }
      this._spr(ctx, swirl, p.x, p.y, -t * 1.7);
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.8;
      this._spr(ctx, swirl2, p.x, p.y, -t * 2.9 + 1);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      // Rim
      this._world(ctx);
      ctx.beginPath();
      ctx.arc(p.x, p.y, R * 0.98, 0, TAU);
      ctx.lineWidth = 3.2;
      ctx.strokeStyle = P.INK;
      ctx.stroke();
      ctx.lineWidth = 1.8;
      ctx.strokeStyle = P.rgba(c1, 0.9);
      ctx.stroke();
      // Occasional inward sparks
      if (Math.random() < this.simDt * 10) {
        const a = Math.random() * TAU;
        const x = p.x + Math.cos(a) * R * 1.3, y = p.y + Math.sin(a) * R * 1.3;
        const tt = this.particles.type('spark|' + c1, 8, true, (g) => P.drawSparkStreak(g, 8, c1), 16.5, 3.4, 16);
        this.particles.spawn(tt, x, y, -Math.cos(a) * 90, -Math.sin(a) * 90, 0.35, 6, 2, 0, 0, 0, 0, 0.8, 1 | 2);
      }
    }
  }

  _drawCore(ctx, st) {
    const c = this.map && this.map.core;
    if (!c) return;
    const t = this.time;
    const pal = (this.map && this.map.palette) || {};
    const edge = pal.edge || '#6ee7ff';
    const R = CORE_R;
    const low = st.maxLives ? Math.max(0, 1 - st.lives / st.maxLives) : 0;
    const alarm = st.maxLives && st.lives / st.maxLives < 0.3 ? 0.35 + 0.35 * Math.sin(t * 5) : 0;
    const flick = this.coreHurt > 0 ? this.coreHurt * (Math.sin(t * 46) > 0 ? 1 : 0.35) : 0;
    const red = Math.min(1, Math.max(flick, alarm));
    const imgSpec = this.assets.get && this.assets.get('core');
    // Glow
    const pulse = 0.5 + 0.5 * Math.sin(t * 2.6);
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.45 + 0.2 * pulse;
    this._spr(ctx, this._glowSprite(edge), c.x, c.y, 0, (R * 1.7) / 32);
    if (red > 0) {
      ctx.globalAlpha = red * 0.9;
      this._spr(ctx, this._glowSprite('#ff3b4d'), c.x, c.y, 0, (R * 2.1) / 32);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    if (imgSpec) {
      const s = imageSprite(this.cache, 'core', imgSpec, R * 2.2);
      this._spr(ctx, s, c.x, c.y, 0, 1 + 0.02 * pulse);
    } else {
      const ring = this.cache.get('coreRing|' + edge, R * 1.6, R * 1.6, (g) => P.drawCoreRing(g, R, edge));
      const ringRed = this.cache.get('coreRing|#ff5d6d', R * 1.6, R * 1.6, (g) => P.drawCoreRing(g, R, '#ff5d6d'));
      const orb = this.cache.get('coreOrb|' + edge, R, R, (g) => P.drawCoreOrb(g, R, P.mix(edge, '#ffffff', 0.3), P.shade(edge, -0.45)));
      const orbRed = this.cache.get('coreOrb|red', R, R, (g) => P.drawCoreOrb(g, R, '#ff8a8a', '#8a1020'));
      this._spr(ctx, ring, c.x, c.y, t * 0.9);
      if (red > 0) { ctx.globalAlpha = red; this._spr(ctx, ringRed, c.x, c.y, t * 0.9); ctx.globalAlpha = 1; }
      const sc = 1 + 0.06 * pulse - 0.04 * low;
      this._spr(ctx, orb, c.x, c.y, 0, sc);
      if (red > 0) { ctx.globalAlpha = red; this._spr(ctx, orbRed, c.x, c.y, 0, sc); ctx.globalAlpha = 1; }
    }
    // Expanding energy ripple
    const ph = (t * 0.7) % 1;
    this._world(ctx);
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = (1 - ph) * 0.5;
    ctx.beginPath();
    ctx.arc(c.x, c.y, R * (0.4 + ph * 0.9), 0, TAU);
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = red > 0.5 ? '#ff5d6d' : edge;
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  // While placing: shade every spot the tower's center cannot use (the channel, blockers,
  // the Core keep-out, other towers and the edges), expanded by the tower's radius, so the
  // free ground is obvious. Shapes go into one mask so overlaps never double up.
  _drawNoBuild(ctx, st, ui) {
    const pl = ui.placing;
    const target = pl ? 1 : 0;
    this._nbA = (this._nbA || 0) + (target - (this._nbA || 0)) * Math.min(1, (this._rdt || 0.016) * 12);
    if (this._nbA < 0.02 || !this.map) return;
    const def = pl ? (pl.def || this.towerDef(pl.type)) : this._nbDef;
    if (pl) this._nbDef = def;
    const r = (def && def.radius) || 22;
    const cam = this.camera;
    let c = this._nbCanvas;
    if (!c) c = this._nbCanvas = document.createElement('canvas');
    if (c.width !== cam.w || c.height !== cam.h) { c.width = cam.w; c.height = cam.h; }
    const g = c.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = 'source-over';
    g.clearRect(0, 0, cam.w, cam.h);
    g.setTransform(this.k, 0, 0, this.k, this.ox, this.oy);
    g.fillStyle = '#000';
    g.strokeStyle = '#000';
    g.lineCap = 'round';
    g.lineJoin = 'round';
    // Channel
    const pw = ((this.map.pathWidth) || 56) + r * 2;
    g.lineWidth = pw;
    g.beginPath();
    for (const L of this.lanes) {
      g.moveTo(L.xs[0], L.ys[0]);
      for (let i = 2; i < L.n; i += 2) g.lineTo(L.xs[i], L.ys[i]);
      g.lineTo(L.xs[L.n - 1], L.ys[L.n - 1]);
    }
    g.stroke();
    // Blockers, Core, towers
    g.beginPath();
    for (const b of this.map.blockers || []) { g.moveTo(b.x + b.r + r, b.y); g.arc(b.x, b.y, b.r + r, 0, TAU); }
    const core = this.map.core;
    if (core) { g.moveTo(core.x + CORE_KEEPOUT + r, core.y); g.arc(core.x, core.y, CORE_KEEPOUT + r, 0, TAU); }
    for (const t of st.towers) { const rr = (t.radius || 22) + r; g.moveTo(t.x + rr, t.y); g.arc(t.x, t.y, rr, 0, TAU); }
    g.fill();
    // Edges (outside the buildable world rectangle)
    const m = BOUNDS_MARGIN + r, v = cam.view;
    g.beginPath();
    g.rect(v.x0 - 50, v.y0 - 50, v.x1 - v.x0 + 100, v.y1 - v.y0 + 100);
    g.rect(WORLD_W - m, m, -(WORLD_W - m * 2), WORLD_H - m * 2);
    g.fill('evenodd');
    // Tint + hatch through the mask
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = 'source-in';
    g.fillStyle = 'rgba(255,70,90,0.16)';
    g.fillRect(0, 0, cam.w, cam.h);
    g.globalCompositeOperation = 'source-atop';
    const hp = this._hatch || (this._hatch = makeHatch());
    const pat = this._hatchPat || (this._hatchPat = g.createPattern(hp, 'repeat'));
    g.fillStyle = pat;
    g.fillRect(0, 0, cam.w, cam.h);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    this._tfWorld = false;
    ctx.globalAlpha = Math.min(1, this._nbA);
    ctx.drawImage(c, 0, 0);
    ctx.globalAlpha = 1;
  }

  _rangeOf(t, def) {
    const s = t.stats || {};
    let r = s.range;
    if (!Number.isFinite(r) && def && def.base) r = def.base.range;
    return r;
  }

  _drawRanges(ctx, st, ui) {
    const sel = ui.selectedTowerId, hov = ui.hoverTowerId, aim = ui.aimingTowerId;
    const all = !!ui.showAllRanges;
    if (sel == null && hov == null && aim == null && !all) return;
    this._world(ctx);
    for (const t of st.towers) {
      const isSel = t.id === sel, isHov = t.id === hov, isAim = aim != null && t.id === aim;
      if (!isSel && !isHov && !isAim && !all) continue;
      const def = t.def || this.towerDef(t.type);
      const r = this._rangeOf(t, def);
      const strength = isSel ? 1 : isHov ? 0.75 : 0.35;
      if (Number.isFinite(r) && r > 0 && r < 3000) this._ring(ctx, t.x, t.y, r, strength, '#ffffff');
      const aura = t.stats && t.stats.aura;
      if (aura && aura.radius && (isSel || isHov)) this._ring(ctx, t.x, t.y, aura.radius, strength * 0.8, '#ffd76a', true);
      if (isSel) {
        // Selection halo under the tower
        const rr = (t.radius || 22) * (1.25 + 0.06 * Math.sin(this.time * 5));
        ctx.beginPath();
        ctx.arc(t.x, t.y, rr, 0, TAU);
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx.setLineDash([6, 5]);
        ctx.lineDashOffset = -this.time * 20;
        ctx.stroke();
        ctx.setLineDash([]);
      }
      // Mortar aim reticle (selected or in Set Target mode), with a dashed sight line.
      if ((isSel || isAim) && t.aim && Number.isFinite(t.aim.x)) {
        ctx.beginPath();
        ctx.moveTo(t.x, t.y);
        ctx.lineTo(t.aim.x, t.aim.y);
        ctx.setLineDash([4, 8]);
        ctx.lineDashOffset = -this.time * 30;
        ctx.lineWidth = 1.6;
        ctx.strokeStyle = 'rgba(255,93,109,0.55)';
        ctx.stroke();
        ctx.setLineDash([]);
        this._reticle(ctx, t.aim.x, t.aim.y);
      }
    }
  }

  _ring(ctx, x, y, r, strength, color, dashed = false) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.fillStyle = P.rgba(color, 0.07 * strength);
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = P.rgba(color, 0.6 * strength);
    if (dashed) { ctx.setLineDash([8, 6]); ctx.lineDashOffset = this.time * 12; }
    ctx.stroke();
    if (dashed) ctx.setLineDash([]);
  }

  _reticle(ctx, x, y) {
    const t = this.time;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(t * 0.8);
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = '#ff5d6d';
    ctx.beginPath();
    ctx.arc(0, 0, 18, 0, TAU);
    ctx.stroke();
    ctx.beginPath();
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * TAU;
      ctx.moveTo(Math.cos(a) * 10, Math.sin(a) * 10);
      ctx.lineTo(Math.cos(a) * 26, Math.sin(a) * 26);
    }
    ctx.stroke();
    ctx.restore();
  }

  // Manifest key for a tower's art, or null for procedural. Tries art.sprite then tower_<id>,
  // the exact variant first and variant 0 as a fallback.
  _towerImageKey(def, variant, hero) {
    const A = this.assets;
    if (!A || !A.has) return null;
    const ck = def.id + '|' + variant + '|' + (hero ? 1 : 0);
    const cache = this._timg || (this._timg = new Map());
    if (cache.has(ck)) return cache.get(ck);
    let found = null;
    if (hero) {
      for (const k of ['hero_' + def.id, (def.art && def.art.sprite) || '']) if (k && A.has(k)) { found = k; break; }
    } else {
      const prefixes = [];
      if (def.art && def.art.sprite) prefixes.push(def.art.sprite);
      prefixes.push('tower_' + def.id);
      if (SPRITE_ALIAS[def.id]) prefixes.push(SPRITE_ALIAS[def.id]);
      outer: for (const v of variant ? [variant, 0] : [0]) {
        for (const p of prefixes) { const k = p + '_' + v; if (A.has(k)) { found = k; break outer; } }
      }
    }
    cache.set(ck, found);
    return found;
  }

  // Layout of an image tower: drawn size (longest side, world units), anchor, rotation and
  // the cached sprites. Towers are sized by the area of their silhouette so a slim upgrade
  // look (long barrel, thin mast) keeps a base as big as the chunky base model; they turn
  // about the centroid of their thick core so barrels swing and the base stays put.
  // Commanders stand on the footprint by their pedestal and never rotate.
  _towerArt(def, variant, hero) {
    const key = this._towerImageKey(def, variant, hero);
    if (!key) return null;
    const ck = key + '|' + (def.radius || 22) + '|' + (hero ? 1 : 0);
    const cache = this._tart || (this._tart = new Map());
    let a = cache.get(ck);
    if (a && a.k === this._sprK) return a;
    const spec = this.assets.get(key);
    if (!spec) return null;
    const meta = imageMeta(spec);
    const fr = def.radius || 22;
    let size, pivot, rotates;
    if (hero) {
      size = Math.round(Math.max(fr * 3.6, Math.min(fr * 5, (fr * HERO_ART_R) / Math.max(0.12, meta.bodyR))));
      pivot = { x: meta.foot.x, y: meta.foot.y - 0.035 };
      rotates = false;
    } else {
      const want = (fr * TOWER_ART_R) / Math.max(0.12, meta.bodyR);
      size = Math.round(Math.max(fr * 2.6, Math.min(fr * 4.4, want)));
      pivot = meta.pivot;
      rotates = !!spec.rotates && !(def.art && def.art.rotates === false);
    }
    const imgKey = key + '|' + (hero ? 'h' : 't');
    a = {
      k: this._sprK, key, spec, size, pivot, rotates, hero, fr,
      rot0: rotates ? facingOffset(spec.facing) : 0,
      spr: imageSprite(this.cache, imgKey, spec, size, pivot),
      shadow: imageShadow(this.cache, imgKey, spec, size, pivot, hero ? 0.45 : 0.55, 0.035),
    };
    cache.set(ck, a);
    return a;
  }

  _enemyImage(type) {
    const c = this._eimg || (this._eimg = new Map());
    let v = c.get(type);
    if (v === undefined) { v = (this.assets.get && this.assets.get('enemy_' + type)) || null; c.set(type, v); }
    return v;
  }

  // Procedural tower sprites (used when a tower has no image art).
  _towerSprites(def, variant, tier, hero, r) {
    const id = def.id || def.name || 'tower';
    const band = tier >= 5 ? 5 : tier >= 4 ? 4 : tier >= 3 ? 3 : 0;
    const key = id + '|' + variant + '|' + band + '|' + (hero ? 1 : 0) + '|' + r;
    const st = { variant, tier: band, hero };
    const base = this.cache.get('tb|' + key, r * 2.7, r * 2.7, (g) => P.drawTowerBase(g, def, r, st));
    const head = this.cache.get('th|' + key, r * 4.2, r * 4.2, (g) => P.drawTowerHead(g, def, r, st));
    const style = P.headStyle(def);
    const spinner = P.hasSpinner(style) ? this.cache.get('ts|' + key, r * 2.4, r * 2.4, (g) => P.drawTowerSpinner(g, def, r, st)) : null;
    const gloss = ROUND_HEADS.has(style) ? this.cache.get('tg|' + r, r * 1.2, r * 1.2, (g) => P.drawHeadGloss(g, r)) : null;
    return { base, head, spinner, gloss, style };
  }

  // Soft contact shadow that seats a tower on the ground (world radius r).
  _contactShadow(r) {
    return this.cache.get('cshd|' + r, r * 2.6, r * 2.2, (g) => {
      g.save();
      g.scale(1, 0.72);
      const gr = g.createRadialGradient(0, 0, r * 0.2, 0, 0, r * 1.25);
      gr.addColorStop(0, 'rgba(0,0,0,0.5)');
      gr.addColorStop(0.6, 'rgba(0,0,0,0.28)');
      gr.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = gr;
      g.beginPath(); g.arc(0, 0, r * 1.25, 0, TAU); g.fill();
      g.restore();
    });
  }

  // Ground ring that marks tier 3+ in the path color (tier 4 adds rim segments, gold at 5).
  _tierRing(col, r, tier) {
    return this.cache.get('tring2|' + col + '|' + r + '|' + tier, r * 3, r * 3, (g) => {
      const rr = r * 1.22;
      g.beginPath(); g.arc(0, 0, rr, 0, TAU);
      g.lineWidth = r * 0.2; g.strokeStyle = 'rgba(6,8,16,0.55)'; g.stroke();
      g.lineWidth = r * 0.085; g.strokeStyle = col; g.stroke();
      if (tier >= 4) {
        for (let i = 0; i < 6; i++) {
          const a0 = (i / 6) * TAU + 0.18;
          g.beginPath(); g.arc(0, 0, rr + r * 0.2, a0, a0 + 0.55);
          g.lineWidth = r * 0.06; g.strokeStyle = tier >= 5 ? '#ffe28a' : col; g.stroke();
        }
      }
      const gr = g.createRadialGradient(0, 0, rr * 0.7, 0, 0, rr * 1.12);
      gr.addColorStop(0, P.rgba(col, 0)); gr.addColorStop(0.75, P.rgba(col, 0.22)); gr.addColorStop(1, P.rgba(col, 0));
      g.fillStyle = gr; g.beginPath(); g.arc(0, 0, rr * 1.12, 0, TAU); g.fill();
    });
  }

  _drawTowers(ctx, st, ui) {
    const t = this.time;
    const pips = [];
    const badges = [];
    // Painter's order: lower on screen draws later, so tall art overlaps correctly.
    const list = this._towerList || (this._towerList = []);
    list.length = 0;
    for (const tw of st.towers) list.push(tw);
    list.sort((a, b) => a.y - b.y || a.id - b.id);
    // Pass 1: ground (contact shadows, tier rings, tier 5 halos, drop shadows), so no tower's
    // shadow ever falls on top of a neighbor.
    const arts = this._towerArts || (this._towerArts = []);
    let na = 0;
    for (const tw of list) {
      const def = tw.def || this.towerDef(tw.type);
      if (!def) continue;
      const fr = tw.radius || def.radius || 22;
      if (!this.camera.visible(tw.x, tw.y - fr, fr * 3.2)) continue;
      const levels = tw.levels || [0, 0, 0];
      const tier = Math.max(levels[0] || 0, levels[1] || 0, levels[2] || 0);
      const variant = P.towerVariant(def, levels);
      const hero = P.isHeroDef(def) || !!tw.hero;
      const art = this._towerArt(def, variant, hero);
      const ang = Number.isFinite(tw.angle) ? tw.angle : -Math.PI / 2;
      const rec = this.recoil.get(tw.id) || 0;
      // Color of the path that reached this tier (drives the ring and the tier 5 halo).
      const pcol = P.PATH_COLORS[levels.indexOf(tier)] || '#ffd76a';
      const E = arts[na] || (arts[na] = {});
      na++;
      E.tw = tw; E.def = def; E.fr = fr; E.levels = levels; E.tier = tier; E.variant = variant; E.hero = hero; E.art = art; E.ang = ang; E.rec = rec;
      if (tier >= 5) {
        const col = pcol;
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = 0.4 + 0.18 * Math.sin(t * 3 + idHash(tw.id) * 6);
        this._spr(ctx, this._glowSprite(col), tw.x, tw.y, 0, (fr * 2.6) / 32);
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
      }
      if (art) {
        this._spr(ctx, this._contactShadow(Math.round(fr)), tw.x + fr * 0.08, tw.y + fr * 0.2);
        if (tier >= 3 && !hero) this._spr(ctx, this._tierRing(pcol, Math.round(fr), Math.min(5, tier)), tw.x, tw.y);
        const rot = art.rotates ? ang + art.rot0 : 0;
        const sx = hero ? 0.2 : 0.16, sy = hero ? 0.12 : 0.26;
        this._spr(ctx, art.shadow, tw.x + fr * sx, tw.y + fr * sy, rot);
      }
    }
    // Pass 2: bodies
    for (let i = 0; i < na; i++) {
      const { tw, def, fr, levels, tier, variant, hero, art, ang, rec } = arts[i];
      const disabled = tw.disabledT > 0;
      if (art) {
        const rot = art.rotates ? ang + art.rot0 : 0;
        const bx = art.rotates ? -Math.cos(ang) * rec * fr * 0.12 : 0, by = art.rotates ? -Math.sin(ang) * rec * fr * 0.12 : 0;
        // Art that cannot turn gets a tiny squash when it fires instead of a kick.
        const sc = !art.rotates && rec > 0 && !hero ? 1 - rec * 0.035 : 1;
        this._spr(ctx, art.spr, tw.x + bx, tw.y + by, rot, sc);
      } else {
        const r = Math.round(fr * TOWER_VIS * 2) / 2;
        const S = this._towerSprites(def, variant, tier, hero, r);
        const rotates = P.headRotates(def);
        this._spr(ctx, S.base, tw.x, tw.y);
        let hr = rotates ? ang : (P.HEAD_SPIN[S.style] ? t * P.HEAD_SPIN[S.style] + idHash(tw.id) * 6 : 0);
        if (disabled) hr = rotates ? ang : 0;
        const bx = rotates ? -Math.cos(ang) * rec * r * 0.14 : 0, by = rotates ? -Math.sin(ang) * rec * r * 0.14 : 0;
        this._spr(ctx, S.head, tw.x + bx, tw.y + by, hr);
        if (S.spinner) {
          const sp = disabled ? 0 : t * (S.style === 'rig' ? 5 : S.style === 'beacon' ? 1.4 : S.style === 'tesla' ? -0.8 : 0.9) + idHash(tw.id) * 6;
          this._spr(ctx, S.spinner, tw.x, tw.y, sp);
        }
        if (S.gloss) this._spr(ctx, S.gloss, tw.x + bx, tw.y + by);
      }
      if (disabled) {
        const r = fr * 1.1;
        ctx.globalAlpha = 0.45;
        this._world(ctx);
        ctx.beginPath();
        ctx.arc(tw.x, tw.y, r * 0.95, 0, TAU);
        ctx.fillStyle = '#10131c';
        ctx.fill();
        ctx.globalAlpha = 1;
        const spark = this.cache.get('stunstar', 10, 10, (g) => P.drawSparkStar(g, 4.5, '#b48cff'));
        for (let k = 0; k < 3; k++) {
          const a = t * 4 + (k / 3) * TAU;
          this._spr(ctx, spark, tw.x + Math.cos(a) * r * 0.8, tw.y - r * 0.6 + Math.sin(a) * r * 0.3, a);
        }
      }
      if (tier > 0 && !hero) pips.push(tw, levels, fr);
      if (hero) badges.push(tw, fr, art);
    }
    // Pips and badges after all towers so neighbors never cover them.
    for (let i = 0; i < pips.length; i += 3) {
      const tw = pips[i], levels = pips[i + 1], fr = pips[i + 2];
      const key = 'pip|' + (levels[0] || 0) + (levels[1] || 0) + (levels[2] || 0);
      const s = this.cache.get(key, 44, 12, (g) => P.drawPips(g, levels, 2.3));
      this._spr(ctx, s, tw.x, tw.y + fr * 1.22 + 4);
    }
    for (let i = 0; i < badges.length; i += 3) {
      const tw = badges[i], fr = badges[i + 1], art = badges[i + 2];
      const lvl = tw.level ?? (tw.data && tw.data.level) ?? tw.heroLevel ?? (tw.hero && tw.hero.level) ?? tw.xpLevel ?? 1;
      const s = this.cache.get('badge|' + lvl, 22, 22, (g) => P.drawHeroBadge(g, 10, lvl));
      if (art) this._spr(ctx, s, tw.x + fr * 0.95, tw.y + fr * 0.15);
      else this._spr(ctx, s, tw.x + fr * 0.85, tw.y - fr * 0.85);
    }
  }

  // Black holes: a dark core that swallows the channel, with a spinning violet accretion ring.
  _drawPersist(ctx) {
    if (!this.persist.length) return;
    const t = this.time;
    for (const f of this.persist) {
      if (f.kind !== 'blackhole') continue;
      const R = f.r;
      const age = f.max - f.life;
      const a = Math.min(1, age / 0.25, f.life / 0.35);
      if (a <= 0) continue;
      this._world(ctx);
      const core = this.cache.get('bhcore|' + Math.round(R), R * 3, R * 3, (g) => {
        const gr = g.createRadialGradient(0, 0, 0, 0, 0, R * 1.5);
        gr.addColorStop(0, 'rgba(0,0,0,0.95)');
        gr.addColorStop(0.42, 'rgba(6,0,18,0.9)');
        gr.addColorStop(0.62, 'rgba(60,16,120,0.45)');
        gr.addColorStop(1, 'rgba(40,10,90,0)');
        g.fillStyle = gr;
        g.beginPath(); g.arc(0, 0, R * 1.5, 0, TAU); g.fill();
      });
      ctx.globalAlpha = a;
      this._spr(ctx, core, f.x, f.y, 0);
      this._world(ctx);
      ctx.globalCompositeOperation = 'lighter';
      ctx.lineCap = 'round';
      for (let k = 0; k < 3; k++) {
        const rr = R * (0.55 + k * 0.17);
        const spin = t * (3.2 - k * 0.7) + f.seed + k * 2.1;
        ctx.beginPath();
        ctx.ellipse(f.x, f.y, rr, rr * 0.82, 0.4, spin, spin + 2.4);
        ctx.lineWidth = 4 - k;
        ctx.strokeStyle = k === 0 ? 'rgba(226,200,255,0.9)' : 'rgba(155,92,255,0.75)';
        ctx.globalAlpha = a * (0.9 - k * 0.2);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }
  }

  _drawGroundFx(ctx, st) {
    const t = this.time;
    this._drawPersist(ctx);
    for (const tw of st.towers) {
      const s = tw.stats;
      if (!s) continue;
      const atks = s.attacks;
      if (atks) {
        for (const key in atks) {
          const a = atks[key];
          if (!a || a.kind !== 'field') continue;
          const R = a.radius || s.range || 100;
          if (!this.camera.visible(tw.x, tw.y, R)) continue;
          const def = tw.def || this.towerDef(tw.type);
          const col = a.color || (def && def.art && def.art.color) || '#b36bff';
          const disc = this.cache.get('field|' + col + '|' + Math.round(R), R * 2, R * 2, (g) => {
            const gr = g.createRadialGradient(0, 0, R * 0.2, 0, 0, R);
            gr.addColorStop(0, P.rgba(col, 0.02));
            gr.addColorStop(0.8, P.rgba(col, 0.1));
            gr.addColorStop(1, P.rgba(col, 0.22));
            g.fillStyle = gr;
            g.beginPath(); g.arc(0, 0, R, 0, TAU); g.fill();
          });
          ctx.globalCompositeOperation = 'lighter';
          this._spr(ctx, disc, tw.x, tw.y, 0);
          this._world(ctx);
          const tide = !!(atks.tide && atks.tide.pull > 0);
          const pull = a.pull || tide ? 1.5 : 0.6;
          for (let i = 0; i < 3; i++) {
            const ph = (t * 0.45 * pull + i / 3 + idHash(tw.id)) % 1;
            // an Undertow well shoves meteors back: its rings run outward
            const rr = tide ? R * ph : R * (1 - ph);
            ctx.globalAlpha = Math.min(1, ph * 3) * (1 - ph) * 0.9;
            ctx.beginPath();
            ctx.arc(tw.x, tw.y, Math.max(1, rr), 0, TAU);
            ctx.lineWidth = 2;
            ctx.strokeStyle = P.rgba(col, 0.7);
            ctx.stroke();
          }
          ctx.globalAlpha = 1;
          ctx.globalCompositeOperation = 'source-over';
        }
      }
      // Faint support aura footprint
      if (s.aura && s.aura.radius && this.camera.visible(tw.x, tw.y, s.aura.radius)) {
        this._world(ctx);
        ctx.beginPath();
        ctx.arc(tw.x, tw.y, s.aura.radius, 0, TAU);
        ctx.setLineDash([3, 9]);
        ctx.lineDashOffset = -t * 6;
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = 'rgba(255,215,106,0.22)';
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
  }

  // Meteor sprite lookup without string building: Map(type) -> Map(r) -> Array(bits*32 + frame)
  _meteorSprite(type, r, bits, frame, color) {
    let byR = this._mSpr.get(type);
    if (!byR) { byR = new Map(); this._mSpr.set(type, byR); }
    let arr = byR.get(r);
    if (!arr) { arr = []; byR.set(r, arr); }
    const idx = bits * 32 + frame;
    let s = arr[idx];
    if (!s) {
      const aurora = type === 'aurora';
      const o = {
        rot: aurora ? 0 : frame * P.METEOR_STEP, phantom: !!(bits & 1), nanite: !!(bits & 2), plated: !!(bits & 4),
        hue: aurora ? frame * 30 : 0, color, silhouette: !!(bits & 8),
      };
      // Tight asymmetric box: outline on all sides plus the drop shadow down-right.
      const lead = (bits & 4) ? r * 1.24 + 1.5 : r * 1.15 + 1;
      const box = lead + r * 1.7 + 2;
      s = this.cache.get('m|' + type + '|' + r + '|' + idx, box, box, (g) => P.drawMeteor(g, type, r, o), lead, lead);
      arr[idx] = s;
    }
    return s;
  }

  // Image meteor with its soft ground shadow and modifier overlays (bits: 1 phantom, 2 nanite,
  // 4 plated) pre-composited, cached per type, size and modifier set.
  _meteorImg(type, eimg, r, bits) {
    const mk = 'img|' + type;
    let byR = this._mSpr.get(mk);
    if (!byR) { byR = new Map(); this._mSpr.set(mk, byR); }
    let arr = byR.get(r);
    if (!arr) { arr = []; byR.set(r, arr); }
    let s = arr[bits];
    if (!s) {
      const size = eimg.size || r * 2.5;
      const img = eimg.img;
      const iw = img.naturalWidth || img.width || 1, ih = img.naturalHeight || img.height || 1;
      const w = iw >= ih ? size : (size * iw) / ih, h = iw >= ih ? (size * ih) / iw : size;
      const half = Math.max(w, h, r * 3) / 2 + r * 0.5;
      s = arr[bits] = this.cache.get('m|img|' + type + '|' + r + '|' + bits, half * 2, half * 2, (g) => {
        if (!(bits & 1)) {
          const gr = g.createRadialGradient(r * 0.2, r * 0.35, 0, r * 0.2, r * 0.35, r * 1.1);
          gr.addColorStop(0, 'rgba(0,0,0,0.42)'); gr.addColorStop(0.55, 'rgba(0,0,0,0.2)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
          g.fillStyle = gr; g.beginPath(); g.arc(r * 0.2, r * 0.35, r * 1.1, 0, TAU); g.fill();
        }
        g.imageSmoothingEnabled = true;
        g.imageSmoothingQuality = 'high';
        if (bits & 1) g.globalAlpha = 0.62;
        g.drawImage(img, -w / 2, -h / 2, w, h);
        g.globalAlpha = 1;
        if (bits & 4) P.drawPlatedRing(g, r);
        if (bits & 2) P.drawNaniteSpecks(g, r);
        if (bits & 1) P.drawPhantomRim(g, r);
      });
    }
    return s;
  }

  _drawEnemies(ctx, st) {
    const ships = [];
    const bars = [];
    const t = this.time;
    const simT = this.simT;
    const v = this.camera.view;
    const lanes = this.lanes;
    const track = this.hpTrack;
    const frame = this.frame;
    let count = 0;
    let iceS = null, flameS = null, starS = null;
    // Only touch globalAlpha when it changes (most meteors draw at 1).
    let ca = -1;
    const A = (v) => { if (v !== ca) { ctx.globalAlpha = v; ca = v; } };
    for (const e of st.enemies) {
      if (e.dead) continue;
      const def = e.def || ENEMIES[e.type];
      if (!def) continue;
      if (e.titan || def.kind === 'ship' || def.kind === 'titan' || TITAN_KINDS.has(e.type)) { ships.push(e); continue; }
      // Visual radius (the sim radius is the hitbox; crystals read better a bit larger).
      const r = Math.round((e.radius || def.radius || 12) * METEOR_VIS * 2) / 2;
      const x = e.x, y = e.y;
      if (x + r * 2 < v.x0 || x - r * 2 > v.x1 || y + r * 2 < v.y0 || y - r * 2 > v.y1) continue;
      count++;
      // Emerging from the portal
      let alpha = 1;
      const L = lanes[e.lane | 0];
      if (L && Number.isFinite(e.d)) {
        const dd = e.d - L.start;
        if (dd < 36) { if (dd <= 0) continue; alpha = dd / 36; }
      }
      const phantom = !!e.phantom && !(e.exposedT > 0);
      const bits = (phantom ? 1 : 0) | (e.nanite ? 2 : 0) | (e.plated ? 4 : 0);
      const h = idHash(e.id);
      const dist = Number.isFinite(e.d) ? e.d : simT * 80;
      // Rolling spin tied to distance travelled (stops when frozen or stunned).
      const theta = h * TAU + dist * 0.014 * P.meteorSpin(e.type) * (h > 0.5 ? 1 : -1);
      const mf = frameOf(theta, P.METEOR_FRAMES);
      const frozen = e.frozenT > 0;
      // Slow trail and comet tail (behind the body), pre-rotated to the travel direction
      const ang = Number.isFinite(e.angle) ? e.angle : 0;
      if (e.slowT > 0 && e.slowMult < 0.999 && !frozen) {
        const s = this._rot('slowtrail', 16, frameOf(ang, 16), 28, (g) => P.drawSlowTrail(g, 10));
        A();
        this._spr(ctx, s, x, y, 0, r / 10);
      }
      if (e.type === 'comet') {
        const s = this._rot('comettail', 24, frameOf(ang, 24), 44, (g) => P.drawCometTail(g, 12));
        A();
        this._spr(ctx, s, x, y, 0, r / 12);
      }
      // Body
      const eimg = this._enemyImage(e.type);
      if (eimg) {
        if (eimg.rotates) {
          const size = eimg.size || r * 2.5;
          A(alpha);
          this._spr(ctx, imageSprite(this.cache, 'enemy_' + e.type, eimg, size), x, y, theta);
        } else {
          // Shadow, body and modifier overlays baked into one sprite: one draw per meteor.
          A(alpha);
          this._spr(ctx, this._meteorImg(e.type, eimg, r, bits), x, y);
        }
      } else {
        // Aurora cycles hue frames (a rainbow gem needs no spin); the rest use rotation frames.
        const spr = e.type === 'aurora'
          ? this._meteorSprite(e.type, r, bits, Math.floor(t * 5 + h * 12) % 12, def.color)
          : this._meteorSprite(e.type, r, bits, mf, def.color);
        A(alpha);
        this._spr(ctx, spr, x, y);
      }
      // Multi-HP meteors: crack overlay + hit flash
      const maxHp = e.maxHp || def.hp || 1;
      if (maxHp > 1) {
        let tr = track.get(e.id);
        if (!tr) { tr = { hp: e.hp, flash: 0, seen: frame }; track.set(e.id, tr); }
        if (e.hp < tr.hp) tr.flash = 1;
        tr.hp = e.hp; tr.seen = frame;
        const lvl = Math.min(4, Math.floor((1 - e.hp / maxHp) * 5));
        const af = e.type === 'aurora' ? 0 : mf;
        if (lvl > 0 && !eimg) {
          const cs = this._rot('mc|' + e.type + '|' + r + '|' + lvl, P.METEOR_FRAMES, af, r * 1.2, (g) => P.drawMeteorCracks(g, e.type, r, lvl));
          A();
          this._spr(ctx, cs, x, y);
        }
        if (tr.flash > 0) {
          A();
          if (eimg) {
            const size = eimg.size || r * 2.5;
            const base = imageSprite(this.cache, 'enemy_' + e.type, eimg, size);
            const wk = 'wimg|' + e.type + '|' + size;
            const white = this.cache.peek(wk) || this.cache.get(wk, base.w, base.h, (g) => {
              drawSprite(g, base, 0, 0);
              g.globalCompositeOperation = 'source-in';
              g.fillStyle = '#ffffff';
              g.fillRect(-base.w, -base.h, base.w * 2, base.h * 2);
            });
            this._spr(ctx, white, x, y, eimg.rotates ? theta : 0);
          } else {
            this._spr(ctx, this._meteorSprite(e.type, r, 8, af, def.color), x, y);
          }
          tr.flash = Math.max(0, tr.flash - this.simDt * 9);
        }
      }
      // Status overlays
      if (frozen) {
        iceS = iceS || this.cache.get('ice|' + 12, 36, 36, (g) => P.drawIceCrust(g, 12));
        A();
        this._spr(ctx, iceS, x, y, 0, r / 12);
      }
      if (e.burn && e.burn.length) {
        flameS = flameS || this.cache.get('flame', 30, 34, (g) => P.drawFlame(g, 10), 15, 26);
        const fl = 0.85 + 0.25 * Math.sin(t * 23 + h * 40) + 0.1 * Math.sin(t * 37);
        ctx.globalCompositeOperation = 'lighter';
        A();
        this._spr(ctx, flameS, x, y + r * 0.2, 0, (r / 10) * fl);
        ctx.globalCompositeOperation = 'source-over';
        if (Math.random() < this.simDt * 3) this.particles.embers(x, y - r * 0.5, 1, 40);
      }
      if (e.stunT > 0) {
        starS = starS || this.cache.get('stunstar2', 12, 12, (g) => P.drawSparkStar(g, 5, '#fff27a'));
        A();
        for (let i = 0; i < 2; i++) {
          const a = t * 7 + i * Math.PI + h * 6;
          this._spr(ctx, starS, x + Math.cos(a) * r * 0.9, y - r * 0.9 + Math.sin(a) * r * 0.3, 0, 0.9);
        }
      }
    }
    ctx.globalAlpha = 1;
    // Track cleanup
    if (frame % 90 === 0) for (const [id, tr] of track) if (frame - tr.seen > 30) track.delete(id);

    // Ships and titans on top of meteors (biggest last)
    ships.sort((a, b) => (a.radius || 0) - (b.radius || 0));
    for (const e of ships) {
      this._drawShip(ctx, e, bars);
      count++;
    }
    this.stats.enemies = count;
    return bars;
  }

  _drawShip(ctx, e, bars) {
    const def = e.def || ENEMIES[e.type] || {};
    const isTitan = !!e.titan || TITAN_KINDS.has(e.type) || def.kind === 'titan';
    const kind = isTitan ? ((e.titan && e.titan.kind) || def.titanKind || e.type) : e.type;
    const R = e.radius || def.radius || (isTitan ? 80 : 40);
    const x = e.x, y = e.y;
    if (!this.camera.visible(x, y, R * 1.6)) return;
    const ang = Number.isFinite(e.angle) ? e.angle : 0;
    const t = this.time;
    const h = idHash(e.id);
    let alpha = 1;
    const L = this.lanes[e.lane | 0];
    if (L && Number.isFinite(e.d)) {
      const dd = e.d - L.start;
      if (dd < R) { if (dd <= -R) return; alpha = Math.max(0, (dd + R) / (2 * R)); }
    }
    const phantom = !!e.phantom && !(e.exposedT > 0);
    const imgKey = (isTitan ? 'titan_' : 'ship_') + kind;
    const img = this.assets.get && this.assets.get(imgKey);
    const bodyKey = (isTitan ? 'ti|' : 'sh|') + kind + '|' + R;
    let body, rotOff = 0;
    if (img) {
      body = imageSprite(this.cache, imgKey, img, img.size || R * 2.3);
      rotOff = facingOffset(img.facing || 'right');
    } else {
      body = this.cache.get(bodyKey, R * 2.6, R * 2.6, (g) => (isTitan ? P.drawTitan(g, kind, R) : P.drawShip(g, kind, R, def.color)));
    }
    // Shadow: silhouette of the body, blurred, offset down-right in screen space.
    const shadow = img
      ? imageShadow(this.cache, imgKey, img, img.size || R * 2.3, null, 0.42, 0.05)
      : this.cache.get('shd|' + bodyKey, R * 2.6, R * 2.6, (g) => {
        const k = g.getTransform().a;
        try { g.filter = `blur(${(R * 0.05 * k).toFixed(1)}px)`; } catch { /* ignore */ }
        drawSprite(g, body, 0, 0);
        g.filter = 'none';
        g.globalCompositeOperation = 'source-in';
        g.fillStyle = 'rgba(0,0,0,0.42)';
        g.fillRect(-R * 2, -R * 2, R * 4, R * 4);
      });
    const hover = isTitan ? 0.26 : 0.16;
    ctx.globalAlpha = alpha * (phantom ? 0.35 : 1);
    this._spr(ctx, shadow, x + R * hover * 0.6, y + R * hover, ang + rotOff);
    // Engine glow
    const eng = P.SHIP_ENGINES[kind];
    if (eng && !img && !(e.stunT > 0)) {
      const gs = this._glowSprite(eng.color);
      const c = Math.cos(ang), s = Math.sin(ang);
      ctx.globalCompositeOperation = 'lighter';
      for (const [ex, ey, es] of eng.pts) {
        const fl = 0.8 + 0.2 * Math.sin(t * 30 + ex * 10 + h * 7);
        const wx = x + (ex * c - ey * s) * R, wy = y + (ex * s + ey * c) * R;
        ctx.globalAlpha = alpha * 0.9;
        this._spr(ctx, gs, wx, wy, 0, (es * R * 1.6 * fl) / 32);
      }
      ctx.globalCompositeOperation = 'source-over';
    }
    // Body
    ctx.globalAlpha = phantom ? alpha * (0.5 + 0.2 * Math.sin(t * 5 + h * 9)) : alpha;
    this._spr(ctx, body, x, y, ang + rotOff);
    // Damage cracks (masked to the hull)
    const maxHp = e.maxHp || 1;
    const frac = Math.max(0, Math.min(1, (e.hp || 0) / maxHp));
    const lvl = frac < 0.25 ? 3 : frac < 0.5 ? 2 : frac < 0.75 ? 1 : 0;
    if (lvl > 0) {
      const cracks = this.cache.get('shc|' + bodyKey + '|' + lvl + (img ? '|img' : ''), R * 2.6, R * 2.6, (g) => {
        P.drawShipCracks(g, R, lvl, kind);
        g.globalCompositeOperation = 'destination-in';
        drawSprite(g, body, 0, 0);
      });
      this._spr(ctx, cracks, x, y, ang + rotOff);
      if (Math.random() < this.simDt * (lvl * 2.5)) {
        const a = Math.random() * TAU;
        this.particles.smoke(x + Math.cos(a) * R * 0.4, y + Math.sin(a) * R * 0.3, R * 0.25, 0.9, '#3a3640', 0, -20, 0.55);
        if (lvl >= 2 && Math.random() < 0.4) this.particles.embers(x + Math.cos(a) * R * 0.3, y + Math.sin(a) * R * 0.2, 2, 60);
      }
    }
    // Hit flash
    let tr = this.hpTrack.get(e.id);
    if (!tr) { tr = { hp: e.hp, flash: 0, seen: this.frame }; this.hpTrack.set(e.id, tr); }
    if (e.hp < tr.hp - 1e-6) tr.flash = Math.min(1, tr.flash + 0.5);
    tr.hp = e.hp; tr.seen = this.frame;
    if (tr.flash > 0) {
      const white = this.cache.get('wh|' + bodyKey + (img ? '|img' : ''), R * 2.6, R * 2.6, (g) => {
        drawSprite(g, body, 0, 0);
        g.globalCompositeOperation = 'source-in';
        g.fillStyle = '#ffffff';
        g.fillRect(-R * 2, -R * 2, R * 4, R * 4);
      });
      ctx.globalAlpha = tr.flash * 0.45 * alpha;
      this._spr(ctx, white, x, y, ang + rotOff);
      tr.flash = Math.max(0, tr.flash - this.simDt * 8);
    }
    ctx.globalAlpha = alpha;
    // Titan specials
    if (isTitan) {
      const ti = e.titan || {};
      if (kind === 'aegis' && (ti.shield > 0 || ti.maxShield === undefined)) {
        const sf = ti.maxShield ? Math.max(0, Math.min(1, ti.shield / ti.maxShield)) : 1;
        if (sf > 0) {
          const bub = this.cache.get('bubble|' + R, R * 2.8, R * 2.8, (g) => P.drawShieldBubble(g, R * 1.3));
          ctx.globalCompositeOperation = 'lighter';
          ctx.globalAlpha = alpha * (0.35 + 0.55 * sf) * (0.85 + 0.15 * Math.sin(t * 4));
          this._spr(ctx, bub, x, y, t * 0.3);
          ctx.globalCompositeOperation = 'source-over';
        }
      } else if (kind === 'rift') {
        const gs = this._glowSprite('#d06bff');
        ctx.globalCompositeOperation = 'lighter';
        const j = 0.85 + Math.random() * 0.35;
        ctx.globalAlpha = alpha * (0.35 + Math.random() * 0.25);
        this._spr(ctx, gs, x + (Math.random() - 0.5) * 6, y + (Math.random() - 0.5) * 6, 0, (R * 1.4 * j) / 32);
        ctx.globalCompositeOperation = 'source-over';
        this._world(ctx);
        ctx.globalAlpha = alpha * 0.7;
        ctx.beginPath();
        ctx.arc(x, y, R * (1.15 + 0.05 * Math.sin(t * 9)), 0, TAU);
        ctx.setLineDash([R * 0.2, R * 0.12]);
        ctx.lineDashOffset = t * 60;
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = '#e8a8ff';
        ctx.stroke();
        ctx.setLineDash([]);
      } else if (kind === 'maw') {
        const gs = this._glowSprite('#ff7a2a');
        const c = Math.cos(ang), s = Math.sin(ang);
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = alpha * (0.5 + 0.3 * Math.sin(t * 5));
        this._spr(ctx, gs, x + c * R * 0.72, y + s * R * 0.72, 0, (R * 0.6) / 32);
        ctx.globalCompositeOperation = 'source-over';
      }
    }
    // Status overlays
    if (e.burn && e.burn.length) {
      const fs = this.cache.get('flame', 30, 34, (g) => P.drawFlame(g, 10), 15, 26);
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.7 * alpha;
      for (let i = 0; i < 3; i++) {
        const a = h * 6 + i * 2.1;
        this._spr(ctx, fs, x + Math.cos(a) * R * 0.45, y + Math.sin(a) * R * 0.3, 0, (R / 26) * (0.9 + 0.2 * Math.sin(t * 20 + i)));
      }
      ctx.globalCompositeOperation = 'source-over';
    }
    if (e.stunT > 0) {
      const ss = this.cache.get('stunstar2', 12, 12, (g) => P.drawSparkStar(g, 5, '#fff27a'));
      for (let i = 0; i < 3; i++) {
        const a = t * 5 + (i / 3) * TAU;
        this._spr(ctx, ss, x + Math.cos(a) * R * 0.7, y - R * 0.5 + Math.sin(a) * R * 0.25, a, 1.3);
      }
    }
    if ((e.slowT > 0 && e.slowMult < 0.999) || e.frozenT > 0) {
      this._world(ctx);
      ctx.globalAlpha = 0.5 * alpha;
      ctx.beginPath();
      ctx.arc(x, y, R * 1.05, 0, TAU);
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#9fe8ff';
      ctx.setLineDash([6, 8]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.globalAlpha = 1;
    // RP-10: a full-health ship far from the core doesn't need a bar yet, and in a late-wave
    // swarm (hundreds of ships) drawing one for every single ship buries the channel. Titans
    // always keep theirs (rare, high-stakes fights); everything else earns one by being damaged
    // or close enough to the core to warn the player, and fades in with how urgent it is rather
    // than popping straight to full opacity. _drawBars then caps how many of these it actually
    // draws, so a huge swarm stays bounded instead of scaling render cost with enemy count.
    let urgency = 1;
    if (!isTitan) {
      const damaged = frac < 0.999;
      let frontUrgency = 0;
      if (L && Number.isFinite(e.d)) {
        const remaining = Math.max(0, L.length - e.d);
        if (remaining < SHIP_BAR_FRONT_DIST) frontUrgency = 1 - remaining / SHIP_BAR_FRONT_DIST;
      }
      const dmgUrgency = damaged ? 1 - frac : 0;
      urgency = Math.max(dmgUrgency, frontUrgency);
      if (urgency <= 0) return; // full health, nowhere near the core: no bar needed
    }
    const shield = isTitan && e.titan && e.titan.maxShield ? Math.max(0, e.titan.shield / e.titan.maxShield) : 0;
    bars.push({ x, y, R, frac, titan: isTitan, shield, alpha, urgency });
  }

  _drawBars(ctx, bars) {
    if (!bars.length) return;
    // Titans always draw; everything else is capped to the most urgent SHIP_BAR_MAX so a huge
    // swarm's worth of bars never buries the map or scales render cost with enemy count (RP-10).
    let list = bars;
    const extra = bars.length - bars.reduce((n, b) => n + (b.titan ? 1 : 0), 0);
    if (extra > SHIP_BAR_MAX) {
      list = bars.filter((b) => b.titan);
      const rest = bars.filter((b) => !b.titan).sort((a, b) => b.urgency - a.urgency).slice(0, SHIP_BAR_MAX);
      list = list.concat(rest);
    }
    this._world(ctx);
    for (const b of list) {
      const w = b.titan ? Math.max(120, b.R * 2.2) : Math.max(40, b.R * 1.5);
      const hgt = b.titan ? 9 : 6;
      const x = b.x - w / 2, y = b.y - b.R - (b.titan ? 26 : 16);
      // Fade the bar in with urgency (min 0.45 so a shown bar always stays legible) instead of
      // popping straight to full opacity the instant a ship crosses the damaged/near-front line.
      ctx.globalAlpha = b.alpha * (b.titan ? 1 : Math.max(0.45, b.urgency));
      ctx.fillStyle = 'rgba(8,10,18,0.85)';
      roundRectPath(ctx, x - 2, y - 2, w + 4, hgt + 4, 4);
      ctx.fill();
      const col = b.frac > 0.6 ? '#5dff8a' : b.frac > 0.3 ? '#ffd23d' : '#ff4d4d';
      if (b.frac > 0) {
        roundRectPath(ctx, x, y, w * b.frac, hgt, 3);
        ctx.fillStyle = col;
        ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.35)';
        ctx.fillRect(x + 1, y + 1, Math.max(0, w * b.frac - 2), hgt * 0.35);
      }
      if (b.shield > 0) {
        roundRectPath(ctx, x, y - 6, w * b.shield, 4, 2);
        ctx.fillStyle = '#7ff4ff';
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }

  _drawDrones(ctx, st) {
    const drones = st.drones;
    if (!drones || !drones.length) return;
    const t = this.time;
    const shadow = this.cache.get('droneShadow', 30, 30, (g) => {
      const gr = g.createRadialGradient(0, 0, 0, 0, 0, 12);
      gr.addColorStop(0, 'rgba(0,0,0,0.45)');
      gr.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = gr;
      g.beginPath(); g.arc(0, 0, 12, 0, TAU); g.fill();
    });
    for (const d of drones) {
      if (!this.camera.visible(d.x, d.y, 20)) continue;
      const vk = String(d.visual || '') + ' ' + String(d.kind || '');
      const kind = /bomb|strike|wing/.test(vk) ? 'bomber' : /tractor|tow|haul|grav/.test(vk) ? 'tractor' : 'gun';
      const owner = this.towerSnap.get(d.towerId);
      const odef = owner && owner.t ? (owner.t.def || this.towerDef(owner.t.type)) : null;
      const col = d.color || (odef && odef.art && odef.art.color) || '#6fd3ff';
      const spr = this.cache.get('drone|' + kind + '|' + col, 30, 30, (g) => P.drawDroneBody(g, 10, col, kind));
      const bob = Math.sin(t * 6 + idHash(d.id) * 10) * 1.5;
      this._spr(ctx, shadow, d.x + 8, d.y + 14, 0);
      const run = owner && owner.t && owner.t.data && owner.t.data._field_run;
      if (kind === 'tractor' && (d.towing === undefined ? d.targetId != null && d.targetId >= 0 : d.towing)) {
        const e = this._enemy(d.targetId);
        if (e) {
          this._world(ctx);
          ctx.globalCompositeOperation = 'lighter';
          ctx.globalAlpha = 0.5 + 0.2 * Math.sin(t * 20);
          ctx.beginPath();
          ctx.moveTo(d.x, d.y + bob); ctx.lineTo(e.x, e.y);
          ctx.lineWidth = 6; ctx.strokeStyle = 'rgba(125,255,176,0.35)'; ctx.stroke();
          ctx.lineWidth = 2; ctx.strokeStyle = '#c8ffd8'; ctx.stroke();
          ctx.globalAlpha = 1;
          ctx.globalCompositeOperation = 'source-over';
        }
      }
      if (run) {
        // Bombing Run: the wing flies big and low, trailing smoke
        if (Math.random() < this.simDt * 40 * this.particles.budget) {
          const c = Math.cos(d.angle || 0), sn = Math.sin(d.angle || 0);
          this.particles.smoke(d.x - c * 14, d.y - sn * 14, 7, 0.6, '#8b8f99', -c * 30, -sn * 30, 0.5);
        }
        this._spr(ctx, spr, d.x, d.y + bob, Number.isFinite(d.angle) ? d.angle : 0, 1.7);
        continue;
      }
      this._spr(ctx, spr, d.x, d.y + bob, Number.isFinite(d.angle) ? d.angle : 0);
    }
  }

  // Per (visual, color, size) entry. Sprites are pre-rotated into PROJ_FRAMES directions so
  // every projectile is a plain drawImage: `full` = glow + body baked together, `body` =
  // body only (low quality / governor). Additive visuals bake glow + core.
  _projSprites(vis, color, s) {
    let byC = this._pjSpr.get(vis);
    if (!byC) { byC = new Map(); this._pjSpr.set(vis, byC); }
    let byS = byC.get(color);
    if (!byS) { byS = new Map(); byC.set(color, byS); }
    let e = byS.get(s);
    if (!e) {
      const B = P.PROJ_BOX[vis] || P.PROJ_BOX.bolt;
      const bb = B.body, gb = B.glow;
      const corner = (b) => Math.max(Math.hypot(b[2], b[3]), Math.hypot(b[0] - b[2], b[3]), Math.hypot(b[2], b[1] - b[3]), Math.hypot(b[0] - b[2], b[1] - b[3]));
      e = {
        vis, color, s, add: ADD_ONLY_VISUALS.has(vis),
        extFull: Math.max(corner(bb), corner(gb)) * s, extBody: corner(bb) * s,
        full: new Array(PROJ_FRAMES), body: new Array(PROJ_FRAMES),
      };
      byS.set(s, e);
    }
    return e;
  }

  _projFrame(e, f, withGlow) {
    const arr = withGlow || e.add ? e.full : e.body;
    let spr = arr[f];
    if (!spr) {
      const { vis, color, s, add } = e;
      const ang = (f * TAU) / PROJ_FRAMES;
      const ext = withGlow || add ? e.extFull : e.extBody;
      spr = arr[f] = this.cache.get('pj|' + vis + '|' + color + '|' + s + '|' + (withGlow || add ? 1 : 0) + '|' + f, ext * 2, ext * 2, (g) => {
        g.rotate(ang);
        if (withGlow || add) {
          g.globalAlpha = add ? 1 : 0.85;
          P.drawProjectileGlow(g, vis, color, s);
          g.globalAlpha = 1;
          if (add) g.globalCompositeOperation = 'lighter';
        }
        P.drawProjectileBody(g, vis, color, s);
      });
    }
    return spr;
  }

  // 0..1 flight progress for arcing shells and growing flames.
  _progress(p) {
    if (p.mortar && Number.isFinite(p.prog)) return Math.max(0, Math.min(1, p.prog));
    if (Number.isFinite(p.maxLife) && p.maxLife > 0 && Number.isFinite(p.life)) return Math.max(0, Math.min(1, 1 - p.life / p.maxLife));
    let rec = this.shellRec.get(p);
    if (!rec || rec.id !== p.id) {
      rec = { id: p.id, life0: Number.isFinite(p.life) ? p.life : 1 };
      this.shellRec.set(p, rec);
    }
    return Number.isFinite(p.life) && rec.life0 > 0 ? Math.max(0, Math.min(1, 1 - p.life / rec.life0)) : 0.5;
  }

  _drawProjectiles(ctx, st) {
    const list = st.projectiles;
    if (!list || !list.length) { this.stats.projectiles = 0; return; }
    const v = this.camera.view;
    const t = this.time;
    const glows = this.settings.particles !== 'low' && this.governor < 2;
    const pt = this.particles;
    const trailBudget = pt.budget;
    let count = 0, adds = 0;
    let shellShadow = null;
    // Pass 1: normal blend (bodies with baked glow); additive visuals are counted for pass 2.
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (p.dead) continue;
      const x = p.x, y = p.y;
      if (x < v.x0 - 30 || x > v.x1 + 30 || y < v.y0 - 30 || y > v.y1 + 200) continue;
      count++;
      const vis = P.resolveVisual(p.visual);
      if (ADD_ONLY_VISUALS.has(vis)) { adds++; continue; }
      const s = Math.max(2, Math.min(24, Math.round((p.radius || 5) * (p.scale || 1) * 2) / 2));
      const S = this._projSprites(vis, p.color || '#9ef', s);
      if (p.mortar) {
        // Arcing shell: ground shadow at the true position, shell raised by the arc.
        const prog = this._progress(p);
        const H = Number.isFinite(p.arc) && p.arc > 0 ? p.arc : 120;
        const hgt = Math.sin(prog * Math.PI) * H;
        shellShadow = shellShadow || this.cache.get('shellShadow', 20, 20, (g) => {
          const gr = g.createRadialGradient(0, 0, 0, 0, 0, 8);
          gr.addColorStop(0, 'rgba(0,0,0,0.55)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
          g.fillStyle = gr; g.beginPath(); g.arc(0, 0, 8, 0, TAU); g.fill();
        });
        this._spr(ctx, shellShadow, x, y, 0, (s / 5) * (1.1 - hgt / (H * 2.2)));
        // Nose follows the arc: up while rising, down while falling.
        const tilt = Math.cos(prog * Math.PI) * 0.9;
        const dir = Math.cos(p.angle || 0) >= 0 ? 1 : -1;
        this._spr(ctx, this._projFrame(S, frameOf((p.angle || 0) - tilt * dir, PROJ_FRAMES), glows), x, y - hgt, 0, 1 + hgt / 240);
        continue;
      }
      let ang = (p.vx || p.vy) ? Math.atan2(p.vy, p.vx) : (p.angle || 0);
      if (vis === 'shard') ang = t * 18 + (idHash(p.id) * 6);
      else if (vis === 'blade') ang = t * 14 + (idHash(p.id) * 6);
      this._spr(ctx, this._projFrame(S, frameOf(ang, PROJ_FRAMES), glows), x, y);
      if (vis === 'missile' && Math.random() < this.simDt * 30 * trailBudget) {
        const c = Math.cos(ang), sn = Math.sin(ang);
        pt.smoke(x - c * s * 2.2, y - sn * s * 2.2, s * 1.1, 0.55, '#a8adb8', -c * 20, -sn * 20, 0.55);
      }
    }
    // Pass 2: additive energy projectiles (orb, plasma, flame)
    if (adds) {
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < list.length; i++) {
        const p = list[i];
        if (p.dead) continue;
        const vis = P.resolveVisual(p.visual);
        if (!ADD_ONLY_VISUALS.has(vis)) continue;
        const x = p.x, y = p.y;
        if (x < v.x0 - 30 || x > v.x1 + 30 || y < v.y0 - 30 || y > v.y1 + 30) continue;
        const s = Math.max(2, Math.min(24, Math.round((p.radius || 5) * (p.scale || 1) * 2) / 2));
        const S = this._projSprites(vis, p.color || '#9ef', s);
        let ang = (p.vx || p.vy) ? Math.atan2(p.vy, p.vx) : (p.angle || 0);
        let sc = 1;
        const h = idHash(p.id);
        if (vis === 'orb') { ang = t * 9 + h * 6; sc = 0.9 + 0.2 * Math.sin(t * 25 + h * 30); }
        else if (vis === 'plasmaorb') { ang = t * 4 + h * 6; sc = 0.95 + 0.08 * Math.sin(t * 12 + h * 30); }
        else if (vis === 'flame') {
          const prog = this._progress(p);
          sc = 0.8 + prog * 1.1;
          ang = h * 6;
          ctx.globalAlpha = Math.max(0.15, 1 - prog * 0.7);
        }
        this._spr(ctx, this._projFrame(S, frameOf(ang, PROJ_FRAMES), true), x, y, 0, sc);
        ctx.globalAlpha = 1;
      }
      ctx.globalCompositeOperation = 'source-over';
    }
    this.stats.projectiles = count;
  }

  _drawBeams(ctx, st) {
    const t = this.time;
    let any = false;
    for (const tw of st.towers) {
      const beams = tw.data && tw.data.beams;
      if (!beams || !beams.length) continue;
      if (!any) { any = true; this._world(ctx); ctx.globalCompositeOperation = 'lighter'; ctx.lineCap = 'round'; }
      const r = tw.radius || 22;
      for (let i = 0; i < beams.length; i++) {
        const b = beams[i];
        let x1 = b.x1, y1 = b.y1;
        if (!Number.isFinite(x1) || Math.hypot(x1 - tw.x, y1 - tw.y) < 2) {
          const a = Math.atan2(b.y2 - tw.y, b.x2 - tw.x);
          x1 = tw.x + Math.cos(a) * r * 1.05; y1 = tw.y + Math.sin(a) * r * 1.05;
        }
        const w = b.width || 5;
        const col = b.color || '#ff5d8a';
        const fl = 0.85 + 0.15 * Math.sin(t * 50 + i * 2 + tw.id);
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(b.x2, b.y2);
        ctx.globalAlpha = 0.16;
        ctx.lineWidth = w * 4 * fl;
        ctx.strokeStyle = col;
        ctx.stroke();
        ctx.globalAlpha = 0.5;
        ctx.lineWidth = w * 1.8 * fl;
        ctx.stroke();
        ctx.globalAlpha = 0.95;
        ctx.lineWidth = Math.max(1.2, w * 0.55);
        ctx.strokeStyle = '#ffffff';
        ctx.stroke();
        ctx.globalAlpha = 0.9;
        const gs = this._glowSprite(col);
        this._spr(ctx, gs, b.x2, b.y2, 0, (w * 3.2 * fl) / 32);
        this._spr(ctx, gs, x1, y1, 0, (w * 2.2) / 32);
        this._world(ctx);
        if (Math.random() < this.simDt * 12) this.particles.sparks(b.x2, b.y2, col, 1, 140, 5, 0.15);
      }
    }
    if (any) { ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; }
  }

  _drawZaps(ctx) {
    if (!this.zaps.length && !this.tracers.length) return;
    this._world(ctx);
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    const odd = this.frame & 1;
    for (const z of this.zaps) {
      const fr = z.life / z.max;
      const pts = odd ? z.a : z.b;
      ctx.beginPath();
      ctx.moveTo(pts[0], pts[1]);
      for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
      const zw = z.w || 1;
      ctx.globalAlpha = 0.3 * fr;
      ctx.lineWidth = 9 * zw;
      ctx.strokeStyle = z.color;
      ctx.stroke();
      ctx.globalAlpha = 0.85 * fr;
      ctx.lineWidth = 3.2 * zw;
      ctx.stroke();
      ctx.globalAlpha = fr;
      ctx.lineWidth = 1.3 * Math.sqrt(zw);
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
    }
    for (const z of this.tracers) {
      const fr = z.life / z.max;
      ctx.beginPath();
      ctx.moveTo(z.x1, z.y1);
      ctx.lineTo(z.x2, z.y2);
      ctx.globalAlpha = 0.25 * fr;
      ctx.lineWidth = z.w * 3;
      ctx.strokeStyle = z.color;
      ctx.stroke();
      ctx.globalAlpha = 0.9 * fr;
      ctx.lineWidth = z.w * 0.6;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    // Node glows
    for (const z of this.zaps) {
      const fr = z.life / z.max;
      const gs = this._glowSprite(z.color);
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = fr * 0.8;
      for (let i = 1; i < z.nodes.length; i++) this._spr(ctx, gs, z.nodes[i][0], z.nodes[i][1], 0, 0.5);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  _drawGhost(ctx, st, ui) {
    const pl = ui.placing;
    if (!pl || !Number.isFinite(pl.x)) return;
    const def = pl.def || this.towerDef(pl.type);
    const r = Math.round(((def && def.radius) || 22) * TOWER_VIS * 2) / 2;
    const valid = pl.valid !== false;
    const col = valid ? '#5dff8a' : '#ff4d5d';
    this._world(ctx);
    const range = pl.range ?? (def && def.base && def.base.range);
    if (Number.isFinite(range) && range > 0 && range < 3000) {
      ctx.beginPath();
      ctx.arc(pl.x, pl.y, range, 0, TAU);
      ctx.fillStyle = P.rgba(col, 0.1);
      ctx.fill();
      ctx.lineWidth = 2.2;
      ctx.strokeStyle = P.rgba(col, 0.8);
      ctx.setLineDash([10, 6]);
      ctx.lineDashOffset = -this.time * 20;
      ctx.stroke();
      ctx.setLineDash([]);
    }
    const auraR = def && def.base && def.base.aura && def.base.aura.radius;
    if (auraR) this._ring(ctx, pl.x, pl.y, auraR, 0.8, '#ffd76a', true);
    // Footprint
    this._world(ctx);
    ctx.beginPath();
    ctx.arc(pl.x, pl.y, r * 1.05, 0, TAU);
    ctx.fillStyle = P.rgba(col, 0.25);
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = col;
    ctx.stroke();
    if (def) {
      const hero = P.isHeroDef(def);
      const art = this._towerArt(def, 0, hero);
      if (art) {
        const fr = def.radius || 22;
        ctx.globalAlpha = valid ? 0.75 : 0.45;
        this._spr(ctx, this._contactShadow(Math.round(fr)), pl.x + fr * 0.08, pl.y + fr * 0.2);
        ctx.globalAlpha = valid ? 0.9 : 0.55;
        this._spr(ctx, art.spr, pl.x, pl.y, art.rotates ? -Math.PI / 2 + art.rot0 : 0);
      } else {
        ctx.globalAlpha = valid ? 0.85 : 0.5;
        const S = this._towerSprites(def, 0, 0, hero, r);
        this._spr(ctx, S.base, pl.x, pl.y);
        this._spr(ctx, S.head, pl.x, pl.y, P.headRotates(def) ? -Math.PI / 2 : 0);
        if (S.spinner) this._spr(ctx, S.spinner, pl.x, pl.y, this.time);
        if (S.gloss) this._spr(ctx, S.gloss, pl.x, pl.y);
      }
      ctx.globalAlpha = 1;
    }
    if (!valid) {
      this._world(ctx);
      ctx.lineWidth = 4;
      ctx.strokeStyle = '#ff4d5d';
      ctx.beginPath();
      ctx.moveTo(pl.x - r * 0.55, pl.y - r * 0.55); ctx.lineTo(pl.x + r * 0.55, pl.y + r * 0.55);
      ctx.moveTo(pl.x + r * 0.55, pl.y - r * 0.55); ctx.lineTo(pl.x - r * 0.55, pl.y + r * 0.55);
      ctx.stroke();
    }
  }

  _drawScreenFx(ctx, st) {
    const cam = this.camera;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const calm = this.settings.reducedMotion ? 0.35 : 1;
    if (this.leakFlash > 0.01) {
      const W = cam.w, H = cam.h;
      const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.hypot(W, H) * 0.6);
      g.addColorStop(0, 'rgba(255,40,60,0)');
      g.addColorStop(1, `rgba(255,40,60,${(0.45 * this.leakFlash * calm).toFixed(3)})`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    }
    if (this.whiteFlash > 0.01) {
      ctx.fillStyle = `rgba(255,250,240,${(0.7 * this.whiteFlash * this.whiteFlash * calm * calm).toFixed(3)})`;
      ctx.fillRect(0, 0, cam.w, cam.h);
    }
    if (st.phase === 'over') {
      ctx.fillStyle = 'rgba(10,4,12,0.35)';
      ctx.fillRect(0, 0, cam.w, cam.h);
    }
  }
}

function roundRectPath(ctx, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Diagonal red hatch tile for the no-build overlay (device px, not world units).
function makeHatch() {
  const S = 14;
  const c = document.createElement('canvas');
  c.width = S; c.height = S;
  const g = c.getContext('2d');
  g.strokeStyle = 'rgba(255,120,135,0.26)';
  g.lineWidth = 3;
  g.beginPath();
  for (let i = -1; i <= 1; i++) { g.moveTo(i * S, S); g.lineTo(i * S + S, 0); }
  g.stroke();
  return c;
}

// Soft screen vignette on a small canvas; stretched to the view each frame.
function makeVignette() {
  const S = 128;
  const c = document.createElement('canvas');
  c.width = S; c.height = S;
  const g = c.getContext('2d');
  const vg = g.createRadialGradient(S / 2, S / 2, S * 0.36, S / 2, S / 2, S * 0.74);
  vg.addColorStop(0, 'rgba(0,0,0,0)');
  vg.addColorStop(0.6, 'rgba(0,0,0,0.14)');
  vg.addColorStop(1, 'rgba(0,0,0,0.42)');
  g.fillStyle = vg;
  g.fillRect(0, 0, S, S);
  return c;
}

function fmtCash(v) {
  const a = Math.abs(v);
  if (a >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (a >= 1e4) return (v / 1e3).toFixed(1) + 'k';
  if (a >= 10) return String(Math.floor(v));
  return (Math.floor(v * 10) / 10).toString();
}

// ---------------------------------------------------------------------------
// UI icon helpers (draw straight into any 2D context, centered in a size x size box
// at the context's current transform). `assets` (optional) lets image art replace the
// procedural icon when the manifest has it.
// ---------------------------------------------------------------------------

function drawImageIcon(ctx, spec, size, fill = 0.92) {
  const img = spec && spec.img;
  if (!img) return false;
  const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
  if (!iw || !ih) return false;
  const s = (size * fill) / Math.max(iw, ih);
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, (size - iw * s) / 2, (size - ih * s) / 2, iw * s, ih * s);
  ctx.restore();
  return true;
}
function assetGet(assets, key) {
  try { return assets && assets.get ? assets.get(key) : null; } catch { return null; }
}

// Map card preview: the real terrain, channel, blockers, Core and portals, rendered with the
// same static-layer code as the game into `canvas` at cssW x cssH (world fit to cover).
export function renderMapPreview(canvas, map, cssW, cssH, assets = null) {
  if (!canvas || !map) return false;
  const dpr = Math.min(2, Math.max(1, (typeof window !== 'undefined' && window.devicePixelRatio) || 1));
  const W = Math.max(2, Math.round(cssW * dpr)), H = Math.max(2, Math.round(cssH * dpr));
  canvas.width = W; canvas.height = H;
  const k = Math.max(W / WORLD_W, H / WORLD_H);
  const x0 = (WORLD_W - W / k) / 2, y0 = (WORLD_H - H / k) / 2;
  const frame = { x0, y0, x1: x0 + W / k, y1: y0 + H / k, k, dpr };
  const A = assets || EMPTY_ASSETS;
  const lanes = buildLanes(null, map);
  const portals = placePortals(lanes, frame, ((map.pathWidth || 56) * 0.9));
  const s = buildStaticLayer({ map, lanes, frame, assets: A, portals });
  const ctx = canvas.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(s.canvas, 0, 0);
  ctx.setTransform(k, 0, 0, k, -x0 * k, -y0 * k);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  const draw = (key, x, y, size, fallback) => {
    const spec = A.get && A.get(key);
    if (spec && spec.img) {
      const img = spec.img;
      const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
      const f = size / Math.max(iw, ih);
      ctx.drawImage(img, x - (iw * f) / 2, y - (ih * f) / 2, iw * f, ih * f);
    } else fallback();
  };
  const pal = map.palette || {};
  for (const p of portals) {
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.globalCompositeOperation = 'lighter';
    P.drawGlow(ctx, 90, pal.portal || '#b86bff', 0, 0.7);
    ctx.restore();
    draw('portal', p.x, p.y, (map.pathWidth || 56) * 1.9, () => {
      ctx.save(); ctx.translate(p.x, p.y); P.drawPortalSwirl(ctx, (map.pathWidth || 56) * 0.78, pal.portal || '#b86bff', pal.edge || '#6ee7ff', 4); ctx.restore();
    });
  }
  const c = map.core;
  if (c) {
    ctx.save();
    ctx.translate(c.x, c.y);
    ctx.globalCompositeOperation = 'lighter';
    P.drawGlow(ctx, CORE_R * 2.2, pal.edge || '#6ee7ff', 0, 0.6);
    ctx.restore();
    draw('core', c.x, c.y, CORE_R * 2.4, () => {
      ctx.save(); ctx.translate(c.x, c.y); P.drawCoreOrb(ctx, CORE_R, P.mix(pal.edge || '#6ee7ff', '#ffffff', 0.3), P.shade(pal.edge || '#6ee7ff', -0.45)); ctx.restore();
    });
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  s.canvas.width = 1; s.canvas.height = 1;
  return true;
}

// variant: 0 base, 1..3 = path A/B/C tier 3+ look.
export function drawTowerIcon(ctx, towerDef, size, variant = 0, assets = null) {
  if (!ctx || !towerDef) return;
  const hero = P.isHeroDef(towerDef);
  if (assets) {
    const keys = hero ? ['hero_' + towerDef.id] : [];
    if (!hero) {
      const pre = [towerDef.art && towerDef.art.sprite, 'tower_' + towerDef.id, SPRITE_ALIAS[towerDef.id]].filter(Boolean);
      for (const v of variant ? [variant, 0] : [0]) for (const p of pre) keys.push(p + '_' + v);
    }
    for (const k of keys) { const spec = assetGet(assets, k); if (spec && drawImageIcon(ctx, spec, size)) return; }
  }
  const r = towerDef.radius || 22;
  const tier = variant ? 3 : 0;
  const st = { variant, tier, hero };
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  P.iconTransform(ctx, size, r * 1.22, 0.04);
  P.drawTowerBase(ctx, towerDef, r, st);
  const rot = P.headRotates(towerDef) ? -Math.PI / 4 : 0;
  ctx.save();
  ctx.rotate(rot);
  P.drawTowerHead(ctx, towerDef, r, st);
  ctx.restore();
  const style = P.headStyle(towerDef);
  if (P.hasSpinner(style)) { ctx.save(); ctx.rotate(0.4); P.drawTowerSpinner(ctx, towerDef, r, st); ctx.restore(); }
  if (ROUND_HEADS.has(style)) P.drawHeadGloss(ctx, r);
  ctx.restore();
}

// Commander icon. Small icons (under 68 px) show a head-and-shoulders portrait cropped from
// the figure art, which reads far better at tile size than a tiny full figure.
export function drawHeroIcon(ctx, heroDef, size, assets = null) {
  if (!ctx || !heroDef) return;
  const def = P.isHeroDef(heroDef) ? heroDef : { ...heroDef, hero: true };
  const spec = assetGet(assets, 'hero_' + def.id) || (def.art && def.art.sprite ? assetGet(assets, def.art.sprite) : null);
  if (spec && spec.img && size < 68) {
    const img = spec.img;
    const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
    if (iw && ih) {
      const m = imageMeta(spec);
      const [bx0, by0, bx1, by1] = m.box;
      const side = Math.min(1, Math.max(bx1 - bx0, (by1 - by0) * 0.5));
      const cx = (bx0 + bx1) / 2 * 0.4 + m.pivot.x * 0.6;
      const sx = Math.max(0, Math.min(1 - side, cx - side / 2));
      const sy = Math.max(0, by0 - side * 0.04);
      ctx.save();
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, sx * iw, sy * ih, side * iw, side * ih, 0, 0, size, size);
      ctx.restore();
      return;
    }
  }
  drawTowerIcon(ctx, def, size, 0, assets);
}

export function drawTitanIcon(ctx, kind, size, assets = null) {
  if (!ctx) return;
  const spec = assetGet(assets, 'titan_' + kind);
  if (spec && drawImageIcon(ctx, spec, size)) return;
  const R = 60;
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  P.iconTransform(ctx, size, R * (kind === 'aegis' ? 1.32 : 1.22), 0.02);
  ctx.rotate(-Math.PI / 2);
  P.drawTitan(ctx, kind, R);
  if (kind === 'aegis') { ctx.globalAlpha = 0.7; P.drawShieldBubble(ctx, R * 1.28); }
  ctx.restore();
}

// mods: { phantom, nanite, plated }. Accepts meteor, ship and titan types ('maw', 'aegis', 'rift').
export function drawEnemyIcon(ctx, type, size, mods = {}, assets = null) {
  if (!ctx) return;
  mods = mods || {};
  if (TITAN_KINDS.has(type) || /^titan/.test(type)) {
    const kind = TITAN_KINDS.has(type) ? type : (String(type).replace(/^titan_?/, '') || 'maw');
    drawTitanIcon(ctx, TITAN_KINDS.has(kind) ? kind : 'maw', size, assets);
    return;
  }
  const def = ENEMIES[type];
  if (!def) return;
  const ship = def.kind === 'ship';
  const spec = assetGet(assets, (ship ? 'ship_' : 'enemy_') + type);
  if (spec) {
    ctx.save();
    if (mods.phantom || def.phantom) ctx.globalAlpha = 0.6;
    const ok = drawImageIcon(ctx, spec, size, ship ? 0.98 : 0.84);
    ctx.restore();
    if (ok) {
      if (!ship && (mods.plated || mods.nanite || mods.phantom)) {
        const r = def.radius || 12;
        ctx.save();
        P.iconTransform(ctx, size, r * 1.3, 0.03);
        if (mods.plated) P.drawPlatedRing(ctx, r);
        if (mods.nanite) P.drawNaniteSpecks(ctx, r);
        if (mods.phantom) P.drawPhantomRim(ctx, r);
        ctx.restore();
      }
      return;
    }
  }
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  if (ship) {
    const R = def.radius || 40;
    P.iconTransform(ctx, size, R * 1.12, 0.02);
    ctx.rotate(-Math.PI / 4);
    if (mods.phantom || def.phantom) ctx.globalAlpha = 0.8;
    P.drawShip(ctx, type, R, def.color);
  } else {
    const r = def.radius || 12;
    P.iconTransform(ctx, size, r * (mods.plated ? 1.3 : 1.2), 0.03);
    if (type === 'comet') {
      ctx.save();
      ctx.rotate(-Math.PI * 0.75);
      ctx.globalAlpha = 0.9;
      P.drawCometTail(ctx, r * 0.9);
      ctx.restore();
    }
    P.drawMeteor(ctx, type, r, { rot: 0.3, phantom: !!mods.phantom, nanite: !!mods.nanite, plated: !!mods.plated, color: def.color, hue: 200 });
  }
  ctx.restore();
}
