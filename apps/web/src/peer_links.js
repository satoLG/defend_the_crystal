import { NET } from '@dtc/shared/config.js';
import { SnapBuffer } from './net_interp.js';
import { lerp, angleLerp, clamp } from '@dtc/shared/utils.js';

// ============================================================
// Which pose to draw each other player at.
//
// Two sources describe the same thing. The authoritative snapshot is
// always arriving and is always correct, but it has been around a
// round trip through the server. A direct peer connection (p2p.js) may
// also be delivering that player's own pose, which is the same claim
// they made to the server, only sooner.
//
// This class owns the choice between them: one interpolation buffer per
// peer, a freshness test, and a cross-fade so switching source is never a
// jump. Keeping it out of the render loop and away from the DOM means the
// interesting part — what happens when a link starts, stalls, dies and
// recovers — can be tested directly (scripts/peer-links-smoke.mjs).
//
// `clock` returns seconds and is injectable for exactly that reason.
// ============================================================

export class PeerLinks {
  constructor(clock = () => performance.now() / 1000) {
    this.clock = clock;
    this.entries = new Map();  // peerId -> { buf, lastRx, blend, lastJump }
  }

  _entry(id) {
    let entry = this.entries.get(id);
    if (!entry) {
      entry = { buf: new SnapBuffer(8), lastRx: 0, blend: 0, lastJump: 0 };
      this.entries.set(id, entry);
    }
    return entry;
  }

  // a pose just arrived over the direct link
  note(id, pose) {
    const entry = this._entry(id);
    const t = this.clock();
    entry.buf.push(pose, t);
    entry.lastRx = t;
  }

  // a jump just arrived over the direct link
  noteJump(id) { this._entry(id).lastJump = this.clock(); }

  // The server relays the same jump a moment later. Whichever copy arrives
  // first should start the arc; this reports whether the direct one already
  // did, so the server's copy can be dropped instead of restarting it.
  jumpedRecently(id) {
    const entry = this.entries.get(id);
    return !!entry && (this.clock() - entry.lastJump) < NET.P2P_EV_DEDUP;
  }

  forget(id) { this.entries.delete(id); }
  clear() { this.entries.clear(); }

  // Advance the cross-fades. A link that stopped delivering fades out over
  // NET.P2P_BLEND rather than cutting, because the two sources are a
  // round-trip apart and that gap has to be walked, not jumped.
  step(dt) {
    const now = this.clock();
    const rate = dt / NET.P2P_BLEND;
    for (const entry of this.entries.values()) {
      const fresh = (now - entry.lastRx) < NET.P2P_STALE;
      entry.blend = clamp(entry.blend + (fresh ? rate : -rate), 0, 1);
      // fully handed back to the server: drop the stale points so a link
      // that recovers starts from fresh data instead of interpolating
      // across the whole silence
      if (!fresh && entry.blend === 0) entry.buf.clear();
    }
  }

  // Pose to draw peer `id` at, or null to use the authoritative snapshot.
  // `blend` is how far to favour this pose over the snapshot one.
  pose(id) {
    const entry = this.entries.get(id);
    if (!entry || entry.blend <= 0) return null;
    const s = entry.buf.sample(this.clock() - NET.P2P_INTERP_DELAY, NET.INTERP_MAX);
    if (!s?.next) return null;
    const { prev, next, alpha } = s;
    if (!prev) {
      return { x: next.x, z: next.z, yaw: next.yaw, moving: next.moving, blend: entry.blend };
    }
    return {
      x: lerp(prev.x, next.x, alpha),
      z: lerp(prev.z, next.z, alpha),
      yaw: angleLerp(prev.yaw, next.yaw, alpha),
      moving: next.moving,
      blend: entry.blend,
    };
  }
}
