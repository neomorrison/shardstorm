// Commander (hero) definitions (docs/DESIGN.md section 6). Pure data plus ability code that only
// talks to the Sim helper API (no DOM, no Math.random, no clocks).
//
// Each Commander is a TowerDef (see src/data/towers/pulse.js) with `paths: []` plus:
//   hero: { maxLevel: 20, levels: [fn x 19], levelNotes: [string x 19] }
// levels[i](stats, ctx) runs when the Commander reaches level i + 2 (levels[0] at level 2,
// levels[18] at level 20); level 1 is `base`. The engine re-applies every reached level to a fresh
// clone of `base` on each level up, so the functions only ever mutate the stats they are given.
// levelNotes[i] is the player-facing summary of levels[i]; it sits next to the function it
// describes, and ability upgrade notes are built from the ability itself (upgradeNote).
//
// Abilities: the level 3 and level 10 functions push the real ability objects into
// stats.abilities; the level 16 and 20 functions replace them with stronger versions under a new
// id (so the ability bar picks up the new name and description). `abilities` at the top level is
// the metadata the UI lists ({ level, name, desc }).
//
// Power curve: every level is a visible gain, with spikes at 3 and 10 (abilities), 5 and 15
// (attack overhauls) and 20 (capstone). Tuned for the pace in docs/ECONOMY.md 6 (level 20 around
// wave 55 when placed on wave 1, so roughly level 10 by wave 25 and level 15 by wave 40). On the
// ECONOMY 3.1 bench scenarios a level 20 Commander lands near a well-invested tier 4 tower in its
// specialty and below every tier 5: Vega is the all-rounder, Nova trades damage for her range aura,
// Brick is the ship killer. The balance pass owns the final numbers.

const main = (s) => s.attacks.main;

// Whole numbers in player-facing text use thousands separators (4,000), like the rest of the UI.
function num(n) {
  const neg = n < 0;
  let s = String(Math.abs(n));
  const dot = s.indexOf('.');
  let int = dot >= 0 ? s.slice(0, dot) : s;
  const frac = dot >= 0 ? s.slice(dot) : '';
  let out = '';
  while (int.length > 3) { out = ',' + int.slice(-3) + out; int = int.slice(0, -3); }
  s = int + out + frac;
  return neg ? '-' + s : s;
}

// ---------------------------------------------------------------- shared ability helpers

function onScreen(e) {
  return e.x > -e.radius * 0.5 && e.x < 1500 + e.radius * 0.5 && e.y > -e.radius * 0.5 && e.y < 1000 + e.radius * 0.5;
}

// Same ordering as the 'strong' targeting mode: Titans, then ships, then remaining mass.
function strength(e) {
  return (e.titan !== null ? 1e13 : 0) + (e.ship ? 1e12 : 0) + e.hp + (e.childMass || 0) + (e.titan !== null ? e.titan.shield : 0);
}

function canSee(e, tower) {
  return !e.phantom || e.exposedT > 0 || !!tower.stats.detection;
}

function immuneTo(e, dtype, bypass) {
  const imm = e.def.immune;
  if (!imm.length || imm.indexOf(dtype) < 0) return false;
  return !(bypass && (bypass.indexOf(dtype) >= 0 || bypass.indexOf(e.type) >= 0));
}

// Strongest visible enemy on screen (or within r of the tower), ships first.
// opts: { r, dtype, bypass, shipsOnly }
function strongest(sim, tower, opts = {}) {
  const list = opts.r ? sim.enemiesInRange(tower.x, tower.y, opts.r) : sim.state.enemies;
  let best = null, bestS = -Infinity;
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (e.dead || !onScreen(e) || !canSee(e, tower)) continue;
    if (opts.shipsOnly && !e.ship) continue;
    if (opts.dtype && immuneTo(e, opts.dtype, opts.bypass)) continue;
    const s = strength(e);
    if (s > bestS) { bestS = s; best = e; }
  }
  return best;
}

// The n strongest visible enemies within r of the tower.
function strongestN(sim, tower, r, n, dtype, bypass) {
  const out = [];
  for (const e of sim.enemiesInRange(tower.x, tower.y, r)) {
    if (e.dead || !onScreen(e) || !canSee(e, tower)) continue;
    if (dtype && immuneTo(e, dtype, bypass)) continue;
    out.push(e);
  }
  out.sort((a, b) => strength(b) - strength(a) || a.id - b.id);
  if (out.length > n) out.length = n;
  return out;
}

// ---------------------------------------------------------------- Captain Vega

function overchargeAbility(id, name, radius, rate, dur, cooldown) {
  const pct = Math.round((rate - 1) * 100);
  return {
    id, name, icon: '\u00bb', cooldown, duration: dur, // double right angle quote
    desc: `Vega and every tower within ${radius} units fire ${pct}% faster for ${dur} s.`,
    activate(sim, tower) {
      for (const t of sim.towersNear(tower.x, tower.y, radius)) sim.addTempBuff(t, { rateMult: rate }, dur);
      sim.emit({ t: 'abilityFx', id, x: tower.x, y: tower.y, r: radius });
      sim.emit({ t: 'pulse', tower: tower.id, type: tower.type, x: tower.x, y: tower.y, r: radius, dtype: 'ENERGY', color: '#7ff5e0' });
    },
  };
}

// Orbital strikes land one after another on the strongest ship at that moment (strength() ranks
// Titans, then ships, then meteors, so a meteor is struck only when no ship is on screen): a
// Titan or big ship soaks the whole salvo and a dead target hands the rest to the next one.
function orbitalAbility(id, name, strikes, dmg, shipDmg, radius, cooldown) {
  const BLAST_PIERCE = 30;
  return {
    id, name, icon: '\u2726', cooldown, duration: 0.3 + strikes * 0.12, // four-pointed star
    desc: `Calls ${strikes} VOID strikes on the strongest ships on screen (else the strongest meteors), each blasting up to ${BLAST_PIERCE} enemies within ${radius} units for ${num(dmg)} damage (${num(shipDmg)} to ships).`,
    activate(sim, tower) {
      const src = { tower, attackKey: id, dtype: 'VOID' };
      const blast = { radius, damage: dmg, shipDamage: shipDmg - dmg, pierce: BLAST_PIERCE, dtype: 'VOID', visual: 'orbital' };
      for (let k = 0; k < strikes; k++) {
        sim.after(0.3 + k * 0.12, (s) => {
          if (s.getTower(tower.id) !== tower) return; // Commander sold mid-salvo
          const e = strongest(s, tower);
          if (!e) return;
          const x = e.x, y = e.y;
          s.emit({ t: 'shot', tower: tower.id, type: tower.type, x: x + 70, y: -40, x2: x, y2: y, angle: Math.atan2(y + 40, -70), visual: 'rail', dtype: 'VOID', attack: id });
          s.explode(x, y, blast, src);
        });
      }
      sim.emit({ t: 'abilityFx', id, x: tower.x, y: tower.y, r: 120 });
    },
  };
}

const OVERCHARGE = overchargeAbility('overcharge', 'Overcharge', 220, 1.5, 8, 45);
const OVERCHARGE_2 = overchargeAbility('overcharge2', 'Overcharge II', 260, 1.75, 10, 40);
const ORBITAL = orbitalAbility('orbital', 'Orbital Salvo', 8, 8, 100, 60, 50);
const ORBITAL_2 = orbitalAbility('orbital2', 'Orbital Salvo II', 12, 20, 320, 80, 45);

// ---------------------------------------------------------------- Nova

function empAbility(id, name, radius, stunT, shipStun, shipSlow, slowT, cooldown) {
  const slowPct = Math.round((1 - shipSlow) * 100);
  return {
    id, name, icon: '\u25ce', cooldown, duration: stunT, // bullseye
    desc: shipStun > 0
      ? `Stuns meteors within ${radius} units for ${stunT} s, stuns ships for ${shipStun} s and slows them by ${slowPct}% for ${slowT} s (Storm Titans half as much).`
      : `Stuns meteors within ${radius} units for ${stunT} s and slows ships by ${slowPct}% for ${slowT} s (Storm Titans half as much).`,
    activate(sim, tower) {
      const fx = { stun: { t: stunT, shipT: shipStun }, slow: { mult: 1, shipMult: shipSlow, t: slowT } };
      const src = { tower, attackKey: id, dtype: 'ENERGY' };
      const hit = sim.enemiesInRange(tower.x, tower.y, radius);
      for (const e of hit) sim.applyEffects(e, fx, src);
      // A few arcs out to the stunned meteors (visual only).
      const step = Math.max(1, Math.floor(hit.length / 6));
      for (let i = 0, n = 0; i < hit.length && n < 6; i += step, n++) {
        sim.emit({ t: 'zap', points: [[tower.x, tower.y], [hit[i].x, hit[i].y]], tower: tower.id, type: tower.type, dtype: 'ENERGY', color: '#8ff0ff', visual: 'arc' });
      }
      sim.emit({ t: 'pulse', tower: tower.id, type: tower.type, x: tower.x, y: tower.y, r: radius, dtype: 'ENERGY', color: '#8ff0ff' });
      sim.emit({ t: 'abilityFx', id, x: tower.x, y: tower.y, r: radius });
    },
  };
}

function supernovaAbility(id, name, radius, dmg, shipDmg, pierce, cooldown, prism) {
  return {
    id, name, icon: '\u2739', cooldown, duration: 0.5, // twelve-pointed star
    desc: prism
      ? `Releases a ${radius}-unit ENERGY blast that deals ${dmg} damage (${shipDmg} to ships) to up to ${pierce} targets, Prism meteors included.`
      : `Releases a ${radius}-unit ENERGY blast that deals ${dmg} damage (${shipDmg} to ships) to up to ${pierce} targets.`,
    activate(sim, tower) {
      const src = { tower, attackKey: id, dtype: 'ENERGY', bypass: prism ? ['prism'] : null };
      sim.explode(tower.x, tower.y, { radius, damage: dmg, shipDamage: shipDmg - dmg, pierce, dtype: 'ENERGY', visual: 'supernova' }, src);
      sim.emit({ t: 'abilityFx', id, x: tower.x, y: tower.y, r: radius });
      sim.emit({ t: 'pulse', tower: tower.id, type: tower.type, x: tower.x, y: tower.y, r: radius * 0.6, dtype: 'ENERGY', color: '#ffffff' });
    },
  };
}

const EMP = empAbility('emp', 'EMP Burst', 240, 2, 0, 0.5, 4, 35);
const EMP_2 = empAbility('emp2', 'EMP Burst II', 300, 3, 1, 0.4, 5, 30);
const SUPERNOVA = supernovaAbility('supernova', 'Supernova', 320, 6, 150, 250, 60, false);
const SUPERNOVA_2 = supernovaAbility('supernova2', 'Supernova II', 420, 20, 600, 400, 55, true);

// ---------------------------------------------------------------- Brick

function barrageAbility(id, name, rockets, dmg, shipDmg, radius, cooldown) {
  const R = 340, TARGETS = 5;
  return {
    id, name, icon: '\u2042', cooldown, duration: rockets * 0.06, // asterism
    desc: `Fires ${rockets} homing rockets at the ${TARGETS} strongest enemies within ${R} units, each exploding for ${num(dmg)} damage (${num(shipDmg)} to ships).`,
    activate(sim, tower) {
      const shot = {
        speed: 520, homing: 7, damage: 0, pierce: 1, dtype: 'BLAST', lifetime: 1.3, projRadius: 7,
        splashOnExpire: true, splash: { radius, damage: dmg, shipDamage: shipDmg - dmg, pierce: 14 },
        visual: 'rocket', color: '#ffb347', attackKey: id, key: id,
      };
      for (let k = 0; k < rockets; k++) {
        sim.after(k * 0.06, (s) => {
          if (s.getTower(tower.id) !== tower) return; // Commander sold mid-barrage
          const targets = strongestN(s, tower, R, TARGETS, 'BLAST', null);
          const tg = targets.length ? targets[k % targets.length] : null;
          const base = tg ? Math.atan2(tg.y - tower.y, tg.x - tower.x) : tower.angle;
          const ang = base + (s.rng() - 0.5) * 1.6;
          const x = tower.x + Math.cos(ang) * tower.radius * 0.6, y = tower.y + Math.sin(ang) * tower.radius * 0.6;
          s.spawnProjectile({ ...shot, x, y, angle: ang, tower, targetId: tg ? tg.id : -1, detection: !!tower.stats.detection });
          if (k % 3 === 0) s.emit({ t: 'shot', tower: tower.id, type: tower.type, x, y, angle: ang, visual: 'missile', dtype: 'BLAST', attack: id });
        });
      }
    },
  };
}

// A rocket fist flies to the strongest ship on screen (strongest meteor if there is none). The
// fist itself is decorative; the hit lands when it arrives, on its target or, if that target
// died on the way, on whatever is strongest then.
function punchAbility(id, name, dmg, stunT, wave, cooldown) {
  const SPEED = 1300;
  const WAVE_PIERCE = 30;
  return {
    id, name, icon: '\u27a4', cooldown, duration: 1, // arrowhead
    desc: `Launches a rocket fist at the strongest ship on screen (else the strongest meteor) for ${num(dmg)} damage and stuns it for ${stunT} s (Storm Titans half as long); the impact shockwave deals ${num(wave.damage)} damage (${num(wave.ship)} to ships) to up to ${WAVE_PIERCE} enemies within ${wave.radius} units.`,
    activate(sim, tower) {
      const pick = (s) => strongest(s, tower, { shipsOnly: true }) || strongest(s, tower);
      const tg = pick(sim);
      if (!tg) return;
      const dist = Math.hypot(tg.x - tower.x, tg.y - tower.y);
      const flight = Math.min(1.1, Math.max(0.25, dist / SPEED));
      const ang = Math.atan2(tg.y - tower.y, tg.x - tower.x);
      const fist = sim.spawnProjectile({
        x: tower.x, y: tower.y, angle: ang, tower, speed: Math.max(SPEED, dist / flight), homing: 30,
        damage: 0, pierce: 1e6, dtype: 'BLAST', lifetime: flight + 0.4, projRadius: 4,
        visual: 'rocketfist', color: '#ff8c2a', scale: 2.4, targetId: tg.id, attackKey: id, key: id,
      });
      const fistId = fist ? fist.id : -1;
      sim.emit({ t: 'shot', tower: tower.id, type: tower.type, x: tower.x, y: tower.y, angle: ang, visual: 'missile', dtype: 'BLAST', attack: id });
      const bypass = ['BLAST'];
      sim.after(flight, (s) => {
        if (fist && fist.id === fistId && !fist.dead) fist.dead = true;
        if (s.getTower(tower.id) !== tower) return; // Commander sold before the fist landed
        let e = s.getEnemy(tg.id);
        if (!e || e.dead) e = pick(s);
        if (!e) return;
        const x = e.x, y = e.y;
        const src = { tower, attackKey: id, dtype: 'BLAST', bypass };
        s.damage(e, dmg, 'BLAST', src);
        if (!e.dead) s.applyEffects(e, { stun: { t: stunT, shipT: stunT } }, src);
        s.explode(x, y, { radius: wave.radius, damage: wave.damage, shipDamage: wave.ship - wave.damage, pierce: WAVE_PIERCE, dtype: 'BLAST', visual: 'punch' }, src);
        s.emit({ t: 'abilityFx', id, x, y, r: wave.radius + 40 });
      });
    },
  };
}

const BARRAGE = barrageAbility('rocketbarrage', 'Rocket Barrage', 16, 2, 12, 45, 40);
const BARRAGE_2 = barrageAbility('rocketbarrage2', 'Rocket Barrage II', 28, 5, 40, 55, 35);
const PUNCH = punchAbility('punch', 'Titan Punch', 800, 1, { radius: 90, damage: 4, ship: 40 }, 50);
const PUNCH_2 = punchAbility('punch2', 'Titan Punch II', 4000, 2, { radius: 130, damage: 10, ship: 100 }, 45);

// ---------------------------------------------------------------- level helpers

function replaceAbility(s, oldId, ab) {
  const i = s.abilities.findIndex((a) => a.id === oldId);
  if (i >= 0) s.abilities[i] = ab; else s.abilities.push(ab);
}
const faster = (a, f) => { a.cooldown *= f; };
const addBypass = (a, ...xs) => { const b = a.bypass ? a.bypass.slice() : []; for (const x of xs) if (b.indexOf(x) < 0) b.push(x); a.bypass = b; };

// Level note for an ability upgrade, built from the ability itself so the numbers never drift.
const upgradeNote = (ab, extra) => `${ab.name}: ${ab.desc}` + (extra ? ' ' + extra : '');

// Build { levels, levelNotes } from [[note, fn], ...] (19 entries, levels 2..20).
function track(rows) {
  if (rows.length !== 19) throw new Error('hero track needs 19 levels, got ' + rows.length);
  return { maxLevel: 20, levels: rows.map((r) => r[1]), levelNotes: rows.map((r) => r[0]) };
}

// ---------------------------------------------------------------- definitions

const vega = {
  id: 'vega',
  name: 'Captain Vega',
  cost: 550,
  radius: 20,
  blurb: 'Rapid pulse rifle with detection. Overcharges nearby towers.',
  desc: 'A field captain with a KINETIC pulse rifle and built-in detection, good against almost anything. Cannot hurt Iron or frozen meteors until level 7.',
  art: { sprite: 'hero_vega', rotates: false, color: '#2ec4b6', accent: '#ff8a3d', shape: 'hex', hero: true },
  base: {
    range: 170,
    detection: true,
    targetModes: ['first', 'last', 'strong', 'close'],
    attacks: {
      main: {
        kind: 'projectile', cooldown: 0.42, damage: 1, pierce: 2, dtype: 'KINETIC',
        speed: 1250, projRadius: 6, visual: 'bolt', color: '#7ff5e0',
      },
    },
    aura: null,
    income: null,
    abilities: [],
  },
  paths: [],
  abilities: [
    { level: 3, name: OVERCHARGE.name, desc: OVERCHARGE.desc },
    { level: 10, name: ORBITAL.name, desc: ORBITAL.desc },
    { level: 16, name: OVERCHARGE_2.name, desc: OVERCHARGE_2.desc },
    { level: 20, name: ORBITAL_2.name, desc: ORBITAL_2.desc },
  ],
  hero: track([
    /* 2 */ ['Range +10.', (s) => { s.range += 10; }],
    /* 3 */ ['Unlocks Overcharge. Bolts pierce 1 more meteor.', (s) => { main(s).pierce += 1; s.abilities.push(OVERCHARGE); }],
    /* 4 */ ['Fires 15% faster.', (s) => { faster(main(s), 0.87); }],
    /* 5 */ ['Twin Rifle: fires 2 bolts per shot.', (s) => { const a = main(s); a.count = 2; a.spread = 0.12; }],
    /* 6 */ ['Bolts pierce 1 more meteor. Range +10.', (s) => { main(s).pierce += 1; s.range += 10; }],
    /* 7 */ ['Tungsten Rounds: bolts can hit Iron meteors and frozen targets.', (s) => { addBypass(main(s), 'iron', 'FROZEN'); }],
    /* 8 */ ['Bolts deal 1 more damage.', (s) => { main(s).damage += 1; }],
    /* 9 */ ['Fires 15% faster.', (s) => { faster(main(s), 0.87); }],
    /* 10 */ ['Unlocks Orbital Salvo. Fires 3 bolts per shot.', (s) => { const a = main(s); a.count = 3; a.spread = 0.2; s.abilities.push(ORBITAL); }],
    /* 11 */ ['Bolts pierce 1 more meteor and deal 1 more damage to ships.', (s) => { const a = main(s); a.pierce += 1; a.shipDamage = (a.shipDamage || 0) + 1; }],
    /* 12 */ ['Range +15 and faster bolts.', (s) => { s.range += 15; main(s).speed += 300; }],
    /* 13 */ ['Fires 12% faster.', (s) => { faster(main(s), 0.89); }],
    /* 14 */ ['Bolts pierce 1 more meteor.', (s) => { main(s).pierce += 1; }],
    /* 15 */ ['Command Rifle: 15% of hits crit for double damage, and range +10.', (s) => { const a = main(s); a.crit = { chance: 0.15, mult: 2 }; s.range += 10; a.visual = 'lance'; a.projRadius = 8; }],
    /* 16 */ [upgradeNote(OVERCHARGE_2), (s) => { replaceAbility(s, 'overcharge', OVERCHARGE_2); }],
    /* 17 */ ['Bolts pierce 1 more meteor and deal 1 more damage to ships.', (s) => { const a = main(s); a.pierce += 1; a.shipDamage = (a.shipDamage || 0) + 1; }],
    /* 18 */ ['Bolts deal 2 more damage to ships and fly faster.', (s) => { const a = main(s); a.shipDamage = (a.shipDamage || 0) + 2; a.speed += 300; }],
    /* 19 */ ['Range +15. Crit chance rises to 20%.', (s) => { s.range += 15; main(s).crit = { chance: 0.2, mult: 2 }; }],
    /* 20 */ [upgradeNote(ORBITAL_2, 'Starfire bolts turn VOID, hitting every meteor type, and pierce 1 more meteor.'), (s) => {
      const a = main(s); a.pierce += 1; a.dtype = 'VOID'; a.visual = 'starlance'; a.color = '#fff3b0'; a.projRadius = 9;
      replaceAbility(s, 'orbital', ORBITAL_2);
    }],
  ]),
};

const nova = {
  id: 'nova',
  name: 'Nova',
  cost: 700,
  radius: 20,
  blurb: 'Chain lightning and an aura that extends nearby tower range.',
  desc: 'An energy adept whose ENERGY arcs jump between meteors while her aura extends the range of nearby towers. Arcs cannot hurt Prism meteors until level 20.',
  art: { sprite: 'hero_nova', rotates: false, color: '#5ad8ff', accent: '#e8f6ff', shape: 'circle', hero: true },
  base: {
    range: 160,
    detection: false,
    targetModes: ['first', 'last', 'strong', 'close'],
    attacks: {
      main: {
        kind: 'chain', cooldown: 0.75, damage: 1, jumps: 3, jumpRange: 95, falloff: 1, dtype: 'ENERGY',
        visual: 'arc', color: '#8ff0ff',
      },
    },
    aura: { radius: 170, rangeMult: 1.06, excludeTypes: ['rig', 'beacon'] },
    income: null,
    abilities: [],
  },
  paths: [],
  abilities: [
    { level: 3, name: EMP.name, desc: EMP.desc },
    { level: 10, name: SUPERNOVA.name, desc: SUPERNOVA.desc },
    { level: 16, name: EMP_2.name, desc: EMP_2.desc },
    { level: 20, name: SUPERNOVA_2.name, desc: SUPERNOVA_2.desc },
  ],
  hero: track([
    /* 2 */ ['Arcs jump to 1 more meteor.', (s) => { main(s).jumps += 1; }],
    /* 3 */ ['Unlocks EMP Burst. Aura range bonus rises to 8%.', (s) => { s.aura.rangeMult = 1.08; s.abilities.push(EMP); }],
    /* 4 */ ['Arcs fire 15% faster.', (s) => { faster(main(s), 0.87); }],
    /* 5 */ ['Twin Arcs: casts 2 arcs per attack.', (s) => { main(s).count = 2; }],
    /* 6 */ ['Range +15 and aura radius +20.', (s) => { s.range += 15; s.aura.radius += 20; }],
    /* 7 */ ['Arcs deal 1 more damage.', (s) => { main(s).damage += 1; }],
    /* 8 */ ['Arcs jump to 1 more meteor and reach 15 units farther.', (s) => { const a = main(s); a.jumps += 1; a.jumpRange += 15; }],
    /* 9 */ ['Arcs fire 15% faster. Aura range bonus rises to 10%.', (s) => { faster(main(s), 0.87); s.aura.rangeMult = 1.1; }],
    /* 10 */ ['Unlocks Supernova. Arcs jump to 1 more meteor.', (s) => { main(s).jumps += 1; s.abilities.push(SUPERNOVA); }],
    /* 11 */ ['Arcs deal 3 more damage to ships.', (s) => { const a = main(s); a.shipDamage = (a.shipDamage || 0) + 3; }],
    /* 12 */ ['Range +15 and aura radius +20.', (s) => { s.range += 15; s.aura.radius += 20; }],
    /* 13 */ ['Arcs fire 15% faster.', (s) => { faster(main(s), 0.87); }],
    /* 14 */ ['Arcs jump to 1 more meteor.', (s) => { main(s).jumps += 1; }],
    /* 15 */ ['Ion Storm: casts 3 arcs per attack that slow meteors by 25% for 1 s. Aura range bonus rises to 13%.', (s) => {
      const a = main(s); a.count = 3; a.onHit = { ...(a.onHit || {}), slow: { mult: 0.75, t: 1 } }; a.color = '#c9f7ff'; s.aura.rangeMult = 1.13;
    }],
    /* 16 */ [upgradeNote(EMP_2), (s) => { replaceAbility(s, 'emp', EMP_2); }],
    /* 17 */ ['Arcs deal 4 more damage to ships.', (s) => { const a = main(s); a.shipDamage = (a.shipDamage || 0) + 4; }],
    /* 18 */ ['Arcs fire 12% faster and the aura radius grows by 20.', (s) => { faster(main(s), 0.89); s.aura.radius += 20; }],
    /* 19 */ ['Arcs reach 15 units farther. Aura range bonus rises to 15%.', (s) => { main(s).jumpRange += 15; s.aura.rangeMult = 1.15; }],
    /* 20 */ [upgradeNote(SUPERNOVA_2, 'Arcs hit Prism meteors and the aura range bonus rises to 18%.'), (s) => {
      const a = main(s); addBypass(a, 'prism'); s.aura.rangeMult = 1.18; a.color = '#ffffff';
      replaceAbility(s, 'supernova', SUPERNOVA_2);
    }],
  ]),
};

const brick = {
  id: 'brick',
  name: 'Brick',
  cost: 800,
  radius: 24,
  blurb: 'Heavy mech with a BLAST cannon that cracks ships.',
  desc: 'A walking siege mech whose BLAST shells hit ships hard and splash nearby meteors. Cannot hurt Magma meteors or Geodes, and targets the strongest enemy by default.',
  art: { sprite: 'hero_brick', rotates: false, color: '#ff8c2a', accent: '#3a3f4b', shape: 'oct', hero: true },
  base: {
    range: 165,
    detection: false,
    targetModes: ['strong', 'first', 'last', 'close'],
    attacks: {
      main: {
        kind: 'projectile', cooldown: 1.1, damage: 1, pierce: 1, shipDamage: 3, dtype: 'BLAST',
        speed: 720, projRadius: 9, splashOnExpire: true,
        splash: { radius: 42, damage: 1, pierce: 12 },
        visual: 'shell', color: '#ffa94d',
      },
    },
    aura: null,
    income: null,
    abilities: [],
  },
  paths: [],
  abilities: [
    { level: 3, name: BARRAGE.name, desc: BARRAGE.desc },
    { level: 10, name: PUNCH.name, desc: PUNCH.desc },
    { level: 16, name: BARRAGE_2.name, desc: BARRAGE_2.desc },
    { level: 20, name: PUNCH_2.name, desc: PUNCH_2.desc },
  ],
  hero: track([
    /* 2 */ ['Blast radius +8.', (s) => { main(s).splash.radius += 8; }],
    /* 3 */ ['Unlocks Rocket Barrage. Shells deal 3 more damage to ships.', (s) => { main(s).shipDamage += 3; s.abilities.push(BARRAGE); }],
    /* 4 */ ['Reloads 15% faster.', (s) => { faster(main(s), 0.87); }],
    /* 5 */ ['Heavy Shells: blasts deal 2 damage and hit up to 14 meteors, and shells deal 4 more damage to ships.', (s) => {
      const a = main(s); a.splash.damage += 1; a.splash.pierce += 2; a.shipDamage += 4; a.projRadius = 10;
    }],
    /* 6 */ ['Range +15.', (s) => { s.range += 15; }],
    /* 7 */ ['Reloads 15% faster. Blast radius +6.', (s) => { const a = main(s); faster(a, 0.87); a.splash.radius += 6; }],
    /* 8 */ ['Shells deal 6 more damage to ships.', (s) => { main(s).shipDamage += 6; }],
    /* 9 */ ['Blasts deal 1 more damage.', (s) => { main(s).splash.damage += 1; }],
    /* 10 */ ['Unlocks Titan Punch. Twin Cannons: fires 2 shells per shot.', (s) => { const a = main(s); a.count = 2; a.spread = 0.16; s.abilities.push(PUNCH); }],
    /* 11 */ ['Shells deal 6 more damage to ships.', (s) => { main(s).shipDamage += 6; }],
    /* 12 */ ['Blast radius +8 and blasts hit up to 16 meteors.', (s) => { const sp = main(s).splash; sp.radius += 8; sp.pierce += 2; }],
    /* 13 */ ['Reloads 15% faster.', (s) => { faster(main(s), 0.87); }],
    /* 14 */ ['Blasts deal 1 more damage and shells deal 2 more on a direct hit.', (s) => { const a = main(s); a.splash.damage += 1; a.damage += 2; }],
    /* 15 */ ['Siege Optics: gains detection, and shells stun meteors for 0.3 s, hit Specters and deal 8 more damage to ships.', (s) => {
      const a = main(s); s.detection = true; a.shipDamage += 8; addBypass(a, 'specter');
      a.splash.onHit = { ...(a.splash.onHit || {}), stun: { t: 0.3, shipT: 0 } }; a.visual = 'siegeshell'; a.color = '#ff7a2a';
    }],
    /* 16 */ [upgradeNote(BARRAGE_2), (s) => { replaceAbility(s, 'rocketbarrage', BARRAGE_2); }],
    /* 17 */ ['Range +15 and faster shells.', (s) => { s.range += 15; main(s).speed += 200; }],
    /* 18 */ ['Shells deal 7 more damage to ships.', (s) => { main(s).shipDamage += 7; }],
    /* 19 */ ['Blasts deal 1 more damage. Blast radius +8.', (s) => { const sp = main(s).splash; sp.damage += 1; sp.radius += 8; }],
    /* 20 */ [upgradeNote(PUNCH_2, 'Shells deal 7 more damage to ships and stun them for 0.2 s.'), (s) => {
      const a = main(s); a.shipDamage += 7; a.onHit = { ...(a.onHit || {}), stun: { t: 0, shipT: 0.2 } };
      replaceAbility(s, 'punch', PUNCH_2);
    }],
  ]),
};

export const HEROES = { vega, nova, brick };
export const HERO_ORDER = ['vega', 'nova', 'brick'];
