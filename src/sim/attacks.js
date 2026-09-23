// Attack kind implementations (docs/ARCHITECTURE.md 5.3): projectile, hitscan, chain, beam,
// pulse, field, mortar, drone, custom. Pure.
import { damageEnemy, applyEffects, canDamage, placeOnPath } from './enemies.js';
import { findTarget } from './towers.js';
import { launchProjectile, allocProjectile, explode, leadPoint } from './projectiles.js';

const TAU = Math.PI * 2;
const leadOut = { x: 0, y: 0 };

export function updateTowerAttacks(sim, t, dt) {
  const list = t.stats._attackList;
  if (t.data.beams && t.data.beams.length) t.data.beams.length = 0;
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    switch (a.kind) {
      case 'beam': updateBeam(sim, t, a, dt); break;
      case 'field': updateField(sim, t, a, dt); break;
      case 'drone': updateDrones(sim, t, a, dt); break;
      case 'custom': if (a.update) a.update(sim, t, a, dt); break;
      default: cooldownFire(sim, t, a, dt, i === 0);
    }
  }
}

function cooldownFire(sim, t, a, dt, primary) {
  const key = a.key;
  let cd = t.cd[key];
  if (cd === undefined) cd = 0;
  cd -= dt;
  if (cd <= 0) {
    let shots = 0;
    const step = a.cooldown > 0.004 ? a.cooldown : 0.004;
    while (cd <= 0) {
      if (!fireOnce(sim, t, a, primary)) { cd = 0; break; }
      cd += step;
      if (++shots >= 12) { if (cd < 0) cd = 0; break; }
    }
  }
  t.cd[key] = cd;
}

function fireOnce(sim, t, a, primary) {
  if (a.kind === 'pulse') return firePulseAt(sim, t, a, t.x, t.y);
  if (a.kind === 'mortar') return fireMortar(sim, t, a);
  const target = findTarget(sim, t, a.range, t.targeting, a, t.x, t.y, null);
  if (!target) { if (primary) t.target = null; return false; }
  if (primary) t.target = target.id;
  return fireAt(sim, t, a, target, t.x, t.y);
}

// Fire attack `a` of tower `t` at `target` from origin (ox, oy). Used by towers and drones.
export function fireAt(sim, t, a, target, ox, oy) {
  switch (a.kind) {
    case 'hitscan': fireHitscan(sim, t, a, target, ox, oy); return true;
    case 'chain': fireChain(sim, t, a, target, ox, oy); return true;
    case 'pulse': return firePulseAt(sim, t, a, ox, oy);
    case 'mortar': return fireMortar(sim, t, a);
    default: fireProjectile(sim, t, a, target, ox, oy); return true;
  }
}

export function fireProjectile(sim, t, a, target, ox, oy) {
  let ang;
  if (target) {
    if (a.homing > 0 || a.noLead) ang = Math.atan2(target.y - oy, target.x - ox);
    else { leadPoint(sim, target, ox, oy, a.speed, leadOut); ang = Math.atan2(leadOut.y - oy, leadOut.x - ox); }
  } else ang = t.angle;
  const fromTower = ox === t.x && oy === t.y;
  if (fromTower) t.angle = ang;
  const count = a.count || 1;
  const muzzle = fromTower ? t.radius * 0.7 : 6;
  const tid = target ? target.id : -1;
  if (a.radial) {
    for (let i = 0; i < count; i++) {
      const g = ang + (TAU * i) / count;
      launchProjectile(sim, t, a, ox + Math.cos(g) * muzzle, oy + Math.sin(g) * muzzle, g, tid);
    }
  } else if (count === 1) {
    launchProjectile(sim, t, a, ox + Math.cos(ang) * muzzle, oy + Math.sin(ang) * muzzle, ang, tid);
  } else {
    const spread = a.spread ?? 0.12 * (count - 1);
    for (let i = 0; i < count; i++) {
      const g = ang - spread / 2 + (spread * i) / (count - 1);
      launchProjectile(sim, t, a, ox + Math.cos(g) * muzzle, oy + Math.sin(g) * muzzle, g, tid);
    }
  }
  sim.emit({ t: 'shot', tower: t.id, type: t.type, x: ox, y: oy, angle: ang, visual: a.visual || 'bolt', dtype: a.dtype, attack: a.key, drone: !fromTower });
}

function hitscanHit(sim, t, a, target, ox, oy, ang) {
  if (a.line) {
    // Penetrating line: hits up to `pierce` enemies along the ray through the target.
    const len = a.lineLength || (a.range === Infinity ? 2200 : a.range + 60);
    const x1 = ox + Math.cos(ang) * len, y1 = oy + Math.sin(ang) * len;
    const mx = (ox + x1) / 2, my = (oy + y1) / 2;
    const q = sim.grid.query(mx, my, len / 2 + 4, sim._qLine);
    const hits = sim._lineHits; hits.length = 0;
    const vx = x1 - ox, vy = y1 - oy, l2 = vx * vx + vy * vy;
    for (let i = 0; i < q.length; i++) {
      const e = q[i];
      const tt = ((e.x - ox) * vx + (e.y - oy) * vy) / l2;
      if (tt < 0 || tt > 1) continue;
      const cx = ox + vx * tt - e.x, cy = oy + vy * tt - e.y;
      if (cx * cx + cy * cy > e.radius * e.radius) continue;
      e._lt = tt;
      hits.push(e);
    }
    if (hits.indexOf(target) < 0) { target._lt = -1; hits.push(target); }
    hits.sort((p, q2) => p._lt - q2._lt);
    let n = 0;
    for (let i = 0; i < hits.length && n < a.pierce; i++) {
      const e = hits[i];
      if (e.dead) continue;
      damageEnemy(sim, e, a.damage, a.dtype, a._src, -1, a.onHit);
      n++;
    }
  } else {
    damageEnemy(sim, target, a.damage, a.dtype, a._src, -1, a.onHit);
    if (!sim._lastBlocked && !target.dead) sim.emit({ t: 'hit', x: target.x, y: target.y, dtype: a.dtype });
  }
}

export function fireHitscan(sim, t, a, target, ox, oy) {
  const count = a.count || 1;
  const fromTower = ox === t.x && oy === t.y;
  let first = true;
  const excl = sim._hsExcl; excl.length = 0;
  let tg = target;
  for (let c = 0; c < count && tg; c++) {
    const tx = tg.x, ty = tg.y, tid = tg.id;
    const ang = Math.atan2(ty - oy, tx - ox);
    if (first && fromTower) t.angle = ang;
    hitscanHit(sim, t, a, tg, ox, oy, ang);
    sim.emit({ t: 'shot', tower: t.id, type: t.type, x: ox, y: oy, x2: tx, y2: ty, angle: ang, visual: a.visual || 'rail', dtype: a.dtype, attack: a.key, drone: !fromTower });
    if (a.splash) explode(sim, tx, ty, a.splash, a.splash._src);
    if (a.shrapnel) {
      const sh = a.shrapnel;
      for (let i = 0; i < sh.count; i++) {
        const g = sh.count === 1 ? ang : ang - sh.spread / 2 + (sh.spread * i) / (sh.count - 1);
        const p = launchProjectile(sim, t, sh, tx, ty, g, -1);
        p.hit.push(tid);
      }
    }
    first = false;
    excl.push(tid);
    if (c + 1 < count) tg = findTarget(sim, t, a.range, t.targeting, a, ox, oy, excl);
  }
}

let chainSeq = 0;
export function fireChain(sim, t, a, target, ox, oy) {
  // Enemies already hit by this shot carry the shot's stamp (O(1) exclusion in findTarget).
  const stamp = ++chainSeq;
  const fromTower = ox === t.x && oy === t.y;
  if (fromTower) t.angle = Math.atan2(target.y - oy, target.x - ox);
  let start = target;
  for (let c = 0; c < a.count && start; c++) {
    const pts = [[ox, oy]];
    let cur = start;
    let dmg = a.damage;
    for (let j = 0; j <= a.jumps && cur; j++) {
      cur._xs = stamp;
      const cx = cur.x, cy = cur.y;
      pts.push([cx, cy]);
      damageEnemy(sim, cur, dmg, a.dtype, a._src, -1, a.onHit);
      if (j === a.jumps) break;
      dmg *= a.falloff;
      cur = findTarget(sim, t, a.jumpRange, 'close', a, cx, cy, stamp);
    }
    sim.emit({ t: 'zap', points: pts, tower: t.id, type: t.type, dtype: a.dtype, color: a.color || null, visual: a.visual || 'arc', width: a.zapWidth || 0 });
    if (c + 1 < a.count) start = findTarget(sim, t, a.range, t.targeting, a, ox, oy, stamp);
  }
}

export function firePulseAt(sim, t, a, ox, oy) {
  const r = a.radius;
  const q = sim.grid.query(ox, oy, r, sim._qArea);
  const n = q.length;
  if (n === 0) return false;
  if (n > a.pierce) {
    for (let i = 0; i < n; i++) { const e = q[i]; const dx = e.x - ox, dy = e.y - oy; e._pd = dx * dx + dy * dy; }
    q.sort((p1, p2) => p1._pd - p2._pd);
  }
  const lim = n < a.pierce ? n : a.pierce;
  for (let i = 0; i < lim; i++) {
    const e = q[i];
    if (e.dead) continue;
    if (a.damage > 0) damageEnemy(sim, e, a.damage, a.dtype, a._src, -1, a.onHit || null);
    else if (a.onHit) applyEffects(sim, e, a.onHit, a._src);
  }
  sim.emit({ t: 'pulse', tower: t.id, type: t.type, x: ox, y: oy, r, dtype: a.dtype, color: a.color || null, visual: a.visual || null });
  if (a.onHit && a.onHit.freeze) sim.emit({ t: 'freeze', x: ox, y: oy, r });
  return true;
}

export function fireMortar(sim, t, a) {
  if (sim._liveEnemies === 0) return false;
  const aim = t.aim || t.data.defaultAim;
  const sp = a.splash;
  for (let c = 0; c < a.count; c++) {
    const rr = a.inaccuracy * Math.sqrt(sim.rng());
    const th = sim.rng() * TAU;
    const p = allocProjectile(sim);
    p.mortar = true;
    p.x0 = t.x; p.y0 = t.y; p.x = t.x; p.y = t.y;
    p.tx = aim.x + Math.cos(th) * rr; p.ty = aim.y + Math.sin(th) * rr;
    p.flight = a.flightTime;
    p.arc = a.arc || 120;
    p.splash = sp;
    p.src = sp._src;
    p.dtype = sp.dtype;
    p.damage = sp.damage;
    p.pierce = 1;
    p.radius = a.projRadius || 8;
    p.visual = a.visual || 'shell';
    p.color = a.color || '#ffb347';
    p.scale = a.scale || 1;
    p.towerId = t.id;
    p.attackKey = a.key;
    p.atk = a;
    p.angle = Math.atan2(p.ty - t.y, p.tx - t.x);
    p.speed = 0; p.vx = 0; p.vy = 0; p.life = a.flightTime; p.maxLife = a.flightTime;
  }
  t.angle = Math.atan2(aim.y - t.y, aim.x - t.x);
  sim.emit({ t: 'shot', tower: t.id, type: t.type, x: t.x, y: t.y, angle: t.angle, visual: a.visual || 'shell', dtype: sp.dtype, attack: a.key });
  return true;
}

function beamState(t, key) {
  let bs = t.data['_beam_' + key];
  if (!bs) bs = t.data['_beam_' + key] = { ids: [], lockT: [], acc: 0 };
  return bs;
}

export function updateBeam(sim, t, a, dt) {
  const bs = beamState(t, a.key);
  const detect = t.stats.detection || !!a.detection;
  const byId = sim._enemyById;
  for (let k = bs.ids.length - 1; k >= 0; k--) {
    const e = byId.get(bs.ids[k]);
    let ok = !!e && !e.dead;
    if (ok) {
      const dx = e.x - t.x, dy = e.y - t.y, rr = a.range + e.radius;
      ok = dx * dx + dy * dy <= rr * rr && (!e.phantom || detect || e.exposedT > 0) && canDamage(e, a.dtype, a.bypass);
    }
    if (!ok) { bs.ids.splice(k, 1); bs.lockT.splice(k, 1); }
  }
  while (bs.ids.length < a.beams) {
    const e = findTarget(sim, t, a.range, t.targeting, a, t.x, t.y, bs.ids);
    if (!e) break;
    bs.ids.push(e.id); bs.lockT.push(0);
  }
  if (!bs.ids.length) { bs.acc = 0; t.target = null; return; }
  bs.acc += dt;
  for (let k = 0; k < bs.lockT.length; k++) bs.lockT[k] += dt;
  let guard = 0;
  while (bs.acc >= a.tickRate && guard++ < 8) {
    bs.acc -= a.tickRate;
    for (let k = 0; k < bs.ids.length; k++) {
      const e = byId.get(bs.ids[k]);
      if (!e || e.dead) continue;
      let mult = 1 + a.ramp * bs.lockT[k];
      if (mult > a.rampMax) mult = a.rampMax;
      if (mult < 1) mult = 1;
      damageEnemy(sim, e, a.dps * a.tickRate * mult, a.dtype, a._src, -1, a.onHit || null);
    }
  }
  if (bs.acc > a.tickRate) bs.acc = a.tickRate;
  // visuals
  const beams = t.data.beams || (t.data.beams = []);
  const pool = t.data._beamPool || (t.data._beamPool = []);
  let first = true;
  for (let k = 0; k < bs.ids.length; k++) {
    const e = byId.get(bs.ids[k]);
    if (!e || e.dead) continue;
    if (first) { t.angle = Math.atan2(e.y - t.y, e.x - t.x); t.target = e.id; first = false; }
    const idx = beams.length;
    let b = pool[idx];
    if (!b) b = pool[idx] = { x1: 0, y1: 0, x2: 0, y2: 0, width: 6, color: '#fff', ramp: 1, dtype: 'THERMAL', targetId: -1 };
    b.x1 = t.x; b.y1 = t.y; b.x2 = e.x; b.y2 = e.y;
    let mult = 1 + a.ramp * bs.lockT[k];
    if (mult > a.rampMax) mult = a.rampMax;
    b.ramp = mult < 1 ? 1 : mult;
    b.width = a.width * (a.rampWidth ? 0.7 + 0.3 * b.ramp / Math.max(1, a.rampMax) : 1);
    b.color = a.color || '#ff6b3d';
    b.dtype = a.dtype;
    b.targetId = e.id;
    beams.push(b);
  }
}

export function updateField(sim, t, a, dt) {
  const q = sim.grid.query(t.x, t.y, a.radius, sim._qArea);
  const key = '_field_' + a.key;
  let fd = t.data[key];
  if (!fd) fd = t.data[key] = { acc: 0 };
  if (q.length === 0) { fd.acc = 0; return; }
  let dmgNow = false;
  if (a.dps > 0) {
    fd.acc += dt;
    if (fd.acc >= a.tickRate) { fd.acc -= a.tickRate; dmgNow = true; }
  }
  const fx = a._fieldFx;
  const pull = a.pull || 0, shipPull = a.shipPull || 0;
  for (let i = 0; i < q.length; i++) {
    const e = q[i];
    if (e.dead) continue;
    if (fx) applyEffects(sim, e, fx, a._src);
    if (a.onTick) a.onTick(sim, t, e, a, dt);
    if (pull > 0 && e.titan === null) {
      const pv = e.ship ? shipPull : pull;
      if (pv > 0 && e.d > 0) { e.d -= pv * dt; if (e.d < 0) e.d = 0; placeOnPath(sim, e); }
    }
    if (dmgNow && !e.dead) damageEnemy(sim, e, a.dps * a.tickRate, a.dtype, a._src, -1, a.onHit || null);
  }
}

function orbitPoint(sim, t, a, idx, count, out) {
  const r = a.orbit || 44;
  const g = sim.state.time * 1.3 + (TAU * idx) / Math.max(1, count);
  out.x = t.x + Math.cos(g) * r;
  out.y = t.y + Math.sin(g) * r;
  return out;
}
const orb = { x: 0, y: 0 };

function droneList(sim, t, a) {
  const key = '_drones_' + a.key;
  let dl = t.data[key];
  if (!dl) dl = t.data[key] = [];
  const count = Math.max(0, Math.floor(a.count));
  while (dl.length < count) {
    const idx = dl.length;
    orbitPoint(sim, t, a, idx, count, orb);
    const d = { id: sim._nextDroneId++, towerId: t.id, x: orb.x, y: orb.y, angle: 0, targetId: -1, cd: 0, visual: a.visual || 'drone', kind: a.droneKind || a.key, idx, key: a.key, color: a.color || null };
    dl.push(d);
    sim.state.drones.push(d);
  }
  while (dl.length > count) {
    const d = dl.pop();
    const i = sim.state.drones.indexOf(d);
    if (i >= 0) sim.state.drones.splice(i, 1);
  }
  // When an upgrade changes the attack's look, restyle the drones created before it (a tower's
  // own custom attack may still restyle them afterwards; this only fires on a change).
  const vis = a.visual || 'drone', kind = a.droneKind || a.key, col = a.color || null;
  const sig = vis + '|' + kind + '|' + col;
  if (dl._look !== sig) {
    dl._look = sig;
    for (let i = 0; i < dl.length; i++) { const d = dl[i]; d.visual = vis; d.kind = kind; d.color = col; }
  }
  return dl;
}

export function updateDrones(sim, t, a, dt) {
  const dl = droneList(sim, t, a);
  const w = a.weapon;
  const byId = sim._enemyById;
  const taken = sim._droneTaken; taken.length = 0;
  const detect = t.stats.detection || !!w.detection;
  for (let i = 0; i < dl.length; i++) {
    const d = dl[i];
    d.cd -= dt;
    if (d.cd < 0) d.cd = 0;
    let tg = d.targetId >= 0 ? byId.get(d.targetId) : null;
    if (tg) {
      const dx = tg.x - t.x, dy = tg.y - t.y, rr = a.patrol + tg.radius;
      if (tg.dead || dx * dx + dy * dy > rr * rr || (tg.phantom && !detect && tg.exposedT <= 0) || !canDamage(tg, w.dtype, w.bypass)) tg = null;
    }
    if (!tg && ((sim.state.tick + i) % 6 === 0 || d.targetId >= 0)) {
      tg = findTarget(sim, t, a.patrol, t.targeting, w, t.x, t.y, taken);
      if (!tg && taken.length) tg = findTarget(sim, t, a.patrol, t.targeting, w, t.x, t.y, null);
    }
    d.targetId = tg ? tg.id : -1;
    let gx, gy, stand = 0;
    if (tg) { gx = tg.x; gy = tg.y; stand = w.range * 0.6; taken.push(tg.id); }
    else { orbitPoint(sim, t, a, i, dl.length, orb); gx = orb.x; gy = orb.y; }
    const dx = gx - d.x, dy = gy - d.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > stand) {
      const step = Math.min(dist - stand, a.droneSpeed * dt);
      if (dist > 0) { d.x += (dx / dist) * step; d.y += (dy / dist) * step; }
      if (!tg && dist > 0.01) d.angle = Math.atan2(dy, dx);
    }
    if (tg) {
      d.angle = Math.atan2(tg.y - d.y, tg.x - d.x);
      if (d.cd <= 0 && dist <= w.range + tg.radius) {
        fireAt(sim, t, w, tg, d.x, d.y);
        d.cd = w.cooldown;
      }
    }
  }
}

// Put every drone exactly on its idle orbit point (used when entering the build phase and
// after loading a save so both runs stay bit-identical).
export function snapDrones(sim) {
  for (const t of sim.state.towers) {
    for (const a of t.stats._attackList) {
      if (a.kind !== 'drone') continue;
      const dl = droneList(sim, t, a);
      for (let i = 0; i < dl.length; i++) {
        orbitPoint(sim, t, a, i, dl.length, orb);
        const d = dl[i];
        d.x = orb.x; d.y = orb.y; d.targetId = -1; d.cd = 0; d.angle = 0;
      }
    }
  }
}

export function removeTowerDrones(sim, t) {
  const drones = sim.state.drones;
  let w = 0;
  for (let i = 0; i < drones.length; i++) if (drones[i].towerId !== t.id) drones[w++] = drones[i];
  drones.length = w;
  for (const k of Object.keys(t.data)) if (k.startsWith('_drones_')) delete t.data[k];
}
