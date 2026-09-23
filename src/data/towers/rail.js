// Rail Sniper: global-range hitscan, slow heavy KINETIC slugs. Pure data.
// Prices follow docs/ECONOMY.md 2.4 for base b = 350:
//   T1 140..420, T2 280..875, T3 700..2800, T4 2800..10500, T5 14000..52500.
// Supply drops (path C T4+) pay stats.income.supply at wave clear, scaled by c(w) (ECONOMY 1.3):
// a fixed number of crates per wave, so rail income stays bounded and modest.

const main = (s) => s.attacks.main;
const addBypass = (a, ...types) => {
  const b = a.bypass ? a.bypass.slice() : [];
  for (const t of types) if (b.indexOf(t) < 0) b.push(t);
  a.bypass = b;
};

const SLUG = '#ffd166';

export default {
  id: 'rail',
  name: 'Rail Sniper',
  hotkey: 'e',
  cost: 350,
  radius: 22,
  blurb: 'Hits any target on the map with heavy slugs.',
  desc: 'A long-barrel railgun with global range that fires slow, heavy KINETIC slugs. Cannot hurt Iron or frozen meteors until upgraded.',
  art: {
    sprite: 'tower_rail', rotates: true, color: '#2c3a66', accent: '#ffcc33', shape: 'square', barrels: 1,
    variant(levels) { return levels[0] >= 3 ? 1 : levels[1] >= 3 ? 2 : levels[2] >= 3 ? 3 : 0; },
  },
  base: {
    range: Infinity,
    detection: false,
    targetModes: ['first', 'last', 'strong', 'close'],
    attacks: {
      main: { kind: 'hitscan', cooldown: 1.6, damage: 5, pierce: 1, dtype: 'KINETIC', visual: 'rail', color: SLUG },
    },
    aura: null,
    income: null,
    abilities: [],
  },
  paths: [
    {
      name: 'Penetrator',
      upgrades: [
        { name: 'Heavy Slugs', cost: 250, desc: 'Slugs deal 4 more damage.',
          apply(s) { main(s).damage += 4; } },
        { name: 'AP Rounds', cost: 380, desc: 'Armor-piercing slugs deal 6 more damage and can hit Iron meteors and frozen targets.',
          apply(s) { const a = main(s); a.damage += 6; addBypass(a, 'iron', 'FROZEN'); } },
        { name: 'Hull Breaker', cost: 1800, desc: 'Slugs deal 20 damage (50 to ships) and punch through 3 meteors in a line (a ship stops the slug).',
          apply(s) {
            const a = main(s);
            a.damage += 5; a.shipDamage = (a.shipDamage || 0) + 30;
            a.line = true; a.pierce = Math.max(a.pierce, 3); a.visual = 'railslug';
          } },
        { name: 'Siege Rail', cost: 8600, desc: 'Slugs deal 36 damage (150 to ships) and punch through 5 meteors in a line (a ship stops the slug).',
          apply(s) {
            const a = main(s);
            a.damage += 16; a.shipDamage = (a.shipDamage || 0) + 84; a.pierce = Math.max(a.pierce, 5);
          } },
        { name: 'Planet Cracker', cost: 32000, desc: 'Slugs deal 150 damage (1300 to ships), punch through 10 meteors (a ship stops the slug), hit every meteor type including Specters, and crack the ground in a 60 unit shockwave.',
          apply(s) {
            const a = main(s);
            a.damage += 114; a.shipDamage = (a.shipDamage || 0) + 1036; a.pierce = Math.max(a.pierce, 10);
            addBypass(a, 'KINETIC', 'FROZEN');
            a.splash = { radius: 60, damage: 12, pierce: 30, dtype: 'KINETIC', shipDamage: 60, visual: 'cracker', color: '#ffe08a' };
            a.visual = 'railslug'; a.color = '#fff3b0';
          } },
      ],
    },
    {
      name: 'Suppression',
      upgrades: [
        { name: 'Night Scope', cost: 200, desc: 'Detection: can target Phantom meteors, and slugs deal 3 more damage.',
          apply(s) { s.detection = true; main(s).damage += 3; } },
        { name: 'Shrapnel Shot', cost: 450, desc: 'Slugs deal 2 more damage and each hit sprays 5 shrapnel shards that deal 2 damage to meteors behind the target.',
          apply(s) {
            const a = main(s);
            a.damage += 2;
            a.shrapnel = { count: 5, damage: 2, pierce: 1, spread: 0.9, range: 120, speed: 900, projRadius: 5, visual: 'shrapnel', color: SLUG };
          } },
        { name: 'Concussion Rounds', cost: 1100, desc: 'Fires 25% faster, slugs deal 10 more damage and stun meteors for 0.7 s, and shrapnel grows to 8 shards that deal 3 damage and pierce 2.',
          apply(s) {
            const a = main(s);
            a.cooldown *= 0.8; a.damage += 10;
            a.onHit = { ...(a.onHit || {}), stun: { t: 0.7, shipT: 0 } };
            a.shrapnel.count = 8; a.shrapnel.damage += 1; a.shrapnel.pierce = 2; a.visual = 'railshock';
          } },
        { name: 'Fracture Rounds', cost: 3600, desc: 'Fires 35% faster, slugs deal 8 more damage and stun ships for 0.25 s, shrapnel deals 6 damage, and everything hit turns brittle for 3 s, taking 3 extra damage from all sources.',
          apply(s) {
            const a = main(s);
            a.cooldown /= 1.35; a.damage += 8;
            const st = (a.onHit && a.onHit.stun) || { t: 0 };
            a.onHit = { ...(a.onHit || {}), stun: { t: st.t, shipT: 0.25 }, brittle: { add: 3, mult: 1, t: 3 } };
            a.shrapnel.damage += 3;
            a.shrapnel.onHit = { ...(a.shrapnel.onHit || {}), brittle: { add: 3, mult: 1, t: 3 } };
          } },
        { name: 'Warden', cost: 16000, desc: 'Fires 60% faster with 20 more damage, 12 shrapnel shards deal 11 damage and pierce 4, every slug and shard stuns (meteors 1.2 s, ships 0.4 s), and brittle targets take 50% more damage plus 3.',
          apply(s) {
            const a = main(s);
            a.cooldown /= 1.6; a.damage += 20;
            const br = { add: 3, mult: 1.5, t: 3 };
            a.onHit = { ...(a.onHit || {}), stun: { t: 1.2, shipT: 0.4 }, brittle: br };
            const sh = a.shrapnel;
            sh.count = 12; sh.damage += 5; sh.pierce = 4; sh.spread = 1.6; sh.range = 170;
            sh.onHit = { ...(sh.onHit || {}), stun: { t: 1.2, shipT: 0.4 }, brittle: br };
            a.color = '#9ff4ff';
          } },
      ],
    },
    {
      name: 'Logistics',
      upgrades: [
        { name: 'Fast Cycling', cost: 200, desc: 'Fires 10% faster and slugs deal 2 more damage.',
          apply(s) { const a = main(s); a.cooldown /= 1.1; a.damage += 2; } },
        { name: 'Twin Capacitors', cost: 380, desc: 'Fires 10% faster and slugs deal 3 more damage.',
          apply(s) { const a = main(s); a.cooldown /= 1.1; a.damage += 3; } },
        { name: 'Semi-Auto Rail', cost: 1800, desc: 'Semi-automatic fire: shoots 3 times as fast, and slugs deal 2 more damage.',
          apply(s) { const a = main(s); a.cooldown /= 3; a.damage += 2; a.visual = 'railauto'; } },
        { name: 'Supply Drop', cost: 5000, desc: 'Fires 40% faster with 16 more damage, and after each wave drops 2 supply crates worth 100 credits each (less after wave 50).',
          apply(s) {
            const a = main(s);
            a.cooldown /= 1.4; a.damage += 16;
            s.income = { perWave: 0, vault: null, refinery: null, supply: { drops: 2, value: 100 } };
          } },
        { name: 'Quartermaster', cost: 18000, desc: 'Fires twice as fast with 50 more damage, drops 5 crates of 150 credits after each wave, and every other Rail Sniper within 400 units fires 15% faster.',
          apply(s) {
            const a = main(s);
            a.cooldown *= 0.5; a.damage += 50; a.color = '#ffe08a';
            s.income = { perWave: 0, vault: null, refinery: null, supply: { drops: 5, value: 150 } };
            s.aura = { radius: 400, rateMult: 1.15, types: ['rail'] };
          } },
      ],
    },
  ],
};
