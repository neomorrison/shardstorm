// Save / load (build phase only). The field is empty in the build phase, so a save is the
// towers plus economy, wave counters, RNG state, cooldowns and Commander progress. Pure.
import { getDef, createTower, refreshTower, recomputeBuffs } from './towers.js';
import { snapDrones } from './attacks.js';
import { MAPS } from '../data/maps.js';
import { HEROES } from '../data/heroes.js';
import { DIFFICULTIES, HERO_MAX_LEVEL } from '../data/economy.js';

export const SAVE_VERSION = 1;

const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const int = (v) => fin(v) && Math.floor(v) === v;

// Structural check of a save (docs/ARCHITECTURE.md 8). Returns null when the save can be
// restored, else a short reason. Sim.fromSave and restoreSim throw an Error with that reason,
// so a corrupted, edited or future-format save never starts a broken run.
export function validateSave(save) {
  if (!save || typeof save !== 'object' || Array.isArray(save)) return 'not a save';
  if (save.v !== SAVE_VERSION) return 'unsupported save version ' + String(save.v);
  if (typeof save.mapId !== 'string' || !own(MAPS, save.mapId)) return 'unknown map';
  if (typeof save.difficulty !== 'string' || !own(DIFFICULTIES, save.difficulty)) return 'unknown difficulty';
  if (save.heroId !== null && save.heroId !== undefined && (typeof save.heroId !== 'string' || !own(HEROES, save.heroId))) return 'unknown Commander';
  if (!fin(save.seed)) return 'bad seed';
  if (!int(save.tick) || save.tick < 0) return 'bad tick';
  if (!int(save.wave) || save.wave < 0) return 'bad wave';
  if (!int(save.cleared) || save.cleared < 0 || save.cleared > save.wave) return 'bad cleared';
  if (!fin(save.cash) || save.cash < 0) return 'bad credits';
  if (!fin(save.lives) || save.lives <= 0) return 'bad lives';
  if (!fin(save.maxLives) || save.maxLives <= 0) return 'bad max lives';
  if (save.rng !== undefined && !(Array.isArray(save.rng) && save.rng.length === 4 && save.rng.every(int))) return 'bad rng state';
  if (save.nextId !== undefined && !int(save.nextId)) return 'bad id counter';
  if (save.stats !== undefined) {
    if (!save.stats || typeof save.stats !== 'object') return 'bad stats';
    for (const k of Object.keys(save.stats)) if (!fin(save.stats[k])) return 'bad stat ' + k;
  }
  if (!Array.isArray(save.towers)) return 'bad tower list';
  const ids = new Set();
  let heroes = 0;
  for (const t of save.towers) {
    if (!t || typeof t !== 'object') return 'bad tower';
    const def = typeof t.type === 'string' ? getDef(t.type) : null;
    if (!def) return 'unknown tower ' + String(t.type);
    if (!int(t.id) || ids.has(t.id)) return 'bad tower id';
    ids.add(t.id);
    if (!fin(t.x) || !fin(t.y)) return 'bad tower position';
    if (!fin(t.paid) || t.paid < 0) return 'bad tower price';
    if (t.undoPaid !== undefined && (!fin(t.undoPaid) || t.undoPaid < 0)) return 'bad tower undo';
    if (t.vault !== undefined && (!fin(t.vault) || t.vault < 0)) return 'bad vault';
    const L = t.levels;
    if (!Array.isArray(L) || L.length !== 3 || !L.every((v) => int(v) && v >= 0 && v <= 5)) return 'bad tower levels';
    const paths = (def.paths || []).length;
    let above2 = 0, nonzero = 0;
    for (let p = 0; p < 3; p++) {
      if (L[p] > 0 && p >= paths) return 'bad tower levels';
      if (L[p] > 2) above2++;
      if (L[p] > 0) nonzero++;
    }
    if (nonzero > 2 || above2 > 1) return 'bad tower levels';
    for (const k of ['pops', 'damage', 'cashEarned', 'angle']) if (t[k] !== undefined && !fin(t[k])) return 'bad tower ' + k;
    if (def.hero) {
      heroes++;
      if (save.heroId && t.type !== save.heroId) return 'Commander does not match';
      const h = t.hero;
      if (h && (!int(h.level) || h.level < 1 || h.level > HERO_MAX_LEVEL || !fin(h.xp) || h.xp < 0)) return 'bad Commander level';
    }
  }
  if (heroes > 1) return 'more than one Commander';
  return null;
}

export function serializeSim(sim) {
  const st = sim.state;
  return {
    v: SAVE_VERSION,
    mapId: st.mapId,
    difficulty: st.difficulty,
    heroId: st.heroId,
    seed: sim.seed,
    rng: sim._rng.getState(),
    tick: st.tick,
    wave: st.wave,
    cleared: st.cleared,
    cash: st.cash,
    lives: st.lives,
    maxLives: st.maxLives,
    autoStart: st.autoStart,
    autoTimer: sim._autoTimer,
    nextId: sim._nextId,
    nextProjId: sim._nextProjId,
    stats: { ...st.stats },
    towers: st.towers.map((t) => ({
      id: t.id,
      type: t.type,
      x: t.x, y: t.y, angle: t.angle,
      levels: t.levels.slice(),
      targeting: t.targeting,
      aim: t.aim ? { x: t.aim.x, y: t.aim.y } : null,
      paid: t.paid,
      undoPaid: t.undoPaid,
      pops: t.pops, damage: t.damage, cashEarned: t.cashEarned,
      abilityCd: { ...t.abilityCd },
      abilityLast: { ...t.abilityLast },
      vault: t.data.vault || 0,
      hero: t.hero ? { level: t.hero.level, xp: t.hero.xp } : null,
    })),
  };
}

// Restore a save into a freshly constructed Sim (same map, difficulty, seed, hero).
// Throws Error('Invalid save: <reason>') when validateSave rejects it.
export function restoreSim(sim, save) {
  const bad = validateSave(save);
  if (bad) throw new Error('Invalid save: ' + bad);
  const st = sim.state;
  st.tick = save.tick;
  st.time = st.tick * sim.TICK;
  st.wave = save.wave;
  st.cleared = save.cleared;
  st.cash = save.cash;
  st.lives = save.lives;
  st.maxLives = save.maxLives;
  st.autoStart = !!save.autoStart;
  // auto-start stays disarmed after a restore until a wave is cleared in this session
  // (save.autoTimer is still written for older clients but not read)
  sim._autoTimer = 1;
  sim._autoArmed = false;
  if (save.stats) Object.assign(st.stats, save.stats);
  if (Array.isArray(save.rng) && save.rng.length === 4) sim._rng.setState(save.rng);
  st.towers.length = 0;
  sim._towerById.clear();
  st.t5Owned = {};
  st.rigCount = 0;
  sim._heroTower = null;
  for (const s of save.towers || []) {
    const def = getDef(s.type);
    const t = createTower(sim, def, s.x, s.y);
    t.id = s.id;
    t.angle = s.angle ?? t.angle;
    t.levels = [s.levels[0] | 0, s.levels[1] | 0, s.levels[2] | 0];
    if (t.hero && s.hero) { t.hero.level = s.hero.level; t.hero.xp = s.hero.xp; }
    t.paid = s.paid; t.undoPaid = Math.min(s.undoPaid || 0, s.paid);
    t.undoable = t.undoPaid > 0 && t.undoPaid >= t.paid;
    t.pops = s.pops || 0; t.damage = s.damage || 0; t.cashEarned = s.cashEarned || 0;
    t.aim = s.aim ? { x: s.aim.x, y: s.aim.y } : null;
    if (s.vault) t.data.vault = s.vault;
    refreshTower(sim, t);
    t.abilityCd = { ...t.abilityCd, ...(s.abilityCd || {}) };
    t.abilityLast = { ...t.abilityLast, ...(s.abilityLast || {}) };
    if (t.stats.targetModes.indexOf(s.targeting) >= 0) t.targeting = s.targeting;
    st.towers.push(t);
    sim._towerById.set(t.id, t);
    if (t.type === 'rig') st.rigCount++;
    if (t.hero) sim._heroTower = t;
    for (let p = 0; p < 3; p++) if (t.levels[p] >= 5) st.t5Owned[t.type + ':' + p] = t.id;
  }
  sim._nextId = Math.max(save.nextId || 1, sim._nextId);
  sim._nextProjId = save.nextProjId || sim._nextProjId;
  recomputeBuffs(sim);
  snapDrones(sim);
  st.phase = 'build';
  return sim;
}
