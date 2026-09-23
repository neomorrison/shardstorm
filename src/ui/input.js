// Mouse, touch and keyboard input: placement ghost, tower selection, mortar aiming and hotkeys.
// Pointer coordinates go through the renderer's screenToWorld (CSS px relative to the canvas).

import { PATH_KEYS } from './ui.js';

const DRAG_PX = 9;           // touch movement before a tap becomes a drag
const PICK_PAD = 6;          // extra world units around a tower when picking it

export class Input {
  constructor(game) {
    this.game = game;
    this.canvas = game.canvas;
    this.touch = null;       // active one-finger gesture { id, sx, sy, lx, ly, gx, gy, drag, multi, placing }
    this.pts = new Map();    // touch pointers currently down: id -> { x, y } (client px)
    this.pinch = null;       // two-finger gesture { d0, z0, mx, my }
    this.mouse = null;       // mouse drag-pan { id, sx, sy, lx, ly, pan }
    this.shift = false;
    this._bound = false;
  }

  get ui() { return this.game.ui; }
  get sim() { return this.game.sim; }

  attach() {
    if (this._bound) return;
    this._bound = true;
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => this.onDown(e));
    c.addEventListener('pointermove', (e) => this.onMove(e));
    c.addEventListener('pointerup', (e) => this.onUp(e));
    c.addEventListener('pointercancel', (e) => this.onCancel(e));
    c.addEventListener('pointerleave', (e) => this.onLeave(e));
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    // iOS Safari: keep a pinch on the map from zooming the page (the game zooms instead).
    c.addEventListener('gesturestart', (e) => e.preventDefault());
    window.addEventListener('keydown', (e) => this.onKeyDown(e));
    window.addEventListener('keyup', (e) => this.onKeyUp(e));
    window.addEventListener('blur', () => { this.shift = false; if (this.ui) this.ui.state.showAllRanges = false; });
  }

  // ------------------------------------------------------------------ coordinates

  local(e) {
    const r = this.canvas.getBoundingClientRect();
    return { px: e.clientX - r.left, py: e.clientY - r.top, w: r.width, h: r.height };
  }

  world(e) {
    const l = this.local(e);
    const w = this.game.screenToWorld(l.px, l.py);
    return { x: w.x, y: w.y, px: l.px, py: l.py, inside: l.px >= 0 && l.py >= 0 && l.px <= l.w && l.py <= l.h };
  }

  /**
   * Tower under a world point (nearest within its radius plus padding). Commanders are drawn
   * as figures standing on their footprint, so their pick area also covers the figure above it.
   */
  towerAt(x, y) {
    const sim = this.sim;
    if (!sim) return null;
    let best = null, bd = Infinity;
    for (const t of sim.state.towers) {
      const r0 = t.radius || t.def?.radius || 20;
      const r = r0 + PICK_PAD;
      let d = Math.hypot(t.x - x, t.y - y);
      if (d > r && (t.hero || t.def?.hero)) {
        const up = t.y - y;
        if (up > 0 && up < r0 * 3.4 && Math.abs(t.x - x) < r0 * 0.95) d = r * 0.9;
      }
      if (d <= r && d < bd) { bd = d; best = t; }
    }
    return best;
  }

  active() {
    const g = this.game;
    return !!(g.sim && g.inGame && !g.screens.isOpen);
  }

  // ------------------------------------------------------------------ view (zoom and pan)

  get view() { return this.game.renderer; }

  zoomAt(factor, px, py) {
    const r = this.view;
    if (!r?.zoomAt) return false;
    const ok = r.zoomAt(factor, px, py);
    if (ok) this.game.onViewChange?.();
    return ok;
  }

  panBy(dx, dy) {
    const r = this.view;
    if (!r?.panBy) return false;
    const ok = r.panBy(dx, dy);
    if (ok) this.game.onViewChange?.();
    return ok;
  }

  zoomed() { return (this.view?.zoom || 1) > 1.001; }

  onWheel(e) {
    if (!this.active()) return;
    e.preventDefault();
    const l = this.local(e);
    // Trackpads send small pixel deltas, mice send lines; both map to a smooth factor.
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
    if (e.ctrlKey || Math.abs(dy) >= Math.abs(e.deltaX) || !this.zoomed()) {
      this.zoomAt(Math.exp(-Math.max(-240, Math.min(240, dy)) * 0.0018), l.px, l.py);
    } else {
      this.panBy(-e.deltaX, 0);
    }
    this._refreshHover(e);
  }

  _refreshHover(e) {
    const p = this.world(e);
    this.game.pointerWorld = p;
    const ui = this.ui;
    if (!ui || e.pointerType === 'touch') return;
    if (ui.placeType) ui.moveGhost(p.x, p.y);
  }

  // ------------------------------------------------------------------ pointer

  onDown(e) {
    if (!this.active()) return;
    this.game.unlockAudio();
    const p = this.world(e);
    this.game.pointerWorld = p;
    const ui = this.ui;
    if (e.pointerType === 'touch' || e.pointerType === 'pen') {
      this.game.setTouch(true);
      try { this.canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      e.preventDefault();
      this.pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pts.size === 2) {
        // Second finger: pinch-zoom and two-finger pan; the first finger's tap is cancelled.
        this._startPinch();
        if (this.touch) this.touch.multi = true;
        return;
      }
      if (this.pts.size > 2) return;
      const g = ui.state.placing;
      this.touch = { id: e.pointerId, sx: e.clientX, sy: e.clientY, lx: e.clientX, ly: e.clientY, gx: g ? g.x : p.x, gy: g ? g.y : p.y, drag: false, multi: false, placing: !!ui.placeType };
      return;
    }
    this.game.setTouch(false);
    if (e.button === 1 || (e.button === 0 && e.altKey)) {
      // Middle drag (or Alt+drag) always pans.
      e.preventDefault();
      this.mouse = { id: e.pointerId, sx: e.clientX, sy: e.clientY, lx: e.clientX, ly: e.clientY, pan: true };
      try { this.canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      return;
    }
    if (e.button === 2) { this.cancel(); return; }
    if (e.button !== 0) return;
    if (ui.state.aimingTowerId != null) {
      ui.setAim(p.x, p.y);
      return;
    }
    if (ui.placeType) {
      ui.moveGhost(p.x, p.y);
      ui.confirmPlace(e.shiftKey);
      return;
    }
    const t = this.towerAt(p.x, p.y);
    if (t) ui.select(t.id);
    else {
      ui.deselect();
      // Dragging empty ground pans a zoomed view.
      if (this.zoomed()) {
        this.mouse = { id: e.pointerId, sx: e.clientX, sy: e.clientY, lx: e.clientX, ly: e.clientY, pan: false };
        try { this.canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      }
    }
  }

  _startPinch() {
    const [a, b] = [...this.pts.values()];
    const r = this.canvas.getBoundingClientRect();
    this.pinch = {
      d0: Math.max(24, Math.hypot(a.x - b.x, a.y - b.y)),
      z0: this.view?.zoom || 1,
      mx: (a.x + b.x) / 2 - r.left, my: (a.y + b.y) / 2 - r.top,
    };
  }

  onMove(e) {
    const p = this.world(e);
    this.game.pointerWorld = p;
    if (!this.active()) return;
    const ui = this.ui;
    if (this.pts.has(e.pointerId)) {
      const pt = this.pts.get(e.pointerId);
      pt.x = e.clientX; pt.y = e.clientY;
      e.preventDefault();
      if (this.pinch && this.pts.size >= 2) {
        const [a, b] = [...this.pts.values()];
        const r = this.canvas.getBoundingClientRect();
        const mx = (a.x + b.x) / 2 - r.left, my = (a.y + b.y) / 2 - r.top;
        const d = Math.max(24, Math.hypot(a.x - b.x, a.y - b.y));
        const view = this.view;
        if (view?.setZoom) {
          const before = view.zoom;
          // Zoom about the previous midpoint, then carry that point to the new midpoint.
          view.setZoom(this.pinch.z0 * (d / this.pinch.d0), this.pinch.mx, this.pinch.my);
          view.panBy(mx - this.pinch.mx, my - this.pinch.my);
          if (view.zoom !== before || mx !== this.pinch.mx || my !== this.pinch.my) this.game.onViewChange?.();
        }
        this.pinch.mx = mx; this.pinch.my = my;
        return;
      }
    }
    const tg = this.touch;
    if (tg && e.pointerId === tg.id) {
      const dx = e.clientX - tg.sx, dy = e.clientY - tg.sy;
      if (!tg.drag && Math.hypot(dx, dy) > DRAG_PX) tg.drag = true;
      if (tg.drag && !tg.multi) {
        if (tg.placing && ui.placeType) {
          // relative drag so the finger never covers the ghost
          const k = this.game.worldScale() || 1;
          const x = clamp(tg.gx + dx / k, 0, 1500), y = clamp(tg.gy + dy / k, 0, 1000);
          ui.moveGhost(x, y);
        } else if (ui.state.aimingTowerId == null) {
          this.panBy(e.clientX - tg.lx, e.clientY - tg.ly);
        }
      } else if (tg.drag && tg.multi && !this.pinch) {
        // One finger left after a pinch keeps panning.
        this.panBy(e.clientX - tg.lx, e.clientY - tg.ly);
      }
      tg.lx = e.clientX; tg.ly = e.clientY;
      e.preventDefault();
      return;
    }
    const m = this.mouse;
    if (m && e.pointerId === m.id) {
      if (!m.pan && Math.hypot(e.clientX - m.sx, e.clientY - m.sy) > 5) m.pan = true;
      if (m.pan) {
        this.panBy(e.clientX - m.lx, e.clientY - m.ly);
        this.canvas.style.cursor = 'grabbing';
      }
      m.lx = e.clientX; m.ly = e.clientY;
      return;
    }
    if (e.pointerType !== 'mouse') return;
    if (ui.placeType) {
      ui.moveGhost(p.x, p.y);
      this.canvas.style.cursor = ui.state.placing?.valid ? 'copy' : 'not-allowed';
      ui.state.hoverTowerId = null;
      return;
    }
    if (ui.state.aimingTowerId != null) {
      this.canvas.style.cursor = 'crosshair';
      return;
    }
    const t = this.towerAt(p.x, p.y);
    ui.state.hoverTowerId = t ? t.id : null;
    this.canvas.style.cursor = t ? 'pointer' : this.zoomed() ? 'grab' : 'default';
  }

  onUp(e) {
    if (this.mouse && e.pointerId === this.mouse.id) {
      this.mouse = null;
      this.canvas.style.cursor = this.zoomed() ? 'grab' : 'default';
      return;
    }
    const wasPinch = !!this.pinch;
    if (this.pts.has(e.pointerId)) {
      this.pts.delete(e.pointerId);
      if (this.pts.size < 2) this.pinch = null;
      if (this.pts.size >= 2) this._startPinch();
    }
    const tg = this.touch;
    if (wasPinch && this.pts.size === 1) {
      // Hand the remaining finger over as a pan-only gesture.
      const [id, pt] = [...this.pts.entries()][0];
      this.touch = { id, sx: pt.x, sy: pt.y, lx: pt.x, ly: pt.y, gx: 0, gy: 0, drag: true, multi: true, placing: false };
      return;
    }
    if (!tg || e.pointerId !== tg.id) return;
    this.touch = null;
    if (!this.active()) return;
    if (tg.drag || tg.multi) return;
    const ui = this.ui;
    const p = this.world(e);
    // a tap
    if (ui.state.aimingTowerId != null) { ui.setAim(p.x, p.y); return; }
    if (ui.placeType) { ui.moveGhost(p.x, p.y); return; }
    const t = this.towerAt(p.x, p.y);
    if (t) ui.select(t.id);
    else ui.deselect();
  }

  onCancel(e) {
    this.pts.delete(e.pointerId);
    if (this.pts.size < 2) this.pinch = null;
    if (this.touch && this.touch.id === e.pointerId) this.touch = null;
    if (this.mouse && this.mouse.id === e.pointerId) this.mouse = null;
  }

  onLeave(e) {
    if (e.pointerType !== 'mouse') return;
    const ui = this.ui;
    if (!ui) return;
    if (this.mouse) return; // captured drag
    this.game.pointerWorld = { ...(this.game.pointerWorld || {}), inside: false };
    ui.state.hoverTowerId = null;
    if (ui.placeType) ui.hideGhost();
  }

  cancel() {
    const ui = this.ui;
    if (!ui) return false;
    if (ui.placeType) { ui.cancelPlacing(); return true; }
    if (ui.state.aimingTowerId != null) { ui.state.aimingTowerId = null; ui._refreshTowerPanel(); return true; }
    if (ui.state.selectedTowerId != null) { ui.deselect(); return true; }
    return false;
  }

  // ------------------------------------------------------------------ keyboard

  onKeyDown(e) {
    const g = this.game;
    g.unlockAudio();
    if (e.key === 'Shift') {
      this.shift = true;
      if (this.ui) this.ui.state.showAllRanges = true;
    }
    const target = e.target;
    const tag = target && target.tagName;
    const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable;

    // menus own the keyboard while open
    if (g.screens.isOpen) {
      const sc = g.screens;
      if (e.key === 'Tab') sc.kbdNav = true;
      if (e.key === 'Escape') { e.preventDefault(); sc.back(); }
      else if ((e.key === 'p' || e.key === 'P') && sc.current === 'pause' && !typing) { e.preventDefault(); g.resume(); }
      else if (this._strayActivation(e)) { e.preventDefault(); this._eatSpaceUp = e.key === ' '; }
      return;
    }
    if (!g.sim || !g.inGame || typing) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const ui = this.ui;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const focusBtn = target && (tag === 'BUTTON');

    switch (key) {
      case 'Escape':
        e.preventDefault();
        if (!this.cancel()) g.pause();
        return;
      case 'p':
        e.preventDefault();
        g.pause();
        return;
      case ' ':
      case 'Spacebar':
        // Space always drives the wave, even when a HUD button has focus
        e.preventDefault();
        if (!e.repeat) g.launchWave();
        return;
      case 'Tab':
        if (ui.state.selectedTowerId != null) {
          e.preventDefault();
          ui.cycleTargeting(e.shiftKey ? -1 : 1);
        }
        return;
      case 'Backspace':
      case 'Delete':
        if (ui.state.selectedTowerId != null) {
          e.preventDefault();
          if (!e.repeat) ui.sellSelected(false);
        }
        return;
      default:
        break;
    }
    // View: + and - zoom about the canvas center, 0 fits the whole map.
    if (key === '=' || key === '+' || key === '-' || key === '_') {
      e.preventDefault();
      const c = this.canvas;
      this.zoomAt(key === '-' || key === '_' ? 1 / 1.25 : 1.25, c.clientWidth / 2, c.clientHeight / 2);
      return;
    }
    if (e.repeat) return;
    if (key === '0') {
      e.preventDefault();
      if (this.view?.resetView?.()) this.game.onViewChange?.();
      return;
    }
    if (key === 'Enter' && focusBtn) return;

    const pi = PATH_KEYS.indexOf(key);
    if (pi >= 0 && ui.state.selectedTowerId != null) {
      e.preventDefault();
      ui.upgradeSelected(pi);
      return;
    }
    if (key >= '1' && key <= '9') {
      const a = ui.abilityAt(Number(key) - 1);
      if (a) { e.preventDefault(); g.useAbility(a.id); }
      return;
    }
    if (key === g.speedKey) {
      e.preventDefault();
      g.cycleSpeed();
      return;
    }
    if (key === 'u' && g.heroHotkey) {
      const hid = g.sim.state.heroId;
      if (hid) { e.preventDefault(); ui.shopPick(hid, false); }
      return;
    }
    const type = g.hotkeys[key];
    if (type) {
      e.preventDefault();
      ui.shopPick(type, false);
    }
  }

  /**
   * Space is the wave key and gets pressed constantly, so on the in-game modals (pause, game
   * over) it must not press the focused Resume or Retry button: Space only activates a button
   * the player reached with Tab. Enter works, but not in the first moments after the game over
   * screen appears, when a key meant for the game could still land on Retry.
   */
  _strayActivation(e) {
    const g = this.game;
    const sc = g.screens;
    if (!g.inGame || (sc.current !== 'pause' && sc.current !== 'gameover')) return false;
    if (e.target?.tagName !== 'BUTTON' && e.target !== document.body && !e.target?.classList?.contains('screen')) return false;
    if (e.key === ' ' || e.key === 'Spacebar') return !sc.kbdNav;
    if (e.key === 'Enter') return sc.current === 'gameover' && performance.now() - sc.openedAt < 700;
    return false;
  }

  onKeyUp(e) {
    if (this._eatSpaceUp && e.key === ' ') { this._eatSpaceUp = false; e.preventDefault(); }
    if (e.key === 'Shift') {
      this.shift = false;
      if (this.ui) this.ui.state.showAllRanges = false;
    }
  }
}

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
