# SHARDSTORM: Architecture and Module Contracts

Static site. Vanilla JavaScript ES modules loaded directly by the browser (no bundler, no framework, no npm runtime deps). Canvas 2D rendering plus an HTML/CSS overlay for UI. Must run from any subpath (GitHub Pages `https://<user>.github.io/shardstorm/`), so **every URL is relative** (`./src/main.js`, `assets/...`), never root-absolute.

The simulation is **pure and deterministic**: `src/sim/**` and `src/data/**` never touch `window`, `document`, `Math.random`, `Date`, `performance` or any DOM API, so Node can import them directly (`tools/headless.mjs`, `tools/bench.mjs`, `tools/balance.mjs`). Randomness comes only from the sim's seeded RNG. Visual-only randomness (particles) lives in `src/render/**` and may use Math.random.

## 1. File layout and ownership

```
index.html                 page shell, loads css/style.css and src/main.js (type=module)
css/style.css              all UI styles (CSS custom properties for theme)
assets/manifest.json       sprite registry (may be empty; everything must work without images)
assets/img/**              images
src/
  main.js                  boot, asset preload, screen routing, main loop, window.__ss debug hooks
  core/rng.js              seeded PRNG (sfc32), serializable state
  core/math.js             vector + geometry helpers
  sim/                     PURE
    game.js                class Sim (state, step, commands). The only entry point clients use.
    path.js                class Path: smoothing, arc-length sampling, pointAt(d), distance queries
    spatial.js             uniform grid spatial hash for enemies
    enemies.js             spawn, move, damage, pop into children, statuses, nanite, titans
    towers.js              tower instances, stat computation, targeting, upgrade rules, buffs
    projectiles.js         projectile motion, collision, pierce, splash, split
    attacks.js             attack kind implementations (projectile, hitscan, chain, beam, pulse, field, mortar, drone, custom)
    abilities.js           activated abilities (cooldowns, global ability bar model)
    economy.js             cash, bounty, bonuses, costs, sell values, rig income, vaults
    wavegen.js             wave specs: authored waves 1..40 + procedural generator 41+
    save.js                serialize / deserialize (build phase only)
  data/                    PURE
    economy.js             constants and formulas (docs/ECONOMY.md)
    enemies.js             enemy defs + derived mass/shells
    maps.js                map defs
    waves.js               authored wave list for waves 1..40
    heroes.js              commander defs
    towers/index.js        tower registry: export const TOWERS = { pulse, scatter, ... } and TOWER_ORDER
    towers/<id>.js         one file per tower: default export TowerDef
  render/
    renderer.js            draws a Sim state onto a canvas
    camera.js              world <-> screen transform, DPR, resize
    sprites.js             manifest loading, sprite lookup, procedural fallbacks
    procedural.js          vector art for towers, meteors, ships, core, portal, projectiles
    particles.js           visual particle system fed by sim events
    channel.js             pre-renders the map channel (path) + terrain to an offscreen canvas
  ui/
    ui.js                  in-game HUD, shop, upgrade panel, ability bar, wave preview
    screens.js             title, map select, difficulty + commander select, pause, settings, game over, codex, records
    input.js               mouse, touch, keyboard, placement ghost, hotkeys
    format.js              number formatting, credit glyph
  audio/audio.js           WebAudio synth SFX + generative music, driven by sim events
  persist/storage.js       localStorage wrappers (all in try/catch), settings, records, run save
tools/                     Node scripts (headless, bench, balance, snap, serve)
docs/                      DESIGN, ECONOMY, ARCHITECTURE, BALANCE
```

## 2. Units and time

- World: 1500 x 1000 units. Origin top-left, +y down. Angles in radians, 0 = +x (right), clockwise positive (canvas convention).
- Simulation tick: `TICK = 1/60` s. `sim.step()` advances exactly one tick. Game speed (1x/2x/3x) = number of steps per rendered 1/60 s; the client accumulates real time and runs `steps = floor(acc / TICK)` capped at 12 per frame.
- Enemy speed in units/s = `def.speed x BASE_SPEED (90) x waveSpeedMult x statusSlow`.
- Tower `cooldown` values are seconds between attacks. Durations are seconds.

## 3. Sim state (read by render and UI; never mutated by them)

```js
sim.state = {
  tick, time,                    // ticks and seconds since start
  mapId, difficulty, heroId,
  phase: 'build' | 'wave' | 'over',
  wave,                          // highest wave launched so far (0 before first launch)
  cleared,                       // highest wave fully cleared (score)
  cash, lives, maxLives,
  autoStart: false,
  enemies: Enemy[], towers: Tower[], projectiles: Projectile[], drones: Drone[],
  titan: null | { id, name, kind, hp, maxHp, shield, maxShield },
  activeWaves: [{ wave, t, spawnsLeft, spawnDone }],
  rigCount, t5Owned: { 'pulse:0': towerId, ... },
  stats: { pops, leaks, massLeaked, cashEarned, damage },
}
sim.map        // map def plus sim.paths: Path[]
```

### Enemy
```js
{ id, type, def, lane, d, x, y, angle, radius,
  hp, maxHp,                     // current shell HP (ships: hull HP after H)
  wave, hullMult, speedMult,
  phantom, nanite, plated, origType,
  regrowT,                       // seconds since last damage (nanite)
  slowMult, slowT, frozenT, stunT, burn: [{ dps, t, src }], brittle: { add, mult, t }, exposedT,
  immuneProj,                    // id of the projectile that killed the parent (children ignore it)
  titan: null | { kind, shield, maxShield, ... },
  dead }
```

### Tower
```js
{ id, type, def, x, y, angle, radius,
  levels: [a, b, c],             // path tiers 0..5
  targeting: 'first' | 'last' | 'strong' | 'close' | ...,
  aim: { x, y } | null,          // mortar ground target
  stats,                         // computed (section 5), includes buffs
  paid,                          // credits actually paid (for sell)
  undoable,                      // bought this build phase, full refund
  pops, damage, cashEarned,
  cd: { [attackKey]: secondsUntilReady },
  abilityCd: { [abilityId]: secondsUntilReady },
  target: enemyId | null,
  disabledT,                     // stunned by a Titan pulse
  data: {} }                     // behavior scratch (beam targets, vault balance, ramp, etc.)
```

### Projectile
```js
{ id, x, y, vx, vy, speed, radius, life, dtype, damage, pierce, hit: enemyId[] (array, cleared on reuse),
  homing, targetId, visual, color, towerId, attackKey, splash, onHit, split, ... }
```

### Drone
```js
{ id, towerId, x, y, angle, targetId, cd, visual, kind }
```

## 4. Events

`sim.events` is an array; consumers call `sim.drainEvents()` once per frame (returns the array and clears it). If nobody drains, the array is capped at 4000 (oldest dropped). Every event has `t` (type):

| t | fields | used by |
|---|---|---|
| `shot` | tower, x, y, angle, visual, dtype | audio, muzzle flash |
| `pop` | x, y, type, color, ship, count | particles, audio |
| `hit` | x, y, dtype | small spark |
| `blocked` | x, y, dtype | "clink" spark (immune) |
| `explode` | x, y, r, dtype | explosion particles, audio, shake |
| `zap` | points: [[x,y],...] | lightning polyline, audio |
| `freeze` | x, y, r | frost ring |
| `leak` | type, mass, x, y | red flash, alarm |
| `cash` | amount, x, y, reason | floating text |
| `waveStart` | wave | banner, audio |
| `waveCleared` | wave, bonus | banner, audio, autosave |
| `titan` | name, kind, wave | banner, horn |
| `titanDown` | name, x, y | big shatter |
| `place` / `upgrade` / `sell` | tower (id), type, path, tier, value | audio, UI refresh |
| `ability` | id, tower, x, y | effect, audio |
| `gameOver` | wave | game over screen |

Beams (lasers) and fields are continuous: the renderer reads `tower.data.beams = [{x1,y1,x2,y2,width,color}]` and `tower.stats` instead of events.

## 5. Towers: data format

`src/data/towers/<id>.js`:
```js
export default {
  id: 'pulse', name: 'Pulse Turret', hotkey: 'q', cost: 200, radius: 22,
  blurb: 'Cheap, fast single-target bolts.',
  art: { sprite: 'tower_pulse', rotates: true, color: '#4cc9f0', accent: '#f9c74f', shape: 'hex', barrels: 1,
         variant(levels) { /* 0 base, 1 path A T3+, 2 path B T3+, 3 path C T3+ */ } },
  base: {                                   // plain data (functions allowed only in `update`/`activate`)
    range: 150,
    detection: false,
    targetModes: ['first', 'last', 'strong', 'close'],
    attacks: {
      main: { kind: 'projectile', cooldown: 0.95, damage: 1, pierce: 2, dtype: 'KINETIC',
              speed: 1100, projRadius: 6, lifetime: 0.5, visual: 'bolt', color: '#9ef' },
    },
    aura: null, income: null, abilities: [],
  },
  paths: [
    { name: 'Penetrator', upgrades: [
      { name: 'Sharp Bolts', cost: 140, desc: 'Bolts pierce 1 more target.', apply(s) { s.attacks.main.pierce += 1; } },
      // ... 5 upgrades per path
    ] },
    { name: 'Cyclone', upgrades: [ ... ] },
    { name: 'Marksman', upgrades: [ ... ] },
  ],
};
```

### 5.1 Stat computation
`computeStats(def, levels, buffs)`:
1. `s = cloneStats(def.base)` (deep clone that copies functions by reference).
2. For tier 1..5, for path 0..2: if `levels[path] >= tier`, call `upgrade.apply(s, ctx)` where `ctx = { levels, tier, path }`. (Tier-major order so crosspaths compose the same way every time.)
3. Apply buffs (section 5.4).
4. Stats are recomputed only when levels or buffs change, never per tick.

### 5.2 Upgrade rules
- Crosspath: at most one path above tier 2; at most two paths above tier 0.
- Only one tower per game may own each tier 5 (`state.t5Owned['pulse:1']`). Selling frees it.
- Price = `priceFor(upgrade.cost, difficulty)` minus Beacon discount if applicable.
- `upgradeInfo` states: `available`, `unaffordable`, `locked` (crosspath or T5 taken; reason string), `maxed`.

### 5.3 Attack kinds (engine-implemented in `src/sim/attacks.js`)

Common fields on every attack: `kind, cooldown, dtype, damage, pierce, range (optional override), bypass (array of damage types whose immunity this attack ignores, plus 'FROZEN' to hit frozen targets with KINETIC), shipDamage (extra damage vs ships), bonus: { [enemyType]: extraDamage }, crit: { chance, mult }, onHit (effects, 5.5), targetModes override, detection override, needsTarget (default true), visual, color`.

| kind | Extra fields | Behavior |
|---|---|---|
| `projectile` | speed, projRadius, lifetime, count, spread (radians total), radial (bool: fire `count` evenly around 360), homing (turn rad/s), splash {radius, damage, pierce, dtype, onHit}, split {count, spread, attack}, splitOn ('hit' or 'expire' or 'both'), bounce | Fires at the target (or radially). Each enemy hit consumes 1 pierce. Splash triggers on each hit (or on expire if `splashOnExpire`). |
| `hitscan` | shrapnel {count, damage, pierce, spread, range}, splash | Instant hit on the target. Range may be `Infinity`. |
| `chain` | jumps, jumpRange, falloff (multiplier per jump) | Hits target then jumps to the nearest not-yet-hit enemy within jumpRange. Emits `zap`. |
| `beam` | beams (targets), dps, tickRate, ramp (per second while locked), rampMax, width | Continuous damage in ticks; ramp resets on target change. Writes `tower.data.beams`. |
| `pulse` | radius | Every cooldown, if any enemy in radius: apply damage + onHit to up to `pierce` enemies in radius. |
| `field` | radius, slow {mult, shipMult}, dps, pull (units/s back along path), expose | Continuous effect on everything in radius each tick. |
| `mortar` | inaccuracy, flightTime, splash | Fires at `tower.aim` (default: path point nearest the tower). No line of sight or range limit. |
| `drone` | count, droneSpeed, patrol (radius, defaults to range), weapon (an attack object) | Keeps `count` drones alive; each drone flies to targets within patrol radius and uses `weapon`. |
| `custom` | update(sim, tower, atk, dt) | Escape hatch using the Sim API (section 6). |

### 5.4 Buffs (Command Beacon and Commanders)
`stats.aura = { radius, rateMult, rangeMult, pierceAdd, damageAdd, detection, bypass: [], discount, shipDamageAdd }`. Every tower whose center is inside the radius gets the best value of each field among covering auras (no stacking of the same field across beacons). Buffed attack cooldown = cooldown / rateMult. Rigs and Beacons never receive discounts.

### 5.5 On-hit effects
`onHit: { slow: { mult, t, shipMult }, freeze: { t }, burn: { dps, t }, stun: { t, shipT }, brittle: { add, mult, t }, knockback: { dist, shipDist }, expose: { t }, strip: true }`
- `slow`: strongest slow wins (lowest mult); ships use `shipMult` (default: no slow). Comets ignore CRYO slows.
- `freeze`: meteors stop; frozen targets cannot be damaged by KINETIC unless the attack bypasses `FROZEN`. Ships cannot be frozen (convert to a 0.6 slow). Comets cannot be frozen.
- `burn`: THERMAL damage over time, ticks every 0.5 s. Prism ignores it.
- `stun`: stops movement; ships use `shipT` (default 0, halved on Titans). A ship stun never extends one already running, and a ship cannot be stunned again for `SHIP_STUN_IMMUNE` (1 s) after a stun ends.
- `brittle`: damage taken `(dmg + add) x mult` for `t` seconds.
- `knockback`: move back along path by `dist` (ships use `shipDist`, default 0).
- `expose` / `strip`: removes Phantom (permanently for strip, timed for expose) so all towers can target it.

### 5.6 Income
`stats.income = { perWave, vault: { rate, cap } | null, refinery: { k, radius } | null, supply: { drops, value } | null }`. Paid at wave clear, times `incomeFactor(w)`. Vault: stores income in `tower.data.vault`, grows by `rate` up to `cap`, UI button `sim.withdraw(towerId)`.

### 5.7 Abilities
`stats.abilities = [{ id, name, icon, cooldown, duration, activate(sim, tower) }]`. The engine keeps cooldowns in `tower.abilityCd`. A newly unlocked ability starts at 1/3 of its cooldown. `sim.abilityBar()` groups by id: `[{ id, name, icon, ready, towerIds, cdFrac }]`; `sim.useAbility(id)` fires the ready instance with the most time since last use. Durations are handled by the ability (it can set temporary flags on towers with an expiry in `tower.data`).

## 6. Sim API

### Construction
```js
import { Sim } from './src/sim/game.js';
const sim = new Sim({ mapId: 'crater', difficulty: 'pilot', seed: 12345, heroId: null });
Sim.fromSave(saveObject) -> Sim
```

### Commands (UI and bots). All return `{ ok: true, ... }` or `{ ok: false, reason }`.
```js
sim.canPlace(type, x, y)
sim.placeTower(type, x, y)            // -> { ok, id }
sim.upgrade(towerId, path)            // path 0..2
sim.upgradeInfo(towerId, path)        // -> { tier, name, desc, cost, state, reason }
sim.sell(towerId)                     // -> { ok, value }
sim.sellValue(towerId)
sim.setTargeting(towerId, mode)
sim.setAim(towerId, x, y)
sim.withdraw(towerId)                 // vault
sim.startWave()                       // build phase, or early send when current wave has finished spawning
sim.canStartWave()
sim.setAutoStart(bool)
sim.useAbility(abilityId)
sim.abilityBar()
sim.towerInfo(towerId)                // UI summary: name, levels, pops, damage, cashEarned, sellValue, targeting, modes, range, detection
sim.priceOf(type)                     // difficulty-adjusted base price (no discount)
sim.priceAt(type, x, y)               // with Beacon discount at that spot
sim.wavePreview(w)                    // [{ type, count, mods }]
sim.serialize()                       // only valid in build phase
sim.step()
sim.drainEvents()
```

### Engine helpers (for `custom` attacks and abilities)
```js
sim.rng()                                     // [0,1)
sim.enemiesInRange(x, y, r, { phantom })      // array (phantom: include phantoms)
sim.findTarget(tower, range, mode, atk)       // respects detection and immunity-aware skipping
sim.damage(enemy, amount, dtype, src, opts)   // src = { tower, attackKey, projId, bypass, shipDamage, bonus, crit }; returns { dealt, pops }
sim.applyEffects(enemy, onHit, src)
sim.spawnProjectile(p)
sim.spawnEnemy(type, { lane, d, wave, mods, hullMult })
sim.pathPoint(lane, d)                        // { x, y, angle }
sim.nearestPathPoint(x, y)                    // { lane, d, x, y, dist }
sim.addCash(amount, x, y, reason)
sim.emit(event)
```

### Damage and popping rules
- Immunity: `def.immune` includes dtype and dtype not in `src.bypass` -> no damage, emit `blocked`, the hit still consumes pierce.
- Frozen + KINETIC without `FROZEN` bypass -> blocked.
- Damage applied: `(amount + bonus[type] + (ship ? shipDamage : 0) + brittle.add) x brittle.mult x (crit ? mult : 1)`.
- When shell HP reaches 0: pay bounty `incomeFactor(enemy.wave)`, `pops += 1`, spawn children at the same `d` (spread +-6 units), children inherit phantom, nanite, origType, wave, hullMult, speedMult and `immuneProj`; plated is not inherited; `def.childMods` are forced on. **Overflow** (damage beyond the shell's remaining HP) is applied to each child, except for ships (no overflow into ship children). Overflow recursion is capped at the family depth.
- Leak: `lives -= remainingMass` where remainingMass = current hp + children mass (with hullMult). Titan leak sets lives to 0.

## 7. Waves contract (`src/sim/wavegen.js`)
```js
export function buildWave(w, { lanes = 1 } = {}) -> WaveSpec
WaveSpec = {
  wave, budget, mass, duration, hullMult, speedMult,
  groups: [{ type, count, start, spacing, lane /* 0..lanes-1, or -1 = alternate */, mods: { phantom, nanite, plated, scout? } }],
  titan: null | { kind: 'maw' | 'aegis' | 'rift', tier, hp, start },
}
export function waveMass(spec) -> number
export function previewWave(w, opts) -> [{ type, count, mods }]
```
Deterministic: the same `w` always yields the same spec (seed derived from `w` only), so records are comparable.

## 8. Rendering contract
- `new Renderer(canvas, assets)`; `renderer.setMap(sim)` (pre-renders terrain + channel); `renderer.render(sim, frameDt, uiState)`; `renderer.onEvents(events)`.
- `uiState = { hoverTowerId, selectedTowerId, placing: { type, x, y, valid } | null, showAllRanges }`.
- Canvas fills its container; world is fit with `contain` scaling and centered; background art covers the whole canvas (so there are no bars).
- `renderer.screenToWorld(px, py)` and `worldToScreen(x, y)` for input.
- Draw order: background, channel, blockers, core, portal, range rings, towers (with tier pips), ground effects (fields, frost), meteors, ships, titans, projectiles, beams, zaps, particles, floating text, placement ghost.
- Sprites come from `assets/manifest.json`:
  ```json
  { "sprites": { "tower_pulse_0": { "src": "img/towers/pulse_0.png", "size": 64, "rotates": true, "facing": "up" } } }
  ```
  `size` is the drawn diameter in world units. Missing sprite keys fall back to `procedural.js` vector art. **The game must look finished with an empty manifest.**
- Sprite keys: `tower_<id>_<0..3>`, `enemy_<type>`, `ship_<type>`, `titan_<kind>`, `hero_<id>`, `map_<id>` (background), `core`, `portal`, `keyart`, `logo`, `ui_<name>`.

## 9. Client loop (`src/main.js`)
```
load settings -> preload manifest images (with timeout) -> title screen
start game: sim = new Sim(...) or Sim.fromSave(...); renderer.setMap(sim); ui.bind(sim)
frame: acc += min(dt, 0.1) * speed; while (acc >= TICK && n < 12) { sim.step(); n++ }
       ev = sim.drainEvents(); renderer.onEvents(ev); audio.onEvents(ev); ui.onEvents(ev)
       renderer.render(sim, dt, ui.state); ui.update(sim)
on waveCleared: storage.saveRun(sim.serialize()); records update
```
Debug hooks: `window.__ss = { get sim(), game, debug: { quickStart(mapId, difficulty, heroId), giveCash(n), place(type, x, y), upgrade(id, path, times), startWave(), skipTo(w), step(n), stats() } }`. `?debug=1` shows an FPS / entity overlay.

## 10. Performance budget
- 60 fps at 3x speed with 1,500 enemies, 800 projectiles, 60 towers on a mid laptop.
- Spatial hash (cell 64) rebuilt once per tick for enemies. No per-tick allocations in hot loops where avoidable (reuse arrays, pool projectiles).
- Enemy position: `Path` precomputes samples every 2 units (x, y, angle) so `pointAt(d)` is O(1).
- Renderer pre-renders static layers; sprites are drawn with `drawImage` from pre-scaled offscreen canvases (cache per sprite key per zoom bucket).

## 11. Style rules
- No em dashes in any user-facing string.
- No external network requests at runtime except same-origin assets (Google Fonts optional with a system-font fallback).
- All localStorage access wrapped in try/catch.

## 12. Implementation notes (as built)

### Tools
- `tools/headless.mjs`: bots measure every tower configuration they consider in a small arena (the tools/bench.mjs arena, seven categories: SWARM, DENSE, SHIP, IRON, SPECIAL, PHANTOM, SPECTER), cache the profiles in `out/botprofiles.json` keyed by a hash of the data and engine sources, and buy against a per-lane, per-category demand built from the next waves. Flags: `--hero <id>`, `--abilities off`, `--help`.
- `tools/bench.mjs` counts only enemies still in reach toward a scenario's population, measures mortar towers under their aim point, places utility towers across the channel from the reference Pulse (plain and Phantom streams) and spawns Beacon runs into the unbuffed window. It exports its arena helpers (`runAdaptiveMulti`, `newArenaSim`, `placeConfigured`, ...).
- `tools/snap.mjs` steps: `{"waitFor": "expr"}` polls until an expression is truthy; an `eval` that contains `await` runs inside an async function.

Additions and deviations the modules settled on while being built. They extend the contract above; nothing above was removed.

### Sim
- `canPlace` returns `{ ok, reason, price, affordable, spotOk }`. `spotOk` says the spot itself is legal regardless of credits. Reason strings: "On the channel", "Too close to another tower", "Too close to the Core", "Blocked by terrain", "Out of bounds", "Not enough credits".
- Extra helpers: `placeHero(x, y)`, `skipTo(w)` (debug, build phase only), `getTower(id)`, `getEnemy(id)`, `pathLength(lane)`, `pathCoverage(...)`, `discountAt(type, x, y)`, `waveInfo(w)` (`{ wave, name, tip, theme, titan }` for the HUD), `fireAttack`, `explode(x, y, splash, src)`, `after(seconds, fn)`, `addTempBuff(tower, buff, duration)`, `towersNear(x, y, r, types)`, `stunTower`, `hash()`.
- Abilities fire only during a wave (a build-phase activation would create state a save cannot hold). `abilityBar()` entries carry `usable` (ready and a wave is running) next to `ready`.
- `projectile.hit` is an array, not a Set.
- `serialize()` during a wave returns the snapshot taken when that wave launched, so a save is always a build-phase state.
- Pulse-kind attacks hit up to 40 enemies when the tower file sets no `pierce`.
- Tower data extras: aura `types` / `excludeTypes`; attack `onTick`, `shipPull`, `noLead` (no lead aiming), `scale` (visual size), hitscan `line` / `lineLength`, projectile `bounceRange`.

### Engine additions in the content phase
- Storm Titans resist slows: a slow (or a freeze turned into a ship slow) is half as strong on a Titan (`TITAN_SLOW_RESIST = 0.5` in `src/sim/enemies.js`; a 0.4 slow becomes 0.7), matching stuns, which already last half as long. An effect can give Titans an exact value with `slow.titanMult` / `freeze.titanMult` (Absolute Zero and Gravity Hauler do).
- Balance pass: `mods.scout` on a ship group spawns it with `SCOUT_HULL` (0.2) of its hull and an empty hold (`familyMass(type, H, plated, scout)`, `e.scout`, no children, leak = remaining hull); the wave 50 Specter debut uses it. A penetrating `line` hitscan stops at the first ship it damages. Two-lane maps may set `map.pace = { mult, until, fade }`; `Sim.paceAt(w)` stretches that wave's spawn times (never its content).
- CRYO-immune meteors (Comet, Geode) are never slowed or frozen by CRYO effects, including on-hit effects passed down from a parent (`applyEffects` guard).
- `findTarget(..., exclude)` accepts an array of ids or a number stamp (skip enemies whose `e._xs` equals it). Chain attacks stamp every enemy they hit, so exclusion is O(1) per check for long chains.
- `sim.spawnProjectile(p)` sets the normalized attack's `key` from `p.attackKey` (or `p.key`), so custom projectiles report their `attackKey`.
- Beacon and Commander `shipDamageAdd` buffs also raise `splash.shipDamage`.
- A drone list restyles its drones (`visual`, `kind`, `color`) whenever the attack's look changes (upgrades), not only at creation; a tower's own custom attack may still restyle them afterwards.
- The `vault` event's `amount` is what stayed in the vault (0 once it is full); the overflow is paid as a `cash` event.
- Commander XP: `heroXpNeed(L) = HERO_XP_K x L^1.6` with `HERO_XP_K = 35` (was 150; see docs/ECONOMY.md 6).
- Ability ids are unique across all towers and Commanders because `abilityBar()` groups by id (Brick's ability is `rocketbarrage`, the mortar's is `barrage`).
- Conventions tower files rely on: per-wave scratch lives in `tower.data` keys starting with `_field_` or `_beam_` (deleted when the build phase starts, so saves never hold it); the engine keeps a drone attack's drones in `tower.data['_drones_' + key]`; custom code may put dynamic fields on enemies (Gravity Well `gRew`, Drone Bay `_towed`, chain stamp `_xs`), which never outlive a wave. The built-in field `pull` is unbounded; custom pulls use a per-enemy budget so waves always end.

### Engine behaviours tower authors should know
- A beam's `shipDamage` is added on every damage tick (every `tickRate`, 0.1 s by default), so `shipDamage: 1` is +10 per second against ships.
- `strong` targeting picks the highest remaining mass (Titans, then ships first), so it keeps switching to fresh big meteors; low per-hit damage may never finish one.
- A `line` hitscan hits the first `pierce` enemies counted from the tower, so a crowded line can use up the pierce before the intended target.

### Events beyond section 4
`crit`, `regrow`, `pulse` (area pulse ring), `titanSpit`, `titanBlink`, `shieldBreak`, `shieldUp`, `heroLevel`, `abilityFx`, `vault`. `shot` also carries `x2, y2` (hitscan tracer end) and `drone`. `waveStart` carries `titan` (kind or null), `name`, `tip` and `theme`; `titan` carries `kind`.

### Renderer
- Extra state it reads: `enemy.off` (lateral offset from the channel centre), `enemy.bornT`, `enemy.titan`; mortar shells `mortar, prog (0..1), x0, y0, tx, ty, arc`; beam entries `ramp, dtype, targetId`; drones `idx, key, color`.
- API beyond section 8: `setSettings({ particles: 'low' | 'medium' | 'high', shake, floatText, reducedMotion })`, `setDefs({ towers, heroes })`, `setInsets({ top, right, bottom, left })` (the HUD and drawer are grid rows beside the canvas, not overlays; main.js sets insets from the ability bar so the world shifts into free letterbox space instead of sitting under the buttons, never shrinking), `setAssets`, `stats` (`{ enemies, projectiles, particles, drawMs, governor }`).
- View control: `zoomAt(factor, px, py)`, `setZoom(z, px, py)`, `panBy(dx, dy)`, `resetView()`, getters `zoom` and `maxZoom` (4x). Zoom and pan are clamped to the world; pinch, one-finger pan, wheel, drag, middle/Alt drag and `+`/`-`/`0` keys drive them. `renderMapPreview(canvas, map, cssW, cssH, assets)` (module export) draws a map card preview. `buildStaticLayer` (render/channel.js) takes `{ frame: { x0, y0, x1, y1, k, dpr } }`.
- Projectile visuals added in the content phase: `blade` (a spinning crescent, Scatter Pod Blade Ring) and `plasmaorb` (a tinted additive orb, Plasma Tempest; the plain `orb` core washes out white). `resolveVisual` maps names by keyword (`blade|crescent|sickle` and `plasma orb|tempest` first).
- `pulse` events are drawn by their `visual` hint: `fire` (burning ground glow and embers, one glow per spot), `implode` (contracting ring), `surge` (inward teal wave), `blackhole`, `radar` (thin cyan ping), `refinery` (small gold ring); anything else is the default ring. `explode` with `visual: 'blackhole'` draws a violet collapse instead of a fireball. Repeated explosions on one spot within 0.25 s draw only a ring and sparks, so a rapid mortar does not stack into a white blob.
- `abilityFx` events are coloured per ability id (a trailing level digit is ignored); `blackhole` also starts a 3 s persistent ground effect (dark core with a spinning accretion ring).
- `zap` events may carry `width` (a stroke multiplier); without it the zap `visual` picks one (`arcweb` 1.1, `stormcrown` 1.55, `overload` 1.35, `zeus` 2.4, which also lingers longer). The engine's chain attacks pass `atk.zapWidth` when a tower sets it.
- Drones: a tractor beam is drawn only while the drone's `towing` flag is true (the Drone Bay sets it each tick; drones without the flag fall back to "has a target"). While the owning tower has `data._field_run` (Strike Wing's Bombing Run) its drones draw 1.7x larger with a smoke trail.
- Field rings: a tower with `attacks.tide` (Gravity Well Undertow) runs its rings outward and faster.
- The vault floating text sits above the rig's own payout text.
- Icon helpers: `drawTowerIcon(ctx, def, size, variant, assets)`, `drawHeroIcon`, `drawEnemyIcon(ctx, type, size, mods, assets)`, `drawTitanIcon(ctx, kind, size, assets)`.
- Tower art: `art.sprite` is tried first, then `tower_<id>`, then an alias (`rail` also looks for `tower_sniper_<n>`). `art.shape`: hex, square, circle, oct, diamond, tri, pent. Optional `art.head` picks the head style. Projectile visuals: bolt, shard, slug, missile, shell, orb, needle, plasma, flame, cryo, bomb, lance (other names map by keyword).
- The placement ghost ring uses `def.base.range` (no Beacon buffs).

### Client
- Titan death plays slow motion from the game loop: 0.3x held for 0.6 s, then eased back to 1x over 0.25 s; the renderer adds the flash and shake.
- UI: ability buttons show the owner's portrait plus a small badge. Tower abilities name an `icon` id and get the matching `ab_<id>` SVG from `src/ui/format.js` (`hasIcon(name)` tells whether one exists); Commander abilities use a one or two character glyph. The tower panel hides the targeting row when no attack picks targets (every attack `needsTarget: false`, such as Rigs and Beacons) and hides the arrows when there is a single mode (the mortar's `manual`); damage-free fields (the base Gravity Well) show no damage type. The Codex and shop tooltip show `Aura` for towers with `base.aura` and `Global` for infinite range. A Commander level-up toast carries that level's note (shortened to its headline when long), and the Commander panel shows the next level's note.
- A run that used `__ss.debug.skipTo` is flagged `debug` (kept in the save meta) and never writes records.
- `window.__ss.debug` also has `select(id)`, `pause()`, `resume()`, `speed(n)`, `screen(name)`.
