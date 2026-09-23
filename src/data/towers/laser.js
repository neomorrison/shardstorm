// Laser Array: continuous THERMAL beam that ramps up the longer it holds one target.
// Pure data plus pure behavior functions.
// Prices follow docs/ECONOMY.md 2.4 for base b = 1100:
//   T1 440..1320, T2 880..2750, T3 2200..8800, T4 8800..33000, T5 44000..165000.
//
// THERMAL hits Iron, Magma, Comets, Geodes and frozen meteors; Prism meteors are immune.
// Answers: Focus (path B) adds detection at T2; Plasma (path C) switches to VOID at T3, which
// hits every meteor type, and its lance (T4+) burns Phantom meteors caught on the line.
// Beam shipDamage is added on every 0.1 s tick, so +1 shipDamage = +10 damage per second.

const main = (s) => s.attacks.main;

function hurts(e, dtype, bypass) {
  const imm = e.def.immune;
  if (imm.length && imm.indexOf(dtype) >= 0) {
    if (!bypass || (bypass.indexOf(dtype) < 0 && bypass.indexOf(e.type) < 0)) return false;
  }
  return true;
}

function srcOf(atk) {
  const s = atk._src;
  if (s && !s._norm) s._norm = true; // engine-normalized source: safe to pass to sim.damage
  return s;
}

// ------------------------------------------------------------------ Prism Split tint
// Runs after the main beam each tick and paints the forks in spectrum colors.
const RAINBOW = ['#ff4f5e', '#ffa23d', '#ffe14d', '#5dff8a', '#4cc9f0', '#6b8cff', '#c77dff', '#ff6ec7'];
function tintUpdate(sim, tower) {
  const beams = tower.data.beams;
  if (!beams) return;
  for (let i = 0; i < beams.length; i++) beams[i].color = RAINBOW[i % RAINBOW.length];
}

// ------------------------------------------------------------------ Plasma Lance
// From Plasma T4 the beam becomes a lance. The main attack stays an engine beam (it locks the
// target, ramps and burns it, and bots and benches can value it); this companion attack runs
// right after it, stretches the first `lines` beams (1: Prism Split forks stay plain beams, so
// a Tri-Beam crosspath does not triple the lance) out to lineLength and burns every other enemy
// on that line (up to `pierce` per tick, nearest first) at the beam's current ramp.
// Per-wave scratch lives in tower.data._beam_lance (the engine deletes _beam_ keys when the
// build phase starts, so saves and replays never see it).
const hitBuf = [];
function lanceUpdate(sim, tower, atk, dt) {
  const beam = tower.stats.attacks.main;
  const beams = tower.data.beams;
  let st = tower.data._beam_lance;
  if (!beams || !beams.length) { if (st) st.acc = 0; return; }
  if (!st) st = tower.data._beam_lance = { acc: 0 };
  st.acc += dt;
  let doTick = false;
  if (st.acc >= beam.tickRate) { st.acc -= beam.tickRate; if (st.acc > beam.tickRate) st.acc = beam.tickRate; doTick = true; }
  const len = atk.lineLength;
  const half = atk.hitWidth;
  const src = srcOf(beam);
  const onHit = beam.onHit ? { onHit: beam.onHit } : undefined;
  const nl = Math.min(beams.length, atk.lines || 1);
  for (let k = 0; k < nl; k++) {
    const b = beams[k];
    const ang = Math.atan2(b.y2 - tower.y, b.x2 - tower.x);
    const ux = Math.cos(ang), uy = Math.sin(ang);
    const x0 = tower.x + ux * tower.radius, y0 = tower.y + uy * tower.radius;
    const x1 = tower.x + ux * len, y1 = tower.y + uy * len;
    if (doTick) {
      const segLen = len - tower.radius;
      const q = sim.enemiesInRange((x0 + x1) / 2, (y0 + y1) / 2, segLen / 2 + half + 24);
      hitBuf.length = 0;
      for (let i = 0; i < q.length; i++) {
        const e = q[i];
        if (e.dead || !hurts(e, beam.dtype, beam.bypass)) continue;
        // enemies a beam already holds are burned by that beam, not by the lance line too
        let held = false;
        for (let j = 0; j < beams.length; j++) if (beams[j].targetId === e.id) { held = true; break; }
        if (held) continue;
        const rx = e.x - x0, ry = e.y - y0;
        const along = rx * ux + ry * uy;
        if (along < -e.radius || along > segLen + e.radius) continue;
        const perp = rx * uy - ry * ux;
        const lim = half + e.radius;
        if (perp > lim || perp < -lim) continue;
        e._la = along;
        hitBuf.push(e);
      }
      if (hitBuf.length > atk.pierce) hitBuf.sort((p1, p2) => p1._la - p2._la);
      const n = Math.min(hitBuf.length, atk.pierce);
      const amount = beam.dps * beam.tickRate * (b.ramp || 1);
      for (let i = 0; i < n; i++) if (!hitBuf[i].dead) sim.damage(hitBuf[i], amount, beam.dtype, src, onHit);
    }
    b.x2 = x1; b.y2 = y1;
  }
}

export default {
  id: 'laser',
  name: 'Laser Array',
  hotkey: 'a',
  cost: 1100,
  radius: 22,
  blurb: 'A beam that burns hotter the longer it holds a target.',
  desc: 'Fires a continuous THERMAL beam that ramps up to 2.5x damage while it stays on one target. Prism meteors are immune.',
  art: {
    sprite: 'tower_laser', rotates: true, color: '#ff5a4d', accent: '#e8eef7', shape: 'oct', barrels: 1,
    variant(levels) { return levels[0] >= 3 ? 1 : levels[1] >= 3 ? 2 : levels[2] >= 3 ? 3 : 0; },
  },
  base: {
    range: 165,
    detection: false,
    targetModes: ['first', 'last', 'strong', 'close'],
    attacks: {
      main: {
        kind: 'beam', beams: 1, dps: 5, tickRate: 0.1, ramp: 0.8, rampMax: 2.5, width: 5, dtype: 'THERMAL',
        color: '#ff4f5e', visual: 'laser',
      },
    },
    aura: null,
    income: null,
    abilities: [],
  },
  paths: [
    {
      name: 'Prism Split',
      upgrades: [
        { name: 'Beam Splitter', cost: 480, desc: 'Splits into 2 beams that lock onto different targets.',
          apply(s) { main(s).beams += 1; } },
        { name: 'Tri-Beam', cost: 900, desc: 'Fires 3 beams. Range +15.',
          apply(s) { main(s).beams += 1; s.range += 15; } },
        { name: 'Prism Fork', cost: 3600, desc: 'Fires 5 rainbow beams that deal 2.5 times the damage and retarget twice as fast.',
          apply(s) {
            const a = main(s);
            a.beams += 2; a.dps *= 2.5; a.width = 5; a.tickRate = 0.05;
            s.attacks.tint = { kind: 'custom', dtype: 'THERMAL', needsTarget: false, damage: 0, update: tintUpdate };
          } },
        { name: 'Spectrum Array', cost: 9500, desc: 'Fires 6 beams that deal 3.5 times the damage and ramp up 50% faster.',
          apply(s) { const a = main(s); a.beams += 1; a.dps *= 3.5; a.ramp *= 1.5; } },
        { name: 'Rainbow Lattice', cost: 48000, desc: 'Fires 8 beams that deal 7 times the damage, retarget faster and ramp up to 4x. Range +45.',
          apply(s) { const a = main(s); a.beams += 2; a.dps *= 7; a.rampMax += 1.5; a.width = 4; a.tickRate = 1 / 30; s.range += 45; } },
      ],
    },
    {
      name: 'Focus',
      upgrades: [
        { name: 'Focusing Lens', cost: 450, desc: 'Ramps up 60% faster, to 3x damage.',
          apply(s) { const a = main(s); a.ramp *= 1.6; a.rampMax += 0.5; } },
        { name: 'Targeting Optics', cost: 880, desc: 'Detection: can target Phantom meteors. Range +25, and ramps up to 4x damage.',
          apply(s) { s.detection = true; s.range += 25; main(s).rampMax += 1; } },
        { name: 'Burning Focus', cost: 5000, desc: 'A focused beam that deals 2.2 times the damage, ramps up to 5x and deals 30 extra damage per second to ships.',
          apply(s) {
            const a = main(s);
            a.dps *= 2.2; a.rampMax += 1; a.shipDamage = (a.shipDamage || 0) + 3;
            a.width = 8; a.rampWidth = true; a.color = '#ffc94d'; a.visual = 'focus';
          } },
        { name: 'Solar Lance', cost: 16000, desc: 'Deals twice the damage, ramps 50% faster up to 8x and deals 180 extra damage per second to ships.',
          apply(s) {
            const a = main(s);
            a.dps *= 2; a.ramp *= 1.5; a.rampMax += 3; a.shipDamage = (a.shipDamage || 0) + 15;
            a.width = 11; a.color = '#ffd76a';
          } },
        { name: 'Sunspear', cost: 75000, desc: 'Deals triple damage, ramps twice as fast up to 14x and deals 1500 extra damage per second to ships.',
          apply(s) {
            const a = main(s);
            a.dps *= 3; a.ramp *= 2; a.rampMax += 6; a.shipDamage = (a.shipDamage || 0) + 132;
            a.width = 16; a.color = '#fff1b8'; a.visual = 'sunspear';
          } },
      ],
    },
    {
      name: 'Plasma',
      upgrades: [
        { name: 'Hot Plasma', cost: 480, desc: 'Beam deals 35% more damage.',
          apply(s) { main(s).dps *= 1.35; } },
        { name: 'Plasma Burn', cost: 1100, desc: 'Targets keep burning for 8 damage per second for 2 s after the beam moves on.',
          apply(s) { const a = main(s); a.onHit = { ...(a.onHit || {}), burn: { dps: 8, t: 2 } }; } },
        { name: 'Void Plasma', cost: 2800, desc: 'Beam switches to VOID damage, which hits every meteor type including Prism, and deals 4 times the damage.',
          apply(s) {
            const a = main(s);
            a.dtype = 'VOID'; a.dps *= 4; a.width = 7; a.color = '#b56bff'; a.visual = 'void';
          } },
        { name: 'Plasma Lance', cost: 8800, desc: 'The main beam becomes a lance that deals 2.8 times the damage and also burns up to 15 enemies along its length, Phantoms included.',
          apply(s) {
            const a = main(s);
            a.dps *= 2.8; a.width = 9; a.rampWidth = true; a.color = '#c77dff'; a.visual = 'lance';
            s.attacks.lance = { kind: 'custom', dtype: 'VOID', needsTarget: false, damage: 0, pierce: 15, lineLength: s.range + 50, hitWidth: 10, update: lanceUpdate };
          } },
        { name: 'Singularity Lance', cost: 48000, desc: 'A 1100-unit lance that deals 4 times the damage, ramps twice as fast up to 5x and burns up to 50 enemies along it.',
          apply(s) {
            const a = main(s), l = s.attacks.lance;
            a.dps *= 4; a.rampMax = Math.max(5, a.rampMax + 1.5); a.ramp *= 2; a.width = 16;
            a.color = '#d6a6ff'; a.visual = 'singularity';
            l.pierce = 50; l.lineLength = 1100; l.hitWidth = 16;
          } },
      ],
    },
  ],
};
