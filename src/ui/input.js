// Mouse, touch and keyboard input: placement ghost, tower selection, mortar aiming and hotkeys.
// Pointer coordinates go through the renderer's screenToWorld (CSS px relative to the canvas).

import { PATH_KEYS } from './ui.js';

const DRAG_PX = 9;           // touch movement before a tap becomes a drag
const PICK_PAD = 6;          // extra world units around a tower when picking it

export class Input {
  constructor(game) {
    this.game = game;
    this.canvas = game.canvas;
    this.touch = null;       // active touch gesture { id, sx, sy, gx, gy, drag, placing }
    this.shift = false;
    this._down = null;
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
    c.addEventListener('pointercancel', () => { this.touch = null; });
    c.addEventListener('pointerleave', (e) => this.onLeave(e));
    c.addEventListener('contextmenu', (e) => e.preventDefault());
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

  /** Tower under a world point (nearest within its radius plus padding). */
  towerAt(x, y) {
    const sim = this.sim;
    if (!sim) return null;
    let best = null, bd = Infinity;
    for (const t of sim.state.towers) {
      const r = (t.radius || t.def?.radius || 20) + PICK_PAD;
      const d = Math.hypot(t.x - x, t.y - y);
      if (d <= r && d < bd) { bd = d; best = t; }
    }
    return best;
  }

  active() {
    const g = this.game;
    return !!(g.sim && g.inGame && !g.screens.isOpen);
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
      const g = ui.state.placing;
      this.touch = { id: e.pointerId, sx: e.clientX, sy: e.clientY, gx: g ? g.x : p.x, gy: g ? g.y : p.y, drag: false, placing: !!ui.placeType };
      e.preventDefault();
      return;
    }
    this.game.setTouch(false);
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
    else ui.deselect();
  }

  onMove(e) {
    const p = this.world(e);
    this.game.pointerWorld = p;
    if (!this.active()) return;
    const ui = this.ui;
    if (this.touch && e.pointerId === this.touch.id) {
      const dx = e.clientX - this.touch.sx, dy = e.clientY - this.touch.sy;
      if (!this.touch.drag && Math.hypot(dx, dy) > DRAG_PX) this.touch.drag = true;
      if (this.touch.drag && this.touch.placing && ui.placeType) {
        // relative drag so the finger never covers the ghost
        const k = this.game.worldScale() || 1;
        const x = clamp(this.touch.gx + dx / k, 0, 1500), y = clamp(this.touch.gy + dy / k, 0, 1000);
        ui.moveGhost(x, y);
      }
      e.preventDefault();
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
    this.canvas.style.cursor = t ? 'pointer' : 'default';
  }

  onUp(e) {
    const tg = this.touch;
    if (!tg || e.pointerId !== tg.id) return;
    this.touch = null;
    if (!this.active()) return;
    const ui = this.ui;
    const p = this.world(e);
    if (tg.drag) return;
    // a tap
    if (ui.state.aimingTowerId != null) { ui.setAim(p.x, p.y); return; }
    if (ui.placeType) { ui.moveGhost(p.x, p.y); return; }
    const t = this.towerAt(p.x, p.y);
    if (t) ui.select(t.id);
    else ui.deselect();
  }

  onLeave(e) {
    if (e.pointerType !== 'mouse') return;
    const ui = this.ui;
    if (!ui) return;
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
      if (e.key === 'Escape') { e.preventDefault(); g.screens.back(); }
      else if ((e.key === 'p' || e.key === 'P') && g.screens.current === 'pause' && !typing) { e.preventDefault(); g.resume(); }
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
    if (e.repeat) return;
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

  onKeyUp(e) {
    if (e.key === 'Shift') {
      this.shift = false;
      if (this.ui) this.ui.state.showAllRanges = false;
    }
  }
}

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
