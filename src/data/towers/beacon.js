// Command Beacon: support aura, no attack of its own. Pure data.
// Prices follow docs/ECONOMY.md 2.4 for base b = 900:
//   T1 360..1080, T2 720..2250, T3 1800..7200, T4 7200..27000, T5 36000..135000.
//
// stats.aura (docs/ARCHITECTURE.md 5.4): every tower whose center is inside `radius` gets the best
// value of each field among the Beacons covering it (no stacking of the same field). Mining Rigs
// and other Beacons are never buffed (they have nothing to buff), and the engine never lets a
// Supply discount apply to a Rig or a Beacon (NO_DISCOUNT).

const aura = (s) => s.aura;
const grow = (s, r) => { s.aura.radius += r; };
const atLeast = (s, key, v) => { if (!(s.aura[key] >= v)) s.aura[key] = v; };
function addBypass(s, list) {
  const b = s.aura.bypass || (s.aura.bypass = []);
  for (const x of list) if (b.indexOf(x) < 0) b.push(x);
}

// Phase Radar (path A tier 3+): strips Phantom from meteors inside the aura, permanently, so every
// tower on the map can target them (and their children, unless a ship forces Phantom on them).
// Omniscient Array also strips Phantom ships. Runs 5 times a second as a passive custom attack,
// timed off the sim tick (saved) rather than a timer in tower.data (not saved), so a loaded
// run strips on exactly the same ticks as an uninterrupted one.
function radarUpdate(sim, t, a) {
  const au = t.stats.aura;
  if (!au) return;
  if ((sim.state.tick + t.id) % 12 !== 0 || !sim.state.enemies.length) return;
  const d = t.data;
  const list = sim.enemiesInRange(t.x, t.y, au.radius);
  let n = 0;
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (e.phantom && (a.ships || !e.ship)) { e.phantom = false; n++; }
  }
  if (n > 0 && sim.state.time - (d._radPing ?? -99) >= 1.5) {
    d._radPing = sim.state.time;
    sim.emit({ t: 'pulse', tower: t.id, type: 'beacon', x: t.x, y: t.y, r: au.radius, color: '#7dfcff', visual: 'radar' });
  }
}

function addRadar(s, ships) {
  if (!s.attacks.radar) s.attacks.radar = { kind: 'custom', needsTarget: false, dtype: 'SUPPORT', cooldown: 1, ships: false, update: radarUpdate };
  if (ships) s.attacks.radar.ships = true;
}

const warCouncil = {
  id: 'warcouncil',
  name: 'War Council',
  icon: 'warcouncil',
  cooldown: 60,
  duration: 10,
  desc: 'Every tower inside this Beacon\'s aura fires twice as fast for 10 s.',
  activate(sim, tower) {
    const r = tower.stats.aura ? tower.stats.aura.radius : 225;
    for (const t of sim.towersNear(tower.x, tower.y, r)) {
      if (t === tower || t.type === 'rig' || t.type === 'beacon') continue;
      sim.addTempBuff(t, { rateMult: 2 }, 10);
    }
    sim.emit({ t: 'abilityFx', id: 'warcouncil', x: tower.x, y: tower.y, r });
  },
};

export default {
  id: 'beacon',
  name: 'Command Beacon',
  hotkey: 'h',
  cost: 900,
  radius: 22,
  blurb: 'Towers inside its aura shoot farther and faster.',
  desc: 'Towers whose center is inside the 165 unit aura get 10% more range and attack 15% faster. Buffs from several Beacons do not stack: each tower keeps the best value of each buff.',
  art: {
    sprite: 'tower_beacon', rotates: false, color: '#3b82f6', accent: '#7dd3fc', shape: 'circle', barrels: 0,
    variant(levels) { return levels[0] >= 3 ? 1 : levels[1] >= 3 ? 2 : levels[2] >= 3 ? 3 : 0; },
  },
  base: {
    range: null,               // no attack; the aura ring shows the coverage
    detection: false,
    targetModes: ['first', 'last', 'strong', 'close'],
    attacks: {},
    aura: {
      radius: 165, rangeMult: 1.1, rateMult: 1.15, pierceAdd: 0, damageAdd: 0, shipDamageAdd: 0,
      detection: false, bypass: [], discount: 0, excludeTypes: ['rig', 'beacon'],
    },
    income: null,
    abilities: [],
  },
  paths: [
    {
      name: 'Radar',
      upgrades: [
        { name: 'Long-Range Scan', cost: 400, desc: 'Towers inside the aura get 15% more range.',
          apply(s) { atLeast(s, 'rangeMult', 1.15); } },
        { name: 'Sensor Net', cost: 800, desc: 'Towers inside the aura gain detection and can target Phantom meteors.',
          apply(s) { aura(s).detection = true; } },
        { name: 'Phase Radar', cost: 2600, desc: 'Radar pings strip Phantom from meteors inside a 230 unit aura so every tower can hit them, and towers inside get 20% more range.',
          apply(s) { grow(s, 65); atLeast(s, 'rangeMult', 1.2); addRadar(s, false); } },
        { name: 'Target Painter', cost: 9000, desc: 'The aura grows to 260 units, towers inside get 25% more range, and their hits deal 2 more damage to ships.',
          apply(s) { grow(s, 30); atLeast(s, 'rangeMult', 1.25); atLeast(s, 'shipDamageAdd', 2); } },
        { name: 'Omniscient Array', cost: 42000, desc: 'A 380 unit aura gives towers inside 40% more range and 5 more damage to ships, and strips Phantom from everything inside, Specter ships included.',
          apply(s) { grow(s, 120); atLeast(s, 'rangeMult', 1.4); atLeast(s, 'shipDamageAdd', 5); aura(s).detection = true; addRadar(s, true); } },
      ],
    },
    {
      name: 'Overclock',
      upgrades: [
        { name: 'Overclock', cost: 450, desc: 'Towers inside the aura attack 25% faster.',
          apply(s) { atLeast(s, 'rateMult', 1.25); } },
        { name: 'Coolant Loop', cost: 1000, desc: 'Towers inside the aura attack 35% faster.',
          apply(s) { atLeast(s, 'rateMult', 1.35); } },
        { name: 'Harmonic Drive', cost: 3200, desc: 'Towers inside a wider 180 unit aura attack 40% faster and their shots pierce 1 more target.',
          apply(s) { grow(s, 15); atLeast(s, 'rateMult', 1.4); atLeast(s, 'pierceAdd', 1); } },
        { name: 'Battle Protocol', cost: 11500, desc: 'Towers inside the aura attack 50% faster, pierce 1 more target and deal 1 more damage per hit.',
          apply(s) { atLeast(s, 'rateMult', 1.5); atLeast(s, 'pierceAdd', 1); atLeast(s, 'damageAdd', 1); } },
        { name: 'War Council', cost: 48000, desc: 'Towers inside a 200 unit aura attack 65% faster, pierce 2 more and deal 2 more damage, and War Council makes them fire twice as fast for 10 s.',
          apply(s) {
            grow(s, 20); atLeast(s, 'rateMult', 1.65); atLeast(s, 'pierceAdd', 2); atLeast(s, 'damageAdd', 2);
            s.abilities.push(warCouncil);
          } },
      ],
    },
    {
      name: 'Supply',
      upgrades: [
        { name: 'Supply Depot', cost: 380, desc: 'Towers bought or upgraded inside the aura cost 5% less (never Mining Rigs or Beacons).',
          apply(s) { atLeast(s, 'discount', 0.05); } },
        { name: 'Bulk Contracts', cost: 850, desc: 'Towers bought or upgraded inside the aura cost 10% less.',
          apply(s) { atLeast(s, 'discount', 0.1); } },
        { name: 'Logistics Hub', cost: 2800, desc: 'Towers bought or upgraded inside a wider 185 unit aura cost 15% less.',
          apply(s) { grow(s, 20); atLeast(s, 'discount', 0.15); } },
        { name: 'Munitions Depot', cost: 9500, desc: 'Special ammunition lets every tower inside a 200 unit aura damage Iron and Magma meteors.',
          apply(s) { grow(s, 15); addBypass(s, ['iron', 'magma']); } },
        { name: 'Command Nexus', cost: 50000, desc: 'Towers inside a 260 unit aura ignore every meteor immunity, hit frozen targets, and gain an extra 10% range, 20% attack speed, 1 pierce and 1 damage.',
          apply(s) {
            // Adds to whatever the aura already gives, so Radar and Overclock crosspaths still count.
            grow(s, 60);
            addBypass(s, ['iron', 'magma', 'comet', 'prism', 'geode', 'FROZEN']);
            const a = aura(s);
            a.rangeMult += 0.1; a.rateMult += 0.2; a.pierceAdd += 1; a.damageAdd += 1;
            atLeast(s, 'discount', 0.15); // the discount stays capped at 15%
          } },
      ],
    },
  ],
};
