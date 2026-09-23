// Economy: prices (difficulty + Beacon discounts), sell values, wave income (Rigs, vaults,
// supply drops) and refinery bonuses. Pure.
import { priceFor, incomeFactor, SELL_RATE, round5 } from '../data/economy.js';
import { NO_DISCOUNT } from '../data/towers/index.js';

export function discountable(type, def) {
  return NO_DISCOUNT.indexOf(type) < 0 && !(def && def.hero);
}

// Beacon giving the best discount at (x, y) for a purchase of `type` (never Rigs/Beacons/
// Commanders), or null.
export function discountSource(sim, type, x, y, def) {
  if (!discountable(type, def)) return null;
  let best = 0, src = null;
  for (const t of sim.state.towers) {
    const au = t.baseStats && t.baseStats.aura;
    if (!au || !au.discount) continue;
    const dx = t.x - x, dy = t.y - y, r = au.radius || 0;
    if (dx * dx + dy * dy <= r * r && au.discount > best) { best = au.discount; src = t; }
  }
  return src;
}

// Best Beacon discount covering (x, y) for a purchase of `type` (never Rigs/Beacons/Commanders).
export function discountAt(sim, type, x, y, def) {
  const src = discountSource(sim, type, x, y, def);
  return src ? Math.min(src.baseStats.aura.discount, 0.5) : 0;
}

// A discounted purchase spends the Beacon's undo refund: once its discount has been used, the
// Beacon sells for 70% like any tower bought before the last wave. Without this, a Beacon placed
// and undone in the same build phase would hand out its discount for free (docs/BALANCE.md).
export function consumeDiscount(sim, type, x, y, def) {
  const src = discountSource(sim, type, x, y, def);
  if (src && src.undoPaid > 0) { src.undoPaid = 0; src.undoable = false; }
}

export function applyDiscount(price, disc) {
  if (!(disc > 0)) return price;
  return Math.min(price, round5(price * (1 - disc)));
}

export function basePrice(sim, def) {
  return priceFor(def.cost, sim.state.difficulty);
}

export function placePrice(sim, def, x, y) {
  const p = basePrice(sim, def);
  if (x === undefined) return p;
  return applyDiscount(p, discountAt(sim, def.id, x, y, def));
}

export function upgradePrice(sim, tower, cost) {
  const p = priceFor(cost, sim.state.difficulty);
  return applyDiscount(p, discountAt(sim, tower.type, tower.x, tower.y, tower.def));
}

// 70% of what was paid, except purchases made during the current build phase (undo: 100%).
// A Rig's banked vault balance is paid out as well.
export function sellValue(sim, t) {
  const undo = Math.min(t.undoPaid, t.paid);
  const v = undo + Math.floor((t.paid - undo) * SELL_RATE + 1e-9);
  return v + Math.floor((t.data.vault || 0) + 1e-9);
}

function payout(sim, t, amount, reason) {
  if (!(amount > 0)) return;
  const st = sim.state;
  st.cash += amount;
  st.stats.cashEarned += amount;
  t.cashEarned += amount;
  sim.emit({ t: 'cash', amount, x: t.x, y: t.y - 20, reason, tower: t.id });
}

// Wave-clear income from every tower with stats.income (docs 5.6).
export function payWaveIncome(sim, w) {
  const f = incomeFactor(w);
  for (const t of sim.state.towers) {
    const inc = t.stats.income;
    if (!inc) continue;
    const amt = (inc.perWave || 0) * f;
    if (inc.vault) {
      const cap = inc.vault.cap || 0, rate = inc.vault.rate || 0;
      let v = t.data.vault || 0;
      // interest is scaled by c(w) like ore (ECONOMY 1.3), so vault income is bounded by
      // rate x cap x c(w) per wave and falls with the storm after wave C_START
      const interest = Math.min(v, cap) * rate * f;
      v += amt + interest;
      let over = 0;
      if (v > cap) { over = v - cap; payout(sim, t, over, 'rig'); v = cap; }
      t.data.vault = v;
      // `amount` is what stayed in the vault (0 once it is full); any overflow was paid out
      // as a 'cash' event
      if (amt + interest > 0) sim.emit({ t: 'vault', tower: t.id, amount: amt + interest - over, balance: v, x: t.x, y: t.y });
    } else payout(sim, t, amt, 'rig');
    if (inc.supply && inc.supply.drops > 0) {
      const each = (inc.supply.value || 0) * f;
      for (let k = 0; k < inc.supply.drops; k++) payout(sim, t, each, 'supply');
    }
  }
}

export function withdrawVault(sim, t) {
  const v = t.data.vault || 0;
  if (!(v > 0)) return { ok: false, reason: 'Vault is empty' };
  t.data.vault = 0;
  payout(sim, t, v, 'vault');
  return { ok: true, amount: v };
}

// Refinery: best k among Rigs whose radius covers the pop, paid as k x c(w).
export function refineryBonus(sim, x, y, c) {
  const list = sim._refineries;
  if (!list || !list.length) return;
  let best = null, bk = 0;
  for (const t of list) {
    const r = t.stats.income && t.stats.income.refinery;
    if (!r) continue;
    const dx = t.x - x, dy = t.y - y, rad = r.radius || 0;
    if (dx * dx + dy * dy <= rad * rad && r.k > bk) { bk = Math.min(0.25, r.k); best = t; }
  }
  if (best) {
    const amt = bk * c;
    sim.state.cash += amt;
    sim.state.stats.cashEarned += amt;
    best.cashEarned += amt;
  }
}
