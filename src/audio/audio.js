// SHARDSTORM audio: WebAudio synth SFX and generative ambient music, driven by sim events.
// docs/ARCHITECTURE.md section 4 defines the event list this reacts to.
//
// Everything here is synthesized (oscillators, noise buffers, filters, envelopes). No audio
// files. This module is NOT part of src/sim/** or src/data/** and may freely use window,
// document, Math.random and the WebAudio API. It must never throw: every public method no-ops
// safely when WebAudio is unavailable, the context has not been unlocked yet, or when passed
// unexpected event shapes.
//
// Voice budget: at most MAX_SFX_VOICES concurrent SFX voices, and at most TYPE_WINDOW_MAX
// voices of the same sound per TYPE_WINDOW_MS window. Late waves at 3x speed can produce
// thousands of `pop` and `shot` events per second, so onEvents() aggregates any burst larger
// than BURST_THRESHOLD events of one kind into a small number of louder, richer representative
// sounds instead of playing one voice per event. Every voice disconnects its nodes when it
// ends (via `onended` plus a timeout safety net), so nothing leaks.

import { ENEMIES } from '../data/enemies.js';

const MAX_SFX_VOICES = 24;
const TYPE_WINDOW_MS = 60;
const TYPE_WINDOW_MAX = 3;
const BURST_THRESHOLD = 6;

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function clamp01(v) { return clamp(v, 0, 1); }
function lerp(a, b, t) { return a + (b - a) * t; }

// Aggregate gain for a representative sound standing in for `count` individual events.
function aggregateGain(count) {
  const n = Math.max(1, count);
  return clamp(0.6 + Math.log2(1 + n) * 0.22, 0.6, 1.8);
}

// Pitch table for the crystal-pop tinkle, derived from the meteor roster in docs/DESIGN.md
// section 4 (via src/data/enemies.js) so it stays consistent if the roster changes: small,
// early-chain shards (rust) ring bright and high; the deepest meteor (obsidian) cracks low.
const METEOR_ORDER = Object.keys(ENEMIES).filter((id) => ENEMIES[id].kind === 'meteor');
const POP_FREQ = {};
METEOR_ORDER.forEach((id, i) => {
  const t = METEOR_ORDER.length > 1 ? i / (METEOR_ORDER.length - 1) : 0;
  POP_FREQ[id] = lerp(1500, 300, t);
});
function popFreq(type) {
  if (type != null && POP_FREQ[type] != null) return POP_FREQ[type];
  // Unknown type: deterministic hash fallback so an unrecognized id never throws or sounds silent.
  const s = String(type == null ? 'x' : type);
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return 400 + (h % 900);
}

const KNOWN_SHOT_VISUALS = new Set(['bolt', 'shard', 'slug', 'rail', 'missile', 'mortar', 'tesla', 'cryo', 'flame', 'orb']);
const DTYPE_VISUAL = { KINETIC: 'bolt', BLAST: 'mortar', THERMAL: 'flame', CRYO: 'cryo', ENERGY: 'tesla', VOID: 'orb' };
function canonicalVisual(e) {
  const v = e && e.visual;
  if (v === 'rail') return 'slug';
  if (KNOWN_SHOT_VISUALS.has(v)) return v;
  return DTYPE_VISUAL[e && e.dtype] || 'bolt';
}

const EXPLODE_COLOR = { BLAST: 900, THERMAL: 1500, ENERGY: 2200, CRYO: 2000, KINETIC: 1100, VOID: 2600 };

// Ambient pad progression: A dorian (i, III, VII, v, IV, III), low register triads (Hz).
const PAD_PROGRESSION = [
  [110.00, 130.81, 164.81], // Am
  [130.81, 164.81, 196.00], // C
  [98.00, 123.47, 146.83],  // G
  [164.81, 196.00, 246.94], // Em
  [146.83, 185.00, 220.00], // D
  [130.81, 164.81, 196.00], // C
];

export class Audio {
  // Event types this module listens for (docs/ARCHITECTURE.md section 4).
  static HANDLED = [
    'shot', 'pop', 'hit', 'blocked', 'explode', 'zap', 'freeze', 'leak', 'cash',
    'waveStart', 'waveCleared', 'titan', 'titanDown', 'place', 'upgrade', 'sell',
    'ability', 'gameOver', 'shieldBreak', 'titanBlink', 'titanSpit', 'heroLevel', 'vault',
  ];

  constructor() {
    this.available = typeof window !== 'undefined' && !!(window.AudioContext || window.webkitAudioContext);
    this.ctx = null;
    this.unlocked = false;
    this.sfxVol = 0.8;
    this.musicVol = 0.5;

    // Plain (non-private) counters and windows: tools/audio-test.html reads these directly
    // to verify the voice budget stays bounded under the stress test.
    this.sfxVoices = 0;
    this.musicVoices = 0;
    this._typeWindows = new Map();

    this.musicPlaying = false;
    this.intensity = 0;
    this._musicTimer = null;
    this._musicState = null;
    this._noiseBuffer = null;

    if (this.available) {
      try {
        const Ctor = window.AudioContext || window.webkitAudioContext;
        this.ctx = new Ctor();
        this._buildGraph();
      } catch {
        this.ctx = null;
        this.available = false;
      }
    }
  }

  _buildGraph() {
    const ctx = this.ctx;
    this.sfxGain = ctx.createGain();
    this.sfxGain.gain.value = this.sfxVol;
    this.musicGain = ctx.createGain();
    this.musicGain.gain.value = this.musicVol;
    this.compressor = ctx.createDynamicsCompressor();
    try {
      this.compressor.threshold.setValueAtTime(-18, ctx.currentTime);
      this.compressor.knee.setValueAtTime(24, ctx.currentTime);
      this.compressor.ratio.setValueAtTime(4, ctx.currentTime);
      this.compressor.attack.setValueAtTime(0.003, ctx.currentTime);
      this.compressor.release.setValueAtTime(0.25, ctx.currentTime);
    } catch { /* defaults are fine */ }
    this.master = ctx.createGain();
    this.master.gain.value = 1;
    this.sfxGain.connect(this.compressor);
    this.musicGain.connect(this.compressor);
    this.compressor.connect(this.master);
    this.master.connect(ctx.destination);
  }

  get ready() { return !!(this.ctx && this.ctx.state === 'running'); }

  // Resume the AudioContext on a user gesture. Safe to call repeatedly, before the context
  // exists, or when WebAudio is unavailable.
  unlock() {
    if (!this.ctx) return;
    try {
      this.unlocked = true;
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    } catch { /* ignore */ }
  }

  setVolumes({ sfx, music } = {}) {
    if (typeof sfx === 'number' && !Number.isNaN(sfx)) {
      this.sfxVol = clamp01(sfx);
      if (this.sfxGain) this._rampGain(this.sfxGain, this.sfxVol);
    }
    if (typeof music === 'number' && !Number.isNaN(music)) {
      this.musicVol = clamp01(music);
      if (this.musicGain) this._rampGain(this.musicGain, this.musicVol);
    }
  }

  _rampGain(node, value) {
    try {
      const t = this.ctx.currentTime;
      node.gain.cancelScheduledValues(t);
      node.gain.setTargetAtTime(value, t, 0.03);
    } catch { try { node.gain.value = value; } catch { /* ignore */ } }
  }

  setIntensity(x) {
    this.intensity = clamp01(typeof x === 'number' ? x : 0);
  }

  // ---- Voice bookkeeping -------------------------------------------------

  _allow(key, windowMs = TYPE_WINDOW_MS, max = TYPE_WINDOW_MAX) {
    if (!this.ready) return false;
    if (this.sfxVoices >= MAX_SFX_VOICES) return false;
    const now = this.ctx.currentTime * 1000;
    let arr = this._typeWindows.get(key);
    if (!arr) { arr = []; this._typeWindows.set(key, arr); }
    while (arr.length && now - arr[0] > windowMs) arr.shift();
    if (arr.length >= max) return false;
    arr.push(now);
    return true;
  }

  // Hard ceiling check: a single throttled event (gated once by _allow) can still spawn several
  // sub-voices (a pop tinkle is 3 nodes, a titan horn is 4). Every node-creating primitive must
  // call this immediately before building nodes so the *total* concurrent SFX voice count never
  // exceeds MAX_SFX_VOICES no matter how many layers one logical sound uses. The music bus has
  // its own separate, uncapped counter (music never floods like combat SFX does).
  _hasVoiceBudget(bus) {
    return bus === 'music' || this.sfxVoices < MAX_SFX_VOICES;
  }

  _trackVoice(sourceNode, extraNodes, durationSec, bus = 'sfx') {
    if (bus === 'music') this.musicVoices++; else this.sfxVoices++;
    let done = false;
    const release = () => {
      if (done) return;
      done = true;
      if (bus === 'music') this.musicVoices = Math.max(0, this.musicVoices - 1);
      else this.sfxVoices = Math.max(0, this.sfxVoices - 1);
      try { sourceNode.disconnect(); } catch { /* ignore */ }
      if (extraNodes) for (const n of extraNodes) { try { n.disconnect(); } catch { /* ignore */ } }
    };
    try { sourceNode.onended = release; } catch { /* ignore */ }
    setTimeout(release, Math.ceil(Math.max(0, durationSec) * 1000) + 400);
  }

  // ---- Low level synth primitives ----------------------------------------

  _getNoiseBuffer() {
    if (this._noiseBuffer) return this._noiseBuffer;
    const ctx = this.ctx;
    const len = Math.floor(ctx.sampleRate * 2);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    this._noiseBuffer = buf;
    return buf;
  }

  // A short envelope-shaped oscillator tone. freqEnd (optional) glides the pitch.
  _tone(opts) {
    const ctx = this.ctx;
    const {
      time, freq, type = 'sine', duration = 0.15, attack = 0.005, decay = 0.06,
      sustain = 0.0001, release = 0.06, gain = 0.2, detune = 0, freqEnd = null,
      filterFreq = null, filterType = 'lowpass', filterQ = 0.7, trackBus = 'sfx',
    } = opts;
    if (!this._hasVoiceBudget(trackBus)) return null;
    const t0 = time != null ? time : ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(Math.max(1, freq), t0);
    if (freqEnd != null) osc.frequency.exponentialRampToValueAtTime(Math.max(1, freqEnd), t0 + duration);
    if (detune) { try { osc.detune.setValueAtTime(detune, t0); } catch { /* ignore */ } }
    let node = osc;
    let filter = null;
    if (filterFreq != null) {
      filter = ctx.createBiquadFilter();
      filter.type = filterType;
      filter.frequency.setValueAtTime(filterFreq, t0);
      filter.Q.value = filterQ;
      node.connect(filter);
      node = filter;
    }
    const g = ctx.createGain();
    const peak = Math.max(0.0003, gain);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + attack);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak * Math.max(sustain, 0.0003)), t0 + attack + decay);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + duration + release);
    node.connect(g);
    g.connect(this.sfxGain);
    osc.start(t0);
    osc.stop(t0 + duration + release + 0.05);
    this._trackVoice(osc, filter ? [filter, g] : [g], duration + release + 0.1, trackBus);
    return osc;
  }

  // A short filtered noise burst. filterFreqEnd (optional) sweeps the filter cutoff.
  _noiseBurst(opts) {
    const ctx = this.ctx;
    const {
      time, duration = 0.15, attack = 0.003, release = 0.12, gain = 0.25,
      filterType = 'bandpass', filterFreq = 1200, filterFreqEnd = null, filterQ = 1,
      trackBus = 'sfx',
    } = opts;
    if (!this._hasVoiceBudget(trackBus)) return null;
    const t0 = time != null ? time : ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this._getNoiseBuffer();
    const offset = Math.random() * 1.0;
    const filter = ctx.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.setValueAtTime(Math.max(20, filterFreq), t0);
    if (filterFreqEnd != null) filter.frequency.exponentialRampToValueAtTime(Math.max(20, filterFreqEnd), t0 + duration);
    filter.Q.value = filterQ;
    const g = ctx.createGain();
    const peak = Math.max(0.0003, gain);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + duration + release);
    src.connect(filter);
    filter.connect(g);
    g.connect(this.sfxGain);
    src.start(t0, offset);
    src.stop(t0 + duration + release + 0.05);
    this._trackVoice(src, [filter, g], duration + release + 0.1, trackBus);
    return src;
  }

  // ---- Event dispatch ------------------------------------------------------

  onEvents(events) {
    if (!events || !events.length) return;
    if (!this.ready) return;
    const buckets = { shot: [], pop: [], hit: [], blocked: [], cash: [] };
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      if (!e) continue;
      switch (e.t) {
        case 'shot': buckets.shot.push(e); break;
        case 'pop': buckets.pop.push(e); break;
        case 'hit': buckets.hit.push(e); break;
        case 'blocked': buckets.blocked.push(e); break;
        case 'cash': buckets.cash.push(e); break;
        case 'explode': this._onExplode(e); break;
        case 'zap': this._onZap(e); break;
        case 'freeze': this._onFreeze(e); break;
        case 'leak': this._onLeak(e); break;
        case 'waveStart': this._onWaveStart(e); break;
        case 'waveCleared': this._onWaveCleared(e); break;
        case 'titan': this._onTitan(e); break;
        case 'titanDown': this._onTitanDown(e); break;
        case 'place': this._onPlace(e); break;
        case 'upgrade': this._onUpgrade(e); break;
        case 'sell': this._onSell(e); break;
        case 'ability': this._onAbility(e); break;
        case 'gameOver': this._onGameOver(e); break;
        // engine extras (docs/ARCHITECTURE.md section 12) mapped onto existing voices
        case 'shieldBreak': this._onFreeze({ r: 260 }); this._onExplode({ r: 120, dtype: 'ENERGY' }); break;
        case 'titanBlink': this._onZap({ points: [0, 0, 0, 0, 0, 0] }); break;
        case 'titanSpit': this._onPlace(e); break;
        case 'heroLevel': this._onUpgrade({ tier: 3 }); break;
        case 'vault': this._onCash(e); break;
        default: break; // unrecognized event types are ignored, never thrown on
      }
    }
    this._dispatchBucket(buckets.pop, (e) => this._onPop(e), (e) => (e.ship ? 'ship' : (e.type || '?')), (sample, count) => this._onPop(sample, aggregateGain(count)));
    this._dispatchBucket(buckets.shot, (e) => this._onShot(e), (e) => canonicalVisual(e), (sample, count) => this._onShot(sample, aggregateGain(count)));
    this._dispatchBucket(buckets.hit, (e) => this._onHit(e), () => 'hit', (sample, count) => this._onHit(sample, aggregateGain(count)));
    this._dispatchBucket(buckets.blocked, (e) => this._onBlocked(e), () => 'blocked', (sample, count) => this._onBlocked(sample, aggregateGain(count)));
    this._dispatchBucket(buckets.cash, (e) => this._onCash(e), () => 'cash', (sample, count) => this._onCash(sample, aggregateGain(count)));
  }

  // Plays every event individually when the burst is small; otherwise groups events by
  // `groupKeyFn` and plays one louder representative sound per (top 3) group. This is the
  // "aggregate bursts into one louder sound" throttle required for thousands-per-second floods.
  _dispatchBucket(list, playOne, groupKeyFn, playGroup) {
    if (!list.length) return;
    if (list.length <= BURST_THRESHOLD) {
      for (let i = 0; i < list.length; i++) playOne(list[i]);
      return;
    }
    const groups = new Map();
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      const k = groupKeyFn(e);
      const prev = groups.get(k);
      const n = e.count && e.count > 1 ? e.count : 1;
      if (prev) { prev.count += n; } else { groups.set(k, { count: n, sample: e }); }
    }
    const top = [...groups.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 3);
    for (const [, { count, sample }] of top) playGroup(sample, count);
  }

  // ---- Individual sound handlers -------------------------------------------

  _onPop(e, gainMult = 1) {
    const ship = !!e.ship;
    const key = ship ? 'pop:ship' : 'pop:' + (e.type || 'x');
    if (!this._allow(key)) return;
    const t = this.ctx.currentTime;
    const countBoost = e.count && e.count > 1 ? aggregateGain(e.count) / aggregateGain(1) : 1;
    const g = 0.5 * gainMult * countBoost;
    if (ship) this._synthShipCrunch(t, g);
    else this._synthPopTinkle(t, popFreq(e.type), g);
  }

  _synthPopTinkle(t, freq, gain) {
    const jitter = 1 + (Math.random() - 0.5) * 0.08; // "randomized slightly"
    const f = freq * jitter;
    this._tone({ time: t, freq: f, freqEnd: f * 1.35, type: 'sine', duration: 0.05, attack: 0.001, decay: 0.05, release: 0.09, gain: gain * 0.55 });
    this._tone({ time: t, freq: f * 2.01, type: 'triangle', duration: 0.03, attack: 0.001, decay: 0.03, release: 0.06, gain: gain * 0.22 });
    this._noiseBurst({ time: t, duration: 0.012, attack: 0.001, release: 0.02, gain: gain * 0.12, filterType: 'highpass', filterFreq: 6000 });
  }

  _synthShipCrunch(t, gain) {
    this._noiseBurst({ time: t, duration: 0.09, attack: 0.001, release: 0.1, gain: gain * 0.7, filterType: 'bandpass', filterFreq: 500, filterFreqEnd: 220, filterQ: 0.7 });
    this._tone({ time: t, freq: 85, freqEnd: 48, type: 'triangle', duration: 0.1, attack: 0.001, decay: 0.05, release: 0.12, gain: gain * 0.6 });
  }

  _onShot(e, gainMult = 1) {
    const visual = canonicalVisual(e);
    if (!this._allow('shot:' + visual)) return;
    const t = this.ctx.currentTime;
    this._synthShot(t, visual, 0.22 * gainMult);
  }

  _synthShot(t, visual, g) {
    switch (visual) {
      case 'bolt':
        this._tone({ time: t, freq: 1100, freqEnd: 500, type: 'sawtooth', duration: 0.05, attack: 0.002, decay: 0.03, release: 0.03, gain: g, filterFreq: 3500 });
        break;
      case 'shard':
        this._tone({ time: t, freq: 900, freqEnd: 650, type: 'square', duration: 0.045, attack: 0.001, decay: 0.02, release: 0.03, gain: g * 0.9 });
        this._noiseBurst({ time: t, duration: 0.03, attack: 0.001, release: 0.03, gain: g * 0.35, filterType: 'highpass', filterFreq: 4000 });
        break;
      case 'slug':
        this._noiseBurst({ time: t, duration: 0.02, attack: 0.001, release: 0.05, gain: g * 1.1, filterType: 'bandpass', filterFreq: 2200, filterQ: 0.6 });
        this._tone({ time: t, freq: 90, freqEnd: 45, type: 'sine', duration: 0.05, attack: 0.001, decay: 0.02, release: 0.08, gain: g * 0.5 });
        break;
      case 'missile':
        this._noiseBurst({ time: t, duration: 0.22, attack: 0.02, release: 0.12, gain: g * 0.7, filterType: 'bandpass', filterFreq: 700, filterFreqEnd: 1600, filterQ: 0.8 });
        this._tone({ time: t, freq: 160, freqEnd: 90, type: 'sawtooth', duration: 0.18, attack: 0.01, decay: 0.05, release: 0.1, gain: g * 0.4, filterFreq: 900 });
        break;
      case 'mortar':
        this._tone({ time: t, freq: 130, freqEnd: 60, type: 'sine', duration: 0.1, attack: 0.002, decay: 0.04, release: 0.1, gain: g * 0.9 });
        this._noiseBurst({ time: t, duration: 0.06, attack: 0.001, release: 0.08, gain: g * 0.4, filterType: 'lowpass', filterFreq: 500 });
        break;
      case 'tesla':
        this._noiseBurst({ time: t, duration: 0.03, attack: 0.001, release: 0.04, gain: g * 0.8, filterType: 'highpass', filterFreq: 3000 });
        this._tone({ time: t, freq: 2400, type: 'square', duration: 0.02, attack: 0.001, decay: 0.01, release: 0.02, gain: g * 0.3 });
        break;
      case 'cryo':
        this._noiseBurst({ time: t, duration: 0.18, attack: 0.01, release: 0.15, gain: g * 0.55, filterType: 'bandpass', filterFreq: 2600, filterFreqEnd: 1400, filterQ: 3 });
        this._tone({ time: t, freq: 1800, type: 'sine', duration: 0.15, attack: 0.01, decay: 0.06, release: 0.15, gain: g * 0.25 });
        break;
      case 'flame':
        this._noiseBurst({ time: t, duration: 0.12, attack: 0.005, release: 0.1, gain: g * 0.6, filterType: 'bandpass', filterFreq: 1200, filterQ: 0.9 });
        break;
      case 'orb':
        this._tone({ time: t, freq: 300, type: 'sine', duration: 0.15, attack: 0.03, decay: 0.05, release: 0.12, gain: g * 0.5, filterFreq: 1200 });
        break;
      default:
        this._tone({ time: t, freq: 1100, freqEnd: 500, type: 'sawtooth', duration: 0.05, attack: 0.002, decay: 0.03, release: 0.03, gain: g, filterFreq: 3500 });
    }
  }

  _onHit(e, gainMult = 1) {
    if (!this._allow('hit')) return;
    const t = this.ctx.currentTime;
    this._tone({ time: t, freq: 1800, freqEnd: 1400, type: 'sine', duration: 0.015, attack: 0.001, decay: 0.015, release: 0.02, gain: 0.08 * gainMult });
  }

  _onBlocked(e, gainMult = 1) {
    if (!this._allow('blocked')) return;
    const t = this.ctx.currentTime;
    const g = 0.18 * gainMult;
    this._tone({ time: t, freq: 2600, freqEnd: 2100, type: 'square', duration: 0.02, attack: 0.001, decay: 0.015, release: 0.03, gain: g });
    this._noiseBurst({ time: t, duration: 0.015, attack: 0.001, release: 0.02, gain: g * 0.4, filterType: 'highpass', filterFreq: 5000 });
  }

  _onCash(e, gainMult = 1) {
    if (!this._allow('cash')) return;
    const t = this.ctx.currentTime;
    this._tone({ time: t, freq: 1500, freqEnd: 2000, type: 'sine', duration: 0.02, attack: 0.001, decay: 0.02, release: 0.03, gain: 0.09 * gainMult });
  }

  _onExplode(e) {
    if (!this._allow('explode')) return;
    const t = this.ctx.currentTime;
    const r = clamp(e.r || 60, 20, 400);
    const size = (r - 20) / 380;
    const duration = 0.2 + size * 0.7;
    const gain = 0.35 + size * 0.55;
    const colorFreq = EXPLODE_COLOR[e.dtype] || 1000;
    this._noiseBurst({ time: t, duration, attack: 0.005, release: 0.25 + size * 0.3, gain: gain * 0.7, filterType: 'lowpass', filterFreq: colorFreq, filterFreqEnd: 200, filterQ: 0.5 });
    this._tone({ time: t, freq: 95 - size * 35, freqEnd: 32, type: 'sine', duration: duration * 0.6, attack: 0.005, decay: 0.05, release: 0.3 + size * 0.3, gain: gain * 0.8 });
  }

  _onZap(e) {
    if (!this._allow('zap')) return;
    const t = this.ctx.currentTime;
    const jumps = clamp((e.points && e.points.length) || 2, 1, 8);
    const cracks = Math.min(jumps, 4);
    for (let i = 0; i < cracks; i++) {
      this._noiseBurst({ time: t + i * 0.012, duration: 0.02, attack: 0.001, release: 0.03, gain: 0.18 / (i * 0.4 + 1), filterType: 'highpass', filterFreq: 3500 + Math.random() * 1500 });
    }
    this._tone({ time: t, freq: 3200, type: 'square', duration: 0.02, attack: 0.001, decay: 0.015, release: 0.03, gain: 0.08 });
  }

  _onFreeze(e) {
    if (!this._allow('freeze')) return;
    const t = this.ctx.currentTime;
    const r = clamp(e.r || 80, 20, 300);
    const g = 0.12 + (r / 300) * 0.1;
    for (const f of [2400, 3000, 3600]) {
      this._tone({ time: t, freq: f, type: 'sine', duration: 0.3, attack: 0.02, decay: 0.15, release: 0.3, gain: g * 0.4 });
    }
  }

  _onLeak(e) {
    if (!this._allow('leak', 220, 2)) return;
    if (!this._hasVoiceBudget('sfx')) return;
    const t = this.ctx.currentTime;
    const mass = e.mass || 1;
    const g = clamp(0.25 + Math.log10(1 + mass) * 0.08, 0.25, 0.6);
    const osc = this.ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(440, t);
    osc.frequency.linearRampToValueAtTime(330, t + 0.15);
    osc.frequency.linearRampToValueAtTime(440, t + 0.3);
    const filt = this.ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.value = 1600;
    const gn = this.ctx.createGain();
    gn.gain.setValueAtTime(0.0001, t);
    gn.gain.exponentialRampToValueAtTime(g, t + 0.02);
    gn.gain.setValueAtTime(g, t + 0.28);
    gn.gain.exponentialRampToValueAtTime(0.0001, t + 0.38);
    osc.connect(filt);
    filt.connect(gn);
    gn.connect(this.sfxGain);
    osc.start(t);
    osc.stop(t + 0.4);
    this._trackVoice(osc, [filt, gn], 0.4);
  }

  _onWaveStart(e) {
    if (!this._allow('waveStart', 2000, 1)) return;
    const t = this.ctx.currentTime;
    const notes = [523.25, 659.25, 783.99, 1046.5]; // C5 E5 G5 C6
    notes.forEach((f, i) => this._tone({ time: t + i * 0.07, freq: f, type: 'triangle', duration: 0.12, attack: 0.004, decay: 0.05, release: 0.12, gain: 0.16, filterFreq: 4000 }));
  }

  _onWaveCleared(e) {
    if (!this._allow('waveCleared', 2000, 1)) return;
    const t = this.ctx.currentTime;
    const notes = [392.0, 493.88, 587.33, 783.99, 987.77]; // G4 B4 D5 G5 B5
    notes.forEach((f, i) => this._tone({ time: t + i * 0.09, freq: f, type: 'sine', duration: 0.18, attack: 0.005, decay: 0.08, release: 0.2, gain: 0.18 }));
  }

  _onTitan(e) {
    if (!this._allow('titan', 3000, 1)) return;
    const t = this.ctx.currentTime;
    const root = { maw: 110, aegis: 98, rift: 123.47 }[e.kind] || 110;
    const duration = 1.6;
    const layers = [[1, 'sawtooth', 0.5], [1.005, 'sawtooth', 0.4], [2, 'square', 0.15], [0.5, 'sine', 0.5]];
    for (const [mul, type, gm] of layers) {
      if (!this._hasVoiceBudget('sfx')) break;
      const osc = this.ctx.createOscillator();
      osc.type = type;
      osc.frequency.setValueAtTime(root * mul, t);
      const filt = this.ctx.createBiquadFilter();
      filt.type = 'lowpass';
      filt.frequency.setValueAtTime(400, t);
      filt.frequency.linearRampToValueAtTime(1200, t + 0.5);
      filt.Q.value = 0.5;
      const gn = this.ctx.createGain();
      gn.gain.setValueAtTime(0.0001, t);
      gn.gain.exponentialRampToValueAtTime(0.35 * gm, t + 0.45);
      gn.gain.setValueAtTime(0.35 * gm, t + duration - 0.5);
      gn.gain.exponentialRampToValueAtTime(0.0001, t + duration);
      osc.connect(filt);
      filt.connect(gn);
      gn.connect(this.sfxGain);
      osc.start(t);
      osc.stop(t + duration + 0.1);
      this._trackVoice(osc, [filt, gn], duration + 0.2);
    }
  }

  _onTitanDown(e) {
    if (!this._allow('titanDown', 3000, 1)) return;
    const t = this.ctx.currentTime;
    this._noiseBurst({ time: t, duration: 0.9, attack: 0.01, release: 0.6, gain: 0.9, filterType: 'lowpass', filterFreq: 1400, filterFreqEnd: 150, filterQ: 0.5 });
    this._tone({ time: t, freq: 60, freqEnd: 24, type: 'sine', duration: 0.8, attack: 0.01, decay: 0.1, release: 0.7, gain: 0.9 });
    const shimmerNotes = [1046.5, 1318.5, 1568.0, 2093.0];
    shimmerNotes.forEach((f, i) => this._tone({ time: t + 0.25 + i * 0.06, freq: f, type: 'sine', duration: 0.5, attack: 0.02, decay: 0.2, release: 0.5, gain: 0.14 }));
  }

  _onPlace(e) {
    if (!this._allow('place')) return;
    const t = this.ctx.currentTime;
    this._tone({ time: t, freq: 180, freqEnd: 70, type: 'triangle', duration: 0.07, attack: 0.001, decay: 0.03, release: 0.08, gain: 0.35 });
    this._noiseBurst({ time: t, duration: 0.02, attack: 0.001, release: 0.03, gain: 0.15, filterType: 'lowpass', filterFreq: 400 });
  }

  _onUpgrade(e) {
    if (!this._allow('upgrade')) return;
    const t = this.ctx.currentTime;
    const tier = clamp(e.tier || 1, 1, 5);
    const baseNotes = [784.0, 987.77, 1174.66, 1567.98, 2349.32];
    const count = 2 + tier;
    for (let i = 0; i < count; i++) {
      const f = baseNotes[Math.min(i, baseNotes.length - 1)] * (1 + i * 0.02);
      this._tone({ time: t + i * 0.035, freq: f, type: 'sine', duration: 0.1, attack: 0.003, decay: 0.04, release: 0.12, gain: 0.13 });
    }
  }

  _onSell(e) {
    if (!this._allow('sell')) return;
    const t = this.ctx.currentTime;
    const value = e.value || 100;
    const coins = clamp(2 + Math.floor(Math.log2(1 + value / 50)), 2, 6);
    for (let i = 0; i < coins; i++) {
      const f = 1400 + Math.random() * 500;
      this._tone({ time: t + i * 0.045, freq: f, freqEnd: f * 1.2, type: 'square', duration: 0.03, attack: 0.001, decay: 0.02, release: 0.05, gain: 0.12 });
    }
  }

  _onAbility(e) {
    if (!this._allow('ability')) return;
    const t = this.ctx.currentTime;
    this._noiseBurst({ time: t, duration: 0.3, attack: 0.02, release: 0.2, gain: 0.35, filterType: 'bandpass', filterFreq: 400, filterFreqEnd: 2400, filterQ: 0.7 });
  }

  _onGameOver(e) {
    if (!this._allow('gameOver', 5000, 1)) return;
    const t = this.ctx.currentTime;
    const notes = [587.33, 523.25, 466.16, 392.0, 293.66]; // D5 C5 Bb4 G4 D4: descending
    notes.forEach((f, i) => this._tone({ time: t + i * 0.28, freq: f, type: 'triangle', duration: 0.4, attack: 0.01, decay: 0.15, release: 0.35, gain: 0.22, filterFreq: 2200 }));
    this._tone({ time: t + notes.length * 0.28, freq: 130.81, type: 'sine', duration: 1.2, attack: 0.05, decay: 0.3, release: 1.0, gain: 0.25 });
  }

  // ---- UI sounds -------------------------------------------------------

  click() {
    if (!this._allow('click', 40, 4)) return;
    const t = this.ctx.currentTime;
    this._tone({ time: t, freq: 900, freqEnd: 700, type: 'triangle', duration: 0.04, attack: 0.001, decay: 0.03, release: 0.03, gain: 0.16 });
  }

  hover() {
    if (!this._allow('hover', 40, 1)) return;
    const t = this.ctx.currentTime;
    this._tone({ time: t, freq: 1500, type: 'sine', duration: 0.025, attack: 0.001, decay: 0.02, release: 0.02, gain: 0.06 });
  }

  // ---- Generative ambient music ------------------------------------------
  //
  // A gentle space pad loop (slow chords in A dorian) with a sparse arpeggio whose density
  // and brightness track setIntensity(). Scheduled with lookahead timing (the standard WebAudio
  // pattern) via a low-frequency setInterval poller, so CPU cost is negligible between notes.

  startMusic() {
    if (!this.ctx || this.musicPlaying) return;
    this.musicPlaying = true;
    const now = this.ctx.currentTime;
    this._musicState = { nextChordTime: now + 0.15, nextArpTime: now + 1.0, chordIndex: 0 };
    if (this._musicTimer) clearInterval(this._musicTimer);
    this._musicTimer = setInterval(() => this._scheduleMusic(), 100);
    this._scheduleMusic();
  }

  stopMusic() {
    if (this._musicTimer) { clearInterval(this._musicTimer); this._musicTimer = null; }
    this.musicPlaying = false;
    // Already-scheduled notes ring out through their own release envelopes; no hard cut.
  }

  _scheduleMusic() {
    if (!this.ready || !this.musicPlaying || !this._musicState) return;
    const ctx = this.ctx;
    const LOOKAHEAD = 0.25;
    const st = this._musicState;
    let guard = 0;
    while (st.nextChordTime < ctx.currentTime + LOOKAHEAD && guard++ < 8) {
      const chord = PAD_PROGRESSION[st.chordIndex % PAD_PROGRESSION.length];
      const duration = 10 + Math.random() * 4;
      this._playPadChord(chord, duration, st.nextChordTime);
      st.chordIndex++;
      st.nextChordTime += duration;
    }
    guard = 0;
    while (st.nextArpTime < ctx.currentTime + LOOKAHEAD && guard++ < 32) {
      const chord = PAD_PROGRESSION[(st.chordIndex - 1 + PAD_PROGRESSION.length) % PAD_PROGRESSION.length];
      const interval = lerp(1.1, 0.32, this.intensity) * (0.75 + Math.random() * 0.5);
      const playProb = 0.35 + this.intensity * 0.55;
      if (Math.random() < playProb) {
        const pool = [chord[0], chord[1], chord[2], chord[0] * 2, chord[1] * 2, chord[2] * 2];
        const freq = pool[Math.floor(Math.random() * pool.length)];
        this._playArpNote(freq, st.nextArpTime);
      }
      st.nextArpTime += interval;
    }
  }

  _playPadChord(freqs, duration, time) {
    const ctx = this.ctx;
    const chordGain = ctx.createGain();
    chordGain.gain.setValueAtTime(0.0001, time);
    const attack = Math.min(3, duration * 0.25);
    const release = Math.min(4, duration * 0.35);
    chordGain.gain.linearRampToValueAtTime(0.22, time + attack);
    chordGain.gain.setValueAtTime(0.22, Math.max(time + attack, time + duration - release));
    chordGain.gain.linearRampToValueAtTime(0.0001, time + duration);
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(1100, time);
    filter.Q.value = 0.4;
    chordGain.connect(filter);
    filter.connect(this.musicGain);

    const layers = [['sine', -4, 1], ['triangle', 5, 0.55]];
    for (const f of freqs) {
      for (const [type, detune, gm] of layers) {
        const osc = ctx.createOscillator();
        osc.type = type;
        osc.frequency.setValueAtTime(f, time);
        try { osc.detune.setValueAtTime(detune, time); } catch { /* ignore */ }
        const g = ctx.createGain();
        g.gain.value = gm * 0.5;
        osc.connect(g);
        g.connect(chordGain);
        osc.start(time);
        osc.stop(time + duration + 0.15);
        this._trackVoice(osc, [g], duration + 0.25, 'music');
      }
    }
    // Sub layer (root, one octave down) for warmth.
    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(freqs[0] / 2, time);
    const subGain = ctx.createGain();
    subGain.gain.value = 0.3;
    sub.connect(subGain);
    subGain.connect(chordGain);
    sub.start(time);
    sub.stop(time + duration + 0.15);
    this._trackVoice(sub, [subGain], duration + 0.25, 'music');

    // chordGain/filter are shared by every layer above; disconnect them once on a dedicated
    // timer rather than tying their cleanup to any single layer's onended (all layers stop at
    // nearly the same scheduled time, so ordering between their `ended` events is not
    // guaranteed, and disconnecting the shared bus from inside one layer's cleanup could cut
    // another layer's release tail a few ms early).
    const t0ms = (time - ctx.currentTime) * 1000;
    setTimeout(() => {
      try { chordGain.disconnect(); } catch { /* ignore */ }
      try { filter.disconnect(); } catch { /* ignore */ }
    }, Math.max(0, Math.ceil(t0ms)) + Math.ceil((duration + 0.3) * 1000));
  }

  _playArpNote(freq, time) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(freq, time);
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(700 + this.intensity * 3200, time);
    filter.Q.value = 0.7;
    const g = ctx.createGain();
    const peak = 0.09 + this.intensity * 0.08;
    g.gain.setValueAtTime(0.0001, time);
    g.gain.exponentialRampToValueAtTime(peak, time + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, time + 0.9);
    osc.connect(filter);
    filter.connect(g);
    g.connect(this.musicGain);
    osc.start(time);
    osc.stop(time + 1.0);
    this._trackVoice(osc, [filter, g], 1.0, 'music');
  }
}
