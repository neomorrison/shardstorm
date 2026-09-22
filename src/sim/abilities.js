// Activated abilities (docs/ARCHITECTURE.md 5.7): cooldowns, the global ability bar model,
// temporary buffs, and shared helpers ability authors can call. Pure.

// Cooldowns only run during waves (Bloons style).
export function updateAbilities(sim, dt) {
  if (sim.state.phase !== 'wave') return;
  for (const t of sim.state.towers) {
    const cd = t.abilityCd;
    for (const id in cd) if (cd[id] > 0) { cd[id] -= dt; if (cd[id] < 0) cd[id] = 0; }
  }
}

// [{ id, name, icon, desc, ready, usable, towerIds, cdFrac, cd }] grouped by ability id, in tower order.
// ready: an instance is off cooldown. usable: ready and a wave is running (abilities only fire in waves).
export function abilityBar(sim) {
  const groups = [];
  const byId = new Map();
  for (const t of sim.state.towers) {
    for (const ab of t.stats.abilities) {
      let g = byId.get(ab.id);
      if (!g) {
        g = { id: ab.id, name: ab.name, icon: ab.icon || ab.id, desc: ab.desc || '', ready: false, towerIds: [], cdFrac: 1, cd: Infinity, cooldown: ab.cooldown };
        byId.set(ab.id, g);
        groups.push(g);
      }
      g.towerIds.push(t.id);
      const cd = t.abilityCd[ab.id] || 0;
      if (cd <= 0) g.ready = true;
      if (cd < g.cd) { g.cd = cd; g.cdFrac = ab.cooldown > 0 ? cd / ab.cooldown : 0; }
    }
  }
  const inWave = sim.state.phase === 'wave';
  for (const g of groups) { if (g.cd === Infinity) g.cd = 0; if (g.ready) g.cdFrac = 0; g.usable = g.ready && inWave; }
  return groups;
}

// Fire the ready instance with the most time since its last use.
export function useAbility(sim, id) {
  if (sim.state.phase === 'over') return { ok: false, reason: 'Game over' };
  if (sim.state.phase !== 'wave') return { ok: false, reason: 'Abilities can only be used during a wave' };
  let best = null, bestAb = null, bestLast = Infinity;
  for (const t of sim.state.towers) {
    for (const ab of t.stats.abilities) {
      if (ab.id !== id) continue;
      if ((t.abilityCd[ab.id] || 0) > 0) continue;
      const last = t.abilityLast[ab.id] ?? -Infinity;
      if (last < bestLast || best === null) { bestLast = last; best = t; bestAb = ab; }
    }
  }
  if (!best) {
    const any = sim.state.towers.some((t) => t.stats.abilities.some((ab) => ab.id === id));
    return { ok: false, reason: any ? 'Ability is recharging' : 'No tower has this ability' };
  }
  best.abilityCd[id] = bestAb.cooldown || 30;
  best.abilityLast[id] = sim.state.time;
  if (bestAb.activate) bestAb.activate(sim, best, bestAb);
  sim.emit({ t: 'ability', id, name: bestAb.name, tower: best.id, type: best.type, x: best.x, y: best.y });
  return { ok: true, tower: best.id };
}

// Temporary buff on a tower: { rateMult, rangeMult, pierceAdd, damageAdd, shipDamageAdd, detection }.
export function addTempBuff(sim, tower, buff, duration) {
  tower.tempBuffs.push({ ...buff, t: duration });
  sim._buffsDirty = true;
}

// Towers of `types` (array or null for all) within r of (x, y).
export function towersNear(sim, x, y, r, types = null) {
  const out = [];
  const r2 = r * r;
  for (const t of sim.state.towers) {
    if (types && types.indexOf(t.type) < 0) continue;
    const dx = t.x - x, dy = t.y - y;
    if (dx * dx + dy * dy <= r2) out.push(t);
  }
  return out;
}
