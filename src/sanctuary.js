import { GRID } from './config.js';

// ============================================================
// The sanctuary behind the battlefield — single source of truth
// for its layout, shared by the sim (spawns, collision, match
// gating), the renderer (set dressing, NPCs) and the UI.
//
// The battlefield (grid + crystal) sits on a raised plateau at
// y = 0; the sanctuary floor lies ELEV below it, reached by two
// full-width flights of stairs just south of the crystal. New
// players arrive through a portal at the far south end and walk
// the whole plaza, past the fountain and the NPCs, up the stairs
// and through the colonnade beside the crystal onto the field.
// ============================================================

const { COLS, ROWS, CELL, CRYSTAL } = GRID;
const HALF_H = (ROWS * CELL) / 2;

// how far the sanctuary floor sits BELOW the battlefield plateau
// ("two floors", measured in grid-obstacle heights)
export const ELEV = 2.4;

// two flights of stairs spanning the plaza's full width, with a
// landing between them (z ranges run south from the board edge)
export const STAIRS = {
  TOP: HALF_H,          // the board's south edge
  FLIGHT: 2.0,          // depth of each flight
  LANDING: 1.4,         // depth of the mid landing
  STEPS: 4,             // steps per flight
  STEP_H: ELEV / 8,     // tread drop per step (4 steps × 2 flights)
};
STAIRS.BOTTOM = STAIRS.TOP + STAIRS.FLIGHT * 2 + STAIRS.LANDING;

// the sanctuary plaza: same width as before, but stretched much
// deeper south to fit the stairs, fountain, NPCs and the portal
export const PLAZA = { HALF_W: 8, DEPTH: 24 };
const PZ = HALF_H; // plaza z reference (board edge)

// ground height at a world z — 0 on the board/plateau, -ELEV on the
// sanctuary floor, ramping down the two flights between them. The
// stairs span the full width, so height only depends on z.
export function terrainY(z) {
  if (z <= STAIRS.TOP) return 0;
  const f1End = STAIRS.TOP + STAIRS.FLIGHT;
  if (z <= f1End) return -((z - STAIRS.TOP) / STAIRS.FLIGHT) * (ELEV / 2);
  const landEnd = f1End + STAIRS.LANDING;
  if (z <= landEnd) return -ELEV / 2;
  if (z <= STAIRS.BOTTOM) {
    return -ELEV / 2 - ((z - landEnd) / STAIRS.FLIGHT) * (ELEV / 2);
  }
  return -ELEV;
}

// where new players arrive (far south end of the sanctuary), and the
// round portal plane that flares open under them
export const PORTAL = { x: 0, z: PZ + PLAZA.DEPTH - 2.6, r: 1.7 };

// the fountain at the heart of the plaza — standing straight on the
// paving, no pedestal
export const FOUNTAIN = { x: 0, z: PZ + 12.6, r: 1.9 };

// a player counts as "crossed to the battlefield" once they are north
// of the crystal row — required from EVERYONE before the match starts
export const CROSS_Z = (CRYSTAL.r - (ROWS - 1) / 2) * CELL - CELL / 2;

// ---- the colonnade on the crystal's row --------------------------
// Only ONE open tile on each side of the crystal (its immediate
// neighbours); every other cell of the row carries a pillar — except
// the middle of each side, which carries a statue staring straight
// north at the woods the monsters march out of. All of them are
// permanently blocked for walking, building and pathing.
export const PILLAR_CELLS = [];
export const STATUE_CELLS = [];
{
  const lMid = Math.round((CRYSTAL.c - 2) / 2);
  const rMid = Math.round((CRYSTAL.c + 2 + COLS - 1) / 2);
  for (let c = 0; c < COLS; c++) {
    if (Math.abs(c - CRYSTAL.c) <= 1) continue; // crystal + the two passages
    (c === lMid || c === rMid ? STATUE_CELLS : PILLAR_CELLS)
      .push({ c, r: CRYSTAL.r });
  }
}
export const BLOCKED_CELLS = [...PILLAR_CELLS, ...STATUE_CELLS];

// ---- inhabitants -------------------------------------------------
// Every NPC faces roughly toward the portal (south, +z) so arriving
// players read them front-on. x/z are sanctuary-floor positions.
export const NPCS = {
  // vendors moved to the far corners so the plaza floor stays roomy
  pets:      { name: 'Tonho', x: 5.4,  z: PZ + 17.2, yaw: 0 },
  weapons:   { name: 'Baru',  x: -5.4, z: PZ + 17.2, yaw: 0 },
  // the friendly guide by the fountain who explains the game
  duvidas:   { name: 'Théo',  x: 1.9,  z: PZ + 14.8, yaw: 0.16 },
  // the cheerleader near the stairs, always shouting encouragement
  incentivo: { name: 'Nina',  x: -1.3, z: PZ + 6.6,  yaw: 0.12 },
  // the sanctuary cleric (future blessings vendor)
  blessings: { name: 'Iris',  x: -6.2, z: PZ + 9.6,  yaw: 0.48 },
  // the drill master with his target dummies (training mode)
  treino:    { name: 'Rocha', x: 6.2,  z: PZ + 9.6,  yaw: -0.48 },
};

// ambient dwellers pottering about (pure set dressing)
export const AMBIENT_NPCS = [
  { model: 'char-mage', name: 'Mira', tint: 0x8fd8c8, x: -2.8, z: PZ + 11.2, yaw: 0.6 },
  { model: 'char-tanker', name: 'Bento', tint: 0xd8b06a, x: 2.9, z: PZ + 7.4, yaw: -0.35 },
];

// training dummies flanking Rocha
export const DUMMIES = [
  { x: 7.35, z: PZ + 8.3 },
  { x: 7.35, z: PZ + 10.9 },
];
// wander farther than this from Rocha and training mode ends itself
export const TRAIN = { RADIUS: 11 };

// plaza dressing shared between visuals and collision
export const PLAZA_COLUMNS = [];
export const PLAZA_LANTERNS = [];
for (const sx of [-1, 1]) {
  PLAZA_COLUMNS.push({ x: sx * (PLAZA.HALF_W - 0.6), z: STAIRS.BOTTOM + 0.8 });
  PLAZA_COLUMNS.push({ x: sx * (PLAZA.HALF_W - 0.6), z: PZ + PLAZA.DEPTH - 1 });
  PLAZA_LANTERNS.push({ x: sx * 7.0, z: PZ + 8.4 });
  PLAZA_LANTERNS.push({ x: sx * 3.4, z: PZ + 20.8 }); // flanking the portal
}

// static circle colliders on the sanctuary floor (props & NPCs) —
// resolved for players on top of the grid-cell collision, so nobody
// walks through the fountain, the stalls or a dweller
export const SANCT_COLLIDERS = [
  { x: FOUNTAIN.x, z: FOUNTAIN.z, r: FOUNTAIN.r + 0.15 },
  // Tonho's stall canopy (behind him) & Baru's forge wall segments
  { x: NPCS.pets.x, z: NPCS.pets.z - 1.8, r: 1.5 },
  { x: NPCS.weapons.x - 1, z: NPCS.weapons.z - 1.5, r: 1.2 },
  { x: NPCS.weapons.x + 1, z: NPCS.weapons.z - 1.5, r: 1.2 },
  { x: NPCS.weapons.x + 1.15, z: NPCS.weapons.z + 0.35, r: 0.5 }, // anvil
  ...Object.values(NPCS).map((n) => ({ x: n.x, z: n.z, r: 0.55 })),
  ...AMBIENT_NPCS.map((n) => ({ x: n.x, z: n.z, r: 0.5 })),
  ...DUMMIES.map((d) => ({ x: d.x, z: d.z, r: 0.5 })),
  ...PLAZA_COLUMNS.map((c) => ({ x: c.x, z: c.z, r: 0.55 })),
  ...PLAZA_LANTERNS.map((l) => ({ x: l.x, z: l.z, r: 0.35 })),
];
