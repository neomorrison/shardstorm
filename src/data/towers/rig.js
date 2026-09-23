// Mining Rig: income tower, no attack. Pure data.
// Prices follow docs/ECONOMY.md 2.4 for base b = 1000:
//   T1 400..1200, T2 800..2500, T3 2000..8000, T4 8000..30000, T5 40000..150000.
//
// Economy contract (docs/ECONOMY.md 1.3, proved by out/rig-econ.mjs for all 64 crosspaths):
//   P = totalCost / perWave >= 8 at c = 1 for every legal combination, and still >= 8 when the
//   maximum vault interest, the Trade Hub bonus (9 maxed Rigs) and a measured Refinery estimate
//   at waves 30 and 40 are counted. Refinery income grows with the storm like bounty does (it is
//   at most +25% of the bounty of shells destroyed nearby), so C-heavy combos dip lower later.
// Every income field is additive per upgrade, so each crosspath is a mediant of its parts.
//
// stats.income (docs/ARCHITECTURE.md 5.6): the engine pays perWave x c(w) at wave clear (into
// the vault when there is one), caps Rigs at 10 and never discounts them. Refinery bonuses are
// paid by the engine on every pop inside the radius (best k wins, never stacks).

const inc = (s) => s.income;
const ore = (s, n) => { s.income.perWave += n; };

function setVault(s, rate, cap) {
  s.income.vault = { rate, cap };
}

function setRefinery(s, k, radius) {
  s.income.refinery = { k, radius };
  s.range = radius; // the selection ring shows the collection radius
  if (!s.attacks.ops) s.attacks.ops = { ...OPS };
}

// Trade Hub: the share of every other Rig's ore income that the Hub pays out each wave.
export const TRADE_HUB_BOOST = 0.1;

// Passive bookkeeping for Refinery rigs, run every tick by the engine as a custom attack:
//  - shows Refinery earnings as floating credits (the engine pays them silently per pop);
//  - on the Trade Hub, keeps perWave = own ore + 10% of every other Rig's ore.
// It never changes cash itself, so saves and replays stay identical.
function opsUpdate(sim, t, a, dt) {
  const base = t.baseStats && t.baseStats.income;
  const cur = t.stats.income;
  if (!base || !cur) return;
  const d = t.data;

  // Trade Hub bonus (only one Trade Hub can exist, so it never stacks).
  if (base.hubBoost > 0) {
    let others = 0;
    const towers = sim.state.towers;
    for (let i = 0; i < towers.length; i++) {
      const o = towers[i];
      if (o === t || o.type !== 'rig' || !o.baseStats || !o.baseStats.income) continue;
      const oi = o.baseStats.income;
      others += oi.ownPerWave !== undefined ? oi.ownPerWave : (oi.perWave || 0);
    }
    const bonus = others * base.hubBoost;
    const pw = base.ownPerWave + bonus;
    base.perWave = pw; // survives buff recomputes (stats are cloned from baseStats)
    cur.perWave = pw;
    d.hubBonus = bonus;
  }

  // Refinery floating credits. Wave payouts and vault withdrawals also raise cashEarned; they
  // are detected (a wave left the active list, or the vault balance changed) and skipped.
  if (!base.refinery) return;
  const st = sim.state;
  let sig = st.activeWaves.length * 1e6;
  for (let i = 0; i < st.activeWaves.length; i++) sig += st.activeWaves[i].wave;
  const v = d.vault || 0;
  if (d._refE === undefined || d._refSig !== sig || d._refV !== v) {
    d._refE = t.cashEarned; d._refSig = sig; d._refV = v;
  } else if (t.cashEarned > d._refE) {
    d._refAcc = (d._refAcc || 0) + (t.cashEarned - d._refE);
    d._refE = t.cashEarned;
  }
  d._refT = (d._refT || 0) + dt;
  if (d._refT >= 1.25) {
    d._refT = 0;
    const whole = Math.floor(d._refAcc || 0);
    if (whole >= 1) {
      d._refAcc -= whole;
      sim.emit({ t: 'cash', amount: whole, x: t.x, y: t.y - 16, reason: 'refinery', tower: t.id });
      // Crystal Refinery and up: a small gold collection ring on every payout
      if (base.refinery.k >= 0.15) sim.emit({ t: 'pulse', tower: t.id, type: 'rig', x: t.x, y: t.y, r: 46, color: '#ffd76a', visual: 'refinery' });
    }
  }
}

const OPS = { kind: 'custom', needsTarget: false, dtype: 'INCOME', cooldown: 1, update: opsUpdate };

export default {
  id: 'rig',
  name: 'Mining Rig',
  hotkey: 'g',
  cost: 1000,
  radius: 24,
  blurb: 'Mines credits at the end of every wave. Up to 10 at once.',
  desc: 'Pays 80 credits at the end of every wave. Ore prices fall after wave 50, so Rig income shrinks with the storm. Up to 10 Mining Rigs can run at once and they are never discounted.',
  art: {
    sprite: 'tower_rig', rotates: false, color: '#f5b82e', accent: '#4aa8ff', shape: 'oct', barrels: 0,
    variant(levels) { return levels[0] >= 3 ? 1 : levels[1] >= 3 ? 2 : levels[2] >= 3 ? 3 : 0; },
  },
  base: {
    range: null,               // no attack; Refinery upgrades set this to the collection radius
    detection: false,
    targetModes: ['first', 'last', 'strong', 'close'],
    attacks: {},
    aura: null,
    income: { perWave: 80, vault: null, refinery: null, supply: null },
    abilities: [],
  },
  paths: [
    {
      name: 'Deep Drill',
      upgrades: [
        { name: 'Diamond Bit', cost: 550, desc: 'Mines 45 more credits per wave.',
          apply(s) { ore(s, 45); } },
        { name: 'Ore Crusher', cost: 1100, desc: 'Mines 95 more credits per wave.',
          apply(s) { ore(s, 95); } },
        { name: 'Deep Shaft', cost: 3000, desc: 'Sinks a second shaft into the bedrock: mines 280 more credits per wave.',
          apply(s) { ore(s, 280); } },
        { name: 'Magma Bore', cost: 11000, desc: 'Bores into the magma layer: mines 1,100 more credits per wave.',
          apply(s) { ore(s, 1100); } },
        { name: 'Core Tap', cost: 58000, desc: 'Taps the moon core itself: mines 6,400 more credits per wave.',
          apply(s) { ore(s, 6400); } },
      ],
    },
    {
      name: 'Vault',
      upgrades: [
        { name: 'Strongbox', cost: 600, desc: 'Banks this Rig\'s income in a vault that earns 4% interest per wave on up to 1,500 stored, withdrawable anytime.',
          apply(s) { setVault(s, 0.04, 1500); } },
        { name: 'Compound Ledger', cost: 1200, desc: 'Vault interest rises to 6% per wave and the vault holds up to 3,000.',
          apply(s) { setVault(s, 0.06, 3000); } },
        { name: 'Orbital Vault', cost: 3200, desc: 'Vault interest rises to 7% per wave, the vault holds 6,000, and the Rig mines 40 more credits per wave.',
          apply(s) { setVault(s, 0.07, 6000); ore(s, 40); } },
        { name: 'Reserve Bank', cost: 12000, desc: 'Vault interest rises to 8% per wave, the vault holds 16,000, and the Rig mines 300 more credits per wave.',
          apply(s) { setVault(s, 0.08, 16000); ore(s, 300); } },
        { name: 'Stellar Exchange', cost: 55000, desc: 'Vault interest rises to 10% per wave on up to 40,000 stored, and the Rig mines 2,400 more credits per wave.',
          apply(s) { setVault(s, 0.1, 40000); ore(s, 2400); } },
      ],
    },
    {
      name: 'Refinery',
      upgrades: [
        { name: 'Ore Sifter', cost: 500, desc: 'Earns 1 credit for every 20 shells destroyed within 150 units, and mines 15 more credits per wave.',
          apply(s) { setRefinery(s, 0.05, 150); ore(s, 15); } },
        { name: 'Smelter', cost: 1000, desc: 'Earns 1 credit for every 10 shells destroyed within 170 units, and mines 40 more credits per wave.',
          apply(s) { setRefinery(s, 0.1, 170); ore(s, 40); } },
        { name: 'Crystal Refinery', cost: 3000, desc: 'Refines shattered crystal: earns 3 credits for every 20 shells destroyed within 200 units, and mines 150 more credits per wave.',
          apply(s) { setRefinery(s, 0.15, 200); ore(s, 150); } },
        { name: 'Ore Exchange', cost: 11000, desc: 'Earns 1 credit for every 5 shells destroyed within 230 units, and mines 800 more credits per wave.',
          apply(s) { setRefinery(s, 0.2, 230); ore(s, 800); } },
        { name: 'Trade Hub', cost: 50000, desc: 'Earns 1 credit for every 4 shells destroyed within 260 units, mines 4,000 more credits per wave, and also pays out 10% of every other Mining Rig\'s ore income.',
          apply(s) {
            setRefinery(s, 0.25, 260);
            ore(s, 4000);
            const i = inc(s);
            i.ownPerWave = i.perWave; // tier 5 applies last, so this is final
            i.hubBoost = TRADE_HUB_BOOST;
          } },
      ],
    },
  ],
};
