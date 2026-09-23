// Tesla Coil: ENERGY chain lightning. Pure data plus pure behavior functions.
// Prices follow docs/ECONOMY.md 2.4 for base b = 600:
//   T1 240..720, T2 480..1500, T3 1200..4800, T4 4800..18000, T5 24000..90000.
//
// ENERGY hits Iron, Magma, Comets, Geodes and frozen meteors; Prism meteors are immune.
// Answers: Overload (path C) adds detection at T2; Ball Lightning (path B) orbs shatter Prism
// from T4 and their zaps reach Phantom meteors (area damage).

const main = (s) => s.attacks.main;

// Can `dtype` (with `bypass`) damage enemy e? Mirrors canDamage in src/sim/enemies.js for
// the ENERGY/VOID cases this tower uses (no KINETIC frozen/shield rules needed).
function hurts(e, dtype, bypass) {
  const imm = e.def.immune;
  if (imm.length && imm.indexOf(dtype) >= 0) {
    if (!bypass || (bypass.indexOf(dtype) < 0 && bypass.indexOf(e.type) < 0)) return false;
  }
  return true;
}

function srcOf(atk) {
  const s = atk._src;
  if (s && !s._norm) s._norm = true; // engine-normalized source: safe to pass to sim.damage
  return s;
}

// ------------------------------------------------------------------ Ball Lightning
// The orb itself is a normal projectile attack ('orb') so bots, benches and the UI see it.
// This companion custom attack ('orbfx') steers every live orb of the tower onto the channel
// and rolls it upstream (against the flow of meteors), and zaps meteors around it.
// Per-wave scratch lives in tower.data._field_orbs, which the engine deletes when the build
// phase starts (so saves and replays never see it).
const zapBuf = [];
function orbUpdate(sim, tower, atk, dt) {
  const list = sim.state.projectiles;
  if (!list.length) return;
  let orbs = tower.data._field_orbs;
  const tick = sim.state.tick;
  let zapFx = 0;
  const src = srcOf(atk);
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    if (p.dead || p.towerId !== tower.id || p.attackKey !== 'orb') continue;
    if (!orbs) orbs = tower.data._field_orbs = new Map();
    let o = orbs.get(p.id);
    if (!o) {
      const tg = p.targetId >= 0 ? sim.getEnemy(p.targetId) : null;
      let lane, d;
      if (tg && !tg.dead) { lane = tg.lane; d = tg.d; } else { const np = sim.nearestPathPoint(p.x, p.y); lane = np.lane; d = np.d; }
      o = { lane, d, zt: atk.zapEvery * 0.5, seen: tick };
      orbs.set(p.id, o);
    }
    o.seen = tick;
    // steer: fly to the anchor point on the channel (also after drifting while the coil was
    // stunned), then roll up the channel against the flow
    let gx, gy;
    const g = sim.pathPoint(o.lane, o.d);
    const dx = g.x - p.x, dy = g.y - p.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const stepLen = atk.approach * dt;
    if (dist > stepLen && dist > 12) {
      gx = p.x + (dx / dist) * stepLen; gy = p.y + (dy / dist) * stepLen;
    } else {
      o.d -= atk.roll * dt;
      if (o.d <= 0) { p.dead = true; continue; }
      const g2 = sim.pathPoint(o.lane, o.d);
      gx = g2.x; gy = g2.y;
    }
    p.vx = (gx - p.x) / dt; p.vy = (gy - p.y) / dt;
    // zap meteors around the orb (area damage: reaches Phantom meteors too)
    o.zt -= dt;
    if (o.zt > 0) continue;
    o.zt += atk.zapEvery;
    const near = sim.enemiesInRange(p.x, p.y, atk.zapRadius);
    zapBuf.length = 0;
    for (let k = 0; k < near.length; k++) {
      const e = near[k];
      if (e.dead || !hurts(e, atk.dtype, atk.bypass)) continue;
      const dx = e.x - p.x, dy = e.y - p.y;
      e._zd = dx * dx + dy * dy;
      zapBuf.push(e);
    }
    if (!zapBuf.length) continue;
    if (zapBuf.length > atk.zapCount) zapBuf.sort((a, b) => a._zd - b._zd);
    const n = Math.min(atk.zapCount, zapBuf.length);
    for (let k = 0; k < n; k++) {
      const e = zapBuf[k];
      if (e.dead) continue;
      const ex = e.x, ey = e.y;
      sim.damage(e, atk.damage, atk.dtype, src);
      if (zapFx < 10) { zapFx++; sim.emit({ t: 'zap', points: [[p.x, p.y], [ex, ey]], tower: tower.id, type: 'tesla', dtype: atk.dtype, color: atk.color, visual: 'orbzap' }); }
    }
  }
  // forget orbs that no longer exist (projectiles are pooled, so ids are the identity)
  if (orbs && orbs.size && (tick & 31) === 0) {
    for (const [id, o] of orbs) if (o.seen !== tick) orbs.delete(id);
  }
}

// ------------------------------------------------------------------ Wrath of Zeus
function strongScore(e) {
  return (e.titan !== null ? 1e13 : 0) + (e.ship ? 1e12 : 0) + (e.hp + e.childMass + (e.titan ? e.titan.shield : 0)) * 1000 + e.d * 1e-3;
}
function strongest(sim, exclude) {
  let best = null, bs = -Infinity;
  for (const e of sim.state.enemies) {
    if (e.dead || exclude.indexOf(e.id) >= 0) continue;
    if (e.x < 0 || e.x > 1500 || e.y < 0 || e.y > 1000) continue;
    if (!hurts(e, 'ENERGY', null)) continue;
    const s = strongScore(e);
    if (s > bs) { bs = s; best = e; }
  }
  return best;
}

const ZEUS_STRIKES = 6;
const ZEUS_DAMAGE = 2500;
const zeus = {
  id: 'zeus',
  name: 'Wrath of Zeus',
  icon: 'zeus',
  cooldown: 50,
  duration: 1,
  desc: 'Lightning strikes the 6 strongest enemies on the map (never Prism meteors) for 2,500 ENERGY damage each and stuns them for 1.5 s (Storm Titans half as long), and each strike\'s 110 unit blast deals 30 damage to up to 40 enemies around it.',
  activate(sim, tower) {
    const struck = [];
    const src = { tower, attackKey: 'zeus', dtype: 'ENERGY' };
    for (let i = 0; i < ZEUS_STRIKES; i++) {
      sim.after(0.12 + i * 0.14, (s) => {
        if (s.getTower(tower.id) !== tower) return; // coil sold mid-strike
        const e = strongest(s, struck);
        if (!e) return;
        struck.push(e.id);
        const x = e.x, y = e.y;
        const jx = (s.rng() - 0.5) * 160;
        s.emit({ t: 'zap', points: [[x + jx, y - 560], [x + jx * 0.4 + (s.rng() - 0.5) * 60, y - 260], [x, y]], tower: tower.id, type: 'tesla', dtype: 'ENERGY', color: '#ffe14d', visual: 'zeus' });
        s.emit({ t: 'zap', points: [[x - jx * 0.6, y - 480], [x, y]], tower: tower.id, type: 'tesla', dtype: 'ENERGY', color: '#fff6c2', visual: 'zeus' });
        s.damage(e, ZEUS_DAMAGE, 'ENERGY', src, { onHit: { stun: { t: 1.5, shipT: 1.5 } } });
        s.explode(x, y, { radius: 110, damage: 30, pierce: 40, dtype: 'ENERGY' }, src);
        s.emit({ t: 'abilityFx', id: 'zeus', x, y, r: 130 });
      });
    }
  },
};

export default {
  id: 'tesla',
  name: 'Tesla Coil',
  hotkey: 'y',
  cost: 600,
  radius: 22,
  blurb: 'Chain lightning that leaps between meteors.',
  desc: 'Arcs of ENERGY lightning jump from meteor to meteor. Hits Iron and frozen meteors, but Prism meteors are immune.',
  art: {
    sprite: 'tower_tesla', rotates: false, color: '#6fd8ff', accent: '#e39a52', shape: 'circle', barrels: 0,
    variant(levels) { return levels[0] >= 3 ? 1 : levels[1] >= 3 ? 2 : levels[2] >= 3 ? 3 : 0; },
  },
  base: {
    range: 145,
    detection: false,
    targetModes: ['first', 'last', 'strong', 'close'],
    attacks: {
      main: {
        kind: 'chain', cooldown: 0.8, damage: 1, jumps: 3, jumpRange: 95, falloff: 1, dtype: 'ENERGY',
        visual: 'arc', color: '#8fe9ff',
      },
    },
    aura: null,
    income: null,
    abilities: [],
  },
  paths: [
    {
      name: 'Chain',
      upgrades: [
        { name: 'Forked Arcs', cost: 250, desc: 'Arcs jump to 2 more meteors (6 per shot) and reach 15 units farther.',
          apply(s) { const a = main(s); a.jumps += 2; a.jumpRange += 15; } },
        { name: 'High Voltage', cost: 900, desc: 'Arcs deal 2 damage and fire 15% faster.',
          apply(s) { const a = main(s); a.damage += 1; a.cooldown *= 0.87; } },
        { name: 'Arc Web', cost: 1700, desc: 'Fires 2 chains per shot, each leaping through up to 9 meteors up to 125 units apart.',
          apply(s) { const a = main(s); a.count = (a.count || 1) + 1; a.jumps += 3; a.jumpRange += 15; a.color = '#7fe3ff'; a.visual = 'arcweb'; } },
        { name: 'Tempest Grid', cost: 7500, desc: 'Chains fire twice as fast and deal 5 damage (15 to ships). Range and arc reach +20.',
          apply(s) { const a = main(s); a.damage += 3; a.shipDamage = (a.shipDamage || 0) + 10; a.cooldown *= 0.5; a.jumpRange += 20; s.range += 20; } },
        { name: 'Storm Crown', cost: 25000, desc: 'Chains fire 4 times as fast and deal 8 damage (30 to ships). Range +35.',
          apply(s) {
            const a = main(s);
            a.damage += 3; a.shipDamage = (a.shipDamage || 0) + 12; a.cooldown /= 4;
            a.color = '#63d4ff'; a.visual = 'stormcrown';
            s.range += 35;
          } },
      ],
    },
    {
      name: 'Ball Lightning',
      upgrades: [
        { name: 'Wide Coil', cost: 250, desc: 'Range +25, and arcs jump to 2 more meteors.',
          apply(s) { const a = main(s); s.range += 25; a.jumps += 2; } },
        { name: 'Capacitors', cost: 1100, desc: 'Fires 33% faster and arcs deal 2 damage.',
          apply(s) { const a = main(s); a.cooldown *= 0.75; a.damage += 1; } },
        { name: 'Ball Lightning', cost: 1800, desc: 'Every 2 s launches a ball of lightning that rolls up the channel through 40 meteors for 1 damage each, and every 0.3 s zaps the 3 nearest meteors within 75 units (Phantoms too) for 1 damage.',
          apply(s) {
            s.attacks.orb = {
              kind: 'projectile', cooldown: 2, damage: 1, pierce: 40, dtype: 'ENERGY', speed: 380, projRadius: 11,
              lifetime: 4.5, noLead: true, visual: 'orb', color: '#c28cff',
            };
            s.attacks.orbfx = {
              kind: 'custom', dtype: 'ENERGY', damage: 1, needsTarget: false, color: '#d9b8ff',
              approach: 380, roll: 95, zapEvery: 0.3, zapCount: 3, zapRadius: 75, update: orbUpdate,
            };
          } },
        { name: 'Plasma Orbs', cost: 7400, desc: 'Orbs launch every second, hit 80 meteors for 2 damage, zap 5 meteors for 2 damage every 0.25 s and can shatter Prism meteors.',
          apply(s) {
            const o = s.attacks.orb, fx = s.attacks.orbfx;
            o.cooldown *= 0.5; o.pierce += 40; o.damage += 1; o.projRadius = 14; o.color = '#d08cff';
            o.bypass = [...(o.bypass || []), 'prism'];
            fx.damage += 1; fx.zapCount += 2; fx.zapEvery = 0.25;
            fx.bypass = [...(fx.bypass || []), 'prism'];
          } },
        { name: 'Plasma Tempest', cost: 50000, desc: 'Launches huge, slower-rolling plasma orbs every 0.6 s that hit 180 meteors for 5 damage and zap 6 meteors within 150 units for 5 damage.',
          apply(s) {
            const o = s.attacks.orb, fx = s.attacks.orbfx;
            o.cooldown = 0.6; o.pierce += 100; o.damage += 3; o.projRadius = 24; o.lifetime = 7; o.color = '#c070ff'; o.visual = 'plasma orb';
            fx.damage += 3; fx.zapCount += 1; fx.zapRadius = 150; fx.zapEvery = 0.25; fx.roll = 70; fx.color = '#cf8cff';
            main(s).color = '#d6a8ff';
          } },
      ],
    },
    {
      name: 'Overload',
      upgrades: [
        { name: 'Hot Coils', cost: 420, desc: 'Arcs deal 2 damage.',
          apply(s) { main(s).damage += 1; } },
        { name: 'Scanner Coil', cost: 480, desc: 'Detection: arcs can target Phantom meteors. Range +20.',
          apply(s) { s.detection = true; s.range += 20; } },
        { name: 'Overload', cost: 2400, desc: 'Arcs become heavy overload bolts that deal 12 damage (40 to ships) to one target and stun it for 0.5 s (ships 0.15 s).',
          apply(s) {
            const a = main(s);
            // one target: also drops the extra jumps of Forked Arcs or Wide Coil crosspaths
            a.jumps = 0; a.damage += 10; a.shipDamage = (a.shipDamage || 0) + 28;
            a.onHit = { ...(a.onHit || {}), stun: { t: 0.5, shipT: 0.15 } };
            a.color = '#ffe14d'; a.visual = 'overload';
          } },
        { name: 'Thunderstrike', cost: 8800, desc: 'Bolts deal 30 damage (130 to ships), fire 25% faster and stun ships for 0.25 s.',
          apply(s) {
            const a = main(s);
            a.damage += 18; a.shipDamage = (a.shipDamage || 0) + 72; a.cooldown *= 0.8;
            a.onHit = { ...(a.onHit || {}), stun: { t: 0.5, shipT: 0.25 } };
            a.color = '#fff08a';
          } },
        { name: 'Zeus Array', cost: 43000, desc: 'Fires 2 bolts per shot, 67% faster, for 80 damage (500 to ships). Unlocks Wrath of Zeus: lightning strikes the 6 strongest enemies for 2,500 damage.',
          apply(s) {
            const a = main(s);
            a.damage += 50; a.shipDamage = (a.shipDamage || 0) + 320; a.cooldown *= 0.6; a.count = (a.count || 1) + 1;
            a.color = '#fff6c2'; a.visual = 'zeus';
            s.abilities.push(zeus);
          } },
      ],
    },
  ],
};
