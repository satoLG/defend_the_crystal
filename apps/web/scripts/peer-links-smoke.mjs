// Checks the part of the direct-link feature that decides what the player
// actually sees: PeerLinks (which source an ally's avatar is drawn from)
// and NetStat (how deep the snapshot buffer should be).
//
//   node scripts/peer-links-smoke.mjs
//
// Both are pure logic on an injectable clock, so this runs in plain Node —
// no browser, no WebRTC, no timing flakiness. The end-to-end version that
// exercises real datachannels between two browsers is p2p-smoke.mjs.
import { PeerLinks } from '../src/peer_links.js';
import { NetStat } from '../src/netstat.js';
import { NET } from '@dtc/shared/config.js';

let t = 100;                       // fake clock, seconds
const links = new PeerLinks(() => t);
const PEER = 'ally';

const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const near = (a, b, tol, msg) =>
  assert(Math.abs(a - b) <= tol, `${msg} (got ${a}, wanted ${b} ±${tol})`);

// walk the clock forward in render-sized steps, feeding poses at P2P_HZ
function run(seconds, { feed = true, moveFrom = null } = {}) {
  const dt = 1 / 60;
  let sinceSend = 0;
  for (let elapsed = 0; elapsed < seconds; elapsed += dt) {
    t += dt;
    sinceSend += dt;
    if (feed && sinceSend >= 1 / NET.P2P_HZ) {
      sinceSend = 0;
      const x = moveFrom ? moveFrom.x + moveFrom.vx * (t - moveFrom.t0) : 5;
      links.note(PEER, { x, z: 9, yaw: 1, moving: !!moveFrom });
    }
    links.step(dt);
  }
}

let failed = null;
try {
  // ---- an unknown peer defers to the snapshot -------------------------
  assert(links.pose(PEER) === null, 'a peer with no link should have no pose');
  console.log('✓ no link -> renderer uses the authoritative snapshot');

  // ---- a link coming up fades in, it does not cut ---------------------
  links.note(PEER, { x: 5, z: 9, yaw: 1, moving: false });
  links.step(1 / 60);
  const first = links.pose(PEER);
  assert(first && first.blend > 0 && first.blend < 0.2,
    `first frame should barely favour the link, got blend=${first?.blend}`);

  run(NET.P2P_BLEND * 1.2);
  const settled = links.pose(PEER);
  near(settled.blend, 1, 0.001, 'a delivering link should reach full blend');
  near(settled.x, 5, 0.001, 'pose should report the delivered position');
  console.log(`✓ link fades in over ~${NET.P2P_BLEND}s and takes over fully`);

  // ---- interpolation tracks a moving peer -----------------------------
  // Moving at 4 u/s, sampled P2P_INTERP_DELAY in the past: the reported x
  // should trail the true one by exactly that delay's worth of travel.
  const vx = 4;
  const mover = { x: 5, vx, t0: t };
  run(1.5, { moveFrom: mover });
  const trueX = 5 + vx * (t - mover.t0);
  const shown = links.pose(PEER);
  near(trueX - shown.x, vx * NET.P2P_INTERP_DELAY, 0.12,
    'interpolated pose should trail the true one by the interp delay');
  assert(shown.moving === true, 'moving flag should follow the delivered pose');
  console.log(`✓ interpolates ${Math.round(NET.P2P_INTERP_DELAY * 1000)}ms behind a moving peer`);

  // ---- a stalled link hands back without a jump -----------------------
  // Silence shorter than P2P_STALE must not disturb anything: packets are
  // allowed to be late.
  const beforeGap = links.pose(PEER).blend;
  t += NET.P2P_STALE * 0.7;
  links.step(1 / 60);
  near(links.pose(PEER).blend, beforeGap, 0.02,
    'a short gap should not start handing back');
  console.log('✓ a late packet does not trigger a handover');

  // Real silence does, and it fades rather than cutting.
  t += NET.P2P_STALE;
  links.step(1 / 60);
  const fading = links.pose(PEER);
  assert(fading.blend < 1 && fading.blend > 0.9,
    `handover should have only just started, got blend=${fading.blend}`);
  run(NET.P2P_BLEND * 1.2, { feed: false });
  assert(links.pose(PEER) === null,
    'a dead link should defer completely to the snapshot');
  console.log(`✓ a dead link fades out over ~${NET.P2P_BLEND}s, then defers`);

  // ---- recovery starts from fresh data --------------------------------
  // The buffer is cleared on full handover, so a link that comes back does
  // not interpolate across the silence from a position minutes old.
  links.note(PEER, { x: 40, z: 2, yaw: 0, moving: false });
  links.step(1 / 60);
  const back = links.pose(PEER);
  near(back.x, 40, 0.001, 'a recovered link should report its newest position');
  assert(back.blend < 0.2, 'a recovered link should fade in, not snap');
  console.log('✓ a recovered link starts fresh and fades back in');

  // ---- jump dedup ------------------------------------------------------
  assert(!links.jumpedRecently(PEER), 'no jump yet');
  links.noteJump(PEER);
  assert(links.jumpedRecently(PEER), 'a direct jump should suppress the server copy');
  t += NET.P2P_EV_DEDUP + 0.01;
  assert(!links.jumpedRecently(PEER),
    'the suppression window must expire so later jumps still play');
  console.log('✓ a jump over the link suppresses exactly one server copy');

  // ---- forgetting a peer ----------------------------------------------
  links.forget(PEER);
  assert(links.pose(PEER) === null, 'a forgotten peer should have no pose');
  console.log('✓ peers leaving the room are dropped');

  // ---- the adaptive interpolation delay --------------------------------
  const feedSnaps = (stat, count, interval, jitter) => {
    let clock = 0;
    for (let i = 0; i < count; i++) {
      // deterministic alternating jitter, so the run is reproducible
      clock += interval + (i % 2 ? jitter : -jitter);
      stat.noteSnap(clock);
    }
  };

  const clean = new NetStat();
  feedSnaps(clean, 600, 1 / NET.SNAP_HZ, 0.002);
  assert(clean.interpDelay() < NET.INTERP_DELAY,
    `a clean link should buffer less than the ${NET.INTERP_DELAY}s default, got ${clean.interpDelay()}`);
  near(clean.interpDelay(), NET.INTERP_MIN, 0.005, 'a clean link should settle at the floor');

  const jittery = new NetStat();
  feedSnaps(jittery, 600, 1 / NET.SNAP_HZ, 0.045);
  assert(jittery.interpDelay() > NET.INTERP_DELAY,
    `a jittery link should buffer more than the default, got ${jittery.interpDelay()}`);
  assert(jittery.interpDelay() <= NET.INTERP_MAX_DELAY + 1e-9, 'delay must stay within its ceiling');
  console.log(`✓ interp delay adapts: clean ${Math.round(clean.interpDelay() * 1000)}ms, `
    + `jittery ${Math.round(jittery.interpDelay() * 1000)}ms `
    + `(default ${Math.round(NET.INTERP_DELAY * 1000)}ms)`);

  // a stall (backgrounded tab, server hiccup) is not jitter to plan for
  const stalled = new NetStat();
  feedSnaps(stalled, 300, 1 / NET.SNAP_HZ, 0.002);
  const beforeStall = stalled.interpDelay();
  stalled.noteSnap(1000);   // a huge gap
  near(stalled.interpDelay(), beforeStall, 1e-9,
    'a one-off stall must not inflate the delay');
  console.log('✓ a stall is ignored rather than treated as jitter');
} catch (err) {
  failed = err;
}

if (failed) { console.error('PEER LINKS SMOKE FAILED:', failed.message); process.exit(1); }
console.log('PEER LINKS SMOKE PASSED');
