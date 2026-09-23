# SHARDSTORM: Game Design

An endless, browser-based tower defense inspired by Bloons TD6. Static site (GitHub Pages), vanilla JS ES modules, Canvas 2D, no build step.

## 1. Theme and fantasy

A moon mining colony sits under a permanent **Shardstorm**: crystal meteors caught in the colony's gravity funnel slide down **gravity channels** (the path) toward the colony **Core**. Every meteor is a layered crystal: crack its outer shell and it **shatters into smaller meteors** of the next lower grade (the Bloons "layer pop" loop, with a satisfying crystal-shatter burst). Later the storm brings alien **ships** (Bloons MOAB-class) that crack open and spill meteors.

You build chunky, colorful sci-fi turrets around the channel. Survive as many waves as you can. There is no final wave; the storm always wins eventually, and the score is the wave you reached.

Tone: bright, playful, readable. Cartoon sci-fi, bold outlines, saturated crystal colors against darker terrain. Juicy feedback on every shatter.

Currency: **credits** (shown as a number with a small crystal glyph, e.g. `◆ 650`). Lives: **Core Integrity**.

## 2. Core loop

1. Build phase: place towers, upgrade, sell. Press **Launch Wave** (or auto-start).
2. Wave phase: meteors spawn at the channel mouth and follow the path to the Core. Towers fire automatically. Each shell destroyed pays credits. Any meteor that reaches the Core deals its remaining **mass** as damage to Core Integrity.
3. Wave cleared: wave bonus paid, Mining Rigs pay out, autosave, next wave.
4. You can place, upgrade and sell during waves too. You can **send the next wave early** once the current wave has finished spawning (Bloons-style), which overlaps waves.

Game over when Core Integrity hits 0. The run's score is the highest wave fully cleared. Records are kept per map and difficulty.

## 3. Damage types and immunities

Every attack has one damage type:

| Type | Sources | Notes |
|---|---|---|
| KINETIC | bullets, shards, rail slugs, drone guns | cannot damage **Iron**; cannot damage **frozen** targets |
| BLAST | missiles, mortar shells, bombs | cannot damage **Magma** |
| THERMAL | lasers, fire, burn | cannot damage **Prism** |
| CRYO | freeze pulses, cryo shots | cannot damage or freeze **Comet**; bosses resist freezing |
| ENERGY | tesla arcs, ball lightning | cannot damage **Prism** |
| VOID | rare, high tier only | damages everything |

**Phantom** (Bloons camo) meteors can only be targeted by towers with **detection**. Area damage (explosions, auras, fields) still hits phantoms it touches.

## 4. Enemy roster

Speeds are multiples of the base speed (90 world units per second). Mass = total hit points including all children (Bloons RBE). Children spawn at the parent's position along the path, slightly spread.

### Meteors (1 HP per shell)
| Id | Name | Speed | Children | Mass | Color |
|---|---|---|---|---|---|
| rust | Rust Shard | 1.0 | none | 1 | red |
| cobalt | Cobalt Shard | 1.4 | 1 rust | 2 | blue |
| jade | Jade Shard | 1.8 | 1 cobalt | 3 | green |
| amber | Amber Shard | 3.2 | 1 jade | 4 | yellow |
| rose | Rose Shard | 3.5 | 1 amber | 5 | pink |

### Special meteors
| Id | Name | Speed | Shell HP | Immune | Children | Mass |
|---|---|---|---|---|---|---|
| iron | Iron Meteor | 1.0 | 1 | KINETIC | 2 rose | 11 |
| magma | Magma Meteor | 1.8 | 1 | BLAST | 2 rose | 11 |
| comet | Comet | 2.0 | 1 | CRYO | 2 rose | 11 |
| prism | Prism Meteor | 3.0 | 1 | ENERGY, THERMAL | 2 rose | 11 |
| geode | Geode | 1.8 | 1 | BLAST, CRYO | 1 magma + 1 comet | 23 |
| aurora | Aurora Meteor | 2.2 | 1 | none | 2 geode | 47 |
| obsidian | Obsidian Heart | 2.5 | 10 | none | 2 aurora | 104 |

### Modifiers (any meteor, shown as overlays)
- **Phantom**: needs detection to be targeted. Children inherit Phantom.
- **Nanite**: regrows. If it has not taken damage for 3 s it regrows one grade (back up toward its original type, never above it). Children inherit Nanite and the original type.
- **Plated**: shell HP doubled (only meaningful on Iron, Obsidian and ships; on 1 HP shells it gives 2 HP). Children do not inherit Plated.

### Ships (Bloons MOAB class)
Ships rotate along the path, show a health bar, cannot be frozen solid (slows at reduced strength), are immune to knockback and instant-kill effects unless an effect says otherwise, and pay $1 for the hull like any shell. Overflow damage does NOT carry into a ship's children.

| Id | Name | Speed | Hull HP | Children | Mass |
|---|---|---|---|---|---|
| hauler | Hauler | 1.0 | 200 | 4 obsidian | 616 |
| warbarge | Warbarge | 0.25 | 700 | 4 hauler | 3164 |
| dreadnought | Dreadnought | 0.18 | 4000 | 4 warbarge | 16656 |
| specter | Specter | 2.2 | 400 | 4 obsidian (phantom, nanite) | 816 |
| worldbreaker | Worldbreaker | 0.18 | 20000 | 2 dreadnought + 3 specter | 55760 |

Specter: Phantom, immune to KINETIC and BLAST. Its first appearance (wave 50) is a **scout**: an empty hold and a fifth of the hull (80 HP), so a first leak costs 80 Integrity and teaches the counter (docs/ECONOMY.md 4.8).

### Storm Titans (boss waves)
Every 20th wave (20, 40, 60, ...) includes a **Storm Titan**: a unique ship with a big health bar at the top of the screen, a name banner, and one special trait. Titan tier = wave / 20. Hull HP = `0.7 x sqrt(tier) x B(w)`, rising with only the square root of the late surge (docs/ECONOMY.md 4.6: about 410 at wave 20, 2.8k at 40, 12.8k at 60, 73k at 80, 1.3M at 100), speed 0.2. Leaking a Titan ends the game. Types rotate:
- **Maw** (wave 20, 80, 140...): periodically spits meteors behind itself (grade scales with tier).
- **Aegis** (wave 40, 100, 160...): a regenerating shield (25% of hull); KINETIC hits deal only 20% of their damage to it, other types full damage; the shield restores after 8 s without being hit.
- **Rift** (wave 60, 120, 180...): at 75/50/25% hull it blinks 250 units forward along the path and briefly emits a pulse that stuns towers within 150 units for 1.5 s.

## 5. Towers

Twelve towers. Each has **3 upgrade paths x 5 tiers**. Bloons crosspath rule: only one path may go above tier 2, and at most two paths may have any upgrades (e.g. 5-2-0, 0-2-4, 2-0-3 are legal; 3-3-0 and 1-1-1 are not). Only **one of each tier 5 upgrade** may exist at a time per game.

Every tower has four targeting modes: **First, Last, Strong, Close** (plus tower-specific ones where noted). Towers without detection cannot target Phantoms.

Hotkeys in brackets. Base costs are for the Pilot (normal) difficulty.

| # | Tower | Key | Base | Role | Damage | Path A | Path B | Path C |
|---|---|---|---|---|---|---|---|---|
| 1 | **Pulse Turret** | Q | 200 | cheap single target | KINETIC | Penetrator (pierce; T5 Starlance) | Cyclone (fire rate; T5 Hurricane Array, ability) | Marksman (range, crits, detection; T5 Deadeye Prime) |
| 2 | **Scatter Pod** | W | 280 | short range radial shards | KINETIC | Blade Ring (more shards, rate; T5 Maelstrom) | Thermal Core (converts to THERMAL fire ring, burn; T5 Solar Flare) | Cluster Shards (splitting shards, range; T5 Shatterstorm) |
| 3 | **Rail Sniper** | E | 350 | global range hitscan | KINETIC | Penetrator (damage; T2 hits Iron; T5 Planet Cracker) | Suppression (shrapnel, boss stun, brittle; T5 Warden) | Logistics (fire rate; T4 supply drops of credits; T5 Quartermaster) |
| 4 | **Missile Pod** | R | 460 | splash | BLAST | Heavy Ordnance (radius, damage; T5 Nova Warhead) | Cluster (sub-munitions; T5 Carpet Barrage) | Hunter-Killer (homing, ship damage; T5 Titan Breaker) |
| 5 | **Cryo Emitter** | T | 450 | freeze pulse aura | CRYO | Deep Freeze (freeze duration, radius; T5 Absolute Zero, ability) | Embrittle (frozen take extra damage, shatter; T5 Glass Storm) | Cryo Lance (targeted cryo bolts, ship slows; T5 Frost Titan) |
| 6 | **Tesla Coil** | Y | 600 | chain lightning | ENERGY | Chain (more jumps; T5 Storm Crown) | Ball Lightning (slow piercing orbs; T5 Plasma Tempest) | Overload (heavy single zaps, ship stun; T5 Zeus Array) |
| 7 | **Laser Array** | A | 1100 | continuous beam that ramps on one target | THERMAL | Prism Split (beam forks to more targets; T5 Rainbow Lattice) | Focus (ramp speed and cap; T5 Sunspear) | Plasma (T3 switches to VOID; T5 Singularity Lance) |
| 8 | **Drone Bay** | S | 800 | mobile drones hunt within a large radius | KINETIC | Swarm (more drones; T5 Hive Carrier) | Bomber (missile drones, BLAST; T5 Strike Wing, ability) | Tractor (drones drag meteors back, then ships; T5 Gravity Hauler) |
| 9 | **Orbital Mortar** | D | 650 | shells a chosen point anywhere | BLAST | Big Shell (radius, damage; T5 Doomsday Battery) | Incendiary (burn; T5 Firestorm) | Rapid (rate, shock stun; T5 Barrage Command, ability) |
| 10 | **Gravity Well** | F | 400 | slowing field | none / ENERGY | Crusher (damage in field; T5 Event Horizon, ability) | Undertow (pulls meteors backwards; T5 Rewind Field) | Lens (exposes: strips Phantom, +damage taken; T5 Quantum Lens) |
| 11 | **Mining Rig** | G | 1000 | income | n/a | Deep Drill (more ore per wave; T5 Core Tap) | Vault (stores income with capped interest; T5 Stellar Exchange) | Refinery (bonus credits from meteors destroyed nearby; T5 Trade Hub) |
| 12 | **Command Beacon** | H | 900 | support aura | n/a | Radar (detection, range buff; T5 Omniscient Array) | Overclock (attack speed, pierce buffs; T5 War Council, ability) | Supply (discounts 5/10/15%, non-stacking, never on Rigs or Beacons; T4 lets towers in radius hit Iron and Magma; T5 Command Nexus) |

Tower design principles (for upgrade authors):
- Each path has a clear identity and a visible payoff at T3 and a game-changing T5.
- Tier 4 or 5 on some paths grants an **activated ability** with a cooldown (Bloons style). Each tower has at most one ability per path.
- Upgrades that change damage type or add detection must say so in the description.
- Descriptions are short, concrete and player-facing: "Fires 3 bolts per shot." not "Improves firepower."
- All numbers follow docs/ECONOMY.md.

## 6. Commanders (heroes)

One Commander per game, chosen before the match, placed like a tower (limit 1). Commanders level from 1 to 20 automatically with XP earned from waves cleared and mass destroyed. Each level improves stats; abilities unlock at levels 3 and 10 and upgrade at 16 and 20.

1. **Captain Vega** ($550): all-rounder with a pulse rifle (KINETIC). L3 ability "Overcharge" (towers in range fire 50% faster for 8 s), L10 "Orbital Salvo" (bombards the strongest ships).
2. **Nova** ($700): energy support. Buffs nearby tower range; arcs ENERGY. L3 "EMP Burst" (stuns meteors, slows ships), L10 "Supernova" (massive radial ENERGY burst).
3. **Brick** ($800): heavy mech, BLAST cannon, strong vs ships. L3 "Rocket Barrage", L10 "Titan Punch" (huge single hit on the strongest ship).

## 7. Maps

World coordinates are 1500 x 1000. Each map has one or more path polylines (smoothed), a spawn portal off the edge, the Core at the end, and a few **blockers** (circles) where towers cannot be placed.

| Id | Name | Difficulty | Layout |
|---|---|---|---|
| crater | Crater Basin | Beginner | one long winding channel |
| frost | Frostline | Intermediate | one path with a large loop that passes the center twice |
| dock | Orbital Dock | Intermediate | two lanes that merge halfway |
| ember | Ember Rift | Advanced | two separate lanes from opposite edges, waves alternate groups between them |
| prism | Prism Fields | Expert | short path that crosses itself |

## 8. Difficulty

| Difficulty | Tower and upgrade cost | Core Integrity | Starting credits | Sell refund |
|---|---|---|---|---|
| Cadet | x0.85 | 200 | 650 | 70% |
| Pilot | x1.00 | 150 | 650 | 70% |
| Veteran | x1.08 | 100 | 650 | 70% |
| Nightmare | x1.20 | 1 | 650 | 70% |

Costs after multipliers round to the nearest 5.

## 9. Presentation and feel

- Crystal shatter particles in the meteor's color on every pop; ships break apart into hull chunks; Titans get a camera shake and a slow-motion flash on death.
- Floating "+credits" text is optional (setting). Screen shake is optional (setting).
- Ranges shown on hover and while placing. Invalid placement shows red.
- Channel (path) is drawn over terrain art as a luminous gravity channel with animated chevrons flowing toward the Core.
- Tier pips under each tower; the tower sprite changes look at tier 3+ per path.
- Speed control: 1x, 2x, 3x. Pause. Auto-start toggle.
- Next wave preview strip shows icons for the enemy types in the upcoming wave.
- Tower stats panel: pops (shells destroyed), damage dealt, credits earned (rigs), targeting, sell value.
- Audio: synthesized WebAudio sound effects (shoot, shatter, explosions, zaps, leak alarm, wave start, upgrade, sell, boss horn) and a lightweight generative ambient music loop. Volume sliders.
- Mobile: touch placement with a confirm button, sidebar collapses to a bottom drawer.
- Codex screen: every enemy (properties, immunities) and every tower (all 15 upgrades with costs).

## 10. Persistence

localStorage, every access in try/catch:
- Settings (volumes, auto-start, particles, shake, damage numbers).
- Records: best wave per map and difficulty, total waves cleared, total shells shattered.
- Autosave of the current run at every build phase (the field is empty then, so the save is towers + economy + wave + RNG state). "Continue" button on the title screen.

## 11. Copy style

User-facing text never uses em dashes. Use periods, commas, colons or parentheses. Upgrade names are 1 to 3 words. Descriptions are one sentence, concrete, present tense.
