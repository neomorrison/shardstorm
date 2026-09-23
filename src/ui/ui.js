// In-game HUD: top bar, shop, commander tile, next wave preview, selected tower panel,
// command strip (ability bar and touch Place / Cancel), Titan health bar, wave banners, toasts
// and tooltips (hover, keyboard focus, or a long press on touch).
// The UI never mutates sim.state directly; it only calls Sim commands (docs/ARCHITECTURE.md section 6).

import {
  esc, int, short, money, dec, credits, glyph, icon, hasIcon, dtypeLabel, targetLabel, friendlyReason, clean,
} from './format.js';
import { RIG_CAP, SELL_RATE, priceFor, TITAN_EVERY, heroXpNeed, HERO_MAX_LEVEL } from '../data/economy.js';

export const PATH_COLORS = ['#3ef0d8', '#b494ff', '#ffb547'];
export const PATH_KEYS = [',', '.', '/'];
const PATH_KEY_LABELS = [',', '.', '/'];

// ---- tiny DOM helpers (diffed writes so per-frame updates stay cheap) -------------------

function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
}
function setText(e, v) {
  if (!e) return;
  v = String(v);
  if (e._t !== v) { e._t = v; e.textContent = v; }
}
function setHTML(e, v) {
  if (!e) return;
  if (e._h !== v) { e._h = v; e.innerHTML = v; }
}
function setClass(e, cls, on) {
  if (!e) return;
  on = !!on;
  const m = e._c || (e._c = {});
  if (m[cls] !== on) { m[cls] = on; e.classList.toggle(cls, on); }
}
function setAttr(e, k, v) {
  if (!e) return;
  const m = e._a || (e._a = {});
  if (m[k] === v) return;
  m[k] = v;
  if (v === null || v === false || v === undefined) e.removeAttribute(k);
  else e.setAttribute(k, v === true ? '' : String(v));
}
function setVar(e, k, v) {
  if (!e) return;
  const m = e._v || (e._v = {});
  if (m[k] === v) return;
  m[k] = v;
  e.style.setProperty(k, v);
}
function setHidden(e, hidden) {
  if (!e) return;
  hidden = !!hidden;
  if (e._hid !== hidden) { e._hid = hidden; e.hidden = hidden; }
}

function okOf(r) {
  if (r == null) return false;
  if (typeof r === 'object') return !!r.ok;
  return !!r;
}
function numOf(r) {
  if (typeof r === 'number') return r;
  if (r && typeof r === 'object') return Number(r.value ?? r.amount ?? r.price ?? r.cost ?? 0);
  return 0;
}

/** Lock reason for an upgrade card. A taken tier 5 reads as "Tier 5 owned elsewhere". */
function lockReason(reason, level) {
  const r = String(reason || '');
  if (level === 4 && /only one .* at a time|owned|t5/i.test(r)) return 'Tier 5 owned elsewhere';
  return friendlyReason(r || 'locked');
}

/** Primary damage type of a tower def or stats block. */
// Damage type of the first attack that actually shoots at things. Passive helper attacks
// (needsTarget: false, such as a Rig's payout tracker or a Beacon's radar) do not count.
export function primaryDtype(stats) {
  const atks = stats?.attacks ? Object.values(stats.attacks) : [];
  for (const a of atks) if (a && a.dtype && a.needsTarget !== false && dealsDamage(a)) return a.dtype;
  return null;
}

// A slowing field with no damage per second deals no damage (the base Gravity Well).
export function dealsDamage(a) {
  return !(a.kind === 'field' && !(a.dps > 0));
}

// Does any attack of these stats pick targets? (Rigs and Beacons only have passive helpers.)
export function hasTargetingAttack(stats) {
  const atks = stats?.attacks ? Object.values(stats.attacks) : [];
  return atks.some((a) => a && a.needsTarget !== false);
}

// ---- UI ---------------------------------------------------------------------------------

// Shown once per run when one of these leaks (the first Iron wave is built to be survivable,
// so this is the moment to point at the missing damage type).
const LEAK_HINTS = {
  iron: 'An Iron Meteor reached the Core. KINETIC damage cannot crack Iron: add a Missile Pod, Orbital Mortar, Tesla Coil, Laser Array or Cryo Emitter.',
  magma: 'A Magma Meteor reached the Core. BLAST damage cannot hurt Magma: mix in another damage type.',
  prism: 'A Prism Meteor reached the Core. It ignores THERMAL and ENERGY: KINETIC, BLAST or CRYO will crack it.',
  specter: 'A Specter reached the Core. It is Phantom and ignores KINETIC and BLAST: it needs detection plus THERMAL, ENERGY, CRYO or VOID damage.',
};

export class UI {
  /**
   * @param {object} game  the client controller (src/main.js): data, icons, settings, commands
   */
  constructor(game) {
    this.game = game;
    this.app = document.getElementById('app');
    this.hud = document.getElementById('hud');
    this.panel = document.getElementById('panel');
    this.overlay = document.getElementById('overlay');
    this.stage = document.getElementById('stage');
    this.cmd = document.getElementById('cmd');

    /** uiState passed to renderer.render (ARCHITECTURE section 8), plus client extras. */
    this.state = {
      hoverTowerId: null,
      selectedTowerId: null,
      placing: null,          // { type, x, y, valid, price, reason } while the ghost is visible
      showAllRanges: false,
      aimingTowerId: null,    // mortar Set Target mode
      settings: game.settings,
    };
    this.placeType = null;    // type being placed (ghost may be hidden while the pointer is off the map)
    this.placeKeep = false;
    this.sim = null;
    this.prices = {};
    this._frame = 0;
    this._panelDirty = true;
    this._panelT = 0;
    this._abilityKey = '';
    this._abilityEls = new Map();
    this._previewWave = -1;
    this._heroKey = '';
    this._portraitKey = '';
    this._lastLeakFlash = 0;
    this._sellArmedUntil = 0;
    this._tipFor = null;
    this._tipTouch = false;
    this._lastPointer = null;
    this._drawerRestore = false;
    this._abilityData = new Map();

    this._buildHud();
    this._buildOverlay();
    this._buildPanel();
    this._initTips();
  }

  get data() { return this.game.data; }

  // ======================================================================= build (static)

  _buildHud() {
    const h = this.hud;
    h.innerHTML = `
      <div class="hud__stats">
        <div class="stat stat--lives" title="Core Integrity">
          <span class="stat__icon">${this._artIcon('ui_integrity', 'stat__art', icon('core'))}</span>
          <span class="stat__body"><span class="stat__v" data-k="lives">0</span><span class="stat__l">Core</span></span>
        </div>
        <div class="stat stat--cash" title="Credits">
          <span class="stat__icon stat__icon--glyph">${glyph('glyph--lg')}</span>
          <span class="stat__body"><span class="stat__v" data-k="cash">0</span><span class="stat__l">Credits</span></span>
        </div>
        <div class="stat stat--wave" title="Wave">
          <span class="stat__icon">${icon('wave')}</span>
          <span class="stat__body"><span class="stat__v" data-k="wave">0</span><span class="stat__l">Wave<span class="stat__best" data-k="best">Best 0</span></span></span>
        </div>
      </div>
      <div class="hud__titan-slot"></div>
      <div class="hud__controls">
        <button type="button" class="hud-btn hud-btn--speed only-compact" data-act="speed" aria-label="Game speed">1x</button>
        <div class="seg only-wide" role="group" aria-label="Game speed">
          <button type="button" class="seg__btn" data-speed="1" aria-label="Normal speed">1x</button>
          <button type="button" class="seg__btn" data-speed="2" aria-label="Double speed">2x</button>
          <button type="button" class="seg__btn" data-speed="3" aria-label="Triple speed">3x</button>
        </div>
        <button type="button" class="hud-btn hud-btn--auto" data-act="auto" aria-pressed="false" aria-label="Auto-start waves" title="Auto-start waves">
          ${icon('auto')}<span class="hud-btn__label">Auto</span>
        </button>
        <button type="button" class="hud-btn hud-btn--icon" data-act="pause" aria-label="Pause (P)" title="Pause (P)">${icon('pause')}</button>
        <button type="button" class="wave-btn only-wide" data-act="wave" aria-label="Launch wave">
          <span class="wave-btn__icon">${icon('play')}</span>
          <span class="wave-btn__text"><span class="wave-btn__main">Launch Wave 1</span><span class="wave-btn__sub">Space</span></span>
        </button>
      </div>`;
    this.$lives = h.querySelector('[data-k="lives"]');
    this.$livesStat = h.querySelector('.stat--lives');
    this.$cash = h.querySelector('[data-k="cash"]');
    this.$cashStat = h.querySelector('.stat--cash');
    this.$wave = h.querySelector('[data-k="wave"]');
    this.$best = h.querySelector('[data-k="best"]');
    this.$speedBtns = [...h.querySelectorAll('[data-speed]')];
    this.$speedCycle = h.querySelector('[data-act="speed"]');
    this.$auto = h.querySelector('[data-act="auto"]');
    this.$pause = h.querySelector('[data-act="pause"]');
    this.$waveBtns = [h.querySelector('[data-act="wave"]')];

    h.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.speed) this.game.setSpeed(Number(b.dataset.speed));
      else if (b.dataset.act === 'auto') this.game.toggleAuto();
      else if (b.dataset.act === 'speed') this.game.cycleSpeed(true);
      else if (b.dataset.act === 'pause') this.game.pause();
      else if (b.dataset.act === 'wave') this.game.launchWave();
      this._blurAfterPointer(b, e);
    });
  }

  /** An <img> for a UI sprite from the manifest, or the fallback markup when it is missing. */
  _artIcon(key, cls, fallback) {
    let src = null;
    try { src = this.game.assets?.image?.(key)?.src || null; } catch { src = null; }
    // width/height attributes keep the art icon-sized even before the stylesheet applies
    return src ? `<img class="${cls}" src="${esc(src)}" width="30" height="30" alt="" draggable="false" decoding="async">` : fallback;
  }

  _buildOverlay() {
    const o = this.overlay;
    // Top-center stack: Titan bar, mortar aim hint, coach and toasts flow in one column, so
    // they never overlap each other; the stack keeps clear of the Fit map corner.
    o.innerHTML = `
      <div class="view-ctl" hidden>
        <button type="button" class="view-ctl__fit" aria-label="Fit the whole map (0)" title="Fit the whole map (0)">${icon('fit')}<span>Fit map</span></button>
      </div>
      <div class="topstack">
        <div class="titan" hidden aria-live="polite">
          <div class="titan__label"><span class="titan__tag">Storm Titan</span><span class="titan__name"></span></div>
          <div class="titan__bar"><div class="titan__hp"></div><div class="titan__shield"></div><span class="titan__num"></span></div>
          <span class="titan__shield-ico" hidden>${this._artIcon('ui_shield', 'titan__shield-art', '')}</span>
        </div>
        <div class="aim-hint" hidden>${icon('target')}<span class="aim-hint__text"></span></div>
        <div class="coach" hidden><span class="coach__step"></span><span class="coach__text"></span></div>
        <div class="toasts" role="status" aria-live="polite"></div>
      </div>
      <div class="banners" aria-live="polite"></div>
      <div class="ghost-tag" hidden><span class="ghost-tag__price"></span><span class="ghost-tag__why"></span></div>
      <div class="fps" hidden></div>`;
    // Command strip: a reserved row under the map (a side column on phones held sideways). It
    // holds the ability bar and, while placing by touch, the Place and Cancel buttons.
    const cmd = this.cmd;
    cmd.innerHTML = `
      <div class="abilities" role="toolbar" aria-label="Abilities"></div>
      <div class="cmd__empty" aria-hidden="true"><span class="cmd__empty-ico">${icon('bolt')}</span><span class="cmd__empty-text"><b>Abilities</b><span>Tier 4 and 5 upgrades and Commanders unlock them</span></span></div>
      <div class="touch-place" hidden>
        <button type="button" class="btn btn--ghost touch-place__cancel" aria-label="Cancel placement">${icon('close')}<span class="touch-place__word">Cancel</span></button>
        <button type="button" class="btn btn--primary touch-place__ok">${icon('check')}<span class="touch-place__label"></span></button>
      </div>`;
    this.$titan = o.querySelector('.titan');
    this.$titanName = o.querySelector('.titan__name');
    this.$titanHp = o.querySelector('.titan__hp');
    this.$titanShield = o.querySelector('.titan__shield');
    this.$titanNum = o.querySelector('.titan__num');
    this.$titanShieldIco = o.querySelector('.titan__shield-ico');
    this.$banners = o.querySelector('.banners');
    this.$aimHint = o.querySelector('.aim-hint');
    this.$aimText = o.querySelector('.aim-hint__text');
    this.$coach = o.querySelector('.coach');
    this.$coachStep = o.querySelector('.coach__step');
    this.$coachText = o.querySelector('.coach__text');
    this.$ghostTag = o.querySelector('.ghost-tag');
    this.$ghostPrice = o.querySelector('.ghost-tag__price');
    this.$ghostWhy = o.querySelector('.ghost-tag__why');
    this.$touch = cmd.querySelector('.touch-place');
    this.$touchOk = cmd.querySelector('.touch-place__ok');
    this.$touchLabel = cmd.querySelector('.touch-place__label');
    this.$abilities = cmd.querySelector('.abilities');
    this.$toasts = o.querySelector('.toasts');
    this.$fps = o.querySelector('.fps');
    this.$viewCtl = o.querySelector('.view-ctl');
    o.querySelector('.view-ctl__fit').addEventListener('click', (e) => {
      this.game.resetView();
      this._blurAfterPointer(e.currentTarget, e);
    });

    cmd.querySelector('.touch-place__cancel').addEventListener('click', () => this.cancelPlacing());
    this.$touchOk.addEventListener('click', () => this.confirmPlace());
    this.$abilities.addEventListener('click', (e) => {
      const b = e.target.closest('.ab');
      if (b) { this.game.useAbility(b.dataset.id); this._blurAfterPointer(b, e); }
    });
    // A mouse wheel scrolls a full ability bar sideways.
    this.$abilities.addEventListener('wheel', (e) => {
      const a = this.$abilities;
      if (a.scrollWidth <= a.clientWidth + 1 || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      e.preventDefault();
      a.scrollLeft += e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    }, { passive: false });

    // tooltip lives at body level so it can float beside the panel
    this.$tip = el('div', 'tip');
    this.$tip.hidden = true;
    this.$tip.setAttribute('role', 'tooltip');
    document.body.appendChild(this.$tip);
  }

  _buildPanel() {
    const p = this.panel;
    p.innerHTML = `
      <div class="drawer-head only-compact">
        <button type="button" class="drawer-toggle" aria-label="Toggle build drawer" aria-expanded="true">${icon('chevdown')}</button>
        <button type="button" class="drawer-head__preview" aria-expanded="false" aria-label="Next wave. Show the full preview">
          <span class="mini__list"></span><span class="pv-more"></span>
        </button>
        <button type="button" class="wave-btn wave-btn--compact" data-act="wave" aria-label="Launch wave">
          <span class="wave-btn__icon">${icon('play')}</span>
          <span class="wave-btn__text"><span class="wave-btn__main">Wave 1</span></span>
        </button>
      </div>
      <div class="panel__body">
        <section class="shop" aria-label="Towers">
          <div class="panel__title"><span>Arsenal</span><span class="panel__hint only-wide">Click or press a key</span></div>
          <div class="shop__grid"></div>
          <div class="hero-slot"></div>
          <div class="preview">
            <div class="preview__head"><span class="preview__label">Next</span><span class="preview__wave">Wave 1</span><span class="preview__tags"></span></div>
            <div class="preview__name"></div>
            <div class="preview__list"></div>
          </div>
        </section>
        <section class="tp" aria-label="Selected tower" hidden></section>
      </div>`;
    this.$drawerToggle = p.querySelector('.drawer-toggle');
    this.$drawerPreview = p.querySelector('.drawer-head__preview');
    this.$miniList = p.querySelector('.mini__list');
    this.$miniMore = p.querySelector('.drawer-head__preview .pv-more');
    this.$waveBtns.push(p.querySelector('.drawer-head [data-act="wave"]'));
    this.$shop = p.querySelector('.shop');
    this.$grid = p.querySelector('.shop__grid');
    this.$heroSlot = p.querySelector('.hero-slot');
    this.$previewWave = p.querySelector('.preview__wave');
    this.$previewTags = p.querySelector('.preview__tags');
    this.$previewName = p.querySelector('.preview__name');
    this.$previewList = p.querySelector('.preview__list');
    this.$tp = p.querySelector('.tp');
    this.$body = p.querySelector('.panel__body');

    p.querySelector('.drawer-head [data-act="wave"]').addEventListener('click', (e) => {
      this.game.launchWave();
      this._blurAfterPointer(e.currentTarget, e);
    });
    this.$drawerToggle.addEventListener('click', () => {
      this._drawerRestore = false;
      this.setDrawer(this.app.classList.contains('drawer-closed'));
    });
    this.setDrawer(this.game.settings.drawer !== false, true);
    this.$drawerPreview.addEventListener('click', () => this.togglePreview());

    this.$grid.addEventListener('click', (e) => {
      const b = e.target.closest('.tile');
      if (!b) return;
      this._syncPointerKind(e);
      this.shopPick(b.dataset.type, this.game.isTouch);
      this._blurAfterPointer(b, e);
    });
    this.$heroSlot.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      this._syncPointerKind(e);
      if (b.dataset.heroSelect) this.select(b.dataset.heroSelect);
      else if (b.dataset.type) this.shopPick(b.dataset.type, this.game.isTouch);
      this._blurAfterPointer(b, e);
    });
  }

  /**
   * Hybrid devices (an iPad with a trackpad, a touch laptop): the device that clicked a card
   * decides how the ghost is placed. A finger gets the ghost plus Place and Cancel, a mouse or
   * trackpad gets a ghost that follows the pointer. Keyboard clicks keep the current mode.
   */
  _syncPointerKind(e) {
    if (!e || !(e.detail > 0)) return;
    const kind = e.pointerType || this._lastPointer;
    if (kind === 'touch' || kind === 'pen') this.game.setTouch(true);
    else if (kind === 'mouse') this.game.setTouch(false);
  }

  /** Mouse clicks should not leave focus on HUD buttons (Space would re-trigger them). */
  _blurAfterPointer(btn, e) {
    if (e && e.detail > 0 && btn && typeof btn.blur === 'function') btn.blur();
  }

  setDrawer(open, silent = false) {
    this.app.classList.toggle('drawer-closed', !open);
    this.$drawerToggle.setAttribute('aria-expanded', String(open));
    if (!silent) this.game.updateSettings({ drawer: open });
    // the stage changes size in compact layout; the renderer reads it on the next frame
  }

  /** Phones and iPad portrait: fold the drawer while a tower is being placed by touch. */
  _collapseDrawerForPlacing() {
    if (this.game.layout !== 'compact' || this.app.classList.contains('is-short')) return;
    if (this.app.classList.contains('drawer-closed')) return;
    this._drawerRestore = true;
    this.setDrawer(false, true);
  }

  _restoreDrawer() {
    if (!this._drawerRestore) return;
    this._drawerRestore = false;
    this.setDrawer(true, true);
  }

  /** Compact layout: the full next wave preview opens at the top of the drawer. */
  togglePreview(force) {
    const on = typeof force === 'boolean' ? force : !this.app.classList.contains('show-preview');
    this.app.classList.toggle('show-preview', on);
    setAttr(this.$drawerPreview, 'aria-expanded', String(on));
    setAttr(this.$drawerPreview, 'aria-label', on ? 'Next wave. Hide the full preview' : 'Next wave. Show the full preview');
    if (!on) return;
    if (this.state.selectedTowerId != null) this.deselect();
    if (this.app.classList.contains('drawer-closed')) { this._drawerRestore = false; this.setDrawer(true); }
    this.$body.scrollTop = 0;
  }

  /** Called by the layout watcher after a resize or rotation. */
  _layoutChanged() {
    const portraitCompact = this.game.layout === 'compact' && !this.app.classList.contains('is-short');
    if (this._drawerRestore && !portraitCompact) this._restoreDrawer();
    this._renderCoach();
    this._fitMini();
  }

  // ======================================================================= bind / reset

  bind(sim) {
    this.sim = sim;
    this.state.hoverTowerId = null;
    this.state.selectedTowerId = null;
    this.state.placing = null;
    this.state.aimingTowerId = null;
    this.state.showAllRanges = false;
    this.placeType = null;
    this._previewWave = -1;
    this._abilityKey = '';
    this._heroKey = '';
    this._panelDirty = true;
    this.$toasts.innerHTML = '';
    this.$banners.innerHTML = '';
    this._abilityEls.clear();
    this.$abilities.innerHTML = '';
    this._hideTip();
    this._abilityData.clear();
    this._drawerRestore = false;
    this.setDrawer(this.game.settings.drawer !== false, true);
    this.togglePreview(false);
    setClass(this.cmd, 'has-abilities', false);
    this._buildShop(sim);
    this._showView('shop');
    const sk = String(this.game.speedKey || 'f').toUpperCase();
    for (const btn of this.$speedBtns) btn.title = `${btn.textContent} speed. ${sk} cycles`;
    if (this.$speedCycle) this.$speedCycle.title = `Game speed. ${sk} cycles`;
    this._updateTouchControls();
    this._coach = this.game.settings.coach && sim.state.wave === 0 && sim.state.towers.length === 0 ? 1 : 0;
    this._seen = new Set();
    for (let w = 1; w <= Math.min(sim.state.wave, 240); w++) this._markSeen(sim, w);
    this._renderCoach();
    this.update(sim, 0);
    // Touch screens: say once per session that the map zooms. It waits for the first tower
    // (or the first wave) so it never lands on the ghost that a first shop tap drops.
    this._zoomHintPending = !UI._zoomHinted;
  }

  _maybeZoomHint() {
    if (!this._zoomHintPending || !this.game.isTouch || UI._zoomHinted) return;
    this._zoomHintPending = false;
    UI._zoomHinted = true;
    const sim = this.sim;
    setTimeout(() => { if (this.sim === sim && !this.game.over) this.toast('Pinch to zoom the map. Drag to pan it.', 'tip', 4000); }, 700);
  }

  /** Remembers which enemy types (and modifiers) the player has already faced this run. */
  _markSeen(sim, w) {
    let list = [];
    try { list = sim.wavePreview(w) || []; } catch { list = []; }
    for (const g of list) {
      this._seen.add(g.type);
      if (g.mods?.phantom) this._seen.add('mod:phantom');
      if (g.mods?.nanite) this._seen.add('mod:nanite');
      if (g.mods?.plated) this._seen.add('mod:plated');
    }
  }

  _renderCoach() {
    const on = !!this._coach;
    setHidden(this.$coach, !on);
    if (!on) return;
    const touch = this.game.isTouch;
    // the shop is below the map in compact portrait, and on the right everywhere else
    const below = this.game.layout === 'compact' && !this.app.classList.contains('is-short');
    const key = below ? 'below' : 'on the right';
    if (this._coach === 1) {
      setText(this.$coachStep, '1');
      setText(this.$coachText, touch
        ? `Pick a tower ${key}, drag it beside the channel, then tap Place.`
        : `Pick a tower ${key}, then click beside the channel to place it.`);
    } else {
      setText(this.$coachStep, '2');
      setText(this.$coachText, touch ? 'Tap the wave button to launch the storm.' : 'Press Space or Launch Wave to start the storm.');
    }
  }

  unbind() {
    this.sim = null;
    this.state.placing = null;
    this.placeType = null;
    this.state.selectedTowerId = null;
    this.state.aimingTowerId = null;
    this._hideTip();
    this._restoreDrawer();
    this._updateTouchControls();
  }

  _priceOf(sim, type) {
    try {
      const v = sim.priceOf(type);
      const n = numOf(v);
      if (Number.isFinite(n) && n > 0) return n;
    } catch { /* fall through */ }
    const def = this.data.TOWERS[type] || this.data.HEROES[type];
    return def ? priceFor(def.cost || 0, sim.state.difficulty) : 0;
  }

  _buildShop(sim) {
    const { TOWERS, TOWER_ORDER } = this.data;
    this.prices = {};
    this.$grid.innerHTML = '';
    this._tiles = [];
    for (const type of TOWER_ORDER) {
      const def = TOWERS[type];
      if (!def) continue;
      const price = this._priceOf(sim, type);
      this.prices[type] = price;
      const key = (def.hotkey || '').toUpperCase();
      const b = el('button', 'tile');
      b.type = 'button';
      b.dataset.type = type;
      b.setAttribute('aria-label', `${def.name}, ${int(price)} credits${key ? ', hotkey ' + key : ''}`);
      b.innerHTML = `
        <span class="tile__art"><canvas class="tile__icon"></canvas></span>
        <span class="tile__name">${esc(def.name)}</span>
        <span class="tile__price">${glyph()}<span>${int(price)}</span></span>
        ${key ? `<kbd class="tile__key">${esc(key)}</kbd>` : ''}`;
      this.$grid.appendChild(b);
      this.game.icons.tower(b.querySelector('canvas'), def, 46, 0);
      this._tiles.push({ el: b, type, def, price, priceEl: b.querySelector('.tile__price'), isRig: this._isRigDef(type, def) });
    }
    this._buildHeroTile(sim);
  }

  _isRigDef(type) {
    return type === 'rig';
  }

  // ======================================================================= commander

  _heroId() {
    const id = this.sim?.state?.heroId;
    return id && this.data.HEROES[id] ? id : null;
  }

  _heroTower() {
    const id = this._heroId();
    if (!id || !this.sim) return null;
    return this.sim.state.towers.find((t) => t.hero || t.isHero || t.type === id || t.def?.hero) || null;
  }

  _buildHeroTile(sim) {
    const id = this._heroId();
    this.$heroSlot.innerHTML = '';
    this._hero = null;
    if (!id) return;
    const def = this.data.HEROES[id];
    const price = this._priceOf(sim, id);
    this.prices[id] = price;
    const b = el('button', 'hero-tile');
    b.type = 'button';
    b.dataset.type = id;
    b.innerHTML = `
      <span class="hero-tile__art"><canvas></canvas></span>
      <span class="hero-tile__body">
        <span class="hero-tile__role">Commander</span>
        <span class="hero-tile__name">${esc(def.name)}</span>
        <span class="hero-tile__meta"><span class="hero-tile__price">${glyph()}<span>${int(price)}</span></span><span class="hero-tile__lvl" hidden></span></span>
        <span class="hero-tile__xp" hidden><i></i></span>
      </span>
      <kbd class="tile__key">U</kbd>`;
    this.$heroSlot.appendChild(b);
    this.game.icons.hero(b.querySelector('canvas'), def, 48);
    this._hero = {
      el: b, id, def, price,
      priceEl: b.querySelector('.hero-tile__price'),
      lvlEl: b.querySelector('.hero-tile__lvl'),
      xpEl: b.querySelector('.hero-tile__xp'),
      xpFill: b.querySelector('.hero-tile__xp i'),
      keyEl: b.querySelector('.tile__key'),
    };
  }

  /** Level/XP summary for a hero tower, tolerant of how the engine stores it. */
  heroProgress(t) {
    if (!t) return null;
    let info = null;
    try { info = this.sim?.towerInfo?.(t.id) || null; } catch { info = null; }
    const src = [info?.hero, info, t.hero && typeof t.hero === 'object' ? t.hero : null, t.data, t];
    const pick = (k) => { for (const o of src) if (o && Number.isFinite(o[k])) return o[k]; return undefined; };
    const level = pick('level') ?? pick('lvl') ?? 1;
    const max = level >= HERO_MAX_LEVEL;
    const xp = pick('xp') ?? 0;
    const need = max ? 0 : (pick('xpNeed') || pick('xpNext') || heroXpNeed(level));
    const frac = max ? 1 : (need ? Math.min(1, xp / need) : 0);
    return { level, xp, need, frac, max };
  }

  // ======================================================================= shop / placing

  shopPick(type, touch = false) {
    const sim = this.sim;
    if (!sim || this.game.over) return;
    if (this.placeType === type) { this.cancelPlacing(); return; }
    const price = this.prices[type] ?? this._priceOf(sim, type);
    if (this._heroId() === type && this._heroTower()) {
      this.select(this._heroTower().id);
      return;
    }
    if (sim.state.cash < price) {
      this.toast('Not enough credits', 'bad');
      this._nudge(type);
      return;
    }
    const tile = this._tiles?.find((t) => t.type === type);
    if (tile?.isRig && sim.state.rigCount >= RIG_CAP) {
      this.toast(`Mining Rig limit reached (${RIG_CAP})`, 'bad');
      this._nudge(type);
      return;
    }
    this.deselect();
    this.state.aimingTowerId = null;
    this.placeType = type;
    this.placeKeep = false;
    this._hideTip();
    if (touch) {
      // touch: drop the ghost in the middle of the visible map; drag to move, tap Place to confirm
      this.togglePreview(false);
      this._collapseDrawerForPlacing();
      const c = this.game.canvasCenterWorld();
      this.moveGhost(c.x, c.y);
    } else if (this.game.pointerWorld) {
      const p = this.game.pointerWorld;
      if (p.inside) this.moveGhost(p.x, p.y);
    }
    this._updateTiles(true);
    this._updateTouchControls();
  }

  _nudge(type) {
    const t = this._tiles?.find((x) => x.type === type)?.el || (this._hero?.id === type ? this._hero.el : null);
    if (!t) return;
    t.classList.remove('nudge');
    void t.offsetWidth;
    t.classList.add('nudge');
  }

  /** Move (or show) the placement ghost at a world position. */
  moveGhost(x, y) {
    const sim = this.sim;
    const type = this.placeType;
    if (!sim || !type) return;
    let valid = false, reason = null, price = this.prices[type] ?? 0;
    try {
      const r = sim.canPlace(type, x, y);
      valid = okOf(r);
      reason = valid ? null : (r && r.reason) || 'blocked';
    } catch { valid = false; reason = 'blocked'; }
    try {
      const p = numOf(sim.priceAt(type, x, y));
      if (p > 0) price = p;
    } catch { /* keep base price */ }
    if (valid && sim.state.cash < price) { valid = false; reason = 'cash'; }
    this.state.placing = { type, x, y, valid, price, reason };
    this._updateTouchControls();
  }

  hideGhost() {
    if (this.state.placing) this.state.placing = null;
  }

  confirmPlace(keep = false) {
    const sim = this.sim;
    const p = this.state.placing;
    if (!sim || !p) return false;
    const type = p.type;
    let r;
    try {
      r = this._heroId() === type && typeof sim.placeHero === 'function'
        ? sim.placeHero(p.x, p.y)
        : sim.placeTower(type, p.x, p.y);
    } catch (err) {
      console.error(err);
      r = { ok: false, reason: 'invalid' };
    }
    if (!okOf(r)) {
      this.toast(friendlyReason(r?.reason || p.reason), 'bad');
      return false;
    }
    const price = this.prices[type] ?? 0;
    const again = keep && this._heroId() !== type && sim.state.cash >= price;
    if (again) {
      this.moveGhost(p.x, p.y);
    } else {
      this.cancelPlacing();
    }
    this._panelDirty = true;
    return true;
  }

  cancelPlacing() {
    this.placeType = null;
    this.state.placing = null;
    this._updateTiles(true);
    this._restoreDrawer();
    this._updateTouchControls();
  }

  get placing() { return !!this.placeType; }

  _updateTouchControls() {
    const show = !!this.placeType && this.game.isTouch;
    setHidden(this.$touch, !show);
    setClass(this.cmd, 'is-placing', show);
    if (show) {
      const p = this.state.placing;
      const price = p?.price ?? this.prices[this.placeType] ?? 0;
      setHTML(this.$touchLabel, `<span class="touch-place__word">Place</span>${credits(price)}`);
      setAttr(this.$touchOk, 'aria-label', `Place for ${int(price)} credits`);
      this.$touchOk.disabled = !p || !p.valid;
    }
  }

  // ======================================================================= selection

  select(id) {
    if (!this.sim) return;
    const t = this._tower(id);
    if (!t) return;
    if (this.placeType) this.cancelPlacing();
    if (this.state.selectedTowerId !== t.id) this.state.aimingTowerId = null;
    this.state.selectedTowerId = t.id;
    this._buildTowerPanel(t);
    this._showView('tower');
    this._panelDirty = true;
    this._refreshTowerPanel(true);
    this.togglePreview(false);
    if (this.game.layout === 'compact' && this.app.classList.contains('drawer-closed')) this.setDrawer(true);
  }

  deselect() {
    if (this.state.selectedTowerId == null && this.state.aimingTowerId == null) return;
    this.state.selectedTowerId = null;
    this.state.aimingTowerId = null;
    this._sellArmedUntil = 0;
    this._showView('shop');
  }

  _showView(v) {
    const tower = v === 'tower';
    setHidden(this.$shop, tower);
    setHidden(this.$tp, !tower);
    this.panel.dataset.view = v;
    if (tower) this.$body.scrollTop = 0;
  }

  _tower(id) {
    if (!this.sim || id == null) return null;
    const ts = this.sim.state.towers;
    for (let i = 0; i < ts.length; i++) if (ts[i].id === id || String(ts[i].id) === String(id)) return ts[i];
    return null;
  }

  _defOf(t) {
    return t.def || this.data.TOWERS[t.type] || this.data.HEROES[t.type] || { name: t.type, paths: [] };
  }

  _isHero(t) {
    return !!(t && (t.hero || t.isHero || t.def?.hero || (this.data.HEROES[t.type] && !this.data.TOWERS[t.type])));
  }

  _variant(t) {
    const def = this._defOf(t);
    try { return def.art?.variant ? def.art.variant(t.levels || [0, 0, 0]) || 0 : 0; } catch { return 0; }
  }

  _buildTowerPanel(t) {
    const def = this._defOf(t);
    const hero = this._isHero(t);
    const paths = hero ? [] : (def.paths || []).slice(0, 3);
    const tp = this.$tp;
    tp.innerHTML = `
      <header class="tp__head">
        <span class="tp__art"><canvas class="tp__portrait"></canvas></span>
        <div class="tp__id">
          <h2 class="tp__name">${esc(def.name)}</h2>
          <div class="tp__sub"><span class="tp__levels"></span><span class="tp__dtype"></span></div>
        </div>
        <button type="button" class="icon-btn tp__close" aria-label="Close (Esc)" title="Close (Esc)">${icon('close')}</button>
      </header>
      <div class="tp__stats">
        <div class="kv" data-row="pops"><span class="kv__k">Pops</span><span class="kv__v" data-k="pops">0</span></div>
        <div class="kv" data-row="dmg"><span class="kv__k">Damage</span><span class="kv__v" data-k="dmg">0</span></div>
        <div class="kv" data-row="cash"><span class="kv__k">Credits</span><span class="kv__v kv__v--cr" data-k="cash">0</span></div>
      </div>
      <div class="tp__hero" hidden>
        <div class="tp__hero-top"><span class="tp__lvl">Level 1</span><span class="tp__xp-text"></span></div>
        <div class="xpbar"><i></i></div>
        <div class="tp__hero-notes"></div>
      </div>
      <div class="tp__target">
        <span class="tp__label">Target</span>
        <button type="button" class="icon-btn icon-btn--sm" data-act="tprev" aria-label="Previous targeting mode">${icon('left')}</button>
        <span class="tp__mode" aria-live="polite">First</span>
        <button type="button" class="icon-btn icon-btn--sm" data-act="tnext" aria-label="Next targeting mode (Tab)">${icon('right')}</button>
        <kbd class="tp__kbd only-wide">Tab</kbd>
      </div>
      <div class="tp__extra">
        <button type="button" class="btn btn--sm btn--ghost tp__aim" data-act="aim" hidden>${icon('target')}<span>Set Target</span></button>
        <button type="button" class="btn btn--sm btn--credit tp__vault" data-act="withdraw" hidden>${icon('vault')}<span>Withdraw</span><span class="tp__vault-amt"></span></button>
      </div>
      <div class="tp__paths">
        ${paths.map((p, i) => `
          <button type="button" class="up" data-path="${i}" style="--path:${PATH_COLORS[i]}">
            <span class="up__top">
              <span class="up__path">${esc(p.name || 'Path ' + (i + 1))}</span>
              <span class="pips">${[0, 1, 2, 3, 4].map((k) => `<i class="pip" title="${esc(p.upgrades?.[k]?.name || '')}"></i>`).join('')}</span>
              <kbd class="up__key only-wide">${PATH_KEY_LABELS[i]}</kbd>
            </span>
            <span class="up__name"></span>
            <span class="up__desc"></span>
            <span class="up__foot"><span class="up__state"></span><span class="up__price"></span></span>
          </button>`).join('')}
      </div>
      <footer class="tp__foot">
        <button type="button" class="btn btn--sell" data-act="sell">
          ${icon('sell')}<span class="btn-sell__label">Sell</span><span class="btn-sell__val"></span>
        </button>
        <span class="tp__foot-note"></span>
      </footer>`;
    const q = (s) => tp.querySelector(s);
    this.tp = {
      id: t.id, def, hero,
      portrait: q('.tp__portrait'), levels: q('.tp__levels'), dtype: q('.tp__dtype'),
      pops: q('[data-k="pops"]'), dmg: q('[data-k="dmg"]'), cash: q('[data-k="cash"]'), cashRow: q('[data-row="cash"]'),
      popsRow: q('[data-row="pops"]'), dmgRow: q('[data-row="dmg"]'), stats: q('.tp__stats'),
      heroBox: q('.tp__hero'), lvl: q('.tp__lvl'), xpText: q('.tp__xp-text'), xpFill: q('.xpbar i'), heroNotes: q('.tp__hero-notes'),
      target: q('.tp__target'), mode: q('.tp__mode'),
      aim: q('.tp__aim'), vault: q('.tp__vault'), vaultAmt: q('.tp__vault-amt'), extra: q('.tp__extra'),
      paths: [...tp.querySelectorAll('.up')].map((b) => ({
        el: b, pips: [...b.querySelectorAll('.pip')], name: b.querySelector('.up__name'), desc: b.querySelector('.up__desc'),
        state: b.querySelector('.up__state'), price: b.querySelector('.up__price'),
      })),
      sell: q('.btn--sell'), sellLabel: q('.btn-sell__label'), sellVal: q('.btn-sell__val'), footNote: q('.tp__foot-note'),
    };
    this._portraitKey = '';
    tp.onclick = (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.classList.contains('tp__close')) this.deselect();
      else if (b.classList.contains('up')) this.upgradeSelected(Number(b.dataset.path));
      else if (b.dataset.act === 'tprev') this.cycleTargeting(-1);
      else if (b.dataset.act === 'tnext') this.cycleTargeting(1);
      else if (b.dataset.act === 'aim') this.toggleAim();
      else if (b.dataset.act === 'withdraw') this.withdraw();
      else if (b.dataset.act === 'sell') this.sellSelected(true);
      this._blurAfterPointer(b, e);
    };
  }

  _refreshTowerPanel(force = false) {
    const sim = this.sim;
    const id = this.state.selectedTowerId;
    if (!sim || id == null || !this.tp) return;
    const t = this._tower(id);
    if (!t) { this.deselect(); return; }
    const tp = this.tp;
    const def = tp.def;
    let info = {};
    try { info = sim.towerInfo(t.id) || {}; } catch { info = {}; }
    const levels = t.levels || info.levels || [0, 0, 0];

    // portrait (changes look at tier 3+)
    const variant = this._variant(t);
    const pk = `${t.type}:${variant}`;
    if (force || pk !== this._portraitKey) {
      this._portraitKey = pk;
      if (tp.hero) this.game.icons.hero(tp.portrait, def, 60);
      else this.game.icons.tower(tp.portrait, def, 60, variant);
    }

    setText(tp.levels, tp.hero ? 'Commander' : levels.join('-'));
    const dt = primaryDtype(t.stats) || primaryDtype(def.base);
    const det = t.stats?.detection || info.detection;
    setHTML(tp.dtype, [dt ? esc(dtypeLabel(dt)) : null, det ? '<span class="tp__det">Detection</span>' : null].filter(Boolean).join('<span class="dot"></span>'));

    const pops = info.pops ?? t.pops ?? 0, dmg = info.damage ?? t.damage ?? 0;
    // Rigs and Beacons never attack: no Pops or Damage row unless they somehow scored some
    const fights = tp.hero || hasTargetingAttack(t.stats) || pops > 0 || dmg > 0;
    setHidden(tp.popsRow, !fights);
    setHidden(tp.dmgRow, !fights);
    setText(tp.pops, short(pops));
    setText(tp.dmg, short(dmg));
    const earned = info.cashEarned ?? t.cashEarned ?? 0;
    const showCash = earned > 0 || !!t.stats?.income;
    setHidden(tp.cashRow, !showCash);
    if (showCash) setHTML(tp.cash, credits(earned));
    setHidden(tp.stats, !fights && !showCash);

    // commander
    setHidden(tp.heroBox, !tp.hero);
    if (tp.hero) {
      const hp = this.heroProgress(t);
      setText(tp.lvl, hp.max ? 'Level 20 (max)' : `Level ${hp.level}`);
      setText(tp.xpText, hp.max ? '' : hp.need ? `${int(hp.xp)} / ${int(hp.need)} XP` : '');
      setVar(tp.xpFill.parentElement, '--fill', String(hp.frac));
      setHTML(tp.heroNotes, this._heroNotes(def, hp.level, info));
    }

    // targeting
    const modes = info.modes || t.stats?.targetModes || def.base?.targetModes || ['first', 'last', 'strong', 'close'];
    const noTarget = !modes || modes.length === 0 || (!hasTargetingAttack(t.stats) && !tp.hero);
    setHidden(tp.target, noTarget);
    setText(tp.mode, targetLabel(info.targeting || t.targeting));
    // a single mode (the mortar's Manual) has nothing to cycle through
    const oneMode = modes.length <= 1;
    for (const b of tp.target.querySelectorAll('[data-act="tprev"], [data-act="tnext"], .tp__kbd')) setHidden(b, oneMode);

    // mortar aim, vault withdraw
    const mortar = typeof info.aimable === 'boolean' ? info.aimable : this._hasMortar(t);
    setHidden(tp.aim, !mortar);
    if (mortar) {
      setClass(tp.aim, 'is-active', this.state.aimingTowerId === t.id);
      setAttr(tp.aim, 'aria-pressed', String(this.state.aimingTowerId === t.id));
    }
    const vault = t.stats?.income?.vault;
    setHidden(tp.vault, !vault);
    if (vault) {
      const bal = Number(t.data?.vault ?? t.data?.vaultBalance ?? info.vault ?? 0);
      setHTML(tp.vaultAmt, credits(bal));
      tp.vault.disabled = !(bal >= 1);
    }
    setHidden(tp.extra, !mortar && !vault);

    // upgrade paths
    const cash = sim.state.cash;
    for (let p = 0; p < tp.paths.length; p++) {
      const ui = tp.paths[p];
      const path = def.paths?.[p];
      const lv = levels[p] || 0;
      let u = null;
      try { u = sim.upgradeInfo(t.id, p); } catch { u = null; }
      let state = u?.state || (lv >= 5 ? 'maxed' : 'locked');
      const next = path?.upgrades?.[lv];
      const cost = Number(u?.cost ?? 0);
      if (state === 'available' && cash < cost) state = 'unaffordable';
      if (state === 'unaffordable' && cash >= cost && cost > 0) state = 'available';
      setAttr(ui.el, 'data-state', state);
      for (let k = 0; k < 5; k++) {
        setClass(ui.pips[k], 'on', k < lv);
        setClass(ui.pips[k], 'next', k === lv && (state === 'available' || state === 'unaffordable'));
      }
      if (state === 'maxed') {
        const top = path?.upgrades?.[Math.max(0, lv - 1)];
        setText(ui.name, top ? clean(top.name) : 'Maxed');
        setText(ui.desc, top ? clean(top.desc) : '');
        setHTML(ui.state, `${icon('star')}<span>Max tier</span>`);
        setAttr(ui.state, 'title', null);
        setHTML(ui.price, '');
        setAttr(ui.el, 'aria-disabled', 'true');
        setAttr(ui.el, 'aria-label', `${path?.name || 'Path'}: max tier`);
      } else if (state === 'locked') {
        setText(ui.name, clean(u?.name || next?.name || ''));
        setText(ui.desc, clean(u?.desc || next?.desc || ''));
        const why = lockReason(u?.reason, lv);
        setHTML(ui.state, `${icon('lock')}<span>${esc(why)}</span>`);
        setAttr(ui.state, 'title', u?.reason ? clean(u.reason) : null);
        setHTML(ui.price, '');
        setAttr(ui.el, 'aria-disabled', 'true');
        setAttr(ui.el, 'aria-label', `${path?.name || 'Path'}: locked. ${why}`);
      } else {
        const nm = clean(u?.name || next?.name || '');
        setText(ui.name, nm);
        setText(ui.desc, clean(u?.desc || next?.desc || ''));
        setHTML(ui.state, `<span class="up__tier">Tier ${lv + 1}</span>`);
        setAttr(ui.state, 'title', null);
        setHTML(ui.price, credits(cost));
        setAttr(ui.el, 'aria-disabled', state === 'available' ? null : 'true');
        setAttr(ui.el, 'aria-label', `Upgrade ${path?.name || ''}: ${nm}, ${int(cost)} credits${state === 'unaffordable' ? ', not enough credits' : ''}. Hotkey ${PATH_KEY_LABELS[p]}`);
      }
    }

    // sell / undo
    const sell = this._sellInfo(sim, t);
    const armed = performance.now() < this._sellArmedUntil;
    setText(tp.sellLabel, armed ? 'Confirm' : sell.undo ? 'Undo' : 'Sell');
    setHTML(tp.sellVal, credits(sell.value));
    setClass(tp.sell, 'is-undo', sell.undo);
    setClass(tp.sell, 'is-armed', armed);
    setAttr(tp.sell, 'aria-label', `${sell.undo ? 'Undo placement, full refund' : 'Sell'} for ${int(sell.value)} credits${this.game.isTouch ? '' : ' (Delete)'}`);
    setText(tp.footNote, sell.note);
  }

  /**
   * What selling a tower pays and why, from the same parts the sim adds up (src/sim/economy.js
   * sellValue): what was spent this build phase comes back in full, the rest at the sell rate,
   * plus a Rig's banked vault. `undo` means the whole tower was bought this build phase.
   */
  _sellInfo(sim, t) {
    let value = 0;
    try { value = numOf(sim.sellValue(t.id)); } catch { value = 0; }
    const paid = Math.max(0, Number(t.paid) || 0);
    const back = Math.min(Math.max(0, Number(t.undoPaid) || 0), paid);
    const vault = Math.floor(Math.max(0, Number(t.data?.vault ?? t.data?.vaultBalance ?? 0)) + 1e-9);
    const rate = `${Math.round(SELL_RATE * 100)}%`;
    const undo = paid > 0 && back >= paid;
    let note;
    if (undo) note = 'Full refund until the next wave';
    else if (back > 0) note = `This phase's upgrades (${int(back)}) refund in full, the rest ${rate}`;
    else note = `Refunds ${rate} of credits paid`;
    if (vault >= 1) note += `, plus ${int(vault)} from the vault`;
    return { value, undo, note };
  }

  _heroNotes(def, level, info) {
    const list = def.abilities || def.skills || null;
    const maxL = def.hero?.maxLevel || 20;
    const nextNote = level < maxL ? def.hero?.levelNotes?.[level - 1] : null;
    const nextLine = nextNote ? `<p class="hero-next"><b>Level ${level + 1}:</b> ${esc(clean(nextNote))}</p>` : '';
    if (Array.isArray(list) && list.length) {
      return `<ul class="hero-abil">${list.map((a) => {
        const lvl = a.level ?? a.unlock ?? 0;
        const on = level >= lvl;
        return `<li class="${on ? 'on' : ''}" tabindex="0" data-tip-title="${esc(clean(a.name || ''))}" data-tip-sub="${on ? 'Unlocked' : `Unlocks at level ${lvl}`}" data-tip-body="${esc(clean(a.desc || ''))}"><span class="hero-abil__lvl">L${lvl}</span><span class="hero-abil__name">${esc(clean(a.name || ''))}</span></li>`;
      }).join('')}</ul>${nextLine}`;
    }
    const have = (info?.abilities || []).map((a) => `<li class="on"><span class="hero-abil__lvl">${icon('bolt')}</span><span class="hero-abil__name">${esc(clean(a.name || a.id))}</span></li>`).join('');
    const next = level < 3 ? 'First ability at level 3'
      : level < 10 ? 'Second ability at level 10'
        : level < 16 ? 'Abilities grow stronger at level 16'
          : level < 20 ? 'Full power at level 20' : 'Full power';
    return `${have ? `<ul class="hero-abil">${have}</ul>` : ''}<p class="hero-next">${esc(next)}</p>`;
  }

  _hasMortar(t) {
    const atks = t.stats?.attacks || this._defOf(t).base?.attacks || {};
    return Object.values(atks).some((a) => a && a.kind === 'mortar');
  }

  // ======================================================================= commands on selection

  upgradeSelected(path) {
    const sim = this.sim;
    const id = this.state.selectedTowerId;
    if (!sim || id == null || this.game.over) return;
    const t = this._tower(id);
    if (!t || this._isHero(t)) return;
    let r;
    try { r = sim.upgrade(t.id, path); } catch (err) { console.error(err); r = { ok: false, reason: 'invalid' }; }
    if (!okOf(r)) {
      let u = null;
      try { u = sim.upgradeInfo(t.id, path); } catch { u = null; }
      const why = u?.state === 'unaffordable' ? 'Not enough credits'
        : u?.state === 'maxed' ? 'Path maxed'
          : friendlyReason(r?.reason || u?.reason);
      this.toast(why, 'bad');
      const card = this.tp?.paths?.[path]?.el;
      if (card) { card.classList.remove('nudge'); void card.offsetWidth; card.classList.add('nudge'); }
    } else {
      const card = this.tp?.paths?.[path]?.el;
      if (card) { card.classList.remove('bought'); void card.offsetWidth; card.classList.add('bought'); }
    }
    this._panelDirty = true;
    this._refreshTowerPanel();
  }

  cycleTargeting(dir = 1) {
    const sim = this.sim;
    const t = this._tower(this.state.selectedTowerId);
    if (!sim || !t) return;
    // towers that never pick targets (Rigs, Beacons) have no targeting row: nothing to cycle
    if (!hasTargetingAttack(t.stats) && !this._isHero(t)) return;
    let info = {};
    try { info = sim.towerInfo(t.id) || {}; } catch { info = {}; }
    const modes = info.modes || t.stats?.targetModes || this._defOf(t).base?.targetModes || ['first', 'last', 'strong', 'close'];
    if (modes.length <= 1) return;
    const cur = modes.indexOf(info.targeting || t.targeting);
    const next = modes[(cur + dir + modes.length) % modes.length];
    try { sim.setTargeting(t.id, next); } catch (err) { console.error(err); }
    this._refreshTowerPanel();
  }

  toggleAim() {
    const t = this._tower(this.state.selectedTowerId);
    if (!t) return;
    this.state.aimingTowerId = this.state.aimingTowerId === t.id ? null : t.id;
    if (this.state.aimingTowerId && this.placeType) this.cancelPlacing();
    this._refreshTowerPanel();
  }

  setAim(x, y) {
    const sim = this.sim;
    const id = this.state.aimingTowerId;
    if (!sim || id == null) return false;
    let r;
    try { r = sim.setAim(id, x, y); } catch (err) { console.error(err); r = { ok: false }; }
    if (r && typeof r === 'object' && r.ok === false) this.toast(friendlyReason(r.reason), 'bad');
    return true;
  }

  withdraw() {
    const sim = this.sim;
    const t = this._tower(this.state.selectedTowerId);
    if (!sim || !t) return;
    let r;
    try { r = sim.withdraw(t.id); } catch (err) { console.error(err); r = { ok: false }; }
    if (!okOf(r)) this.toast(friendlyReason(r?.reason || 'Vault is empty'), 'bad');
    else {
      const amt = numOf(r);
      if (amt > 0) this.toast(`Withdrew ${int(amt)} credits`, 'good');
    }
    this._refreshTowerPanel();
  }

  /** Sell the selected tower. From the keyboard the first press arms, the second confirms. */
  sellSelected(immediate = false) {
    const sim = this.sim;
    const t = this._tower(this.state.selectedTowerId);
    if (!sim || !t || this.game.over) return;
    const now = performance.now();
    if (!immediate && now >= this._sellArmedUntil) {
      this._sellArmedUntil = now + 2200;
      const sell = this._sellInfo(sim, t);
      this.toast(`Press again to ${sell.undo ? 'undo' : 'sell'} for ${int(sell.value)} credits`, 'info');
      this._refreshTowerPanel();
      return;
    }
    this._sellArmedUntil = 0;
    let r;
    try { r = sim.sell(t.id); } catch (err) { console.error(err); r = { ok: false, reason: 'invalid' }; }
    if (!okOf(r)) { this.toast(friendlyReason(r?.reason), 'bad'); return; }
    this.deselect();
  }

  // ======================================================================= events

  // One teaching hint per run the first time an enemy leaks because of its immunities.
  _leakHint(type) {
    const hint = LEAK_HINTS[type];
    if (!hint || !this.sim || this.game.over) return;
    if (this._hintSim !== this.sim) { this._hintSim = this.sim; this._hintsShown = new Set(); }
    if (this._hintsShown.has(type)) return;
    this._hintsShown.add(type);
    this.toast(hint, 'tip', 7000);
  }

  onEvents(events) {
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      switch (e.t) {
        case 'waveStart':
          if (this.sim && this._seen) this._markSeen(this.sim, e.wave);
          if (this._coach) { this._coach = 0; this._renderCoach(); this.game.updateSettings({ coach: false }); }
          this.banner(`Wave ${e.wave}`, e.name || (e.titan || e.wave % TITAN_EVERY === 0 ? 'Titan wave' : ''), 'wave');
          if (e.tip && !this.game.over) this.toast(e.tip, 'tip', 6000);
          this._previewWave = -1;
          this._maybeZoomHint();
          break;
        case 'waveCleared':
          this.banner(`Wave ${e.wave} cleared`, e.bonus ? `+${int(e.bonus)} bonus` : '', 'clear');
          this._panelDirty = true;
          break;
        case 'titan':
          this.banner(e.name || 'Storm Titan', 'A Storm Titan approaches', 'titan');
          break;
        case 'titanDown':
          this.banner('Titan destroyed', e.name || '', 'win');
          break;
        case 'heroLevel': {
          const def = this.data.HEROES[e.type];
          // the level's note, shortened to its headline ("Orbital Salvo II", "Twin Rifle") when long
          let note = clean(def?.hero?.levelNotes?.[e.level - 2] || '');
          if (note.length > 70) {
            const head = note.split(':')[0];
            const first = note.split('. ')[0];
            note = head.length < note.length && head.length <= 32 ? head : first.length <= 70 ? first.replace(/\.$/, '') : '';
          }
          this.toast(`${def?.name || 'Commander'} reached level ${e.level}${note ? `: ${note}` : ''}`, 'good', note ? 4200 : undefined);
          this._panelDirty = true;
          break;
        }
        case 'leak': {
          this._leakHint(e.type);
          const now = performance.now();
          if (now - this._lastLeakFlash > 120) {
            this._lastLeakFlash = now;
            this.$livesStat.classList.remove('hit');
            void this.$livesStat.offsetWidth;
            this.$livesStat.classList.add('hit');
          }
          break;
        }
        case 'place':
        case 'upgrade':
        case 'sell':
          if (e.t === 'upgrade' && e.tier === 5) {
            const def = this.data.TOWERS[e.type];
            this.banner(e.name || 'Tier 5', `${def?.name || 'Tower'} reaches tier 5`, 'win');
          }
          if (e.t === 'place' && this._coach === 1) { this._coach = 2; this._renderCoach(); }
          if (e.t === 'place') this._maybeZoomHint();
          this._panelDirty = true;
          if (e.t === 'sell' && (e.tower === this.state.selectedTowerId)) this.deselect();
          if (this.placeType && this.state.placing) {
            const p = this.state.placing;
            this.moveGhost(p.x, p.y);
          }
          break;
        case 'cash':
          if (e.reason === 'wave' || e.reason === 'bonus') this._pulseCash();
          break;
        default:
          break;
      }
    }
  }

  _pulseCash() {
    this.$cashStat.classList.remove('gain');
    void this.$cashStat.offsetWidth;
    this.$cashStat.classList.add('gain');
  }

  // ======================================================================= per-frame update

  update(sim, dt) {
    if (!sim) return;
    this._frame++;
    const s = sim.state;

    // --- top bar
    setText(this.$lives, int(Math.max(0, s.lives)));
    const lowLives = s.maxLives > 1 ? s.lives / s.maxLives <= 0.25 : false;
    setClass(this.$livesStat, 'low', lowLives && s.lives > 0);
    setText(this.$cash, money(s.cash));
    setText(this.$wave, String(s.wave));
    const best = Math.max(this.game.run?.best || 0, s.cleared || 0);
    setText(this.$best, `Best ${best}`);
    for (const b of this.$speedBtns) {
      const on = Number(b.dataset.speed) === this.game.speed;
      setClass(b, 'is-on', on);
      setAttr(b, 'aria-pressed', String(on));
    }
    setText(this.$speedCycle, `${this.game.speed}x`);
    setClass(this.$speedCycle, 'is-fast', this.game.speed > 1);
    setAttr(this.$speedCycle, 'aria-label', `Game speed ${this.game.speed}x. Tap to change`);
    const auto = !!s.autoStart;
    setClass(this.$auto, 'is-on', auto);
    setAttr(this.$auto, 'aria-pressed', String(auto));
    this._updateWaveButtons(sim);

    // --- shop affordability
    this._updateTiles(false);
    this._updateHeroTile(sim);

    // --- next wave preview
    if (s.wave !== this._previewWave) this._updatePreview(sim);

    // --- selected tower panel (throttled)
    this._panelT += dt;
    if (this.state.selectedTowerId != null && (this._panelDirty || this._panelT > 0.12)) {
      this._panelT = 0;
      this._panelDirty = false;
      this._refreshTowerPanel();
    }
    if (this._sellArmedUntil && performance.now() > this._sellArmedUntil) {
      this._sellArmedUntil = 0;
      this._refreshTowerPanel();
    }

    // --- abilities
    if ((this._frame & 1) === 0) this._updateAbilities(sim);

    // --- titan
    this._updateTitan(s);

    // --- aim hint, coach, ghost tag
    const aiming = this.state.aimingTowerId != null;
    setHidden(this.$aimHint, !aiming);
    if (aiming) {
      setText(this.$aimText, this.game.isTouch
        ? 'Tap the map to set the target. Tap Set Target again to finish.'
        : 'Click the map to set the target. Press Esc to finish.');
    }
    if (this._coach) {
      setHidden(this.$coach, aiming || !!s.titan);
      this._fadeCoach();
    }
    this._updateGhostTag();
    if (this.game.isTouch) this._updateTouchControls();
    setHidden(this.$viewCtl, !((this.game.renderer?.zoom || 1) > 1.01));
  }

  /** The coach bubble fades while the ghost or the pointer is near it (towers can sit there). */
  _fadeCoach() {
    const c = this.$coach;
    if (!c || c.hidden) return;
    const p = this.state.placing;
    const pw = this.game.pointerWorld;
    let pt = null;
    if (p) pt = this.game.worldToScreen(p.x, p.y);
    else if (pw && pw.inside && !this.game.isTouch) pt = { x: pw.px, y: pw.py };
    let near = false;
    if (pt) {
      const cr = c.getBoundingClientRect(), vr = this.game.canvas.getBoundingClientRect();
      const x = vr.left + pt.x, y = vr.top + pt.y;
      near = x > cr.left - 50 && x < cr.right + 50 && y < cr.bottom + 70 && y > cr.top - 70;
    }
    setClass(c, 'is-faded', near);
  }

  _updateWaveButtons(sim) {
    const s = sim.state;
    const next = s.wave + 1;
    let can = false;
    try { can = okOf(sim.canStartWave()); } catch { can = false; }
    // the Space hint only helps with a keyboard
    let label, mode, disabled = false, sub = this.game.isTouch ? '' : 'Space';
    if (s.phase === 'over' || this.game.over) { label = 'Core lost'; mode = 'over'; disabled = true; sub = ''; }
    else if (s.phase === 'build') { label = `Launch Wave ${next}`; mode = 'launch'; disabled = !can; }
    else if (can) { label = `Send Wave ${next} early`; mode = 'early'; }
    else { label = `Wave ${s.wave} spawning`; mode = 'busy'; disabled = true; sub = 'Wait for the last spawn'; }
    const titan = next % TITAN_EVERY === 0 && mode !== 'busy' && mode !== 'over';
    const compactLabel = mode === 'launch' ? `Wave ${next}` : mode === 'early' ? `Send ${next}` : mode === 'busy' ? `Wave ${s.wave}` : 'Over';
    for (let i = 0; i < this.$waveBtns.length; i++) {
      const b = this.$waveBtns[i];
      if (!b) continue;
      const main = b.querySelector('.wave-btn__main');
      setText(main, i === 0 ? label : compactLabel);
      const subEl = b.querySelector('.wave-btn__sub');
      if (subEl) setText(subEl, titan ? 'Titan wave' : sub);
      setAttr(b, 'data-mode', mode);
      setClass(b, 'is-titan', titan);
      setAttr(b, 'aria-disabled', disabled ? 'true' : null);
      setAttr(b, 'aria-label', `${label}${titan ? ', Titan wave' : ''}${this.game.isTouch ? '' : ' (Space)'}`);
      const ic = b.querySelector('.wave-btn__icon');
      setHTML(ic, mode === 'early' ? icon('fast') : icon('play'));
    }
  }

  _updateTiles(force) {
    if (!this._tiles || !this.sim) return;
    const s = this.sim.state;
    for (const tile of this._tiles) {
      const capped = tile.isRig && s.rigCount >= RIG_CAP;
      const poor = s.cash < tile.price;
      setClass(tile.el, 'is-poor', poor);
      setClass(tile.el, 'is-capped', capped);
      setClass(tile.el, 'is-active', this.placeType === tile.type);
      if (force) setAttr(tile.el, 'aria-pressed', String(this.placeType === tile.type));
    }
  }

  _updateHeroTile(sim) {
    const h = this._hero;
    if (!h) return;
    const tower = this._heroTower();
    const s = sim.state;
    // every state class is written in both branches, so none can go stale
    if (tower) {
      const hp = this.heroProgress(tower);
      const key = `on:${hp.level}:${Math.round(hp.frac * 50)}:${this.state.selectedTowerId === tower.id}`;
      if (key !== this._heroKey) {
        this._heroKey = key;
        h.el.dataset.heroSelect = String(tower.id);
        delete h.el.dataset.type;
        setHidden(h.priceEl, true);
        setHidden(h.lvlEl, false);
        setHidden(h.xpEl, false);
        setHidden(h.keyEl, true);
        setText(h.lvlEl, hp.max ? 'Level 20' : `Level ${hp.level}`);
        setVar(h.xpEl, '--fill', String(hp.frac));
        setClass(h.el, 'is-deployed', true);
        setClass(h.el, 'is-selected', this.state.selectedTowerId === tower.id);
        setClass(h.el, 'is-active', false);
        setClass(h.el, 'is-poor', false);
        setAttr(h.el, 'aria-label', `${h.def.name}, level ${hp.level}. Select`);
      }
    } else {
      const key = `off:${s.cash >= h.price}:${this.placeType === h.id}`;
      if (key !== this._heroKey) {
        this._heroKey = key;
        delete h.el.dataset.heroSelect;
        h.el.dataset.type = h.id;
        setHidden(h.priceEl, false);
        setHidden(h.lvlEl, true);
        setHidden(h.xpEl, true);
        setHidden(h.keyEl, false);
        setClass(h.el, 'is-deployed', false);
        setClass(h.el, 'is-selected', false);
        setClass(h.el, 'is-poor', s.cash < h.price);
        setClass(h.el, 'is-active', this.placeType === h.id);
        setAttr(h.el, 'aria-label', `Deploy ${h.def.name}, ${int(h.price)} credits${this.game.isTouch ? '' : ', hotkey U'}`);
      }
    }
  }

  _updatePreview(sim) {
    const s = sim.state;
    this._previewWave = s.wave;
    const w = s.wave + 1;
    let list = [];
    try { list = sim.wavePreview(w) || []; } catch (err) { console.error(err); list = []; }
    let info = null;
    try { info = typeof sim.waveInfo === 'function' ? sim.waveInfo(w) : null; } catch { info = null; }
    setText(this.$previewWave, `Wave ${w}`);
    setText(this.$previewName, info?.name ? clean(info.name) : '');
    const titan = w % TITAN_EVERY === 0;
    const tags = [];
    if (titan) tags.push('<span class="tag tag--titan">Titan</span>');
    if (list.some((g) => g.mods?.phantom)) tags.push('<span class="tag tag--phantom">Phantom</span>');
    setHTML(this.$previewTags, tags.join(''));

    // merge identical entries
    const merged = new Map();
    for (const g of list) {
      const mods = g.mods || {};
      const k = `${g.type}|${mods.phantom ? 1 : 0}${mods.nanite ? 1 : 0}${mods.plated ? 1 : 0}${mods.scout ? 1 : 0}`;
      const m = merged.get(k);
      if (m) m.count += g.count || 0;
      else merged.set(k, { type: g.type, count: g.count || 0, mods });
    }
    const items = [...merged.values()];
    const ENEMIES = this.data.ENEMIES;
    const frag = document.createDocumentFragment();
    const mini = document.createDocumentFragment();
    const titanTip = { title: 'Storm Titan', sub: `Wave ${w}`, body: 'A boss ship with a health bar at the top of the screen. Leaking it ends the run.' };
    if (titan) {
      // first in the compact strip, so it is never cut off
      const m = el('span', 'pv pv--mini pv--titan');
      m.innerHTML = `<span class="pv__skull">${icon('skull')}</span><span class="pv__n">Titan</span>`;
      m._tip = titanTip;
      mini.appendChild(m);
    }
    items.forEach((g) => {
      const def = ENEMIES[g.type];
      const name = def?.name || g.type;
      const badges = [
        g.mods.phantom ? '<i class="mod mod--phantom">P</i>' : '',
        g.mods.nanite ? '<i class="mod mod--nanite">N</i>' : '',
        g.mods.plated ? '<i class="mod mod--plated">+</i>' : '',
      ].join('');
      const seen = this._seen || new Set();
      const fresh = w > 1 && (!seen.has(g.type) || (g.mods.phantom && !seen.has('mod:phantom')) || (g.mods.nanite && !seen.has('mod:nanite')) || (g.mods.plated && !seen.has('mod:plated')));
      const tip = this._enemyTip(g, def, name, fresh);
      const d = el('div', `pv${fresh ? ' pv--new' : ''}`);
      d.tabIndex = 0;
      d.setAttribute('aria-label', `${g.count} ${tip.title}. ${tip.body}`);
      d._tip = tip;
      d.innerHTML = `<canvas></canvas><span class="pv__n">${short(g.count)}</span>${badges ? `<span class="pv__mods">${badges}</span>` : ''}${fresh ? '<span class="pv__new">New</span>' : ''}`;
      this.game.icons.enemy(d.querySelector('canvas'), g.type, 30, g.mods);
      frag.appendChild(d);
      const m = el('span', `pv pv--mini${fresh ? ' pv--new' : ''}`);
      m._tip = tip;
      m.innerHTML = `<canvas></canvas><span class="pv__n">${short(g.count)}</span>${badges ? `<span class="pv__mods">${badges}</span>` : ''}${fresh ? '<span class="pv__dot"></span>' : ''}`;
      this.game.icons.enemy(m.querySelector('canvas'), g.type, 22, g.mods);
      mini.appendChild(m);
    });
    if (titan) {
      const d = el('div', 'pv pv--titan');
      d.tabIndex = 0;
      d._tip = titanTip;
      d.setAttribute('aria-label', 'Storm Titan');
      d.innerHTML = `<span class="pv__skull">${icon('skull')}</span><span class="pv__n">Titan</span>`;
      frag.appendChild(d);
    }
    if (!items.length && !titan) frag.appendChild(el('div', 'preview__empty', 'Scanning the storm'));
    this.$previewList.replaceChildren(frag);
    this.$miniList.replaceChildren(mini);
    this._fitMini();
  }

  /** Tooltip text for one entry of the wave preview. */
  _enemyTip(g, def, name, fresh) {
    const lines = [];
    if (g.mods.phantom) lines.push('Phantom: only towers with detection can target it.');
    if (g.mods.nanite) lines.push('Nanite: regrows a grade after 3 s without damage.');
    if (g.mods.plated) lines.push('Plated: double shell HP.');
    if (g.mods.scout) lines.push('Scout: an empty hold and a light hull.');
    const imm = (def?.immune || []).map((t) => dtypeLabel(t));
    if (imm.length) lines.push(`Immune to ${imm.join(' and ')}.`);
    if (!lines.length) lines.push(def?.kind === 'ship' ? 'A ship. It cracks open and spills its cargo.' : 'No immunities.');
    const mods = [g.mods.phantom ? 'Phantom' : '', g.mods.nanite ? 'Nanite' : '', g.mods.plated ? 'Plated' : ''].filter(Boolean).join(' ');
    return { title: `${mods ? mods + ' ' : ''}${name}`, sub: `${int(g.count)} in the next wave${fresh ? '. New threat' : ''}`, body: lines.join(' ') };
  }

  /** Marks a full ability bar as scrollable (its edges fade to show there is more). */
  _abilityScroll() {
    const a = this.$abilities;
    if (!a) return;
    const over = a.scrollWidth > a.clientWidth + 1 || a.scrollHeight > a.clientHeight + 1;
    setClass(a, 'is-scroll', over);
  }

  /** Compact drawer head: show the preview icons that fit and count the rest. */
  _fitMini() {
    this._abilityScroll();
    const list = this.$miniList;
    if (!list) return;
    const kids = [...list.children];
    for (const k of kids) k.hidden = false;
    setText(this.$miniMore, '');
    if (!kids.length || list.offsetParent === null) return;
    const hideOverflow = () => {
      const right = list.getBoundingClientRect().right;
      let n = 0;
      for (const k of kids) {
        if (k.classList.contains('pv--titan')) continue;
        if (n || k.getBoundingClientRect().right > right + 0.5) { k.hidden = true; n++; }
      }
      return n;
    };
    let n = hideOverflow();
    if (n) {
      setText(this.$miniMore, `+${n}`);
      for (const k of kids) k.hidden = false;
      n = hideOverflow();
      setText(this.$miniMore, n ? `+${n}` : '');
    }
  }

  _updateAbilities(sim) {
    let bar = [];
    try { bar = sim.abilityBar() || []; } catch { bar = []; }
    const key = bar.map((a) => a.id).join('|');
    this._abilityData.clear();
    bar.forEach((a, i) => this._abilityData.set(a.id, { a, i }));
    if (key !== this._abilityKey) {
      this._abilityKey = key;
      this._abilityEls.clear();
      setClass(this.cmd, 'has-abilities', bar.length > 0);
      if (this._tipFor && String(this._tipFor).startsWith('ab:')) this._hideTip();
      const frag = document.createDocumentFragment();
      bar.forEach((a, i) => {
        const b = el('button', 'ab');
        b.type = 'button';
        b.dataset.id = a.id;
        b.innerHTML = `<canvas></canvas><span class="ab__sweep"></span><span class="ab__glyph"></span><span class="ab__cd"></span>${i < 9 ? `<kbd class="ab__key">${i + 1}</kbd>` : ''}<span class="ab__count"></span>`;
        const tower = this._tower(a.towerIds?.[0]);
        if (tower) {
          const def = this._defOf(tower);
          if (this._isHero(tower)) this.game.icons.hero(b.querySelector('canvas'), def, 40);
          else this.game.icons.tower(b.querySelector('canvas'), def, 40, this._variant(tower));
        }
        const ge = b.querySelector('.ab__glyph');
        if (typeof a.icon === 'string' && a.icon.length > 2 && hasIcon('ab_' + a.icon)) {
          ge.innerHTML = icon('ab_' + a.icon);
          ge.classList.add('ab__glyph--svg');
        } else ge.textContent = typeof a.icon === 'string' && a.icon.length <= 2 ? a.icon : '';
        frag.appendChild(b);
        this._abilityEls.set(a.id, { el: b, sweep: b.querySelector('.ab__sweep'), count: b.querySelector('.ab__count'), cd: b.querySelector('.ab__cd') });
      });
      this.$abilities.replaceChildren(frag);
      this._abilityScroll();
    }
    for (let i = 0; i < bar.length; i++) {
      const a = bar[i];
      const r = this._abilityEls.get(a.id);
      if (!r) continue;
      const frac = a.ready ? 0 : Math.max(0, Math.min(1, Number(a.cdFrac) || 0));
      setVar(r.el, '--cd', frac.toFixed(3));
      const usable = !!a.ready && a.usable !== false;
      setClass(r.el, 'is-ready', usable);
      setClass(r.el, 'is-waiting', !!a.ready && !usable);
      const n = a.towerIds?.length || 0;
      setText(r.count, n > 1 ? `x${n}` : '');
      setText(r.cd, a.ready || !(a.cd > 0) ? '' : String(Math.ceil(a.cd)));
      setAttr(r.el, 'aria-label', `${clean(a.name || a.id)}${usable ? ', ready' : a.ready ? ', ready when the next wave starts' : ', cooling down'}${i < 9 && !this.game.isTouch ? `. Hotkey ${i + 1}` : ''}`);
      setAttr(r.el, 'aria-disabled', usable ? null : 'true');
    }
  }

  abilityAt(index) {
    const sim = this.sim;
    if (!sim) return null;
    let bar = [];
    try { bar = sim.abilityBar() || []; } catch { bar = []; }
    return bar[index] || null;
  }

  _updateTitan(s) {
    const t = s.titan;
    setHidden(this.$titan, !t);
    if (!t) return;
    setText(this.$titanName, clean(t.name || 'Storm Titan'));
    const hpFrac = t.maxHp > 0 ? Math.max(0, t.hp / t.maxHp) : 0;
    setVar(this.$titanHp, '--fill', hpFrac.toFixed(4));
    const sh = t.maxShield > 0 ? Math.max(0, (t.shield || 0) / t.maxShield) : 0;
    setVar(this.$titanShield, '--fill', sh.toFixed(4));
    setHidden(this.$titanShield, !(t.maxShield > 0));
    setHidden(this.$titanShieldIco, !(t.maxShield > 0 && t.shield > 0) || !this.$titanShieldIco.firstElementChild);
    setText(this.$titanNum, `${short(Math.max(0, t.hp))} / ${short(t.maxHp)}${t.maxShield > 0 && t.shield > 0 ? `  +${short(t.shield)} shield` : ''}`);
  }

  _updateGhostTag() {
    const p = this.state.placing;
    if (!p || !this.game.renderer) { setHidden(this.$ghostTag, true); return; }
    const pt = this.game.worldToScreen(p.x, p.y);
    if (!pt) { setHidden(this.$ghostTag, true); return; }
    setHidden(this.$ghostTag, false);
    const def = this.data.TOWERS[p.type] || this.data.HEROES[p.type];
    const r = (def?.radius || 22) * (this.game.worldScale() || 1);
    this.$ghostTag.style.transform = `translate(${Math.round(pt.x)}px, ${Math.round(pt.y + r + 10)}px) translate(-50%, 0)`;
    setHTML(this.$ghostPrice, credits(p.price));
    setText(this.$ghostWhy, p.valid ? '' : friendlyReason(p.reason));
    setClass(this.$ghostTag, 'is-bad', !p.valid);
  }

  setFps(text) {
    setHidden(this.$fps, !text);
    if (text) setHTML(this.$fps, text);
  }

  // ======================================================================= banners, toasts, tips

  banner(title, sub = '', kind = 'wave') {
    const reduce = this.game.reducedMotion;
    for (const old of [...this.$banners.children]) {
      old.classList.add('out');
      setTimeout(() => old.remove(), 260);
    }
    const b = el('div', `banner banner--${kind}${reduce ? ' banner--still' : ''}`);
    b.innerHTML = `<div class="banner__title">${esc(title)}</div>${sub ? `<div class="banner__sub">${kind === 'clear' ? glyph() : ''}${esc(sub)}</div>` : ''}`;
    this.$banners.appendChild(b);
    const life = kind === 'titan' ? 3200 : kind === 'win' ? 2600 : 1900;
    setTimeout(() => { b.classList.add('out'); setTimeout(() => b.remove(), 300); }, life);
  }

  toast(msg, kind = 'info', ms = 2200) {
    const text = String(msg);
    for (const t of this.$toasts.children) {
      if (t._msg === text) {
        t._n = (t._n || 1) + 1;
        t.querySelector('.toast__n').textContent = `x${t._n}`;
        clearTimeout(t._timer);
        t._timer = setTimeout(() => this._dropToast(t), ms);
        t.classList.remove('bump'); void t.offsetWidth; t.classList.add('bump');
        return;
      }
    }
    const t = el('div', `toast toast--${kind}`);
    t._msg = text;
    t.innerHTML = `<span class="toast__msg">${esc(text)}</span><span class="toast__n"></span>`;
    this.$toasts.appendChild(t);
    // the stack sits over the top of the map: three at most, two on small screens
    const max = this.game.layout === 'compact' ? 2 : 3;
    while (this.$toasts.children.length > max) this.$toasts.firstElementChild.remove();
    t._timer = setTimeout(() => this._dropToast(t), ms);
  }

  _dropToast(t) {
    t.classList.add('out');
    setTimeout(() => t.remove(), 250);
  }

  // ---- tooltips: mouse hover, keyboard focus, or a long press on touch ------------------

  /**
   * One floating tip serves shop cards, the Commander card, abilities, wave preview icons and
   * Commander ability rows. Touch has no hover, so a long press (450 ms, finger still) shows
   * the same tip instead of picking, firing or toggling, and the click that follows is eaten.
   */
  _initTips() {
    const SEL = '.tile, .hero-tile, .ab, .pv, .hero-abil li';
    const app = this.app;
    let lp = null;
    const stop = () => { if (lp) { clearTimeout(lp.timer); lp = null; } };
    app.addEventListener('pointerdown', (e) => {
      this._lastPointer = e.pointerType || this._lastPointer;
      this._suppress = null;
      if (this._tipTouch) this._hideTip();
      stop();
      if (e.pointerType === 'mouse') return;
      const t = e.target.closest?.(SEL);
      if (!t) return;
      const cur = { el: t, id: e.pointerId, x: e.clientX, y: e.clientY };
      cur.timer = setTimeout(() => {
        if (lp !== cur || !t.isConnected) return;
        this._suppress = t;
        this._showTipFor(t, true);
      }, 450);
      lp = cur;
    }, true);
    app.addEventListener('pointermove', (e) => {
      if (lp && e.pointerId === lp.id && Math.hypot(e.clientX - lp.x, e.clientY - lp.y) > 10) stop();
    }, true);
    const end = (e) => { if (lp && e.pointerId === lp.id) stop(); };
    app.addEventListener('pointerup', end, true);
    app.addEventListener('pointercancel', end, true);
    app.addEventListener('click', (e) => {
      const s = this._suppress;
      if (s && s.contains(e.target)) { this._suppress = null; e.preventDefault(); e.stopPropagation(); }
    }, true);
    app.addEventListener('contextmenu', (e) => { if (e.target.closest?.(SEL)) e.preventDefault(); });

    app.addEventListener('pointerover', (e) => {
      if (e.pointerType !== 'mouse') return;
      const t = e.target.closest?.(SEL);
      if (t && !(e.relatedTarget && t.contains(e.relatedTarget))) this._showTipFor(t, false);
    });
    app.addEventListener('pointerout', (e) => {
      if (e.pointerType !== 'mouse' || this._tipTouch) return;
      const t = e.target.closest?.(SEL);
      if (t && (!e.relatedTarget || !t.contains(e.relatedTarget))) this._hideTip();
    });
    app.addEventListener('focusin', (e) => {
      const t = e.target.closest?.(SEL);
      let fv = false;
      try { fv = e.target.matches(':focus-visible'); } catch { fv = false; }
      if (t && fv) this._showTipFor(t, false);
    });
    app.addEventListener('focusout', (e) => {
      const t = e.target.closest?.(SEL);
      if (t && !this._tipTouch && (!e.relatedTarget || !t.contains(e.relatedTarget))) this._hideTip();
    });
    // a scrolling panel or strip would leave the tip pointing at nothing
    for (const sc of [this.$body, this.$abilities]) sc?.addEventListener('scroll', () => { if (!this._tipTouch) this._hideTip(); }, { passive: true });
  }

  _showTipFor(t, touch) {
    if (!this.sim) return;
    if (t.matches('.tile')) this._showTip(t, touch);
    else if (t.matches('.hero-tile')) { if (this._hero) this._showTip(t, touch, this._hero.id); }
    else if (t.matches('.ab')) this._showAbilityTip(t, touch);
    else if (t._tip) this._placeTip(this._simpleTip(t._tip), t, 'auto', 'el', touch);
    else if (t.dataset.tipTitle) this._placeTip(this._simpleTip({ title: t.dataset.tipTitle, sub: t.dataset.tipSub, body: t.dataset.tipBody }), t, 'auto', 'el', touch);
  }

  _simpleTip({ title, sub, body }) {
    return `<div class="tip__head"><span class="tip__name">${esc(title || '')}</span></div>${sub ? `<div class="tip__sub">${esc(sub)}</div>` : ''}${body ? `<p class="tip__blurb">${esc(body)}</p>` : ''}`;
  }

  /** Places the tip beside `anchor` and keeps it inside the window. */
  _placeTip(html, anchor, side, key, touch) {
    if (this._tipFor !== key && !touch) this.game.uiHover();
    this._tipFor = key;
    this._tipTouch = !!touch;
    clearTimeout(this._tipTimer);
    if (touch) this._tipTimer = setTimeout(() => this._hideTip(), 4000);
    const tip = this.$tip;
    tip.innerHTML = html;
    tip.hidden = false;
    const r = anchor.getBoundingClientRect();
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    const W = window.innerWidth, H = window.innerHeight, m = 8;
    let x, y;
    if (side === 'panel') {
      const pr = this.panel.getBoundingClientRect();
      x = pr.left - tw - 10;
      y = r.top + r.height / 2 - th / 2;
      y = Math.max(this.hud.getBoundingClientRect().bottom + 8, y);
    } else if (side === 'left') {
      x = r.left - tw - 10;
      y = r.top + r.height / 2 - th / 2;
    } else {
      x = r.left + r.width / 2 - tw / 2;
      y = r.top - th - 10;
      if (y < m) y = r.bottom + 10;
    }
    x = Math.max(m, Math.min(W - tw - m, x));
    y = Math.max(m, Math.min(H - th - m, y));
    tip.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }

  _showTip(tile, touch = false, typeOverride = null) {
    const type = typeOverride || tile.dataset.type;
    const def = this.data.TOWERS[type] || this.data.HEROES[type];
    if (!def) return;
    const price = this.prices[type] ?? 0;
    const hero = type === this._heroId();
    const dt = primaryDtype(def.base);
    const range = def.base?.range;
    const det = def.base?.detection;
    const key = this.game.isTouch ? '' : hero ? (this.game.heroHotkey ? 'U' : '') : (def.hotkey || '').toUpperCase();
    const facts = [];
    if (dt) facts.push(`<span class="chip chip--dtype" style="--chip:var(--dt-${dt.toLowerCase()}, #9fb0cf)">${esc(dtypeLabel(dt))}</span>`);
    if (range === Infinity || Number.isFinite(range)) facts.push(`<span class="tip__fact">Range ${range >= 5000 ? 'global' : int(range)}</span>`);
    const aura = def.base?.aura?.radius;
    if (Number.isFinite(aura) && aura > 0) facts.push(`<span class="tip__fact">Aura ${int(aura)}</span>`);
    if (det) facts.push('<span class="tip__fact tip__fact--det">Detection</span>');
    const deployed = hero && this._heroTower();
    const html = `
      <div class="tip__head"><span class="tip__name">${esc(def.name)}</span>${key ? `<kbd>${esc(key)}</kbd>` : ''}</div>
      <p class="tip__blurb">${esc(clean(def.blurb || def.desc || def.role || ''))}</p>
      <div class="tip__facts">${facts.join('')}</div>
      ${deployed ? '' : `<div class="tip__price">${credits(price)}</div>`}`;
    const side = this.game.layout === 'wide' || this.app.classList.contains('is-short') ? 'panel' : 'auto';
    this._placeTip(html, tile, side, 'tower:' + type, touch);
  }

  _showAbilityTip(b, touch) {
    const d = this._abilityData.get(b.dataset.id);
    if (!d) return;
    const { a, i } = d;
    const usable = !!a.ready && a.usable !== false;
    const state = usable ? 'Ready' : a.ready ? 'Ready. Use it during a wave' : a.cd > 0 ? `Recharging, ${Math.ceil(a.cd)} s` : 'Recharging';
    const n = a.towerIds?.length || 0;
    const key = i < 9 && !this.game.isTouch ? `<kbd>${i + 1}</kbd>` : '';
    const html = `
      <div class="tip__head"><span class="tip__name">${esc(clean(a.name || a.id))}</span>${key}</div>
      <div class="tip__sub${usable ? ' tip__sub--ok' : ''}">${esc(state)}${n > 1 ? `. ${n} towers share it` : ''}</div>
      ${a.desc ? `<p class="tip__blurb">${esc(clean(a.desc))}</p>` : ''}`;
    const side = this.app.classList.contains('is-short') && this.game.layout === 'compact' ? 'left' : 'auto';
    this._placeTip(html, b, side, 'ab:' + a.id, touch);
  }

  _hideTip() {
    this._tipFor = null;
    this._tipTouch = false;
    clearTimeout(this._tipTimer);
    if (this.$tip) this.$tip.hidden = true;
  }
}
