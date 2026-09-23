# SHARDSTORM: Tower Benchmark

`tools/bench.mjs` is the official tower benchmark from docs/ECONOMY.md section 3. It places one
tower (at a given upgrade combo) beside a straight test channel, keeps it saturated with an
adaptive spawner, and measures **mass destroyed per second (MDS)** over a warm-up-then-measure
window. It grades every tower's best primary-scenario efficiency against the target curve in
ECONOMY.md 3.2, and separately benchmarks utility, income and support towers, whose value isn't
expressed as raw MDS.

This doc and `tools/bench.mjs` (plus its `out/` scratch) are the only files this agent owns. The
bench never edits `src/**`. Everything it needs that isn't in the real game data (the straight
channel, a couple of synthetic bench-only enemies) is registered at runtime into the imported
`MAPS`/`ENEMIES` objects, inside the bench process only, and never written to disk.

## 1. Running it

```
node tools/bench.mjs                                full run: every tower, default config set, all 4 scenarios
node tools/bench.mjs --tower pulse                   one tower
node tools/bench.mjs --tower pulse --config 5-2-0    one tower, one upgrade combo (path A/B/C tiers)
node tools/bench.mjs --scenario SWARM                one scenario only (SWARM | DENSE | SHIP | MIXED)
node tools/bench.mjs --phantom                       also run the optional SWARM_PHANTOM scenario
node tools/bench.mjs --json out/bench.json           also write full machine-readable results
node tools/bench.mjs --quick                         1 s warm-up / 6 s measure (dev iteration, not official numbers)
node tools/bench.mjs --selftest                      validate the bench harness itself (section 6)
```

A full default run (12 towers x 25 configs x 4 scenarios, official 3 s warm-up / 30 s measure
windows) takes well under 15 seconds on a normal laptop, comfortably inside the ~2 minute budget.
`--quick` shortens the simulated windows for fast iteration while building a tower; its numbers
are noisier and not the ones to report as final.

Config codes are `pathA-pathB-pathC` tiers, e.g. `5-2-0` means path A maxed, path B at tier 2,
path C untouched. The default config set is `0-0-0`, each single path at tiers 1 through 5, the
six tier-5 crosspaths named in ECONOMY.md 3.1 (`5-2-0`, `5-0-2`, `2-5-0`, `0-5-2`, `2-0-5`,
`0-2-5`), and three representative "4-2-0 style" mid-tier crosspaths (`4-2-0`, `0-4-2`, `2-0-4`).

## 2. Arena

A single straight channel, `[[40, 500], [1460, 500]]`, width 56, registered at runtime under a
bench-only map id. It stays inside the 1500x1000 world (with the same kind of small edge margin
real maps use), which matters because `findTarget` only considers on-screen enemies
(`ARCHITECTURE.md` never documents this explicitly, but `src/sim/towers.js`'s `onScreen()` check
gates every cooldown-fired attack kind: projectile, hitscan, chain, beam, drone). Pulse- and
field-kind attacks query the grid directly and aren't screen-gated, but keeping everything
on-screen is simpler and matches how the tower would actually be used in a real map.

For a single-tower scenario the tower sits at `x = 750`, just outside the channel edge
(`pathWidth/2 + tower radius + 6` units off it), matching how a player would actually place it
beside a lane. Multi-tower tests (utility protection, Beacon buff) place towers at other fixed
offsets along the same channel; see the source for exact coordinates.

`sim.state.cash` is set to 1e9 and `sim.state.lives` to 1e18 before anything is placed or
spawned, so upgrades never fail on credits and a stray leak can never end the run. The bench never
calls `startWave()`; towers fire regardless of `phase` (confirmed: `Sim.step()` only gates on
`phase === 'over'`), so enemies are spawned directly with `sim.spawnEnemy()` and the sim is
stepped tick by tick. This sidesteps the wave/economy system entirely, which is what lets the
bench run thousands of scenario-ticks per second.

## 3. Scenarios, and the two flaws they fix in the naive ECONOMY.md 3.1 spec

The naive spec was "Jade shards, 10/s" for SWARM and real "Obsidian Hearts, 2/s" for DENSE, both
at a fixed spawn rate. Two problems, found while building this bench:

1. **A fixed 10 Jade/s hard-caps SWARM at 30 mass/s** (10/s x mass 3), regardless of how strong
   the tower is. No tower could ever be measured accurately once its kill rate exceeded the
   supply rate.
2. **A real Obsidian Heart's grandchildren include BLAST- and CRYO-immune types** (Magma and
   Comet, via Geode), which unfairly penalizes BLAST/CRYO-damage towers in a scenario that's
   supposed to be a clean "sustained DPS against a tanky single target" test.

Both are fixed the same way: an **adaptive spawner** (`runAdaptiveMulti` in `tools/bench.mjs`)
checks every tick how many enemies are within the tower's actual reach and tops up to a target
count `N`, spawned just upstream of the tower's engagement window (so there is never a fixed spawn
rate to cap anything), and the DENSE scenario uses a synthetic bench-only meteor instead of a real
Obsidian Heart.

Only enemies still inside (or upstream of) the engagement window count toward `N`: a meteor that
has already slipped past the tower cannot be shot any more, so counting it would starve
short-range towers (this was fixed in the content QA pass; before it, Scatter Pod and chain towers
read 2-3x too low). Towers with a **mortar** attack engage around their aim point, not around the
tower, so their window is the stretch of channel under the shells (aim point +- splash radius +
inaccuracy + 40).

| Scenario | Stream | targetN | Rewards | Fix applied |
|---|---|---|---|---|
| SWARM | Rose shards (mass 5, the fastest 5-shell meteor chain), not Jade | 12 | pierce, area, fire rate | adaptive spawner removes the supply cap |
| DENSE | synthetic `__bench_dense__`: 20 HP, one shell, no children, no immunities | 5 | damage per hit, sustained DPS, type coverage | synthetic target has no BLAST/CRYO-immune descendants |
| SHIP | synthetic `__bench_ship__`: ship-kind, 1e9 HP, speed 0.2, no immunities | 1 | single-target DPS, shipDamage bonuses | near-infinite hull means it's never a supply/respawn problem |
| MIXED | real Iron, Magma, Comet, Prism, Geode, cycled | 8 | damage-type coverage (each is immune to at least one dtype) | n/a, uses real data on purpose |
| SWARM_PHANTOM (`--phantom`, optional) | Rose shards, Phantom-flagged | 12 | detection coverage | n/a |

**MDS** is the delta in the tower's own `damage` stat (docs/ARCHITECTURE.md section 3: the engine
already tracks this per tower) across the 30 s measurement window, divided by 30. That stat is
real mass eliminated, not raw damage dealt: `damageEnemy`/`popEnemy` clamp it to the shell's actual
remaining HP at every layer, including recursive overflow into freshly-spawned children, and never
count overkill beyond a family's remaining mass. A warm-up window (3 s by default) runs first,
untimed, so cooldowns, beam ramps, drone positioning etc. settle before the clock starts.

**Efficiency**: `eta = MDS / totalCost x 1000` (totalCost = base price + every purchased
upgrade's price, at Pilot difficulty, ECONOMY.md 2.4). `target = ETA0 x TIER_EFFICIENCY[highest
tier]` (both from `src/data/economy.js`, the single source of truth). **PASS** if the best eta
among the tower's *primary* scenarios (the table below, hardcoded from ECONOMY.md 3.2) is within
`EFFICIENCY_TOLERANCE` (currently 35%) of target; otherwise **LOW** or **HIGH**. Configs that
don't run any of a tower's primary scenarios (e.g. `--scenario SHIP` for Pulse, whose primary is
SWARM) show `INFO`, not a verdict, since nothing was actually measured against the target.

**Global range.** A tower with `range: Infinity` (the Rail Sniper) is graded on SHIP against
`GLOBAL_SHIP_FACTOR x target` (0.7, `src/data/economy.js`): it applies its ship damage over the
whole channel, 8 to 10 times the stretch a bench tower covers. The printed eta is normalised
back to the plain target (the SHIP value divided by 0.7) and the grade reads `SHIP/global`.

| Tower | Primary | Secondary |
|---|---|---|
| Pulse Turret | SWARM | SHIP |
| Scatter Pod | SWARM | DENSE |
| Rail Sniper | DENSE, SHIP | |
| Missile Pod | SWARM, DENSE | SHIP |
| Tesla Coil | SWARM, MIXED | SHIP |
| Laser Array | SHIP, DENSE | |
| Drone Bay | SWARM | SHIP |
| Orbital Mortar | SWARM | DENSE |
| Cryo Emitter | utility, see section 4 | SWARM |
| Gravity Well | utility, see section 4 | SWARM |
| Mining Rig | income, see section 4 | |
| Command Beacon | support, see section 4 | |

## 4. Utility, income and support towers

These aren't graded by raw MDS against the standard target curve; ECONOMY.md 3.3 and 1.3 give
them their own contracts.

**Cryo Emitter, Gravity Well (protection factor)**: a reference Pulse Turret 2-0-0 sits beside the
channel at `x = 900`; the utility tower under test sits directly across the channel from it, so
its field, pulse or lens overlaps the stretch the Pulse covers (the first version put it 400 units
upstream, where a slow or a Lens never touched the Pulse's targets). Both runs spawn into the same
window, computed from the unassisted Pulse. The same adaptively-saturated SWARM stream (Rose
shards) is fed through both, once plain and once Phantom-flagged (the Lens path exists to expose
Phantoms); the graded gain is the better of the two, and the Phantom gain is reported as
`gainPhantom` in the JSON. Two runs per stream: the reference Pulse alone, and the reference Pulse
plus the utility tower. The **primary** signal is `gainMDS = mdsWith -
mdsAlone`, the combined corridor's extra mass destroyed per second (the utility tower's own kills
plus whatever the slow/freeze/expose lets the Pulse turret do better), benchmarked in the same
mass-per-cost currency as every other tower (`etaGain = gainMDS / totalCost x 1000`, graded
against the same `ETA0 x TIER_EFFICIENCY` target curve). `massLeaked` before/after is also
reported as a secondary, more literal reading of "protection" (ECONOMY.md 3.3 allows either
signal).

Known limitation: a pure pull-backward effect (e.g. Gravity Well's Undertow path) can show a
*negative* `gainMDS` in a fixed 30 s window, because delaying enemies means fewer of them reach
the downstream Pulse turret within the window, even though the corridor's actual leak rate
improves (visible in the `leakA`/`leakW` columns). Read both columns for a pull-type utility
tower; don't grade it on `gainMDS` alone.

**Command Beacon (buff on 4 reference towers)**: 4 reference Pulse Turrets (2-0-0) are clustered
beside the channel at `x = 750 +/- {135, 45}`; the Beacon under test sits behind them. Same
`gainMDS`/`etaGain` methodology as the utility test, summed over all 4 reference towers. Both runs
spawn into the window of the **unbuffed** reference towers (a range aura would otherwise move the
spawns upstream and change the test), and the population is 30, so four Pulse Turrets are never
supply-bound. A saturated stream only rewards rate, pierce and damage; range and detection
buffs show up in real waves rather than here.

**Mining Rig (payback period)**: analytical, no simulation needed. `P = totalCost /
stats.income.perWave` (at `c(w) = 1`, matching ECONOMY.md 1.3, "P = totalCost / incomePerWave").
`status`: **LOW** if P < 8 (violates the hard floor), **PASS** if P is in the target band [9, 14],
otherwise **WATCH** (above the floor but outside the target band; several Vault/Refinery-heavy
combos land here because this simple formula doesn't model vault interest compounding or
Refinery/Trade Hub income, which push effective payback lower than the headline `perWave` alone
suggests. That's a real limitation worth a closer look in the balance pass, not necessarily a
balance bug).

## 5. Reading STUB rows

Ten of the twelve towers started as placeholder stub files (`stub: true`, flat 1-damage bolts,
`In development.` everywhere); the tower agents are replacing them while this bench was being
built. The bench detects `def.stub` and prints `[STUB - placeholder data]` under the tower name
and `STUB` in the status column instead of a verdict, so nobody mistakes a placeholder's numbers
for real balance data. It still runs the full scenario set on stubs (cheap, and it exercises the
harness against every attack kind stubs might use). **Nothing else about the bench changes when a
tower goes from stub to real** the results table below already mixes stub and real towers, and a
rerun after every tower lands needs no code changes.

## 6. Validating the bench itself

`node tools/bench.mjs --selftest` runs three checks documented in the CLI usage:

1. **Determinism**: the same tower/config/scenario/seed produces bit-identical MDS twice. Every
   `Sim` is seeded (`newArenaSim(seed)`, default seed 1) and every stochastic thing the bench does
   (spawn offset jitter, and whatever the tower's own attacks roll, e.g. crits) draws from
   `sim.rng()`, so this holds as long as nothing in the harness reads real time or `Math.random`.
2. **Doubling damage roughly doubles MDS.** Checked against DENSE (a flat single-shell target: a
   clean ~2x is expected and enforced). SWARM is reported but only asserted to *increase*: Rose is
   a 5-layer chain of 1 HP shells, so doubling a hit's damage lets its overflow cascade through an
   extra layer in the same hit (`docs/ARCHITECTURE.md` section 6, "Overflow"), which can
   legitimately push SWARM's ratio well past 2x. That isn't a bench bug, it's the engine's overflow
   mechanic being genuinely superlinear against chained 1 HP families; DENSE (no children) is the
   scenario that actually isolates "does more damage per hit mean more MDS".
3. **SHIP is not supply-capped**: a base Pulse Turret's measured SHIP MDS is checked against its
   own cooldown-limited rate (`damage / cooldown`, ignoring pierce since only one target exists),
   and must be close to it, not far below it (which would mean the single synthetic ship was
   unavailable, or being needlessly respawned, part of the time).

All three currently pass.

## 7. Latest results

Full default run after the final balance pass (2026-09), official windows, regenerated with
`node tools/bench.mjs --json out/balance/bench.json`. Counts are over the 25 default configs.
`tools/balance.mjs` section 4 grades the same rows (and the utility, support and income contracts)
and fails on any HIGH; docs/BALANCE.md 3.5 charts efficiency by tier.

| Tower | PASS | LOW | HIGH | Best config (eta vs target, graded on) | Notes |
|---|---|---|---|---|---|
| Pulse Turret | 24 | 1 | 0 | 5-2-0: 30.4 vs 25 (DENSE) | 0-0-2 (7.0 vs 7.3 floor) is the detection step of Marksman; Marksman T3+ is graded on SHIP, Starlance on DENSE |
| Scatter Pod | 25 | 0 | 0 | 2-0-5: 31.3 vs 25 (SWARM) | Solar Flare graded on SHIP; Shatterstorm costs 16,000 (was 13,000: with children visible to same-tick splash, 2-0-5 read 36.5, HIGH) |
| Rail Sniper | 25 | 0 | 0 | 5-0-2: 32.8 vs 25 (SHIP, global) | SHIP graded at 0.7 x target for global range (section 3); a ship hull stops a penetrating slug in real waves |
| Missile Pod | 24 | 1 | 0 | 0-5-2: 29.0 vs 25 (DENSE) | 5-0-2 reads 16.0 on SWARM4X (0.64); Hunter-Killer graded on SHIP; Bomblets scatter 3 bomblets (was 4: 0-2-0 read 24.3, HIGH, now 11.4) |
| Tesla Coil | 25 | 0 | 0 | 0-2-5: 33.4 vs 25 (SHIP) | Overload graded on SHIP; Arc Web chains reach 9 meteors and cost 1,700 (were 10 and 1,200: 3-0-0 read 19.8, HIGH, now 15.3); Hot Coils 420 and Scanner Coil 480 (were 450 and 500) keep 0-0-2 above the floor |
| Laser Array | 25 | 0 | 0 | 0-0-2: 13.4 vs 11.2 (DENSE) | |
| Drone Bay | 22 | 3 | 0 | 2-5-0: 33.0 vs 25 (SHIP) | Tractor 0-0-2 (detection) and the Gravity Hauler T5 (control, 0.58x) read low; Bomber Drones blasts deal 3 to 12 meteors (were 5 to 16: 0-3-0 read 22.1, HIGH, now 12.6; Heavy Bombers still ends at 8 to 24); Tractor Drones costs 1,700 (was 1,800) |
| Orbital Mortar | 22 | 3 | 0 | 0-2-0: 14.4 vs 11.2 (SWARM) | Firestorm 0-5-0 / 2-5-0 and 0-2-5 read 0.55 to 0.64 on SWARM4X; Doomsday deals 200 to ships (was 230, 5-0-2 read HIGH on SHIP) |
| Cryo Emitter | utility | | | leaks through the corridor fall from 1965 to 10 to 25 with Frost Titan or Glass Storm | graded on leak and MDS gain by `tools/balance.mjs` (25/25 protect the corridor) |
| Gravity Well | utility | | | Crusher T5 and Rewind crosspaths cut leaks to near 0 | graded as above (25/25) |
| Mining Rig | 12 PASS | 13 WATCH | | P 9.3 to 50 | every combo pays back in 8 waves or more (the hard floor) |
| Command Beacon | support | | | base aura +20% attack speed | `etaGain` reads low by construction (four cheap Pulse 2-0-0s); on four covered towers of its own value every config pays for itself (`tools/balance.mjs`, 25/25) |

Damage towers: 192 of 200 default configs pass, none HIGH. Efficiency rises with tier on every
damage tower (docs/BALANCE.md, efficiency chart).

The headless bots (`tools/headless.mjs`) measure every configuration in a similar arena (seven
categories: SWARM, DENSE, SHIP, IRON, SPECIAL, PHANTOM, SPECTER) and build real defenses from
those numbers, so bot results are the second balance signal next to this table.

Full machine-readable results (every config, every tower): `out/balance/bench.json` (gitignored
scratch, regenerate with `--json`).
