# SHARDSTORM: Economy and Scaling Model

This document is the numeric contract. All tower, enemy and wave numbers must follow it, and `tools/balance.mjs` verifies it. Every constant below lives in `src/data/economy.js` so the balance pass can tune it in one place. docs/BALANCE.md explains the model in plain language, proves the soundness claims of section 7 and shows the measured results.

Notation: `w` = wave number (1-based). "Mass" = total hit points of an enemy including all of its children (Bloons RBE). "Shell" = one layer that breaks (one pop).

## 1. Income

### 1.1 Shell bounty
Every shell destroyed pays `1 x c(w)` credits, where `w` is the wave the enemy belongs to.

```
c(w) = 1                      for w <= C_START      (C_START = 50)
c(w) = (C_START / w)^C_EXP    for w >  C_START      (C_EXP = 3)
```
c(60) = 0.58, c(80) = 0.24, c(100) = 0.125, c(120) = 0.072, c(150) = 0.037.

Because a multi-HP shell (Obsidian, ship hulls) pays one bounty regardless of its HP, credits per mass fall naturally as waves shift to denser enemies: Obsidian 95/104 = 0.91, Hauler 381/616 = 0.62, Dreadnought 0.37, Worldbreaker about 0.24. This is the first brake on late-game income; `c(w)` is the second.

Credits are stored as a float; the HUD shows `floor(credits)`. Purchases require `credits >= price`.

**Bounty conservation.** Bounty is paid once per shell the storm sent, never for shells created on the field. Two things create shells there, and both are capped (`e.owed` in `src/sim/enemies.js`):
- **Nanite regrowth.** A regrown shell and every child it later splits into share the bounty of the shells it had before it regrew. A family that is popped, left alone for 3 s and popped again keeps growing, but it never pays more than it was worth when it arrived.
- **The Maw's volleys.** The Maw pays for as many volleys as it spits crossing its channel once at full speed (`ceil(crossing time / 3.2 s)`, counted from where it appears). Volleys past that (a slowed or stalled Maw) pay nothing.

An unpaid shell also gives no Refinery bonus and no Commander XP. So every wave pays bounty for at most the shells in its groups, its Titan and the Maw's paid volleys, whatever the defense does.

### 1.2 Wave bonus
When a wave is cleared (all of its spawns released and every enemy belonging to it destroyed or leaked): `+ (200 + w)` credits. Not scaled by c(w). It matters most in the first twenty waves, where it funds the second and third tower; by wave 30 pops pay more than the bonus.

### 1.3 Passive income (bounded by construction)
- **Mining Rig**: pays a fixed amount per wave cleared (by tier), scaled by `c(w)` ("ore price falls as the storm floods the market"). Hard cap **10 Rigs** alive at once. Payback period `P = totalCost / incomePerWave` (at c = 1) must be **>= 8 waves** at every tier combination; target P in [9, 14].
- **Vault** (Rig path B): banks that rig's income with interest of 4% to 10% per wave (by tier) on the stored amount, up to a **capacity cap** per rig (by tier). Withdraw anytime. Interest never applies above the cap, and it is scaled by `c(w)` like ore, so vault income is bounded by `rate x cap x c(w)` per wave.
- **Supply drops** (Rail Sniper path C T4+): a fixed number of drops per wave, each worth a fixed amount scaled by c(w). A Supply Drop rail pays back its cost in more than 8 waves at c = 1 (it is a combat tower first).
- **Refinery** (Rig path C): extra `k x c(w)` credits per shell destroyed within its radius, k <= 0.25. This is a bonus on bounty, not passive income: it is at most a quarter of the pop income of the shells it covers, so it grows with the storm's shell count and is not held to the payback floor.

Because Rigs are capped, vault interest is capped, supply drops are counted per tower on a finite map, and every payout is scaled by c(w), total passive income per wave is bounded by a constant times c(w). There is no compounding loop. docs/BALANCE.md 3.2 gives the bound (about 170k x c(w) per wave, with a map packed full of Supply Drop rails).

### 1.4 Starting credits
650 on every difficulty.

## 2. Spending

### 2.1 Difficulty cost multiplier
`price = round5(basePrice x m_d)`, m_d = 0.85 / 1.00 / 1.08 / 1.20 (Cadet / Pilot / Veteran / Nightmare). round5 = round to nearest multiple of 5.

### 2.2 Discounts
Command Beacon path C gives 5 / 10 / 15% off tower purchases and upgrades for towers whose center is inside its radius. **Discounts do not stack** (the best one applies), and they never apply to Mining Rigs or Command Beacons (no discount-to-income loop).

### 2.3 Selling
- Sell value = **70% of credits actually paid** for the tower and its upgrades (after discounts and difficulty).
- **Undo refund**: a tower bought during the current build phase, before any wave has launched since, sells for 100% of what was paid. No value can be created because no wave ran in between.
- Since refunds are always <= what was paid, buying and selling can never create credits (no arbitrage).

### 2.4 Tier price ratios (guideline)
For a tower with base price `b`, upgrade prices should fall in these bands (per upgrade, not cumulative):

| Tier | Price range |
|---|---|
| T1 | 0.4b to 1.2b |
| T2 | 0.8b to 2.5b |
| T3 | 2b to 8b |
| T4 | 8b to 30b |
| T5 | 40b to 150b |

## 3. Tower power and efficiency

### 3.1 Benchmark scenarios
`tools/bench.mjs` places one tower (with a given upgrade set) beside a straight test channel and measures **mass destroyed per second (MDS)** over 30 simulated seconds with an overwhelming supply of targets:

| Scenario | Stream (kept saturated by an adaptive spawner, docs/BENCH.md 3) | What it rewards |
|---|---|---|
| SWARM | Rose shards, 12 in the tower's reach | pierce, area, fire rate |
| DENSE | a synthetic 20 HP single-shell meteor, 5 in reach | damage per hit, sustained DPS |
| SHIP | one synthetic ship hull with effectively infinite HP creeping past at speed 0.2 | single target DPS, ship bonuses |
| MIXED | cycling Iron, Magma, Comet, Prism, Geode, 8 in reach | damage type coverage |
| SWARM2X / SWARM4X | Rose shards at 24 / 48 in reach | area towers at late-game density (graded only as path secondaries) |

Efficiency: `eta_s = MDS_s / totalCost x 1000` (mass per second per 1000 credits).

### 3.2 Target curve
Let `eta0 = 10` be the reference efficiency of a base tower in its primary scenario. The expected efficiency by the tower's highest tier:

| Highest tier | 0 | 1 | 2 | 3 | 4 | 5 |
|---|---|---|---|---|---|---|
| Multiplier | 1.00 | 1.05 | 1.12 | 1.30 | 1.60 | 2.50 |

A damage tower passes if its best primary-scenario efficiency is within **+-35%** of `eta0 x multiplier`. Higher tiers are more efficient (upgrading is always worth it), but T4 and T5 require saving a large lump sum, which is the strategic cost.

**Global range.** A global-range tower (Rail Sniper) applies its ship damage over the whole channel, 8 to 10 times the stretch one bench tower covers, so on SHIP it is graded against `GLOBAL_SHIP_FACTOR x target` (0.7). Matching the plain target there made Rails the answer to every late ship wave (more than half of a strong defense's credits).

**Path secondaries.** A config whose highest path is a ship path (Pulse Marksman T3+, Missile Hunter-Killer T3+, Tesla Overload T3+, Drone Bomber, Scatter Solar Flare T5, Mortar Doomsday T5) is also graded on SHIP; Pulse Starlance on DENSE; Missile Nova and every Mortar T4/T5 on 2x or 4x SWARM density (an aimed shell or a Nova is limited by how many meteors are under it). docs/BENCH.md lists them.

Primary scenarios:
| Tower | Primary | Secondary |
|---|---|---|
| Pulse Turret | SWARM | SHIP (Marksman) |
| Scatter Pod | SWARM | DENSE |
| Rail Sniper | DENSE, SHIP | |
| Missile Pod | SWARM, DENSE | SHIP (Hunter-Killer) |
| Tesla Coil | SWARM, MIXED | SHIP (Overload) |
| Laser Array | SHIP, DENSE | |
| Drone Bay | SWARM | SHIP (Bomber) |
| Orbital Mortar | SWARM | DENSE |
| Cryo Emitter | utility | SWARM (Embrittle, Cryo Lance) |
| Gravity Well | utility | SWARM (Crusher) |
| Mining Rig | income | |
| Command Beacon | support | |

### 3.3 Utility value
- Slows and freezes: measured against a reference Pulse Turret 2-0-0 sharing the corridor. A utility config passes when it cuts the corridor's leaked mass by at least 20% or raises its MDS by at least 35% (the MDS gain alone undervalues pure delay, docs/BENCH.md 4).
- Beacon buffs: +X% attack speed / range on the towers it covers. It pays for itself when covering 4 towers of its own value: `4 x (fractional MDS gain on 4 reference towers) >= 0.75`.

## 4. Threat

### 4.1 Mass budget per wave
```
B(w) = 19 x w^0.81 x 1.0514^w x S(w)
S(w) = exp(K_SURGE x x^2)                    x = max(0, w - SURGE_START), x <= SURGE_CAP
S(w) = exp(K_SURGE x SURGE_CAP x (2x - SURGE_CAP))                          x >  SURGE_CAP
K_SURGE = 0.0032, SURGE_START = 65, SURGE_CAP = 100
```
| w | 1 | 10 | 20 | 30 | 40 | 50 | 60 | 70 | 80 | 90 | 100 | 110 | 120 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| B(w) | 20 | 203 | 586 | 1.34k | 2.8k | 5.5k | 10.6k | 21.5k | 75k | 489k | 6.0M | 138M | 6.0G |

Up to wave 65 this tracks Bloons TD6's round RBE (a fitted power-times-exponential). After wave 65 the **surge** term makes log(B) grow quadratically, so threat grows faster than any fixed exponential: the storm always wins eventually. The surge is what ends strong runs between waves 95 and 115 (docs/BALANCE.md 4). Past wave 165 (SURGE_CAP) log(B) keeps growing at a constant rate instead, only so that every number stays finite far beyond any run (B(1000) is about 3e271).

Authored waves 1 to 40 must each be within **+-20%** of B(w) (spikes and breather waves are fine inside that band). Procedural waves (41+) are generated to within +-5% of B(w).

### 4.2 Spawn duration
`D(w) = clamp(10 + 0.4w, 10, 45)` seconds for procedural waves. Authored waves are free but should stay near this.

### 4.3 Entity caps and ship scaling
To keep performance bounded, a wave spawns at most **300 top-level entries**. When the budget cannot be met within that cap using the strongest unlocked enemies, the wave applies a **hull multiplier** `H(w) >= 1` to every ship hull HP in that wave (ships spawned as children included). The generator solves for H so that total mass matches B(w). Meteor shells are never multiplied, so their bounty and pop counts stay intuitive.

Mass of a ship with hull multiplier H: `mass(H) = H x hullMass + meteorMass`, where hullMass is the sum of all ship hull HP in its family tree. Example: Worldbreaker hullMass = 41,200 and meteorMass = 14,560.

With the surge the cap binds from about wave 100, and H carries the growth from there (H is about 3 at wave 100 and 80 at wave 110).

### 4.4 Speed ramp
All enemies move at `v(w) = 1 + 0.01 x max(0, w - 80)` times their base speed, capped at 2.5.

### 4.5 Enemy unlock schedule (guideline for authored waves)
| First appears | Enemy |
|---|---|
| 1 | rust |
| 3 | cobalt |
| 5 | jade |
| 9 | amber |
| 12 | rose |
| 14 | phantom modifier |
| 16 | iron |
| 18 | magma, comet |
| 22 | prism, nanite modifier |
| 24 | geode |
| 28 | aurora |
| 32 | obsidian |
| 35 | plated modifier |
| 40 | hauler |
| 50 | warbarge, specter |
| 70 | dreadnought |
| 90 | worldbreaker |

Every 20th wave adds a Storm Titan on top of its budget (the Titan's own hull is not counted in B(w); it is the boss check).

### 4.6 Storm Titan hull
```
titanHp(tier) = TITAN_K x sqrt(tier) x B(w) / S(w)^(1 - TITAN_SURGE_EXP)     w = 20 x tier
TITAN_K = 0.7, TITAN_SURGE_EXP = 0.5
```
| wave | 20 | 40 | 60 | 80 | 100 | 120 |
|---|---|---|---|---|---|---|
| hull | 410 | 2.8k | 12.8k | 73k | 1.32M | 82M |
| hull / B(w) | 0.70 | 0.99 | 1.21 | 0.98 | 0.22 | 0.014 |

Before the surge the Titan tracks the threat budget of its own wave, so every early Titan is the same kind of single-target check relative to the economy the player has at that point, and the sqrt(tier) factor makes each one a little stiffer than the last. Once the surge starts, the Titan follows only the square root of it: the surge is flood pressure, spread over hundreds of spawns that area damage handles, while a Titan is one target. With the full surge (the previous rule) the wave 100 Aegis was 1.57 x B(100) of single-target hull and ended every strong run on that one wave; now it is a real check that some defenses fail and the flood decides the rest (docs/BALANCE.md 4). The hull multiplier H is already inside B(w), so it is not applied again.

Titans resist crowd control like every ship: slows are half as strong on a Titan, stuns last half as long, and a ship cannot be stunned again for 1 s after a stun ends (`SHIP_STUN_IMMUNE`), so stacked stunners hold a ship still for at most `stun / (stun + 1 s)` of the time and every wave ends. Pulling an enemy back along the channel (Gravity Well Undertow, Drone Bay tractors) spends a per-enemy budget that children inherit from their parent, so no pop-and-regrow cycle can refresh it.

### 4.7 Early pacing
Authored waves 1 to 15 are stretched in time without changing their mass: every `start` and `spacing` is multiplied by `earlyPace(w) = 1 + 0.6 x (16 - w) / 15` (1.6x at wave 1, 1x from wave 16). Early rounds keep their BTD-like mass but arrive at roughly BTD-like density, so an opening of two or three turrets can hold them.

**Per-map pacing.** Two-lane maps split a young defense in two, so they also stretch spawn times (never mass or content) with `map.pace = { mult, until, fade }`: Orbital Dock 1.2x up to wave 30, Ember Rift 1.4x up to wave 35, each easing back to 1x over the next 10 waves. Ember Rift also opens its second lane gradually (every spawn uses the west lane before wave 10, an even split by wave 20). Records stay comparable because the waves themselves are identical on every map.

### 4.8 First exposures
New threats arrive in a survivable first dose with a tip that names the counter:
- **Iron (wave 16):** two Iron Meteors in an otherwise ordinary wave. An all-KINETIC defense leaks them for 22 Integrity, a clear signal with most of the Integrity left; Iron comes in larger numbers from wave 17.
- **Specter (wave 50):** the first Specter is a **scout** (`scout` group modifier): an empty hold and a fifth of its hull (`SCOUT_HULL = 0.2`, 80 HP), so a leak costs 80 Integrity instead of 816. Wave 49 warns about it; full Specters follow from wave 53.

## 5. Leaks
A leaked enemy removes its **remaining mass** from Core Integrity: remaining shell HP plus the full mass of its children (with the wave's H applied to ship hulls; a scout has no children). A leaked Storm Titan ends the run.

## 6. Commanders
Commander XP per wave cleared: `xp(w) = 40 + 12w`, plus 0.1 XP for every shell the team destroys while the Commander is on the field. XP to go from level L to L+1: `xpNeed(L) = 35 x L^1.6`. Placed on wave 1, a Commander reaches level 10 around wave 25 and level 20 around wave 60. Commander price follows the difficulty multiplier; selling returns 70%.

## 7. Soundness claims and how they are checked

The proofs are in docs/BALANCE.md 3; `node tools/balance.mjs` checks every claim and exits non-zero on a violation.

1. **Termination.** The map has finite buildable area, so the number of towers is bounded and total damage output is bounded by a constant. Required damage grows without bound (B(w)/D(w) is super-exponential after wave 65, hulls grow with H once the spawn cap binds, the speed ramps, and ships cannot be held still by stuns). Therefore every run ends. Checked: no bot survives past wave 160 (uncapped runs).
2. **No arbitrage.** Refunds <= paid, a used Beacon discount spends the Beacon's undo refund, discounts excluded from Rigs and Beacons, no interest above caps, abilities never pay credits directly, and bounty is paid once per shell the storm sent (1.1). Checked: property tests that try buy/sell/undo loops, discount loops, Rig and vault loops, save/load and every activated ability under three timing policies, and assert credits plus asset value never rise above what the storm paid in; the same ability runs assert that no wave pays bounty for more shells than it sent (nanite regrowth and Maw volleys included).
3. **Bounded passive income.** Rig cap, vault caps, supply drop counts, everything times c(w). Checked: maximum theoretical passive income per wave for waves 1 to 160, and an engine payout check against it.
4. **Monotone threat.** B(w+1) > B(w) for all w >= 1 (checked to wave 600), log-convex from the surge start to SURGE_CAP, authored waves inside +-20% and procedural waves inside +-5%, Titan hulls increasing. Checked by the balance report.
5. **Upgrades are worth buying.** Efficiency rises with tier per section 3.2. Checked by the bench table (pass rate by tower and tier; no config HIGH).
6. **Skill expression.** On every map, Pilot, several seeds, with and without a Commander (medians):
   - Novice bot (buys cheap towers, random legal spots, never upgrades past tier 2) loses between waves 25 and 55.
   - Solid bot (greedy best-efficiency purchases near the path, upgrades toward tier 4 and 5) reaches waves 70 to 110 (with a Commander: up to 130).
   - Eco bot (Solid bot plus Mining Rigs early) reaches at least as far as Solid: strictly on the median pooled over all maps, and within 2 waves of it on each map (seed noise; `TARGETS.ecoTol` in tools/balance.mjs).
   - No bot passes wave 160.
   - Difficulty orders the results: Cadet >= Pilot >= Veteran >= Nightmare.
   - No tower type holds more than half of the solid bot's credits at the end of a run.
