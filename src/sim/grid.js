import { GRID } from '../config.js';

// ============================================================
// Grid model: blocked cells, buildability rules, and a BFS
// flow field that always points ground enemies toward the
// crystal along the shortest open path.
// ============================================================

const { COLS, ROWS, CELL, SPAWNS, CRYSTAL, BUILD_ROW_MIN, BUILD_ROW_MAX } = GRID;

export const idx = (c, r) => r * COLS + c;
export const inBounds = (c, r) => c >= 0 && c < COLS && r >= 0 && r < ROWS;

// world <-> grid transforms (grid centered at world origin)
export const cellToWorld = (c, r) => ({
  x: (c - (COLS - 1) / 2) * CELL,
  z: (r - (ROWS - 1) / 2) * CELL,
});
export const worldToCell = (x, z) => ({
  c: Math.round(x / CELL + (COLS - 1) / 2),
  r: Math.round(z / CELL + (ROWS - 1) / 2),
});

export const CRYSTAL_POS = cellToWorld(CRYSTAL.c, CRYSTAL.r);
export const HALF_W = (COLS * CELL) / 2;
export const HALF_H = (ROWS * CELL) / 2;

// sanctuary plaza behind the board's south edge — a paved resting
// spot players can wander into between waves (enemies never path
// there; their goal is the crystal, which lives on the board).
// Deep enough to actually stroll around in during checkpoints.
export const PLAZA = { HALF_W: 8, DEPTH: 13 };

// Jump check: standing at (x,z) facing along yaw, can the character
// vault over a run of consecutive blocked cells (towers/obstacles) and
// land on the free cell right behind them? Facing is quantized to the
// 4 cardinals. Base characters clear exactly ONE cell; the monkey pet
// raises maxCells up to 5. The run ends at the FIRST free cell — gaps
// aren't flown over, you land in them.
// Returns { to: worldPos, over: firstCell, span } or null.
export function canJumpFrom(grid, x, z, yaw, maxCells = 1) {
  const { c, r } = worldToCell(x, z);
  if (!inBounds(c, r)) return null;
  const dx = Math.sin(yaw), dz = Math.cos(yaw);
  const dc = Math.abs(dx) >= Math.abs(dz) ? (dx > 0 ? 1 : -1) : 0;
  const dr = dc === 0 ? (dz > 0 ? 1 : -1) : 0;
  return jumpAlong(grid, c, r, x, z, dc, dr, maxCells);
}

// Core of the vault check for one cardinal step (dc, dr). Shared by the
// facing-based check above and the proximity-based findJump below.
function jumpAlong(grid, c, r, x, z, dc, dr, maxCells) {
  const oc = c + dc, or = r + dr; // first cell being vaulted
  if (!inBounds(oc, or) || !grid.blocked[idx(oc, or)]) return null;
  // must actually be right in front of the vaulted cell
  const ow = cellToWorld(oc, or);
  if (Math.abs(x - ow.x) > CELL * 1.2 || Math.abs(z - ow.z) > CELL * 1.2) return null;
  // walk the run of blocked cells; land on the first free cell after it
  for (let span = 1; span <= maxCells; span++) {
    const lc = c + dc * (span + 1), lr = r + dr * (span + 1); // landing cell
    if (!inBounds(lc, lr)) return null;
    if (grid.blocked[idx(lc, lr)]) continue; // still mid-wall, keep counting
    return { to: cellToWorld(lc, lr), over: { c: oc, r: or }, span };
  }
  return null; // the wall is thicker than this character can clear
}

// the four cardinals with the yaw that points along each — used to pick
// a jump direction from proximity rather than the character's facing
const JUMP_DIRS = [
  { dc: 0, dr: 1, yaw: 0 },
  { dc: 1, dr: 0, yaw: Math.PI / 2 },
  { dc: 0, dr: -1, yaw: Math.PI },
  { dc: -1, dr: 0, yaw: -Math.PI / 2 },
];

// Proximity jump: standing at (x,z), is there ANY adjacent wall we can
// vault, regardless of which way the character is facing? So the hero can
// hop a block just by being next to it while looking at a foe. When
// `preferYaw` is given (the player's movement heading) and several walls
// are jumpable, the one most aligned with it wins. Returns the same shape
// as canJumpFrom plus `yaw` (the cardinal jumped along), or null.
export function findJump(grid, x, z, maxCells = 1, preferYaw = null) {
  const { c, r } = worldToCell(x, z);
  if (!inBounds(c, r)) return null;
  let best = null, bestScore = Infinity;
  for (const d of JUMP_DIRS) {
    const info = jumpAlong(grid, c, r, x, z, d.dc, d.dr, maxCells);
    if (!info) continue;
    if (preferYaw == null) return { ...info, yaw: d.yaw };
    let diff = (d.yaw - preferYaw) % (Math.PI * 2);
    if (diff > Math.PI) diff -= Math.PI * 2;
    if (diff < -Math.PI) diff += Math.PI * 2;
    const score = Math.abs(diff);
    if (score < bestScore) { bestScore = score; best = { ...info, yaw: d.yaw }; }
  }
  return best;
}

// Endpoint of the berserker's dash: march forward along yaw up to
// `cells` grid cells, stopping short of the first blocked cell or the
// edge of the playable area. Used by both the sim and the owning
// client's local prediction, so they agree on where the dash lands.
export function computeDashEnd(grid, x, z, yaw, cells) {
  const dx = Math.sin(yaw), dz = Math.cos(yaw);
  const open = (nx, nz) => {
    if (nx >= -HALF_W + 0.5 && nx <= HALF_W - 0.5 &&
        nz >= -HALF_H + 0.5 && nz <= HALF_H - 0.5) {
      const { c, r } = worldToCell(nx, nz);
      return !grid.blocked[idx(c, r)];
    }
    // sanctuary plaza south of the board is open ground too
    return Math.abs(nx) < PLAZA.HALF_W - 0.5 && nz > 0 && nz <= HALF_H + PLAZA.DEPTH - 0.5;
  };
  const step = 0.2;
  let dist = 0;
  for (let d = step; d <= cells * CELL; d += step) {
    if (!open(x + dx * d, z + dz * d)) break;
    dist = d;
  }
  return { x: x + dx * dist, z: z + dz * dist };
}

// Shortcut check for jumping enemies (vampires): from the cell under
// (x,z), is there a cardinal hop over exactly ONE blocked cell onto a
// free cell that is meaningfully closer to the crystal (by flow dist)?
// minGain is in flow-dist units (an orthogonal step costs 2).
export function enemyJumpShortcut(grid, x, z, minGain) {
  const { c, r } = worldToCell(x, z);
  if (!inBounds(c, r)) return null;
  const here = grid.dist[idx(c, r)];
  if (here === -1) return null;
  let best = null, bestD = here - minGain;
  for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const oc = c + dc, or = r + dr;          // cell being vaulted
    const lc = c + dc * 2, lr = r + dr * 2;  // landing cell
    if (!inBounds(oc, or) || !grid.blocked[idx(oc, or)]) continue;
    if (!grid.isWalkable(lc, lr)) continue;
    const d = grid.dist[idx(lc, lr)];
    if (d === -1 || d > bestD) continue;
    bestD = d;
    best = { to: cellToWorld(lc, lr), over: { c: oc, r: or } };
  }
  return best;
}

const NEIGHBORS4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const NEIGHBORS8 = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [1, 1], [1, -1], [-1, 1], [-1, -1],
];

export class Grid {
  constructor() {
    this.blocked = new Uint8Array(COLS * ROWS);
    this.dist = new Int32Array(COLS * ROWS);
    this.next = new Int32Array(COLS * ROWS); // index of next cell toward crystal, -1 = none/goal
    this.computeFlow();
  }

  isBlocked(c, r) { return !inBounds(c, r) || this.blocked[idx(c, r)] === 1; }
  isWalkable(c, r) { return inBounds(c, r) && this.blocked[idx(c, r)] === 0; }

  isBuildable(c, r) {
    if (!inBounds(c, r)) return false;
    if (r < BUILD_ROW_MIN || r > BUILD_ROW_MAX) return false;
    // keep a small free pocket right in front of the crystal
    if (Math.abs(c - CRYSTAL.c) <= 1 && r >= CRYSTAL.r - 1) return false;
    return !this.blocked[idx(c, r)];
  }

  setBlocked(c, r, v) {
    this.blocked[idx(c, r)] = v ? 1 : 0;
    this.computeFlow();
  }

  // BFS from the crystal over walkable cells. 8-directional but
  // diagonals never cut a blocked corner, so paths look natural.
  computeFlow() {
    const { dist, next, blocked } = this;
    dist.fill(-1);
    next.fill(-1);
    const goal = idx(CRYSTAL.c, CRYSTAL.r);
    dist[goal] = 0;
    const queue = [goal];
    let head = 0;
    while (head < queue.length) {
      const cur = queue[head++];
      const c = cur % COLS, r = (cur / COLS) | 0;
      for (const [dc, dr] of NEIGHBORS8) {
        const nc = c + dc, nr = r + dr;
        if (!inBounds(nc, nr)) continue;
        const ni = idx(nc, nr);
        if (blocked[ni] || dist[ni] !== -1) continue;
        if (dc !== 0 && dr !== 0) {
          // both orthogonal neighbors must be open to pass diagonally
          if (blocked[idx(c + dc, r)] || blocked[idx(c, r + dr)]) continue;
        }
        dist[ni] = dist[cur] + (dc !== 0 && dr !== 0 ? 3 : 2); // cheap ~1.5x diagonal cost
        next[ni] = cur;
        queue.push(ni);
      }
    }
  }

  // Would blocking (c,r) keep the crystal reachable from every spawn
  // and from every listed enemy cell?
  canPlaceAt(c, r, enemyCells = []) {
    if (!this.isBuildable(c, r)) return false;
    this.blocked[idx(c, r)] = 1;
    const ok = this._allReachable(enemyCells);
    this.blocked[idx(c, r)] = 0;
    return ok;
  }

  _allReachable(enemyCells) {
    // BFS from crystal, then check every required cell was reached
    const seen = new Uint8Array(COLS * ROWS);
    const goal = idx(CRYSTAL.c, CRYSTAL.r);
    seen[goal] = 1;
    const queue = [goal];
    let head = 0;
    while (head < queue.length) {
      const cur = queue[head++];
      const c = cur % COLS, r = (cur / COLS) | 0;
      for (const [dc, dr] of NEIGHBORS4) {
        const nc = c + dc, nr = r + dr;
        if (!inBounds(nc, nr)) continue;
        const ni = idx(nc, nr);
        if (this.blocked[ni] || seen[ni]) continue;
        seen[ni] = 1;
        queue.push(ni);
      }
    }
    for (const s of SPAWNS) if (!seen[idx(s.c, s.r)]) return false;
    for (const e of enemyCells) {
      if (!inBounds(e.c, e.r)) continue;
      // an enemy standing on a blocked cell is handled by unstick logic
      if (this.blocked[idx(e.c, e.r)]) continue;
      if (!seen[idx(e.c, e.r)]) return false;
    }
    return true;
  }

  // Where should a ground enemy standing at world (x,z) head next?
  flowTarget(x, z) {
    let { c, r } = worldToCell(x, z);
    c = Math.min(Math.max(c, 0), COLS - 1);
    r = Math.min(Math.max(r, 0), ROWS - 1);
    let i = idx(c, r);
    if (this.blocked[i] || this.dist[i] === -1) {
      // stuck inside/next to a fresh obstacle: head to nearest open neighbor
      let best = null, bestD = Infinity;
      for (const [dc, dr] of NEIGHBORS8) {
        const nc = c + dc, nr = r + dr;
        if (!this.isWalkable(nc, nr) || this.dist[idx(nc, nr)] === -1) continue;
        const w = cellToWorld(nc, nr);
        const d = (w.x - x) ** 2 + (w.z - z) ** 2;
        if (d < bestD) { bestD = d; best = w; }
      }
      return best || CRYSTAL_POS;
    }
    const n = this.next[i];
    if (n === -1) return CRYSTAL_POS; // already on the goal cell
    return cellToWorld(n % COLS, (n / COLS) | 0);
  }

  // Circle-vs-blocked-cells collision resolve for characters.
  // Returns corrected {x,z}. allowPlaza lets players (not enemies)
  // step off the south edge into the sanctuary plaza.
  resolveCircle(x, z, radius, allowPlaza = false) {
    const margin = 0.05;
    if (allowPlaza && z > HALF_H - radius) {
      // already south of the battlefield: confined to the plaza's width
      x = Math.min(Math.max(x, -PLAZA.HALF_W + radius + margin), PLAZA.HALF_W - radius - margin);
    } else {
      x = Math.min(Math.max(x, -HALF_W + radius + margin), HALF_W - radius - margin);
    }
    const southMax = allowPlaza && Math.abs(x) < PLAZA.HALF_W - radius
      ? HALF_H + PLAZA.DEPTH
      : HALF_H;
    z = Math.min(Math.max(z, -HALF_H + radius + margin), southMax - radius - margin);
    const { c, r } = worldToCell(x, z);
    for (let rr = r - 1; rr <= r + 1; rr++) {
      for (let cc = c - 1; cc <= c + 1; cc++) {
        if (!this.isBlocked(cc, rr) || !inBounds(cc, rr)) continue;
        const w = cellToWorld(cc, rr);
        const half = CELL / 2;
        // closest point on cell AABB to circle center
        const px = Math.min(Math.max(x, w.x - half), w.x + half);
        const pz = Math.min(Math.max(z, w.z - half), w.z + half);
        let dx = x - px, dz = z - pz;
        const d2 = dx * dx + dz * dz;
        if (d2 >= radius * radius) continue;
        if (d2 < 1e-6) {
          // center inside the box: push out along the shallowest axis
          const ox = half + radius - Math.abs(x - w.x);
          const oz = half + radius - Math.abs(z - w.z);
          if (ox < oz) x += (x >= w.x ? ox : -ox);
          else z += (z >= w.z ? oz : -oz);
        } else {
          const d = Math.sqrt(d2);
          x = px + (dx / d) * radius;
          z = pz + (dz / d) * radius;
        }
      }
    }
    return { x, z };
  }
}
