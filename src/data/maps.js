// Map definitions (docs/DESIGN.md section 7). World is 1500 x 1000.
// paths: one or more control-point polylines from spawn (off-screen) to the Core.
// The engine smooths them with Catmull-Rom and samples them by arc length.
// Every path of a map ends at the same Core point. tools/mapcheck.mjs validates this file.

export const MAPS = {
  crater: {
    id: 'crater',
    name: 'Crater Basin',
    difficulty: 'Beginner',
    order: 1,
    background: 'map_crater',
    palette: { ground: '#3b4356', ground2: '#2a303e', channel: '#141925', edge: '#6ee7ff', glow: 'rgba(110,231,255,0.30)', accent: '#ffb347' },
    pathWidth: 56,
    lanes: 'single',
    paths: [[
      [-80, 170], [150, 170], [300, 190], [390, 300], [360, 440], [220, 520], [150, 660], [220, 820],
      [400, 880], [580, 820], [640, 660], [620, 500], [700, 350], [860, 280], [1030, 320], [1100, 470],
      [1040, 640], [1080, 800], [1230, 870], [1370, 800], [1400, 640], [1330, 480], [1350, 330], [1330, 190],
    ]],
    core: { x: 1330, y: 190 },
    blockers: [
      { x: 505, y: 520, r: 62, kind: 'crater' },
      { x: 880, y: 610, r: 70, kind: 'crater' },
      { x: 1180, y: 250, r: 48, kind: 'crater' },
      { x: 90, y: 900, r: 55, kind: 'rock' },
    ],
    props: [],
  },

  frost: {
    id: 'frost',
    name: 'Frostline',
    difficulty: 'Intermediate',
    order: 2,
    background: 'map_frost',
    palette: { ground: '#274257', ground2: '#152633', channel: '#0c1822', edge: '#7ee8ff', glow: 'rgba(126,232,255,0.30)', accent: '#dff6ff' },
    pathWidth: 56,
    lanes: 'single',
    paths: [[
      [-80, 480], [150, 460], [270, 400], [410, 500], [620, 440],
      [900, 410], [1180, 350], [1360, 500], [1300, 730], [1000, 850], [750, 790],
      [560, 650], [460, 810], [650, 900],
    ]],
    core: { x: 650, y: 900 },
    blockers: [
      { x: 950, y: 620, r: 55, kind: 'ice' },
      { x: 1000, y: 220, r: 45, kind: 'rock' },
      { x: 180, y: 700, r: 44, kind: 'ice' },
      { x: 800, y: 550, r: 40, kind: 'rock' },
    ],
    props: [],
  },

  dock: {
    id: 'dock',
    name: 'Orbital Dock',
    difficulty: 'Intermediate',
    order: 3,
    background: 'map_dock',
    palette: { ground: '#3a4650', ground2: '#242d34', channel: '#12171b', edge: '#8fd0c9', glow: 'rgba(143,208,201,0.28)', accent: '#f4d35e' },
    pathWidth: 56,
    lanes: 'merge',
    // two lanes until the merge split a young defense: early waves arrive 20% slower (Sim.paceAt)
    pace: { mult: 1.2, until: 30, fade: 10 },
    paths: [
      [[-80, 150], [150, 140], [360, 220], [200, 360], [430, 420], [660, 280], [500, 130], [760, 100], [970, 210], [810, 390], [750, 520],
        [950, 480], [1120, 540], [1300, 470], [1420, 500]],
      [[300, 1080], [150, 880], [360, 800], [200, 660], [430, 600], [660, 740], [500, 890], [760, 920], [970, 810], [810, 630], [750, 520],
        [950, 480], [1120, 540], [1300, 470], [1420, 500]],
    ],
    core: { x: 1420, y: 500 },
    blockers: [
      { x: 150, y: 500, r: 44, kind: 'container' },
      { x: 1150, y: 150, r: 44, kind: 'container' },
      { x: 1270, y: 800, r: 44, kind: 'container' },
      { x: 1150, y: 640, r: 44, kind: 'rock' },
      { x: 500, y: 700, r: 32, kind: 'container' },
    ],
    props: [],
  },

  ember: {
    id: 'ember',
    name: 'Ember Rift',
    difficulty: 'Advanced',
    order: 4,
    background: 'map_ember',
    palette: { ground: '#3a1d18', ground2: '#24110e', channel: '#160a08', edge: '#ff7a3c', glow: 'rgba(255,122,60,0.30)', accent: '#ffb14e' },
    pathWidth: 56,
    lanes: 'alternate',
    // two separate lanes split every defense: waves up to 35 arrive 40% slower (Sim.paceAt)
    pace: { mult: 1.4, until: 35, fade: 10 },
    // The east rift opens gradually: every spawn uses the west lane before wave 10, then the
    // east lane's share ramps to an even split by wave 20 (Sim._rampLanes).
    laneOpen: { wave: 10, full: 20, tip: 'The east rift is opening: meteors now arrive from both edges. Build a second defense.' },
    paths: [
      [[-146,100], [102,90], [329,176], [156,327], [404,392], [653,241], [480,79], [765,65], [988,120], [1150,150], [1230,300], [1080,380], [900,360], [750,500]],
      [[1646,900], [1398,910], [1171,824], [1344,673], [1096,608], [847,759], [1020,921], [735,935], [512,880], [350,850], [270,700], [420,620], [600,640], [750,500]],
    ],
    core: { x: 750, y: 500 },
    blockers: [
      { x: 1340, y: 340, r: 46, kind: 'vent' },
      { x: 160, y: 660, r: 46, kind: 'vent' },
      { x: 1390, y: 110, r: 40, kind: 'rock' },
      { x: 110, y: 890, r: 40, kind: 'rock' },
    ],
    props: [],
  },

  prism: {
    id: 'prism',
    name: 'Prism Fields',
    difficulty: 'Expert',
    order: 5,
    background: 'map_prism',
    palette: { ground: '#2a1f45', ground2: '#19122c', channel: '#0e0a1c', edge: '#e06bff', glow: 'rgba(224,107,255,0.30)', accent: '#7cf7ff' },
    pathWidth: 56,
    lanes: 'single',
    crossings: 1,
    paths: [[
      [750, 1080], [750, 900], [750, 750], [560, 690], [430, 540], [510, 380],
      [700, 300], [900, 375], [955, 560], [835, 715], [700, 815], [510, 890],
    ]],
    core: { x: 510, y: 890 },
    blockers: [
      { x: 950, y: 220, r: 42, kind: 'crystal' },
      { x: 250, y: 700, r: 44, kind: 'crystal' },
      { x: 1080, y: 640, r: 40, kind: 'crystal' },
    ],
    props: [],
  },
};

export const MAP_ORDER = ['crater', 'frost', 'dock', 'ember', 'prism'];
