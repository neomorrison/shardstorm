// Gravity Well: a slowing field around the tower. Pure data.
// Prices follow docs/ECONOMY.md 2.4 for base b = 400:
//   T1 160..480, T2 320..1000, T3 800..3200, T4 3200..12000, T5 16000..60000.
//
// The base field is the engine's `field` kind (slow + optional expose). Path mechanics are
// `custom` attacks built on the Sim helpers:
//   crush  (Crusher)  ENERGY damage over time to a capped number of meteors inside the field,
//                     plus the Event Horizon black hole.
//   tide   (Undertow) pulls meteors (and at T4 ships) back along the channel. Pull is BOUNDED:
//                     every enemy carries `gRew`, the distance gravity wells have already pulled
//                     it back; pull fades as gRew approaches the well's cap and stops at the cap,
//                     so no number of wells can stall a wave forever. Storm Titans are immune.
//   mark   (Lens)     focusing beams that mark targets to take extra damage.
// Per-wave state lives in tower.data._field_*, which the engine clears when a wave ends, so a
// save (always taken in the build phase) never needs it.

const field = (s) => s.attacks.field;

const massOf = (e) => e.hp + (e.childMass || 0) + (e.titan ? e.titan.shield : 0);
const onScreen = (e) => e.x > 0 && e.x < 1500 && e.y > 0 && e.y < 1000;
const toCore = (sim, e) => (sim.paths[e.lane] || sim.paths[0]).length - e.d;

function canHurt(e, dtype, bypass) {
  const imm = e.def.immune;
  if (imm.length && imm.indexOf(dtype) >= 0) {
    if (!bypass || (bypass.indexOf(dtype) < 0 && bypass.indexOf(e.type) < 0)) return false;
  }
  return true;
}

function normSrc(a) {
  const src = a._src;
  if (!src._norm) src._norm = true;
  return src;
}

// ------------------------------------------------------------------------------------------
// Crusher: capped damage over time, implosions (pulse attack), Event Horizon black hole
// ------------------------------------------------------------------------------------------

const CRUSH_TICK = 0.25;

function crushUpdate(sim, t, a, dt) {
  let d = t.data._field_crush;
  if (!d) d = t.data._field_crush = { acc: 0, q: [], pick: [] };
  if (d.bh) blackHoleTick(sim, t, d, dt);
  d.acc += dt;
  if (d.acc < CRUSH_TICK) return;
  d.acc -= CRUSH_TICK;
  const q = sim.grid.query(t.x, t.y, a.range, d.q);
  if (!q.length) { d.acc = 0; return; }
  const pick = d.pick; pick.length = 0;
  for (let i = 0; i < q.length; i++) {
    const e = q[i];
    if (!e.dead && canHurt(e, a.dtype, a.bypass)) { e._gk = toCore(sim, e); pick.push(e); }
  }
  if (!pick.length) return;
  if (pick.length > a.max) { pick.sort((p, r) => p._gk - r._gk); pick.length = a.max; }
  const src = normSrc(a);
  const dmg = a.dps * CRUSH_TICK;
  let sparks = 0;
  for (let i = 0; i < pick.length; i++) {
    const e = pick[i];
    if (e.dead) continue;
    const x = e.x, y = e.y;
    const r = sim.damage(e, dmg, a.dtype, src);
    if (sparks < 5 && !e.dead && !r.blocked) { sparks++; sim.emit({ t: 'hit', x, y, dtype: a.dtype }); }
  }
}

// Event Horizon ability: a black hole at the densest spot of the channel.
const BH_RADIUS = 110;
const BH_TIME = 3;
const BH_SHIP_DPS = 2000;
const BH_TITAN_DPS = 1000;
const bhQ = [];

function densestSpot(sim, radius) {
  const list = sim.state.enemies;
  const n = list.length;
  const step = Math.max(1, Math.floor(n / 150));
  let best = null, bestM = 0;
  for (let i = 0; i < n; i += step) {
    const e = list[i];
    if (e.dead || !onScreen(e)) continue;
    const near = sim.grid.query(e.x, e.y, radius, bhQ);
    let m = 0;
    for (let k = 0; k < near.length; k++) if (!near[k].dead) m += massOf(near[k]);
    if (m > bestM) { bestM = m; best = e; }
  }
  return best;
}

function blackHoleTick(sim, t, d, dt) {
  const bh = d.bh;
  bh.t -= dt;
  bh.acc += dt;
  // Pull meteors on the same lane toward the hole (both directions); ships drift in slowly.
  const pullR = BH_RADIUS * 2.2;
  const q = sim.grid.query(bh.x, bh.y, pullR, d.q);
  for (let i = 0; i < q.length; i++) {
    const e = q[i];
    if (e.dead || e.titan !== null || e.lane !== bh.lane) continue;
    const gap = bh.d - e.d;
    if (Math.abs(gap) > pullR) continue;
    const v = (e.ship ? 25 : 220) * dt;
    if (gap > 0) e.d += Math.min(gap, v);
    else if (!e.ship) e.d -= Math.min(-gap, v);
  }
  if (bh.acc >= 0.1) {
    bh.acc -= 0.1;
    const src = bh.src;
    const inner = sim.grid.query(bh.x, bh.y, BH_RADIUS, d.q);
    for (let i = 0; i < inner.length; i++) {
      const e = inner[i];
      if (e.dead) continue;
      if (e.ship) sim.damage(e, (e.titan !== null ? BH_TITAN_DPS : BH_SHIP_DPS) * 0.1, 'VOID', src);
      else sim.damage(e, e.hp + (e.childMass || 0) + 1, 'VOID', src);
    }
    bh.fx -= 0.1;
    if (bh.fx <= 0) {
      bh.fx = 0.2;
      sim.emit({ t: 'pulse', tower: t.id, type: t.type, x: bh.x, y: bh.y, r: BH_RADIUS, dtype: 'VOID', color: '#7b2cff', visual: 'blackhole' });
    }
  }
  if (bh.t <= 0) {
    sim.emit({ t: 'explode', x: bh.x, y: bh.y, r: BH_RADIUS * 1.2, dtype: 'VOID', visual: 'blackhole', color: '#b86bff' });
    d.bh = null;
  }
}

const blackHole = {
  id: 'blackhole',
  name: 'Black Hole',
  icon: 'blackhole',
  cooldown: 60,
  duration: BH_TIME,
  desc: 'Opens a black hole on the densest spot of the channel for 3 s: it destroys every meteor within 110 units and deals 2000 damage per second to ships (1000 to Storm Titans).',
  activate(sim, tower) {
    const c = densestSpot(sim, BH_RADIUS);
    let x, y, lane, d;
    if (c) { x = c.x; y = c.y; lane = c.lane; d = c.d; }
    else { const np = sim.nearestPathPoint(tower.x, tower.y); x = np.x; y = np.y; lane = np.lane; d = np.d; }
    let st = tower.data._field_crush;
    if (!st) st = tower.data._field_crush = { acc: 0, q: [], pick: [] };
    st.bh = {
      x, y, lane, d, t: BH_TIME, acc: 0.1, fx: 0,
      src: { _norm: true, tower, attackKey: 'blackhole', dtype: 'VOID', bypass: null, shipDamage: 0, bonus: null, crit: null },
    };
    sim.emit({ t: 'explode', x, y, r: BH_RADIUS, dtype: 'VOID', visual: 'blackhole', color: '#7b2cff' });
    sim.emit({ t: 'abilityFx', id: 'blackhole', x, y, r: BH_RADIUS });
  },
};

function crush(s) {
  if (!s.attacks.crush) {
    s.attacks.crush = { kind: 'custom', dtype: 'ENERGY', damage: 0, dps: 0, max: 0, needsTarget: false, update: crushUpdate };
  }
  return s.attacks.crush;
}

function implode(s) {
  if (!s.attacks.implode) {
    s.attacks.implode = { kind: 'pulse', cooldown: 1.5, damage: 0, pierce: 30, dtype: 'ENERGY', color: '#d45dff', visual: 'implode' };
  }
  return s.attacks.implode;
}

// ------------------------------------------------------------------------------------------
// Undertow: bounded pull and rewind surges
// ------------------------------------------------------------------------------------------

// Pull `e` back by up to `amount` without exceeding `cap` total gravity rewind for that enemy.
function pullBack(e, amount, cap) {
  const rew = e.gRew || 0;
  if (rew >= cap || e.d <= 0) return 0;
  let m = amount;
  if (m > cap - rew) m = cap - rew;
  if (m > e.d) m = e.d;
  if (m <= 0) return 0;
  e.d -= m;
  e.gRew = rew + m;
  return m;
}

function tideUpdate(sim, t, a, dt) {
  let d = t.data._field_tide;
  if (!d) d = t.data._field_tide = { q: [], surgeT: a.surgeEvery > 0 ? a.surgeEvery * 0.5 : 0 };
  const q = sim.grid.query(t.x, t.y, a.range, d.q);
  let surge = false;
  if (a.surge > 0) {
    d.surgeT -= dt;
    if (d.surgeT <= 0) {
      if (q.length) { surge = true; d.surgeT = a.surgeEvery; }
      else d.surgeT = 0;
    }
  }
  if (!q.length) return;
  for (let i = 0; i < q.length; i++) {
    const e = q[i];
    if (e.dead || e.titan !== null) continue;
    const ship = e.ship;
    const cap = ship ? a.shipCap : a.cap;
    if (!(cap > 0)) continue;
    const pv = ship ? a.shipPull : a.pull;
    if (pv > 0) {
      // Pull fades as the enemy's rewind budget runs out.
      const left = 1 - (e.gRew || 0) / cap;
      if (left > 0) pullBack(e, pv * dt * (0.25 + 0.75 * left), cap);
    }
    if (surge) pullBack(e, ship ? a.shipSurge : a.surge, cap);
  }
  if (surge) sim.emit({ t: 'pulse', tower: t.id, type: t.type, x: t.x, y: t.y, r: a.range, dtype: 'VOID', color: '#4de8e0', visual: 'surge' });
}

function tide(s) {
  if (!s.attacks.tide) {
    s.attacks.tide = {
      kind: 'custom', dtype: 'ENERGY', damage: 0, needsTarget: false,
      pull: 0, cap: 0, shipPull: 0, shipCap: 0, surge: 0, shipSurge: 0, surgeEvery: 0,
      update: tideUpdate,
    };
  }
  return s.attacks.tide;
}

// ------------------------------------------------------------------------------------------
// Lens: marking beams
// ------------------------------------------------------------------------------------------

const MARK_TICK = 0.1;

function markScore(sim, e, mode, t) {
  switch (mode) {
    case 'first': return -toCore(sim, e);
    case 'last': return toCore(sim, e);
    case 'close': { const dx = e.x - t.x, dy = e.y - t.y; return -(dx * dx + dy * dy); }
    default: return (e.titan !== null ? 1e13 : 0) + (e.ship ? 1e12 : 0) + massOf(e) * 1000 - toCore(sim, e) * 1e-3;
  }
}

function markUpdate(sim, t, a, dt) {
  let d = t.data._field_mark;
  if (!d) d = t.data._field_mark = { ids: [], acc: MARK_TICK, q: [], cand: [] };
  const byRange = a.range;
  // Keep live targets that are still in the field.
  for (let k = d.ids.length - 1; k >= 0; k--) {
    const e = sim.getEnemy(d.ids[k]);
    let ok = !!e && !e.dead;
    if (ok) { const dx = e.x - t.x, dy = e.y - t.y, rr = byRange + e.radius; ok = dx * dx + dy * dy <= rr * rr; }
    if (!ok) d.ids.splice(k, 1);
  }
  d.acc += dt;
  if (d.acc >= MARK_TICK) {
    d.acc -= MARK_TICK;
    // Re-pick the best targets for the tower's targeting mode, so a ship entering the field
    // takes a beam at once.
    const q = sim.grid.query(t.x, t.y, byRange, d.q);
    const cand = d.cand; cand.length = 0;
    for (let i = 0; i < q.length; i++) {
      const e = q[i];
      if (e.dead || !onScreen(e)) continue;
      e._gk = markScore(sim, e, t.targeting, t);
      cand.push(e);
    }
    cand.sort((p, r) => r._gk - p._gk);
    d.ids.length = 0;
    for (let i = 0; i < cand.length && d.ids.length < a.beams; i++) d.ids.push(cand[i].id);
    if (d.ids.length) {
      const src = normSrc(a);
      const fx = a._markFx || (a._markFx = { expose: { t: 0.4, mult: a.mult } });
      for (const id of d.ids) { const e = sim.getEnemy(id); if (e && !e.dead) sim.applyEffects(e, fx, src); }
    }
  }
  if (!d.ids.length) return;
  // Beam visuals (the renderer draws tower.data.beams; the engine clears it every tick).
  const beams = t.data.beams || (t.data.beams = []);
  const pool = d.pool || (d.pool = []);
  for (let k = 0; k < d.ids.length; k++) {
    const e = sim.getEnemy(d.ids[k]);
    if (!e || e.dead) continue;
    let b = pool[k];
    if (!b) b = pool[k] = { x1: 0, y1: 0, x2: 0, y2: 0, width: 3, color: '#ffe28a', ramp: 1, dtype: 'VOID', targetId: -1 };
    b.x1 = t.x; b.y1 = t.y; b.x2 = e.x; b.y2 = e.y;
    b.width = a.width; b.color = a.color; b.targetId = e.id;
    beams.push(b);
  }
}

function mark(s) {
  if (!s.attacks.mark) {
    s.attacks.mark = {
      kind: 'custom', dtype: 'VOID', damage: 0, needsTarget: false,
      beams: 1, mult: 1.5, width: 3, color: '#ffe28a', update: markUpdate,
    };
  }
  return s.attacks.mark;
}

function stripPhantom(sim, t, e) { if (e.phantom) e.phantom = false; }

// ------------------------------------------------------------------------------------------
// Tower definition
// ------------------------------------------------------------------------------------------

export default {
  id: 'gravity',
  name: 'Gravity Well',
  hotkey: 'f',
  cost: 400,
  radius: 22,
  blurb: 'Slows everything in its field.',
  desc: 'Bends gravity so meteors in its field move 40% slower (ships 15% slower, Storm Titans half as much as ships). Deals no damage until upgraded.',
  art: {
    sprite: 'tower_gravity', rotates: false, color: '#a78bfa', accent: '#e0c3ff', shape: 'circle', barrels: 0,
    variant(levels) { return levels[0] >= 3 ? 1 : levels[1] >= 3 ? 2 : levels[2] >= 3 ? 3 : 0; },
  },
  base: {
    range: 105,
    detection: false,
    targetModes: ['strong', 'first', 'last', 'close'],
    attacks: {
      field: {
        kind: 'field', dtype: 'ENERGY', damage: 0,
        slow: { mult: 0.6, shipMult: 0.85 },
        color: '#a78bfa',
      },
    },
    aura: null,
    income: null,
    abilities: [],
  },
  paths: [
    {
      name: 'Crusher',
      upgrades: [
        { name: 'Crush Field', cost: 240, desc: 'Meteors in the field take 1 ENERGY damage per second, up to 4 at once.',
          apply(s) { const c = crush(s); c.dps = 1; c.max = 4; } },
        { name: 'Dense Core', cost: 460, desc: 'Crushing deals 1.5 damage per second to up to 6 meteors, and the field is 15 wider.',
          apply(s) { const c = crush(s); c.dps = 1.5; c.max = 6; s.range += 15; } },
        { name: 'Graviton Press', cost: 1500, desc: 'Every 2.5 s the well implodes for 2 damage (8 to ships) on up to 16 meteors; crushing deals 2 per second to 8.',
          apply(s) {
            const c = crush(s); c.dps = 2; c.max = 8;
            const im = implode(s); im.damage = 2; im.shipDamage = 6; im.cooldown = 2.5; im.pierce = 16;
            field(s).color = '#d45dff';
          } },
        { name: 'Neutron Core', cost: 5200, desc: 'Crushing deals 3 per second to 12 meteors, implosions deal 4 (16 to ships) every 1.5 s, and both now hurt Prism.',
          apply(s) {
            const c = crush(s); c.dps = 3; c.max = 12; c.bypass = [...(c.bypass || []), 'prism'];
            const im = implode(s); im.damage = 4; im.shipDamage = 12; im.cooldown = 1.5; im.pierce = 24;
            im.bypass = [...(im.bypass || []), 'prism'];
            field(s).color = '#e04dff';
          } },
        { name: 'Event Horizon', cost: 26000, desc: 'Crushing turns VOID and hits everything for 10 per second, implosions deal 16 (80 to ships) every 1 s, the field grows 30 wider, and Black Hole unlocks.',
          apply(s) {
            const c = crush(s); c.dps = 10; c.max = 30; c.dtype = 'VOID';
            const im = implode(s); im.damage = 16; im.shipDamage = 64; im.cooldown = 1; im.pierce = 50; im.dtype = 'VOID'; im.color = '#b86bff';
            const f = field(s); f.dtype = 'VOID'; f.color = '#7b2cff';
            s.range += 30;
            s.abilities.push(blackHole);
          } },
      ],
    },
    {
      name: 'Undertow',
      upgrades: [
        { name: 'Reverse Drift', cost: 220, desc: 'The field pulls meteors back 30 units per second, up to 100 units each.',
          apply(s) { const w = tide(s); w.pull = 30; w.cap = 100; } },
        { name: 'Deep Current', cost: 420, desc: 'Pulls meteors back 50 units per second (up to 160 each), and the field is 15 wider.',
          apply(s) { const w = tide(s); w.pull = 50; w.cap = 160; s.range += 15; } },
        { name: 'Riptide Surge', cost: 1400, desc: 'Every 3 s a surge knocks meteors in the field 60 units back; pull rises to 70 per second, up to 260 each.',
          apply(s) {
            const w = tide(s); w.pull = 70; w.cap = 260; w.surge = 60; w.surgeEvery = 3;
            field(s).color = '#4de8e0';
          } },
        { name: 'Tidal Lock', cost: 4800, desc: 'Drags ships back 14 units per second (up to 120 each, never Storm Titans) and slows them 25% (Titans half as much); meteor pull rises to 100.',
          apply(s) {
            const w = tide(s); w.pull = 100; w.cap = 360; w.surge = 80;
            w.shipPull = 14; w.shipCap = 120; w.shipSurge = 25;
            field(s).slow.shipMult = 0.75;
            field(s).color = '#2fd6ff';
          } },
        { name: 'Rewind Field', cost: 22000, desc: 'Every 2.5 s the field rewinds meteors 180 units (ships 70); it grows 35 wider, slows meteors 55% (ships 35%) and pulls up to 700 units each.',
          apply(s) {
            const w = tide(s); w.pull = 160; w.cap = 700; w.surge = 180; w.surgeEvery = 2.5;
            w.shipPull = 30; w.shipCap = 320; w.shipSurge = 70;
            const f = field(s); f.slow.mult = Math.min(f.slow.mult, 0.45); f.slow.shipMult = 0.65; f.color = '#7df9ff';
            s.range += 35;
          } },
      ],
    },
    {
      name: 'Lens',
      upgrades: [
        { name: 'Scanner Lens', cost: 200, desc: 'Meteors in the field lose Phantom cover, so every tower can target them there.',
          apply(s) { field(s).expose = { mult: 1 }; } },
        { name: 'Stress Lens', cost: 380, desc: 'Meteors in the field take 15% more damage from every source, and the field is 10 wider.',
          apply(s) { const f = field(s); f.expose = { mult: 1.15 }; s.range += 10; } },
        { name: 'Focal Beam', cost: 1400, desc: 'A focusing beam marks the strongest target in the field to take 50% more damage; the field amplifies damage by 20%.',
          apply(s) {
            const f = field(s); f.expose = { mult: 1.2 }; f.color = '#ffd166';
            const m = mark(s); m.beams = 1; m.mult = 1.5;
          } },
        { name: 'Twin Focus', cost: 4600, desc: 'Marks 2 targets for 75% more damage, and the field amplifies damage by 30%.',
          apply(s) {
            const f = field(s); f.expose = { mult: 1.3 };
            const m = mark(s); m.beams = 2; m.mult = 1.75; m.width = 4;
          } },
        { name: 'Quantum Lens', cost: 20000, desc: 'The field grows 40 wider, amplifies damage by 50% and strips Phantom for good; 4 beams mark targets for double damage.',
          apply(s) {
            const f = field(s); f.expose = { mult: 1.5 }; f.onTick = stripPhantom; f.color = '#ffc940';
            const m = mark(s); m.beams = 4; m.mult = 2; m.width = 5; m.color = '#fff3b0';
            s.range += 40;
          } },
      ],
    },
  ],
};
