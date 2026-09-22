// Save / load (build phase only). The field is empty in the build phase, so a save is the
// towers plus economy, wave counters, RNG state, cooldowns and Commander progress. Pure.
import { getDef, createTower, refreshTower, recomputeBuffs } from './towers.js';
import { snapDrones } from './attacks.js';

export const SAVE_VERSION = 1;

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
export function restoreSim(sim, save) {
  if (!save || typeof save !== 'object') throw new Error('invalid save');
  const st = sim.state;
  st.tick = save.tick || 0;
  st.time = st.tick * sim.TICK;
  st.wave = save.wave || 0;
  st.cleared = save.cleared ?? st.wave;
  st.cash = save.cash;
  st.lives = save.lives;
  st.maxLives = save.maxLives ?? st.maxLives;
  st.autoStart = !!save.autoStart;
  sim._autoTimer = save.autoTimer ?? sim._autoTimer;
  if (save.stats) Object.assign(st.stats, save.stats);
  if (Array.isArray(save.rng) && save.rng.length === 4) sim._rng.setState(save.rng);
  st.towers.length = 0;
  sim._towerById.clear();
  st.t5Owned = {};
  st.rigCount = 0;
  sim._heroTower = null;
  for (const s of save.towers || []) {
    const def = getDef(s.type);
    if (!def) continue; // tower removed from the game: skip it
    const t = createTower(sim, def, s.x, s.y);
    t.id = s.id;
    t.angle = s.angle ?? t.angle;
    t.levels = [s.levels[0] | 0, s.levels[1] | 0, s.levels[2] | 0];
    if (t.hero && s.hero) { t.hero.level = s.hero.level; t.hero.xp = s.hero.xp; }
    t.paid = s.paid; t.undoPaid = s.undoPaid || 0;
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
