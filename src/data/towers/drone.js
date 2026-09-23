// Drone Bay: keeps drones that hunt meteors inside a large patrol radius. Pure data plus pure
// behavior functions.
// Prices follow docs/ECONOMY.md 2.4 for base b = 800:
//   T1 320..960, T2 640..2000, T3 1600..6400, T4 6400..24000, T5 32000..120000.
//
// KINETIC guns cannot hurt Iron or frozen meteors. Answers: Bomber (path B) switches to BLAST
// at T2 and fires BLAST missiles from T3 (hits Iron and frozen, not Magma);
// Swarm (path A) hits frozen meteors from T4; Tractor (path C) adds detection at T2.

const main = (s) => s.attacks.main;
const gun = (s) => s.attacks.main.weapon;
const bay = (s) => s.attacks.bay;

function srcOf(atk) {
  const s = atk._src;
  if (s && !s._norm) s._norm = true; // engine-normalized source: safe to pass to sim.damage
  return s;
}

// The engine keeps a tower's drones in tower.data['_drones_<attack key>'] and only sets their
// look when they are created, so this companion attack keeps the look in sync with upgrades,
// runs the tractor beams (path C) and flies the Strike Wing bombing run (path B).
function dronesOf(tower) { return tower.data._drones_main || null; }

function place(sim, e) {
  const p = sim.pathPoint(e.lane, e.d);
  if (e.off) { e.x = p.x - Math.sin(p.angle) * e.off; e.y = p.y + Math.cos(p.angle) * e.off; }
  else { e.x = p.x; e.y = p.y; }
}

const towFx = { slow: { mult: 1, shipMult: 1, t: 0.2 } };
function towUpdate(sim, tower, atk, dl, dt) {
  const tow = atk.tow;
  const reach = tower.stats.attacks.main.weapon.range + 12;
  const src = srcOf(atk);
  for (let i = 0; i < dl.length; i++) {
    const d = dl[i];
    d.towing = false; // render hint: true while this drone's beam is actually holding its target
    if (d.targetId < 0) continue;
    const e = sim.getEnemy(d.targetId);
    if (!e || e.dead) continue;
    const dx = e.x - d.x, dy = e.y - d.y, rr = reach + e.radius;
    if (dx * dx + dy * dy > rr * rr) continue;
    let speed, cap;
    if (e.ship) {
      if (!tow.ships) continue;
      if (e.titan !== null) {
        // Storm Titans are slowed (Gravity Hauler), never dragged
        if (tow.titanSlow < 1) { towFx.slow.shipMult = tow.titanSlow; towFx.slow.titanMult = tow.titanSlow; sim.applyEffects(e, towFx, src); d.towing = true; }
        continue;
      }
      towFx.slow.shipMult = tow.shipSlow;
      sim.applyEffects(e, towFx, src);
      d.towing = true;
      speed = tow.shipSpeed; cap = tow.shipCap;
    } else {
      if (e.hp + e.childMass > tow.maxMass) continue;
      speed = tow.speed; cap = tow.cap;
    }
    // Every enemy can be dragged at most `cap` units in total (shared by all tractors), so a
    // wave can never be stalled forever: each shell is towed once and then slips free.
    const used = e._towed || 0;
    if (used >= cap || e.d <= 0) continue;
    let amt = speed * dt;
    if (amt > cap - used) amt = cap - used;
    if (amt > e.d) amt = e.d;
    e._towed = used + amt;
    e.d -= amt;
    d.towing = true;
    place(sim, e);
  }
}

// Strike Wing bombing run: the wing sweeps every lane from the portal to the Core.
const RUN_DELAY = 0.3, RUN_SWEEP = 2.2, RUN_BLASTS = 36;
function runUpdate(sim, tower, dl, run) {
  run.t = sim.state.time - run.t0; // clock-based, so a stunned bay stays in sync with the bombs
  const f = (run.t - RUN_DELAY) / RUN_SWEEP;
  if (f > 1.08) { delete tower.data._field_run; return; }
  const lanes = sim.paths.length;
  for (let i = 0; i < dl.length; i++) {
    const d = dl[i];
    const lane = i % lanes;
    const L = sim.pathLength(lane);
    const slot = Math.floor(i / lanes);
    const along = Math.max(0, Math.min(L, L * (0.03 + 0.94 * Math.max(0, f)) - slot * 26));
    const p = sim.pathPoint(lane, along);
    const side = (slot % 2 === 0 ? 1 : -1) * (10 + slot * 4);
    const tx = p.x - Math.sin(p.angle) * side, ty = p.y + Math.cos(p.angle) * side;
    if (f < 0) {
      // take off: swoop from where the drone was to the head of the run
      const k = Math.min(1, run.t / RUN_DELAY), ease = k * k * (3 - 2 * k);
      const sx = run.sx[i] ?? tower.x, sy = run.sy[i] ?? tower.y;
      const nx = sx + (tx - sx) * ease, ny = sy + (ty - sy) * ease;
      if (Math.abs(nx - d.x) + Math.abs(ny - d.y) > 0.01) d.angle = Math.atan2(ny - d.y, nx - d.x);
      d.x = nx; d.y = ny;
    } else {
      d.x = tx; d.y = ty; d.angle = p.angle;
    }
    d.cd = Math.max(d.cd, 0.1); // hold fire during the run
  }
}

function bayUpdate(sim, tower, atk, dt) {
  const dl = dronesOf(tower);
  if (!dl || !dl.length) return;
  for (let i = 0; i < dl.length; i++) {
    const d = dl[i];
    if (d.kind !== atk.look) { d.kind = atk.look; d.visual = atk.look; }
    if (d.color !== atk.droneColor) d.color = atk.droneColor;
  }
  const run = tower.data._field_run;
  if (run) { runUpdate(sim, tower, dl, run); return; }
  if (atk.tow) towUpdate(sim, tower, atk, dl, dt);
}

const bombingRun = {
  id: 'bombingrun',
  name: 'Bombing Run',
  icon: 'bombingrun',
  cooldown: 45,
  duration: 2.5,
  desc: 'The wing sweeps the channel from the portal to the Core, dropping 36 bombs that each deal 40 BLAST damage (160 to ships) to up to 40 enemies within 72 units.',
  activate(sim, tower) {
    const dl = dronesOf(tower) || [];
    tower.data._field_run = { t: 0, t0: sim.state.time, sx: dl.map((d) => d.x), sy: dl.map((d) => d.y) };
    const lanes = sim.paths.length;
    const per = Math.max(12, Math.round(RUN_BLASTS / lanes));
    const src = { tower, attackKey: 'bombingrun', dtype: 'BLAST' };
    for (let lane = 0; lane < lanes; lane++) {
      const L = sim.pathLength(lane);
      for (let k = 0; k < per; k++) {
        const f = k / (per - 1);
        const p = sim.pathPoint(lane, L * (0.03 + 0.94 * f));
        sim.after(RUN_DELAY + RUN_SWEEP * f + 0.05, (s) => {
          if (s.getTower(tower.id) !== tower) return; // bay sold mid-run
          s.explode(p.x, p.y, { radius: 72, damage: 40, pierce: 40, dtype: 'BLAST', shipDamage: 120 }, src);
        });
      }
    }
    sim.emit({ t: 'abilityFx', id: 'bombingrun', x: tower.x, y: tower.y, r: 160 });
  },
};

export default {
  id: 'drone',
  name: 'Drone Bay',
  hotkey: 's',
  cost: 800,
  radius: 24,
  blurb: 'Drones that hunt meteors anywhere near the bay.',
  desc: 'Keeps 2 drones that fly out to hunt meteors inside a large patrol radius with KINETIC guns. Cannot hurt Iron or frozen meteors until upgraded.',
  art: {
    sprite: 'tower_drone', rotates: false, color: '#5eead4', accent: '#ffd23d', shape: 'square', barrels: 0,
    variant(levels) { return levels[0] >= 3 ? 1 : levels[1] >= 3 ? 2 : levels[2] >= 3 ? 3 : 0; },
  },
  base: {
    range: 240,
    detection: false,
    targetModes: ['first', 'last', 'strong', 'close'],
    attacks: {
      main: {
        kind: 'drone', count: 2, droneSpeed: 280, dtype: 'KINETIC', visual: 'gun', droneKind: 'gun', color: '#9ff3e6',
        weapon: {
          kind: 'projectile', cooldown: 0.5, damage: 1, pierce: 2, speed: 950, range: 120, projRadius: 5,
          visual: 'bolt', color: '#b8fff4',
        },
      },
      bay: { kind: 'custom', needsTarget: false, damage: 0, look: 'gun', droneColor: '#9ff3e6', tow: null, update: bayUpdate },
    },
    aura: null,
    income: null,
    abilities: [],
  },
  paths: [
    {
      name: 'Swarm',
      upgrades: [
        { name: 'Third Drone', cost: 330, desc: 'Adds a third drone.',
          apply(s) { main(s).count += 1; } },
        { name: 'Rapid Guns', cost: 640, desc: 'Drone guns fire 33% faster and drones fly 15% faster.',
          apply(s) { gun(s).cooldown *= 0.75; main(s).droneSpeed *= 1.15; } },
        { name: 'Drone Squadron', cost: 2400, desc: 'Deploys 5 drones that fire twin needles, each piercing 3 meteors.',
          apply(s) {
            const a = main(s), w = gun(s);
            a.count += 2; w.count = (w.count || 1) + 1; w.spread = 0.14; w.pierce += 1; w.visual = 'needle'; w.color = '#d6fffa';
          } },
        { name: 'Swarm Protocol', cost: 9500, desc: 'Deploys 8 faster drones whose needles deal 2 damage, fire 25% faster and can hit frozen meteors.',
          apply(s) {
            const a = main(s), w = gun(s);
            a.count += 3; a.droneSpeed += 60; w.damage += 1; w.cooldown *= 0.8;
            w.bypass = [...(w.bypass || []), 'FROZEN'];
          } },
        { name: 'Hive Carrier', cost: 32000, desc: 'Deploys 12 faster drones that fire 67% faster with needles that deal 4 damage and pierce 5 meteors. Patrol radius +60.',
          apply(s) {
            const a = main(s), w = gun(s);
            a.count += 4; a.droneSpeed += 80; w.damage += 2; w.pierce += 2; w.cooldown *= 0.6; w.speed += 250;
            w.color = '#ffffff';
            bay(s).droneColor = '#d9fff9';
            s.range += 60;
          } },
      ],
    },
    {
      name: 'Bomber',
      upgrades: [
        { name: 'Armor Piercing', cost: 350, desc: 'Drone rounds deal 2 extra damage to ships.',
          apply(s) { const w = gun(s); w.shipDamage = (w.shipDamage || 0) + 2; } },
        { name: 'Explosive Rounds', cost: 700, desc: 'Rounds deal 1 more damage to ships and switch to BLAST damage, which can hit Iron and frozen meteors but not Magma meteors or Geodes.',
          apply(s) { const w = gun(s); w.shipDamage = (w.shipDamage || 0) + 1; w.dtype = 'BLAST'; w.color = '#ffd08a'; main(s).dtype = 'BLAST'; } },
        { name: 'Bomber Drones', cost: 2200, desc: 'Drones become bombers that fire a pair of homing BLAST missiles every second, each hitting for 2 damage and exploding for 3 damage to up to 12 meteors across 55 units.',
          apply(s) {
            const w = gun(s);
            main(s).dtype = 'BLAST';
            w.dtype = 'BLAST'; w.damage = 2; w.pierce = 1; w.count = 2; w.spread = 0.5; w.speed = 520; w.homing = 8; w.cooldown = 1;
            w.range = 150; w.projRadius = 7; w.lifetime = 0.9; w.splashOnExpire = true;
            w.splash = { radius: 55, damage: 3, pierce: 12, dtype: 'BLAST' };
            w.visual = 'missile'; w.color = '#ffb347';
            const b = bay(s); b.look = 'bomber'; b.droneColor = '#ff9f43';
          } },
        { name: 'Heavy Bombers', cost: 7500, desc: 'One more bomber joins, and missiles reload 11% faster and deal 8 damage (20 to ships) to up to 24 meteors in a wider blast.',
          apply(s) {
            const a = main(s), w = gun(s), sp = w.splash;
            a.count += 1; sp.damage += 5; sp.radius += 15; sp.pierce += 12; sp.shipDamage = (sp.shipDamage || 0) + 12;
            w.cooldown *= 0.9; w.projRadius = 9;
          } },
        { name: 'Strike Wing', cost: 47000, desc: 'One more bomber joins, bombers fly faster and fire 3-missile salvos, 33% faster, that deal 17 damage (85 to ships) to up to 40 meteors. Unlocks Bombing Run: the wing carpet-bombs the channel.',
          apply(s) {
            const a = main(s), w = gun(s), sp = w.splash;
            a.count += 1; a.droneSpeed += 80; w.count = 3; w.spread = 0.7; w.cooldown *= 0.75;
            sp.damage += 9; sp.radius += 20; sp.pierce += 16; sp.shipDamage = (sp.shipDamage || 0) + 56;
            w.color = '#ff7a3d';
            bay(s).droneColor = '#ff7a3d';
            s.abilities.push(bombingRun);
          } },
      ],
    },
    {
      name: 'Tractor',
      upgrades: [
        { name: 'Afterburners', cost: 320, desc: 'Drones fly 35% faster, patrol 50 units farther and fire 15% faster.',
          apply(s) { main(s).droneSpeed *= 1.35; s.range += 50; gun(s).cooldown *= 0.87; } },
        { name: 'Sensor Drones', cost: 640, desc: 'Detection: drones can target Phantom meteors. Patrol radius +30.',
          apply(s) { s.detection = true; s.range += 30; } },
        { name: 'Tractor Drones', cost: 1700, desc: 'Tractor beams drag each target (up to Aurora size) as far as 160 units back up the channel, and rounds deal 3 damage, pierce 3 meteors and fire 25% faster.',
          apply(s) {
            const w = gun(s); w.damage += 2; w.pierce += 1; w.cooldown *= 0.8;
            const b = bay(s);
            b.look = 'tractor'; b.droneColor = '#7dffb0';
            b.tow = { speed: 220, cap: 160, maxMass: 50, ships: false, shipSpeed: 0, shipCap: 0, shipSlow: 1, titanSlow: 1 };
          } },
        { name: 'Heavy Tractors', cost: 9900, desc: 'Two more drones join, rounds deal 6 damage, and tractors drag any meteor 240 units back and hold ships (not Storm Titans) at 60% speed while hauling them 150 units back.',
          apply(s) {
            const a = main(s), w = gun(s), t = bay(s).tow;
            a.count += 2; w.damage += 3;
            t.speed = 280; t.cap = 240; t.maxMass = Infinity; t.ships = true; t.shipSpeed = 45; t.shipCap = 150; t.shipSlow = 0.6; t.titanSlow = 1;
          } },
        { name: 'Gravity Hauler', cost: 32000, desc: 'The haulers get 10-damage rounds that pierce 5 meteors and fire 3 times as fast, hold ships at 40% speed, drag each one up to 600 units back up the channel and slow Storm Titans by 30%.',
          apply(s) {
            const a = main(s), w = gun(s), t = bay(s).tow;
            w.damage += 4; w.pierce += 2; w.cooldown /= 3;
            t.shipSpeed = 120; t.shipCap = 600; t.shipSlow = 0.4; t.titanSlow = 0.7;
            bay(s).droneColor = '#b6ffd0';
          } },
      ],
    },
  ],
};
