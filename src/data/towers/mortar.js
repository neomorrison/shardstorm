// Orbital Mortar: BLAST shells on a chosen ground point anywhere on the map. Pure data.
// Prices follow docs/ECONOMY.md 2.4 for base b = 650:
//   T1 260..780, T2 520..1625, T3 1300..5200, T4 5200..19500, T5 26000..97500.
//
// The main attack is the engine's `mortar` kind (aim = tower.aim, default the nearest channel
// point). Burning ground (Incendiary T3+) and aftershocks (Big Shell T4+) come from a `custom` attack
// ("fx") that runs right after `main` in the same tick: it spots the shells `main` just fired
// (the tail of sim.state.projectiles, still at prog 0) and acts where they land. Its state lives
// in tower.data._field_* so the engine clears it with the rest of the field state when a wave
// ends (saves never carry it, so loaded runs stay identical to live ones).

const TAU = Math.PI * 2;
const main = (s) => s.attacks.main;
const splash = (s) => s.attacks.main.splash;
const addOnHit = (sp, fx) => { sp.onHit = { ...(sp.onHit || {}), ...fx }; };

// Remaining mass of an enemy (shell + children + Titan shield).
const massOf = (e) => e.hp + (e.childMass || 0) + (e.titan ? e.titan.shield : 0);
const onScreen = (e) => e.x > 0 && e.x < 1500 && e.y > 0 && e.y < 1000;
const blastOk = (e, bypass) => e.def.immune.indexOf('BLAST') < 0 || (bypass && bypass.indexOf('BLAST') >= 0);

// ------------------------------------------------------------------------------------------
// Shell effects: burning ground and aftershocks
// ------------------------------------------------------------------------------------------

const PATCH_TICK = 0.25;       // seconds between burning ground ticks
const MAX_PATCHES = 16;        // per tower (oldest burns out first)

function fxState(t) {
  let d = t.data._field_shellfx;
  if (!d) d = t.data._field_shellfx = { pend: [], patches: [], acc: 0, q: [] };
  return d;
}

function shellFx(sim, t, a, dt) {
  const st = sim.state;
  const now = st.time;
  const d = fxState(t);
  // Shells `main` fired this tick sit at the end of the projectile list with prog 0.
  const projs = st.projectiles;
  for (let i = projs.length - 1; i >= 0; i--) {
    const p = projs[i];
    if (p.towerId !== t.id || !p.mortar || p.prog !== 0) break;
    if (d.pend.length < 96) d.pend.push({ x: p.tx, y: p.ty, r: p.splash ? p.splash.radius : 50, at: now + p.flight - sim.TICK * 0.5 });
  }
  if (d.pend.length) {
    let w = 0;
    for (let i = 0; i < d.pend.length; i++) {
      const s = d.pend[i];
      if (now >= s.at) land(sim, t, a, d, s);
      else d.pend[w++] = s;
    }
    d.pend.length = w;
  }
  if (d.patches.length) burnGround(sim, t, a, d, dt);
}

function land(sim, t, a, d, s) {
  if (a.patchTime > 0) {
    if (d.patches.length >= MAX_PATCHES) d.patches.shift();
    const r = s.r * a.patchScale;
    d.patches.push({ x: s.x, y: s.y, r, t: a.patchTime, glow: 0 });
    sim.emit({ t: 'pulse', tower: t.id, type: t.type, x: s.x, y: s.y, r, dtype: 'THERMAL', color: '#ff8a3d', visual: 'fire' });
  }
  if (a.aftershocks > 0) {
    const n = a.aftershocks;
    const R = s.r * 0.72;
    const rot = sim.rng() * TAU;
    const sp = { radius: a.aftershockRadius, damage: a.aftershockDamage, pierce: 60, dtype: 'BLAST', shipDamage: a.aftershockShip, bypass: a.bypass && a.bypass.length ? a.bypass : undefined };
    const src = { tower: t, attackKey: 'aftershock', dtype: 'BLAST', bypass: sp.bypass };
    for (let k = 0; k < n; k++) {
      const g = rot + (TAU * k) / n;
      const x = s.x + Math.cos(g) * R, y = s.y + Math.sin(g) * R;
      sim.after(0.22 + k * 0.05, (S) => { if (S.getTower(t.id) === t) S.explode(x, y, sp, src); });
    }
  }
}

function burnGround(sim, t, a, d, dt) {
  d.acc += dt;
  if (d.acc < PATCH_TICK) return;
  d.acc -= PATCH_TICK;
  const src = a._src;
  if (!src._norm) src._norm = true;
  let fx = a._burnFx;
  if (!fx) fx = a._burnFx = { burn: { dps: a.patchDps, t: a.patchBurnT } };
  const max = a.patchMax;
  for (let k = d.patches.length - 1; k >= 0; k--) {
    const P = d.patches[k];
    const q = sim.grid.query(P.x, P.y, P.r, d.q);
    // Each patch ignites at most patchMax meteors per tick (area damage needs a pierce cap).
    for (let i = 0, n = 0; i < q.length && n < max; i++) {
      const e = q[i];
      if (e.dead || e.def.immune.indexOf('THERMAL') >= 0) continue;
      sim.applyEffects(e, fx, src);
      n++;
    }
    P.glow -= PATCH_TICK;
    if (P.glow <= 0) {
      P.glow = 0.75;
      sim.emit({ t: 'pulse', tower: t.id, type: t.type, x: P.x, y: P.y, r: P.r, dtype: 'THERMAL', color: '#ff6a1a', visual: 'fire' });
    }
    P.t -= PATCH_TICK;
    if (P.t <= 0) d.patches.splice(k, 1);
  }
}

// The fx attack is added by the first upgrade that needs it; later upgrades tune it.
function fx(s) {
  if (!s.attacks.fx) {
    s.attacks.fx = {
      kind: 'custom', dtype: 'THERMAL', damage: 0, needsTarget: false,
      patchTime: 0, patchScale: 0.85, patchDps: 0, patchBurnT: 2, patchMax: 12,
      aftershocks: 0, aftershockRadius: 0, aftershockDamage: 0, aftershockShip: 0,
      update: shellFx,
    };
  }
  return s.attacks.fx;
}

// ------------------------------------------------------------------------------------------
// Barrage Command ability
// ------------------------------------------------------------------------------------------

const BARRAGE_SHELLS = 40;
const barrageQ = [];           // scratch for grid queries (reused synchronously)
const BARRAGE_EVERY = 0.1;

// Strongest ship BLAST can hurt; else the densest cluster of meteors BLAST can hurt.
function barrageTarget(sim, radius) {
  const list = sim.state.enemies;
  let best = null, bestM = 0;
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (e.dead || !e.ship || !onScreen(e) || !blastOk(e, null)) continue;
    const m = massOf(e);
    if (m > bestM) { bestM = m; best = e; }
  }
  if (best) return best;
  const n = list.length;
  const step = Math.max(1, Math.floor(n / 120));
  const q = barrageQ;
  for (let i = 0; i < n; i += step) {
    const e = list[i];
    if (e.dead || !onScreen(e)) continue;
    const near = sim.grid.query(e.x, e.y, radius, q);
    let m = 0;
    for (let k = 0; k < near.length; k++) { const o = near[k]; if (!o.dead && blastOk(o, null)) m += massOf(o); }
    if (m > bestM) { bestM = m; best = e; }
  }
  return best;
}

// Spawn one arcing shell from the tower to (tx, ty) using the public projectile helper.
function launchShell(sim, tower, tx, ty, o) {
  const sp = { radius: o.radius, damage: o.damage, pierce: o.pierce, dtype: 'BLAST', shipDamage: o.shipDamage, onHit: o.onHit };
  const p = sim.spawnProjectile({
    x: tower.x, y: tower.y, tower, speed: 1, damage: 0, pierce: 1, dtype: 'BLAST',
    lifetime: o.flight, visual: 'shell', color: o.color, projRadius: o.projRadius, splash: sp, attackKey: 'barrage',
  });
  p.mortar = true;
  p.x0 = tower.x; p.y0 = tower.y; p.tx = tx; p.ty = ty;
  p.flight = o.flight; p.prog = 0; p.arc = o.arc;
  p.vx = 0; p.vy = 0; p.speed = 0;
  p.life = o.flight; p.maxLife = o.flight;
  p.scale = o.scale;
  p.angle = Math.atan2(ty - tower.y, tx - tower.x);
  return p;
}

const BARRAGE_SHELL = {
  radius: 72, damage: 12, pierce: 40, shipDamage: 60, onHit: { stun: { t: 0.6, shipT: 0.15 } },
  flight: 0.75, arc: 220, scale: 1.25, projRadius: 9, color: '#ffd23d',
};

function barrageStep(sim, tower) {
  if (sim.getTower(tower.id) !== tower) return; // sold mid-barrage
  const d = tower.data._field_barrage || (tower.data._field_barrage = { id: -1, until: -1 });
  let tg = d.id >= 0 ? sim.getEnemy(d.id) : null;
  if (!tg || tg.dead || sim.state.time >= d.until || !onScreen(tg)) {
    tg = barrageTarget(sim, 80);
    d.id = tg ? tg.id : -1;
    d.until = sim.state.time + 0.6;
  }
  if (!tg) return;
  const rr = 34 * Math.sqrt(sim.rng()), th = sim.rng() * TAU;
  const p = launchShell(sim, tower, tg.x + Math.cos(th) * rr, tg.y + Math.sin(th) * rr, BARRAGE_SHELL);
  sim.emit({ t: 'shot', tower: tower.id, type: tower.type, x: tower.x, y: tower.y, angle: p.angle, visual: 'shell', dtype: 'BLAST', attack: 'barrage' });
}

const barrage = {
  id: 'barrage',
  name: 'Barrage',
  icon: 'barrage',
  cooldown: 45,
  duration: 4,
  desc: '40 heavy shells rain on the strongest ship (or the densest meteor cluster) over 4 s, each dealing 12 damage (72 to ships) to up to 40 enemies within 72 units and stunning meteors for 0.6 s and ships for 0.15 s.',
  activate(sim, tower) {
    for (let k = 0; k < BARRAGE_SHELLS; k++) sim.after(k * BARRAGE_EVERY, (s) => barrageStep(s, tower));
    // Mark the first target so the player sees where the barrage will land.
    const tg = barrageTarget(sim, 80);
    if (tg) sim.emit({ t: 'abilityFx', id: 'barrage', x: tg.x, y: tg.y, r: 90 });
  },
};

// ------------------------------------------------------------------------------------------
// Tower definition
// ------------------------------------------------------------------------------------------

export default {
  id: 'mortar',
  name: 'Orbital Mortar',
  hotkey: 'd',
  cost: 650,
  radius: 22,
  blurb: 'Shells any spot on the map.',
  desc: 'Lobs BLAST shells at a target point anywhere on the map (Set Target in the tower panel). Blasts hit Phantoms they touch but cannot hurt Magma meteors or Geodes.',
  art: {
    sprite: 'tower_mortar', rotates: false, color: '#e8454b', accent: '#ffd166', shape: 'oct', barrels: 1,
    variant(levels) { return levels[0] >= 3 ? 1 : levels[1] >= 3 ? 2 : levels[2] >= 3 ? 3 : 0; },
  },
  base: {
    range: 9999,              // global: shells land anywhere (UI shows "Global")
    detection: false,
    targetModes: ['manual'],  // aims at tower.aim, never at enemies
    attacks: {
      main: {
        kind: 'mortar', cooldown: 1.2, dtype: 'BLAST', count: 1,
        inaccuracy: 28, flightTime: 0.9, arc: 150, projRadius: 8,
        splash: { radius: 54, damage: 1, pierce: 24 },
        visual: 'shell', color: '#ff5d5d',
      },
    },
    aura: null,
    income: null,
    abilities: [],
  },
  paths: [
    {
      name: 'Big Shell',
      upgrades: [
        { name: 'Heavy Shells', cost: 480, desc: 'Explosions are 15% wider, deal 2 damage and hit up to 32 meteors.',
          apply(s) { const sp = splash(s); sp.radius += 8; sp.pierce += 8; sp.damage += 1; } },
        { name: 'Dense Charge', cost: 520, desc: 'Blasts grow another 15% wider, deal 4 damage (6 to ships) and hit up to 40 meteors.',
          apply(s) { const sp = splash(s); sp.damage += 2; sp.radius += 8; sp.pierce += 8; sp.shipDamage = (sp.shipDamage || 0) + 2; } },
        { name: 'Siege Shells', cost: 2000, desc: 'Fires huge siege shells that deal 7 damage (20 to ships) to up to 50 meteors in a bigger blast.',
          apply(s) {
            const a = main(s), sp = a.splash;
            sp.damage += 3; sp.radius += 14; sp.pierce += 10; sp.shipDamage = (sp.shipDamage || 0) + 11;
            a.scale = 1.6; a.projRadius = 9; a.arc = 210; a.color = '#ff9f43'; a.inaccuracy *= 0.85;
          } },
        { name: 'Tectonic Charge', cost: 6500, desc: 'Blasts deal 14 damage (56 to ships) in a wider radius, hit up to 100 meteors, stun them for 0.4 s and set off 3 aftershocks that deal 7 damage (27 to ships).',
          apply(s) {
            const a = main(s), sp = a.splash;
            sp.damage += 7; sp.radius += 26; sp.pierce += 50; sp.shipDamage = (sp.shipDamage || 0) + 29;
            addOnHit(sp, { stun: { t: 0.4, shipT: 0 } });
            a.scale = 1.9; a.arc = 260; a.color = '#ff7a1a';
            const f = fx(s);
            f.aftershocks = 3; f.aftershockRadius = 50; f.aftershockDamage = 7; f.aftershockShip = 20;
          } },
        { name: 'Doomsday Battery', cost: 26000, desc: 'Fires 3 doomsday shells per volley that deal 40 damage (200 to ships) to up to 300 targets in enormous blasts, stun meteors for 1 s and ships for 0.3 s, ignore BLAST immunity and set off 6 aftershocks each that deal 15 damage (60 to ships).',
          apply(s) {
            const a = main(s), sp = a.splash;
            sp.damage += 26; sp.radius += 64; sp.pierce += 200; sp.shipDamage = (sp.shipDamage || 0) + 118;
            addOnHit(sp, { stun: { t: 1, shipT: 0.3 } });
            a.bypass = [...(a.bypass || []), 'BLAST'];
            a.count = Math.max(3, a.count || 1);
            a.scale = 2; a.projRadius = 10; a.arc = 300; a.flightTime += 0.25; a.color = '#fff3b0';
            const f = fx(s);
            f.aftershocks = 6; f.aftershockRadius = 70; f.aftershockDamage = 15; f.aftershockShip = 45;
            f.bypass = ['BLAST'];
          } },
      ],
    },
    {
      name: 'Incendiary',
      upgrades: [
        { name: 'Hot Shells', cost: 330, desc: 'Explosions ignite meteors for 1 extra THERMAL damage over 1 s.',
          apply(s) { addOnHit(splash(s), { burn: { dps: 1, t: 1 } }); } },
        { name: 'Thermite Fill', cost: 700, desc: 'Burn deals 2 damage per second for 1.5 s, and explosions are 15% wider.',
          apply(s) { const sp = splash(s); sp.onHit.burn = { dps: 2, t: 1.5 }; sp.radius += 8; } },
        { name: 'Napalm Shells', cost: 1600, desc: 'Shells leave burning ground for 3 s that ignites up to 10 meteors at a time for 3 THERMAL damage per second, Magma included.',
          apply(s) {
            const a = main(s);
            a.color = '#ff7a1a';
            const f = fx(s);
            f.patchTime = 3; f.patchScale = 0.85; f.patchDps = 3; f.patchBurnT = 1; f.patchMax = 10;
          } },
        { name: 'Inferno Rounds', cost: 5800, desc: 'Blasts deal 2 damage and burn for 5 per second over 2 s; burning ground lasts 4 s, spreads 30% wider and ignites up to 16 meteors for 5 per second over 2 s.',
          apply(s) {
            const a = main(s), sp = a.splash;
            sp.damage += 1;
            sp.onHit.burn = { dps: 5, t: 2 };
            a.color = '#ff4d1a'; a.scale = Math.max(a.scale || 1, 1.2);
            const f = fx(s);
            f.patchTime = 4; f.patchScale = 1.1; f.patchDps = 5; f.patchBurnT = 2; f.patchMax = 16;
          } },
        { name: 'Firestorm', cost: 26000, desc: 'Fires 3 shells per volley twice as fast; blasts deal 6 damage (40 to ships) and burn for 20 per second over 2.5 s, and burning ground lasts 6 s, spreads 9% wider and ignites up to 40 meteors for 20 per second over 2.5 s.',
          apply(s) {
            const a = main(s), sp = a.splash;
            sp.damage += 4; sp.shipDamage = (sp.shipDamage || 0) + 34;
            sp.onHit.burn = { dps: 20, t: 2.5 };
            a.count = Math.max(3, a.count || 1); a.cooldown *= 0.5; a.inaccuracy += 16;
            a.color = '#ffe14d'; a.scale = Math.max(a.scale || 1, 1.35);
            const f = fx(s);
            f.patchTime = 6; f.patchScale = 1.2; f.patchDps = 20; f.patchBurnT = 2.5; f.patchMax = 40;
          } },
      ],
    },
    {
      name: 'Rapid',
      upgrades: [
        { name: 'Quick Loader', cost: 260, desc: 'Fires 25% faster.',
          apply(s) { main(s).cooldown *= 0.8; } },
        { name: 'Fast Fuse', cost: 520, desc: 'Shells land 40% sooner, fire 33% faster and deal 2 damage.',
          apply(s) { const a = main(s); a.flightTime *= 0.6; a.cooldown *= 0.75; a.arc = 110; a.splash.damage += 1; } },
        { name: 'Shock Shells', cost: 1300, desc: 'Fires 2 shells per volley for 3 damage each, and every blast stuns meteors for 0.5 s.',
          apply(s) {
            const a = main(s);
            a.count = Math.max(2, a.count || 1); a.inaccuracy += 14; a.scale = 0.9; a.color = '#7fe9ff';
            a.splash.damage += 1;
            addOnHit(a.splash, { stun: { t: 0.5, shipT: 0 } });
          } },
        { name: 'Autoloader', cost: 5600, desc: 'Fires 3 shells per volley 43% faster; blasts deal 4 damage and stun ships for 0.25 s.',
          apply(s) {
            const a = main(s), sp = a.splash;
            a.count = Math.max(3, a.count || 1); a.cooldown *= 0.7;
            sp.damage += 1;
            addOnHit(sp, { stun: { t: 0.5, shipT: 0.25 } });
          } },
        { name: 'Barrage Command', cost: 27000, desc: 'Fires 4 shells per volley 67% faster; wider blasts deal 7 damage (27 to ships) to up to 48 meteors and stun meteors for 0.8 s and ships for 0.3 s. Unlocks Barrage: 40 shells rain on the strongest ship.',
          apply(s) {
            const a = main(s), sp = a.splash;
            a.count = Math.max(4, a.count || 1); a.cooldown *= 0.6; a.color = '#ffd23d';
            sp.damage += 3; sp.shipDamage = (sp.shipDamage || 0) + 20; sp.pierce += 24; sp.radius += 10;
            addOnHit(sp, { stun: { t: 0.8, shipT: 0.3 } });
            s.abilities.push(barrage);
          } },
      ],
    },
  ],
};
