# SHARDSTORM: Economy and Scaling Model

This document is the numeric contract. All tower, enemy and wave numbers must follow it, and `tools/balance.mjs` verifies it. Every constant below lives in `src/data/economy.js` so the balance pass can tune it in one place.

Notation: `w` = wave number (1-based). "Mass" = total hit points of an enemy including all of its children (Bloons RBE). "Shell" = one layer that breaks (one pop).

## 1. Income

### 1.1 Shell bounty
Every shell destroyed pays `1 x c(w)` credits, where `w` is the wave the enemy belongs to.

```
c(w) = 1                      for w <= C_START      (C_START = 50)
c(w) = (C_START / w)^C_EXP    for w >  C_START      (C_EXP = 2)
```
c(60) = 0.69, c(80) = 0.39, c(100) = 0.25, c(120) = 0.17, c(150) = 0.11.

Because a multi-HP shell (Obsidian, ship hulls) pays one bounty regardless of its HP, credits per mass fall naturally as waves shift to denser enemies: Obsidian 95/104 = 0.91, Hauler 381/616 = 0.62, Dreadnought 0.37, Worldbreaker about 0.24. This is the first brake on late-game income; `c(w)` is the second.

Credits are stored as a float; the HUD shows `floor(credits)`. Purchases require `credits >= price`.

### 1.2 Wave bonus
When a wave is cleared (all of its spawns released and every enemy belonging to it destroyed or leaked): `+ (100 + w)` credits. Not scaled by c(w).

### 1.3 Passive income (bounded by construction)
- **Mining Rig**: pays a fixed amount per wave cleared (by tier), scaled by `c(w)` ("ore price falls as the storm floods the market"). Hard cap **10 Rigs** alive at once. Payback period `P = totalCost / incomePerWave` (at c = 1) must be **>= 8 waves** at every tier combination; target P in [9, 14].
- **Vault** (Rig path B): banks that rig's income with interest of 4% to 10% per wave (by tier) on the stored amount, up to a **capacity cap** per rig (by tier). Withdraw anytime. Interest never applies above the cap, so vault income is bounded by `rate x cap` per wave.
- **Supply drops** (Rail Sniper path C T4+): a fixed number of drops per wave, each worth a fixed amount scaled by c(w).
- **Refinery** (Rig path C): extra `k x c(w)` credits per shell destroyed within its radius, k <= 0.25.

Because Rigs are capped, vault interest is capped, and every tower costs space, total passive income per wave is bounded by a constant times c(w). There is no compounding loop.

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

| Scenario | Stream | What it rewards |
|---|---|---|
| SWARM | Jade shards, 10 per second | pierce, area, fire rate |
| DENSE | Obsidian Hearts, 2 per second | damage per hit, sustained DPS, iron/type coverage |
| SHIP | one Dreadnought hull with effectively infinite HP creeping past at speed 0.2 | single target DPS, ship bonuses |
| MIXED | cycling Iron, Magma, Comet, Prism, Geode, 4 per second | damage type coverage |

Efficiency: `eta_s = MDS_s / totalCost x 1000` (mass per second per 1000 credits).

### 3.2 Target curve
Let `eta0 = 10` be the reference efficiency of a base tower in its primary scenario. The expected efficiency by the tower's highest tier:

| Highest tier | 0 | 1 | 2 | 3 | 4 | 5 |
|---|---|---|---|---|---|---|
| Multiplier | 1.00 | 1.05 | 1.12 | 1.30 | 1.60 | 2.50 |

A damage tower passes if its best primary-scenario efficiency is within **+-35%** of `eta0 x multiplier`. Higher tiers are more efficient (upgrading is always worth it), but T4 and T5 require saving a large lump sum, which is the strategic cost.

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
- Slows and freezes: measured as the **protection factor**, the ratio of MDS of a reference Pulse Turret 2-0-0 with the utility tower placed upstream vs without. Target: utility tower's protection gain, converted to equivalent credits, is within +-35% of its cost at every tier.
- Beacon buffs: +X% attack speed / range on the towers it covers. At tier k it should pay for itself when covering about 4 average towers of the same total value.

## 4. Threat

### 4.1 Mass budget per wave
```
B(w) = 19 x w^0.81 x 1.0514^w x S(w)
S(w) = exp(K_SURGE x max(0, w - SURGE_START)^2)      K_SURGE = 0.0007, SURGE_START = 80
```
| w | 1 | 10 | 20 | 30 | 40 | 50 | 60 | 80 | 100 | 120 | 150 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| B(w) | 20 | 203 | 585 | 1.35k | 2.8k | 5.5k | 10.6k | 36.6k | 158k | 1.15M | 62M |

Up to wave 80 this tracks Bloons TD6's round RBE (a fitted power-times-exponential). After wave 80 the **surge** term makes log(B) grow quadratically, so threat grows faster than any fixed exponential: the storm always wins eventually.

Authored waves 1 to 40 must each be within **+-20%** of B(w) (spikes and breather waves are fine inside that band). Procedural waves (41+) are generated to within +-5% of B(w).

### 4.2 Spawn duration
`D(w) = clamp(10 + 0.4w, 10, 45)` seconds for procedural waves. Authored waves are free but should stay near this.

### 4.3 Entity caps and ship scaling
To keep performance bounded, a wave spawns at most **300 top-level entries**. When the budget cannot be met within that cap using the strongest unlocked enemies, the wave applies a **hull multiplier** `H(w) >= 1` to every ship hull HP in that wave (ships spawned as children included). The generator solves for H so that total mass matches B(w). Meteor shells are never multiplied, so their bounty and pop counts stay intuitive.

Mass of a ship with hull multiplier H: `mass(H) = H x hullMass + meteorMass`, where hullMass is the sum of all ship hull HP in its family tree. Example: Worldbreaker hullMass = 41,200 and meteorMass = 14,560.

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
titanHp(tier) = TITAN_K x sqrt(tier) x B(20 x tier)        TITAN_K = 0.7
```
| wave | 20 | 40 | 60 | 80 | 100 | 120 |
|---|---|---|---|---|---|---|
| hull | 410 | 2.8k | 12.8k | 51k | 246k | 1.98M |

The Titan tracks the threat budget of its own wave, so every Titan is the same kind of single-target check relative to the economy the player has at that point, and the sqrt(tier) factor makes each one a little stiffer than the last. The hull multiplier H is already inside B(w), so it is not applied again. (The first draft used `3000 x 3.2^(tier-1)`, which was about 5x the wave budget at wave 20 and ended every bot run there, then fell below 1x after wave 110.)

### 4.7 Early pacing
Authored waves 1 to 15 are stretched in time without changing their mass: every `start` and `spacing` is multiplied by `earlyPace(w) = 1 + 0.6 x (16 - w) / 15` (1.6x at wave 1, 1x from wave 16). Early rounds keep their BTD-like mass but arrive at roughly BTD-like density, so an opening of two or three turrets can hold them.

## 5. Leaks
A leaked enemy removes its **remaining mass** from Core Integrity: remaining shell HP plus the full mass of its children (with the wave's H applied to ship hulls). A leaked Storm Titan ends the run.

## 6. Commanders
Commander XP per wave cleared: `xp(w) = 40 + 12w`. XP to go from level L to L+1: `xpNeed(L) = 150 x L^1.6`. Level 20 is reached around wave 55 if placed on wave 1. Commander price follows the difficulty multiplier; selling returns 70%.

## 7. Soundness claims and how they are checked

1. **Termination.** The map has finite buildable area, so the number of towers is bounded and total damage output is bounded by a constant. Required damage per second grows without bound (B(w)/D(w) is super-exponential after wave 80, and speed ramps). Therefore every run ends. Checked: no bot survives past wave 160.
2. **No arbitrage.** Refunds <= paid, discounts excluded from Rigs and Beacons, no interest above caps. Checked: property test in `tools/balance.mjs` that tries buy/sell/undo loops and discount loops and asserts credits never increase.
3. **Bounded passive income.** Rig cap, vault caps, supply drop counts. Checked: max theoretical passive income per wave reported.
4. **Monotone threat.** B(w+1) > B(w) for all w >= 1, and authored waves stay inside the +-20% band. Checked by the balance report.
5. **Upgrades are worth buying.** Efficiency rises with tier per section 3.2. Checked by the bench table.
6. **Skill expression.** On Crater Basin, Pilot:
   - Novice bot (buys cheap towers, random legal spots, never upgrades past tier 2) loses between waves 25 and 55.
   - Solid bot (greedy best-efficiency purchases near the path, upgrades toward tier 4 and 5) reaches waves 70 to 110.
   - Eco bot (Solid bot plus Mining Rigs early) reaches at least as far as Solid.
   - No bot passes wave 160.
