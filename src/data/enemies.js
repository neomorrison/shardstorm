// Enemy definitions (docs/DESIGN.md section 4). Pure data plus derived stats.
// speed: multiple of BASE_SPEED. hp: shell HP. children: [[type, count], ...].
// childMods: modifiers forced onto children (on top of inherited phantom/nanite).

export const DTYPES = ['KINETIC', 'BLAST', 'THERMAL', 'CRYO', 'ENERGY', 'VOID'];

export const ENEMIES = {
  // Meteors (1 HP per shell)
  rust:   { name: 'Rust Shard',   kind: 'meteor', speed: 1.0, hp: 1, immune: [], children: [],              radius: 10, color: '#ff4d4d' },
  cobalt: { name: 'Cobalt Shard', kind: 'meteor', speed: 1.4, hp: 1, immune: [], children: [['rust', 1]],   radius: 11, color: '#3d8bff' },
  jade:   { name: 'Jade Shard',   kind: 'meteor', speed: 1.8, hp: 1, immune: [], children: [['cobalt', 1]], radius: 12, color: '#2ee37a' },
  amber:  { name: 'Amber Shard',  kind: 'meteor', speed: 3.2, hp: 1, immune: [], children: [['jade', 1]],   radius: 12, color: '#ffd23d' },
  rose:   { name: 'Rose Shard',   kind: 'meteor', speed: 3.5, hp: 1, immune: [], children: [['amber', 1]],  radius: 13, color: '#ff6ec7' },

  // Special meteors
  iron:     { name: 'Iron Meteor',    kind: 'meteor', speed: 1.0, hp: 1,  immune: ['KINETIC'],           children: [['rose', 2]],                 radius: 14, color: '#8a94a6' },
  magma:    { name: 'Magma Meteor',   kind: 'meteor', speed: 1.8, hp: 1,  immune: ['BLAST'],             children: [['rose', 2]],                 radius: 13, color: '#2b1a1a', glow: '#ff6a00' },
  comet:    { name: 'Comet',          kind: 'meteor', speed: 2.0, hp: 1,  immune: ['CRYO'],              children: [['rose', 2]],                 radius: 13, color: '#e8f6ff' },
  prism:    { name: 'Prism Meteor',   kind: 'meteor', speed: 3.0, hp: 1,  immune: ['ENERGY', 'THERMAL'], children: [['rose', 2]],                 radius: 13, color: '#a45bff' },
  geode:    { name: 'Geode',          kind: 'meteor', speed: 1.8, hp: 1,  immune: ['BLAST', 'CRYO'],     children: [['magma', 1], ['comet', 1]],  radius: 15, color: '#5a5f6e', glow: '#9ff' },
  aurora:   { name: 'Aurora Meteor',  kind: 'meteor', speed: 2.2, hp: 1,  immune: [],                    children: [['geode', 2]],                radius: 16, color: '#ffffff', rainbow: true },
  obsidian: { name: 'Obsidian Heart', kind: 'meteor', speed: 2.5, hp: 10, immune: [],                    children: [['aurora', 2]],               radius: 18, color: '#1d1330', glow: '#c77dff' },

  // Ships (MOAB class)
  hauler:       { name: 'Hauler',       kind: 'ship', speed: 1.0,  hp: 200,   immune: [],                   children: [['obsidian', 4]],                    radius: 34, color: '#4f6d8f' },
  warbarge:     { name: 'Warbarge',     kind: 'ship', speed: 0.25, hp: 700,   immune: [],                   children: [['hauler', 4]],                      radius: 44, color: '#8f4f4f' },
  dreadnought:  { name: 'Dreadnought',  kind: 'ship', speed: 0.18, hp: 4000,  immune: [],                   children: [['warbarge', 4]],                    radius: 56, color: '#3f7f5a' },
  specter:      { name: 'Specter',      kind: 'ship', speed: 2.75, hp: 400,   immune: ['KINETIC', 'BLAST'], children: [['obsidian', 4]], phantom: true, childMods: { phantom: true, nanite: true }, radius: 30, color: '#20242c' },
  worldbreaker: { name: 'Worldbreaker', kind: 'ship', speed: 0.18, hp: 20000, immune: [],                   children: [['dreadnought', 2], ['specter', 3]], radius: 70, color: '#2a2d3a' },
};

// Nanite regrow chain: which grade a meteor regrows into (one step up).
export const REGROW_UP = { rust: 'cobalt', cobalt: 'jade', jade: 'amber', amber: 'rose' };
// Grade order used to cap regrowth at the original type for the simple chain.
export const GRADE = { rust: 1, cobalt: 2, jade: 3, amber: 4, rose: 5 };

// Derived stats: mass (total HP incl. children), hullMass (ship hull HP in family tree),
// meteorMass (mass - hullMass), shells (bounty count = number of shells in family tree).
function derive(id, seen = new Set()) {
  const d = ENEMIES[id];
  if (d._derived) return d;
  if (seen.has(id)) throw new Error('enemy cycle at ' + id);
  seen.add(id);
  let mass = d.hp, hull = d.kind === 'ship' ? d.hp : 0, shells = 1;
  for (const [c, n] of d.children) {
    const cd = derive(c, seen);
    mass += n * cd.mass; hull += n * cd.hullMass; shells += n * cd.shells;
  }
  d.id = id;
  d.mass = mass;
  d.hullMass = hull;
  d.meteorMass = mass - hull;
  d.shells = shells;
  d._derived = true;
  return d;
}
for (const id of Object.keys(ENEMIES)) derive(id);

// Mass of an enemy family when every ship hull is multiplied by H and plated doubles the top shell.
export function familyMass(id, hullMult = 1, plated = false) {
  const d = ENEMIES[id];
  const top = d.hp * (d.kind === 'ship' ? hullMult : 1) * (plated ? 2 : 1);
  // children: hull part scaled by H, meteor part unchanged
  let childMass = 0;
  for (const [c, n] of d.children) {
    const cd = ENEMIES[c];
    childMass += n * (cd.hullMass * hullMult + cd.meteorMass);
  }
  return top + childMass;
}
