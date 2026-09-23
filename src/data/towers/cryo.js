// Cryo Emitter: CRYO pulse that freezes meteors around it. Pure data.
// Frozen meteors stop and cannot be hurt by KINETIC unless an attack bypasses FROZEN; Comets and
// Geodes ignore CRYO; ships are slowed instead of frozen.
// Prices follow docs/ECONOMY.md 2.4 for base b = 450:
//   T1 180..540, T2 360..1125, T3 900..3600, T4 3600..13500, T5 18000..67500.

const main = (s) => s.attacks.main;
const ICE = '#bff4ff';

function freezeOf(a) {
  if (!a.onHit) a.onHit = {};
  if (!a.onHit.freeze) a.onHit.freeze = { t: 1.3 };
  return a.onHit.freeze;
}
// Replace the on-hit object so upgrades never mutate a shared reference.
function setHit(a, patch) { a.onHit = { ...(a.onHit || {}), ...patch }; }

const absoluteZero = {
  id: 'absolutezero',
  name: 'Absolute Zero',
  icon: 'absolutezero',
  cooldown: 60,
  duration: 5,
  desc: 'Freezes every meteor on the map for 5 s, slows ships to 25% (Storm Titans to 50%) and makes Cryo Emitters pulse 50% faster.',
  activate(sim, tower) {
    const src = { tower, attackKey: 'absolutezero', dtype: 'CRYO' };
    const fx = { freeze: { t: 5, shipMult: 0.25 }, slow: { mult: 0.6, shipMult: 0.25, t: 7 } };
    const titanFx = { slow: { shipMult: 0.5, titanMult: 0.5, t: 5 } };
    for (const e of sim.enemiesInRange(0, 0, Infinity)) {
      if (e.def.immune.indexOf('CRYO') >= 0) continue; // Comets and Geodes shrug it off
      sim.applyEffects(e, e.titan ? titanFx : fx, src);
    }
    for (const t of sim.towersNear(tower.x, tower.y, Infinity, ['cryo'])) sim.addTempBuff(t, { rateMult: 1.5 }, 5);
    sim.emit({ t: 'abilityFx', id: 'absolutezero', x: tower.x, y: tower.y, r: 420 });
    // A frost front races down every channel.
    for (let lane = 0; lane < sim.paths.length; lane++) {
      const L = sim.pathLength(lane);
      const n = Math.max(6, Math.round(L / 220));
      for (let k = 0; k < n; k++) {
        const p = sim.pathPoint(lane, (L * (k + 0.5)) / n);
        sim.after(k * 0.035, (s) => s.emit({ t: 'freeze', x: p.x, y: p.y, r: 110 }));
      }
    }
  },
};

export default {
  id: 'cryo',
  name: 'Cryo Emitter',
  hotkey: 't',
  cost: 450,
  radius: 22,
  blurb: 'Pulses cold that freezes nearby meteors in place.',
  desc: 'Emits a CRYO pulse that chips up to 20 nearby meteors and freezes them solid. Frozen meteors cannot be hurt by KINETIC attacks, Comets and Geodes ignore the cold, and ships are only slowed.',
  art: {
    sprite: 'tower_cryo', rotates: false, color: '#5fc8ff', accent: '#e8fbff', shape: 'circle', barrels: 6,
    variant(levels) { return levels[0] >= 3 ? 1 : levels[1] >= 3 ? 2 : levels[2] >= 3 ? 3 : 0; },
  },
  base: {
    range: 100,
    detection: false,
    targetModes: ['first', 'last', 'strong', 'close'],
    attacks: {
      main: {
        kind: 'pulse', cooldown: 2.4, damage: 1, pierce: 20, dtype: 'CRYO',
        onHit: { freeze: { t: 1.3 } }, visual: 'frost', color: ICE,
      },
    },
    aura: null,
    income: null,
    abilities: [],
  },
  paths: [
    {
      name: 'Deep Freeze',
      upgrades: [
        { name: 'Deep Chill', cost: 220, desc: 'Freezes last 0.6 s longer.',
          apply(s) { const a = main(s); setHit(a, { freeze: { ...freezeOf(a), t: freezeOf(a).t + 0.6 } }); } },
        { name: 'Wide Emitter', cost: 420, desc: 'Pulse radius +25, and each pulse freezes up to 15 more meteors.',
          apply(s) { s.range += 25; const a = main(s); if (a.kind === 'pulse') a.pierce += 15; } },
        { name: 'Permafrost', cost: 1500, desc: 'Pulses fire 15% faster, and thawed meteors stay slowed to 50% for 2.5 s (ships slowed to 50% as well).',
          apply(s) {
            const a = main(s);
            a.cooldown *= 0.87; a.color = '#9fe3ff';
            const fr = freezeOf(a);
            setHit(a, { freeze: { ...fr, shipMult: 0.5 }, slow: { mult: 0.5, shipMult: 0.5, t: fr.t + 2.5 } });
          } },
        { name: 'Glacial Core', cost: 5200, desc: 'Pulse radius +30, freezes last 0.8 s longer, each pulse freezes up to 20 more meteors, and ships are slowed to 40%.',
          apply(s) {
            const a = main(s);
            s.range += 30; a.pierce += 20;
            const fr = freezeOf(a);
            const t = fr.t + 0.8;
            setHit(a, { freeze: { ...fr, t, shipMult: 0.4 }, slow: { mult: 0.5, shipMult: 0.4, t: t + 2.5 } });
            a.color = '#86d8ff';
          } },
        { name: 'Absolute Zero', cost: 26000, desc: 'Pulses reach 45 units farther, fire 25% faster, freeze up to 100 meteors for 1 s longer and slow ships to 30%. Unlocks Absolute Zero: freezes every meteor on the map for 5 s.',
          apply(s) {
            const a = main(s);
            s.range += 45; a.pierce = Math.max(a.pierce + 35, 100); a.cooldown *= 0.8;
            const fr = freezeOf(a);
            const t = fr.t + 1;
            setHit(a, { freeze: { ...fr, t, shipMult: 0.3 }, slow: { mult: 0.45, shipMult: 0.3, t: t + 3 } });
            a.color = '#e8fbff';
            s.abilities.push(absoluteZero);
          } },
      ],
    },
    {
      name: 'Embrittle',
      upgrades: [
        { name: 'Brittle Frost', cost: 300, desc: 'Everything the pulse hits turns brittle for 1.5 s, taking 1 extra damage from every hit.',
          apply(s) { const a = main(s); setHit(a, { brittle: { add: 1, mult: 1, t: 1.5 } }); } },
        { name: 'Deep Cracks', cost: 550, desc: 'Pulses fire 15% faster and brittleness lasts 3 s.',
          apply(s) { const a = main(s); a.cooldown *= 0.87; setHit(a, { brittle: { ...a.onHit.brittle, t: 3 } }); } },
        { name: 'Shatter Field', cost: 1900, desc: 'Towers within 160 units can hit frozen meteors with KINETIC attacks, and brittle targets take 2 extra damage per hit.',
          apply(s) {
            const a = main(s);
            setHit(a, { brittle: { ...a.onHit.brittle, add: 2 } });
            s.aura = { radius: 160, bypass: ['FROZEN'], excludeTypes: ['rig', 'beacon'] };
            a.color = '#c9f3ff';
          } },
        { name: 'Cold Fracture', cost: 5500, desc: 'Pulses deal 1 more damage, brittle targets take 50% more damage plus 2, and the shatter field reaches 190 units.',
          apply(s) {
            const a = main(s);
            a.damage += 1;
            setHit(a, { brittle: { ...a.onHit.brittle, add: 2, mult: 1.5 } });
            s.aura.radius = 190;
          } },
        { name: 'Glass Storm', cost: 28000, desc: 'Pulses fire 60% faster and deal 3 more damage to up to 100 meteors, each pulse bursts 20 KINETIC glass shards that cut frozen meteors (3 damage, pierce 5), brittle targets take double damage plus 3, and the shatter field reaches 230 units.',
          apply(s) {
            const a = main(s);
            a.cooldown /= 1.6; a.damage += 3; a.pierce = Math.max(a.pierce, 100); a.color = '#f2fdff';
            const br = { ...a.onHit.brittle, add: 3, mult: 2 };
            setHit(a, { brittle: br });
            s.aura.radius = 230;
            s.attacks.glass = {
              kind: 'projectile', radial: true, count: 20, cooldown: a.cooldown, damage: 3, pierce: 5, dtype: 'KINETIC', bypass: ['FROZEN'],
              speed: 560, projRadius: 6, scale: 1.2, lifetime: (s.range + 10) / 560,
              onHit: { brittle: br }, visual: 'shard', color: '#e8fbff',
            };
          } },
      ],
    },
    {
      name: 'Cryo Lance',
      upgrades: [
        { name: 'Cold Focus', cost: 250, desc: 'Pulse radius +20 and freezes last 0.3 s longer.',
          apply(s) { s.range += 20; const a = main(s); setHit(a, { freeze: { ...freezeOf(a), t: freezeOf(a).t + 0.3 } }); } },
        { name: 'Hard Frost', cost: 450, desc: 'Pulses deal 1 more damage and slow ships to 50%.',
          apply(s) { const a = main(s); a.damage += 1; setHit(a, { freeze: { ...freezeOf(a), shipMult: 0.5 } }); } },
        { name: 'Cryo Lance', cost: 1400, desc: 'Range +60, and icy lances replace the pulse, firing 3.5 times as often: each deals 2 more damage, pierces 6 meteors, freezes them and slows ships to 50% for 2 s.',
          apply(s) {
            const a = main(s);
            const fr = freezeOf(a);
            s.range += 60;
            a.kind = 'projectile'; a.cooldown /= 3.5; a.damage += 2; a.pierce = 6;
            a.speed = 820; a.projRadius = 7; a.scale = 1.3; a.visual = 'cryo'; a.color = '#9be7ff';
            setHit(a, { freeze: { t: Math.max(0.8, fr.t - 0.2), shipMult: 0.5 }, slow: { shipMult: 0.5, t: 2 } });
            delete a.radius; delete a.lifetime;
          } },
        { name: 'Glacier Lance', cost: 5400, desc: 'Lances fire 20% faster, deal 6 more damage (56 more to ships), pierce 8 and slow ships to 35% for 3 s, and the emitter gains detection.',
          apply(s) {
            const a = main(s);
            s.detection = true;
            a.cooldown /= 1.2; a.damage += 6; a.pierce = 8; a.shipDamage = (a.shipDamage || 0) + 50; a.speed = 950; a.scale = 1.5;
            setHit(a, { freeze: { ...a.onHit.freeze, shipMult: 0.35 }, slow: { shipMult: 0.35, t: 3 } });
          } },
        { name: 'Frost Titan', cost: 30000, desc: 'Heavy frost bolts deal 20 more damage (270 more to ships) to up to 4 targets, burst in a 70 unit freeze blast, slow ships to 25% for 3 s and can hurt Comets and Geodes.',
          apply(s) {
            const a = main(s);
            a.damage += 20; a.shipDamage = (a.shipDamage || 0) + 250; a.pierce = 4; a.projRadius = 10; a.scale = 1.6; a.color = '#dff8ff';
            a.bypass = [...(a.bypass || []), 'CRYO'];
            setHit(a, { freeze: { ...a.onHit.freeze, shipMult: 0.25 }, slow: { shipMult: 0.25, t: 3 } });
            a.splash = { radius: 70, damage: 4, pierce: 25, dtype: 'CRYO', onHit: { freeze: { t: 1.5, shipMult: 0.5 } }, visual: 'frostburst', color: '#dff8ff' };
          } },
      ],
    },
  ],
};
