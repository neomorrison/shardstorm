// class Sim: the only entry point clients use (docs/ARCHITECTURE.md sections 3, 4 and 6).
// Pure and deterministic: no DOM, no Math.random, no clocks. Randomness comes from this.rng().
import { Rng } from '../core/rng.js';
import { Hasher } from '../core/math.js';
import { MAPS } from '../data/maps.js';
import {
  DIFFICULTIES, TICK, WORLD_W, WORLD_H, RIG_CAP, waveBonus, heroXpForWave, heroXpNeed,
  HERO_MAX_LEVEL, TITAN_EVERY, titanHp,
} from '../data/economy.js';
import { Path } from './path.js';
import { SpatialHash } from './spatial.js';
import { buildWave, previewWave } from './wavegen.js';
import {
  createEnemy, createTitan, updateEnemies, damageEnemy, applyEffects as applyFx, TITAN_ORDER, TITAN_KINDS,
} from './enemies.js';
import {
  getDef, createTower, refreshTower, recomputeBuffs, findTarget as findTargetImpl, updateTowers,
  crosspathReason, normAttack,
} from './towers.js';
import { updateProjectiles, launchProjectile, explode as explodeImpl } from './projectiles.js';
import { snapDrones, removeTowerDrones, fireAt } from './attacks.js';
import {
  placePrice, basePrice, upgradePrice, sellValue as sellValueImpl, payWaveIncome, withdrawVault,
  refineryBonus, discountAt,
} from './economy.js';
import { updateAbilities, abilityBar as abilityBarImpl, useAbility as useAbilityImpl, addTempBuff, towersNear } from './abilities.js';
import { serializeSim, restoreSim } from './save.js';

export const EVENT_CAP = 4000;
export const AUTO_START_DELAY = 1.0;   // seconds of build phase before auto-start launches
export const CORE_KEEPOUT = 60;
export const BOUNDS_MARGIN = 10;
export const HERO_XP_PER_POP = 0.1;

const fail = (reason) => ({ ok: false, reason });

export class Sim {
  constructor({ mapId = 'crater', difficulty = 'pilot', seed = 1, heroId = null } = {}) {
    const map = MAPS[mapId];
    if (!map) throw new Error('Unknown map: ' + mapId);
    const diff = DIFFICULTIES[difficulty] || DIFFICULTIES.pilot;
    this.TICK = TICK;
    this.seed = seed;
    this._rng = new Rng(seed);
    this.map = map;
    this.paths = map.paths.map((pts) => new Path(pts, { step: 2, width: map.pathWidth }));
    this.lanes = this.paths.length;
    this.grid = new SpatialHash(64);
    this.state = {
      tick: 0, time: 0,
      mapId, difficulty: diff.id, heroId: heroId || null,
      phase: 'build',
      wave: 0,
      cleared: 0,
      cash: diff.startCash,
      lives: diff.lives, maxLives: diff.lives,
      autoStart: false,
      enemies: [], towers: [], projectiles: [], drones: [],
      titan: null,
      activeWaves: [],
      rigCount: 0,
      t5Owned: {},
      stats: { pops: 0, leaks: 0, massLeaked: 0, cashEarned: 0, damage: 0 },
    };
    this.events = [];
    // internals
    this._nextId = 1;
    this._nextProjId = 1;
    this._nextDroneId = 1;
    this._enemyById = new Map();
    this._towerById = new Map();
    this._waveAlive = new Map();
    this._runs = new Map();
    this._clearedSet = new Set();
    this._titans = [];
    this._liveEnemies = 0;
    this._buffsDirty = false;
    this._gridStale = true;
    this._auraTowers = [];
    this._refineries = [];
    this._heroTower = null;
    this._heroXpPending = 0;
    this._scheduled = [];
    this._autoTimer = AUTO_START_DELAY;
    this._snap = null;
    this._popsThisTick = 0;
    this._lastBlocked = false;
    this._projPool = [];
    // reusable scratch
    this._pt = { x: 0, y: 0, angle: 0 };
    this._pt2 = { x: 0, y: 0, angle: 0 };
    this._qFind = []; this._qProj = []; this._qProj2 = []; this._qExp = []; this._qArea = []; this._qLine = [];
    this._expDist = []; this._hitBuf = []; this._hitT = []; this._chainHit = []; this._hsExcl = [];
    this._lineHits = []; this._droneTaken = [];
  }

  static fromSave(save) {
    const sim = new Sim({ mapId: save.mapId, difficulty: save.difficulty, seed: save.seed, heroId: save.heroId });
    restoreSim(sim, save);
    return sim;
  }

  // ---------------------------------------------------------------- core helpers
  rng() { return this._rng.next(); }

  emit(ev) {
    const evs = this.events;
    evs.push(ev);
    if (evs.length > EVENT_CAP) evs.splice(0, evs.length - (EVENT_CAP - 500));
  }

  drainEvents() {
    const ev = this.events;
    this.events = [];
    return ev;
  }

  _waveAliveInc(w) {
    this._waveAlive.set(w, (this._waveAlive.get(w) || 0) + 1);
    this._liveEnemies++;
  }

  _removeEnemy(e) {
    if (e.dead) return;
    e.dead = true;
    this._liveEnemies--;
    const n = (this._waveAlive.get(e.wave) || 0) - 1;
    this._waveAlive.set(e.wave, n < 0 ? 0 : n);
  }

  _onPop(e, c, tower) {
    if (this._refineries.length) refineryBonus(this, e.x, e.y, c);
    if (tower && this._heroTower) this._heroXpPending += HERO_XP_PER_POP;
  }

  _ensureGrid() {
    if (this._gridStale) { this.grid.build(this.state.enemies); this._gridStale = false; }
  }

  // ---------------------------------------------------------------- simulation step
  step() {
    const st = this.state;
    if (st.phase === 'over') return;
    const dt = TICK;
    st.tick++;
    st.time = st.tick * TICK;
    this._popsThisTick = 0;
    if (this._scheduled.length) this._runScheduled();
    this._spawnTick(dt);
    updateEnemies(this, dt);
    this.grid.build(st.enemies);
    this._gridStale = false;
    if (this._buffsDirty) recomputeBuffs(this);
    updateTowers(this, dt);
    updateProjectiles(this, dt);
    updateAbilities(this, dt);
    this._compactEnemies();
    if (this._heroXpPending > 0 && this._heroTower) { const x = this._heroXpPending; this._heroXpPending = 0; this._addHeroXp(this._heroTower, x); }
    this._heroXpPending = 0;
    this._updateTitanState();
    if (st.lives <= 0) { this._gameOver(); return; }
    this._checkWaves();
    if (st.phase === 'build' && st.autoStart) {
      this._autoTimer -= dt;
      if (this._autoTimer <= 0) this.startWave();
    }
  }

  _runScheduled() {
    const now = this.state.time;
    const due = [];
    const keep = [];
    for (const s of this._scheduled) (s.at <= now + 1e-9 ? due : keep).push(s);
    this._scheduled = keep;
    this._ensureGrid();
    for (const s of due) s.fn(this);
  }

  _compactEnemies() {
    const list = this.state.enemies;
    let w = 0;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (e.dead) this._enemyById.delete(e.id);
      else list[w++] = e;
    }
    if (w !== list.length) { list.length = w; this._gridStale = true; }
  }

  _updateTitanState() {
    const st = this.state;
    if (!this._titans.length) { st.titan = null; return; }
    this._titans = this._titans.filter((e) => !e.dead);
    const e = this._titans[0];
    if (!e) { st.titan = null; return; }
    const T = e.titan;
    const o = st.titan && st.titan.id === e.id ? st.titan : {};
    o.id = e.id; o.name = T.name; o.kind = T.kind; o.tier = T.tier; o.wave = e.wave;
    o.hp = e.hp; o.maxHp = e.maxHp; o.shield = T.shield; o.maxShield = T.maxShield;
    o.trait = TITAN_KINDS[T.kind].trait;
    st.titan = o;
  }

  _spawnTick(dt) {
    const st = this.state;
    for (const aw of st.activeWaves) {
      if (aw.spawnDone) continue;
      const run = this._runs.get(aw.wave);
      aw.t += dt;
      const q = run.queue;
      while (run.idx < q.length && q[run.idx].time <= aw.t) {
        this._spawnEntry(run, q[run.idx]);
        run.idx++;
      }
      aw.spawnsLeft = q.length - run.idx;
      if (aw.spawnsLeft <= 0) aw.spawnDone = true;
    }
  }

  _spawnEntry(run, en) {
    const spec = run.spec;
    if (en.titan) {
      const e = createTitan(this, en.titan, { lane: en.lane, wave: spec.wave, speedMult: spec.speedMult || 1 });
      this._titans.push(e);
      return;
    }
    const mods = en.mods || {};
    createEnemy(this, en.type, {
      lane: en.lane, d: 0, wave: spec.wave,
      hullMult: spec.hullMult || 1, speedMult: spec.speedMult || 1,
      phantom: !!mods.phantom, nanite: !!mods.nanite, plated: !!mods.plated,
      off: (this.rng() - 0.5) * this.map.pathWidth * 0.36,
    });
  }

  _checkWaves() {
    const st = this.state;
    if (!st.activeWaves.length) return;
    const done = [];
    for (const aw of st.activeWaves) {
      if (aw.spawnDone && (this._waveAlive.get(aw.wave) || 0) === 0) done.push(aw.wave);
    }
    for (const w of done) this._waveCleared(w);
  }

  _waveCleared(w) {
    const st = this.state;
    st.activeWaves = st.activeWaves.filter((a) => a.wave !== w);
    this._runs.delete(w);
    this._waveAlive.delete(w);
    const bonus = waveBonus(w);
    st.cash += bonus;
    st.stats.cashEarned += bonus;
    const core = this.map.core;
    this.emit({ t: 'cash', amount: bonus, x: core.x, y: core.y, reason: 'wave' });
    payWaveIncome(this, w);
    if (this._heroTower) this._addHeroXp(this._heroTower, heroXpForWave(w));
    this._clearedSet.add(w);
    while (this._clearedSet.has(st.cleared + 1)) { this._clearedSet.delete(st.cleared + 1); st.cleared++; }
    if (!st.activeWaves.length && st.phase === 'wave') this._enterBuild();
    this.emit({ t: 'waveCleared', wave: w, bonus, cleared: st.cleared });
  }

  _enterBuild() {
    const st = this.state;
    st.phase = 'build';
    for (const p of st.projectiles) if (this._projPool.length < 4000) this._projPool.push(p);
    st.projectiles.length = 0;
    let hadTemp = false;
    for (const t of st.towers) {
      t.cd = {};
      t.target = null;
      t.disabledT = 0;
      if (t.tempBuffs.length) { t.tempBuffs.length = 0; hadTemp = true; }
      for (const k of Object.keys(t.data)) {
        if (k.startsWith('_beam_') || k.startsWith('_field_')) delete t.data[k];
      }
      if (t.data.beams) t.data.beams.length = 0;
    }
    if (hadTemp || this._buffsDirty) recomputeBuffs(this);
    snapDrones(this);
    this._scheduled = [];
    this._autoTimer = AUTO_START_DELAY;
    st.titan = null;
    this._titans = [];
    this._snap = null;
  }

  _gameOver() {
    const st = this.state;
    st.lives = 0;
    st.phase = 'over';
    this.emit({ t: 'gameOver', wave: st.cleared, cleared: st.cleared, reached: st.wave });
  }

  _addHeroXp(t, xp) {
    const h = t.hero;
    if (!h) return;
    const max = Math.min(HERO_MAX_LEVEL, (t.def.hero && t.def.hero.maxLevel) || HERO_MAX_LEVEL);
    if (h.level >= max) { h.xp = 0; return; }
    h.xp += xp;
    let up = false;
    while (h.level < max && h.xp >= heroXpNeed(h.level)) {
      h.xp -= heroXpNeed(h.level);
      h.level++;
      up = true;
    }
    if (h.level >= max) h.xp = 0;
    if (up) {
      refreshTower(this, t);
      recomputeBuffs(this);
      this.emit({ t: 'heroLevel', tower: t.id, type: t.type, level: h.level, x: t.x, y: t.y });
    }
  }

  // ---------------------------------------------------------------- waves
  canStartWave() {
    const st = this.state;
    if (st.phase === 'over') return false;
    if (st.phase === 'build') return true;
    return st.activeWaves.every((a) => a.spawnDone);
  }

  startWave() {
    const st = this.state;
    if (st.phase === 'over') return fail('Game over');
    if (st.phase === 'build') {
      this._snap = serializeSim(this);
      for (const t of st.towers) { t.undoPaid = 0; t.undoable = false; }
      st.phase = 'wave';
    } else if (!this.canStartWave()) {
      return fail('The current wave is still arriving');
    }
    const w = st.wave + 1;
    this._launch(w);
    return { ok: true, wave: w };
  }

  _launch(w) {
    const st = this.state;
    const lanes = this.lanes;
    const spec = buildWave(w, { lanes });
    const queue = [];
    let seq = 0;
    for (const g of spec.groups || []) {
      const count = Math.max(0, g.count | 0);
      const start = g.start || 0, spacing = g.spacing || 0;
      for (let i = 0; i < count; i++) {
        let lane;
        if (g.lane === -1) lane = i % lanes;
        else lane = ((g.lane | 0) % lanes + lanes) % lanes;
        queue.push({ time: start + i * spacing, type: g.type, lane, mods: g.mods || null, titan: null, seq: seq++ });
      }
    }
    let titan = spec.titan || null;
    if (!titan && w % TITAN_EVERY === 0) {
      const tier = w / TITAN_EVERY;
      titan = { kind: TITAN_ORDER[(tier - 1) % TITAN_ORDER.length], tier, hp: titanHp(tier), start: Math.min(10, (spec.duration || 20) * 0.4) };
    }
    if (titan) {
      const tier = titan.tier || Math.max(1, Math.round(w / TITAN_EVERY));
      const lane = titan.lane !== undefined ? ((titan.lane % lanes) + lanes) % lanes : (tier - 1) % lanes;
      queue.push({ time: titan.start || 0, type: 'titan', lane, mods: null, titan: { ...titan, tier }, seq: seq++ });
    }
    queue.sort((a, b) => a.time - b.time || a.seq - b.seq);
    this._runs.set(w, { spec, queue, idx: 0 });
    st.activeWaves.push({ wave: w, t: 0, spawnsLeft: queue.length, spawnDone: queue.length === 0, duration: spec.duration || 0, titan: !!titan });
    if (!this._waveAlive.has(w)) this._waveAlive.set(w, 0);
    st.wave = w;
    this.emit({ t: 'waveStart', wave: w, titan: titan ? titan.kind : null, name: spec.name || null, tip: spec.tip || null, theme: spec.theme || null });
  }

  setAutoStart(on) {
    this.state.autoStart = !!on;
    if (on) this._autoTimer = Math.min(this._autoTimer, AUTO_START_DELAY);
    return { ok: true };
  }

  wavePreview(w) {
    return previewWave(w ?? this.state.wave + 1, { lanes: this.lanes });
  }

  // Title, tip, theme and Titan kind of wave w (defaults to the next wave), for the HUD.
  waveInfo(w) {
    const n = w ?? this.state.wave + 1;
    const spec = buildWave(n, { lanes: this.lanes });
    return { wave: n, name: spec.name || null, tip: spec.tip || null, theme: spec.theme || null, titan: spec.titan ? spec.titan.kind : null };
  }

  // ---------------------------------------------------------------- placement
  _spotReason(def, x, y, ignoreTowerId = -1) {
    const r = def.radius || 22;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return 'Invalid position';
    if (x - r < BOUNDS_MARGIN || x + r > WORLD_W - BOUNDS_MARGIN || y - r < BOUNDS_MARGIN || y + r > WORLD_H - BOUNDS_MARGIN) return 'Out of bounds';
    const clear = this.map.pathWidth / 2 + r;
    for (const p of this.paths) if (p.within(x, y, clear)) return 'On the channel';
    for (const b of this.map.blockers || []) {
      const dx = b.x - x, dy = b.y - y, rr = b.r + r;
      if (dx * dx + dy * dy < rr * rr) return 'Blocked by terrain';
    }
    const core = this.map.core;
    if (core) {
      const dx = core.x - x, dy = core.y - y, rr = CORE_KEEPOUT + r;
      if (dx * dx + dy * dy < rr * rr) return 'Too close to the Core';
    }
    for (const t of this.state.towers) {
      if (t.id === ignoreTowerId) continue;
      const dx = t.x - x, dy = t.y - y, rr = t.radius + r;
      if (dx * dx + dy * dy < rr * rr) return 'Too close to another tower';
    }
    return null;
  }

  canPlace(type, x, y) {
    const st = this.state;
    const def = getDef(type);
    if (!def) return { ok: false, reason: 'Unknown tower', price: 0, affordable: false, spotOk: false };
    const price = placePrice(this, def, x, y);
    const res = { ok: false, reason: null, price, affordable: st.cash >= price, spotOk: false };
    if (st.phase === 'over') { res.reason = 'Game over'; return res; }
    if (def.hero) {
      if (this._heroTower) { res.reason = 'Only one Commander per game'; return res; }
      if (st.heroId && st.heroId !== type) { res.reason = 'A different Commander was chosen'; return res; }
    }
    if (type === 'rig' && st.rigCount >= RIG_CAP) { res.reason = 'Mining Rig limit reached (' + RIG_CAP + ')'; return res; }
    const spot = this._spotReason(def, x, y);
    if (spot) { res.reason = spot; return res; }
    res.spotOk = true;
    if (!res.affordable) { res.reason = 'Not enough credits'; return res; }
    res.ok = true;
    return res;
  }

  placeTower(type, x, y) {
    const chk = this.canPlace(type, x, y);
    if (!chk.ok) return fail(chk.reason);
    const st = this.state;
    const def = getDef(type);
    st.cash -= chk.price;
    const t = createTower(this, def, x, y);
    t.paid = chk.price;
    t.undoPaid = st.phase === 'build' ? chk.price : 0;
    t.undoable = t.undoPaid > 0;
    st.towers.push(t);
    this._towerById.set(t.id, t);
    if (type === 'rig') st.rigCount++;
    if (def.hero) this._heroTower = t;
    recomputeBuffs(this);
    this.emit({ t: 'place', tower: t.id, type, x, y, value: chk.price });
    return { ok: true, id: t.id, price: chk.price };
  }

  // Place the Commander chosen for this match (state.heroId).
  placeHero(x, y) {
    if (!this.state.heroId) return fail('No Commander was chosen for this match');
    return this.placeTower(this.state.heroId, x, y);
  }

  // Debug: jump to the build phase before wave w (field must be empty).
  skipTo(w) {
    const st = this.state;
    if (st.phase !== 'build') return false;
    const n = Math.max(0, (w | 0) - 1);
    st.wave = n; st.cleared = n;
    this._clearedSet.clear();
    return true;
  }

  getTower(id) { return this._towerById.get(id) || null; }
  getEnemy(id) { return this._enemyById.get(id) || null; }

  // ---------------------------------------------------------------- upgrades
  upgradeInfo(towerId, path) {
    const t = this._towerById.get(towerId);
    if (!t) return { tier: 0, name: '', desc: '', cost: 0, state: 'locked', reason: 'No such tower', path };
    const paths = t.def.paths || [];
    const p = paths[path];
    if (!p) return { tier: 0, name: '', desc: '', cost: 0, state: 'locked', reason: 'No upgrades on this path', path };
    const cur = t.levels[path];
    if (cur >= 5) {
      const u = p.upgrades[4];
      return { tier: 5, name: u.name, desc: u.desc, cost: 0, state: 'maxed', reason: 'Fully upgraded', path, pathName: p.name };
    }
    const up = p.upgrades[cur];
    const tier = cur + 1;
    const cost = upgradePrice(this, t, up.cost);
    let reason = crosspathReason(t.levels, path);
    if (!reason && tier === 5) {
      const owner = this.state.t5Owned[t.type + ':' + path];
      if (owner !== undefined && owner !== t.id && this._towerById.has(owner)) reason = 'Only one ' + up.name + ' can exist at a time';
    }
    if (!reason && this.state.phase === 'over') reason = 'Game over';
    let state;
    if (reason) state = 'locked';
    else if (this.state.cash >= cost) state = 'available';
    else { state = 'unaffordable'; reason = 'Not enough credits'; }
    return { tier, name: up.name, desc: up.desc, cost, state, reason, path, pathName: p.name, icon: up.icon || null };
  }

  upgrade(towerId, path) {
    const t = this._towerById.get(towerId);
    if (!t) return fail('No such tower');
    const info = this.upgradeInfo(towerId, path);
    if (info.state !== 'available') return fail(info.reason || 'Cannot upgrade');
    const st = this.state;
    st.cash -= info.cost;
    t.paid += info.cost;
    if (st.phase === 'build') t.undoPaid += info.cost;
    t.undoable = t.undoPaid > 0 && t.undoPaid >= t.paid;
    t.levels[path]++;
    if (t.levels[path] === 5) st.t5Owned[t.type + ':' + path] = t.id;
    refreshTower(this, t);
    recomputeBuffs(this);
    this.emit({ t: 'upgrade', tower: t.id, type: t.type, path, tier: t.levels[path], value: info.cost, name: info.name, x: t.x, y: t.y });
    return { ok: true, tier: t.levels[path], cost: info.cost };
  }

  sellValue(towerId) {
    const t = this._towerById.get(towerId);
    return t ? sellValueImpl(this, t) : 0;
  }

  sell(towerId) {
    const st = this.state;
    if (st.phase === 'over') return fail('Game over');
    const t = this._towerById.get(towerId);
    if (!t) return fail('No such tower');
    const value = sellValueImpl(this, t);
    st.cash += value;
    t.data.vault = 0;
    const i = st.towers.indexOf(t);
    if (i >= 0) st.towers.splice(i, 1);
    this._towerById.delete(t.id);
    for (const k of Object.keys(st.t5Owned)) if (st.t5Owned[k] === t.id) delete st.t5Owned[k];
    if (t.type === 'rig') st.rigCount--;
    if (this._heroTower === t) this._heroTower = null;
    removeTowerDrones(this, t);
    recomputeBuffs(this);
    this.emit({ t: 'sell', tower: t.id, type: t.type, value, x: t.x, y: t.y });
    return { ok: true, value };
  }

  setTargeting(towerId, mode) {
    const t = this._towerById.get(towerId);
    if (!t) return fail('No such tower');
    if (t.stats.targetModes.indexOf(mode) < 0) return fail('This tower cannot use that targeting mode');
    t.targeting = mode;
    return { ok: true, mode };
  }

  setAim(towerId, x, y) {
    const t = this._towerById.get(towerId);
    if (!t) return fail('No such tower');
    if (!Number.isFinite(x) || !Number.isFinite(y)) return fail('Invalid position');
    t.aim = { x: Math.max(0, Math.min(WORLD_W, x)), y: Math.max(0, Math.min(WORLD_H, y)) };
    return { ok: true };
  }

  withdraw(towerId) {
    const t = this._towerById.get(towerId);
    if (!t) return fail('No such tower');
    return withdrawVault(this, t);
  }

  useAbility(abilityId) {
    this._ensureGrid();
    return useAbilityImpl(this, abilityId);
  }

  abilityBar() { return abilityBarImpl(this); }

  priceOf(type) {
    const def = getDef(type);
    return def ? basePrice(this, def) : 0;
  }

  priceAt(type, x, y) {
    const def = getDef(type);
    return def ? placePrice(this, def, x, y) : 0;
  }

  discountAt(type, x, y) {
    const def = getDef(type);
    return def ? discountAt(this, type, x, y, def) : 0;
  }

  towerInfo(towerId) {
    const t = this._towerById.get(towerId);
    if (!t) return null;
    const s = t.stats;
    const h = t.hero;
    return {
      id: t.id, type: t.type, name: t.def.name, levels: t.levels.slice(),
      pops: t.pops, damage: t.damage, cashEarned: t.cashEarned,
      sellValue: sellValueImpl(this, t), undoable: t.undoPaid > 0, paid: t.paid,
      targeting: t.targeting, modes: s.targetModes.slice(),
      range: s.range, detection: s.detection,
      buffed: s.buffed, discount: t.discount, disabled: t.disabledT > 0,
      vault: t.data.vault || 0, vaultCap: s.income && s.income.vault ? s.income.vault.cap : 0,
      income: s.income || null,
      aim: t.aim || t.data.defaultAim || null,
      aimable: s._attackList.some((a) => a.kind === 'mortar'),
      abilities: s.abilities.map((ab) => ({ id: ab.id, name: ab.name, cd: t.abilityCd[ab.id] || 0, cooldown: ab.cooldown })),
      hero: h ? { level: h.level, xp: h.xp, xpNeed: h.level >= HERO_MAX_LEVEL ? 0 : heroXpNeed(h.level) } : null,
      paths: (t.def.paths || []).map((p, i) => ({ name: p.name, tier: t.levels[i] })),
    };
  }

  serialize() {
    if (this.state.phase === 'build') return serializeSim(this);
    return this._snap;
  }

  // ---------------------------------------------------------------- engine helpers (custom attacks, abilities)
  enemiesInRange(x, y, r, { phantom = true } = {}) {
    this._ensureGrid();
    const out = [];
    const q = r === Infinity ? this.state.enemies : this.grid.query(x, y, r, []);
    for (const e of q) {
      if (e.dead) continue;
      if (!phantom && e.phantom && e.exposedT <= 0) continue;
      out.push(e);
    }
    return out;
  }

  findTarget(tower, range, mode, atk) {
    this._ensureGrid();
    return findTargetImpl(this, tower, range ?? tower.stats.range, mode ?? tower.targeting, atk ?? null, tower.x, tower.y, null);
  }

  damage(enemy, amount, dtype, src = {}, opts = {}) {
    const pops0 = this.state.stats.pops;
    const s = src._norm ? src : normSrc(src, dtype);
    const dealt = damageEnemy(this, enemy, amount, dtype, s, opts.projId ?? -1, opts.onHit || null);
    return { dealt, pops: this.state.stats.pops - pops0, blocked: this._lastBlocked };
  }

  applyEffects(enemy, onHit, src = {}) {
    applyFx(this, enemy, onHit, src._norm ? src : normSrc(src, src.dtype));
  }

  // p: { x, y, angle | vx+vy, tower, speed, damage, pierce, dtype, lifetime, ... any projectile attack field }
  spawnProjectile(p) {
    const tower = p.tower ? (typeof p.tower === 'object' ? p.tower : this._towerById.get(p.tower)) : null;
    const a = normAttack({ ...p, kind: 'projectile', tower: undefined }, { range: p.range ?? 300 }, p.attackKey || 'custom', tower, p.dtype || 'KINETIC');
    const ang = p.angle ?? Math.atan2(p.vy || 0, p.vx || 1);
    const proj = launchProjectile(this, tower, a, p.x, p.y, ang, p.targetId ?? -1);
    return proj;
  }

  // Area damage at a point. splash: { radius, damage, pierce, dtype, onHit, shipDamage }
  explode(x, y, splash, src = {}) {
    this._ensureGrid();
    const s = { ...splash };
    if (s.pierce === undefined) s.pierce = 40;
    if (s.damage === undefined) s.damage = 1;
    if (!s.dtype) s.dtype = src.dtype || 'BLAST';
    const ns = normSrc({ ...src, shipDamage: s.shipDamage ?? src.shipDamage, bonus: s.bonus ?? src.bonus }, s.dtype);
    explodeImpl(this, x, y, s, ns);
  }

  spawnEnemy(type, opts = {}) {
    if (type === 'titan') {
      const e = createTitan(this, opts.titan || { kind: 'maw', tier: 1, hp: titanHp(1) }, { lane: opts.lane || 0, d: opts.d || 0, wave: opts.wave ?? this.state.wave, speedMult: opts.speedMult || 1 });
      this._titans.push(e);
      return e;
    }
    const mods = opts.mods || {};
    return createEnemy(this, type, {
      lane: opts.lane || 0, d: opts.d || 0, wave: opts.wave ?? this.state.wave,
      hullMult: opts.hullMult || 1, speedMult: opts.speedMult || 1,
      phantom: !!(mods.phantom || opts.phantom), nanite: !!(mods.nanite || opts.nanite), plated: !!(mods.plated || opts.plated),
      origType: opts.origType, off: opts.off || 0,
    });
  }

  pathPoint(lane, d) {
    const p = (this.paths[lane] || this.paths[0]).pointAt(d);
    return { x: p.x, y: p.y, angle: p.angle };
  }

  pathLength(lane = 0) { return (this.paths[lane] || this.paths[0]).length; }

  nearestPathPoint(x, y) {
    let best = null;
    for (let i = 0; i < this.paths.length; i++) {
      const n = this.paths[i].nearest(x, y);
      if (!best || n.dist < best.dist) best = { lane: i, d: n.d, x: n.x, y: n.y, dist: n.dist };
    }
    return best;
  }

  // Path length within r of (x, y), summed over lanes.
  pathCoverage(x, y, r) {
    let c = 0;
    for (const p of this.paths) c += p.coverage(x, y, r);
    return c;
  }

  addCash(amount, x, y, reason = 'bonus') {
    if (!(amount > 0)) return;
    this.state.cash += amount;
    this.state.stats.cashEarned += amount;
    this.emit({ t: 'cash', amount, x, y, reason });
  }

  after(seconds, fn) {
    this._scheduled.push({ at: this.state.time + Math.max(0, seconds), fn });
  }

  // Fire one of a tower's normalized attacks (tower.stats.attacks[key]) at a target, optionally
  // from another origin (drones, custom attacks). Returns true if it fired.
  fireAttack(tower, atk, target, ox = tower.x, oy = tower.y) {
    this._ensureGrid();
    return fireAt(this, tower, atk, target, ox, oy);
  }

  addTempBuff(tower, buff, duration) { addTempBuff(this, tower, buff, duration); }
  towersNear(x, y, r, types = null) { return towersNear(this, x, y, r, types); }
  stunTower(tower, t) { if (t > tower.disabledT) tower.disabledT = t; }

  // Deterministic hash of the whole simulation state (tests).
  hash() {
    const h = new Hasher();
    const st = this.state;
    h.num(st.tick).str(st.phase).num(st.wave).num(st.cleared).num(st.cash).num(st.lives).num(st.rigCount);
    for (const v of this._rng.getState()) h.num(v);
    const s = st.stats;
    h.num(s.pops).num(s.leaks).num(s.massLeaked).num(s.cashEarned).num(s.damage);
    for (const t of st.towers) {
      h.num(t.id).str(t.type).num(t.x).num(t.y).num(t.levels[0]).num(t.levels[1]).num(t.levels[2]);
      h.num(t.pops).num(t.damage).num(t.paid).num(t.cashEarned).str(t.targeting).num(t.angle);
      for (const k of Object.keys(t.abilityCd).sort()) h.str(k).num(t.abilityCd[k]);
      if (t.hero) h.num(t.hero.level).num(t.hero.xp);
      h.num(t.data.vault || 0);
    }
    for (const e of st.enemies) {
      h.str(e.type).num(e.lane).num(e.d).num(e.hp).num(e.x).num(e.y).bool(e.phantom).bool(e.nanite).num(e.slowMult).num(e.frozenT);
    }
    for (const p of st.projectiles) h.num(p.x).num(p.y).num(p.pierce).num(p.life);
    for (const d of st.drones) h.num(d.x).num(d.y);
    return h.hex();
  }
}

function normSrc(src, dtype) {
  return {
    _norm: true,
    tower: src.tower && typeof src.tower === 'object' ? src.tower : null,
    attackKey: src.attackKey || 'custom',
    dtype: dtype || src.dtype || 'KINETIC',
    bypass: src.bypass && src.bypass.length ? src.bypass : null,
    shipDamage: src.shipDamage || 0,
    bonus: src.bonus || null,
    crit: src.crit || null,
  };
}
