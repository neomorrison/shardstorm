// Economy and scaling constants. Single source of truth for docs/ECONOMY.md.
// The balance pass tunes numbers here; nothing else should hard-code them.

export const TICK = 1 / 60;            // simulation step, seconds
export const WORLD_W = 1500;
export const WORLD_H = 1000;
export const BASE_SPEED = 90;          // world units per second at speed 1.0

export const START_CASH = 650;
export const SELL_RATE = 0.7;          // refund on credits actually paid
export const RIG_CAP = 10;             // max Mining Rigs alive at once

// Shell bounty multiplier c(w)
export const C_START = 50;
export const C_EXP = 2;
export function incomeFactor(w) {
  return w <= C_START ? 1 : Math.pow(C_START / w, C_EXP);
}

// Wave clear bonus
export function waveBonus(w) {
  return 100 + w;
}

// Threat budget B(w) (mass per wave)
export const B_A = 19, B_P = 0.81, B_G = 1.0514;
export const K_SURGE = 0.0007, SURGE_START = 80;
export function surge(w) {
  const x = Math.max(0, w - SURGE_START);
  return Math.exp(K_SURGE * x * x);
}
export function budget(w) {
  return B_A * Math.pow(w, B_P) * Math.pow(B_G, w) * surge(w);
}

// Spawn duration for procedural waves (seconds)
export function spawnDuration(w) {
  return Math.min(45, Math.max(10, 10 + 0.4 * w));
}

// Global enemy speed ramp v(w)
export function speedRamp(w) {
  return Math.min(2.5, 1 + 0.01 * Math.max(0, w - 80));
}

// Max top-level spawn entries per wave
export const MAX_SPAWNS_PER_WAVE = 300;

// Storm Titans
export const TITAN_EVERY = 20;
// Titan hull HP tracks the threat budget of its wave, times a factor that grows with the
// square root of the tier, so each Titan is a slightly stiffer single-target check than the
// last (wave 20: about 410 HP, wave 40: 2.8k, wave 60: 12.8k, wave 80: 51k, wave 100: 247k).
// The hull multiplier H is already part of budget(w), so it is not applied again.
export const TITAN_K = 0.7;
export function titanHp(tier) {
  const t = Math.max(1, tier);
  return Math.max(100, Math.round(TITAN_K * Math.sqrt(t) * budget(TITAN_EVERY * t) / 10) * 10);
}

// Commander XP
export function heroXpForWave(w) { return 40 + 12 * w; }
// Tuned so a Commander placed on wave 1 reaches level 10 near wave 25 and level 20 near wave 60
// (measured with the real XP sources: 0.1 XP per shell its team destroys plus 40 + 12w per wave).
export const HERO_XP_K = 35;
export function heroXpNeed(level) { return HERO_XP_K * Math.pow(level, 1.6); }
export const HERO_MAX_LEVEL = 20;

// Difficulty
export const DIFFICULTIES = {
  cadet:     { id: 'cadet',     name: 'Cadet',     costMult: 0.85, lives: 200, startCash: START_CASH },
  pilot:     { id: 'pilot',     name: 'Pilot',     costMult: 1.00, lives: 150, startCash: START_CASH },
  veteran:   { id: 'veteran',   name: 'Veteran',   costMult: 1.08, lives: 100, startCash: START_CASH },
  nightmare: { id: 'nightmare', name: 'Nightmare', costMult: 1.20, lives: 1,   startCash: START_CASH },
};

export function round5(x) { return Math.max(5, Math.round(x / 5) * 5); }
export function priceFor(base, difficultyId) {
  const d = DIFFICULTIES[difficultyId] || DIFFICULTIES.pilot;
  return round5(base * d.costMult);
}

// Efficiency targets (docs/ECONOMY.md section 3.2)
export const ETA0 = 10;
export const TIER_EFFICIENCY = [1.0, 1.05, 1.12, 1.3, 1.6, 2.5];
export const EFFICIENCY_TOLERANCE = 0.35;
