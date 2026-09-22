// Number formatting, the credit glyph, damage type labels and the small inline icon set.
// Everything here returns plain strings (HTML where noted). No DOM access.

const NF = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

/** Whole number with thousands separators: 1234.7 -> "1,234". */
export function int(n) {
  if (!Number.isFinite(n)) return n > 0 ? '∞' : '0';
  return NF.format(Math.floor(n + 1e-9));
}

/** Compact number: 950 -> "950", 12400 -> "12.4k", 3100000 -> "3.1M". */
export function short(n) {
  if (!Number.isFinite(n)) return n > 0 ? '∞' : '0';
  const a = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (a < 10000) return sign + int(a);
  const units = [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'k']];
  for (const [v, u] of units) {
    if (a >= v) {
      const x = a / v;
      return sign + String(parseFloat(x >= 100 ? Math.floor(x) : x >= 10 ? x.toFixed(1) : x.toFixed(2))) + u;
    }
  }
  return sign + int(a);
}

/** Credits for the HUD: full precision up to 10M, compact after. */
export function money(n) {
  return n >= 1e7 ? short(n) : int(n);
}

/** One decimal when useful: 1.25 -> "1.3", 2 -> "2". */
export function dec(n, digits = 1) {
  if (!Number.isFinite(n)) return n > 0 ? '∞' : '0';
  const s = n.toFixed(digits);
  return s.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
}

export function pct(x, digits = 0) {
  return dec(x * 100, digits) + '%';
}

/** Seconds as "m:ss" or "h:mm:ss". */
export function clock(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** Long durations for lifetime totals: "3h 12m", "45m", "20s". */
export function duration(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m`;
  return `${sec}s`;
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
}

/** Replaces any em or en dash that slipped into data text with a comma pause. */
const EM_DASH = new RegExp('\\s*' + String.fromCharCode(0x2014) + '\\s*', 'g');
const EN_DASH = new RegExp('\\s*' + String.fromCharCode(0x2013) + '\\s*', 'g');
export function clean(s) {
  return String(s ?? '').replace(EM_DASH, ', ').replace(EN_DASH, ' to ');
}

// ---- damage types ----------------------------------------------------------------

export const DTYPE_INFO = {
  KINETIC: { label: 'Kinetic', color: '#c9d4e6', blurb: 'Bullets, shards and slugs. Cannot hurt Iron or frozen targets.' },
  BLAST:   { label: 'Blast',   color: '#ff9f43', blurb: 'Missiles, bombs and shells. Cannot hurt Magma.' },
  THERMAL: { label: 'Thermal', color: '#ff5e5e', blurb: 'Lasers, fire and burn. Cannot hurt Prism.' },
  CRYO:    { label: 'Cryo',    color: '#7fdcff', blurb: 'Freeze pulses and cryo shots. Cannot hurt or freeze Comets.' },
  ENERGY:  { label: 'Energy',  color: '#c58bff', blurb: 'Tesla arcs and ball lightning. Cannot hurt Prism.' },
  VOID:    { label: 'Void',    color: '#ff5fd2', blurb: 'Rare, high tier only. Damages everything.' },
};

export function dtypeLabel(t) {
  return DTYPE_INFO[t]?.label || (t ? String(t).charAt(0) + String(t).slice(1).toLowerCase() : 'None');
}

/** HTML chip for a damage type. */
export function dtypeChip(t, extraClass = '') {
  const info = DTYPE_INFO[t];
  const color = info ? info.color : '#9fb0cf';
  return `<span class="chip chip--dtype ${extraClass}" style="--chip:${color}">${esc(dtypeLabel(t))}</span>`;
}

export const TARGET_LABELS = {
  first: 'First', last: 'Last', strong: 'Strong', close: 'Close', weak: 'Weak', far: 'Far',
  ships: 'Ships', ship: 'Ships', manual: 'Manual', lock: 'Lock', random: 'Random', smart: 'Smart',
};
export function targetLabel(mode) {
  return TARGET_LABELS[mode] || String(mode || '').replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// ---- icons -----------------------------------------------------------------------

const P = {
  pause: '<rect x="6.5" y="5" width="3.6" height="14" rx="1.2" fill="currentColor" stroke="none"/><rect x="13.9" y="5" width="3.6" height="14" rx="1.2" fill="currentColor" stroke="none"/>',
  play: '<path d="M8 5.5v13l10.5-6.5z" fill="currentColor" stroke="none"/>',
  fast: '<path d="M4.5 6v12l7.5-6zM12.5 6v12l7.5-6z" fill="currentColor" stroke="none"/>',
  auto: '<path d="M19.5 12a7.5 7.5 0 0 1-13.2 4.9"/><path d="M4.5 12a7.5 7.5 0 0 1 13.2-4.9"/><path d="M17.9 3.6v3.6h-3.6"/><path d="M6.1 20.4v-3.6h3.6"/>',
  gear: '<circle cx="12" cy="12" r="3.2"/><path d="M12 2.8v2.6M12 18.6v2.6M21.2 12h-2.6M5.4 12H2.8M18.5 5.5l-1.8 1.8M7.3 16.7l-1.8 1.8M18.5 18.5l-1.8-1.8M7.3 7.3L5.5 5.5"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  back: '<path d="M14.5 5.5L8 12l6.5 6.5"/>',
  left: '<path d="M14 6l-6 6 6 6"/>',
  right: '<path d="M10 6l6 6-6 6"/>',
  core: '<path d="M12 2.8l8 4.6v9.2l-8 4.6-8-4.6V7.4z"/><path d="M12 8l3.5 4L12 16l-3.5-4z" fill="currentColor"/>',
  wave: '<path d="M3 9c2.2-2.4 4.4-2.4 6.6 0s4.4 2.4 6.6 0 3.3-1.8 4.8-1"/><path d="M3 15c2.2-2.4 4.4-2.4 6.6 0s4.4 2.4 6.6 0 3.3-1.8 4.8-1"/>',
  target: '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.2" fill="currentColor"/><path d="M12 2v3.5M12 18.5V22M2 12h3.5M18.5 12H22"/>',
  sell: '<path d="M12 3.5v11"/><path d="M7.5 10.5L12 15l4.5-4.5"/><path d="M4.5 19.5h15"/>',
  undo: '<path d="M8.5 7.5H15a5 5 0 0 1 0 10H8"/><path d="M11.5 4L8 7.5l3.5 3.5"/>',
  lock: '<rect x="5.5" y="10.5" width="13" height="9.5" rx="2"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/>',
  trophy: '<path d="M8 4.5h8v5a4 4 0 0 1-8 0z"/><path d="M8 6.5H5a3 3 0 0 0 3 4M16 6.5h3a3 3 0 0 1-3 4"/><path d="M12 13.5v3.5M8.5 20h7M10 17h4"/>',
  book: '<path d="M4.5 5.5c2.5-1 5-1 7.5.5v13c-2.5-1.5-5-1.5-7.5-.5z"/><path d="M19.5 5.5c-2.5-1-5-1-7.5.5v13c2.5-1.5 5-1.5 7.5-.5z"/>',
  up: '<path d="M12 19V6"/><path d="M6.5 11.5L12 6l5.5 5.5"/>',
  vault: '<rect x="3.5" y="5.5" width="17" height="13" rx="2"/><circle cx="12" cy="12" r="3"/><path d="M12 9v-1.5M12 16.5V15M9 12H7.5M16.5 12H15"/>',
  star: '<path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.8z" fill="currentColor" stroke="none"/>',
  skull: '<path d="M12 3.5c-4.4 0-7.5 3-7.5 7 0 2.4 1.1 4.2 2.8 5.2V19h9.4v-3.3c1.7-1 2.8-2.8 2.8-5.2 0-4-3.1-7-7.5-7z"/><circle cx="9.2" cy="11" r="1.6" fill="currentColor"/><circle cx="14.8" cy="11" r="1.6" fill="currentColor"/>',
  grid: '<rect x="4" y="4" width="6.5" height="6.5" rx="1.2"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.2"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.2"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.2"/>',
  chevup: '<path d="M6 15l6-6 6 6"/>',
  chevdown: '<path d="M6 9l6 6 6-6"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
  restart: '<path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3"/><path d="M4.5 4.5v4h4"/>',
  home: '<path d="M4 11.5L12 4.5l8 7"/><path d="M6.5 10v9.5h11V10"/>',
  map: '<path d="M3.5 6.5l5.5-2 6 2 5.5-2v13l-5.5 2-6-2-5.5 2z"/><path d="M9 4.5v13M15 6.5v13"/>',
  bolt: '<path d="M13 2.5L5 13.5h6l-1 8 8-11h-6z" fill="currentColor" stroke="none"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5"/><circle cx="12" cy="7.8" r="1.1" fill="currentColor" stroke="none"/>',
  sound: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>',
};

/** Inline SVG icon (24 unit box, stroked with currentColor). */
export function icon(name, cls = '') {
  const body = P[name] || P.info;
  return `<svg class="ico ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
}

/** The small faceted crystal that marks credits. */
export function glyph(cls = '') {
  return `<svg class="glyph ${cls}" viewBox="0 0 12 16" aria-hidden="true" focusable="false"><path d="M6 .6 11.4 6 6 15.4.6 6z" fill="url(#ssCredit)"/><path d="M6 .6 8.6 6 6 15.4 3.4 6z" fill="rgba(255,255,255,.28)"/><path d="M.6 6h10.8" stroke="rgba(120,50,0,.45)" stroke-width=".8"/></svg>`;
}

/** Credits with glyph as HTML: "<glyph> 1,234". */
export function credits(n, cls = '') {
  return `<span class="cr ${cls}">${glyph()}<span class="cr__n">${money(n)}</span></span>`;
}

/** Plain text credits for aria labels. */
export function creditsText(n) {
  return `${money(n)} credits`;
}

/** Turns an engine reason code or sentence into a short player-facing line. */
export function friendlyReason(r) {
  if (!r) return 'Not available';
  const s = String(r);
  const k = s.toLowerCase();
  if (/cash|credit|fund|afford|money|cost/.test(k) && !/\s{1}.*\s/.test(s)) return 'Not enough credits';
  if (/^(path|channel|onpath|on_path)$/.test(k)) return 'Too close to the channel';
  if (/^(overlap|tower|towers|occupied|collide|collision)$/.test(k)) return 'Too close to another tower';
  if (/^(blocker|blocked|rock|crater|terrain)$/.test(k)) return 'Blocked terrain';
  if (/^(bounds|outside|edge|oob)$/.test(k)) return 'Outside the build zone';
  if (/^(cap|limit|max|rigcap|rig_cap)$/.test(k)) return 'Limit reached';
  if (/^(hero|herolimit|commander)$/.test(k)) return 'Commander already deployed';
  if (/^(phase|busy|spawning|wave)$/.test(k)) return 'Not right now';
  if (/^(maxed|max_tier)$/.test(k)) return 'Path maxed';
  if (/^(locked|crosspath)$/.test(k)) return 'Path locked';
  if (/^(t5|tier5|t5owned)$/.test(k)) return 'Tier 5 owned elsewhere';
  if (/^(unaffordable|nocash|no_cash|cash)$/.test(k)) return 'Not enough credits';
  if (/^(unknown|invalid|notfound|not_found)$/.test(k)) return 'Not available';
  // already a sentence from the engine: make sure it reads like product copy
  const t = clean(s).trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}
