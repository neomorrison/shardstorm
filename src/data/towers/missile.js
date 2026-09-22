// Missile Pod: BLAST splash. Pure data.
// Prices follow docs/ECONOMY.md 2.4 for base b = 500:
//   T1 200..600, T2 400..1250, T3 1000..4000, T4 4000..15000, T5 20000..75000.

const main = (s) => s.attacks.main;

const carpetBarrage = {
  id: 'carpet',
  name: 'Carpet Barrage',
  icon: 'carpet',
  cooldown: 55,
  duration: 2,
  desc: '40 heavy explosions sweep the whole channel from the Core outward.',
  activate(sim, tower) {
    const lanes = sim.paths.length;
    const per = Math.max(8, Math.round(40 / lanes));
    const src = { tower, attackKey: 'carpet', dtype: 'BLAST' };
    for (let lane = 0; lane < lanes; lane++) {
      const L = sim.pathLength(lane);
      for (let k = 0; k < per; k++) {
        const d = L * (0.97 - (0.85 * k) / (per - 1));
        const p = sim.pathPoint(lane, d);
        sim.after(k * 0.045, (s) => s.explode(p.x, p.y, { radius: 75, damage: 20, pierce: 40, dtype: 'BLAST', shipDamage: 60, visual: 'carpet' }, src));
      }
    }
  },
};

export default {
  id: 'missile',
  name: 'Missile Pod',
  hotkey: 'r',
  cost: 500,
  radius: 24,
  blurb: 'Missiles that explode on impact.',
  desc: 'Launches BLAST missiles that shatter groups of meteors. Cannot hurt Magma meteors.',
  art: {
    sprite: 'tower_missile', rotates: true, color: '#ff9f43', accent: '#e8f6ff', shape: 'square', barrels: 2,
    variant(levels) { return levels[0] >= 3 ? 1 : levels[1] >= 3 ? 2 : levels[2] >= 3 ? 3 : 0; },
  },
  base: {
    range: 170,
    detection: false,
    targetModes: ['first', 'last', 'strong', 'close'],
    attacks: {
      main: {
        kind: 'projectile', cooldown: 1.25, damage: 0, pierce: 1, dtype: 'BLAST',
        speed: 620, projRadius: 8, lifetime: 0.55, splashOnExpire: true,
        splash: { radius: 42, damage: 1, pierce: 14 },
        visual: 'missile', color: '#ff9f43',
      },
    },
    aura: null,
    income: null,
    abilities: [],
  },
  paths: [
    {
      name: 'Heavy Ordnance',
      upgrades: [
        { name: 'Wide Blast', cost: 280, desc: 'Explosions are 33% wider.',
          apply(s) { main(s).splash.radius += 14; } },
        { name: 'Dense Payload', cost: 520, desc: 'Explosions deal 2 damage and hit up to 22 meteors.',
          apply(s) { const sp = main(s).splash; sp.damage += 1; sp.pierce += 8; } },
        { name: 'Siege Warhead', cost: 1700, desc: 'Warheads deal 4 damage in a bigger blast that stuns meteors for 0.35 s.',
          apply(s) {
            const a = main(s), sp = a.splash;
            sp.damage += 2; sp.radius += 20; sp.onHit = { ...(sp.onHit || {}), stun: { t: 0.35, shipT: 0 } };
            s.range += 20; a.visual = 'warhead';
          } },
        { name: 'Thermobaric', cost: 6500, desc: 'Thermobaric blasts deal 10 damage (20 to ships) across a huge radius.',
          apply(s) {
            const a = main(s), sp = a.splash;
            sp.damage += 6; sp.radius += 24; sp.pierce += 20; sp.shipDamage = (sp.shipDamage || 0) + 10;
            sp.visual = 'thermobaric'; a.color = '#ff6b3d';
          } },
        { name: 'Nova Warhead', cost: 36000, desc: 'Nova warheads deal 40 damage (90 to ships) in a massive blast that stuns everything it touches.',
          apply(s) {
            const a = main(s), sp = a.splash;
            sp.damage += 30; sp.radius += 60; sp.pierce += 60; sp.shipDamage = (sp.shipDamage || 0) + 40;
            sp.onHit = { ...(sp.onHit || {}), stun: { t: 1, shipT: 0.4 } };
            sp.visual = 'nova'; a.cooldown *= 0.8; a.visual = 'nova'; a.color = '#fff3b0'; a.projRadius = 11;
          } },
      ],
    },
    {
      name: 'Cluster',
      upgrades: [
        { name: 'Quick Loader', cost: 300, desc: 'Reloads 25% faster.',
          apply(s) { main(s).cooldown *= 0.8; } },
        { name: 'Bomblets', cost: 700, desc: 'Each missile scatters 4 bomblets that explode on their own.',
          apply(s) {
            const a = main(s);
            a.split = {
              count: 4,
              attack: {
                kind: 'projectile', damage: 0, pierce: 1, speed: 260, lifetime: 0.28, projRadius: 6,
                splash: { radius: 26, damage: 1, pierce: 6 }, splashOnExpire: true, visual: 'bomblet', color: '#ffd23d',
              },
            };
            a.splitOn = 'both';
          } },
        { name: 'Cluster Swarm', cost: 2400, desc: 'Scatters 8 bomblets that deal 2 damage each.',
          apply(s) { const sp = main(s).split; sp.count = 8; sp.attack.splash.damage += 1; } },
        { name: 'Saturation Pods', cost: 8000, desc: 'Fires 3 cluster missiles per volley, 25% faster.',
          apply(s) { const a = main(s); a.count = 3; a.spread = 0.45; a.cooldown *= 0.8; a.visual = 'cluster'; } },
        { name: 'Carpet Barrage', cost: 32000, desc: 'Fires 5 missiles per volley with 12 bomblets each. Unlocks Carpet Barrage: 40 heavy explosions sweep the channel.',
          apply(s) {
            const a = main(s);
            a.count = 5; a.spread = 0.8; a.split.count = 12; a.split.attack.splash.damage += 2; a.splash.damage += 2;
            a.color = '#ffd23d';
            s.abilities.push(carpetBarrage);
          } },
      ],
    },
    {
      name: 'Hunter-Killer',
      upgrades: [
        { name: 'Seeker Heads', cost: 240, desc: 'Missiles home in on their targets.',
          apply(s) { const a = main(s); a.homing = 5; a.lifetime *= 1.6; s.range += 15; } },
        { name: 'Target Painter', cost: 450, desc: 'Detection: can target Phantom meteors. Range +45.',
          apply(s) { s.detection = true; s.range += 45; } },
        { name: 'Ship Buster', cost: 2200, desc: 'Missiles hit their target for 2 damage, plus 14 more to ships.',
          apply(s) { const a = main(s); a.damage += 2; a.shipDamage = (a.shipDamage || 0) + 14; a.speed += 150; a.visual = 'seeker'; } },
        { name: 'Hull Ripper', cost: 8500, desc: 'Missiles deal 100 extra damage to ships, stun them for 0.4 s and reload 33% faster.',
          apply(s) {
            const a = main(s);
            a.shipDamage = (a.shipDamage || 0) + 86; a.onHit = { ...(a.onHit || {}), stun: { t: 0, shipT: 0.4 } };
            a.cooldown *= 0.75; a.speed += 250; a.color = '#ff5d73';
          } },
        { name: 'Titan Breaker', cost: 45000, desc: 'Twin missiles each deal 500 damage to ships and 1000 to Storm Titans, stunning ships for 1 s.',
          apply(s) {
            const a = main(s);
            a.count = Math.max(2, a.count || 1); a.spread = Math.max(a.spread || 0, 0.3);
            a.damage += 18; a.shipDamage = (a.shipDamage || 0) + 380;
            a.bonus = { ...(a.bonus || {}), titan: 500 };
            a.onHit = { ...(a.onHit || {}), stun: { t: 0, shipT: 1 } };
            a.homing = 9; a.visual = 'titanbreaker'; a.color = '#ff2e63'; a.projRadius = 11;
          } },
      ],
    },
  ],
};
