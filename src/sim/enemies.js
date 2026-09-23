// Enemies: spawning, movement, statuses, damage and popping into children, nanite regrow,
// leaks and Storm Titans. Pure. All functions take the Sim as the first argument.
import { ENEMIES, familyMass, SCOUT_HULL } from '../data/enemies.js';
import { BASE_SPEED, incomeFactor } from '../data/economy.js';

export const REGROW_DELAY = 3;          // seconds without damage before a nanite regrows
export const BURN_TICK = 0.5;           // seconds between burn ticks
export const SHIP_FREEZE_SLOW = 0.6;    // freeze on a ship becomes this slow
export const AEGIS_SHIELD_FRAC = 0.25;
export const AEGIS_REGEN_DELAY = 8;
// KINETIC hits on the Aegis shield deal this fraction of their damage (other types deal full
// damage), so an all-KINETIC defense is slowed down by the shield rather than walled.
export const AEGIS_KINETIC_MULT = 0.2;
export const RIFT_THRESHOLDS = [0.75, 0.5, 0.25];
export const RIFT_BLINK = 250;
export const RIFT_STUN_RADIUS = 150;
export const RIFT_STUN_TIME = 1.5;
export const MAW_SPIT_EVERY = 3.2;
// Bounty is paid once per shell the storm actually sent (docs/ECONOMY.md 1.1). Two things can
// create shells on the field: nanite regrowth and the Maw's spit. Both are tracked with
// `e.owed`, the number of shells of an enemy's family that still pay bounty (-1: untracked,
// the whole family pays as usual). Regrown shells and their children pay nothing, and the Maw
// pays for the volleys of one unslowed crossing of its channel, so a stalled or looped enemy
// can never farm credits (out/exploits/regrow_farm.mjs, out/exploits/maw_farm.mjs).
// Ships (Storm Titans included) cannot be stunned again for this long after a stun ends, and a
// stun never extends one already running on a ship. Stacked stuns therefore hold a ship still
// for at most stun / (stun + SHIP_STUN_IMMUNE) of the time, so massed stunners cannot stall a
// wave forever (docs/BALANCE.md, termination).
export const SHIP_STUN_IMMUNE = 1.0;
export const MAW_SPIT_TYPES = ['rose', 'iron', 'geode', 'aurora', 'obsidian'];
// The Maw appears every third Titan (tiers 1, 4, 7, ...), and the grade it spits rises one step
// per appearance: Rose, Iron, Geode, Aurora, then Obsidian from its fifth appearance on.
export function mawSpitType(tier) {
  const n = Math.floor(Math.max(0, (tier | 0) - 1) / TITAN_ORDER.length);
  return MAW_SPIT_TYPES[Math.min(MAW_SPIT_TYPES.length - 1, n)];
}

export const TITAN_KINDS = {
  maw:   { name: 'The Maw',   title: 'Storm Titan', trait: 'Spits meteors behind itself.', color: '#ff5d73' },
  aegis: { name: 'The Aegis', title: 'Storm Titan', trait: 'A regenerating shield that KINETIC damage barely scratches.', color: '#5dd6ff' },
  rift:  { name: 'The Rift',  title: 'Storm Titan', trait: 'Blinks forward at 75%, 50% and 25% hull and stuns nearby towers.', color: '#b36bff' },
};
export const TITAN_ORDER = ['maw', 'aegis', 'rift'];

// Remaining child mass cache per (type, hullMult).
const childMassCache = new Map();
export function childMassOf(type, hullMult) {
  const def = ENEMIES[type];
  if (!def || !def.children.length) return 0;
  if (hullMult === 1 && def._childMass1 !== undefined) return def._childMass1;
  const key = type + '|' + hullMult;
  let m = childMassCache.get(key);
  if (m === undefined) {
    m = 0;
    for (const [c, n] of def.children) m += n * familyMass(c, hullMult, false);
    if (childMassCache.size > 5000) childMassCache.clear();
    childMassCache.set(key, m);
    if (hullMult === 1) def._childMass1 = m;
  }
  return m;
}

function titanDef(kind, hp) {
  const k = TITAN_KINDS[kind] || TITAN_KINDS.maw;
  return {
    id: 'titan', name: k.name, kind: 'ship', titan: true, titanKind: kind, speed: 0.2, hp,
    immune: [], children: [], radius: 80, color: k.color,
    mass: hp, hullMass: hp, meteorMass: 0, shells: 1,
  };
}

// Create an enemy and add it to the field. opts: { lane, d, wave, hullMult, speedMult,
// phantom, nanite, plated, origType, off, def (override) }
export function createEnemy(sim, type, o = {}) {
  const def = o.def || ENEMIES[type];
  if (!def) throw new Error('unknown enemy type ' + type);
  const ship = def.kind === 'ship';
  const hullMult = o.hullMult ?? 1;
  const plated = !!o.plated;
  const scout = ship && !def.titan && !!o.scout;
  const hp = def.hp * (ship && !def.titan ? hullMult : 1) * (plated ? 2 : 1) * (scout ? SCOUT_HULL : 1);
  const lane = o.lane ?? 0;
  let origType = o.origType || type;
  if (!ENEMIES[origType] || ENEMIES[origType].kind === 'ship') origType = type;
  const e = {
    id: sim._nextId++,
    type, def, lane,
    d: Math.max(0, o.d ?? 0),
    x: 0, y: 0, angle: 0,
    off: ship ? 0 : (o.off ?? 0),
    radius: def.radius,
    hp, maxHp: hp,
    wave: o.wave ?? sim.state.wave,
    hullMult,
    speedMult: o.speedMult ?? 1,
    phantom: !!(o.phantom || def.phantom),
    nanite: !ship && !!o.nanite,
    plated,
    origType,
    regrowT: 0,
    slowMult: 1, slowT: 0, slowDtype: null, frozenT: 0, stunT: 0, stunImmT: 0,
    burn: null, brittle: null, exposedT: 0, exposeMult: 1,
    immuneProj: -1,
    titan: null,
    ship, scout,
    childMass: def.titan || scout ? 0 : childMassOf(type, hullMult),
    owed: o.owed ?? -1,
    bornT: sim.state.time,
    dead: false,
  };
  placeOnPath(sim, e);
  e.angle = sim._pt.angle;
  sim.state.enemies.push(e);
  sim._enemyById.set(e.id, e);
  // mid-tick spawns (children, Maw spit) are visible to area queries in the same tick
  if (!sim._gridStale) sim.grid.insert(e);
  sim._waveAliveInc(e.wave);
  return e;
}

export function createTitan(sim, spec, { lane = 0, wave, speedMult = 1, d = 0 } = {}) {
  const kind = spec.kind || 'maw';
  const tier = spec.tier || 1;
  const hp = spec.hp;
  const e = createEnemy(sim, 'titan', { def: titanDef(kind, hp), lane, d, wave, speedMult, hullMult: 1 });
  const shield = kind === 'aegis' ? hp * AEGIS_SHIELD_FRAC : 0;
  // the Maw's paid volleys: as many as it spits crossing its channel once at full speed
  const path = sim.paths[e.lane] || sim.paths[0];
  const cross = Math.max(0, path.length - e.d) / Math.max(1e-6, e.def.speed * BASE_SPEED * e.speedMult);
  e.titan = {
    kind, tier, name: TITAN_KINDS[kind].name,
    shield, maxShield: shield, lastHitT: sim.state.time,
    blinks: 0, spitT: MAW_SPIT_EVERY, paidVolleys: Math.ceil(cross / MAW_SPIT_EVERY),
    spitType: kind === 'maw' ? mawSpitType(tier) : null,
  };
  sim.emit({ t: 'titan', name: e.titan.name, kind, wave: e.wave, tier, id: e.id });
  return e;
}

// Re-file an enemy that moved mid-tick (knockback, blink, pull) in the spatial hash.
export function refile(sim, e) {
  if (!sim._gridStale && !e.dead) sim.grid.insert(e);
}

// Recompute x, y, angle from lane + d (+ lateral offset).
export function placeOnPath(sim, e) {
  const path = sim.paths[e.lane] || sim.paths[0];
  const p = path.pointAt(e.d, sim._pt);
  if (e.off) {
    e.x = p.x - Math.sin(p.angle) * e.off;
    e.y = p.y + Math.cos(p.angle) * e.off;
  } else { e.x = p.x; e.y = p.y; }
  return p;
}

export function enemySpeed(e) {
  if (e.stunT > 0 || e.frozenT > 0) return 0;
  return e.def.speed * BASE_SPEED * e.speedMult * e.slowMult;
}

export function remainingMass(e) {
  return e.hp + e.childMass + (e.titan ? e.titan.shield : 0);
}

function setType(sim, e, type) {
  const def = ENEMIES[type];
  e.type = type;
  e.def = def;
  e.radius = def.radius;
  e.hp = def.hp;
  e.maxHp = def.hp;
  e.childMass = childMassOf(type, e.hullMult);
}

// Direct parent of `type` inside the family tree of `root` (depth-first, children in their
// listed order), or null when `type` is not a descendant of `root`. A Rose inside a Geode family
// has two possible parents (Magma and Comet); the first one listed (Magma) is used.
const parentCache = new Map();
export function familyParent(root, type) {
  const key = root + '>' + type;
  let r = parentCache.get(key);
  if (r !== undefined) return r;
  r = null;
  const walk = (id) => {
    const def = ENEMIES[id];
    if (!def) return false;
    for (const [c] of def.children) {
      if (c === type) { r = id; return true; }
      if (walk(c)) return true;
    }
    return false;
  };
  if (root !== type) walk(root);
  parentCache.set(key, r);
  return r;
}

// Nanite regrowth (docs/DESIGN.md 4): a shell regrows exactly one grade, into its direct parent
// in the family tree of its original type (Rust to Cobalt, Rose to Magma in an Obsidian family,
// Geode to Aurora, Aurora to Obsidian), never above origType. An intact origType shell with lost
// HP heals to full instead.
export function regrow(sim, e) {
  e.regrowT = 0;
  if (e.type === e.origType) {
    if (e.hp < e.maxHp) { e.hp = e.maxHp; sim.emit({ t: 'regrow', x: e.x, y: e.y, type: e.type, id: e.id }); }
    return;
  }
  const next = familyParent(e.origType, e.type);
  if (!next || !ENEMIES[next] || ENEMIES[next].kind === 'ship') return;
  // the family grows but its bounty does not: it still pays only for the shells it had
  if (e.owed < 0) e.owed = e.def.shells;
  setType(sim, e, next);
  sim.emit({ t: 'regrow', x: e.x, y: e.y, type: next, id: e.id });
}

export function canDamage(e, dtype, bypass) {
  const imm = e.def.immune;
  if (imm.length !== 0 && imm.indexOf(dtype) >= 0) {
    if (!bypass || (bypass.indexOf(dtype) < 0 && bypass.indexOf(e.type) < 0)) return false;
  }
  if (e.frozenT > 0 && dtype === 'KINETIC' && !(bypass && bypass.indexOf('FROZEN') >= 0)) return false;
  return true;
}

// Can this attack target/damage the enemy? (targeting filter)
export function isTargetable(e, detection) {
  return !e.phantom || detection || e.exposedT > 0;
}

function blocked(sim, e, dtype) {
  sim._lastBlocked = true;
  if (sim.state.tick !== e._blkTick) { // at most one blocked spark per enemy per tick
    e._blkTick = sim.state.tick;
    sim.emit({ t: 'blocked', x: e.x, y: e.y, dtype });
  }
}

// Full damage entry point. Returns damage dealt (0 if blocked). Sets sim._lastBlocked.
// src: { tower, attackKey, dtype, bypass, shipDamage, bonus, crit }
export function damageEnemy(sim, e, amount, dtype, src, projId, onHit) {
  sim._lastBlocked = false;
  if (e.dead) return 0;
  if (!canDamage(e, dtype, src.bypass)) { blocked(sim, e, dtype); return 0; }
  let dmg = amount;
  const bonus = src.bonus;
  if (bonus) { const b = bonus[e.type]; if (b) dmg += b; }
  if (e.ship && src.shipDamage) dmg += src.shipDamage;
  if (e.brittle !== null) dmg = (dmg + e.brittle.add) * e.brittle.mult;
  if (e.exposedT > 0 && e.exposeMult !== 1) dmg *= e.exposeMult;
  const crit = src.crit;
  if (crit && crit.chance > 0 && sim.rng() < crit.chance) {
    dmg *= crit.mult;
    sim.emit({ t: 'crit', x: e.x, y: e.y, amount: dmg });
  }
  if (!(dmg > 0)) {
    if (onHit) applyEffects(sim, e, onHit, src);
    return 0;
  }
  return applyRaw(sim, e, dmg, dtype, src, projId ?? -1, onHit);
}

// Apply already-computed damage (used directly for overflow into children).
function applyRaw(sim, e, dmg, dtype, src, projId, onHit) {
  e.regrowT = 0;
  let dealt = 0;
  const tower = src.tower;
  const T = e.titan;
  if (T !== null) {
    T.lastHitT = sim.state.time;
    if (T.shield > 0) {
      // KINETIC damage is cut to AEGIS_KINETIC_MULT against the shield (attacks that bypass
      // 'SHIELD' hit it at full strength); whatever breaks through goes on to the hull
      const km = dtype === 'KINETIC' && !(src.bypass && src.bypass.indexOf('SHIELD') >= 0) ? AEGIS_KINETIC_MULT : 1;
      // Work in shield units so a fully absorbed hit leaves exactly nothing for the hull (no
      // float residue). On-hit effects only land on the hull: a hit the shield absorbs in full
      // applies no stun, slow, burn or brittle (docs/ARCHITECTURE.md 6, damage and popping rules).
      const want = dmg * km;
      if (want < T.shield - 1e-9) {
        T.shield -= want; dealt += want;
        credit(sim, tower, dealt);
        return dealt;
      }
      const s = T.shield;
      T.shield = 0; dealt += s;
      sim.emit({ t: 'shieldBreak', x: e.x, y: e.y, id: e.id });
      dmg -= s / km;
      if (dmg <= 1e-9) { credit(sim, tower, dealt); return dealt; }
    }
  }
  // a hit within 1e-9 of the remaining HP breaks the shell (fractional beam, burn and field
  // ticks would otherwise leave a live 1e-16 HP sliver that needs one more hit)
  if (dmg < e.hp - 1e-9) {
    e.hp -= dmg;
    dealt += dmg;
    credit(sim, tower, dealt);
    if (onHit) applyEffects(sim, e, onHit, src);
    return dealt;
  }
  const over = dmg > e.hp ? dmg - e.hp : 0;
  dealt += e.hp;
  credit(sim, tower, dealt);
  dealt += popEnemy(sim, e, src, projId, over, dtype, onHit);
  return dealt;
}

function credit(sim, tower, dealt) {
  sim.state.stats.damage += dealt;
  if (tower) tower.damage += dealt;
}

// Break the current shell: bounty, stats, children, overflow. Returns overflow damage dealt.
function popEnemy(sim, e, src, projId, over, dtype, onHit) {
  e.hp = 0;
  sim._removeEnemy(e);
  const st = sim.state;
  const tower = src.tower;
  // a shell created on the field (regrowth, an unpaid Maw volley) pays no bounty, no Refinery
  // bonus and no Commander XP
  if (e.owed !== 0) {
    const c = incomeFactor(e.wave);
    st.cash += c;
    st.stats.cashEarned += c;
    sim._onPop(e, c, tower);
  }
  st.stats.pops += 1;
  sim._popsThisTick++;
  if (tower) tower.pops += 1;
  sim.emit({ t: 'pop', x: e.x, y: e.y, type: e.type, color: e.def.color, ship: e.ship, count: 1, id: e.id, titan: e.titan !== null });
  if (e.titan !== null) {
    sim.emit({ t: 'titanDown', name: e.titan.name, kind: e.titan.kind, x: e.x, y: e.y, wave: e.wave });
  }
  const def = e.def;
  if (!def.children.length) return 0;
  const kids = spawnChildren(sim, e, projId);
  let dealt = 0;
  if (!e.ship && over > 0) {
    for (let i = 0; i < kids.length; i++) {
      const k = kids[i];
      if (k.dead) continue;
      if (!canDamage(k, dtype, src.bypass)) { blocked(sim, k, dtype); continue; }
      dealt += applyRaw(sim, k, over, dtype, src, projId, onHit);
    }
  } else if (onHit && !e.ship) {
    for (let i = 0; i < kids.length; i++) if (!kids[i].dead) applyEffects(sim, kids[i], onHit, src);
  }
  return dealt;
}

export function spawnChildren(sim, e, projId = -1) {
  const def = e.def;
  if (e.scout) return []; // a scout's hold is empty
  const cm = def.childMods || null;
  let total = 0;
  for (const [, n] of def.children) total += n;
  const spacing = e.ship ? 18 : 7;
  const kids = [];
  let idx = 0;
  // tracked families hand what they still owe down to their children (this shell took one)
  let owed = e.owed < 0 ? -1 : Math.max(0, e.owed - 1);
  for (const [c, n] of def.children) {
    const cdef = ENEMIES[c];
    for (let k = 0; k < n; k++) {
      const offD = (idx - (total - 1) / 2) * spacing + (sim.rng() - 0.5) * 4;
      const nanite = e.nanite || !!(cm && cm.nanite);
      const origType = e.nanite ? e.origType : c;
      const kid = createEnemy(sim, c, {
        lane: e.lane,
        d: e.d + offD,
        wave: e.wave,
        hullMult: e.hullMult,
        speedMult: e.speedMult,
        phantom: e.phantom || !!(cm && cm.phantom),
        nanite,
        plated: !!(cm && cm.plated),
        origType,
        off: cdef.kind === 'ship' ? 0 : clampOff(sim, e.off + (sim.rng() - 0.5) * 10),
      });
      if (projId >= 0) kid.immuneProj = projId;
      if (owed >= 0) { kid.owed = Math.min(owed, cdef.shells); owed -= kid.owed; }
      // displacement budgets (Undertow `gRew`, tractor `_towed`) belong to the family: children
      // start with what their parent already used, so a nanite family that pops and regrows
      // cannot refresh its budget every generation and be held forever
      // (out/exploits/undertow_stall.mjs)
      if (e.gRew) kid.gRew = e.gRew;
      if (e._towed) kid._towed = e._towed;
      // inherit statuses (not freeze or stun). A slow passes down only between enemies of the
      // same kind (a ship's slow is ship-strength, so meteor cargo does not keep it), and a CRYO
      // slow never passes to a CRYO-immune child (Geode, Comet).
      if (e.slowT > 0 && kid.ship === e.ship
        && !(e.slowDtype === 'CRYO' && cdef.immune.indexOf('CRYO') >= 0)) {
        kid.slowMult = e.slowMult; kid.slowT = e.slowT; kid.slowDtype = e.slowDtype;
      }
      if (e.exposedT > 0) { kid.exposedT = e.exposedT; kid.exposeMult = e.exposeMult; }
      if (e.burn !== null && !kid.ship && kid.def.immune.indexOf('THERMAL') < 0) {
        kid.burn = e.burn.map((b) => ({ dps: b.dps, t: b.t, acc: b.acc, src: b.src, towerId: b.towerId }));
      }
      kids.push(kid);
      idx++;
    }
  }
  return kids;
}

function clampOff(sim, off) {
  const lim = sim.map.pathWidth * 0.28;
  return off < -lim ? -lim : off > lim ? lim : off;
}

// Storm Titans resist slows: a slow is half as strong on a Titan (a 0.4 slow becomes 0.7),
// like stuns, which last half as long. An effect can set slow.titanMult / freeze.titanMult to
// give Titans an exact value instead.
export const TITAN_SLOW_RESIST = 0.5;
function titanSlow(m) { return 1 - (1 - m) * (1 - TITAN_SLOW_RESIST); }

// e.slowDtype remembers the damage type of the slow in force, so children know whether a CRYO
// slow may pass to them (spawnChildren).
function setSlow(e, mult, t, dtype) {
  if (e.slowT <= 0 || mult < e.slowMult) { e.slowMult = mult; e.slowT = t; e.slowDtype = dtype; }
  else if (mult === e.slowMult && t > e.slowT) { e.slowT = t; if (dtype !== 'CRYO') e.slowDtype = dtype; }
}

// On-hit effects (docs/ARCHITECTURE.md 5.5).
export function applyEffects(sim, e, fx, src) {
  if (e.dead) return;
  const ship = e.ship;
  const dtype = src.dtype;
  // CRYO-immune meteors (Comet, Geode) are never slowed or frozen by CRYO, including when a
  // CRYO hit on their parent passes its on-hit effects down to them.
  const cryoImmune = dtype === 'CRYO' && e.def.immune.indexOf('CRYO') >= 0;
  const slow = fx.slow;
  if (slow) {
    if (!(dtype === 'CRYO' && e.type === 'comet') && !cryoImmune) {
      let m = ship ? slow.shipMult : slow.mult;
      if (e.titan !== null && m !== undefined) m = slow.titanMult ?? titanSlow(m);
      if (m !== undefined && m < 1) setSlow(e, m, slow.t ?? 1, dtype);
    }
  }
  const fr = fx.freeze;
  if (fr && e.type !== 'comet' && !cryoImmune) {
    if (ship) {
      const m = fr.shipMult ?? SHIP_FREEZE_SLOW;
      setSlow(e, e.titan !== null ? (fr.titanMult ?? titanSlow(m)) : m, fr.t, dtype);
    }
    else if (fr.t > e.frozenT) { e.frozenT = fr.t; if (!e._frozeEmit) { e._frozeEmit = true; } }
  }
  const burn = fx.burn;
  if (burn && e.def.immune.indexOf('THERMAL') < 0) addBurn(e, burn, src);
  const stun = fx.stun;
  if (stun) {
    if (ship) {
      const t = (stun.shipT || 0) * (e.titan !== null ? 0.5 : 1);
      if (t > 0 && e.stunT <= 0 && e.stunImmT <= 0) e.stunT = t;
    } else {
      const t = stun.t || 0;
      if (t > e.stunT) e.stunT = t;
    }
  }
  const br = fx.brittle;
  if (br) addBrittle(e, br.add || 0, br.mult || 1, br.t || 1);
  const kb = fx.knockback;
  if (kb) {
    const k = ship ? (e.titan !== null ? 0 : (kb.shipDist || 0)) : (kb.dist || 0);
    if (k > 0) { e.d = Math.max(0, e.d - k); placeOnPath(sim, e); refile(sim, e); }
  }
  const ex = fx.expose;
  if (ex) {
    if ((ex.t || 1) > e.exposedT) e.exposedT = ex.t || 1;
    if (ex.mult && ex.mult > e.exposeMult) e.exposeMult = ex.mult;
  }
  if (fx.strip) e.phantom = false;
}

// Brittleness: every distinct brittle (add, mult) keeps its own timer in e._brit, and the one
// in force (e.brittle) takes the best add and the best mult among the active entries, the way
// auras merge. Hit order therefore never matters, and a weak long brittle never stretches a
// strong short one (docs/ARCHITECTURE.md 5.5).
function addBrittle(e, add, mult, t) {
  let list = e._brit;
  if (!list) list = e._brit = [];
  let found = false;
  for (let i = 0; i < list.length; i++) {
    const b = list[i];
    if (b.add === add && b.mult === mult) { if (t > b.t) b.t = t; found = true; break; }
  }
  if (!found) list.push({ add, mult, t });
  syncBrittle(e);
}

function syncBrittle(e) {
  const list = e._brit;
  if (!list || list.length === 0) { e.brittle = null; e._brit = null; return; }
  let add = 0, mult = 1, t = 0;
  for (let i = 0; i < list.length; i++) {
    const b = list[i];
    if (b.add > add) add = b.add;
    if (b.mult > mult) mult = b.mult;
    if (b.t > t) t = b.t;
  }
  const cur = e.brittle;
  if (cur === null) e.brittle = { add, mult, t };
  else { cur.add = add; cur.mult = mult; cur.t = t; }
}

function addBurn(e, burn, src) {
  const towerId = src.tower ? src.tower.id : -1;
  let bsrc = src._burnSrc;
  if (!bsrc) {
    bsrc = { tower: src.tower || null, attackKey: src.attackKey, dtype: 'THERMAL', bypass: src.bypass || null, shipDamage: 0, bonus: null, crit: null };
    src._burnSrc = bsrc;
  }
  if (e.burn === null) e.burn = [];
  for (const b of e.burn) {
    if (b.towerId === towerId) {
      if (burn.dps > b.dps) b.dps = burn.dps;
      if (burn.t > b.t) b.t = burn.t;
      return;
    }
  }
  e.burn.push({ dps: burn.dps, t: burn.t, acc: 0, src: bsrc, towerId });
}

// Per-tick enemy update: statuses, burn, regrow, titans, movement, leaks.
export function updateEnemies(sim, dt) {
  const list = sim.state.enemies;
  const n0 = list.length;
  for (let i = 0; i < n0; i++) {
    const e = list[i];
    if (e.dead) continue;
    if (e.stunT > 0) { e.stunT -= dt; if (e.stunT <= 0 && e.ship) e.stunImmT = SHIP_STUN_IMMUNE; }
    else if (e.stunImmT > 0) e.stunImmT -= dt;
    if (e.frozenT > 0) { e.frozenT -= dt; if (e.frozenT <= 0) { e.frozenT = 0; e._frozeEmit = false; } }
    if (e.slowT > 0) { e.slowT -= dt; if (e.slowT <= 0) { e.slowT = 0; e.slowMult = 1; e.slowDtype = null; } }
    if (e.exposedT > 0) { e.exposedT -= dt; if (e.exposedT <= 0) { e.exposedT = 0; e.exposeMult = 1; } }
    if (e.brittle !== null) {
      const list = e._brit;
      if (!list) { e.brittle.t -= dt; if (e.brittle.t <= 0) e.brittle = null; }
      else {
        let gone = false;
        for (let k = list.length - 1; k >= 0; k--) { list[k].t -= dt; if (list[k].t <= 0) { list.splice(k, 1); gone = true; } }
        if (gone) syncBrittle(e); else e.brittle.t -= dt;
      }
    }
    if (e.burn !== null) {
      const burns = e.burn;
      for (let k = burns.length - 1; k >= 0; k--) {
        const b = burns[k];
        b.t -= dt; b.acc += dt;
        // tolerance: after 30 ticks of 1/60 s the sum is a hair under 0.5, and without it a
        // 1 s burn loses its second tick on the frame it expires
        if (b.acc >= BURN_TICK - 1e-9) {
          b.acc -= BURN_TICK;
          damageEnemy(sim, e, b.dps * BURN_TICK, 'THERMAL', b.src, -1, null);
          if (e.dead) break;
        }
        if (b.t <= 1e-9) burns.splice(k, 1);
      }
      if (e.dead) continue;
      if (burns.length === 0) e.burn = null;
    }
    if (e.nanite) {
      e.regrowT += dt;
      if (e.regrowT >= REGROW_DELAY) regrow(sim, e);
    }
    if (e.titan !== null) {
      updateTitan(sim, e, dt);
      if (e.dead) continue;
    }
    if (e.stunT <= 0 && e.frozenT <= 0) {
      e.d += e.def.speed * BASE_SPEED * e.speedMult * e.slowMult * dt;
    }
    const path = sim.paths[e.lane] || sim.paths[0];
    if (e.d >= path.length) { leakEnemy(sim, e); continue; }
    const p = placeOnPath(sim, e);
    if (e.ship) {
      // ships turn smoothly
      let da = p.angle - e.angle;
      while (da > Math.PI) da -= Math.PI * 2;
      while (da < -Math.PI) da += Math.PI * 2;
      const maxTurn = 2.2 * dt;
      e.angle += da > maxTurn ? maxTurn : da < -maxTurn ? -maxTurn : da;
    } else e.angle = p.angle;
  }
}

export function leakEnemy(sim, e) {
  const st = sim.state;
  const isTitan = e.titan !== null;
  const mass = isTitan ? st.lives : Math.ceil(remainingMass(e) - 1e-9);
  sim._removeEnemy(e);
  st.stats.leaks += 1;
  st.stats.massLeaked += mass;
  if (isTitan) st.lives = 0; else st.lives -= mass;
  sim.emit({ t: 'leak', type: e.type, mass, x: e.x, y: e.y, titan: isTitan, id: e.id });
}

function updateTitan(sim, e, dt) {
  const T = e.titan;
  const st = sim.state;
  if (T.kind === 'maw') {
    T.spitT -= dt;
    if (T.spitT <= 0) {
      T.spitT += MAW_SPIT_EVERY;
      const type = T.spitType;
      const count = Math.min(8, 2 + T.tier);
      // volleys past one full-speed crossing (a slowed or stalled Maw) pay no bounty
      const paid = T.paidVolleys > 0;
      if (paid) T.paidVolleys--;
      for (let k = 0; k < count; k++) {
        createEnemy(sim, type, {
          lane: e.lane, d: Math.max(0, e.d - 60 - k * 12), wave: e.wave, speedMult: e.speedMult,
          hullMult: 1, off: (sim.rng() - 0.5) * sim.map.pathWidth * 0.5, owed: paid ? -1 : 0,
        });
      }
      sim.emit({ t: 'titanSpit', x: e.x, y: e.y, type, count, id: e.id });
    }
  } else if (T.kind === 'aegis') {
    if (T.shield < T.maxShield && st.time - T.lastHitT >= AEGIS_REGEN_DELAY) {
      T.shield = T.maxShield;
      sim.emit({ t: 'shieldUp', x: e.x, y: e.y, id: e.id });
    }
  } else if (T.kind === 'rift') {
    const frac = e.hp / e.maxHp;
    while (T.blinks < RIFT_THRESHOLDS.length && frac <= RIFT_THRESHOLDS[T.blinks]) {
      T.blinks++;
      const path = sim.paths[e.lane] || sim.paths[0];
      const x0 = e.x, y0 = e.y;
      // forward only: near the Core the blink stops 90 units short of it and never moves back
      e.d = Math.max(e.d, Math.min(path.length - 90, e.d + RIFT_BLINK));
      placeOnPath(sim, e);
      refile(sim, e);
      const r2 = RIFT_STUN_RADIUS * RIFT_STUN_RADIUS;
      for (const t of st.towers) {
        const dx = t.x - e.x, dy = t.y - e.y;
        if (dx * dx + dy * dy <= r2 && t.disabledT < RIFT_STUN_TIME) t.disabledT = RIFT_STUN_TIME;
      }
      sim.emit({ t: 'titanBlink', x0, y0, x: e.x, y: e.y, r: RIFT_STUN_RADIUS, id: e.id });
      sim.emit({ t: 'explode', x: e.x, y: e.y, r: RIFT_STUN_RADIUS, dtype: 'VOID' });
    }
  }
}
