# SHARDSTORM: Waves

How the storm is scheduled. Numbers come from `docs/ECONOMY.md` section 4 and live in `src/data/economy.js`; the authored list is `src/data/waves.js`; the generator is `src/sim/wavegen.js`; `node tools/wavecheck.mjs` proves every claim below for waves 1 to 200.

## 1. The contract in one paragraph

`buildWave(w, { lanes })` returns a fresh spec: `{ wave, budget, mass, duration, hullMult, speedMult, groups, titan, name, tip, theme, authored }`. Each group spawns `count` enemies of one `type` at `start + i * spacing` seconds, on `lane` (0 or 1, or -1 to alternate spawn by spawn: the engine sends spawn `i` to lane `i % lanes`). `mass` is the total hit points of everything in the wave, children included, with the wave's hull multiplier applied; the Storm Titan is never counted. The same `w` always gives the same wave on every map and device. `lanes` only renumbers lanes (everything is lane 0 on one-lane maps), so records stay comparable. `previewWave(w)` aggregates the wave by type and modifiers, strongest first, for the HUD strip.

Extra fields for the UI: `name` (banner title such as "Ghost Signal" or "Phantom Rush"), `tip` (a one-line hint on waves that introduce something, otherwise null), `theme` (procedural theme id, null for authored waves), `authored` (bool).

## 2. Authored waves 1 to 40

Hand-built in `src/data/waves.js`. Each wave is within 20% of `budget(w)` and runs close to `D(w) = 10 + 0.4w` seconds. Waves 1 to 15 are then stretched in time by `earlyPace(w)` (1.6x at wave 1 easing to 1x at wave 16, ECONOMY 4.7), so the times written in `waves.js` are the unstretched ones; wavecheck prints a duration warning for waves 1 to 6 because of it.

**Rhythm.** Waves climb gently, take a breather now and then (about 0.86 to 0.90 of budget: waves 7, 11, 21, 26, 31, 37) and spike just before each milestone (about 1.12 to 1.17: waves 9, 19, 29, 39; wave 10 and 30 also run hot). Titan waves 20 and 40 sit near budget because the Titan is the event.

**Debuts, exactly on the ECONOMY 4.5 schedule.** Each new enemy arrives in a small, readable group with a tip that names the counter:

| Wave | New | Introduced as |
|---|---|---|
| 3 / 5 / 9 / 12 | cobalt, jade, amber, rose | a short group behind a familiar stream |
| 14 | phantom | 8 phantom Cobalt at the end of the wave (cheap to leak, easy to notice) |
| 16 | iron | 4 Iron Meteors, 2 s apart |
| 18 | magma, comet | 6 of each, one per lane |
| 20 | Storm Titan (Maw) | a normal wave, Titan enters at 5 s |
| 22 | prism, nanite | 6 Prism, 12 nanite Rose |
| 24 / 28 / 32 | geode, aurora, obsidian | 6, 5 and 3 of them, widely spaced |
| 35 | plated | plated Iron and plated Obsidian |
| 40 | Hauler + Titan (Aegis) | a heavy opening that ends by 13.4 s, a silence, then the Hauler alone at 16 s with a phantom nanite escort |

Streams use lane -1 so both lanes of a two-lane map always carry pressure; paired groups (Magma on one lane, Comet on the other) use explicit lanes.

## 3. Procedural waves 41+

Deterministic: a local seeded PRNG (mulberry32) seeded from `w` alone. Never `Math.random`.

### 3.1 Themes
Themes rotate in shuffled blocks of seven: each theme once per block, never the same theme twice in a row. The first time a theme appears (waves 41 to 47) its spec carries a tip.

| Theme | Signature | Ships |
|---|---|---|
| Shard Swarm | 180 fast Rose in a long stream plus bursts, Prism or Comet bursts, a heavy stream | capital |
| Dense Front | Aurora and Obsidian in tight packs of four, a Geode stream | escort + capital |
| Mixed Ore | Iron, Magma, Comet and Prism bursts in shuffled order, Geodes | Specters + capital |
| Phantom Rush | every meteor Phantom | Specters + capital |
| Nanite Siege | every meteor Nanite, one long Rose stream for the whole wave | escort + capital |
| Ship Convoy | light hulls (Hauler, Warbarge) all wave long, a thin meteor screen | light + capital |
| Armored Column | plated Iron column, plated heavy packs, plated Magma | plated escort + capital |

Outside forced ones, modifiers are rolled per group with chances that ramp with `w`: Phantom 10% at wave 41 rising to 50% by wave 140, Nanite 8% to 50% by 145, Plated 8% to 60% by 144 (Plated is rolled only on Iron, Obsidian and ships, where it matters). Ships never carry Phantom or Nanite (the Specter is phantom by nature).

New ship classes debut as one featured hull on their unlock wave: **Heavy Company** (50: a Warbarge and a Specter), **Dreadnought Rising** (70), **Worldbreaker** (90). The rest of the wave fits around it.

### 3.2 How a wave is filled
Each theme is a list of components. A component has a share of the budget, a **ladder** of types from weak to strong (for example Hauler, Warbarge, Dreadnought, Worldbreaker), a count ceiling and a spawn pattern. The ceilings of every theme add up to exactly 300, the spawn cap.

1. **Targets.** Shares get a ±20% jitter and are normalized. Ship shares start at 35% of nominal on wave 41 and ramp to full by wave 71, so the step after the wave 40 Hauler is gentle.
2. **Rungs.** Each component takes the weakest unlocked rung whose count stays under 80% of its ceiling (sometimes one rung up: "fewer, bigger"). Mass that a component cannot hold at its top rung and ceiling spills to components that still have room.
3. **Counts.** Components are realized largest unit first. Ships make change down their ladder (4 Dreadnoughts and 3 Warbarges rather than a rounded 5 Dreadnoughts) and each remainder carries to the next, finer component, so total mass lands within about 1% of budget (5% is the hard limit).
4. **Hull multiplier.** Only when every component is at its ceiling on its strongest rung, which means the wave has hit the 300-spawn cap, does the leftover go into `H`, applied to every ship hull in the wave (children included). Mass is linear in `H`, so it is solved exactly: `H = (B - meteorMass) / hullMass`. Every theme saturates at about 1.64M hull HP, so `H` follows the budget trend instead of jumping with the theme.

Results: `H` stays 1 until wave 128, is about 35 at wave 150 and about 3 x 10^5 at wave 200. The storm always wins.

### 3.3 Timing and lanes
Spawn duration is exactly `D(w)`, capped at 45 s. Patterns: **stream** (even spacing across a window), **burst** (clusters of about 12, 0.08 to 0.12 s apart), **pulse** (packs of about 4, 0.3 to 0.45 s apart), **convoy** (evenly spaced hulls). Windows are fractions of `D(w)` with a small jitter; afterwards the whole wave is stretched so its last spawn lands exactly on `D(w)`. Enemy speed is multiplied by `speedRamp(w)`.

On two-lane maps, ship groups balance their mass between the lanes (heaviest first; an odd hull stream is split so the extra hull goes to the lighter lane), meteor streams alternate spawn by spawn, and bursts and pulses alternate lanes in time order. A single hull that outweighs the rest of the wave (the debut Dreadnought and Worldbreaker) takes one lane, and the other lane gets the rest.

### 3.4 Storm Titans
Every 20th wave: kind rotates Maw, Aegis, Rift (tier 1, 2, 3, then Maw again at 80), `tier = w / 20`, `hp = titanHp(tier)` (ECONOMY 4.6; H is already inside the budget the Titan tracks), entering at `clamp(0.2 x D, 3, 8)` seconds (authored: 5 s on wave 20, 6 s on wave 40). The Titan is on top of the budget.

## 4. Checks (`node tools/wavecheck.mjs`)
Prints a table for waves 1 to 200 (budget, mass, ratio, spawns, groups, H, duration, D(w), speed, titan, lane split, mass by type) and fails on any of:
- authored mass outside ±20% of budget, procedural outside ±5%
- more than 300 spawns, `H < 1`, or `H > 1` while the spawn cap does not bind
- budget not strictly increasing, any NaN or Infinity (also sampled out to wave 600)
- output that differs between two module instances built in opposite orders, or after the cache is cleared, or between `lanes: 1` and `lanes: 2` (other than lane numbers)
- any enemy or modifier before its unlock wave, or a debut that is not exactly on schedule
- a missing, extra or wrong Titan
- bad groups (unknown type, non-integer count, spacing under 3 ticks, spawn after `duration`); procedural duration other than `D(w)`
- a two-lane split that leaves a lane idle
- a long dash in any wave name or tip, or a reference to `window`, `document`, `Math.random`, `Date` or `performance` in the wave modules
- `buildWave(200)` slower than 2 ms (it takes about 0.05 ms)

`--wave N` dumps one spec, `--preview N` its preview, `--quiet` prints only the verdict.

## 5. Tuning knobs
- Authored waves: edit counts in `src/data/waves.js` and rerun the check. The comment on each wave states its planned ratio.
- Theme feel: `THEMES` in `src/sim/wavegen.js` (shares, ladders, ceilings, patterns, windows). Keep each theme's ceilings summing to 300 and its saturated hull capacity near 1.64M, or `H` starts to swing between themes.
- Modifier ramps: `modChance`. Ship ramp: `shipRamp`. Debuts: `DEBUTS`.
- Threat curve, durations, speed ramp, Titan HP: `src/data/economy.js` (owned by the economy pass).
