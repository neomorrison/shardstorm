// Missile Pod: BLAST splash. Pure data.
// Prices follow docs/ECONOMY.md 2.4 for base b = 460:
//   T1 184..552, T2 368..1150, T3 920..3680, T4 3680..13800, T5 18400..69000.

const main = (s) => s.attacks.main;

const carpetBarrage = {
  id: 'carpet',
  name: 'Carpet Barrage',
  icon: 'carpet',
  cooldown: 55,
  duration: 2,
  desc: '40 heavy explosions sweep the channel from the Core outward, each dealing 20 BLAST damage (80 to ships) to up to 40 enemies within 75 units.',
  activate(sim, tower) {
    const lanes = sim.paths.length;
    const per = Math.max(8, Math.round(40 / lanes));
    const src = { tower, attackKey: 'carpet', dtype: 'BLAST' };
    for (let lane = 0; lane < lanes; lane++) {
      const L = sim.pathLength(lane);
      for (let k = 0; k < per; k++) {
        const d = L * (0.97 - (0.85 * k) / (per - 1));
        const p = sim.pathPoint(lane, d);
        sim.after(k * 0.045, (s) => {
          if (s.getTower(tower.id) !== tower) return; // pod sold mid-barrage
          s.explode(p.x, p.y, { radius: 75, damage: 20, pierce: 40, dtype: 'BLAST', shipDamage: 60, visual: 'carpet' }, src);
        });
      }
    }
  },
};

export default {
  id: 'missile',
  name: 'Missile Pod',
  hotkey: 'r',
  cost: 460,
  radius: 24,
  blurb: 'Missiles that explode on impact.',
  desc: 'Launches BLAST missiles that shatter groups of meteors. Cannot hurt Magma meteors or Geodes.',
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
        { name: 'Wide Blast', cost: 220, desc: 'Explosions are 33% wider.',
          apply(s) { main(s).splash.radius += 14; } },
        { name: 'Dense Payload', cost: 480, desc: 'Explosions deal 2 damage and hit up to 22 meteors.',
          apply(s) { const sp = main(s).splash; sp.damage += 1; sp.pierce += 8; } },
        { name: 'Siege Warhead', cost: 1300, desc: 'Range +20, and warheads fire 25% faster and deal 4 damage in a bigger blast that stuns meteors for 0.35 s.',
          apply(s) {
            const a = main(s), sp = a.splash;
            a.cooldown *= 0.8; sp.damage += 2; sp.radius += 20; sp.onHit = { ...(sp.onHit || {}), stun: { t: 0.35, shipT: 0 } };
            s.range += 20; a.visual = 'warhead';
          } },
        { name: 'Thermobaric', cost: 4500, desc: 'Thermobaric warheads fire 50% faster and deal 10 damage (20 to ships) to up to 42 meteors across a huge radius.',
          apply(s) {
            const a = main(s), sp = a.splash;
            a.cooldown /= 1.5; sp.damage += 6; sp.radius += 24; sp.pierce += 20; sp.shipDamage = (sp.shipDamage || 0) + 10;
            sp.visual = 'thermobaric'; a.color = '#ff6b3d';
          } },
        { name: 'Nova Warhead', cost: 18500, desc: 'Nova warheads fire 25% faster and deal 40 damage (90 to ships) to up to 102 targets in a massive blast that stuns meteors for 1 s and ships for 0.4 s.',
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
        { name: 'Quick Loader', cost: 200, desc: 'Reloads 30% faster.',
          apply(s) { main(s).cooldown /= 1.3; } },
        { name: 'Bomblets', cost: 600, desc: 'Each missile scatters 4 bomblets that explode on their own.',
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
        { name: 'Cluster Swarm', cost: 1800, desc: 'Scatters 8 bomblets that deal 2 damage each.',
          apply(s) { const sp = main(s).split; sp.count = 8; sp.attack.splash.damage += 1; } },
        { name: 'Saturation Pods', cost: 4200, desc: 'Fires 3 guided cluster missiles per volley, 40% faster.',
          apply(s) { const a = main(s); a.count = 3; a.spread = 0.45; a.cooldown /= 1.4; a.homing = Math.max(a.homing || 0, 4); a.lifetime *= 1.4; a.visual = 'cluster'; } },
        { name: 'Carpet Barrage', cost: 24000, desc: 'Fires 5 missiles per volley 40% faster, each with 12 bomblets, and every blast deals 2 more damage. Unlocks Carpet Barrage: 40 heavy explosions sweep the channel for 20 damage each (80 to ships).',
          apply(s) {
            const a = main(s);
            a.cooldown /= 1.4; a.count = 5; a.spread = 0.8; a.split.count = 12; a.split.attack.splash.damage += 2; a.splash.damage += 2;
            a.color = '#ffd23d';
            s.abilities.push(carpetBarrage);
          } },
      ],
    },
    {
      name: 'Hunter-Killer',
      upgrades: [
        { name: 'Seeker Heads', cost: 220, desc: 'Range +15, and missiles home in on their targets.',
          apply(s) { const a = main(s); a.homing = 5; a.lifetime *= 1.6; s.range += 15; } },
        { name: 'Target Painter', cost: 400, desc: 'Detection: can target Phantom meteors, and explosions deal 1 more damage.',
          apply(s) { s.detection = true; main(s).splash.damage += 1; } },
        { name: 'Ship Buster', cost: 1500, desc: 'Missiles hit their target for 2 damage, plus 30 more to ships.',
          apply(s) { const a = main(s); a.damage += 2; a.shipDamage = (a.shipDamage || 0) + 30; a.speed += 150; a.visual = 'seeker'; } },
        { name: 'Hull Ripper', cost: 7000, desc: 'Missiles deal 100 extra damage to ships, stun them for 0.4 s and reload 33% faster.',
          apply(s) {
            const a = main(s);
            a.shipDamage = (a.shipDamage || 0) + 70; a.onHit = { ...(a.onHit || {}), stun: { t: 0, shipT: 0.4 } };
            a.cooldown *= 0.75; a.speed += 250; a.color = '#ff5d73';
          } },
        { name: 'Titan Breaker', cost: 40000, desc: 'Twin missiles each hit for 20 damage, 500 to ships and 1,000 to Storm Titans, stunning ships for 1 s.',
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
