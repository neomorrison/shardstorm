# SHARDSTORM

An endless tower defense game for the browser, inspired by Bloons TD6.

A moon mining colony sits under a permanent storm of crystal meteors. Every meteor is layered: crack its shell and it shatters into smaller meteors. Build and upgrade turrets along the gravity channels, protect the Core, and see how many waves you can survive. There is no final wave.

**Play:** https://neomorrison.github.io/shardstorm/

## Features

- 12 towers, each with 3 upgrade paths of 5 tiers (Bloons-style crosspathing: one path past tier 2, two paths at most, one of each tier 5 per game)
- Activated abilities on high-tier upgrades
- 3 Commanders that level up during a run
- 17 enemy types: layered crystal meteors, immune types (Iron, Magma, Comet, Prism, Geode), Phantom, Nanite and Plated modifiers, 5 alien ships, and Storm Titan bosses every 20 waves
- 6 damage types with immunities that shape your build
- 5 maps from Beginner to Expert, including two-lane and self-crossing maps
- 4 difficulties
- Endless waves: 40 hand-authored waves, then a deterministic procedural generator
- Autosave between waves, records per map and difficulty, a full Codex
- Works on desktop and mobile. No install, no build step.

## The economy is designed on paper first

Every number follows a written model in [docs/ECONOMY.md](docs/ECONOMY.md):

- Threat per wave `B(w) = 19 x w^0.81 x 1.0514^w x S(w)` tracks Bloons TD6's round mass up to wave 80, then a surge term makes log-threat grow quadratically, so the storm always wins eventually.
- Income is $1 per shell destroyed (dense enemies pay less per hit point), scaled by `c(w)` after wave 50, plus a flat wave bonus.
- Passive income is bounded by construction (Mining Rig cap, capped vault interest), and refunds never exceed what you paid, so there is no money loop.
- Tower cost-efficiency rises with tier on a fixed target curve, measured by a benchmark harness.

`tools/headless.mjs` plays full runs with scripted bots, `tools/wavecheck.mjs` proves the wave generator stays on the threat curve for waves 1 to 200, and `tools/simtest.mjs` checks the engine rules.

## Run locally

```
node tools/serve.mjs
```
Then open http://localhost:8123/. Any static file server works.

Developer tools (Node 20+):
```
node tools/headless.mjs --map crater --bot solid --waves 100
node tools/simtest.mjs
node tools/wavecheck.mjs
node tools/mapcheck.mjs
node tools/snap.mjs --path "/?debug=1&quick=crater" --wait 3000 --shot out/game.png
```

## Tech

Vanilla JavaScript ES modules, Canvas 2D, WebAudio synthesis. The simulation (`src/sim`, `src/data`) is pure and deterministic, so the same code runs in the browser and in Node for testing and balancing. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

Art: key art, the tower, meteor and ship sprite sheets were generated with ChatGPT. Map terrain, Storm Titans, the Core, Commanders, the logo and the 36 tower upgrade looks were generated with Nano Banana (via kie.ai) using the ChatGPT sheets as style references. `tools/art/slice.py` slices the sheets into sprites. Effects, projectiles and the gravity channels are drawn procedurally.
