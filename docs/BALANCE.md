# SHARDSTORM: Balance and Economic Soundness

This document explains how the SHARDSTORM economy works, proves the claims that make it sound as an endless game, and shows what the bots measure. The numeric contract is docs/ECONOMY.md; every constant lives in `src/data/economy.js`. Everything below the headings marked *generated* is written by `tools/balance-report.mjs` from real runs, so the document can be reproduced:

```
node tools/balance.mjs --sweep --json out/balance/report.json   # soundness suite + bot sweep (about 25 minutes)
node tools/balance-report.mjs                                   # charts in docs/balance/*.svg, tables below
node tools/balance-report.mjs --check                           # exit 1 if this document is out of date
```

`tools/balance.mjs` exits non-zero on any violation of the claims in section 3 and the targets in section 4.

## 1. The model in plain language

A run is a loop of two flows.

**Credits in.** Every shell (one layer of a meteor or a ship hull) that breaks pays `c(w)` credits, where `w` is the wave it belongs to. `c(w)` is 1 up to wave 50 and then falls as `(50/w)^3`: the storm floods the market with ore. Clearing a wave pays a flat `200 + w`. Mining Rigs, vaults and Rail supply drops pay a fixed amount per wave, also times `c(w)`. Nothing else ever creates credits.

**Credits out.** Credits buy towers and upgrades. A tower turns credits into damage at a rate that rises with tier (the bench efficiency, section 3.5). Selling returns 70% of what was paid (100% for a purchase undone before the next wave launches).

**Threat.** Wave `w` carries a mass budget `B(w)`: the total hit points of everything in it. `B` follows Bloons TD6's round curve (a power law times 5.1% growth per wave) up to wave 65, and from there a **surge** factor `exp(0.0032 x (w - 65)^2)` makes its logarithm grow quadratically. Every twentieth wave adds a Storm Titan, a single boss hull that ends the run if it reaches the Core.

**Why the storm always wins.** Income is roughly proportional to the number of shells in a wave times `c(w)`. Past wave 50 `c(w)` falls like `w^-3`, and past about wave 100 the wave hits its 300-spawn cap, so the shell count stops growing while `B(w)` keeps climbing by multiplying ship hulls. The defense a player can afford grows roughly with cumulative income; the threat grows faster than any exponential. The chart below shows the gap: all the credits a perfect player could ever earn are overtaken by a single wave's mass shortly after wave 90.

![Threat budget versus income, log scale](balance/threat.svg)

**Where skill shows.** Early waves are generous (a 200-credit wave bonus, stretched early spawns, gentle first doses of every new enemy), so the difference between players is how well they convert credits into coverage of every damage type, detection and ship damage. A random cheap defense (the novice bot) dies between waves 20 and 45 at the first threat it cannot answer: an unanswered Iron wave, a dense Rose stream, or the first all-Phantom wave (43). A defense that buys efficiently (the solid bot) reaches the surge, where the flood and the wave 100 Titan end the run between waves 95 and 115. No strategy survives past about wave 120, because by then one wave outweighs every credit the game has ever paid.

### Constants (generated)
<!-- gen:constants -->
| Constant | Value | Where |
|---|---|---|
| Starting credits | 650 | ECONOMY 1.4 |
| c(w) | 1 up to wave 50, then (50/w)^3 | ECONOMY 1.1 |
| Wave bonus | 200 + w | ECONOMY 1.2 |
| Surge | exp(0.0032 x max(0, w - 65)^2) | ECONOMY 4.1 |
| Titan hull | 0.7 x sqrt(tier) x B(w) / S(w)^0.5, w = 20 x tier | ECONOMY 4.6 |
| Global-range SHIP grading | 0.7 x target | ECONOMY 3.2 |
| Specter scout hull | 0.2 x hull, empty hold | ECONOMY 4.8 |
<!-- /gen:constants -->

## 2. The math

Notation: `w` wave, `c(w)` bounty factor, `B(w)` mass budget, `S(w)` surge, `H(w)` hull multiplier, `D(w)` spawn duration, `v(w)` speed ramp, `N_max` the most towers any map can hold.

**Income per wave.** If every shell of wave `w` is destroyed, the wave pays

```
I(w) = shells(w) x c(w) + 200 + w + P(w)
```

where `shells(w)` is the number of shells in the wave (fixed by the wave generator) and `P(w)` the passive income. Cumulative income `C(w) = 650 + sum I(k)` for k <= w is an upper bound on everything a player can have spent by wave `w` (a leak only loses shells, it never adds any).

**Passive income.** Each Rig pays `ore x c(w)`; a vault adds `min(balance, cap) x rate x c(w)`; a Supply Drop rail pays `drops x value x c(w)`. With at most 10 Rigs, each tier 5 once per game, and at most `N_max` Rails:

```
P(w) <= (R_max + S_max) x c(w)
```

with `R_max` the best legal 10-Rig fleet at c = 1 and `S_max` every supply drop a map packed with Rails could pay (section 3.2 prints both). The Refinery pays `k x c(w)` per shell destroyed in its radius with `k <= 0.25`, so it is bounded by a quarter of the pop income.

**Threat.**

```
B(w) = 19 x w^0.81 x 1.0514^w x S(w)
log B(w) = log 19 + 0.81 log w + w log 1.0514 + K x max(0, w - 65)^2      (K = 0.0032, up to wave 165)
```

Authored waves 1 to 40 are hand-built within 20% of `B(w)`; procedural waves are generated to within 5%. When 300 spawns of the strongest unlocked enemies cannot carry `B(w)`, every ship hull in the wave is multiplied by `H(w) = (B(w) - meteorMass) / hullMass`, which is exact because mass is linear in `H`.

**Titans.** `titanHp(t) = 0.7 x sqrt(t) x B(20t) / sqrt(S(20t))`: the early Titans are 0.7 to 1.2 times their wave's mass, and after the surge they rise with its square root, so the Titan remains a single-target check (docs/ECONOMY.md 4.6).

**Defense capacity.** A tower config with total cost `k` destroys `eta x k / 1000` mass per second in its bench scenario (section 3.5). Efficiency `eta` is bounded above by the best tier 5 (about 35 on the bench), and a map holds at most `N_max` towers, so the whole defense destroys at most `DPS_max` mass per second, a constant of the map.

### Economy by wave (generated)
Pop income assumes every shell of the wave is destroyed; cumulative income starts at the 650 starting credits.

<!-- gen:economy -->
| Wave | B(w) | Wave mass | Shells | c(w) | Pop + bonus | Cumulative income | B / cumulative | H | Titan |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 20 | 20 | 20 | 1.000 | 221 | 871 | 0.023 | 1.00 |  |
| 10 | 203 | 230 | 230 | 1.000 | 440 | 3.8k | 0.053 | 1.00 |  |
| 20 | 586 | 515 | 515 | 1.000 | 735 | 9.6k | 0.061 | 1.00 | 410 |
| 30 | 1.3k | 1.5k | 1.5k | 1.000 | 1.7k | 21k | 0.063 | 1.00 |  |
| 40 | 2.8k | 2.8k | 2.5k | 1.000 | 2.7k | 44k | 0.064 | 1.00 | 2.8k |
| 50 | 5.5k | 5.5k | 4.0k | 1.000 | 4.2k | 81k | 0.068 | 1.00 |  |
| 60 | 11k | 11k | 7.1k | 0.579 | 4.4k | 128k | 0.083 | 1.00 | 13k |
| 70 | 21k | 21k | 9.8k | 0.364 | 3.9k | 176k | 0.122 | 1.00 |  |
| 80 | 75k | 75k | 38k | 0.244 | 9.6k | 250k | 0.299 | 1.00 | 73k |
| 90 | 489k | 488k | 181k | 0.171 | 31k | 426k | 1.149 | 1.00 |  |
| 100 | 6.0M | 6.0M | 463k | 0.125 | 58k | 999k | 6.002 | 3.34 | 1.3M |
| 110 | 138.4M | 138.4M | 463k | 0.094 | 44k | 1.6M | 85 | 84 |  |
| 120 | 6.0G | 6.0G | 463k | 0.072 | 34k | 2.1M | 2.9k | 3.7k | 81.5M |
| 130 | 492.7G | 492.7G | 676k | 0.057 | 39k | 2.5M | 198k | 295k |  |
| 140 | 7.6e13 | 7.6e13 | 676k | 0.046 | 31k | 2.8M | 27.4M | 30.8M | 17.4G |
| 150 | 2.2e16 | 2.2e16 | 676k | 0.037 | 25k | 3.0M | 7.4G | 12.7G |  |
| 160 | 1.2e19 | 1.2e19 | 552k | 0.031 | 17k | 3.2M | 3.8T | 5.0T | 1.3e13 |
<!-- /gen:economy -->

## 3. Soundness claims and proofs

### 3.1 No arbitrage

**Claim.** Let `W` be the player's wealth (credits plus the sell value of every tower, vault balances in full) and `E` the income the storm paid (bounty, wave bonus, Rig ore, vault interest, supply drops, Refinery). Then `W - E` never increases, whatever the player does and whenever abilities fire. In words: no sequence of actions creates credits.

**Proof.** The simulation changes credits in exactly these places (`src/sim/**`, checked by search): the pop bounty, the wave bonus, the Rig/vault/supply payout, the Refinery bonus, selling, buying, and the debug `giveCash` hook, which flags the run as debug and never writes records. The first four are income, so they raise `W` and `E` by the same amount. For the player's own actions:

1. *Buying* a tower or an upgrade for `p` credits lowers credits by `p` and raises the sell value by `0.7 p` (or `p` while undoable): `W` falls by `0.3 p` or stays equal.
2. *Selling* returns exactly the sell value, which leaves `W` unchanged.
3. *Undo* refunds 100% only for purchases made in the current build phase, before any wave has launched since, so the refund equals what was paid and no income happened in between.
4. *Discounts.* A Beacon discount lowers a purchase price, but the discount is never applied to Rigs or Beacons (so it cannot feed income or itself), discounts do not stack, and a discounted purchase spends the Beacon's undo refund: the Beacon then sells for 70%. The loop "place Beacon, buy discounted, undo Beacon" therefore costs at least 30% of the Beacon, more than any discount it gave.
5. *Vaults.* Interest is paid only on the balance up to the cap and is scaled by `c(w)` (it is income), withdrawing moves the balance to credits one for one, and a vault balance is counted in `W` in full, so withdraw and deposit loops change nothing.
6. *Abilities* never touch credits directly (no ability calls a payout; checked by search in `src/data/**`). They destroy meteors, whose bounty is income, or buff towers.
7. *Save and load* restore credits, paid amounts and vault balances exactly.

Every action therefore leaves `W - E` equal or lower. **Checked by** `tools/balance.mjs` section 1: targeted undo, sell, discount, vault and save/load tests, every activated ability in the game fired at the first usable tick, at random ticks and late in the wave (with Commanders at level 20), and thousands of random commands across all maps and difficulties, asserting `W - E` never rises by more than float rounding.

### 3.2 Bounded passive income

**Claim.** Passive income per wave is at most a constant times `c(w)`, and after wave 50 its share of the threat falls toward zero.

**Proof.** Rigs are capped at 10 alive, each tier 5 upgrade exists at most once per game, and each Rig's ore and vault interest are fixed by its tier, so the Rig total is at most `R_max x c(w)`. Supply drops are a fixed count per Rail at fixed value times `c(w)`; Rails are towers, and the map holds at most `N_max` of them, so drops are at most `S_max x c(w)`. Interest applies only below the cap, so there is no compounding: the vault's payout is at most `rate x cap x c(w)` whatever its history. Since `c(w)` is non-increasing and `B(w)` is increasing, `P(w) / B(w)` is decreasing after wave 50. The Refinery is not passive: it is at most `0.25 x c(w)` per shell actually destroyed in its radius, a bonus on pop income.

**Checked by** `tools/balance.mjs` section 2: it finds the best legal 10-Rig fleet, the Supply Drop and Quartermaster payouts and the densest Rail packing of every map, places the fleet in the engine with every vault full, pays waves 1 to 160 and asserts no payout exceeds the analytic bound; it also asserts the Rig payback floor (P >= 8 waves at c = 1), Refinery k <= 0.25, and that a Supply Drop rail pays back its cost in more than 8 waves.

<!-- gen:passive -->
Best legal 10-Rig fleet (each tier 5 at most once): 5-2-0, 2-5-0, 0-2-5, 2-4-0, 2-4-0, 2-4-0, 2-4-0, 2-4-0, 2-4-0, 2-4-0, paying 35k per wave at c = 1 (ore, full vaults and Trade Hub).
Supply drops: 200 per Supply Drop Rail, 750 for the one Quartermaster; at most 675 Rails fit on any map, so every drop the game could ever pay is at most 136k per wave at c = 1.

| Wave | c(w) | Pop + bonus | 10 Rigs (engine) | Supply bound | Passive / pop |
|---|---|---|---|---|---|
| 1 | 1.000 | 221 | 35k | 136k | 770.69 |
| 20 | 1.000 | 735 | 35k | 136k | 231.73 |
| 40 | 1.000 | 2.7k | 35k | 136k | 62.60 |
| 60 | 0.579 | 4.4k | 20k | 78k | 22.45 |
| 80 | 0.244 | 9.6k | 8.5k | 33k | 4.32 |
| 100 | 0.125 | 58k | 4.3k | 17k | 0.37 |
| 120 | 0.072 | 34k | 2.5k | 9.8k | 0.36 |
| 140 | 0.046 | 31k | 1.6k | 6.2k | 0.25 |
| 160 | 0.031 | 17k | 1.1k | 4.1k | 0.30 |
<!-- /gen:passive -->

### 3.3 Monotone threat

**Claim.** `B(w+1) > B(w)` for every wave, the growth rate of `B` never falls from the surge start to wave 165, and every wave's real mass stays in its band.

**Proof.** `log B(w) = log 19 + 0.81 log w + w log 1.0514 + K x (w - 65)^2 [w > 65]`. Each term is non-decreasing in `w` and the linear term strictly increases, so `B` is strictly increasing. Its growth rate `0.81 log(1 + 1/w) + log 1.0514 + K (2x + 1)` (with `x = w - 65`) changes by `-0.81 / w^2` at most from the power term, while the surge term adds `2K = 0.0064` per wave; `0.81 / w^2 < 0.0064` for every `w > 11`, so from the surge start the growth rate keeps rising (the threat is log-convex, faster than any exponential). Past wave 165 the surge exponent continues along its tangent line (constant growth) only to keep numbers finite; no run gets there. Titan hulls `0.7 sqrt(t) B0(20t) sqrt(S(20t))` are products of increasing positive terms, so each Titan is stronger than the last. The speed ramp `min(2.5, 1 + 0.01 max(0, w - 80))` is non-decreasing.

**Checked by** `tools/balance.mjs` section 3 (B strictly increasing to wave 600, log-convex to wave 165, every wave 1 to 200 inside its band, `H >= 1`, Titans increasing, required clear rate `B/D x v` increasing) and `tools/wavecheck.mjs` (every wave spec, both lane counts, determinism).

### 3.4 Termination

**Claim.** Every run ends, whatever the player does.

**Proof.** The map has a finite buildable area and towers keep a minimum spacing, so at most `N_max` towers exist. Each tower config has a bounded damage output (finitely many configs, bounded buffs, abilities on cooldowns), so the whole defense deals at most `DPS_max` damage per second. Now bound how long one ship can stay on the field. The slowest ship class moves at 0.18 x 90 = 16.2 units per second times `v(w) >= 1`; the strongest ship slow in the game is 0.25 (Frost Titan), and slows do not stack (the strongest applies); a freeze on a ship is only a 0.6 slow; stuns on ships last at most 1.5 s and a ship cannot be stunned again for `SHIP_STUN_IMMUNE = 1` s afterwards, so it moves at least 40% of the time; Gravity Well pulls on ships have a per-ship budget (at most 320 units). A ship therefore crosses a channel of length `L` in at most `T_max = (L + 320) / (16.2 x 0.25 x 0.4)` seconds, a constant of the map. It absorbs at most `DPS_max x T_max` damage before it reaches the Core. Once the spawn cap binds, every hull in wave `w` is multiplied by `H(w)`, and `H(w) -> infinity` because `B(w)` grows without bound while the unmultiplied capacity of 300 spawns is fixed. So there is a wave where a single Worldbreaker hull (20,000 x `H(w)`) exceeds `DPS_max x T_max`; it leaks, its remaining mass is larger than any Core Integrity (at most 200), and the run ends. Storm Titans end it sooner.

**Checked by** the bot sweep (section 4): no run, uncapped, clears wave 160, and every wave finishes inside the headless wave timeout (600 simulated seconds). Before the ship stun immunity, stacked stuns could hold a Storm Titan still for most of a wave and stall it past that timeout.

### 3.5 Upgrades are worth buying

**Claim.** A higher tier destroys more mass per credit than a lower one, so upgrading is never a trap, and no single config is out of band.

**Evidence.** The bench (docs/BENCH.md) measures every damage tower's efficiency on its primary scenarios; the target rises with tier (1.0, 1.05, 1.12, 1.3, 1.6, 2.5 times 10). `tools/balance.mjs` section 4 grades the 25 default configs of every tower, reports the pass rate by tier and fails on any config reading HIGH (more than 35% over target) or a tower whose tier 5 is not more efficient than its base.

<!-- gen:bench -->
| Tower | Kind | Pass | T0 | T1 | T2 | T3 | T4 | T5 | Mean eta by tier |
|---|---|---|---|---|---|---|---|---|---|
| Pulse Turret | damage | 20/25 | 1/1 | 2/3 | 1/3 | 3/3 | 6/6 | 7/9 | 10.0, 7.6, 7.2, 9.4, 13.0, 23.8 |
| Scatter Pod | damage | 23/25 | 1/1 | 2/3 | 3/3 | 2/3 | 6/6 | 9/9 | 11.9, 7.9, 9.9, 11.6, 15.2, 24.6 |
| Rail Sniper | damage | 22/25 | 0/1 | 2/3 | 3/3 | 3/3 | 6/6 | 8/9 | 13.6, 13.4, 13.0, 16.0, 15.3, 28.9 |
| Missile Pod | damage | 22/25 | 1/1 | 2/3 | 2/3 | 3/3 | 6/6 | 8/9 | 9.8, 8.3, 9.7, 12.1, 12.6, 22.6 |
| Cryo Emitter | utility | 25/25 |  |  |  |  |  |  |  |
| Tesla Coil | damage | 25/25 | 1/1 | 3/3 | 3/3 | 3/3 | 6/6 | 9/9 | 7.8, 9.0, 11.1, 12.3, 17.1, 24.6 |
| Laser Array | damage | 25/25 | 1/1 | 3/3 | 3/3 | 3/3 | 6/6 | 9/9 | 11.1, 10.5, 10.0, 13.0, 15.7, 23.9 |
| Drone Bay | damage | 21/25 | 1/1 | 3/3 | 2/3 | 2/3 | 6/6 | 7/9 | 8.8, 9.1, 7.2, 10.8, 15.2, 22.8 |
| Orbital Mortar | damage | 22/25 | 1/1 | 3/3 | 3/3 | 3/3 | 6/6 | 6/9 | 8.5, 9.4, 11.4, 11.9, 13.3, 17.3 |
| Gravity Well | utility | 25/25 |  |  |  |  |  |  |  |
| Mining Rig | income | 25/25 |  |  |  |  |  |  |  |
| Command Beacon | support | 12/25 |  |  |  |  |  |  |  |

Targets by tier: 10.0, 10.5, 11.2, 13.0, 16.0, 25.0 (+-35%). Utility, support and income rows count configs that meet their own contract (section 4 of docs/BENCH.md).
<!-- /gen:bench -->

![Bench efficiency by tier](balance/efficiency.svg)

Configs that read LOW are reported but not violations: Tractor detection and control tiers and Firestorm are utility-heavy, and a few crosspaths trade raw damage for range, which a saturated bench stream cannot reward.

### 3.6 Summary of checks (generated)
<!-- gen:checks -->
| Check | Result |
|---|---|
| No arbitrage (random play) | 6 runs, 1628 commands, 122907 ticks, 77 ability uses; worst rise of credits + assets above income 0.0e+0 |
| Threat bands | authored waves within 16.8% of B(w), procedural within 1.00% |
| Violations | [threat] B(525) = Infinity is not above B(524) = 4.787800027998677e+307; [threat] B(526) = Infinity is not above B(525) = Infinity; [threat] B(527) = Infinity is not above B(526) = Infinity; [threat] B(528) = Infinity is not above B(527) = Infinity; [threat] B(529) = Infinity is not above B(528) = Infinity; [threat] B(530) = Infinity is not above B(529) = Infinity; [threat] B(531) = Infinity is not above B(530) = Infinity; [threat] B(532) = Infinity is not above B(531) = Infinity; [threat] B(533) = Infinity is not above B(532) = Infinity; [threat] B(534) = Infinity is not above B(533) = Infinity; [threat] B(535) = Infinity is not above B(534) = Infinity; [threat] B(536) = Infinity is not above B(535) = Infinity; [bench] rail 0-0-0 reads HIGH (13.6 vs target 10.0 on SHIP/global); [bench] rail 1-0-0 reads HIGH (14.3 vs target 10.5 on SHIP/global); [bench] rail 5-0-2 reads HIGH (38.0 vs target 25.0 on SHIP/global); [bench] beacon: 13 configs would not pay for themselves on 4 equal towers |
<!-- /gen:checks -->

## 4. Skill expression: the bot sweep

Three bots play every map with several seeds, uncapped (docs/ECONOMY.md 7):

- **novice** buys cheap damage towers at random legal spots near the path and never upgrades past tier 2;
- **solid** buys the purchase with the best marginal defensive value per credit (new towers, upgrades, Beacons, slowing fields), saves for big upgrades and fires abilities;
- **eco** is solid plus Mining Rigs early and vault withdrawals.

Solid also runs with each Commander. Targets: novice loses between waves 25 and 55; solid reaches 70 to 110; eco at least as far as solid; nobody past 160; Cadet >= Pilot >= Veteran >= Nightmare.

![Survival waves per bot per map](balance/survival.svg)

### Waves reached on Pilot (generated)
<!-- gen:survival -->
| Bot | Crater Basin | Frostline | Orbital Dock | Ember Rift | Prism Fields | All |
|---|---|---|---|---|---|---|
| novice | 42 (42, 42, 42) | 26 (26, 33) | 22 (22, 27) | 19 (19, 42) | 28 (28, 33) | 33 |
| solid | 99 (99, 104) | 104 (104, 106) | 106 (106, 106) | 99 (99) | 106 (106) | 104 |
| solid+brick | 99 (99, 104) | 99 (99, 99) | 105 (105, 106) | 99 (99) | - | 99 |
| solid+nova | 99 (99) | 105 (105) | 105 (105, 106) | 99 (99) | - | 105 |
| solid+vega | 104 (104) | - | 105 (105, 106) | 99 (99) | 108 (108) | 105 |
| eco | 99 (99, 99) | 99 (99) | 99 (99, 105) | 104 (104) | 108 (108) | 99 |

Median wave cleared (every seed in brackets). 43 runs; the furthest cleared wave 108; 10 of 32 solid and eco runs ended on a Storm Titan leak, the rest on Core Integrity.
<!-- /gen:survival -->

### Difficulty (generated)
<!-- gen:difficulty -->
_(no difficulty runs in the sweep)_
<!-- /gen:difficulty -->

Nightmare has one point of Core Integrity, so the first leak of any size ends the run; the bots build with extra headroom there (a careful player would), and the result depends mostly on whether the opening holds without a single leak.

### Late-game tower mix (generated)
The solid bot's final defense, as the share of credits invested per tower type. No type may hold more than half.

<!-- gen:mix -->
| Map | Towers at the end (median) | Share of credits invested, by tower (median over seeds) |
|---|---|---|
| Crater Basin | 104 | Rail Sniper 46%, Laser Array 10%, Tesla Coil 8%, Orbital Mortar 7%, Command Beacon 5%, Pulse Turret 5%, Drone Bay 3%, Scatter Pod 2% |
| Frostline | 100 | Rail Sniper 47%, Laser Array 13%, Command Beacon 11%, Pulse Turret 8%, Tesla Coil 5%, Orbital Mortar 3%, Scatter Pod 2%, Drone Bay 1%, Gravity Well 1% |
| Orbital Dock | 102 | Rail Sniper 45%, Pulse Turret 11%, Command Beacon 10%, Orbital Mortar 8%, Laser Array 8%, Tesla Coil 7%, Scatter Pod 3%, Gravity Well 1%, Drone Bay 1% |
| Ember Rift | 113 | Rail Sniper 52%, Pulse Turret 12%, Tesla Coil 12%, Laser Array 10%, Orbital Mortar 5%, Scatter Pod 3%, Command Beacon 2%, Gravity Well 2%, Cryo Emitter 1% |
| Prism Fields | 130 | Rail Sniper 46%, Pulse Turret 12%, Laser Array 10%, Drone Bay 8%, Command Beacon 6%, Tesla Coil 6%, Cryo Emitter 4%, Scatter Pod 4%, Orbital Mortar 3%, Gravity Well 2% |
<!-- /gen:mix -->

## 5. What this balance pass changed, and why

| Problem found in QA | Cause | Fix |
|---|---|---|
| Ember Rift ended every bot run before wave 25 | two separate lanes split a young defense in half from wave 1 | longer lanes, the east lane opens gradually (waves 10 to 20), spawns 40% slower up to wave 35 (docs/ECONOMY.md 4.7) |
| The wave 50 Specter ended runs on one leak (816 Integrity) | full-size debut of a Phantom ship immune to KINETIC and BLAST | a scout debut: empty hold, 80 HP hull, 80 Integrity if it leaks, with a warning on wave 49 and a tip naming the counter; slower (2.2) |
| Novices died at the first Iron wave | eight Iron at once on wave 16 | two Iron on wave 16 (22 Integrity if both leak), Iron ramps from wave 17 |
| Strong play reached waves 139 to 154 | late income and tower power outgrew the old surge | `c(w)` falls as `w^-3`, the surge starts at wave 65 and is steeper, a ship stops a penetrating Rail slug, Siege Rail deals 150 to ships (was 200) |
| Every strong run then died on the wave 100 Titan | the Titan hull tracked the full surge (1.57 x B(100) in one target) | the Titan follows the square root of the surge; it is a check some defenses fail, not a wall |
| Rails held over half of every late defense | global range applies ship damage over the whole channel, and a slug went through a whole stack of ships | the ship stop, the Siege Rail trim, and bench grading of global towers at 0.7 x target on SHIP |
| Vault interest was not scaled by `c(w)` | engine | interest is `min(balance, cap) x rate x c(w)` |
| Massed stuns stalled Titans past the wave timeout | no diminishing returns on ship stuns | 1 s stun immunity after a ship stun, stuns never extend a running one |
| Titans took full-strength slows | engine | slows are half as strong on Titans, like stuns; descriptions say so |
| Nightmare bots died on wave 2 to 4 | a 1-life run cannot learn from its first leak | the bots add headroom when Core Integrity is tiny (tools/headless.mjs); the economy is unchanged |

Tower-level tuning (prices, damage, descriptions) was done per tower before this pass; docs/BENCH.md 7 has the current bench table.

## 6. Reproducing and extending

- `node tools/balance.mjs` runs sections 1 to 4 and grades the cached sweep; add `--sweep` to rerun the bots (the plan is `SWEEP_PLAN` at the top of the file), `--quick` for short bench windows, `--only arbitrage,passive,threat,bench,sweep` to pick sections.
- `node tools/balance-report.mjs` regenerates `docs/balance/threat.svg`, `survival.svg`, `efficiency.svg` and the generated tables above from `out/balance/report.json` and `out/balance/sweep.jsonl`.
- When a constant in `src/data/economy.js` changes, update docs/ECONOMY.md, rerun both commands and commit the regenerated document.
