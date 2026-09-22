// Commander (hero) definitions. Pure data.
// A later agent fills this in. Each entry is a TowerDef (see src/data/towers/pulse.js) plus:
//   hero: { maxLevel: 20, levels: [fn x 19] }
// where levels[i](stats, ctx) is applied when the Commander reaches level i + 2
// (so levels[0] runs at level 2, levels[18] at level 20). Level 1 is the base stats.
// Commanders have `paths: []`, are limited to one per game, and gain XP automatically
// (docs/ECONOMY.md section 6). Abilities are added to stats.abilities by level functions.
//
// Example:
//   export const HEROES = { vega: { id: 'vega', name: 'Captain Vega', cost: 550, radius: 20, base: {...},
//     paths: [], hero: { maxLevel: 20, levels: [ (s) => { s.range += 5; }, ... ] } } };

export const HEROES = {};
export const HERO_ORDER = [];
