// Renderer test bench. Open tools/render-test.html with a scene:
//   ?scene=showcase   (default) every tower look, enemy type, modifier, status, ship, titan,
//                     projectile visual, beam, zap and effect, animated with a fake state
//   ?scene=early      a calm early-game look (few towers, small shards)
//   ?scene=heavy      perf: 1500 enemies + 800 projectiles + 60 towers, reports frame times
//   ?scene=sim        the real Sim (src/sim/game.js) running waves at 3x
//   ?scene=icons      drawTowerIcon / drawEnemyIcon / drawTitanIcon grid
// Options: &img=1 loads assets/manifest.json (or &manifest=../assets/manifest.art.json)
//          &map=crater|frost|dock|ember|prism  (fake-state scenes)
//          &focus=x,y,zoom  magnify around a world point for close inspection
//          &ghost=bad  invalid placement ghost, &ranges=1  show all ranges
//          &low=1 particles low, &wave=N (sim scene fast-forward), &speed=N (sim scene)
//          &frames=N (heavy bench length), &gov=0 disable the load governor, &prof=1 layer timings
//          &warm=S seconds of simulated warm-up before the first shown frame
// Screenshot: node tools/snap.mjs --path "/tools/render-test.html?scene=showcase" --wait 1500 --shot out/render.png
// Results are printed with console.log (tools/snap.mjs shows them) and kept in window.__rt.

import { Renderer, drawTowerIcon, drawEnemyIcon, drawTitanIcon, loadAssets } from '../src/render/renderer.js';
import { EMPTY_ASSETS } from '../src/render/sprites.js';
import { MAPS } from '../src/data/maps.js';
import { ENEMIES } from '../src/data/enemies.js';
import { Path } from '../src/sim/path.js';

const params = new URLSearchParams(location.search);
const SCENE = params.get('scene') || 'showcase';
const hud = document.getElementById('hud');
const canvas = document.getElementById('game');
window.__rt = { scene: SCENE, ready: false };

// ---------------------------------------------------------------------------
// Deterministic helpers
// ---------------------------------------------------------------------------
function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const R = mulberry(12345);

// ---------------------------------------------------------------------------
// Tower defs: real ones when the registry has them, test stand-ins otherwise
// ---------------------------------------------------------------------------
const FAKE_DEFS = {
  pulse: { id: 'pulse', radius: 20, art: { color: '#4cc9f0', accent: '#f9c74f', shape: 'hex', barrels: 1, rotates: true }, base: { range: 150 } },
  scatter: { id: 'scatter', radius: 22, art: { color: '#9b5de5', accent: '#f15bb5', shape: 'oct', rotates: false }, base: { range: 110 } },
  rail: { id: 'rail', radius: 21, art: { color: '#3a5a9f', accent: '#ffd23d', shape: 'diamond', rotates: true }, base: { range: Infinity } },
  missile: { id: 'missile', radius: 22, art: { color: '#ff9f43', accent: '#e8f6ff', shape: 'square', barrels: 2, rotates: true }, base: { range: 190 } },
  cryo: { id: 'cryo', radius: 22, art: { color: '#7fdcff', accent: '#e8fbff', shape: 'circle', rotates: false }, base: { range: 120 } },
  tesla: { id: 'tesla', radius: 22, art: { color: '#5fd4ff', accent: '#ffd23d', shape: 'oct', rotates: false }, base: { range: 140 } },
  laser: { id: 'laser', radius: 23, art: { color: '#e8eef7', accent: '#ff5d6d', shape: 'hex', rotates: true }, base: { range: 190 } },
  drone: { id: 'drone', radius: 24, art: { color: '#5fd4ff', accent: '#ffd23d', shape: 'square', rotates: false }, base: { range: 260 } },
  mortar: { id: 'mortar', radius: 23, art: { color: '#d64545', accent: '#ffd23d', shape: 'circle', rotates: true }, base: { range: Infinity } },
  gravity: { id: 'gravity', radius: 22, art: { color: '#8a5cf6', accent: '#c77dff', shape: 'oct', rotates: false }, base: { range: 120 } },
  rig: { id: 'rig', radius: 24, art: { color: '#e0a526', accent: '#5fd4ff', shape: 'square', rotates: false }, base: { range: 0 } },
  beacon: { id: 'beacon', radius: 22, art: { color: '#3a6fd6', accent: '#ffd23d', shape: 'circle', rotates: false }, base: { range: 180 } },
  vega: { id: 'vega', radius: 20, hero: { maxLevel: 20 }, art: { color: '#3a86ff', accent: '#ffd76a', rotates: true }, base: { range: 170 } },
  nova: { id: 'nova', radius: 20, hero: { maxLevel: 20 }, art: { color: '#b14dff', accent: '#ff9cf5', rotates: false }, base: { range: 160 } },
  brick: { id: 'brick', radius: 22, hero: { maxLevel: 20 }, art: { color: '#ff9f43', accent: '#ffd76a', rotates: true }, base: { range: 180 } },
};
let DEFS = { ...FAKE_DEFS };
async function loadDefs() {
  try {
    const m = await import('../src/data/towers/index.js');
    for (const [id, d] of Object.entries(m.TOWERS || {})) DEFS[id] = d;
  } catch { /* stand-ins only */ }
  try {
    const m = await import('../src/data/heroes.js');
    for (const [id, d] of Object.entries(m.HEROES || {})) DEFS[id] = d;
  } catch { /* stand-ins only */ }
}

// ---------------------------------------------------------------------------
// Fake sim state
// ---------------------------------------------------------------------------
class FakeSim {
  constructor(mapId = 'crater') {
    this.map = MAPS[mapId];
    this.paths = this.map.paths.map((p) => new Path(p, { step: 2, width: this.map.pathWidth }));
    this.state = {
      tick: 0, time: 0, phase: 'wave', wave: 24, cleared: 23, cash: 4321, lives: 150, maxLives: 150,
      enemies: [], towers: [], projectiles: [], drones: [], titan: null,
    };
    this.events = [];
    this.nextId = 1;
    this.pt = { x: 0, y: 0, angle: 0 };
    this.timers = {};
  }
  drainEvents() { const e = this.events; this.events = []; return e; }
  emit(e) { this.events.push(e); }
  lanePoint(lane, d) { return this.paths[lane % this.paths.length].pointAt(d, this.pt); }
  spot(d, side, off = 40, lane = 0) {
    const p = this.lanePoint(lane, d);
    const nx = -Math.sin(p.angle), ny = Math.cos(p.angle);
    const o = this.map.pathWidth / 2 + off;
    return { x: p.x + nx * side * o, y: p.y + ny * side * o };
  }
  addTower(type, x, y, levels = [0, 0, 0], extra = {}) {
    const def = DEFS[type];
    const range = (def.base && def.base.range) || 150;
    const t = {
      id: this.nextId++, type, def, x, y, angle: -Math.PI / 2 + R() * 2, radius: def.radius || 22,
      levels, stats: { range, attacks: {}, aura: null }, data: {}, hero: def.hero ? { level: extra.level || 1, xp: 0 } : null,
      disabledT: 0, target: null, ...extra,
    };
    if (type === 'gravity') t.stats.attacks.field = { kind: 'field', radius: 115, color: '#b36bff', pull: levels[1] > 0 ? 20 : 0 };
    if (type === 'beacon') t.stats.aura = { radius: 170 };
    this.state.towers.push(t);
    return t;
  }
  addEnemy(type, d, o = {}) {
    const def = o.def || ENEMIES[type];
    const e = {
      id: this.nextId++, type, def, lane: o.lane || 0, d, x: 0, y: 0, angle: 0, radius: def.radius,
      hp: o.hp ?? def.hp, maxHp: def.hp, phantom: !!(o.phantom || def.phantom), nanite: !!o.nanite, plated: !!o.plated,
      slowMult: o.slow ? 0.5 : 1, slowT: o.slow ? 99 : 0, frozenT: o.frozen ? 99 : 0, stunT: o.stun ? 99 : 0,
      burn: o.burn ? [{ dps: 1, t: 99 }] : null, exposedT: 0, titan: o.titan || null, dead: false,
      speed: (o.speed ?? def.speed) * 90 * (o.speedScale ?? 0.3), off: o.off || 0,
    };
    this._place(e);
    this.state.enemies.push(e);
    return e;
  }
  _place(e) {
    const path = this.paths[e.lane % this.paths.length];
    const p = path.pointAt(e.d, this.pt);
    e.x = p.x - Math.sin(p.angle) * e.off; e.y = p.y + Math.cos(p.angle) * e.off; e.angle = p.angle;
  }
  step(dt) {
    const st = this.state;
    st.time += dt; st.tick++;
    for (const e of st.enemies) {
      if (!(e.frozenT > 0 || e.stunT > 0)) e.d += e.speed * (e.slowT > 0 ? 0.5 : 1) * dt;
      const L = this.paths[e.lane % this.paths.length].length;
      if (e.d > L - 40) e.d = 40 + (e.d - (L - 40));
      this._place(e);
    }
  }
}

function titanDef(kind) {
  const color = { maw: '#ff5d73', aegis: '#5dd6ff', rift: '#b36bff' }[kind];
  return { id: 'titan', name: kind, kind: 'ship', titan: true, titanKind: kind, speed: 0.2, hp: 9600, immune: [], children: [], radius: 80, color };
}

// ---------------------------------------------------------------------------
// Showcase scene
// ---------------------------------------------------------------------------
function buildShowcase(sim, { early = false } = {}) {
  const tw = (type, d, side, levels, extra) => { const p = sim.spot(d, side, extra && extra.off || 40); return sim.addTower(type, p.x, p.y, levels, extra); };
  if (early) {
    tw('pulse', 330, 1, [0, 0, 0]);
    tw('pulse', 600, -1, [1, 1, 0]);
    tw('missile', 1350, 1, [1, 0, 0]);
    tw('pulse', 2150, -1, [2, 0, 1]);
    const types = ['rust', 'rust', 'cobalt', 'rust', 'cobalt', 'jade', 'rust', 'rust', 'cobalt'];
    for (let i = 0; i < 26; i++) sim.addEnemy(types[i % types.length], 120 + i * 58, { off: (R() - 0.5) * 12, lane: i % sim.paths.length });
    sim.state.wave = 6; sim.state.cleared = 5;
    return;
  }
  // Towers of many types and tiers along the channel
  tw('pulse', 250, 1, [0, 0, 0]);
  tw('pulse', 470, -1, [3, 2, 0]);
  tw('scatter', 700, 1, [0, 2, 3], { off: 36 });
  tw('rail', 980, -1, [2, 0, 4]);
  tw('missile', 1180, 1, [4, 0, 2]);
  tw('cryo', 1420, -1, [0, 3, 1]);
  tw('tesla', 1640, 1, [5, 2, 0]);
  tw('laser', 1860, -1, [0, 4, 2]);
  tw('drone', 2080, -1, [3, 0, 0], { off: 60 });
  tw('mortar', 2280, 1, [0, 0, 3]);
  tw('gravity', 2520, -1, [2, 3, 0]);
  tw('rig', 2760, 1, [0, 0, 0], { off: 70 });
  tw('beacon', 2980, -1, [0, 2, 3]);
  tw('vega', 3200, 1, [0, 0, 0], { level: 7 });
  tw('pulse', 3420, -1, [5, 0, 2]);
  tw('missile', 3620, 1, [0, 5, 2]);
  tw('nova', 900, 1, [0, 0, 0], { level: 13, off: 44 });
  tw('brick', 2420, 1, [0, 0, 0], { level: 20 });
  const stunned = tw('scatter', 3050, 1, [1, 0, 0]);
  stunned.disabledT = 9;
  // Enemies: every meteor type, modifiers and statuses
  const list = [
    ['rust', {}], ['cobalt', {}], ['jade', {}], ['amber', {}], ['rose', {}],
    ['iron', {}], ['magma', {}], ['comet', {}], ['prism', {}], ['geode', {}], ['aurora', {}], ['obsidian', { hp: 6 }],
    ['rose', { phantom: true }], ['jade', { nanite: true }], ['iron', { plated: true }], ['obsidian', { plated: true, hp: 14 }],
    ['cobalt', { frozen: true }], ['amber', { burn: true }], ['magma', { stun: true }], ['rust', { slow: true }],
    ['prism', { phantom: true, nanite: true }], ['geode', { slow: true }], ['aurora', { burn: true }], ['comet', { phantom: true }],
  ];
  let d = 150;
  for (const [type, o] of list) {
    sim.addEnemy(type, d, { ...o, off: (R() - 0.5) * 14 });
    d += 64;
    if (R() < 0.5) { sim.addEnemy(list[(R() * 5) | 0][0], d - 30, { off: (R() - 0.5) * 16 }); }
  }
  // A stream of small shards behind
  for (let i = 0; i < 30; i++) sim.addEnemy(['rust', 'cobalt', 'jade', 'amber', 'rose'][i % 5], d + i * 22, { off: (R() - 0.5) * 18 });
  // Ships
  sim.addEnemy('hauler', 2300, { hp: 140, speedScale: 0.4 });
  sim.addEnemy('warbarge', 2560, { hp: 290, speedScale: 0.8 });
  sim.addEnemy('specter', 2120, { hp: 250, speedScale: 0.2 });
  sim.addEnemy('dreadnought', 2880, { hp: 3700, speedScale: 1 });
  sim.addEnemy('worldbreaker', 3260, { hp: 4000, speedScale: 1 });
  const aeg = sim.addEnemy('titan', 3560, { def: titanDef('aegis'), hp: 7000, speedScale: 1, titan: { kind: 'aegis', shield: 1500, maxShield: 2400 } });
  aeg.maxHp = 9600;
  const rift = sim.addEnemy('titan', 3780, { def: titanDef('rift'), hp: 3000, speedScale: 1, titan: { kind: 'rift', shield: 0, maxShield: 0 } });
  rift.maxHp = 9600;
  const maw = sim.addEnemy('titan', 1520, { def: titanDef('maw'), hp: 8000, speedScale: 1, titan: { kind: 'maw', shield: 0, maxShield: 0 } });
  maw.maxHp = 9600;
  for (const e of sim.state.enemies) if (e.def.kind === 'ship' && !e.titan) e.maxHp = e.def.hp;
  sim.state.titan = { id: aeg.id, name: 'The Aegis', kind: 'aegis', hp: aeg.hp, maxHp: 9600, shield: 1500, maxShield: 2400 };
}

// Projectiles, beams, drones and events for the showcase (animated each frame)
function animateShowcase(sim, dt) {
  const st = sim.state;
  const T = st.time;
  const en = st.enemies;
  const nearest = (x, y, maxD = 400) => {
    let best = null, bd = maxD * maxD;
    for (const e of en) { const dx = e.x - x, dy = e.y - y, dd = dx * dx + dy * dy; if (dd < bd) { bd = dd; best = e; } }
    return best;
  };
  // Aim towers at the nearest enemy
  for (const t of st.towers) {
    const e = nearest(t.x, t.y, 320);
    if (e) { t.angle = Math.atan2(e.y - t.y, e.x - t.x); t.target = e.id; }
  }
  // Laser beams
  for (const t of st.towers) {
    if (t.type !== 'laser') continue;
    const e = nearest(t.x, t.y, 260);
    t.data.beams = e ? [{ x1: t.x, y1: t.y, x2: e.x, y2: e.y, width: 7, color: '#ff5d8a' }] : [];
  }
  // Drones orbit their bay
  const bay = st.towers.find((t) => t.type === 'drone');
  if (bay) {
    st.drones.length = 0;
    const kinds = ['gun', 'bomber', 'tractor'];
    for (let i = 0; i < 3; i++) {
      const a = T * 0.9 + (i / 3) * Math.PI * 2;
      const x = bay.x + Math.cos(a) * 80, y = bay.y + Math.sin(a) * 60;
      const e = nearest(x, y, 300);
      st.drones.push({ id: 900 + i, towerId: bay.id, x, y, angle: a + Math.PI / 2, targetId: e ? e.id : -1, visual: kinds[i], kind: kinds[i] });
    }
  }
  // Projectiles: keep a set flying from their towers
  const want = [
    ['pulse', 'bolt', '#8ee6ff', 6, 900], ['pulse', 'lance', '#b18cff', 8, 1000], ['scatter', 'shard', '#f15bb5', 6, 500],
    ['missile', 'missile', '#ff9f43', 7, 420], ['cryo', 'cryo', '#bff4ff', 6, 600], ['tesla', 'orb', '#7fe9ff', 9, 180],
    ['laser', 'plasma', '#d36bff', 8, 380], ['scatter', 'flame', '#ff7a1a', 12, 260], ['rail', 'needle', '#ffffff', 5, 1300],
    ['drone', 'bomb', '#ffd23d', 7, 300], ['rail', 'slug', '#fff2c4', 5, 1300], ['missile', 'bomblet', '#ffd23d', 6, 360],
  ];
  const projs = st.projectiles;
  for (let i = projs.length - 1; i >= 0; i--) {
    const p = projs[i];
    if (p.mortar) {
      p.prog += dt / p.flight;
      if (p.prog >= 1) { sim.emit({ t: 'explode', x: p.tx, y: p.ty, r: 70, dtype: 'BLAST' }); projs.splice(i, 1); continue; }
      p.x = p.x0 + (p.tx - p.x0) * p.prog; p.y = p.y0 + (p.ty - p.y0) * p.prog;
      continue;
    }
    p.life -= dt;
    p.x += p.vx * dt; p.y += p.vy * dt;
    if (p.life <= 0) projs.splice(i, 1);
  }
  if (!sim._projT || T - sim._projT > 0.09) {
    sim._projT = T;
    for (const [type, vis, color, rad, speed] of want) {
      const srcs = st.towers.filter((t) => t.type === type);
      for (const t of srcs) {
        const e = nearest(t.x, t.y, 330);
        if (!e || R() < 0.5) continue;
        const a = Math.atan2(e.y - t.y, e.x - t.x) + (vis === 'shard' ? (R() - 0.5) * 6 : (R() - 0.5) * 0.1);
        const dist = Math.hypot(e.x - t.x, e.y - t.y);
        projs.push({ id: sim.nextId++, x: t.x + Math.cos(a) * 20, y: t.y + Math.sin(a) * 20, vx: Math.cos(a) * speed, vy: Math.sin(a) * speed,
          radius: rad, life: Math.min(1.2, dist / speed + 0.05), maxLife: Math.min(1.2, dist / speed + 0.05), visual: vis, color, dead: false });
        sim.emit({ t: 'shot', tower: t.id, x: t.x, y: t.y, angle: a, visual: vis, dtype: 'KINETIC' });
      }
    }
  }
  // Mortar shells
  const mortar = st.towers.find((t) => t.type === 'mortar');
  if (mortar && (!sim._mortT || T - sim._mortT > 0.8)) {
    sim._mortT = T;
    const e = en[(R() * en.length) | 0];
    mortar.aim = { x: e.x, y: e.y };
    projs.push({ id: sim.nextId++, mortar: true, x0: mortar.x, y0: mortar.y, x: mortar.x, y: mortar.y, tx: e.x, ty: e.y, prog: 0, flight: 1.1, arc: 140,
      radius: 8, visual: 'shell', color: '#ffb347', angle: Math.atan2(e.y - mortar.y, e.x - mortar.x), vx: 0, vy: 0, life: 1.1, maxLife: 1.1, dead: false });
    sim.emit({ t: 'shot', tower: mortar.id, x: mortar.x, y: mortar.y, angle: Math.atan2(e.y - mortar.y, e.x - mortar.x), visual: 'shell', dtype: 'BLAST' });
  }
  // Rail hitscan
  const rail = st.towers.find((t) => t.type === 'rail');
  if (rail && (!sim._railT || T - sim._railT > 0.7)) {
    sim._railT = T;
    const e = nearest(rail.x, rail.y, 900);
    if (e) sim.emit({ t: 'shot', tower: rail.id, x: rail.x, y: rail.y, x2: e.x, y2: e.y, angle: Math.atan2(e.y - rail.y, e.x - rail.x), visual: 'rail', dtype: 'KINETIC' });
  }
  // Tesla zaps
  const tesla = st.towers.find((t) => t.type === 'tesla');
  if (tesla && (!sim._zapT || T - sim._zapT > 0.45)) {
    sim._zapT = T;
    const pts = [[tesla.x, tesla.y]];
    let cx = tesla.x, cy = tesla.y;
    const used = new Set();
    for (let j = 0; j < 4; j++) {
      let best = null, bd = 200 * 200;
      for (const e of en) { if (used.has(e.id)) continue; const dx = e.x - cx, dy = e.y - cy, dd = dx * dx + dy * dy; if (dd < bd) { bd = dd; best = e; } }
      if (!best) break;
      used.add(best.id); pts.push([best.x, best.y]); cx = best.x; cy = best.y;
    }
    if (pts.length > 1) sim.emit({ t: 'zap', points: pts });
  }
  // Cryo freeze pulse
  const cryo = st.towers.find((t) => t.type === 'cryo');
  if (cryo && (!sim._frzT || T - sim._frzT > 1.6)) { sim._frzT = T; sim.emit({ t: 'freeze', x: cryo.x, y: cryo.y, r: 120 }); }
  // Pops, hits and explosions along the path
  if (!sim._popT || T - sim._popT > 0.12) {
    sim._popT = T;
    const e = en[(R() * en.length) | 0];
    if (e && e.def.kind !== 'ship') sim.emit({ t: 'pop', x: e.x, y: e.y, type: e.type, color: e.def.color, ship: false, count: 1 });
    const e2 = en[(R() * en.length) | 0];
    if (e2) sim.emit({ t: 'hit', x: e2.x, y: e2.y, dtype: 'KINETIC' });
    if (R() < 0.15) { const e3 = en[(R() * en.length) | 0]; sim.emit({ t: 'blocked', x: e3.x, y: e3.y, dtype: 'KINETIC' }); }
    // Multi-HP damage so ships and obsidian flash
    for (const q of en) if (q.maxHp > 1 && R() < 0.1) q.hp = Math.max(1, q.hp - q.maxHp * 0.002);
  }
  if (!sim._expT || T - sim._expT > 0.9) {
    sim._expT = T;
    const e = en[(R() * en.length) | 0];
    sim.emit({ t: 'explode', x: e.x, y: e.y, r: 60 + R() * 30, dtype: ['BLAST', 'ENERGY', 'VOID', 'THERMAL'][(R() * 4) | 0] });
  }
  const rig = st.towers.find((t) => t.type === 'rig');
  if (rig && (!sim._cashT || T - sim._cashT > 2.2)) { sim._cashT = T; sim.emit({ t: 'cash', amount: 180, x: rig.x, y: rig.y - 20, reason: 'rig', tower: rig.id }); }
  if (!sim._leakT || T - sim._leakT > 5) { sim._leakT = T; sim.emit({ t: 'leak', type: 'rose', mass: 5, x: 1330, y: 190 }); st.lives -= 5; if (st.lives < 20) st.lives = 150; }
  if (!sim._shipPopT || T - sim._shipPopT > 3.3) {
    sim._shipPopT = T;
    const s = en.find((q) => q.type === 'hauler');
    if (s) sim.emit({ t: 'pop', x: s.x + 60, y: s.y + 40, type: 'hauler', color: s.def.color, ship: true, count: 1 });
  }
}

// ---------------------------------------------------------------------------
// Heavy scene (performance)
// ---------------------------------------------------------------------------
function buildHeavy(sim) {
  const st = sim.state;
  const L = sim.paths[0].length;
  const small = ['rust', 'cobalt', 'jade', 'amber', 'rose'];
  const special = ['iron', 'magma', 'comet', 'prism', 'geode', 'aurora', 'obsidian'];
  for (let i = 0; i < 1500; i++) {
    const r = R();
    const type = r < 0.7 ? small[(R() * 5) | 0] : special[(R() * special.length) | 0];
    sim.addEnemy(type, 60 + (i / 1500) * (L - 120), {
      off: (R() - 0.5) * 30, phantom: R() < 0.12, nanite: R() < 0.1, plated: R() < 0.06,
      frozen: R() < 0.05, burn: R() < 0.05, slow: R() < 0.08, stun: R() < 0.02, speedScale: 1,
    });
  }
  const ships = ['hauler', 'warbarge', 'dreadnought', 'specter', 'worldbreaker'];
  for (let i = 0; i < 20; i++) {
    const type = ships[i % ships.length];
    const e = sim.addEnemy(type, 200 + (i / 20) * (L - 400), { speedScale: 1, hp: ENEMIES[type].hp * (0.2 + R() * 0.8) });
    e.maxHp = ENEMIES[type].hp;
  }
  // 60 towers on free ground
  const types = Object.keys(DEFS).filter((k) => !DEFS[k].hero);
  let placed = 0, guard = 0;
  while (placed < 60 && guard++ < 5000) {
    const x = 40 + R() * 1420, y = 40 + R() * 920;
    const nd = sim.paths[0].distance ? sim.paths[0].distance(x, y, 200) : 999;
    if (nd < sim.map.pathWidth / 2 + 26) continue;
    if (st.towers.some((t) => Math.hypot(t.x - x, t.y - y) < 48)) continue;
    const type = types[placed % types.length];
    sim.addTower(type, x, y, [(R() * 4) | 0, (R() * 3) | 0, 0]);
    placed++;
  }
  // 800 projectiles
  const vis = ['bolt', 'shard', 'slug', 'missile', 'orb', 'needle', 'plasma', 'flame', 'cryo', 'bomb', 'lance'];
  for (let i = 0; i < 800; i++) {
    const e = st.enemies[(R() * st.enemies.length) | 0];
    const a = R() * Math.PI * 2, sp = 300 + R() * 700;
    st.projectiles.push({ id: sim.nextId++, x: e.x + Math.cos(a) * 60, y: e.y + Math.sin(a) * 60, vx: -Math.cos(a) * sp, vy: -Math.sin(a) * sp,
      radius: params.get('pv') === '1' ? 6 : 5 + R() * 4, life: 0.3 + R() * 0.3, maxLife: 0.6, visual: vis[i % vis.length], color: params.get('pv') === '1' ? '#8ee6ff' : ['#8ee6ff', '#ff9f43', '#f15bb5', '#bff4ff'][i % 4], dead: false });
  }
  for (const t of st.towers) if (t.type === 'laser') t.data.beams = [{ x1: t.x, y1: t.y, x2: t.x + 120, y2: t.y + 40, width: 6, color: '#ff5d8a' }];
}

function animateHeavy(sim, dt) {
  const st = sim.state;
  // Recycle projectiles (keep 800 alive)
  for (const p of st.projectiles) {
    p.life -= dt;
    p.x += p.vx * dt; p.y += p.vy * dt;
    if (p.life <= 0) {
      const e = st.enemies[(Math.random() * st.enemies.length) | 0];
      const a = Math.random() * Math.PI * 2;
      p.x = e.x + Math.cos(a) * 60; p.y = e.y + Math.sin(a) * 60;
      p.life = 0.3 + Math.random() * 0.3;
    }
  }
  // Event load similar to a busy late wave at 3x
  const en = st.enemies;
  for (let i = 0; i < 40; i++) { const e = en[(Math.random() * en.length) | 0]; sim.emit({ t: 'pop', x: e.x, y: e.y, type: e.type, color: e.def.color, ship: false, count: 1 }); }
  for (let i = 0; i < 30; i++) { const e = en[(Math.random() * en.length) | 0]; sim.emit({ t: 'hit', x: e.x, y: e.y, dtype: 'KINETIC' }); }
  for (let i = 0; i < 25; i++) { const t = st.towers[(Math.random() * st.towers.length) | 0]; sim.emit({ t: 'shot', tower: t.id, x: t.x, y: t.y, angle: t.angle, visual: 'bolt', dtype: 'KINETIC' }); }
  if (Math.random() < 0.5) { const e = en[(Math.random() * en.length) | 0]; sim.emit({ t: 'explode', x: e.x, y: e.y, r: 70, dtype: 'BLAST' }); }
  if (Math.random() < 0.3) {
    const e = en[(Math.random() * en.length) | 0];
    sim.emit({ t: 'zap', points: [[e.x, e.y], [e.x + 40, e.y + 20], [e.x + 90, e.y - 10]] });
  }
}

// ---------------------------------------------------------------------------
// Real sim scene
// ---------------------------------------------------------------------------
async function buildRealSim() {
  const { Sim } = await import('../src/sim/game.js');
  const sim = new Sim({ mapId: 'crater', difficulty: 'pilot', seed: 7 });
  sim.state.cash = 1e7;
  const types = Object.keys(DEFS).filter((k) => !FAKE_DEFS[k] || DEFS[k] !== FAKE_DEFS[k]);
  const path = sim.paths[0];
  let i = 0;
  for (let d = 200; d < path.length - 150; d += 150) {
    for (const side of [1, -1]) {
      const p = path.pointAt(d, {});
      const nx = -Math.sin(p.angle), ny = Math.cos(p.angle);
      const x = p.x + nx * side * 64, y = p.y + ny * side * 64;
      const type = types[i % Math.max(1, types.length)];
      if (!type) continue;
      const res = sim.placeTower(type, x, y);
      if (res && res.ok) {
        const lv = [[2, 0, 0], [0, 3, 1], [4, 0, 1], [1, 0, 3], [0, 2, 0], [5, 2, 0]][i % 6];
        for (let pth = 0; pth < 3; pth++) for (let k = 0; k < lv[pth]; k++) sim.upgrade(res.id, pth);
        i++;
      }
    }
  }
  sim.setAutoStart(true);
  sim.startWave();
  const target = Number(params.get('wave') || 0);
  let guard = 0;
  while (sim.state.wave < target && sim.state.phase !== 'over' && guard++ < 400000) {
    sim.step();
    if (sim.state.phase === 'build' && sim.canStartWave()) sim.startWave();
  }
  sim.drainEvents();
  return sim;
}

// ---------------------------------------------------------------------------
// Icons scene
// ---------------------------------------------------------------------------
function buildIcons(assets) {
  const box = document.getElementById('icons');
  box.style.display = 'block';
  document.getElementById('stage').style.display = 'none';
  const add = (row, label, size, draw) => {
    const f = document.createElement('figure');
    const c = document.createElement('canvas');
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = size * dpr; c.height = size * dpr;
    c.style.width = size + 'px'; c.style.height = size + 'px';
    const ctx = c.getContext('2d');
    ctx.scale(dpr, dpr);
    draw(ctx);
    const cap = document.createElement('figcaption');
    cap.textContent = label;
    f.append(c, cap);
    row.append(f);
  };
  const section = (title) => {
    const h = document.createElement('h2'); h.textContent = title;
    const row = document.createElement('div'); row.className = 'row';
    box.append(h, row);
    return row;
  };
  for (const v of [0, 1, 2, 3]) {
    const row = section('Towers, variant ' + v);
    for (const [id, def] of Object.entries(DEFS)) {
      if (def.hero && v) continue;
      add(row, id, 64, (ctx) => drawTowerIcon(ctx, def, 64, v, assets));
    }
  }
  const row2 = section('Enemies');
  for (const type of Object.keys(ENEMIES)) add(row2, type, 56, (ctx) => drawEnemyIcon(ctx, type, 56, {}, assets));
  const row3 = section('Modifiers');
  for (const [type, mods] of [['rust', { phantom: true }], ['jade', { nanite: true }], ['iron', { plated: true }], ['obsidian', { plated: true, nanite: true }], ['rose', { phantom: true, nanite: true }]]) {
    add(row3, type + ' ' + Object.keys(mods).join('+'), 56, (ctx) => drawEnemyIcon(ctx, type, 56, mods, assets));
  }
  const row4 = section('Titans');
  for (const k of ['maw', 'aegis', 'rift']) add(row4, k, 96, (ctx) => drawTitanIcon(ctx, k, 96, assets));
  const row5 = section('Small sizes (shop tiles at 32px)');
  for (const [id, def] of Object.entries(DEFS)) add(row5, id, 32, (ctx) => drawTowerIcon(ctx, def, 32, 0, assets));
  for (const type of Object.keys(ENEMIES)) add(row5, type, 28, (ctx) => drawEnemyIcon(ctx, type, 28, {}, assets));
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function main() {
  await loadDefs();
  let assets = EMPTY_ASSETS;
  if (params.get('img') === '1' || params.get('manifest')) {
    assets = await loadAssets({ timeout: 6000, manifestUrl: params.get('manifest') || null });
    console.log('assets loaded:', assets.keys().length);
  }
  if (SCENE === 'icons') { buildIcons(assets); window.__rt.ready = true; return; }

  const renderer = new Renderer(canvas, assets);
  renderer.setDefs({ towers: DEFS });
  if (params.get('inset')) { const [t, r, b, l] = params.get('inset').split(',').map(Number); renderer.setInsets({ top: t, right: r, bottom: b, left: l }); }
  window.__rt.renderer = renderer;
  renderer.profile = params.get('prof') === '1' || SCENE === 'heavy';
  renderer.autoQuality = params.get('gov') !== '0';
  const layerSum = {};
  const low = params.get('low') === '1';
  const ui = {
    hoverTowerId: null, selectedTowerId: null, placing: null, showAllRanges: false,
    settings: { particles: low ? 'low' : 'high', shake: true, floatText: true },
  };

  let sim;
  let animate = () => {};
  if (SCENE === 'sim') {
    try { sim = await buildRealSim(); } catch (err) { console.error('real sim failed', err); hud.textContent = 'real sim failed: ' + err.message; return; }
    const speed = Number(params.get('speed') || 3);
    animate = () => {
      for (let s = 0; s < speed; s++) {
        sim.step();
        if (sim.state.phase === 'build' && sim.canStartWave()) sim.startWave();
      }
    };
  } else {
    sim = new FakeSim(params.get('map') || 'crater');
    if (SCENE === 'heavy') buildHeavy(sim);
    else buildShowcase(sim, { early: SCENE === 'early' });
    animate = (dt) => {
      sim.step(dt);
      if (SCENE === 'heavy') animateHeavy(sim, dt);
      else if (SCENE !== 'early') animateShowcase(sim, dt);
    };
    if (SCENE === 'showcase') {
      const sel = sim.state.towers.find((t) => t.type === 'laser');
      ui.selectedTowerId = sel ? sel.id : null;
      const hov = sim.state.towers.find((t) => t.type === 'beacon');
      ui.hoverTowerId = hov ? hov.id : null;
      ui.placing = params.get('ghost') === 'bad' ? { type: 'missile', x: 505, y: 505, valid: false } : { type: 'tesla', x: 760, y: 140, valid: true };
      ui.showAllRanges = params.get('ranges') === '1';
    }
  }
  renderer.setMap(sim);

  // Focus / zoom for close inspection
  const focus = params.get('focus');
  if (focus) {
    const [fx, fy, z] = focus.split(',').map(Number);
    const W = window.innerWidth, H = window.innerHeight;
    canvas.style.position = 'absolute';
    canvas.style.width = W * z + 'px';
    canvas.style.height = H * z + 'px';
    renderer.render(sim, 0, ui);
    const p = renderer.worldToScreen(fx, fy);
    canvas.style.left = (W / 2 - p.x) + 'px';
    canvas.style.top = (H / 2 - p.y) + 'px';
  }

  // Warm up the simulation so effects are mid-flight in screenshots
  const warm = Number(params.get('warm') ?? (SCENE === 'heavy' ? 0 : 1.2));
  for (let t = 0; t < warm; t += 1 / 60) {
    animate(1 / 60);
    renderer.onEvents(sim.drainEvents());
    renderer.render(sim, 1 / 60, ui);
  }

  const times = [];
  const drawTimes = [];
  const simTimes = [], evTimes = [];
  let last = performance.now();
  let frames = 0;
  const benchFrames = Number(params.get('frames') || 240);
  function frame(now) {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    const ta = performance.now();
    animate(1 / 60);
    const tb = performance.now();
    renderer.onEvents(sim.drainEvents());
    const t0 = performance.now();
    renderer.render(sim, dt || 1 / 60, ui);
    const t1 = performance.now();
    frames++;
    if (frames > 10) {
      times.push(dt * 1000); drawTimes.push(t1 - t0);
      simTimes.push(tb - ta); evTimes.push(t0 - tb);
      if (renderer.stats.layers) for (const [k, v] of Object.entries(renderer.stats.layers)) layerSum[k] = (layerSum[k] || 0) + v;
    }
    if (frames % 15 === 0) {
      const st = renderer.stats;
      const avg = drawTimes.slice(-60).reduce((a, b) => a + b, 0) / Math.max(1, Math.min(60, drawTimes.length));
      hud.textContent = `${SCENE}  enemies ${st.enemies}  projectiles ${st.projectiles}  particles ${st.particles}\nrender ${avg.toFixed(2)} ms  frame ${(times.slice(-60).reduce((a, b) => a + b, 0) / Math.max(1, Math.min(60, times.length))).toFixed(1)} ms` + (sim.state.wave ? `  wave ${sim.state.wave}` : '');
    }
    if (SCENE === 'heavy' && drawTimes.length === benchFrames) report();
    requestAnimationFrame(frame);
  }
  function pct(arr, p) { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; }
  function report() {
    const avg = drawTimes.reduce((a, b) => a + b, 0) / drawTimes.length;
    const favg = times.reduce((a, b) => a + b, 0) / times.length;
    const r = {
      frames: drawTimes.length, renderAvgMs: +avg.toFixed(2), renderP95Ms: +pct(drawTimes, 0.95).toFixed(2), renderMaxMs: +Math.max(...drawTimes).toFixed(2),
      frameAvgMs: +favg.toFixed(2), frameP95Ms: +pct(times, 0.95).toFixed(2),
      harnessSimMs: +(simTimes.reduce((a, b) => a + b, 0) / simTimes.length).toFixed(2),
      onEventsMs: +(evTimes.reduce((a, b) => a + b, 0) / evTimes.length).toFixed(2),
      enemies: renderer.stats.enemies, projectiles: renderer.stats.projectiles, particles: renderer.stats.particles, governor: renderer.governor,
      canvas: `${canvas.width}x${canvas.height}`,
      layersAvgMs: Object.fromEntries(Object.entries(layerSum).map(([k, v]) => [k, +(v / drawTimes.length).toFixed(2)])),
    };
    window.__rt.perf = r;
    console.log('PERF ' + JSON.stringify(r));
  }
  window.__rt.ready = true;
  window.__rt.sim = sim;
  window.__rt.ui = ui;
  requestAnimationFrame(frame);
}

main().catch((err) => { console.error(err); hud.textContent = 'error: ' + err.message; });
