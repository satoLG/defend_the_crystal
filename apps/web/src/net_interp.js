import { clamp } from '@dtc/shared/utils.js';

// ============================================================
// Snapshot interpolation buffer.
//
// Snapshots only arrive ~SNAP_HZ times/sec, but the screen renders at
// ~60fps. To keep remote entities smooth we don't draw the newest
// snapshot raw — we render slightly in the past (by INTERP_DELAY) and
// blend the two snapshots that *bracket* that render time.
//
// A two-snapshot double-buffer isn't enough once INTERP_DELAY exceeds a
// single snapshot interval: the render time then falls behind the oldest
// buffered point and the blend factor pins to an endpoint, which reads as
// the classic "jump then ease" stutter. A short ring of recent snapshots
// lets us always find the correct bracketing pair, so motion stays
// continuous and INTERP_DELAY can be sized to absorb network jitter.
//
// The same buffer serves both roles: the host stamps the snapshots it
// broadcasts with the render wall-clock, clients stamp on receive. Both
// then sample at (clock - INTERP_DELAY).
// ============================================================
export class SnapBuffer {
  constructor(keep = 12) {
    this.buf = [];      // [{ snap, t }], oldest first, t strictly increasing
    this.keep = keep;
  }

  push(snap, t) {
    const n = this.buf.length;
    // keep timestamps strictly monotonic so bracketing/alpha stay well-defined
    if (n && t <= this.buf[n - 1].t) t = this.buf[n - 1].t + 1e-4;
    this.buf.push({ snap, t });
    if (this.buf.length > this.keep) this.buf.shift();
  }

  // Most recent snapshot, un-interpolated — for HUD, camera and grid,
  // which want current authoritative values rather than the delayed pose.
  latest() {
    const n = this.buf.length;
    return n ? this.buf[n - 1].snap : null;
  }

  clear() {
    this.buf.length = 0;
  }

  // Returns { prev, next, alpha } to render at time `renderT`, or null when
  // empty. `alpha` is clamped to [0,1] within the buffer; on the newest
  // segment it may reach up to `maxExtrap` (>= 1) so a late snapshot briefly
  // extrapolates along the last heading instead of freezing.
  sample(renderT, maxExtrap = 1) {
    const b = this.buf;
    const n = b.length;
    if (n === 0) return null;
    if (n === 1) return { prev: null, next: b[0].snap, alpha: 1 };

    const last = b[n - 1];
    // Ahead of the newest stamp: extrapolate along the last segment (capped).
    if (renderT >= last.t) {
      const p = b[n - 2];
      const span = last.t - p.t;
      const alpha = span > 0 ? clamp((renderT - p.t) / span, 0, maxExtrap) : 1;
      return { prev: p.snap, next: last.snap, alpha };
    }
    // Find the segment [i-1, i] that brackets renderT (scan newest -> oldest).
    for (let i = n - 1; i >= 1; i--) {
      if (renderT >= b[i - 1].t) {
        const span = b[i].t - b[i - 1].t;
        const alpha = span > 0 ? clamp((renderT - b[i - 1].t) / span, 0, 1) : 1;
        return { prev: b[i - 1].snap, next: b[i].snap, alpha };
      }
    }
    // Older than everything buffered: hold the oldest snapshot.
    return { prev: null, next: b[0].snap, alpha: 1 };
  }
}
