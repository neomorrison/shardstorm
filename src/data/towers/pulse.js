// Pulse Turret: cheap, fast single-target KINETIC bolts. Pure data.
// Prices follow docs/ECONOMY.md 2.4 for base b = 200:
//   T1 80..240, T2 160..500, T3 400..1600, T4 1600..6000, T5 8000..30000.

const main = (s) => s.attacks.main;

const hurricane = {
  id: 'hurricane',
  name: 'Hurricane',
  icon: 'hurricane',
  cooldown: 50,
  duration: 8,
  desc: 'This turret and every Pulse Turret within 320 units fire 3 times as fast for 8 s.',
  activate(sim, tower) {
    for (const t of sim.towersNear(tower.x, tower.y, 320, ['pulse'])) sim.addTempBuff(t, { rateMult: 3 }, 8);
    sim.emit({ t: 'abilityFx', id: 'hurricane', x: tower.x, y: tower.y, r: 320 });
  },
};

export default {
  id: 'pulse',
  name: 'Pulse Turret',
  hotkey: 'q',
  cost: 200,
  radius: 20,
  blurb: 'Cheap, fast single-target bolts.',
  desc: 'A reliable turret that fires piercing KINETIC bolts. Cannot hurt Iron or frozen meteors until upgraded.',
  art: {
    sprite: 'tower_pulse', rotates: true, color: '#4cc9f0', accent: '#f9c74f', shape: 'hex', barrels: 1,
    variant(levels) { return levels[0] >= 3 ? 1 : levels[1] >= 3 ? 2 : levels[2] >= 3 ? 3 : 0; },
  },
  base: {
    range: 150,
    detection: false,
    targetModes: ['first', 'last', 'strong', 'close'],
    attacks: {
      main: {
        kind: 'projectile', cooldown: 0.95, damage: 1, pierce: 2, dtype: 'KINETIC',
        speed: 1100, projRadius: 6, lifetime: 0.3, visual: 'bolt', color: '#8ee6ff',
      },
    },
    aura: null,
    income: null,
    abilities: [],
  },
  paths: [
    {
      name: 'Penetrator',
      upgrades: [
        { name: 'Sharp Bolts', cost: 140, desc: 'Bolts pierce 1 more meteor.',
          apply(s) { main(s).pierce += 1; } },
        { name: 'Tungsten Core', cost: 240, desc: 'Bolts pierce 2 more meteors and can crack frozen targets.',
          apply(s) { const a = main(s); a.pierce += 2; a.bypass = [...(a.bypass || []), 'FROZEN']; } },
        { name: 'Lance Rounds', cost: 850, desc: 'Fires heavy lances that deal 2 damage and pierce 4 more meteors.',
          apply(s) { const a = main(s); a.damage += 1; a.pierce += 4; a.projRadius = 9; a.speed += 300; a.visual = 'lance'; } },
        { name: 'Phase Driver', cost: 3400, desc: 'Phase lances deal 4 damage (7 to ships), pierce 8 more meteors and fire 25% faster.',
          apply(s) { const a = main(s); a.damage += 2; a.pierce += 8; a.cooldown *= 0.8; a.lifetime *= 1.5; a.shipDamage = (a.shipDamage || 0) + 3; a.visual = 'phase'; a.color = '#b18cff'; } },
        { name: 'Starlance', cost: 19000, desc: 'Fires VOID starlances that hit every meteor type, deal 12 damage (35 to ships) and pierce 30 more targets.',
          apply(s) {
            const a = main(s);
            a.dtype = 'VOID'; a.damage += 8; a.pierce += 30; a.speed = 2400; a.lifetime = 0.6; a.projRadius = 14;
            a.shipDamage = (a.shipDamage || 0) + 20; a.visual = 'starlance'; a.color = '#fff3b0';
            s.range += 60;
          } },
      ],
    },
    {
      name: 'Cyclone',
      upgrades: [
        { name: 'Quick Cycle', cost: 120, desc: 'Fires 25% faster.',
          apply(s) { main(s).cooldown *= 0.8; } },
        { name: 'Twin Feed', cost: 320, desc: 'Fires 2 bolts per shot.',
          apply(s) { const a = main(s); a.count = (a.count || 1) + 1; a.spread = 0.14; } },
        { name: 'Rotary Barrel', cost: 700, desc: 'A rotary barrel fires over twice as fast, and bolts pierce 1 more meteor.',
          apply(s) { const a = main(s); a.cooldown *= 0.45; a.pierce += 1; } },
        { name: 'Storm Gatling', cost: 3800, desc: 'Fires 3 bolts per shot, 67% faster, each dealing 1 more damage and piercing 1 more meteor.',
          apply(s) { const a = main(s); a.cooldown *= 0.6; a.damage += 1; a.count = (a.count || 1) + 1; a.pierce += 1; a.spread = 0.26; a.visual = 'gatling'; } },
        { name: 'Hurricane Array', cost: 16500, desc: 'Fires 5 bolts per shot twice as fast. Unlocks Hurricane: nearby Pulse Turrets fire 3 times as fast for 8 s.',
          apply(s) {
            const a = main(s);
            a.cooldown *= 0.5; a.damage += 1; a.count = (a.count || 1) + 2; a.pierce += 2; a.spread = 0.5;
            a.visual = 'hurricane'; a.color = '#7df9ff';
            s.abilities.push(hurricane);
          } },
      ],
    },
    {
      name: 'Marksman',
      upgrades: [
        { name: 'Long Barrel', cost: 100, desc: 'Range +40 and faster bolts.',
          apply(s) { s.range += 40; main(s).speed += 300; } },
        { name: 'Target Scanner', cost: 260, desc: 'Detection: can target Phantom meteors. Range +20.',
          apply(s) { s.detection = true; s.range += 20; } },
        { name: 'Crit Optics', cost: 1150, desc: 'Bolts deal 4 damage, fire 25% faster, and 15% of hits crit for 4x.',
          apply(s) { const a = main(s); a.damage += 3; a.cooldown *= 0.8; a.crit = { chance: 0.15, mult: 4 }; s.range += 30; a.visual = 'sniper'; } },
        { name: 'Ship Hunter', cost: 4400, desc: 'Homing bolts deal 7 damage (21 to ships) and crit 25% of the time for 5x.',
          apply(s) { const a = main(s); a.damage += 3; a.shipDamage = (a.shipDamage || 0) + 14; a.crit = { chance: 0.25, mult: 5 }; a.cooldown *= 0.75; a.homing = 9; } },
        { name: 'Deadeye Prime', cost: 21000, desc: 'Bolts deal 20 damage (80 to ships), crit 30% of the time for 6x and strip Phantom from meteors they hit.',
          apply(s) {
            const a = main(s);
            a.damage += 13; a.shipDamage = (a.shipDamage || 0) + 46; a.crit = { chance: 0.3, mult: 6 };
            a.cooldown *= 0.5; a.pierce += 2; a.onHit = { ...(a.onHit || {}), strip: true };
            a.speed = 2200; a.homing = 14; a.visual = 'deadeye'; a.color = '#ff5d73';
            s.range += 80;
          } },
      ],
    },
  ],
};
