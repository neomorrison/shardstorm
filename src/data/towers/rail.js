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
        { name: 'Heavy Slugs', cost: 250, desc: 'Slugs deal 3 more damage.',
          apply(s) { main(s).damage += 3; } },
        { name: 'AP Rounds', cost: 380, desc: 'Armor-piercing slugs deal 3 more damage and can hit Iron meteors and frozen targets.',
          apply(s) { const a = main(s); a.damage += 3; addBypass(a, 'iron', 'FROZEN'); } },
        { name: 'Hull Breaker', cost: 1600, desc: 'Slugs deal 14 damage (50 to ships) and punch through 3 targets in a line.',
          apply(s) {
            const a = main(s);
            a.damage += 3; a.shipDamage = (a.shipDamage || 0) + 36;
            a.line = true; a.pierce = Math.max(a.pierce, 3); a.visual = 'railslug';
          } },
        { name: 'Siege Rail', cost: 6000, desc: 'Slugs deal 30 damage (220 to ships) and punch through 5 targets in a line.',
          apply(s) {
            const a = main(s);
            a.damage += 16; a.shipDamage = (a.shipDamage || 0) + 154; a.pierce = Math.max(a.pierce, 5);
          } },
        { name: 'Planet Cracker', cost: 32000, desc: 'Slugs deal 150 damage (1300 to ships), punch through 10 targets, hit every meteor type including Specters, and crack the ground in a 60 unit shockwave.',
          apply(s) {
            const a = main(s);
            a.damage += 120; a.shipDamage = (a.shipDamage || 0) + 960; a.pierce = Math.max(a.pierce, 10);
            addBypass(a, 'KINETIC', 'FROZEN');
            a.splash = { radius: 60, damage: 12, pierce: 30, dtype: 'KINETIC', shipDamage: 60, visual: 'cracker', color: '#ffe08a' };
            a.visual = 'railslug'; a.color = '#fff3b0';
          } },
      ],
    },
    {
      name: 'Suppression',
      upgrades: [
        { name: 'Night Scope', cost: 200, desc: 'Detection: can target Phantom meteors, and slugs deal 1 more damage.',
          apply(s) { s.detection = true; main(s).damage += 1; } },
        { name: 'Shrapnel Shot', cost: 450, desc: 'Slugs deal 1 more damage and each hit sprays 5 shrapnel shards that deal 1 damage to meteors behind the target.',
          apply(s) {
            const a = main(s);
            a.damage += 1;
            a.shrapnel = { count: 5, damage: 1, pierce: 1, spread: 0.9, range: 120, speed: 900, projRadius: 5, visual: 'shrapnel', color: SLUG };
          } },
        { name: 'Concussion Rounds', cost: 1400, desc: 'Fires 25% faster, slugs deal 6 more damage and stun meteors for 0.7 s, and shrapnel grows to 7 shards that deal 2 damage and pierce 2.',
          apply(s) {
            const a = main(s);
            a.cooldown *= 0.8; a.damage += 6;
            a.onHit = { ...(a.onHit || {}), stun: { t: 0.7, shipT: 0 } };
            a.shrapnel.count = 7; a.shrapnel.damage += 1; a.shrapnel.pierce = 2; a.visual = 'railshock';
          } },
        { name: 'Fracture Rounds', cost: 5200, desc: 'Fires 20% faster, slugs deal 6 more damage and stun ships for 0.25 s, shrapnel deals 3 damage, and everything hit turns brittle for 3 s, taking 2 extra damage from all sources.',
          apply(s) {
            const a = main(s);
            a.cooldown /= 1.2; a.damage += 6;
            const st = (a.onHit && a.onHit.stun) || { t: 0 };
            a.onHit = { ...(a.onHit || {}), stun: { t: st.t, shipT: 0.25 }, brittle: { add: 2, mult: 1, t: 3 } };
            a.shrapnel.damage += 1;
            a.shrapnel.onHit = { ...(a.shrapnel.onHit || {}), brittle: { add: 2, mult: 1, t: 3 } };
          } },
        { name: 'Warden', cost: 25000, desc: 'Fires 60% faster with 14 more damage, 12 shrapnel shards deal 6 damage and pierce 4, every slug and shard stuns (meteors 1.2 s, ships 0.4 s), and brittle targets take 50% more damage plus 3.',
          apply(s) {
            const a = main(s);
            a.cooldown /= 1.6; a.damage += 14;
            const br = { add: 3, mult: 1.5, t: 3 };
            a.onHit = { ...(a.onHit || {}), stun: { t: 1.2, shipT: 0.4 }, brittle: br };
            const sh = a.shrapnel;
            sh.count = 12; sh.damage += 3; sh.pierce = 4; sh.spread = 1.6; sh.range = 170;
            sh.onHit = { ...(sh.onHit || {}), stun: { t: 1.2, shipT: 0.4 }, brittle: br };
            a.color = '#9ff4ff';
          } },
      ],
    },
    {
      name: 'Logistics',
      upgrades: [
        { name: 'Fast Cycling', cost: 200, desc: 'Fires 25% faster.',
          apply(s) { main(s).cooldown *= 0.8; } },
        { name: 'Twin Capacitors', cost: 380, desc: 'Fires 30% faster and slugs deal 2 more damage.',
          apply(s) { const a = main(s); a.cooldown /= 1.3; a.damage += 2; } },
        { name: 'Semi-Auto Rail', cost: 1800, desc: 'Semi-automatic fire: shoots 3 times as fast, and slugs deal 2 more damage.',
          apply(s) { const a = main(s); a.cooldown /= 3; a.damage += 2; a.visual = 'railauto'; } },
        { name: 'Supply Drop', cost: 6500, desc: 'Fires 40% faster with 10 more damage, and after each wave drops 2 supply crates worth 100 credits each (less after wave 50).',
          apply(s) {
            const a = main(s);
            a.cooldown /= 1.4; a.damage += 10;
            s.income = { perWave: 0, vault: null, refinery: null, supply: { drops: 2, value: 100 } };
          } },
        { name: 'Quartermaster', cost: 24000, desc: 'Fires twice as fast with 30 more damage, drops 5 crates of 150 credits after each wave, and every other Rail Sniper on the map fires 30% faster.',
          apply(s) {
            const a = main(s);
            a.cooldown *= 0.5; a.damage += 30; a.color = '#ffe08a';
            s.income = { perWave: 0, vault: null, refinery: null, supply: { drops: 5, value: 150 } };
            s.aura = { radius: Infinity, rateMult: 1.3, types: ['rail'] };
          } },
      ],
    },
  ],
};
