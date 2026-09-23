// Wave specs: authored waves 1..40 plus the procedural generator for 41+.
// Contract: docs/ARCHITECTURE.md section 7. Design notes: docs/WAVES.md.
//
// PURE and deterministic: no DOM, no Math.random, no clocks. The same wave number always
// yields the same spec (the seed comes from the wave number only), so records are comparable
// across runs, maps and devices. The `lanes` option only changes lane numbers, never content.
import {
  budget, spawnDuration, speedRamp, MAX_SPAWNS_PER_WAVE, TITAN_EVERY, titanHp,
} from '../data/economy.js';
import { ENEMIES, familyMass } from '../data/enemies.js';
import { AUTHORED_WAVES, UNLOCK, MOD_UNLOCK } from '../data/waves.js';

export const AUTHORED_COUNT = AUTHORED_WAVES.length;   // 40
export const AUTHORED_TOLERANCE = 0.20;                // authored mass within +-20% of budget(w)
export const PROC_TOLERANCE = 0.05;                    // procedural mass within +-5% of budget(w)

const FIT_TOL = 0.01;          // the count fit aims well inside PROC_TOLERANCE
const MIN_SPACING = 0.05;      // seconds between spawns of one group (3 ticks)
const MAX_BUDGET = 1e300;      // keeps absurd debug waves (w > 1000) finite
const TITAN_KINDS = ['maw', 'aegis', 'rift'];

// ---------------------------------------------------------------------------------------------
// Seeded PRNG (local, never Math.random)

function hash32(x) {
  x = (x ^ 0x9e3779b9) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b) >>> 0;
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function waveRng(w, salt) {
  return mulberry32(hash32(Math.imul(w, 0x27d4eb2d) ^ salt));
}

// ---------------------------------------------------------------------------------------------
// Unlocks, modifiers, titans

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

export function isUnlocked(type, w) {
  const u = UNLOCK[type];
  return u !== undefined && w >= u;
}
export function modUnlocked(mod, w) {
  return w >= MOD_UNLOCK[mod];
}

// Chance that a procedural group rolls a modifier. Ramps with w, capped.
export function modChance(mod, w) {
  if (!modUnlocked(mod, w)) return 0;
  const x = Math.max(0, w - AUTHORED_COUNT);
  if (mod === 'phantom') return Math.min(0.5, 0.10 + 0.004 * x);
  if (mod === 'nanite') return Math.min(0.5, 0.08 + 0.004 * x);
  return Math.min(0.6, 0.08 + 0.005 * x); // plated
}

// Storm Titan for wave w (every TITAN_EVERY waves), without hp scaling. Null otherwise.
export function titanForWave(w) {
  if (w < TITAN_EVERY || w % TITAN_EVERY !== 0) return null;
  const tier = w / TITAN_EVERY;
  return { kind: TITAN_KINDS[(tier - 1) % TITAN_KINDS.length], tier };
}

const unitMass = (type, plated, scout = false) => familyMass(type, 1, plated, scout);
const isShip = (type) => ENEMIES[type].kind === 'ship';

// ---------------------------------------------------------------------------------------------
// Procedural themes
//
// A theme is a list of components. Each component owns a share of the budget, a ladder of
// enemy types ordered weak to strong, a count ceiling and a spawn pattern. The count ceilings
// of every theme add up to exactly MAX_SPAWNS_PER_WAVE, so the spawn cap binds precisely when
// every component is at its ceiling on the strongest rung it can use; only then does the hull
// multiplier H rise above 1.

const CHAFF = ['rose'];
const HEAVY = ['geode', 'aurora', 'obsidian'];
const HEARTS = ['aurora', 'obsidian'];
const CAPITAL = ['hauler', 'warbarge', 'dreadnought', 'worldbreaker'];
const ESCORT = ['hauler', 'warbarge', 'dreadnought'];
const LIGHT = ['hauler', 'warbarge'];
const SPECTERS = ['specter'];
// Plated only means something on multi-hit shells, so random plating is rolled only for
// ladders that reach Iron or Obsidian (and for ships). Themes can still force it.
const PLATE_ROLL = new Set(['iron', 'obsidian']);

// Component fields:
//   ladder | pick   types weak to strong, or several ladders of which the rng picks one
//   share           fraction of the budget before jitter and normalization
//   max, min        count ceiling and floor
//   pattern         stream | burst | pulse | convoy
//   win             [a, b] spawn window as fractions of the wave duration
//   phantom, nanite, plated: 'roll' (chance ramps with w), true (forced), false
//   ship            ship component (never phantom or nanite)
export const THEMES = {
  swarm: {
    name: 'Shard Swarm',
    tip: 'Shard Swarm: long, fast streams of meteors. Pierce and area damage shine here.',
    comps: [
      { ladder: CHAFF, share: 0.22, max: 110, pattern: 'stream', win: [0, 0.6] },
      { ladder: CHAFF, share: 0.14, max: 70, pattern: 'burst', win: [0.3, 1] },
      { pick: [['prism'], ['comet']], share: 0.12, max: 45, pattern: 'burst', win: [0.15, 0.9] },
      { ladder: HEAVY, share: 0.14, max: 35, pattern: 'stream', win: [0.4, 1] },
      { ladder: CAPITAL, share: 0.38, max: 40, min: 1, pattern: 'convoy', win: [0.2, 0.95], ship: true },
    ],
  },
  dense: {
    name: 'Dense Front',
    tip: 'Dense Front: packs of Aurora and Obsidian. Bring heavy hitters.',
    comps: [
      { ladder: HEARTS, share: 0.34, max: 110, pattern: 'pulse', win: [0, 1] },
      { ladder: ['geode', 'aurora'], share: 0.14, max: 60, pattern: 'stream', win: [0.1, 0.7] },
      { ladder: CHAFF, share: 0.06, max: 60, pattern: 'stream', win: [0, 0.5] },
      { ladder: ESCORT, share: 0.14, max: 40, pattern: 'convoy', win: [0.3, 0.9], ship: true },
      { ladder: CAPITAL, share: 0.32, max: 30, min: 1, pattern: 'convoy', win: [0.4, 1], ship: true },
    ],
  },
  special: {
    name: 'Mixed Ore',
    tip: 'Mixed Ore: every immunity in one wave. Cover all damage types.',
    comps: [
      { ladder: ['iron'], share: 0.065, max: 25, pattern: 'burst', win: [0, 0.4], slot: true },
      { ladder: ['magma'], share: 0.065, max: 25, pattern: 'burst', win: [0.2, 0.6], slot: true },
      { ladder: ['comet'], share: 0.065, max: 25, pattern: 'burst', win: [0.4, 0.8], slot: true },
      { ladder: ['prism'], share: 0.065, max: 25, pattern: 'burst', win: [0.6, 1], slot: true },
      { ladder: ['geode'], share: 0.12, max: 45, pattern: 'stream', win: [0.2, 0.9] },
      { ladder: CHAFF, share: 0.05, max: 40, pattern: 'stream', win: [0, 1] },
      { ladder: HEARTS, share: 0.12, max: 45, pattern: 'pulse', win: [0.3, 1] },
      { ladder: SPECTERS, share: 0.12, max: 30, pattern: 'convoy', win: [0.3, 0.9], ship: true },
      { ladder: CAPITAL, share: 0.33, max: 40, min: 1, pattern: 'convoy', win: [0.35, 1], ship: true },
    ],
  },
  phantom: {
    name: 'Phantom Rush',
    tip: 'Phantom Rush: nearly everything is Phantom. Detection is not optional.',
    comps: [
      { ladder: CHAFF, share: 0.18, max: 100, pattern: 'stream', win: [0, 0.7], phantom: true },
      { ladder: CHAFF, share: 0.10, max: 60, pattern: 'burst', win: [0.3, 1], phantom: true },
      { ladder: HEARTS, share: 0.20, max: 60, pattern: 'pulse', win: [0.2, 1], phantom: true },
      { ladder: SPECTERS, share: 0.16, max: 40, pattern: 'convoy', win: [0.2, 0.9], ship: true },
      { ladder: CAPITAL, share: 0.36, max: 40, min: 1, pattern: 'convoy', win: [0.4, 1], ship: true },
    ],
  },
  nanite: {
    name: 'Nanite Siege',
    tip: 'Nanite Siege: every meteor regrows if left alone. Keep the damage flowing.',
    comps: [
      { ladder: CHAFF, share: 0.20, max: 120, pattern: 'stream', win: [0, 1], nanite: true },
      { ladder: HEARTS, share: 0.22, max: 70, pattern: 'pulse', win: [0.15, 1], nanite: true },
      { ladder: ['geode'], share: 0.10, max: 40, pattern: 'stream', win: [0.1, 0.6], nanite: true },
      { ladder: ESCORT, share: 0.12, max: 40, pattern: 'convoy', win: [0.2, 0.8], ship: true },
      { ladder: CAPITAL, share: 0.36, max: 30, min: 1, pattern: 'convoy', win: [0.4, 1], ship: true },
    ],
  },
  convoy: {
    name: 'Ship Convoy',
    tip: 'Ship Convoy: most of the threat rides inside ships. Bring ship damage.',
    comps: [
      { ladder: CHAFF, share: 0.06, max: 80, pattern: 'burst', win: [0, 0.6] },
      { ladder: HEARTS, share: 0.12, max: 60, pattern: 'pulse', win: [0, 0.8] },
      { ladder: LIGHT, share: 0.34, max: 124, pattern: 'convoy', win: [0, 0.8], ship: true },
      { ladder: CAPITAL, share: 0.48, max: 36, min: 1, pattern: 'convoy', win: [0.25, 1], ship: true },
    ],
  },
  armored: {
    name: 'Armored Column',
    tip: 'Armored Column: plated Iron and plated ships. KINETIC alone will not hold.',
    comps: [
      { ladder: ['iron'], share: 0.14, max: 80, pattern: 'stream', win: [0, 0.8], plated: true },
      { ladder: HEAVY, share: 0.28, max: 120, pattern: 'pulse', win: [0.1, 1], plated: true },
      { ladder: ['magma'], share: 0.08, max: 50, pattern: 'burst', win: [0.3, 0.9], plated: true },
      { ladder: ESCORT, share: 0.14, max: 30, pattern: 'convoy', win: [0.2, 0.9], ship: true, plated: true },
      { ladder: CAPITAL, share: 0.36, max: 20, min: 1, pattern: 'convoy', win: [0.35, 1], ship: true, plated: true },
    ],
  },
};
export const THEME_ORDER = ['swarm', 'dense', 'special', 'phantom', 'nanite', 'convoy', 'armored'];

// New ship classes debut as a single featured unit on their unlock wave.
// `win` (optional) places the featured hull in the wave; `warn` is shown as the tip of the wave
// before, so the player can prepare (the preview strip shows the new ship too).
const DEBUTS = {
  // The first Specter is a scout: an empty hold and a fifth of its hull (80 HP), so a leak costs
  // 80 Integrity and teaches the counter. Full Specters (816 mass) follow from the next waves.
  50: { types: ['warbarge', 'specter'], name: 'Heavy Company', win: { specter: [0.08, 0.12] }, scout: ['specter'],
    tip: 'A Specter scout leads: a Phantom ship immune to KINETIC and BLAST. This one is empty; the next ones carry four Obsidian Hearts.',
    warn: 'Next wave brings a Specter scout: a fast Phantom ship that ignores KINETIC and BLAST. Get detection plus THERMAL, ENERGY, CRYO or VOID damage ready.' },
  70: { types: ['dreadnought'], name: 'Dreadnought Rising',
    tip: 'A Dreadnought carries four Warbarges. Its hull holds 4000 HP.',
    warn: 'Next wave brings the first Dreadnought: a slow 4000 HP hull carrying four Warbarges.' },
  90: { types: ['worldbreaker'], name: 'Worldbreaker',
    tip: 'The Worldbreaker carries two Dreadnoughts and three Specters.',
    warn: 'Next wave brings the Worldbreaker: two Dreadnoughts and three Specters inside one hull.' },
};

// Themes rotate in shuffled blocks of seven: every theme once per block, never the same
// theme twice in a row across a block boundary.
function blockPerm(b) {
  const rng = mulberry32(hash32(Math.imul(b + 1, 0x9e3779b1) ^ 0x5eed7e11));
  const p = THEME_ORDER.slice();
  for (let i = p.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = p[i]; p[i] = p[j]; p[j] = t;
  }
  return p;
}
export function themeForWave(w) {
  if (w <= AUTHORED_COUNT) return null;
  const i = w - AUTHORED_COUNT - 1;
  const b = Math.floor(i / THEME_ORDER.length);
  const p = blockPerm(b);
  if (b > 0 && p[0] === blockPerm(b - 1)[THEME_ORDER.length - 1]) { const t = p[0]; p[0] = p[1]; p[1] = t; }
  return p[i % THEME_ORDER.length];
}

// Ships take a smaller slice of the budget right after the authored waves and ramp to their
// full share by wave 71.
function shipRamp(w) {
  return clamp(0.35 + (0.65 * (w - 41)) / 30, 0.35, 1);
}

// ---------------------------------------------------------------------------------------------
// Composition fit
//
// 1. Targets: each component gets its share of the budget.
// 2. Rungs: each component picks the weakest rung of its ladder whose count stays under 80% of
//    its ceiling. Mass a component cannot hold even at its top rung and ceiling spills to the
//    components that still have room.
// 3. Counts: components are realized largest unit first. Ship components make change down their
//    ladder (4 Dreadnoughts + 3 Warbarges rather than a rounded 5 Dreadnoughts) and every
//    remainder carries to the next, finer component, so the total lands within about 1%.
// 4. Hull multiplier: only when every component sits at its ceiling (the spawn cap binds) does
//    the leftover go into H, solved exactly because mass is linear in H.

function chooseRung(c) {
  const L = c.ladder;
  let r = L.length - 1;
  for (let i = 0; i < L.length; i++) {
    if (c.target / unitMass(L[i], c.plated) <= 0.8 * c.max) { r = i; break; }
  }
  // Sometimes send fewer, bigger enemies instead (only when at least 1.5 of them fit).
  if (r < L.length - 1 && c.escRoll < c.escP && c.target / unitMass(L[r + 1], c.plated) >= 1.5) r++;
  c.rung = r;
  c.type = L[r];
  c.unit = unitMass(c.type, c.plated);
  c.saturated = r === L.length - 1 && c.target > c.max * c.unit;
}

const compCount = (c) => c.entries.reduce((s, e) => s + e.count, 0);
const compRungs = (c) => (c.ship ? c.ladder.slice(0, c.rung + 1) : [c.type]);
function entryFor(c, type) {
  let e = c.entries.find((x) => x.type === type);
  if (!e) { e = { type, unit: unitMass(type, c.plated), count: 0 }; c.entries.push(e); }
  return e;
}

function fitComposition(comps, B, cap) {
  const free = comps.filter((c) => !c.fixed);
  const fixedMass = comps.reduce((s, c) => s + (c.fixed ? c.entries[0].count * c.entries[0].unit : 0), 0);
  const shareSum = free.reduce((s, c) => s + c.share, 0) || 1;
  for (const c of free) c.target = Math.max(0, (B - fixedMass) * (c.share / shareSum));

  // Rungs and spill.
  for (let iter = 0; iter < 16; iter++) {
    for (const c of free) chooseRung(c);
    let spill = 0;
    for (const c of free) {
      if (c.saturated) { spill += c.target - c.max * c.unit; c.target = c.max * c.unit; }
    }
    if (spill <= 1e-9 * B) break;
    const recv = free.filter((c) => !c.saturated);
    if (!recv.length) break; // everything saturated: the hull multiplier takes the rest
    const rs = recv.reduce((s, c) => s + c.share, 0);
    for (const c of recv) c.target += spill * (c.share / rs);
  }
  for (const c of free) chooseRung(c);

  // Counts: largest units first, remainders carry down.
  let carry = 0;
  for (const c of free.slice().sort((a, b) => b.unit - a.unit)) {
    let t = c.target + carry;
    let room = c.max;
    c.entries = [];
    compRungs(c).reverse().forEach((type, j) => {
      if (room <= 0) return;
      const u = unitMass(type, c.plated);
      let n = Math.min(room, Math.max(0, Math.floor(t / u)));
      if (j === 0 && n < c.min) n = c.min;
      if (n > 0) { c.entries.push({ type, unit: u, count: n }); room -= n; t -= n * u; }
    });
    carry = t;
  }

  const mass = () => comps.reduce((s, c) => s + c.entries.reduce((a, e) => a + e.count * e.unit, 0), 0);
  let total = comps.reduce((s, c) => s + compCount(c), 0);
  const roomOf = (c) => Math.min(c.max - compCount(c), cap - total);
  let left = B - mass();

  // Close the gap: add (or remove) whole units, largest first; the last usable unit rounds.
  for (let pass = 0; pass < 3 && Math.abs(left) > FIT_TOL * B; pass++) {
    if (left > 0) {
      const cands = [];
      for (const c of free) for (const type of compRungs(c)) cands.push({ c, type, unit: unitMass(type, c.plated) });
      cands.sort((a, b) => b.unit - a.unit);
      for (let i = 0; i < cands.length && left > 0; i++) {
        const { c, type, unit } = cands[i];
        const room = roomOf(c);
        if (room <= 0) continue;
        const lastUsable = !cands.slice(i + 1).some((x) => roomOf(x.c) > 0);
        const k = Math.min(room, lastUsable ? Math.round(left / unit) : Math.floor(left / unit));
        if (k > 0) { entryFor(c, type).count += k; total += k; left -= k * unit; }
      }
    } else {
      const ents = [];
      for (const c of free) for (const e of c.entries) ents.push({ c, e });
      ents.sort((a, b) => b.e.unit - a.e.unit);
      for (let i = 0; i < ents.length && left < 0; i++) {
        const { c, e } = ents[i];
        const removable = Math.min(e.count, compCount(c) - c.min);
        if (removable <= 0) continue;
        const lastUsable = !ents.slice(i + 1).some((x) => Math.min(x.e.count, compCount(x.c) - x.c.min) > 0);
        const k = Math.min(removable, lastUsable ? Math.round(-left / e.unit) : Math.floor(-left / e.unit));
        if (k > 0) { e.count -= k; total -= k; left += k * e.unit; }
      }
    }
  }
  for (const c of comps) c.entries = c.entries.filter((e) => e.count > 0);

  // Hard spawn cap (only reachable when a debut unit sits on top of a saturated theme).
  for (const c of free.slice().sort((a, b) => a.unit - b.unit)) {
    for (const e of c.entries.slice().sort((a, b) => a.unit - b.unit)) {
      if (total <= cap) break;
      const k = Math.min(total - cap, e.count, compCount(c) - c.min);
      if (k > 0) { e.count -= k; total -= k; left += k * e.unit; }
    }
  }
  for (const c of comps) c.entries = c.entries.filter((e) => e.count > 0);

  // A gap smaller than half of every unit that still fits is fine (it is well inside the
  // tolerance); hulls only scale once no component has room left.
  if (left <= FIT_TOL * B || free.some((c) => roomOf(c) > 0)) return 1;

  // Every component is full. Swap lower-rung units for the strongest rung before scaling hulls.
  for (const c of free) {
    const top = c.ladder[c.ladder.length - 1];
    const tu = unitMass(top, c.plated);
    for (const e of c.entries.slice().sort((a, b) => b.unit - a.unit)) {
      if (e.type === top || left <= 0) continue;
      const k = Math.min(e.count, Math.floor(left / (tu - e.unit)));
      if (k > 0) { e.count -= k; entryFor(c, top).count += k; left -= k * (tu - e.unit); }
    }
    c.entries = c.entries.filter((e) => e.count > 0);
  }

  // Mass is linear in H: sum(count * (meteorPart + H * hullPart)).
  let base = 0, hull = 0;
  for (const c of comps) {
    for (const e of c.entries) {
      const f0 = familyMass(e.type, 0, c.plated, !!c.scout);
      base += e.count * f0;
      hull += e.count * (e.unit - f0);
    }
  }
  return hull > 0 ? Math.max(1, (B - base) / hull) : 1;
}

// ---------------------------------------------------------------------------------------------
// Layout: turn fitted components into timed groups

function round3(x) { return Math.round(x * 1000) / 1000; }

function layoutEntry(c, e, D, rng, pw, out) {
  const n = e.count;
  const jit = (rng() - 0.5) * 0.1;
  const a = clamp(c.win[0] + jit, 0, 0.9);
  const b = clamp(c.win[1] + jit, a + 0.08, 1);
  const t0 = a * D;
  const span = (b - a) * D;
  const push = (count, start, spacing, split) => {
    out.push({ type: e.type, count, start, spacing, lane: 0, split, mods: rollMods(c, rng, pw) });
  };
  if (c.pattern === 'stream') {
    push(n, t0, n > 1 ? Math.max(MIN_SPACING, span / (n - 1)) : 0, true);
  } else if (c.pattern === 'burst' || c.pattern === 'pulse') {
    const burst = c.pattern === 'burst';
    const k = clamp(Math.ceil(n / (burst ? 12 : 4)), 1, burst ? 8 : 12);
    const inner = burst ? 0.08 + rng() * 0.04 : 0.3 + rng() * 0.15;
    const base = Math.floor(n / k);
    let extra = n - base * k;
    const maxLen = (base + (extra ? 1 : 0) - 1) * inner;
    const room = Math.max(0, span - maxLen);
    for (let j = 0; j < k; j++) {
      const size = base + (extra > 0 ? 1 : 0);
      if (extra > 0) extra--;
      const start = k > 1 ? t0 + (room * j) / (k - 1) : t0 + room * rng();
      push(size, start, size > 1 ? inner : 0, false);
    }
  } else if (n === 1) { // convoy (ships), a single hull somewhere in the middle of its window
    push(1, t0 + span * (0.25 + 0.5 * rng()), 0, false);
  } else {              // convoy, evenly spaced hulls
    push(n, t0, Math.max(0.6, span / (n - 1)), true);
  }
}

function rollMods(c, rng, pw) {
  const pick = (mode, p) => (mode === true ? true : mode === 'roll' ? rng() < p : false);
  if (c.ship) return c.scout ? { phantom: false, nanite: false, plated: c.plated, scout: true } : { phantom: false, nanite: false, plated: c.plated };
  return {
    phantom: modUnlocked('phantom', pw.w) && pick(c.phantom, pw.phantom),
    nanite: modUnlocked('nanite', pw.w) && pick(c.nanite, pw.nanite),
    plated: c.plated,
  };
}

// Two-lane maps. Each class of group balances its own mass across the lanes, so the wave as a
// whole is balanced and equal bursts strictly alternate lanes:
//   ships, heaviest first: pinned to the lighter lane (among ships). Multi-hull streams use
//     lane -1, which sends spawn i to lane i % 2; an odd stream is split so its last hull goes
//     to the lighter lane instead of always landing on lane 0.
//   meteor streams: lane -1.
//   meteor bursts and pulses, in time order: pinned to the lighter lane (among bursts).
function assignLanes(groups, H) {
  const ship = [0, 0], pin = [0, 0];
  const extra = [];
  const items = groups.map((g) => ({ g, u: familyMass(g.type, H, g.mods.plated, !!g.mods.scout) }));
  const ships = items.filter((x) => isShip(x.g.type))
    .sort((a, b) => b.u * b.g.count - a.u * a.g.count || a.g.start - b.g.start);
  for (const { g, u } of ships) {
    if (g.split && g.count >= 2) {
      if (g.count % 2 === 1) {
        g.count -= 1;
        const lane = ship[0] <= ship[1] ? 0 : 1;
        extra.push({ ...g, mods: { ...g.mods }, count: 1, start: g.start + g.count * g.spacing, spacing: 0, lane });
        ship[lane] += u;
      }
      g.lane = -1;
      ship[0] += (g.count / 2) * u;
      ship[1] += (g.count / 2) * u;
    } else {
      g.lane = ship[0] <= ship[1] ? 0 : 1;
      ship[g.lane] += g.count * u;
    }
  }
  const mets = items.filter((x) => !isShip(x.g.type)).sort((a, b) => a.g.start - b.g.start);
  for (const { g, u } of mets) {
    if (g.split && g.count >= 2) { g.lane = -1; continue; }
    g.lane = pin[0] <= pin[1] ? 0 : 1;
    pin[g.lane] += g.count * u;
  }
  for (const g of groups) delete g.split;
  for (const g of extra) { delete g.split; groups.push(g); }
}

// Stretch or compress spawn times so the last spawn lands exactly on D.
function fitDuration(groups, D) {
  let end = 0, endGroup = null;
  for (const g of groups) {
    const last = g.start + (g.count - 1) * g.spacing;
    if (last >= end) { end = last; endGroup = g; }
  }
  const f = end > 0 ? D / end : 1;
  for (const g of groups) {
    g.start = round3(g.start * f);
    g.spacing = g.count > 1 ? Math.max(MIN_SPACING, Math.floor(g.spacing * f * 1e4) / 1e4) : 0;
    if (g.start + (g.count - 1) * g.spacing > D) g.start = Math.max(0, D - (g.count - 1) * g.spacing);
  }
  // The group that closes the wave ends exactly on D.
  if (endGroup && end > 0) endGroup.start = Math.max(0, D - (endGroup.count - 1) * endGroup.spacing);
}

function proceduralWave(w) {
  const B = Math.min(budget(w), MAX_BUDGET);
  const D = spawnDuration(w);
  const theme = themeForWave(w);
  const T = THEMES[theme];
  const rng = waveRng(w, 0x51a2d);
  const pw = { w, phantom: modChance('phantom', w), nanite: modChance('nanite', w), plated: modChance('plated', w) };
  const ramp = shipRamp(w);

  const comps = [];
  const slotWins = T.comps.filter((d) => d.slot).map((d) => d.win);
  for (let i = slotWins.length - 1; i > 0; i--) {         // shuffle which special comes first
    const j = Math.floor(rng() * (i + 1));
    const t = slotWins[i]; slotWins[i] = slotWins[j]; slotWins[j] = t;
  }
  let slotIdx = 0;
  for (const d of T.comps) {
    let ladder = d.pick ? d.pick[Math.floor(rng() * d.pick.length)] : d.ladder;
    ladder = ladder.filter((t) => isUnlocked(t, w));
    if (!ladder.length) ladder = d.ship ? ['hauler'] : ['rose'];
    const plateable = d.ship || ladder.some((t) => PLATE_ROLL.has(t));
    let plated = false;
    if (modUnlocked('plated', w)) {
      if (d.plated === true) plated = true;
      else if (plateable) plated = rng() < pw.plated;
    }
    comps.push({
      ladder, plated, entries: [],
      share: d.share * (0.8 + 0.4 * rng()) * (d.ship ? ramp : 1),
      max: d.max, min: d.min || 0,
      pattern: d.pattern,
      win: d.slot ? slotWins[slotIdx++] : d.win,
      phantom: d.phantom === undefined ? 'roll' : d.phantom,
      nanite: d.nanite === undefined ? 'roll' : d.nanite,
      ship: !!d.ship,
      escP: d.ship ? 0.3 : 0.2,
      escRoll: rng(),
    });
  }

  // Ship debuts: one featured hull, fixed, and the rest of the wave fits around it.
  const debut = DEBUTS[w];
  if (debut) {
    for (const type of debut.types) {
      const scout = !!(debut.scout && debut.scout.indexOf(type) >= 0);
      comps.push({
        ladder: [type], plated: false, entries: [{ type, unit: unitMass(type, false, scout), count: 1 }],
        min: 1, max: 1, share: 0, pattern: 'convoy', win: (debut.win && debut.win[type]) || [0.4, 0.6],
        phantom: false, nanite: false, ship: true, fixed: true, scout,
      });
    }
  }

  const H = fitComposition(comps, B, MAX_SPAWNS_PER_WAVE);

  const groups = [];
  for (const c of comps) for (const e of c.entries) layoutEntry(c, e, D, rng, pw, groups);
  assignLanes(groups, H);
  fitDuration(groups, D);

  return {
    wave: w, budget: B, hullMult: H, duration: D, speedMult: speedRamp(w),
    theme, name: debut ? debut.name : T.name,
    // Debut waves explain the new ship; otherwise a theme explains itself the first time it appears.
    tip: debut ? debut.tip : w - AUTHORED_COUNT <= THEME_ORDER.length ? T.tip : DEBUTS[w + 1] ? DEBUTS[w + 1].warn || null : null,
    authored: false, groups,
  };
}

// Early pacing: the first waves are stretched in time (same mass, lower density) so a
// starting loadout of two or three turrets can hold them. 1.6x at wave 1, easing to 1x by 16.
export const EARLY_PACE_WAVES = 16, EARLY_PACE_MAX = 0.6;
export function earlyPace(w) {
  return 1 + EARLY_PACE_MAX * Math.max(0, (EARLY_PACE_WAVES - w) / (EARLY_PACE_WAVES - 1));
}

function authoredWave(w) {
  const a = AUTHORED_WAVES[w - 1];
  const pace = earlyPace(w);
  const groups = a.groups.map((g) => ({
    type: g.type, count: g.count, start: Math.round(g.start * pace * 1000) / 1000, spacing: g.count > 1 ? Math.round(g.spacing * pace * 1000) / 1000 : 0,
    lane: g.lane === undefined ? -1 : g.lane,
    mods: { phantom: !!(g.mods && g.mods.phantom), nanite: !!(g.mods && g.mods.nanite), plated: !!(g.mods && g.mods.plated) },
  }));
  let end = 0;
  for (const g of groups) end = Math.max(end, g.start + (g.count - 1) * g.spacing);
  return {
    wave: w, budget: budget(w), hullMult: 1, duration: end, speedMult: speedRamp(w),
    theme: null, name: a.name || 'Wave ' + w, tip: a.tip || null, authored: true, groups,
    titanStart: a.titanStart,
  };
}

// ---------------------------------------------------------------------------------------------
// Public API

const cache = new Map();
const CACHE_MAX = 128;

export function clearWaveCache() { cache.clear(); }

function baseSpec(w) {
  let s = cache.get(w);
  if (s) return s;
  s = w <= AUTHORED_COUNT ? authoredWave(w) : proceduralWave(w);
  s.groups.sort((a, b) => a.start - b.start || unitMass(b.type, b.mods.plated) - unitMass(a.type, a.mods.plated));
  s.mass = waveMass(s);
  const t = titanForWave(w);
  if (t) {
    const start = s.titanStart !== undefined ? s.titanStart : Math.round(clamp(0.2 * s.duration, 3, 8) * 10) / 10;
    t.hp = Math.min(MAX_BUDGET, titanHp(t.tier));
    t.start = Math.min(start, s.duration);
    s.titan = t;
  } else {
    s.titan = null;
  }
  delete s.titanStart;
  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(w, s);
  return s;
}

function resolveLane(lane, lanes) {
  if (lanes <= 1) return 0;
  if (lane < 0) return -1;
  return lane % lanes;
}

// buildWave(w, { lanes }) -> WaveSpec (docs/ARCHITECTURE.md section 7). Always a fresh object.
// Extra fields beyond the contract: theme (procedural theme id or null), name (banner title),
// tip (one-line hint or null), authored (bool).
export function buildWave(w, { lanes = 1 } = {}) {
  w = Math.max(1, Math.floor(Number(w) || 1));
  lanes = Math.max(1, Math.floor(Number(lanes) || 1));
  const s = baseSpec(w);
  return {
    wave: s.wave, budget: s.budget, mass: s.mass, duration: s.duration,
    hullMult: s.hullMult, speedMult: s.speedMult,
    theme: s.theme, name: s.name, tip: s.tip, authored: s.authored,
    groups: s.groups.map((g) => ({
      type: g.type, count: g.count, start: g.start, spacing: g.spacing,
      lane: resolveLane(g.lane, lanes), mods: { ...g.mods },
    })),
    titan: s.titan ? { ...s.titan } : null,
  };
}

// Total mass of the spec's spawns (titan excluded), with the wave's hull multiplier.
export function waveMass(spec) {
  const H = spec.hullMult || 1;
  let m = 0;
  for (const g of spec.groups) m += g.count * familyMass(g.type, H, !!(g.mods && g.mods.plated), !!(g.mods && g.mods.scout));
  return m;
}

// Upcoming-wave summary for the HUD strip: aggregated by type + mods, strongest first.
// Titans are not listed here; use buildWave(w).titan or titanForWave(w).
export function previewWave(w, opts) {
  const s = buildWave(w, opts);
  const map = new Map();
  for (const g of s.groups) {
    const key = g.type + (g.mods.phantom ? ':p' : '') + (g.mods.nanite ? ':n' : '') + (g.mods.plated ? ':x' : '') + (g.mods.scout ? ':s' : '');
    const e = map.get(key);
    if (e) e.count += g.count;
    else map.set(key, { type: g.type, count: g.count, mods: { ...g.mods }, first: g.start, unit: unitMass(g.type, g.mods.plated, !!g.mods.scout) });
  }
  return [...map.values()]
    .sort((a, b) => b.unit - a.unit || a.first - b.first)
    .map(({ type, count, mods }) => ({ type, count, mods }));
}
