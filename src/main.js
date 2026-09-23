// SHARDSTORM client: boot, asset preload, screen routing, the fixed-step main loop,
// persistence hooks and the window.__ss debug surface (docs/ARCHITECTURE.md section 9).

import * as storage from './persist/storage.js';
import { UI } from './ui/ui.js';
import { Screens } from './ui/screens.js';
import { Input } from './ui/input.js';
import { friendlyReason, esc, icon } from './ui/format.js';
import { MAPS, MAP_ORDER } from './data/maps.js';
import { ENEMIES } from './data/enemies.js';
import { DIFFICULTIES, TICK } from './data/economy.js';

const params = new URLSearchParams(location.search);
const DEBUG = params.get('debug') === '1';
const MAX_STEPS = 12;
const SPEEDS = [1, 2, 3];
// Titan death: a short slow-motion beat. Holds 0.3x for SLOWMO_HOLD s of real time, then eases
// back to full speed over SLOWMO_EASE s.
const SLOWMO_HOLD = 0.6;
const SLOWMO_EASE = 0.25;
const SLOWMO_TIME = SLOWMO_HOLD + SLOWMO_EASE;
const SLOWMO_RATE = 0.3;

function okOf(r) {
  if (r == null) return false;
  if (typeof r === 'object') return !!r.ok;
  return !!r;
}

async function optionalImport(path) {
  try {
    return await import(path);
  } catch (err) {
    console.error(`[shardstorm] could not load ${path}:`, err);
    return null;
  }
}

function withTimeout(promise, ms, fallback) {
  return Promise.race([promise, new Promise((r) => setTimeout(() => r(fallback), ms))]);
}

function media(q) {
  try { return window.matchMedia(q); } catch { return { matches: false, addEventListener() {} }; }
}

// ---------------------------------------------------------------------------- icon painting

function paint(canvas, size, draw, fallback) {
  if (!canvas) return;
  const dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
  const px = Math.round(size * dpr);
  if (canvas.width !== px) canvas.width = px;
  if (canvas.height !== px) canvas.height = px;
  canvas.style.width = size + 'px';
  canvas.style.height = size + 'px';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, px, px);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.save();
  try {
    if (!draw) throw new Error('no painter');
    draw(ctx);
  } catch (err) {
    if (draw && !paint._warned) { paint._warned = true; console.warn('[shardstorm] icon painter failed, using fallback art', err); }
    ctx.restore();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, px, px);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.save();
    try { fallback(ctx); } catch { /* ignore */ }
  }
  ctx.restore();
}

function fallbackTower(ctx, def, size) {
  const c = def?.art?.color || '#4cc9f0', a = def?.art?.accent || '#f9c74f';
  const r = size * 0.4, cx = size / 2, cy = size / 2;
  ctx.beginPath();
  for (let i = 0; i < 6; i++) { const t = Math.PI / 6 + i * Math.PI / 3; ctx.lineTo(cx + Math.cos(t) * r, cy + Math.sin(t) * r); }
  ctx.closePath();
  const g = ctx.createLinearGradient(0, 0, size, size);
  g.addColorStop(0, '#ffffff');
  g.addColorStop(0.3, c);
  g.addColorStop(1, '#10162a');
  ctx.fillStyle = g;
  ctx.fill();
  ctx.lineWidth = Math.max(1.5, size * 0.05);
  ctx.strokeStyle = '#0a0d1a';
  ctx.stroke();
  ctx.fillStyle = a;
  ctx.beginPath(); ctx.arc(cx, cy, r * 0.38, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
}

function fallbackEnemy(ctx, type, size, mods) {
  const d = ENEMIES[type] || {};
  const c = d.color || '#ff4d4d';
  const cx = size / 2, cy = size / 2;
  if (d.kind === 'ship') {
    const r = size * 0.42;
    ctx.fillStyle = c;
    ctx.strokeStyle = '#0a0d1a';
    ctx.lineWidth = Math.max(1.5, size * 0.05);
    ctx.beginPath();
    ctx.moveTo(cx + r, cy); ctx.lineTo(cx - r * 0.3, cy - r * 0.62); ctx.lineTo(cx - r, cy - r * 0.35);
    ctx.lineTo(cx - r, cy + r * 0.35); ctx.lineTo(cx - r * 0.3, cy + r * 0.62); ctx.closePath();
    ctx.fill(); ctx.stroke();
  } else {
    const r = size * 0.36;
    const g = ctx.createLinearGradient(cx - r, cy - r, cx + r, cy + r);
    g.addColorStop(0, '#ffffff');
    g.addColorStop(0.3, d.glow && d.color && d.color < '#444444' ? d.glow : c);
    g.addColorStop(1, '#101020');
    ctx.fillStyle = g;
    ctx.beginPath();
    for (let i = 0; i < 7; i++) { const t = i / 7 * Math.PI * 2; const rr = r * (i % 2 ? 0.86 : 1); ctx.lineTo(cx + Math.cos(t) * rr, cy + Math.sin(t) * rr); }
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = '#0a0d1a'; ctx.lineWidth = Math.max(1.2, size * 0.05); ctx.stroke();
  }
  if (mods?.phantom) { ctx.globalCompositeOperation = 'destination-out'; ctx.fillStyle = 'rgba(0,0,0,0.45)'; ctx.fillRect(0, 0, size, size); ctx.globalCompositeOperation = 'source-over'; }
}

function fallbackTitan(ctx, kind, size) {
  const cx = size / 2, cy = size / 2, r = size * 0.44;
  const col = { maw: '#ff5470', aegis: '#5fd4ff', rift: '#b48cff' }[kind] || '#ff5470';
  ctx.fillStyle = '#12101f';
  ctx.strokeStyle = col;
  ctx.lineWidth = Math.max(2, size * 0.05);
  ctx.beginPath();
  for (let i = 0; i < 12; i++) { const t = i / 12 * Math.PI * 2; const rr = r * (i % 2 ? 0.62 : 1); ctx.lineTo(cx + Math.cos(t) * rr, cy + Math.sin(t) * rr); }
  ctx.closePath(); ctx.fill(); ctx.stroke();
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r * 0.5);
  g.addColorStop(0, '#ffffff'); g.addColorStop(0.4, col); g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(cx, cy, r * 0.5, 0, Math.PI * 2); ctx.fill();
}

function fallbackHero(ctx, def, size) {
  const cx = size / 2, cy = size / 2, r = size * 0.42;
  const c = def?.art?.color || '#ffb547';
  const g = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.3, 1, cx, cy, r);
  g.addColorStop(0, '#ffffff'); g.addColorStop(0.35, c); g.addColorStop(1, '#221633');
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
  ctx.lineWidth = Math.max(1.5, size * 0.05); ctx.strokeStyle = '#0a0d1a'; ctx.stroke();
  ctx.fillStyle = '#0a0d1a';
  ctx.font = `700 ${Math.round(size * 0.42)}px "Chakra Petch", system-ui, sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(String(def?.name || '?').replace(/^Captain\s+/i, '').charAt(0).toUpperCase(), cx, cy + size * 0.02);
}

// ---------------------------------------------------------------------------- audio stub

class SilentAudio {
  unlock() {} setVolumes() {} onEvents() {} startMusic() {} stopMusic() {} setIntensity() {} click() {} hover() {}
}

// ---------------------------------------------------------------------------- game

class Game {
  constructor() {
    this.settings = storage.loadSettings();
    this.canvas = document.getElementById('view');
    this.app = document.getElementById('app');
    this.gameEl = document.getElementById('game');
    this.data = {
      MAPS, MAP_ORDER: MAP_ORDER.filter((id) => MAPS[id]), ENEMIES, DIFFICULTIES,
      TOWERS: {}, TOWER_ORDER: [], HEROES: {}, HERO_ORDER: [],
    };
    this.images = {};
    this.SimClass = null;
    this.renderer = null;
    this.audio = new SilentAudio();
    this.sim = null;
    this.inGame = false;
    this.over = false;
    this.paused = false;
    this.speed = 1;
    this.acc = 0;
    this.run = null;
    this.pointerWorld = null;
    this.hotkeys = {};
    this.speedKey = 'f';
    this.heroHotkey = true;
    this.isTouch = media('(pointer: coarse)').matches;
    this.reducedMotion = media('(prefers-reduced-motion: reduce)').matches;
    this.layout = 'wide';
    this.fps = 60;
    this.frameMs = 16.7;
    this.lastSteps = 0;
    this.slowMo = 0;
    this._last = 0;
    this._frameN = 0;
    this._errors = 0;
    this._audioUnlocked = false;
    this._frame = (t) => this.frame(t);
  }

  // ------------------------------------------------------------------ boot

  async boot() {
    this._lockPageZoom();
    const bootEl = document.getElementById('boot');
    const bar = bootEl?.querySelector('.boot__bar i');
    const setProgress = (f) => { if (bar) bar.style.transform = `scaleX(${Math.max(0.05, Math.min(1, f))})`; };
    setProgress(0.1);

    const [simMod, renderMod, spritesMod, procMod, audioMod, towersMod, heroesMod] = await Promise.all([
      optionalImport('./sim/game.js'),
      optionalImport('./render/renderer.js'),
      optionalImport('./render/sprites.js'),
      optionalImport('./render/procedural.js'),
      optionalImport('./audio/audio.js'),
      optionalImport('./data/towers/index.js'),
      optionalImport('./data/heroes.js'),
    ]);
    setProgress(0.35);

    this.SimClass = simMod?.Sim || null;
    if (towersMod) {
      this.data.TOWERS = towersMod.TOWERS || {};
      this.data.TOWER_ORDER = (towersMod.TOWER_ORDER || Object.keys(this.data.TOWERS)).filter((id) => this.data.TOWERS[id]);
    }
    if (heroesMod) {
      this.data.HEROES = heroesMod.HEROES || {};
      this.data.HERO_ORDER = (heroesMod.HERO_ORDER || Object.keys(this.data.HEROES)).filter((id) => this.data.HEROES[id]);
    }
    this._buildHotkeys();

    // assets (never blocks for long; everything has procedural fallbacks)
    let assets = null;
    if (spritesMod?.loadAssets) {
      assets = await withTimeout(
        spritesMod.loadAssets({ timeout: 6000, onProgress: (n, t) => setProgress(0.35 + 0.6 * (t ? n / t : 1)) }).catch(() => null),
        7000, null);
    }
    this.assets = assets || spritesMod?.EMPTY_ASSETS || null;
    const img = (k) => { try { return this.assets?.image?.(k) || null; } catch { return null; } };
    this.images = { keyart: img('keyart'), logo: img('logo') };
    for (const id of this.data.MAP_ORDER) this.images['map_' + id] = null; // previews stay procedural (cleaner at card size)

    // icon painters (the renderer owns the art; fallbacks keep menus working without it)
    const pick = (name) => renderMod?.[name] || spritesMod?.[name] || procMod?.[name] || null;
    const drawTowerIcon = pick('drawTowerIcon');
    const drawEnemyIcon = pick('drawEnemyIcon');
    const drawHeroIcon = pick('drawHeroIcon');
    const drawTitanIcon = pick('drawTitanIcon');
    this.renderMapPreview = renderMod?.renderMapPreview || null;
    const A = this.assets;
    this.icons = {
      tower: (c, def, size, variant = 0) => paint(c, size,
        drawTowerIcon ? (ctx) => drawTowerIcon(ctx, def, size, variant, A) : null,
        (ctx) => fallbackTower(ctx, def, size)),
      enemy: (c, type, size, mods = {}) => paint(c, size,
        drawEnemyIcon ? (ctx) => drawEnemyIcon(ctx, type, size, mods || {}, A) : null,
        (ctx) => fallbackEnemy(ctx, type, size, mods)),
      hero: (c, def, size) => paint(c, size,
        drawHeroIcon ? (ctx) => drawHeroIcon(ctx, def, size, A)
          : drawTowerIcon ? (ctx) => drawTowerIcon(ctx, def, size, 0, A) : null,
        (ctx) => fallbackHero(ctx, def, size)),
      titan: (c, kind, size) => paint(c, size,
        drawTitanIcon ? (ctx) => drawTitanIcon(ctx, kind, size, A)
          : procMod?.drawTitan && procMod?.iconTransform ? (ctx) => { procMod.iconTransform(ctx, size, 100, 0.04); procMod.drawTitan(ctx, kind, 88); } : null,
        (ctx) => fallbackTitan(ctx, kind, size)),
    };

    // renderer
    if (renderMod?.Renderer) {
      try {
        this.renderer = new renderMod.Renderer(this.canvas, this.assets);
        if (typeof this.renderer.setDefs === 'function') this.renderer.setDefs({ towers: this.data.TOWERS, heroes: this.data.HEROES });
        this._applyRendererSettings();
      } catch (err) {
        console.error('[shardstorm] renderer failed to start', err);
        this.renderer = null;
      }
    }
    if (audioMod?.Audio) {
      try { this.audio = new audioMod.Audio(); } catch (err) { console.error('[shardstorm] audio failed', err); this.audio = new SilentAudio(); }
    }
    this.audio.setVolumes({ sfx: this.settings.sfx, music: this.settings.music });

    // UI
    this.ui = new UI(this);
    this.screens = new Screens(this);
    if (this.images.keyart) this.screens.sky.setImage(this.images.keyart);
    this.input = new Input(this);
    this.input.attach();
    this._watchLayout();
    this._watchLifecycle();
    this._installDebug();
    this._globalUiSounds();

    setProgress(1);
    if (bootEl) {
      bootEl.classList.add('done');
      setTimeout(() => bootEl.remove(), 400);
    }
    if (!this.SimClass || !this.renderer) {
      this._fatal(!this.SimClass ? 'The simulation module did not load.' : 'The renderer did not load.');
    }
    this.screens.show('title', {}, { reset: true });
    this._last = performance.now();
    requestAnimationFrame(this._frame);
    if (params.get('quick')) this.debugQuickStart(params.get('quick'), params.get('diff') || 'pilot', params.get('hero') || null);
  }

  _fatal(msg) {
    const box = document.createElement('div');
    box.className = 'fatal';
    box.setAttribute('role', 'alert');
    box.innerHTML = `${icon('info')}<div><b>SHARDSTORM could not start.</b><span>${esc(msg)} Refresh the page to try again.</span></div>`;
    document.body.appendChild(box);
  }

  _buildHotkeys() {
    this.hotkeys = {};
    for (const id of this.data.TOWER_ORDER) {
      const k = (this.data.TOWERS[id].hotkey || '').toLowerCase();
      if (k && !this.hotkeys[k]) this.hotkeys[k] = id;
    }
    // F cycles speed unless a tower claims it; then fall back to the first free key.
    const reserved = new Set(['p', 'u', ',', '.', '/', ' ']);
    this.speedKey = ['f', 'z', 'x', 'v', 'b'].find((k) => !this.hotkeys[k] && !reserved.has(k)) || 'f';
    this.heroHotkey = !this.hotkeys.u;
  }

  /** Rows for the Controls list in Settings: [[keys], label]. */
  controls() {
    const towerKeys = this.data.TOWER_ORDER.map((id) => (this.data.TOWERS[id].hotkey || '').toUpperCase()).filter(Boolean);
    const rows = [];
    if (towerKeys.length) rows.push([towerKeys, 'Pick a tower to place']);
    if (this.data.HERO_ORDER.length && this.heroHotkey) rows.push([['U'], 'Deploy or select your commander']);
    rows.push(
      [['Click'], 'Place, or select a tower'],
      [['Shift', 'Click'], 'Place and keep placing'],
      [['Right click', 'Esc'], 'Cancel or deselect'],
      [[',', '.', '/'], 'Upgrade path A, B, C'],
      [['Tab'], 'Cycle targeting'],
      [['Delete'], 'Sell (press twice)'],
      [['Space'], 'Launch wave, or send the next one early'],
      [[this.speedKey.toUpperCase()], 'Cycle game speed'],
      [['P', 'Esc'], 'Pause'],
      [['1', '9'], 'Abilities'],
      [['Hold Shift'], 'Show every tower range'],
      [this.isTouch ? ['Pinch', 'Drag'] : ['Wheel', '+', '-'], this.isTouch ? 'Zoom and pan the map' : 'Zoom the map'],
      [['Drag'], 'Pan a zoomed map (or middle drag)'],
      [['0'], 'Fit the whole map'],
    );
    return rows;
  }

  // ------------------------------------------------------------------ settings

  updateSettings(patch) {
    Object.assign(this.settings, patch);
    storage.saveSettings(this.settings);
    if ('sfx' in patch || 'music' in patch) this.audio.setVolumes({ sfx: this.settings.sfx, music: this.settings.music });
    if ('autoStart' in patch && this.sim) {
      try { this.sim.setAutoStart(!!this.settings.autoStart); } catch { /* ignore */ }
    }
    this._applyRendererSettings();
  }

  _applyRendererSettings() {
    const r = this.renderer;
    if (!r) return;
    const s = { particles: this.settings.particles, shake: this.settings.shake, floatText: this.settings.floatText, reducedMotion: this.reducedMotion };
    try {
      if (typeof r.setSettings === 'function') r.setSettings(s);
      else if (r.settings && typeof r.settings === 'object') Object.assign(r.settings, s);
      else r.settings = s;
    } catch { /* ignore */ }
  }

  // ------------------------------------------------------------------ layout, lifecycle

  _watchLayout() {
    const q = media('(max-width: 899px), (orientation: portrait) and (max-width: 1100px)');
    const apply = () => {
      this.layout = q.matches ? 'compact' : 'wide';
      this.app.dataset.layout = this.layout;
      // phones held sideways: keep the map tall and move the drawer to the side
      const short = this.layout === 'compact' && window.innerWidth > window.innerHeight && window.innerHeight < 560;
      this.app.classList.toggle('is-short', short);
      this.ui?._hideTip();
      this._queueInsets();
    };
    apply();
    // The ability bar and the stage change size independently of the window.
    if (typeof ResizeObserver !== 'undefined') {
      try {
        const ro = new ResizeObserver(() => this._queueInsets());
        ro.observe(this.canvas);
        if (this.ui?.$abilities) ro.observe(this.ui.$abilities);
      } catch { /* ignore */ }
    }
    try { q.addEventListener('change', apply); } catch { /* old browsers */ }
    window.addEventListener('resize', apply);
    const rm = media('(prefers-reduced-motion: reduce)');
    try { rm.addEventListener('change', () => { this.reducedMotion = rm.matches; this._applyRendererSettings(); }); } catch { /* ignore */ }
    this.setTouch(this.isTouch);
  }

  setTouch(on) {
    if (this.isTouch === on && this.app.classList.contains('is-touch') === on) return;
    this.isTouch = on;
    this.app.classList.toggle('is-touch', on);
    this.ui?._updateTouchControls();
  }

  _watchLifecycle() {
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        if (this.sim && this.inGame && !this.over) {
          this.saveNow();
          if (!this.paused) this.pause();
        }
        this.flushTotals();
      }
    });
    window.addEventListener('pagehide', () => { this.saveNow(); this.flushTotals(); });
  }

  // iPad and iPhone Safari ignore user-scalable=no, so a stray double tap or pinch on the HUD
  // zoomed the whole page with no easy way back. CSS touch-action handles double tap; these
  // listeners stop Safari's pinch gestures. The playfield keeps its own zoom (src/ui/input.js),
  // which runs on pointer events and is unaffected.
  _lockPageZoom() {
    const block = (e) => { if (e.cancelable) e.preventDefault(); };
    for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
      document.addEventListener(type, block, { passive: false });
    }
    document.addEventListener('touchmove', (e) => { if (e.touches && e.touches.length > 1) block(e); }, { passive: false });
    document.addEventListener('dblclick', block, { passive: false });
  }

  _globalUiSounds() {
    document.addEventListener('click', (e) => {
      const b = e.target.closest?.('#hud button, #panel button, #overlay button');
      if (b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled) this.uiClick();
    });
    // iOS Safari only starts audio from touchend, click or keydown (never pointerdown or
    // touchstart), and can suspend it again after an app switch, so every gesture retries
    // until the context is running. Once running, unlock() is a cheap state check.
    const unlock = () => this.unlockAudio();
    for (const type of ['pointerdown', 'pointerup', 'touchend', 'click', 'keydown']) {
      window.addEventListener(type, unlock, { capture: true, passive: true });
    }
  }

  unlockAudio() {
    try {
      this.audio.unlock();
      if (!this._audioUnlocked) {
        this._audioUnlocked = true;
        this.audio.setVolumes({ sfx: this.settings.sfx, music: this.settings.music });
        this.audio.startMusic();
      }
    } catch { /* ignore */ }
  }

  uiClick() {
    try { this.audio.click?.(); } catch { /* ignore */ }
  }

  uiHover() {
    try { this.audio.hover?.(); } catch { /* ignore */ }
  }

  notify(msg, kind = 'info') {
    if (this.inGame && this.ui) { this.ui.toast(msg, kind); return; }
    let box = document.getElementById('notice');
    if (!box) {
      box = document.createElement('div');
      box.id = 'notice';
      box.className = 'notice';
      box.setAttribute('role', 'status');
      document.body.appendChild(box);
    }
    box.textContent = msg;
    box.classList.remove('on');
    void box.offsetWidth;
    box.classList.add('on');
    clearTimeout(this._noticeT);
    this._noticeT = setTimeout(() => box.classList.remove('on'), 3200);
  }

  // ------------------------------------------------------------------ coordinates

  screenToWorld(px, py) {
    const r = this.renderer;
    if (r?.screenToWorld) {
      const p = r.screenToWorld(px, py);
      return Array.isArray(p) ? { x: p[0], y: p[1] } : p;
    }
    const w = this.canvas.clientWidth || 1, h = this.canvas.clientHeight || 1;
    const s = Math.min(w / 1500, h / 1000);
    return { x: (px - (w - 1500 * s) / 2) / s, y: (py - (h - 1000 * s) / 2) / s };
  }

  worldToScreen(x, y) {
    const r = this.renderer;
    if (r?.worldToScreen) {
      const p = r.worldToScreen(x, y);
      return Array.isArray(p) ? { x: p[0], y: p[1] } : p;
    }
    const w = this.canvas.clientWidth || 1, h = this.canvas.clientHeight || 1;
    const s = Math.min(w / 1500, h / 1000);
    return { x: (w - 1500 * s) / 2 + x * s, y: (h - 1000 * s) / 2 + y * s };
  }

  /** Back to the whole-map view. */
  resetView() {
    if (this.renderer?.resetView?.()) this.onViewChange();
  }

  /** Called after any zoom or pan (input.js). */
  onViewChange() {
    this.ui?._hideTip();
  }

  _queueInsets() {
    if (this._insetsQueued) return;
    this._insetsQueued = true;
    requestAnimationFrame(() => { this._insetsQueued = false; this._updateInsets(); });
  }

  /**
   * Keep the world clear of overlays that sit on the canvas for good (the ability bar). The
   * world only shifts into free letterbox space, it never shrinks, so the map keeps its size;
   * when zoomed in, the same insets let the player pan the world edge out from under the bar.
   */
  _updateInsets() {
    const r = this.renderer;
    if (!r?.setInsets) return;
    const ins = { top: 0, right: 0, bottom: 0, left: 0 };
    const bar = this.inGame ? this.ui?.$abilities : null;
    if (bar && bar.childElementCount && bar.offsetParent !== null) {
      const st = this.canvas.getBoundingClientRect();
      const br = bar.getBoundingClientRect();
      if (st.width > 0 && st.height > 0 && br.width > 0) {
        const fit = Math.min(st.width / 1500, st.height / 1000);
        const freeV = st.height - 1000 * fit, freeH = st.width - 1500 * fit;
        const coverB = Math.max(0, st.bottom - br.top + 6);
        const coverR = Math.max(0, st.right - br.left + 6);
        if (freeV >= freeH) ins.bottom = Math.floor(Math.min(coverB, freeV));
        else ins.right = Math.floor(Math.min(coverR, freeH));
      }
    }
    r.setInsets(ins);
  }

  /** CSS px per world unit. */
  worldScale() {
    const a = this.worldToScreen(0, 0), b = this.worldToScreen(100, 0);
    return (b.x - a.x) / 100;
  }

  canvasCenterWorld() {
    const w = this.canvas.clientWidth || 1, h = this.canvas.clientHeight || 1;
    const p = this.screenToWorld(w / 2, h / 2);
    return { x: Math.max(40, Math.min(1460, p.x)), y: Math.max(40, Math.min(960, p.y)) };
  }

  // ------------------------------------------------------------------ runs

  startNew({ mapId, difficulty = 'pilot', heroId = null } = {}) {
    if (!this.SimClass) { this.notify('The game could not load. Refresh to try again.', 'bad'); return false; }
    mapId = MAPS[mapId] ? mapId : this.data.MAP_ORDER[0];
    difficulty = DIFFICULTIES[difficulty] ? difficulty : 'pilot';
    heroId = heroId && this.data.HEROES[heroId] ? heroId : null;
    const seed = (Math.random() * 0x100000000) >>> 0;
    let sim;
    try {
      sim = new this.SimClass({ mapId, difficulty, seed, heroId });
    } catch (err) {
      console.error('[shardstorm] could not start a run', err);
      this.notify('That run could not start.', 'bad');
      return false;
    }
    if (this.sim) this._leaveGame();
    storage.clearRun();
    storage.addTotals({ runs: 1 });
    this._enter(sim);
    return true;
  }

  continueRun() {
    const save = storage.loadRun();
    if (!save || !this.SimClass) return false;
    let sim;
    try {
      sim = this.SimClass.fromSave(save.data);
    } catch (err) {
      console.error('[shardstorm] save could not be restored', err);
      storage.clearRun();
      this.notify('That save could not be restored, so it was cleared.', 'bad');
      this.screens.refresh();
      return false;
    }
    if (this.sim) this._leaveGame();
    this._enter(sim);
    if (save.meta?.debug) this.run.debug = true;
    return true;
  }

  restart() {
    const cfg = this.run?.config;
    if (!cfg) return;
    this.flushTotals();
    this.startNew(cfg);
  }

  _enter(sim) {
    const s = sim.state;
    this.sim = sim;
    this.over = false;
    this.paused = false;
    this.speed = 1;
    this.acc = 0;
    this.slowMo = 0;
    const startBest = storage.bestWave(s.mapId, s.difficulty);
    this.run = {
      config: { mapId: s.mapId, difficulty: s.difficulty, heroId: s.heroId || null },
      startBest,
      best: Math.max(startBest, s.cleared || 0),
      time: 0,
      flushed: { pops: s.stats?.pops || 0, time: 0, titans: 0, leaks: s.stats?.leaks || 0 },
      titans: 0,
      pendingSave: false,
      lastSaveCleared: s.cleared || 0,
    };
    try { sim.setAutoStart(!!this.settings.autoStart); } catch { /* ignore */ }
    this.updateSettings({ lastMap: s.mapId, lastDifficulty: s.difficulty });
    this.inGame = true;
    this.gameEl.hidden = false;
    this.app.classList.add('in-game');
    this.screens.closeAll();
    try { this.renderer?.setMap(sim); } catch (err) { console.error('[shardstorm] setMap failed', err); }
    this.ui.bind(sim);
    this._queueInsets();
    this.unlockAudio();
    try { this.audio.startMusic(); this.audio.setIntensity(0.1); } catch { /* ignore */ }
    this._last = performance.now();
    try { this.canvas.focus({ preventScroll: true }); } catch { /* ignore */ }
  }

  _leaveGame() {
    this.sim = null;
    this.inGame = false;
    this.over = false;
    this.paused = false;
    this.ui.unbind();
    this.gameEl.hidden = true;
    this.app.classList.remove('in-game');
    try { this.audio.setIntensity(0); } catch { /* ignore */ }
  }

  quitToTitle(next = 'title') {
    if (this.sim && !this.over) this.saveNow();
    this.flushTotals();
    this._leaveGame();
    this.screens.show('title', {}, { reset: true });
    if (next === 'maps') this.screens.show('maps');
  }

  /** Saves the run when the sim is in its build phase (the only phase serialize supports). */
  saveNow() {
    const sim = this.sim;
    if (!sim || this.over) return false;
    const s = sim.state;
    if (s.phase !== 'build') return false;
    try {
      const data = sim.serialize();
      storage.saveRun(data, {
        mapId: s.mapId, difficulty: s.difficulty, heroId: s.heroId || null,
        wave: s.wave, cleared: s.cleared, lives: s.lives, cash: Math.floor(s.cash),
        debug: !!this.run.debug,
      });
      this.run.pendingSave = false;
      this.run.lastSaveCleared = s.cleared;
      return true;
    } catch (err) {
      console.warn('[shardstorm] autosave failed', err);
      return false;
    }
  }

  /** Adds lifetime totals accumulated since the last flush. */
  flushTotals() {
    const run = this.run;
    const sim = this.sim;
    if (!run || !sim) return;
    const st = sim.state.stats || {};
    const pops = Math.max(0, (st.pops || 0) - run.flushed.pops);
    const time = Math.max(0, run.time - run.flushed.time);
    const titans = Math.max(0, run.titans - run.flushed.titans);
    const leaks = Math.max(0, (st.leaks || 0) - run.flushed.leaks);
    run.flushed = { pops: st.pops || 0, time: run.time, titans: run.titans, leaks: st.leaks || 0 };
    if (pops || time || titans || leaks) storage.addTotals({ pops, time, titans, leaks });
  }

  _onWaveCleared(ev) {
    const sim = this.sim;
    const s = sim.state;
    storage.addTotals({ waves: 1 });
    this.flushTotals();
    if (!this.run.debug) storage.submitBest(s.mapId, s.difficulty, s.cleared);
    this.run.best = Math.max(this.run.best, s.cleared || 0);
    this.run.pendingSave = true;
    this.saveNow();
  }

  _gameOver() {
    if (this.over || !this.sim) return;
    this.over = true;
    const sim = this.sim;
    const s = sim.state;
    this.ui.cancelPlacing();
    this.ui.deselect();
    storage.clearRun();
    this.flushTotals();
    if (!this.run.debug) storage.submitBest(s.mapId, s.difficulty, s.cleared);
    const best = storage.bestWave(s.mapId, s.difficulty);
    const p = {
      mapId: s.mapId, difficulty: s.difficulty,
      wave: s.wave, cleared: s.cleared || 0, best,
      newBest: !this.run.debug && (s.cleared || 0) > this.run.startBest && (s.cleared || 0) > 0,
      stats: { ...(s.stats || {}) },
      time: this.run.time,
    };
    try { this.audio.setIntensity(0); } catch { /* ignore */ }
    setTimeout(() => {
      if (this.sim === sim && this.over) this.screens.show('gameover', p, { reset: true });
    }, this.reducedMotion ? 600 : 1700);
  }

  // ------------------------------------------------------------------ commands from UI and input

  setSpeed(n) {
    if (!SPEEDS.includes(n)) return;
    this.speed = n;
  }

  cycleSpeed(quiet = false) {
    const i = SPEEDS.indexOf(this.speed);
    this.speed = SPEEDS[(i + 1) % SPEEDS.length];
    if (!quiet) this.ui.toast(`Speed ${this.speed}x`, 'info');
  }

  toggleAuto() {
    const v = !(this.sim?.state?.autoStart ?? this.settings.autoStart);
    this.updateSettings({ autoStart: v });
    this.ui.toast(v ? 'Auto-start on' : 'Auto-start off', 'info');
  }

  pause() {
    if (!this.sim || this.over || !this.inGame) return;
    this.paused = true;
    this.ui._hideTip();
    this.screens.show('pause', {}, { reset: true });
  }

  resume() {
    if (!this.sim) return;
    this.paused = false;
    this.screens.closeAll();
    this._last = performance.now();
  }

  launchWave() {
    const sim = this.sim;
    if (!sim || this.over || this.paused) return;
    let can = false;
    try { can = okOf(sim.canStartWave()); } catch { can = false; }
    if (!can) {
      if (sim.state.phase === 'wave') this.ui.toast('Wait for the last spawn of this wave', 'info');
      return;
    }
    if (sim.state.phase === 'build') this.saveNow();
    let r;
    try { r = sim.startWave(); } catch (err) { console.error(err); r = { ok: false, reason: 'invalid' }; }
    if (!okOf(r)) this.ui.toast(friendlyReason(r?.reason), 'bad');
  }

  useAbility(id) {
    const sim = this.sim;
    if (!sim || this.over || this.paused) return;
    let r;
    try { r = sim.useAbility(id); } catch (err) { console.error(err); r = { ok: false }; }
    if (!okOf(r)) this.ui.toast(r?.reason ? friendlyReason(r.reason) : 'Still recharging', 'bad');
  }

  // ------------------------------------------------------------------ main loop

  frame(now) {
    requestAnimationFrame(this._frame);
    const rawDt = Math.max(0, (now - this._last) / 1000);
    this._last = now;
    const dt = Math.min(rawDt, 0.25);
    this.frameMs = this.frameMs * 0.9 + rawDt * 1000 * 0.1;
    this.fps = this.frameMs > 0 ? 1000 / this.frameMs : 60;
    this._frameN++;
    const sim = this.sim;
    if (!sim || !this.inGame) return;
    try {
      this._tick(sim, dt);
    } catch (err) {
      this._errors++;
      if (this._errors <= 5) console.error('[shardstorm] frame error', err);
    }
  }

  _tick(sim, dt) {
    let steps = 0;
    if (!this.paused && !this.over) {
      // Titan death: a short slow-motion beat (DESIGN section 9), eased back to full speed.
      let slow = 1;
      if (this.slowMo > 0) {
        this.slowMo = Math.max(0, this.slowMo - dt);
        const e = this.slowMo > SLOWMO_EASE ? 0 : 1 - this.slowMo / SLOWMO_EASE;
        slow = this.reducedMotion ? 1 : SLOWMO_RATE + (1 - SLOWMO_RATE) * e * e * (3 - 2 * e);
      }
      this.acc += Math.min(dt, 0.1) * this.speed * slow;
      while (this.acc >= TICK && steps < MAX_STEPS) {
        sim.step();
        steps++;
        this.acc -= TICK;
        if (this.run.pendingSave && sim.state.phase === 'build') this.saveNow();
        if (sim.state.phase === 'over') break;
      }
      if (steps >= MAX_STEPS && this.acc > TICK) this.acc = TICK; // drop backlog instead of spiraling
      this.run.time += dt;
    }
    this.lastSteps = steps;
    this._route(sim.drainEvents());
    if (this.renderer) this.renderer.render(sim, this.paused ? 0 : dt, this.ui.state);
    this.ui.update(sim, dt);
    if (sim.state.phase === 'over' && !this.over) this._gameOver();
    if ((this._frameN & 15) === 0) this._music(sim);
    this._fpsOverlay(sim);
  }

  _route(ev) {
    if (!ev || !ev.length) return;
    try { this.renderer?.onEvents(ev); } catch (err) { if (this._errors++ < 5) console.error(err); }
    try { this.audio.onEvents(ev); } catch (err) { if (this._errors++ < 5) console.error(err); }
    this.ui.onEvents(ev);
    for (let i = 0; i < ev.length; i++) {
      const e = ev[i];
      if (e.t === 'waveCleared') this._onWaveCleared(e);
      else if (e.t === 'titanDown') { this.run.titans++; this.slowMo = SLOWMO_TIME; }
      else if (e.t === 'gameOver') this._gameOver();
    }
  }

  _music(sim) {
    const s = sim.state;
    let x = 0.12;
    if (s.phase === 'wave') x = 0.35 + Math.min(0.5, s.enemies.length / 400);
    if (s.titan) x = 1;
    if (this.paused || this.over) x = 0.05;
    try { this.audio.setIntensity(x); } catch { /* ignore */ }
  }

  _fpsOverlay(sim) {
    if (!DEBUG && !this.settings.showFps) { if (this._fpsShown) { this._fpsShown = false; this.ui.setFps(''); } return; }
    if ((this._frameN % 10) !== 0) return;
    this._fpsShown = true;
    const s = sim.state;
    let html = `<b>${Math.round(this.fps)}</b> fps`;
    if (DEBUG) {
      html += `<span>${this.frameMs.toFixed(1)} ms</span><span>${this.lastSteps} steps</span>`
        + `<span>E ${s.enemies.length}</span><span>P ${s.projectiles.length}</span>`
        + `<span>T ${s.towers.length}</span><span>D ${(s.drones || []).length}</span><span>tick ${s.tick}</span>`;
    }
    this.ui.setFps(html);
  }

  // ------------------------------------------------------------------ debug hooks

  debugQuickStart(mapId = 'crater', difficulty = 'pilot', heroId = null) {
    return this.startNew({ mapId: mapId || 'crater', difficulty, heroId });
  }

  _installDebug() {
    const game = this;
    const route = () => { if (game.sim) game._route(game.sim.drainEvents()); };
    window.__ss = {
      get sim() { return game.sim; },
      game,
      debug: {
        quickStart(mapId = 'crater', difficulty = 'pilot', heroId = null) { return game.debugQuickStart(mapId, difficulty, heroId); },
        giveCash(n = 10000) {
          if (!game.sim) return false;
          game.sim.state.cash += Number(n) || 0;
          return game.sim.state.cash;
        },
        place(type, x, y) {
          if (!game.sim) return { ok: false, reason: 'no game' };
          const hero = game.data.HEROES[type] && typeof game.sim.placeHero === 'function';
          const r = hero ? game.sim.placeHero(x, y) : game.sim.placeTower(type, x, y);
          route();
          return r;
        },
        upgrade(id, path, times = 1) {
          if (!game.sim) return { ok: false, reason: 'no game' };
          let r = null;
          for (let i = 0; i < times; i++) { r = game.sim.upgrade(id, path); if (!okOf(r)) break; }
          route();
          return r;
        },
        startWave() {
          if (!game.sim) return { ok: false, reason: 'no game' };
          const r = game.sim.startWave();
          return r;
        },
        skipTo(w) {
          const sim = game.sim;
          if (!sim) return false;
          if (game.run) game.run.debug = true; // skipped runs never set records
          if (typeof sim.skipTo === 'function') { const ok = sim.skipTo(w); game.ui._previewWave = -1; return ok; }
          if (typeof sim.debugSkipTo === 'function') return sim.debugSkipTo(w);
          if (sim.state.phase !== 'build') return false;
          sim.state.wave = Math.max(0, (w | 0) - 1);
          sim.state.cleared = Math.max(0, (w | 0) - 1);
          game.ui._previewWave = -1;
          return true;
        },
        step(n = 1) {
          const sim = game.sim;
          if (!sim) return 0;
          for (let i = 0; i < n; i++) {
            sim.step();
            if (sim.state.phase === 'over') break;
          }
          route();
          if (sim.state.phase === 'over' && !game.over) game._gameOver();
          return sim.state.tick;
        },
        select(id) { game.ui.select(id); return game.ui.state.selectedTowerId; },
        pause() { game.pause(); },
        resume() { game.resume(); },
        speed(n) { game.setSpeed(n); return game.speed; },
        screen(name, p = {}) { game.screens.show(name, p); return name; },
        stats() {
          const sim = game.sim;
          const s = sim?.state;
          return {
            fps: Math.round(game.fps), frameMs: +game.frameMs.toFixed(2), steps: game.lastSteps,
            speed: game.speed, paused: game.paused, over: game.over, screen: game.screens.current,
            phase: s?.phase ?? null, wave: s?.wave ?? 0, cleared: s?.cleared ?? 0, cash: s ? Math.floor(s.cash) : 0,
            lives: s?.lives ?? 0, tick: s?.tick ?? 0,
            enemies: s?.enemies.length ?? 0, projectiles: s?.projectiles.length ?? 0,
            towers: s?.towers.length ?? 0, drones: s?.drones?.length ?? 0,
          };
        },
      },
    };
  }
}

// ---------------------------------------------------------------------------- start

const game = new Game();
game.boot().catch((err) => {
  console.error('[shardstorm] boot failed', err);
  game._fatal('Something went wrong while loading.');
});
