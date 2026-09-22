// Tower registry. Pure.
//
// TOWER_ORDER lists all twelve tower ids in shop order (docs/DESIGN.md section 5).
// TOWERS only contains towers whose definition file exists. Consumers must skip ids in
// TOWER_ORDER that are not in TOWERS (or use TOWER_LIST, which is already filtered).
//
// HOW TO ADD A TOWER
// 1. Create src/data/towers/<id>.js with `export default { id: '<id>', ... }` (see pulse.js).
// 2. Add an import line below and add the id to the TOWERS object:
//
//      import scatter from './scatter.js';
//      import rail from './rail.js';
//      import cryo from './cryo.js';
//      import tesla from './tesla.js';
//      import laser from './laser.js';
//      import drone from './drone.js';
//      import mortar from './mortar.js';
//      import gravity from './gravity.js';
//      import rig from './rig.js';        // id must be 'rig' (Rig cap, no discounts)
//      import beacon from './beacon.js';  // id must be 'beacon' (no discounts)
//
//      export const TOWERS = { pulse, scatter, rail, missile, cryo, tesla, laser, drone, mortar, gravity, rig, beacon };

import pulse from './pulse.js';
import missile from './missile.js';

export const TOWER_ORDER = ['pulse', 'scatter', 'rail', 'missile', 'cryo', 'tesla', 'laser', 'drone', 'mortar', 'gravity', 'rig', 'beacon'];

export const TOWERS = { pulse, missile };

// Registered towers in shop order.
export const TOWER_LIST = TOWER_ORDER.filter((id) => TOWERS[id]);

// Tower ids that never receive discounts (docs/ECONOMY.md 2.2).
export const NO_DISCOUNT = ['rig', 'beacon'];
