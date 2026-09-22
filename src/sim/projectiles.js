// Projectiles: pooled objects, motion, swept collision, pierce, splash, split, bounce,
// homing and mortar shells. Pure.
import { damageEnemy, applyEffects, enemySpeed } from './enemies.js';
import { segPointDist2, segParam, turnToward } from '../core/math.js';

const TAU = Math.PI * 2;

function blankProjectile() {
  return {
    id: 0, x: 0, y: 0, vx: 0, vy: 0, speed: 0, angle: 0, radius: 6, life: 0, maxLife: 0,
    dtype: 'KINETIC', damage: 1, pierce: 1, hit: [],
    homing: 0, targetId: -1, detection: false, visual: 'bolt', color: '#fff',
    towerId: -1, attackKey: '', src: null, atk: null,
    splash: null, splashOnExpire: false, onHit: null, split: null, splitOn: 'hit', bounce: 0, bounceRange: 180,
    mortar: false, x0: 0, y0: 0, tx: 0, ty: 0, prog: 0, flight: 0, arc: 0,
    scale: 1, dead: false,
  };
}

export function allocProjectile(sim) {
  const p = sim._projPool.length ? sim._projPool.pop() : blankProjectile();
  p.id = sim._nextProjId++;
  p.hit.length = 0;
  p.homing = 0; p.targetId = -1; p.detection = false;
  p.splash = null; p.splashOnExpire = false; p.onHit = null; p.split = null; p.splitOn = 'hit';
  p.bounce = 0; p.bounceRange = 180; p.mortar = false; p.prog = 0; p.arc = 0; p.scale = 1; p.dead = false;
  p.src = null; p.atk = null;
  sim.state.projectiles.push(p);
  return p;
}

// Launch a projectile described by a normalized attack `a` from (x, y) at angle `ang`.
export function launchProjectile(sim, tower, a, x, y, ang, targetId) {
  const p = allocProjectile(sim);
  const sp = a.speed;
  p.x = x; p.y = y;
  p.vx = Math.cos(ang) * sp; p.vy = Math.sin(ang) * sp;
  p.speed = sp; p.angle = ang;
  p.radius = a.projRadius;
  p.life = a.lifetime; p.maxLife = a.lifetime;
  p.dtype = a.dtype; p.damage = a.damage; p.pierce = a.pierce;
  p.homing = a.homing || 0;
  p.targetId = targetId ?? -1;
  p.detection = !!(tower && tower.stats && tower.stats.detection) || !!a.detection;
  p.visual = a.visual || 'bolt';
  p.color = a.color || '#ffffff';
  p.scale = a.scale || 1;
  p.towerId = tower ? tower.id : -1;
  p.attackKey = a.key || '';
  p.src = a._src;
  p.atk = a;
  p.splash = a.splash || null;
  p.splashOnExpire = !!a.splashOnExpire;
  p.onHit = a.onHit || null;
  p.split = a.split || null;
  p.splitOn = a.splitOn || 'hit';
  p.bounce = a.bounce || 0;
  p.bounceRange = a.bounceRange || 180;
  return p;
}

// Area damage: up to splash.pierce enemies (closest first) within splash.radius.
export function explode(sim, x, y, splash, src, emit = true) {
  const r = splash.radius;
  const q = sim.grid.query(x, y, r, sim._qExp);
  const n = q.length;
  const pierce = splash.pierce ?? 20;
  if (n > pierce) {
    const d2 = sim._expDist;
    d2.length = 0;
    for (let i = 0; i < n; i++) { const e = q[i]; const dx = e.x - x, dy = e.y - y; d2.push(dx * dx + dy * dy); }
    // insertion sort by distance (n is small)
    for (let i = 1; i < n; i++) {
      const ke = q[i], kd = d2[i];
      let j = i - 1;
      while (j >= 0 && d2[j] > kd) { q[j + 1] = q[j]; d2[j + 1] = d2[j]; j--; }
      q[j + 1] = ke; d2[j + 1] = kd;
    }
  }
  const s = src || splash._src;
  const lim = n < pierce ? n : pierce;
  const dmg = splash.damage;
  const dtype = splash.dtype || s.dtype;
  for (let i = 0; i < lim; i++) {
    const e = q[i];
    if (e.dead) continue;
    if (dmg > 0) damageEnemy(sim, e, dmg, dtype, s, -1, splash.onHit || null);
    else if (splash.onHit) applyEffects(sim, e, splash.onHit, s);
  }
  if (emit) sim.emit({ t: 'explode', x, y, r, dtype, visual: splash.visual || null, color: splash.color || null });
}

function doSplit(sim, p, x, y, hitId) {
  const sp = p.split;
  const a = sp.attack;
  const n = sp.count;
  const base = Math.atan2(p.vy, p.vx);
  const spread = sp.spread ?? TAU;
  const full = spread >= TAU - 1e-6;
  const tower = sim._towerById.get(p.towerId) || null;
  for (let i = 0; i < n; i++) {
    let ang;
    if (full) ang = base + (TAU * i) / n + 0.3;
    else ang = n === 1 ? base : base - spread / 2 + (spread * i) / (n - 1);
    const c = launchProjectile(sim, tower, a, x, y, ang, -1);
    if (hitId >= 0) c.hit.push(hitId);
    c.towerId = p.towerId;
  }
}

function retarget(sim, p, x, y, range) {
  const q = sim.grid.query(x, y, range, sim._qProj2);
  let best = null, bd = Infinity;
  for (let i = 0; i < q.length; i++) {
    const e = q[i];
    if (e.dead) continue;
    if (e.phantom && !p.detection && e.exposedT <= 0) continue;
    if (p.hit.indexOf(e.id) >= 0) continue;
    if (e.immuneProj === p.id) continue;
    const dx = e.x - x, dy = e.y - y, d2 = dx * dx + dy * dy;
    if (d2 < bd) { bd = d2; best = e; }
  }
  return best;
}

function projHit(sim, p, e) {
  p.hit.push(e.id);
  p.pierce--;
  const src = p.src;
  const wantsDamage = p.damage > 0 || (e.ship && src.shipDamage > 0) || (src.bonus && src.bonus[e.type]);
  if (wantsDamage) {
    damageEnemy(sim, e, p.damage, p.dtype, src, p.id, p.onHit);
    if (!sim._lastBlocked && !e.dead) sim.emit({ t: 'hit', x: e.x, y: e.y, dtype: p.dtype });
  } else if (p.onHit) applyEffects(sim, e, p.onHit, src);
  const hx = e.x, hy = e.y;
  if (p.splash) explode(sim, hx, hy, p.splash, p.splash._src);
  if (p.split && (p.splitOn === 'hit' || p.splitOn === 'both')) doSplit(sim, p, hx, hy, e.id);
}

function expire(sim, p) {
  if (p.splashOnExpire && p.splash) explode(sim, p.x, p.y, p.splash, p.splash._src);
  if (p.split && (p.splitOn === 'expire' || p.splitOn === 'both')) doSplit(sim, p, p.x, p.y, -1);
  p.dead = true;
}

export function updateProjectiles(sim, dt) {
  const list = sim.state.projectiles;
  const hits = sim._hitBuf, ts = sim._hitT;
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    if (p.dead) continue;
    if (p.mortar) {
      p.prog += dt / p.flight;
      if (p.prog >= 1) {
        p.x = p.tx; p.y = p.ty;
        explode(sim, p.tx, p.ty, p.splash, p.splash._src);
        p.dead = true;
      } else {
        p.x = p.x0 + (p.tx - p.x0) * p.prog;
        p.y = p.y0 + (p.ty - p.y0) * p.prog;
      }
      continue;
    }
    // homing
    if (p.homing > 0) {
      let tg = p.targetId >= 0 ? sim._enemyById.get(p.targetId) : null;
      if (!tg || tg.dead || p.hit.indexOf(tg.id) >= 0) {
        tg = null;
        if (((sim.state.tick + p.id) & 3) === 0) {
          tg = retarget(sim, p, p.x, p.y, 320);
        }
        p.targetId = tg ? tg.id : -1;
      }
      if (tg) {
        const cur = Math.atan2(p.vy, p.vx);
        const want = Math.atan2(tg.y - p.y, tg.x - p.x);
        const na = turnToward(cur, want, p.homing * dt);
        p.vx = Math.cos(na) * p.speed; p.vy = Math.sin(na) * p.speed;
        p.angle = na;
      }
    }
    const x0 = p.x, y0 = p.y;
    const x1 = x0 + p.vx * dt, y1 = y0 + p.vy * dt;
    const mx = (x0 + x1) * 0.5, my = (y0 + y1) * 0.5;
    const half = Math.sqrt((x1 - x0) * (x1 - x0) + (y1 - y0) * (y1 - y0)) * 0.5;
    const cands = sim.grid.query(mx, my, half + p.radius, sim._qProj);
    hits.length = 0; ts.length = 0;
    for (let k = 0; k < cands.length; k++) {
      const e = cands[k];
      if (e.dead || e.immuneProj === p.id) continue;
      if (p.hit.length && p.hit.indexOf(e.id) >= 0) continue;
      const rr = p.radius + e.radius;
      if (segPointDist2(x0, y0, x1, y1, e.x, e.y) <= rr * rr) {
        const tt = segParam(x0, y0, x1, y1, e.x, e.y);
        // insertion by t
        let j = hits.length;
        hits.push(e); ts.push(tt);
        while (j > 0 && ts[j - 1] > tt) { hits[j] = hits[j - 1]; ts[j] = ts[j - 1]; j--; }
        hits[j] = e; ts[j] = tt;
      }
    }
    p.x = x1; p.y = y1;
    for (let k = 0; k < hits.length && p.pierce > 0; k++) {
      const e = hits[k];
      if (e.dead) continue;
      projHit(sim, p, e);
      if (p.bounce > 0 && p.pierce > 0) {
        const nx = e.x, ny = e.y;
        const nt = retarget(sim, p, nx, ny, p.bounceRange);
        if (nt) {
          p.bounce--;
          const ang = Math.atan2(nt.y - ny, nt.x - nx);
          p.x = nx; p.y = ny;
          p.vx = Math.cos(ang) * p.speed; p.vy = Math.sin(ang) * p.speed;
          p.angle = ang;
          p.targetId = nt.id;
          p.life = Math.max(p.life, 0.25);
          break;
        }
      }
    }
    if (p.pierce <= 0) { p.dead = true; continue; }
    p.life -= dt;
    if (p.life <= 0) { expire(sim, p); continue; }
    if (p.x < -200 || p.x > 1700 || p.y < -200 || p.y > 1200) p.dead = true;
  }
  // compact + pool
  let w = 0;
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    if (p.dead) { if (sim._projPool.length < 4000) sim._projPool.push(p); }
    else list[w++] = p;
  }
  list.length = w;
}

// Predict where an enemy will be after travelling for the projectile flight time.
export function leadPoint(sim, e, ox, oy, speed, out) {
  const dx = e.x - ox, dy = e.y - oy;
  const t = Math.sqrt(dx * dx + dy * dy) / speed;
  const v = enemySpeed(e);
  if (v <= 0 || t <= 0) { out.x = e.x; out.y = e.y; return out; }
  const path = sim.paths[e.lane] || sim.paths[0];
  const d = Math.min(path.length, e.d + v * t);
  const p = path.pointAt(d, sim._pt2);
  out.x = p.x - Math.sin(p.angle) * e.off;
  out.y = p.y + Math.cos(p.angle) * e.off;
  return out;
}
