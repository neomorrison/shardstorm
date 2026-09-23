// Tower registry. Pure.
// TOWER_ORDER is the shop order (docs/DESIGN.md section 5). Every tower has a file.

import pulse from './pulse.js';
import scatter from './scatter.js';
import rail from './rail.js';
import missile from './missile.js';
import cryo from './cryo.js';
import tesla from './tesla.js';
import laser from './laser.js';
import drone from './drone.js';
import mortar from './mortar.js';
import gravity from './gravity.js';
import rig from './rig.js';       // id must stay 'rig' (Rig cap, no discounts)
import beacon from './beacon.js'; // id must stay 'beacon' (no discounts)

export const TOWER_ORDER = ['pulse', 'scatter', 'rail', 'missile', 'cryo', 'tesla', 'laser', 'drone', 'mortar', 'gravity', 'rig', 'beacon'];

export const TOWERS = { pulse, scatter, rail, missile, cryo, tesla, laser, drone, mortar, gravity, rig, beacon };

// Registered towers in shop order.
export const TOWER_LIST = TOWER_ORDER.filter((id) => TOWERS[id]);

// Tower ids that never receive discounts (docs/ECONOMY.md 2.2).
export const NO_DISCOUNT = ['rig', 'beacon'];
