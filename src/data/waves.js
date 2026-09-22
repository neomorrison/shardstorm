// Authored waves 1..40 and the enemy unlock schedule (docs/ECONOMY.md 4.5, docs/WAVES.md).
// PURE data: no DOM, no randomness. Consumed by src/sim/wavegen.js.
//
// Group fields: type, count, start (s), spacing (s between spawns), lane, mods.
// lane: 0 or 1 pins the group to a lane on two-lane maps, -1 alternates spawns between lanes.
// On one-lane maps every lane resolves to 0 (wavegen does that).
// Budget target per wave is budget(w) from src/data/economy.js; every authored wave must be
// within +-20% of it (tools/wavecheck.mjs asserts this). The comment after each wave is its
// planned mass ratio: breathers sit near 0.86, spikes before milestones near 1.15.

// First wave each enemy type (and modifier) may appear. The generator never uses a type
// before this wave, and the authored list debuts each one exactly on schedule.
export const UNLOCK = {
  rust: 1, cobalt: 3, jade: 5, amber: 9, rose: 12,
  iron: 16, magma: 18, comet: 18, prism: 22, geode: 24, aurora: 28, obsidian: 32,
  hauler: 40, warbarge: 50, specter: 50, dreadnought: 70, worldbreaker: 90,
};
export const MOD_UNLOCK = { phantom: 14, nanite: 22, plated: 35 };

function mods(s) {
  return { phantom: s.includes('phantom'), nanite: s.includes('nanite'), plated: s.includes('plated') };
}
function g(type, count, start, spacing, lane = -1, m = '') {
  return { type, count, start, spacing, lane, mods: mods(m) };
}

// name: short wave title for the banner. tip: optional one-line hint shown when the wave starts.
// titanStart: optional override for when the Storm Titan enters (titan waves only).
export const AUTHORED_WAVES = [
  { // 1 (1.00)
    name: 'First Fall',
    tip: 'Meteors follow the glowing channel to the Core. Place turrets beside it.',
    groups: [g('rust', 20, 0, 0.5)],
  },
  { // 2 (0.95)
    name: 'Drizzle',
    groups: [g('rust', 20, 0, 0.5, 0), g('rust', 15, 2.25, 0.55, 1)],
  },
  { // 3 (1.00) cobalt
    name: 'Blue Shift',
    tip: 'Cobalt Shards crack into Rust Shards. Every shell you break pays credits.',
    groups: [g('rust', 24, 0, 0.42), g('cobalt', 15, 3, 0.55)],
  },
  { // 4 (1.01)
    name: 'Crossfire',
    groups: [
      g('rust', 20, 0, 0.4, 0), g('cobalt', 10, 1.5, 0.5, 1),
      g('rust', 12, 6, 0.25), g('cobalt', 10, 8.5, 0.35),
    ],
  },
  { // 5 (0.96) jade
    name: 'Green Flash',
    tip: 'Jade Shards move faster and hold two more shells.',
    groups: [
      g('rust', 20, 0, 0.4), g('cobalt', 12, 2, 0.5),
      g('jade', 6, 6, 0.8), g('cobalt', 12, 8, 0.3),
    ],
  },
  { // 6 (1.05)
    name: 'Rush Hour',
    groups: [
      g('cobalt', 20, 0, 0.4), g('rust', 25, 1, 0.2, 0),
      g('jade', 10, 5, 0.6, 1), g('cobalt', 10, 9.5, 0.25),
    ],
  },
  { // 7 (0.90) breather
    name: 'Lull',
    groups: [g('jade', 14, 0, 0.8), g('cobalt', 20, 1, 0.5), g('rust', 36, 3, 0.25)],
  },
  { // 8 (1.07)
    name: 'Green Tide',
    groups: [
      g('jade', 20, 0, 0.5, 0), g('cobalt', 25, 0.5, 0.4, 1),
      g('jade', 10, 7, 0.2), g('cobalt', 12, 10.5, 0.2),
    ],
  },
  { // 9 (1.12) amber, spike
    name: 'Gold Rush',
    tip: 'Amber Shards are very fast. Keep some firepower close to the Core.',
    groups: [
      g('jade', 25, 0, 0.45), g('cobalt', 30, 1, 0.35),
      g('rust', 40, 2, 0.25), g('amber', 6, 5, 1.2),
    ],
  },
  { // 10 (1.13) milestone
    name: 'Pressure Front',
    groups: [
      g('jade', 30, 0, 0.35, 0), g('jade', 20, 2, 0.45, 1),
      g('amber', 10, 6, 0.5), g('cobalt', 20, 10.5, 0.15),
    ],
  },
  { // 11 (0.87) breather
    name: 'Calm Before',
    groups: [
      g('cobalt', 40, 0, 0.3), g('jade', 20, 2, 0.5),
      g('rust', 28, 4, 0.2), g('amber', 8, 8, 0.6),
    ],
  },
  { // 12 (1.00) rose
    name: 'Rose Dawn',
    tip: 'Rose Shards are the fastest meteors in the storm.',
    groups: [
      g('jade', 30, 0, 0.4), g('amber', 15, 2, 0.6),
      g('cobalt', 30, 4, 0.25), g('rose', 10, 9, 0.5),
    ],
  },
  { // 13 (1.05)
    name: 'Double Time',
    groups: [
      g('amber', 25, 0, 0.5, 0), g('jade', 35, 0.5, 0.33, 1),
      g('rose', 12, 6, 0.4), g('cobalt', 20, 11, 0.15),
    ],
  },
  { // 14 (0.94) phantom
    name: 'Ghost Signal',
    tip: 'Phantom meteors can only be targeted by towers with detection. Area damage still hits them.',
    groups: [
      g('jade', 45, 0, 0.28), g('rust', 24, 1, 0.2), g('amber', 20, 3, 0.5),
      g('rose', 10, 8, 0.5), g('cobalt', 8, 10, 0.7, -1, 'phantom'),
    ],
  },
  { // 15 (1.08)
    name: 'Needle Storm',
    groups: [
      g('rose', 20, 0, 0.5), g('amber', 30, 1, 0.35), g('jade', 30, 4, 0.3),
      g('jade', 6, 9, 0.6, -1, 'phantom'), g('cobalt', 30, 11, 0.15),
    ],
  },
  { // 16 (0.95) iron
    name: 'Iron Rain',
    tip: 'Iron Meteors shrug off KINETIC damage. Answer them with BLAST, THERMAL, CRYO or ENERGY.',
    groups: [
      g('rose', 25, 0, 0.45), g('amber', 25, 1, 0.4), g('jade', 30, 3, 0.3),
      g('iron', 4, 6, 2), g('cobalt', 10, 12, 0.3, -1, 'phantom'),
    ],
  },
  { // 17 (1.05)
    name: 'Heavy Metal',
    groups: [
      g('rose', 30, 0, 0.4), g('iron', 8, 3, 1.2), g('amber', 30, 5, 0.3),
      g('jade', 12, 9, 0.4, -1, 'phantom'), g('jade', 24, 13, 0.15),
    ],
  },
  { // 18 (0.98) magma, comet
    name: 'Fire and Ice',
    tip: 'Magma ignores BLAST. Comets ignore CRYO and cannot be frozen.',
    groups: [
      g('rose', 30, 0, 0.35), g('amber', 25, 2, 0.4),
      g('magma', 6, 4, 1, 0), g('comet', 6, 8, 1, 1),
      g('iron', 6, 11, 0.8), g('jade', 10, 14, 0.3, -1, 'phantom'),
    ],
  },
  { // 19 (1.14) spike
    name: 'Avalanche',
    groups: [
      g('rose', 50, 0, 0.28), g('iron', 10, 5, 0.6),
      g('magma', 5, 10, 0.5, 0), g('comet', 5, 10, 0.5, 1),
      g('rose', 8, 13, 0.3, -1, 'phantom'), g('amber', 25, 15, 0.12),
    ],
  },
  { // 20 (0.96) Storm Titan: Maw
    name: 'Maw of the Storm',
    tip: 'A Storm Titan joins this wave. If it reaches the Core, the run ends.',
    titanStart: 5,
    groups: [
      g('rose', 40, 0, 0.35), g('jade', 35, 2, 0.3), g('iron', 8, 6, 0.8),
      g('magma', 6, 10, 0.6, 0), g('comet', 6, 10, 0.6, 1),
      g('amber', 10, 14, 0.35, -1, 'phantom'),
    ],
  },
  { // 21 (0.86) breather
    name: 'Aftermath',
    groups: [
      g('rose', 60, 0, 0.3), g('iron', 6, 4, 1, 0), g('comet', 6, 8, 1, 1),
      g('rose', 10, 12, 0.4, -1, 'phantom'), g('amber', 18, 15, 0.2),
    ],
  },
  { // 22 (1.00) prism, nanite
    name: 'Prism Break',
    tip: 'Prism Meteors ignore THERMAL and ENERGY. Nanite meteors regrow if left alone for 3 seconds.',
    groups: [
      g('rose', 50, 0, 0.35), g('prism', 6, 3, 0.8),
      g('iron', 8, 6, 0.8, 0), g('magma', 8, 6, 0.8, 1),
      g('comet', 6, 11, 0.6), g('rose', 12, 13, 0.4, -1, 'nanite'),
      g('amber', 20, 15, 0.2, -1, 'phantom'),
    ],
  },
  { // 23 (1.06)
    name: 'Regrowth',
    groups: [
      g('rose', 60, 0, 0.3), g('prism', 10, 3, 0.6), g('amber', 20, 6, 0.3, -1, 'nanite'),
      g('iron', 10, 9, 0.5), g('magma', 5, 12, 0.4, 0), g('comet', 5, 12, 0.4, 1),
      g('rose', 20, 15, 0.2, -1, 'phantom'),
    ],
  },
  { // 24 (0.98) geode
    name: 'Geode Field',
    tip: 'Geodes ignore BLAST and CRYO, then split into a Magma Meteor and a Comet.',
    groups: [
      g('rose', 50, 0, 0.35), g('prism', 8, 2, 0.6), g('geode', 6, 5, 1.5),
      g('rose', 15, 8, 0.4, -1, 'nanite'), g('iron', 8, 10, 0.6, 0), g('comet', 10, 10, 0.5, 1),
      g('rose', 12, 16, 0.25, -1, 'phantom'),
    ],
  },
  { // 25 (1.10)
    name: 'Crystal Surge',
    groups: [
      g('rose', 80, 0, 0.22), g('geode', 10, 4, 1),
      g('magma', 10, 7, 0.4, 0), g('iron', 10, 7, 0.4, 1),
      g('prism', 8, 12, 0.3), g('rose', 10, 16, 0.3, -1, 'phantom nanite'),
    ],
  },
  { // 26 (0.89) breather
    name: 'Eye of the Storm',
    groups: [
      g('rose', 70, 0, 0.28), g('comet', 8, 3, 0.5, 0), g('prism', 6, 3, 0.6, 1),
      g('geode', 8, 5, 1.2), g('amber', 20, 8, 0.3, -1, 'nanite'),
      g('rose', 20, 15, 0.25, -1, 'phantom'),
    ],
  },
  { // 27 (1.08)
    name: 'Hard Rock',
    groups: [
      g('rose', 60, 0, 0.32), g('geode', 15, 3, 0.8), g('iron', 15, 6, 0.4),
      g('magma', 10, 10, 0.4), g('prism', 14, 13, 0.3),
      g('rose', 15, 17, 0.25, -1, 'phantom nanite'),
    ],
  },
  { // 28 (1.00) aurora
    name: 'Aurora',
    tip: 'Aurora Meteors split into two Geodes. Mix your damage types.',
    groups: [
      g('rose', 60, 0, 0.32), g('geode', 12, 3, 1), g('aurora', 5, 6, 2),
      g('prism', 10, 10, 0.4), g('rose', 25, 12, 0.3, -1, 'nanite'),
      g('rose', 20, 16, 0.25, -1, 'phantom'),
    ],
  },
  { // 29 (1.16) spike
    name: 'Lightshow',
    groups: [
      g('rose', 70, 0, 0.28), g('iron', 10, 2, 0.5), g('aurora', 10, 4, 1.2),
      g('geode', 15, 8, 0.6), g('prism', 8, 12, 0.5, -1, 'nanite'),
      g('rose', 15, 18, 0.2, -1, 'phantom'),
    ],
  },
  { // 30 (1.12) milestone
    name: 'Deep Impact',
    groups: [
      g('rose', 60, 0, 0.3), g('aurora', 14, 3, 1.2), g('geode', 12, 6, 0.8),
      g('iron', 15, 10, 0.4), g('rose', 20, 18, 0.2, -1, 'phantom nanite'),
    ],
  },
  { // 31 (0.86) breather
    name: 'Breathing Room',
    groups: [
      g('rose', 100, 0, 0.2), g('prism', 10, 3, 0.5, 0), g('comet', 10, 3, 0.5, 1),
      g('aurora', 8, 5, 1.5), g('rose', 30, 13, 0.3, -1, 'phantom'),
    ],
  },
  { // 32 (1.00) obsidian
    name: 'Black Heart',
    tip: 'Obsidian Hearts have a 10 HP shell. Bring heavy hitters.',
    groups: [
      g('rose', 50, 0, 0.35), g('aurora', 10, 2, 1.2), g('geode', 15, 5, 0.8),
      g('obsidian', 3, 10, 3), g('rose', 20, 15, 0.3, -1, 'phantom'),
      g('iron', 8, 18, 0.5, -1, 'nanite'),
    ],
  },
  { // 33 (1.04)
    name: 'Dark Matter',
    groups: [
      g('rose', 60, 0, 0.3), g('aurora', 12, 3, 1), g('obsidian', 5, 8, 2),
      g('geode', 12, 12, 0.6), g('rose', 20, 18, 0.25, -1, 'phantom nanite'),
    ],
  },
  { // 34 (1.07)
    name: 'Mixed Signals',
    groups: [
      g('iron', 12, 0, 0.5, 0), g('magma', 12, 0, 0.5, 1), g('aurora', 10, 2, 1.2),
      g('obsidian', 8, 4, 1.8), g('geode', 10, 8, 0.8),
      g('rose', 30, 14, 0.3, -1, 'phantom'),
    ],
  },
  { // 35 (0.96) plated
    name: 'Iron Curtain',
    tip: 'Plated enemies have double shell HP.',
    groups: [
      g('iron', 12, 0, 0.6, -1, 'plated'), g('rose', 50, 2, 0.35), g('aurora', 10, 4, 1.2),
      g('obsidian', 4, 8, 2.5, -1, 'plated'), g('obsidian', 4, 10, 2.5),
      g('rose', 30, 16, 0.25, -1, 'phantom nanite'),
    ],
  },
  { // 36 (1.06)
    name: 'Night Shift',
    groups: [
      g('aurora', 12, 0, 1.2), g('obsidian', 10, 4, 2), g('rose', 40, 6, 0.3, -1, 'nanite'),
      g('iron', 20, 12, 0.45, -1, 'plated'), g('aurora', 4, 16, 1.8, -1, 'phantom'),
    ],
  },
  { // 37 (0.90) breather
    name: 'Quiet Storm',
    groups: [
      g('rose', 120, 0, 0.18), g('aurora', 15, 3, 1.2),
      g('rose', 40, 8, 0.3, -1, 'phantom'), g('obsidian', 5, 12, 2.5),
    ],
  },
  { // 38 (1.11)
    name: 'Hammerfall',
    groups: [
      g('aurora', 16, 0, 1.2), g('obsidian', 8, 2, 2), g('geode', 15, 6, 0.8),
      g('prism', 15, 10, 0.4), g('rose', 30, 14, 0.3, -1, 'phantom nanite'),
      g('obsidian', 4, 18, 1.5, -1, 'plated'),
    ],
  },
  { // 39 (1.17) spike before the Hauler
    name: 'The Long Night',
    groups: [
      g('aurora', 15, 0, 1), g('obsidian', 10, 2, 1.6), g('rose', 60, 4, 0.3),
      g('prism', 10, 8, 0.5, -1, 'nanite'), g('obsidian', 6, 16, 1.2, -1, 'plated'),
      g('obsidian', 2, 20, 2, -1, 'phantom'),
    ],
  },
  { // 40 (1.00) the first Hauler, with a Storm Titan: Aegis
    name: 'The Hauler',
    tip: 'A Hauler approaches: a 200 HP hull carrying four Obsidian Hearts.',
    titanStart: 6,
    groups: [
      g('rose', 80, 0, 0.17), g('aurora', 12, 1, 1), g('geode', 12, 4, 0.6),
      g('obsidian', 8, 6, 1),
      // silence, then the Hauler arrives alone
      g('hauler', 1, 16, 0, 0),
      g('rose', 20, 17, 0.3, -1, 'phantom nanite'),
    ],
  },
];
