// Towers: definitions lookup, stat computation (tier-major), buffs/auras, upgrade rules,
// targeting and the per-tick tower update. Pure.
import { TOWERS, NO_DISCOUNT } from '../data/towers/index.js';
import { HEROES } from '../data/heroes.js';
import { canDamage, isTargetable, remainingMass } from './enemies.js';
import { updateTowerAttacks } from './attacks.js';

export const DEFAULT_MODES = ['first', 'last', 'strong', 'close'];

export function getDef(type) {
  return (Object.prototype.hasOwnProperty.call(TOWERS, type) && TOWERS[type])
    || (Object.prototype.hasOwnProperty.call(HEROES, type) && HEROES[type]) || null;
}
export function isHeroDef(def) { return !!(def && def.hero); }

// Deep clone of plain data; functions, Sets and class instances are copied by reference.
export function cloneStats(v) {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) {
    const out = new Array(v.length);
    for (let i = 0; i < v.length; i++) out[i] = cloneStats(v[i]);
    return out;
  }
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return v;
  const out = {};
  for (const k in v) {
    if (k.charCodeAt(0) === 95 /* _ */) continue; // derived/private fields are rebuilt
    out[k] = cloneStats(v[k]);
  }
  return out;
}

export const NO_BUFFS = Object.freeze({
  rateMult: 1, rangeMult: 1, pierceAdd: 0, damageAdd: 0, detection: false, bypass: Object.freeze([]),
  discount: 0, shipDamageAdd: 0,
});
function newBuffs() {
  return { rateMult: 1, rangeMult: 1, pierceAdd: 0, damageAdd: 0, detection: false, bypass: [], discount: 0, shipDamageAdd: 0 };
}
function buffKey(b) {
  return b.rateMult + '|' + b.rangeMult + '|' + b.pierceAdd + '|' + b.damageAdd + '|' + (b.detection ? 1 : 0)
    + '|' + b.bypass.join(',') + '|' + b.discount + '|' + b.shipDamageAdd;
}

// Step 1+2 of docs 5.1: base clone plus upgrades in tier-major order (and Commander levels).
export function computeBaseStats(def, levels, heroLevel = 1) {
  const s = cloneStats(def.base || {});
  if (!s.attacks) s.attacks = {};
  if (!s.abilities) s.abilities = [];
  if (s.range === undefined) s.range = 150;
  const paths = def.paths || [];
  for (let tier = 1; tier <= 5; tier++) {
    for (let p = 0; p < paths.length; p++) {
      if ((levels[p] || 0) >= tier) {
        const up = paths[p].upgrades[tier - 1];
        if (up && up.apply) up.apply(s, { levels, tier, path: p, def });
      }
    }
  }
  if (def.hero && def.hero.levels) {
    const max = Math.min(heroLevel, def.hero.maxLevel || 20);
    for (let L = 2; L <= max; L++) {
      const fn = def.hero.levels[L - 2];
      if (fn) fn(s, { level: L, def });
    }
  }
  return s;
}

function mkSrc(tower, key, dtype, bypass, shipDamage, bonus, crit) {
  return { tower: tower || null, attackKey: key, dtype, bypass: bypass && bypass.length ? bypass : null, shipDamage: shipDamage || 0, bonus: bonus || null, crit: crit || null };
}

function buffAttack(a, b) {
  if (!a) return;
  if (b.rangeMult !== 1) {
    if (a.range !== undefined && a.range !== Infinity) a.range *= b.rangeMult;
    if (a.radius !== undefined) a.radius *= b.rangeMult;
    if (a.patrol !== undefined) a.patrol *= b.rangeMult;
  }
  if (b.rateMult !== 1) {
    if (a.cooldown) a.cooldown /= b.rateMult;
    if (a.dps) a.dps *= b.rateMult;
  }
  // Pierce buffs: projectiles, hitscan and pulses hit more targets; a mortar shell's blast hits
  // more meteors (splash pierce). Beams, chains, fields and drones have no pierce of their own
  // (a drone's weapon is buffed through `a.weapon` below), so the buff does not change them.
  if (b.pierceAdd && (a.kind === undefined || a.kind === 'projectile' || a.kind === 'hitscan' || a.kind === 'pulse')) {
    a.pierce = (a.pierce ?? (a.kind === 'pulse' ? 40 : 1)) + b.pierceAdd;
  } else if (b.pierceAdd && a.kind === 'mortar' && a.splash) {
    a.splash.pierce = (a.splash.pierce ?? 20) + b.pierceAdd;
  }
  if (b.damageAdd) {
    if ((a.damage ?? 1) > 0) a.damage = (a.damage ?? 1) + b.damageAdd;
    if (a.splash) a.splash.damage = (a.splash.damage ?? 1) + b.damageAdd;
    if (a.dps) a.dps *= 1 + 0.2 * b.damageAdd;
  }
  if (b.shipDamageAdd) {
    a.shipDamage = (a.shipDamage || 0) + b.shipDamageAdd;
    if (a.splash) a.splash.shipDamage = (a.splash.shipDamage || 0) + b.shipDamageAdd;
  }
  if (b.bypass.length) {
    const cur = a.bypass || [];
    for (const x of b.bypass) if (cur.indexOf(x) < 0) cur.push(x);
    a.bypass = cur;
    if (a.splash) { const sb = a.splash.bypass || []; for (const x of b.bypass) if (sb.indexOf(x) < 0) sb.push(x); a.splash.bypass = sb; }
  }
  if (a.split && a.split.attack) buffAttack(a.split.attack, { ...b, rangeMult: 1, rateMult: 1 });
  if (a.shrapnel) buffAttack(a.shrapnel, { ...b, rangeMult: 1, rateMult: 1 });
  if (a.weapon) buffAttack(a.weapon, { ...b, rangeMult: 1 });
}

// Fill defaults and precompute damage sources. `parentDtype` for nested attacks.
export function normAttack(a, s, key, tower, parentDtype) {
  a.kind = a.kind || 'projectile';
  if (a.cooldown === undefined) a.cooldown = 1;
  if (!a.dtype) a.dtype = parentDtype || 'KINETIC';
  if (a.damage === undefined) a.damage = 1;
  if (a.pierce === undefined) a.pierce = a.kind === 'pulse' ? 40 : 1; // pulse: max enemies hit per pulse
  if (!a.bypass) a.bypass = [];
  if (!a.shipDamage) a.shipDamage = 0;
  if (a.needsTarget === undefined) a.needsTarget = true;
  if (a.range === undefined) a.range = s.range;
  switch (a.kind) {
    case 'projectile':
      if (a.speed === undefined) a.speed = 900;
      if (a.projRadius === undefined) a.projRadius = 6;
      if (a.count === undefined) a.count = 1;
      if (a.lifetime === undefined) a.lifetime = a.range === Infinity ? 2 : (a.range / a.speed) * 1.35 + 0.05;
      break;
    case 'hitscan':
      if (a.count === undefined) a.count = 1;
      break;
    case 'chain':
      if (a.jumps === undefined) a.jumps = 3;
      if (a.jumpRange === undefined) a.jumpRange = 110;
      if (a.falloff === undefined) a.falloff = 1;
      if (a.count === undefined) a.count = 1;
      break;
    case 'beam':
      if (a.beams === undefined) a.beams = 1;
      if (a.dps === undefined) a.dps = 5;
      if (a.tickRate === undefined) a.tickRate = 0.1;
      if (a.ramp === undefined) a.ramp = 0;
      if (a.rampMax === undefined) a.rampMax = 1;
      if (a.width === undefined) a.width = 6;
      break;
    case 'pulse':
      if (a.radius === undefined) a.radius = a.range;
      break;
    case 'field':
      if (a.radius === undefined) a.radius = a.range;
      if (a.tickRate === undefined) a.tickRate = 0.25;
      a._fieldFx = null;
      if (a.slow || a.expose) {
        a._fieldFx = {};
        if (a.slow) a._fieldFx.slow = { mult: a.slow.mult, shipMult: a.slow.shipMult, t: 0.15 };
        if (a.expose) a._fieldFx.expose = { t: 0.15, mult: typeof a.expose === 'object' ? (a.expose.mult || 1) : 1 };
      }
      break;
    case 'mortar':
      if (a.flightTime === undefined) a.flightTime = 0.8;
      if (a.inaccuracy === undefined) a.inaccuracy = 20;
      if (a.count === undefined) a.count = 1;
      if (!a.splash) a.splash = { radius: 50, damage: a.damage, pierce: 20 };
      if (a.onHit && !a.splash.onHit) a.splash.onHit = a.onHit;
      break;
    case 'drone':
      if (a.count === undefined) a.count = 1;
      if (a.droneSpeed === undefined) a.droneSpeed = 260;
      if (a.patrol === undefined) a.patrol = a.range;
      if (!a.weapon) a.weapon = { kind: 'projectile', cooldown: 0.5, damage: 1, pierce: 1, speed: 900 };
      if (a.weapon.range === undefined) a.weapon.range = 110;
      normAttack(a.weapon, s, key, tower, a.dtype);
      break;
    default: break;
  }
  if (a.splash) {
    const sp = a.splash;
    if (!sp.dtype) sp.dtype = a.dtype;
    if (sp.damage === undefined) sp.damage = 1;
    if (sp.pierce === undefined) sp.pierce = 20;
    if (sp.radius === undefined) sp.radius = 40;
    if (!sp.bypass) sp.bypass = a.bypass;
    sp._src = mkSrc(tower, key, sp.dtype, sp.bypass, sp.shipDamage, sp.bonus, null);
  }
  if (a.split) {
    const sp = a.split;
    if (sp.count === undefined) sp.count = 4;
    if (!sp.attack) sp.attack = { kind: 'projectile', damage: 1, pierce: 1, speed: 500, lifetime: 0.25 };
    sp.attack.kind = 'projectile';
    normAttack(sp.attack, s, key, tower, a.dtype);
  }
  if (a.shrapnel) {
    const sh = a.shrapnel;
    sh.kind = 'projectile';
    if (sh.speed === undefined) sh.speed = 900;
    if (sh.range === undefined) sh.range = 130;
    if (sh.lifetime === undefined) sh.lifetime = sh.range / sh.speed;
    if (sh.count === undefined) sh.count = 3;
    if (sh.spread === undefined) sh.spread = 0.6;
    normAttack(sh, s, key, tower, a.dtype);
  }
  a._src = mkSrc(tower, key, a.dtype, a.bypass, a.shipDamage, a.bonus, a.crit);
  return a;
}

// Step 3 of docs 5.1: clone base, apply buffs, normalize.
export function finalizeStats(base, buffs, tower = null) {
  const s = cloneStats(base);
  const b = buffs || NO_BUFFS;
  s.baseRange = s.range;
  if (s.range !== Infinity) s.range *= b.rangeMult;
  s.detection = !!(s.detection || b.detection);
  if (!s.targetModes || !s.targetModes.length) s.targetModes = DEFAULT_MODES.slice();
  if (!s.abilities) s.abilities = [];
  if (!s.attacks) s.attacks = {};
  const list = [];
  for (const key of Object.keys(s.attacks)) {
    const a = s.attacks[key];
    if (!a) { delete s.attacks[key]; continue; }
    buffAttack(a, b);
    normAttack(a, s, key, tower, null);
    a.key = key;
    list.push(a);
  }
  s._attackList = list;
  s.buffed = b !== NO_BUFFS;
  return s;
}

// Contract helper: computeStats(def, levels, buffs, heroLevel)
export function computeStats(def, levels, buffs = null, heroLevel = 1, tower = null) {
  return finalizeStats(computeBaseStats(def, levels, heroLevel), buffs, tower);
}

// Crosspath rule: returns a reason string if buying the next tier on `path` is illegal.
export function crosspathReason(levels, path) {
  let above2 = 0, nonzero = 0;
  for (let i = 0; i < 3; i++) {
    const v = (levels[i] || 0) + (i === path ? 1 : 0);
    if (v > 2) above2++;
    if (v > 0) nonzero++;
  }
  if (nonzero > 2) return 'Only two paths can be upgraded';
  if (above2 > 1) return 'Only one path can go past tier 2';
  return null;
}

export function createTower(sim, def, x, y) {
  const st = sim.state;
  const t = {
    id: sim._nextId++,
    type: def.id, def, name: def.name,
    x, y, angle: -Math.PI / 2, radius: def.radius || 22,
    levels: [0, 0, 0],
    targeting: 'first',
    aim: null,
    stats: null, baseStats: null, buffs: NO_BUFFS, buffKey: '', discount: 0,
    paid: 0, undoPaid: 0, undoable: false,
    pops: 0, damage: 0, cashEarned: 0,
    cd: {}, abilityCd: {}, abilityLast: {},
    target: null,
    disabledT: 0,
    data: {},
    hero: def.hero ? { level: 1, xp: 0 } : null,
    tempBuffs: [],
    placedWave: st.wave,
  };
  const np = sim.nearestPathPoint(x, y);
  t.data.defaultAim = { x: np.x, y: np.y };
  refreshTower(sim, t);
  t.targeting = t.stats.targetModes[0] || 'first';
  return t;
}

// Recompute base stats (levels changed) and finalize with current buffs.
export function refreshTower(sim, t) {
  t.baseStats = computeBaseStats(t.def, t.levels, t.hero ? t.hero.level : 1);
  t.stats = finalizeStats(t.baseStats, t.buffs, t);
  syncAbilities(sim, t);
  if (t.stats.targetModes.indexOf(t.targeting) < 0) t.targeting = t.stats.targetModes[0] || 'first';
  sim._buffsDirty = true;
}

export function syncAbilities(sim, t) {
  for (const ab of t.stats.abilities) {
    if (!(ab.id in t.abilityCd)) {
      t.abilityCd[ab.id] = (ab.cooldown || 30) / 3;
      t.abilityLast[ab.id] = sim.state.time;
    }
  }
}

function mergeAura(b, au) {
  if (au.rateMult && au.rateMult > b.rateMult) b.rateMult = au.rateMult;
  if (au.rangeMult && au.rangeMult > b.rangeMult) b.rangeMult = au.rangeMult;
  if (au.pierceAdd && au.pierceAdd > b.pierceAdd) b.pierceAdd = au.pierceAdd;
  if (au.damageAdd && au.damageAdd > b.damageAdd) b.damageAdd = au.damageAdd;
  if (au.detection) b.detection = true;
  if (au.bypass) for (const x of au.bypass) if (b.bypass.indexOf(x) < 0) b.bypass.push(x);
  if (au.discount && au.discount > b.discount) b.discount = au.discount;
  if (au.shipDamageAdd && au.shipDamageAdd > b.shipDamageAdd) b.shipDamageAdd = au.shipDamageAdd;
}

export function auraAppliesTo(au, tower) {
  if (au.types && au.types.indexOf(tower.type) < 0) return false;
  if (au.excludeTypes && au.excludeTypes.indexOf(tower.type) >= 0) return false;
  return true;
}

// Recompute buffs for every tower; only towers whose buff set changed get new stats.
export function recomputeBuffs(sim) {
  const towers = sim.state.towers;
  const auras = [], refineries = [];
  for (const t of towers) {
    if (t.baseStats.aura) auras.push(t);
    const inc = t.baseStats.income;
    if (inc && inc.refinery) refineries.push(t);
  }
  sim._auraTowers = auras;
  sim._refineries = refineries;
  for (const t of towers) {
    let b = null;
    for (const a of auras) {
      if (a === t) continue;
      const au = a.baseStats.aura;
      const dx = a.x - t.x, dy = a.y - t.y, r = au.radius || 0;
      if (dx * dx + dy * dy > r * r) continue;
      if (!auraAppliesTo(au, t)) continue;
      if (!b) b = newBuffs();
      mergeAura(b, au);
    }
    for (const tb of t.tempBuffs) {
      if (!b) b = newBuffs();
      if (tb.rateMult) b.rateMult *= tb.rateMult;
      if (tb.rangeMult) b.rangeMult *= tb.rangeMult;
      if (tb.pierceAdd) b.pierceAdd += tb.pierceAdd;
      if (tb.damageAdd) b.damageAdd += tb.damageAdd;
      if (tb.shipDamageAdd) b.shipDamageAdd += tb.shipDamageAdd;
      if (tb.detection) b.detection = true;
    }
    if (b && (NO_DISCOUNT.indexOf(t.type) >= 0 || t.hero)) b.discount = 0;
    const key = b ? buffKey(b) : '';
    if (key !== t.buffKey) {
      t.buffs = b || NO_BUFFS;
      t.buffKey = key;
      t.discount = b ? b.discount : 0;
      t.stats = finalizeStats(t.baseStats, t.buffs, t);
      syncAbilities(sim, t);
    }
  }
  sim._buffsDirty = false;
}

// Is an enemy inside the visible world (towers cannot target off-screen enemies)?
function onScreen(e) {
  return e.x > -e.radius * 0.5 && e.x < 1500 + e.radius * 0.5 && e.y > -e.radius * 0.5 && e.y < 1000 + e.radius * 0.5;
}

// Target selection. Respects detection, immunity-aware skipping and an optional exclusion:
// an array of enemy ids, or a number stamp (skip enemies whose e._xs equals it; O(1) per check,
// used by long chains).
export function findTarget(sim, tower, range, mode, atk, ox, oy, exclude) {
  if (ox === undefined) { ox = tower.x; oy = tower.y; }
  const detect = tower.stats.detection || !!(atk && atk.detection);
  const dtype = atk ? atk.dtype : null;
  const bypass = atk ? atk.bypass : null;
  const cands = range === Infinity ? sim.state.enemies : sim.grid.query(ox, oy, range, sim._qFind);
  let best = null, bestScore = -Infinity;
  const paths = sim.paths;
  for (let i = 0, n = cands.length; i < n; i++) {
    const e = cands[i];
    if (e.dead) continue;
    if (e.phantom && !detect && e.exposedT <= 0) continue;
    if (dtype !== null && !canDamage(e, dtype, bypass)) continue;
    if (exclude != null && (typeof exclude === 'number' ? e._xs === exclude : exclude.indexOf(e.id) >= 0)) continue;
    if (!onScreen(e)) continue;
    let score;
    switch (mode) {
      case 'last': score = (paths[e.lane] || paths[0]).length - e.d; break;
      case 'strong': score = (e.ship ? 1e12 : 0) + (e.titan !== null ? 1e13 : 0) + remainingMass(e) * 1000 + e.d * 1e-3; break;
      case 'close': { const dx = e.x - ox, dy = e.y - oy; score = -(dx * dx + dy * dy); break; }
      default: score = e.d - (paths[e.lane] || paths[0]).length; break;
    }
    if (score > bestScore) { bestScore = score; best = e; }
  }
  return best;
}

export { isTargetable };

export function updateTowers(sim, dt) {
  const towers = sim.state.towers;
  for (let i = 0; i < towers.length; i++) {
    const t = towers[i];
    if (t.tempBuffs.length) {
      for (let k = t.tempBuffs.length - 1; k >= 0; k--) {
        const tb = t.tempBuffs[k];
        tb.t -= dt;
        if (tb.t <= 0) { t.tempBuffs.splice(k, 1); sim._buffsDirty = true; }
      }
    }
    if (t.disabledT > 0) {
      t.disabledT -= dt;
      if (t.data.beams) t.data.beams.length = 0;
      continue;
    }
    updateTowerAttacks(sim, t, dt);
  }
}
