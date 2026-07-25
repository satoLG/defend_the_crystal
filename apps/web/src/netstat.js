import { NET } from '@dtc/shared/config.js';
import { clamp } from '@dtc/shared/utils.js';

// ============================================================
// Connection metrics + the adaptive interpolation delay.
//
// Two jobs, both fed by the same measurements:
//
// 1. Turn "it felt laggy" into numbers. Add ?netstat=1 to the URL for a
//    small overlay showing round-trip time to the server, how fast
//    snapshots really arrive, how much that rate wobbles, and whether each
//    peer is being drawn from a direct connection or from the server.
//    Everything is also on window.__dtcNet for the console.
//
// 2. Size the snapshot interpolation buffer to the connection actually in
//    use. Rendering N milliseconds in the past is what hides network
//    jitter, so the right N is a property of the link, not a constant: too
//    short and a late packet leaves nothing to interpolate toward (freeze,
//    then jump), too long and every remote is needlessly behind. We track
//    the spread of arrival times and follow it slowly — slowly matters,
//    because the delay shifts the render clock, and yanking that clock
//    around is itself visible.
// ============================================================

// how strongly a single arrival moves the running averages
const RATE_ALPHA = 0.1;
// the adaptive delay follows its target far more gently than the
// measurements move — ~2s to cross most of a gap at 18 snapshots/s
const DELAY_ALPHA = 0.02;
// headroom over the mean, in multiples of the measured deviation: enough
// that ordinary wobble stays covered without over-padding a clean link
const JITTER_HEADROOM = 3;

export class NetStat {
  constructor() {
    this.rtt = 0;             // ms, round trip to the server
    this.snapInterval = 1 / NET.SNAP_HZ;  // s, measured
    this.snapJitter = 0;      // s, mean deviation of the above
    this.snapAge = 0;         // s, since the newest snapshot
    this.snapCount = 0;
    this.delay = NET.INTERP_DELAY;
    this._lastSnapT = 0;
    this.el = null;
    this._lastPaint = 0;
  }

  // called on every authoritative snapshot (t = performance clock, seconds)
  noteSnap(t) {
    this.snapCount++;
    if (this._lastSnapT) {
      const gap = t - this._lastSnapT;
      // a gap this large is a stall or a tab wake, not jitter to plan for
      if (gap < 1) {
        this.snapInterval += (gap - this.snapInterval) * RATE_ALPHA;
        const dev = Math.abs(gap - this.snapInterval);
        this.snapJitter += (dev - this.snapJitter) * RATE_ALPHA;
        const target = clamp(
          this.snapInterval + this.snapJitter * JITTER_HEADROOM,
          NET.INTERP_MIN,
          NET.INTERP_MAX_DELAY,
        );
        this.delay += (target - this.delay) * DELAY_ALPHA;
      }
    }
    this._lastSnapT = t;
  }

  noteRtt(ms) {
    // keep the worst of the recent samples visible rather than averaging a
    // spike away — a spike is exactly what the player felt
    this.rtt = this.rtt ? this.rtt + (ms - this.rtt) * 0.2 : ms;
  }

  // seconds to render behind the newest snapshot
  interpDelay() { return this.delay; }

  // ---- overlay ---------------------------------------------------------

  // opt-in, in the same debug-override style as ?server=
  static requested() {
    try { return new URLSearchParams(location.search).get('netstat') === '1'; }
    catch { return false; }
  }

  mount() {
    if (this.el || typeof document === 'undefined') return;
    const el = document.createElement('div');
    el.id = 'netstat';
    el.style.cssText = [
      'position:fixed', 'left:8px', 'bottom:8px', 'z-index:9999',
      'font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace',
      'color:#cfe6ff', 'background:rgba(6,10,20,.78)', 'padding:6px 9px',
      'border-radius:6px', 'white-space:pre', 'pointer-events:none',
      'text-shadow:0 1px 2px rgba(0,0,0,.8)',
    ].join(';');
    document.body.appendChild(el);
    this.el = el;
  }

  // `peers` is P2PMesh.stats() (empty array when the mesh is off)
  paint(now, peers = []) {
    if (!this.el) return;
    this.snapAge = this._lastSnapT ? now - this._lastSnapT : 0;
    if (now - this._lastPaint < 0.25) return;   // 4Hz is plenty to read
    this._lastPaint = now;

    const ms = (s) => `${Math.round(s * 1000)}ms`;
    const lines = [
      `rtt      ${Math.round(this.rtt)}ms`,
      `snap     ${(1 / this.snapInterval).toFixed(1)}Hz  ±${ms(this.snapJitter)}`,
      `age      ${ms(this.snapAge)}`,
      `interp   ${ms(this.delay)}`,
    ];
    if (peers.length) {
      for (const p of peers) {
        const via = p.live ? `p2p ${Math.round(p.rtt)}ms` : `server (${p.state})`;
        lines.push(`${p.id.slice(0, 4)}     ${via}`);
      }
    } else {
      lines.push('peers    —');
    }
    this.el.textContent = lines.join('\n');
  }
}
