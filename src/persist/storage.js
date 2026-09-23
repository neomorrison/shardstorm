// localStorage wrappers. Every access is wrapped in try/catch; when storage is blocked
// (private mode, sandboxed iframe, quota) everything keeps working from memory for the session.

const NS = 'shardstorm.v1.';
const memory = new Map();
let usable = null;

function probe() {
  if (usable !== null) return usable;
  try {
    const k = NS + '__probe';
    localStorage.setItem(k, '1');
    localStorage.removeItem(k);
    usable = true;
  } catch {
    usable = false;
  }
  return usable;
}

function read(key, fallback) {
  // memory holds the newest value written this session (even when a storage write failed)
  let raw = memory.has(key) ? memory.get(key) : null;
  if (raw == null && probe()) {
    try { raw = localStorage.getItem(NS + key); } catch { raw = null; }
  }
  if (raw == null) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

function write(key, value) {
  let raw;
  try { raw = JSON.stringify(value); } catch { return false; }
  memory.set(key, raw);
  if (!probe()) return false;
  try { localStorage.setItem(NS + key, raw); return true; } catch { return false; }
}

function remove(key) {
  memory.delete(key);
  if (!probe()) return;
  try { localStorage.removeItem(NS + key); } catch { /* ignore */ }
}

/** True when saves survive a reload. */
export function persistent() { return probe(); }

// ---- settings --------------------------------------------------------------------

export const DEFAULT_SETTINGS = Object.freeze({
  sfx: 0.8,            // 0..1
  music: 0.5,          // 0..1
  autoStart: false,
  particles: 'high',   // 'low' | 'medium' | 'high'
  shake: true,
  floatText: true,
  showFps: false,
  lastMap: null,
  lastDifficulty: 'pilot',
  lastHero: null,
  drawer: true,        // compact layout: drawer expanded
  codexDifficulty: 'pilot',
  coach: true,         // first-run hints
});

export function loadSettings() {
  const s = read('settings', null);
  const out = { ...DEFAULT_SETTINGS };
  if (s && typeof s === 'object') {
    for (const k of Object.keys(DEFAULT_SETTINGS)) {
      if (k in s && (typeof s[k] === typeof DEFAULT_SETTINGS[k] || DEFAULT_SETTINGS[k] === null)) out[k] = s[k];
    }
  }
  out.sfx = clamp01(out.sfx);
  out.music = clamp01(out.music);
  if (out.particles !== 'low' && out.particles !== 'medium') out.particles = 'high';
  return out;
}

export function saveSettings(s) {
  const out = {};
  for (const k of Object.keys(DEFAULT_SETTINGS)) out[k] = s[k];
  return write('settings', out);
}

function clamp01(x) {
  x = Number(x);
  return Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0.5;
}

// ---- records ---------------------------------------------------------------------

function emptyRecords() {
  return {
    best: {},            // best[mapId][difficulty] = highest wave cleared
    totals: { runs: 0, waves: 0, pops: 0, titans: 0, time: 0, leaks: 0, towers: 0, cash: 0 },
    highest: 0,          // highest wave cleared anywhere
  };
}

export function loadRecords() {
  const r = read('records', null);
  const out = emptyRecords();
  if (r && typeof r === 'object') {
    if (r.best && typeof r.best === 'object') {
      for (const [m, byDiff] of Object.entries(r.best)) {
        if (!byDiff || typeof byDiff !== 'object') continue;
        out.best[m] = {};
        for (const [d, v] of Object.entries(byDiff)) if (Number.isFinite(v)) out.best[m][d] = v;
      }
    }
    if (r.totals && typeof r.totals === 'object') {
      for (const k of Object.keys(out.totals)) if (Number.isFinite(r.totals[k])) out.totals[k] = r.totals[k];
    }
    if (Number.isFinite(r.highest)) out.highest = r.highest;
  }
  return out;
}

export function saveRecords(rec) {
  return write('records', rec);
}

export function bestWave(mapId, difficulty, rec = loadRecords()) {
  return rec.best?.[mapId]?.[difficulty] || 0;
}

/** Raises the best wave for a map and difficulty. Returns true when it is a new best. */
export function submitBest(mapId, difficulty, cleared) {
  const rec = loadRecords();
  const prev = rec.best[mapId]?.[difficulty] || 0;
  if (!(cleared > prev)) return false;
  (rec.best[mapId] ||= {})[difficulty] = cleared;
  rec.highest = Math.max(rec.highest || 0, cleared);
  saveRecords(rec);
  return true;
}

/** Adds to lifetime totals: { runs, waves, pops, titans, time, leaks, towers, cash }. */
export function addTotals(delta) {
  const rec = loadRecords();
  for (const [k, v] of Object.entries(delta || {})) {
    if (!Number.isFinite(v) || v === 0) continue;
    rec.totals[k] = (rec.totals[k] || 0) + v;
  }
  saveRecords(rec);
  return rec;
}

export function resetRecords() {
  remove('records');
}

// ---- run save --------------------------------------------------------------------

/**
 * Saves the current run. `data` is sim.serialize() (build phase only);
 * `meta` is a small summary for the Continue button { mapId, difficulty, heroId, wave, lives, cash }.
 */
export function saveRun(data, meta = {}) {
  if (!data) return false;
  return write('run', { v: 1, savedAt: Date.now(), meta, data });
}

/** Returns { meta, data, savedAt } or null. */
export function loadRun() {
  const r = read('run', null);
  if (!r || typeof r !== 'object' || !r.data) return null;
  return { meta: r.meta || {}, data: r.data, savedAt: r.savedAt || 0 };
}

export function hasRun() {
  return !!loadRun();
}

export function clearRun() {
  remove('run');
}
