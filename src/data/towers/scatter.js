// Scatter Pod: short-range radial KINETIC shards. Pure data plus two small custom behaviors
// (the orbiting blade ring and the Solar Flare burn stoker) that only use the Sim helpers.
// Prices follow docs/ECONOMY.md 2.4 for base b = 280:
//   T1 112..336, T2 224..700, T3 560..2240, T4 2240..8400, T5 11200..42000.

const TAU = Math.PI * 2;
const main = (s) => s.attacks.main;

const SHARD = '#c6a8ff';
const BLADE = '#b98cff';
const CRYSTAL = '#4fe6ff';
const FIRE = '#ff8a3d';

// Shards fly just past the pod's range (they launch from the rim, about 15 units out).
function fit(a, s) {
  a.lifetime = Math.max(0.08, (s.range - 4) / a.speed);
}

// Walk the split chain so splinters share the parent's on-hit effects and bypasses.
function syncSplits(a) {
  let sp = a.split;
  while (sp && sp.attack) {
    const c = sp.attack;
    c.onHit = a.onHit || null;
    c.bypass = (a.bypass || []).slice();
    if (a.detection) c.detection = true;
    sp = c.split;
  }
}

function splinter(damage, speed, lifetime, extra = {}) {
  return {
    kind: 'projectile', damage, pierce: 1, speed, lifetime, projRadius: 4, scale: 0.8,
    visual: 'shard', color: CRYSTAL, ...extra,
  };
}

// Custom behaviors run while anything is on the field. In real play that is exactly the wave
// phase (the field is always empty in the build phase, so saves never hold blade projectiles);
// tools/bench.mjs spawns enemies without launching a wave, which this also covers.
function fieldLive(sim) { return sim.state.phase === 'wave' || sim.state.enemies.length > 0; }

// ---------------------------------------------------------------- blade ring (path A)
// Blades are real projectiles that the pod steers around itself every tick (towers update
// before projectiles move, so each blade sweeps a chord of its orbit and collides normally).
// A blade is re-spawned once per revolution, which resets its hit list and the immunity that
// children of meteors it broke have against it. Each blade cuts at most `cuts` targets per
// revolution; after that it goes dull (dimmer and harmless) until it re-sharpens on the next
// revolution. State lives under a '_field_' key so the engine clears it when a wave ends.
const DULL_SRC = { tower: null, attackKey: 'blades', dtype: 'KINETIC', bypass: null, shipDamage: 0, bonus: null, crit: null };
function stormGrow(t, now) {
  const m = t.data._field_mael;
  if (!m || now >= m.until) return 0;
  const up = Math.min(1, (now - m.t0) / 0.5);
  const down = Math.min(1, (m.until - now) / 0.6);
  const g = Math.min(up, down);
  return g * g * (3 - 2 * g);
}

// Ring r: radius at storm growth g, and angular speed (rad/s). Ring 1 counter-rotates.
function ringRadius(a, r, g) {
  const base = r === 1 ? a.orbit2 : a.orbit;
  return base + (a.stormOrbit - base) * g * (r === 1 ? 1 : 0.85);
}
function ringSpin(a, r) {
  const rate = a.cooldown > 0 ? 1 / a.cooldown : 1;
  return a.spin * rate * (r === 1 ? -0.8 : 1);
}

function updateBlades(sim, t, a, dt) {
  if (!fieldLive(sim)) return;
  const n = Math.max(0, a.blades | 0);
  const rings = Math.max(1, a.rings | 0);
  let st = t.data._field_blades;
  if (!st || st.list.length !== n || st.th.length !== rings) {
    if (st) for (const b of st.list) if (b.p && b.p.id === b.id && !b.p.dead) b.p.dead = true;
    st = t.data._field_blades = { list: [], th: [] };
    for (let r = 0; r < rings; r++) st.th.push(r * 0.5);
    for (let i = 0; i < n; i++) st.list.push({ p: null, id: -1, rev: 0, base: 0, dull: false });
  }
  const now = sim.state.time;
  const g0 = stormGrow(t, now), g1 = stormGrow(t, now + dt);
  const perRing = Math.ceil(n / rings);
  for (let i = 0; i < n; i++) {
    const r = i % rings, k = Math.floor(i / rings);
    const w = ringSpin(a, r);
    const th0 = st.th[r] + (TAU * k) / perRing;
    const th1 = th0 + w * dt;
    const R0 = ringRadius(a, r, g0), R1 = ringRadius(a, r, g1);
    const x0 = t.x + Math.cos(th0) * R0, y0 = t.y + Math.sin(th0) * R0;
    const x1 = t.x + Math.cos(th1) * R1, y1 = t.y + Math.sin(th1) * R1;
    const rev = Math.floor(th0 / TAU);
    const b = st.list[i];
    let p = b.p;
    const alive = p && p.id === b.id && !p.dead;
    if (!alive || b.rev !== rev) {
      const np = sim.spawnProjectile({
        tower: t, attackKey: a.key, x: x0, y: y0, angle: 0, speed: 1,
        damage: a.damage, pierce: 1e9, dtype: a.dtype, bypass: a.bypass, shipDamage: a.shipDamage,
        onHit: a.onHit || null, lifetime: 0.2, projRadius: a.bladeRadius, scale: a.scale || 0.8,
        visual: a.visual || 'blade', color: a.color || BLADE,
      });
      if (alive) {
        // Carry over targets still touching the blade so the hand-over never double hits.
        for (const id of p.hit) {
          const e = sim.getEnemy(id);
          if (!e || e.dead) continue;
          const dx = e.x - x0, dy = e.y - y0, rr = a.bladeRadius + e.radius + 6;
          if (dx * dx + dy * dy <= rr * rr) np.hit.push(id);
        }
        p.dead = true;
      }
      p = np; b.p = np; b.id = np.id; b.rev = rev; b.base = np.hit.length; b.dull = false;
    } else if (!b.dull && p.hit.length - b.base >= a.cuts) {
      b.dull = true;
      p.damage = 0; p.onHit = null; p.src = DULL_SRC; p.color = a.dullColor || '#6d6488';
    }
    p.x = x0; p.y = y0;
    p.vx = (x1 - x0) / dt; p.vy = (y1 - y0) / dt;
    p.speed = Math.hypot(p.vx, p.vy);
    p.angle = Math.atan2(p.vy, p.vx);
    p.life = 0.2;
  }
  for (let r = 0; r < rings; r++) st.th[r] += ringSpin(a, r) * dt;
}

const maelstrom = {
  id: 'maelstrom',
  name: 'Maelstrom',
  icon: 'maelstrom',
  cooldown: 45,
  duration: 6,
  desc: 'The blade ring flies out to 210 units and the pod attacks twice as fast for 6 s.',
  activate(sim, tower) {
    const now = sim.state.time;
    tower.data._field_mael = { t0: now, until: now + 6 };
    sim.addTempBuff(tower, { rateMult: 2 }, 6);
    sim.emit({ t: 'abilityFx', id: 'maelstrom', x: tower.x, y: tower.y, r: 210 });
  },
};

// ---------------------------------------------------------------- Solar Flare burn stacks (path B)
// Every 0.5 s, burns this pod started on targets inside its ring grow by `step` up to `cap`.
function updateStoke(sim, t, a, dt) {
  if (!fieldLive(sim)) return;
  let st = t.data._field_stoke;
  if (!st) st = t.data._field_stoke = { acc: 0 };
  st.acc += dt;
  if (st.acc < 0.5) return;
  st.acc -= 0.5;
  const r = t.stats.attacks.main ? t.stats.attacks.main.radius : t.stats.range;
  const list = sim.enemiesInRange(t.x, t.y, r);
  for (let i = 0; i < list.length; i++) {
    const burns = list[i].burn;
    if (!burns) continue;
    for (let k = 0; k < burns.length; k++) {
      const b = burns[k];
      if (b.towerId !== t.id) continue;
      b.dps = Math.min(a.cap, b.dps + a.step);
      if (b.t < 3) b.t = 3;
    }
  }
}

export default {
  id: 'scatter',
  name: 'Scatter Pod',
  hotkey: 'w',
  cost: 280,
  radius: 22,
  blurb: 'Sprays 8 shards in every direction at close range.',
  desc: 'A short-range pod that bursts KINETIC shards in all directions whenever a meteor comes close. Cannot hurt Iron or frozen meteors until upgraded.',
  art: {
    sprite: 'tower_scatter', rotates: false, color: '#8f5bff', accent: '#c6a8ff', shape: 'oct', barrels: 8,
    variant(levels) { return levels[0] >= 3 ? 1 : levels[1] >= 3 ? 2 : levels[2] >= 3 ? 3 : 0; },
  },
  base: {
    range: 110,
    detection: false,
    targetModes: ['first', 'last', 'strong', 'close'],
    attacks: {
      main: {
        kind: 'projectile', radial: true, count: 8, cooldown: 1.2, damage: 1, pierce: 1, dtype: 'KINETIC',
        speed: 620, projRadius: 6, lifetime: 106 / 620, visual: 'shard', color: SHARD,
      },
    },
    aura: null,
    income: null,
    abilities: [],
  },
  paths: [
    {
      name: 'Blade Ring',
      upgrades: [
        { name: 'Spin Up', cost: 160, desc: 'Fires 25% faster.',
          apply(s) { main(s).cooldown *= 0.8; } },
        { name: 'Twelve Point', cost: 300, desc: 'Fires 12 shards per volley, 10% faster.',
          apply(s) { const a = main(s); a.count += 4; a.cooldown *= 0.9; } },
        { name: 'Blade Ring', cost: 950, desc: 'Three spinning blades circle the pod and slice every meteor they touch, and shards pierce 1 more meteor.',
          apply(s) {
            const a = main(s);
            a.pierce += 1; a.visual = 'blade'; a.color = BLADE;
            s.attacks.blades = {
              kind: 'custom', needsTarget: false, dtype: 'KINETIC', damage: 1, cooldown: 1,
              blades: 3, rings: 1, orbit: 66, orbit2: 102, stormOrbit: 210, spin: 6, cuts: 4, bladeRadius: 12, scale: 0.8,
              visual: 'blade', color: BLADE, update: updateBlades,
            };
          } },
        { name: 'Razor Halo', cost: 3800, desc: 'Five blades spin 40% faster and deal 2 damage, shards pierce 1 more meteor, and blades and shards now cut frozen meteors.',
          apply(s) {
            const a = main(s), b = s.attacks.blades;
            b.blades = 5; b.spin *= 1.4; b.damage += 1; b.cuts = 6; b.bladeRadius = 13;
            b.bypass = [...(b.bypass || []), 'FROZEN'];
            a.bypass = [...(a.bypass || []), 'FROZEN'];
            a.pierce += 1;
          } },
        { name: 'Maelstrom', cost: 19500, desc: 'Ten blades in two rings deal 4 damage (10 to ships), and the pod fires 20 shards per volley 25% faster that deal 2 damage (4 to ships). Unlocks Maelstrom: the blades fly out to 210 units for 6 s.',
          apply(s) {
            const a = main(s), b = s.attacks.blades;
            b.blades = 10; b.rings = 2; b.cuts = 10; b.damage += 2; b.shipDamage = (b.shipDamage || 0) + 6; b.bladeRadius = 14; b.scale = 0.8;
            a.count += 8; a.damage += 1; a.pierce += 1; a.cooldown *= 0.8; a.shipDamage = (a.shipDamage || 0) + 2;
            s.abilities.push(maelstrom);
          } },
      ],
    },
    {
      name: 'Thermal Core',
      upgrades: [
        { name: 'Heat Sink', cost: 200, desc: 'Fires 20% faster.',
          apply(s) { main(s).cooldown *= 0.83; } },
        { name: 'Molten Shards', cost: 400, desc: 'Shards turn THERMAL: they hit Iron and frozen meteors and burn 1 damage per second for 1.5 s, but cannot hurt Prism.',
          apply(s) {
            const a = main(s);
            a.dtype = 'THERMAL'; a.color = FIRE; a.visual = 'ember';
            a.onHit = { ...(a.onHit || {}), burn: { dps: 1, t: 1.5 } };
          } },
        { name: 'Ring of Fire', cost: 1700, desc: 'Fires a THERMAL ring of fire that hits up to 20 meteors in range for 1 damage and burns them, including Iron and frozen ones (never Prism).',
          apply(s) {
            const a = main(s);
            a.kind = 'pulse'; a.dtype = 'THERMAL'; a.damage = 1; a.pierce = 20;
            a.color = FIRE; a.visual = 'flame';
            a.onHit = { ...(a.onHit || {}), burn: { dps: 1, t: 1.5 } };
            delete a.radial; delete a.count; delete a.split; delete a.splitOn; delete a.lifetime;
          } },
        { name: 'Inferno Core', cost: 4600, desc: 'The ring pulses 15% faster, reaches 25 units farther and hits up to 40 meteors for 2 damage (12 to ships), burning 2 per second.',
          apply(s) {
            const a = main(s);
            s.range += 25; a.damage += 1; a.pierce = 40; a.shipDamage = (a.shipDamage || 0) + 10;
            a.cooldown *= 0.85; a.color = '#ff6a2a';
            a.onHit = { ...(a.onHit || {}), burn: { dps: 2, t: 2.5 } };
          } },
        { name: 'Solar Flare', cost: 23000, desc: 'Solar flares 45 units wider pulse 70% faster, hit up to 120 targets for 6 damage (250 to ships) and burn 6 per second, stacking up to 30 on anything that stays inside.',
          apply(s) {
            const a = main(s);
            s.range += 45; a.damage += 4; a.pierce = 120; a.shipDamage = (a.shipDamage || 0) + 234;
            a.cooldown /= 1.7; a.color = '#ffd76a';
            a.onHit = { ...(a.onHit || {}), burn: { dps: 6, t: 3 } };
            s.attacks.stoke = { kind: 'custom', needsTarget: false, dtype: 'THERMAL', damage: 0, step: 3, cap: 30, update: updateStoke };
          } },
      ],
    },
    {
      name: 'Cluster Shards',
      upgrades: [
        { name: 'Long Shards', cost: 140, desc: 'Range +25 and shards fly 20% faster.',
          apply(s) { const a = main(s); s.range += 25; a.speed *= 1.2; fit(a, s); } },
        { name: 'Splinters', cost: 440, desc: 'Range +10, and each shard bursts into 2 splinters when it hits or reaches the end of its flight.',
          apply(s) {
            const a = main(s);
            s.range += 10;
            if (a.kind === 'projectile') {
              fit(a, s);
              a.split = { count: 2, spread: TAU, attack: splinter(1, 480, 0.1) };
              a.splitOn = 'both';
              syncSplits(a);
            }
          } },
        { name: 'Cluster Shards', cost: 1400, desc: 'Range +15, and heavy crystals pierce 2 meteors and burst into 3 splinters on every hit and at the end of their flight.',
          apply(s) {
            const a = main(s);
            s.range += 15; a.pierce += 1; a.projRadius = 8; a.scale = 1.25; a.visual = 'crystal'; a.color = CRYSTAL;
            a.split.count = 3; a.splitOn = 'both';
            fit(a, s); syncSplits(a);
          } },
        { name: 'Fracture Web', cost: 3800, desc: 'Crystals and splinters deal 2 damage, splinters that hit a meteor break into 2 more shards, and the pod gains detection.',
          apply(s) {
            const a = main(s);
            s.detection = true;
            a.damage += 1;
            const sp = a.split.attack;
            sp.damage += 1;
            sp.split = { count: 2, spread: TAU, attack: splinter(1, 440, 0.1) };
            sp.splitOn = 'hit';
            syncSplits(a);
          } },
        { name: 'Shatterstorm', cost: 19000, desc: 'Fires 4 more crystals twice as fast with 15 more range, and every shard deals 3 damage (8 to ships) and splits three generations deep.',
          apply(s) {
            const a = main(s);
            s.range += 15;
            a.count += 4; a.cooldown *= 0.5; a.damage += 1; a.shipDamage = (a.shipDamage || 0) + 5;
            a.scale = 1.4; a.color = '#3fd8ff';
            a.split.count = 4;
            const g1 = a.split.attack;
            g1.damage += 1; g1.shipDamage = (g1.shipDamage || 0) + 5;
            const g2 = g1.split.attack;
            g2.damage += 2; g2.shipDamage = (g2.shipDamage || 0) + 5;
            g2.split = { count: 2, spread: TAU, attack: splinter(3, 400, 0.09, { shipDamage: 5 }) };
            g2.splitOn = 'hit';
            fit(a, s); syncSplits(a);
          } },
      ],
    },
  ],
};
