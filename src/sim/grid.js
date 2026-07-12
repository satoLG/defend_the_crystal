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
  // Returns corrected {x,z}.
  resolveCircle(x, z, radius) {
    const margin = 0.05;
    x = Math.min(Math.max(x, -HALF_W + radius + margin), HALF_W - radius - margin);
    z = Math.min(Math.max(z, -HALF_H + radius + margin), HALF_H - radius - margin);
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
