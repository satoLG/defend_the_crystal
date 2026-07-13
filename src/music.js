// ============================================================
// Procedural medieval-ish background music — pure WebAudio,
// zero audio files (tiks only does short UI blips, so the
// music loop is synthesized here in the same spirit).
// A plucked "lute" melody in D dorian over a soft drone and a
// muffled hand-drum. Patterns are hand-written and lightly
// humanized so the loop doesn't grate.
// ============================================================

let ctx = null;
let master = null;
let volume = 0.35;
let playing = false;
let timer = null;
let nextNoteTime = 0;
let step = 0;

const BPM = 92;
const STEP = 60 / BPM / 2; // eighth notes

// D dorian degrees as semitone offsets from D4 (62)
const N = (semi, oct = 0) => 293.66 * Math.pow(2, (semi + oct * 12) / 12);
// melody phrases (semitone offset | null = rest), 16 steps each
const PHRASES = [
  [0, null, 3, null, 5, null, 7, 5, 3, null, 0, null, -2, null, 0, null],
  [7, null, 5, 3, 5, null, 7, null, 10, null, 7, 5, 3, null, 5, null],
  [0, null, 3, 5, 7, null, 10, null, 12, null, 10, 7, 5, 3, 0, null],
  [-2, null, 0, null, 3, null, 0, -2, -4, null, -2, null, 0, null, null, null],
];
const ORDER = [0, 1, 0, 2, 0, 1, 3, 3]; // phrase sequence, then loops

function ensureCtx() {
  if (ctx) return true;
  try {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain();
    master.gain.value = volume;
    master.connect(ctx.destination);
    return true;
  } catch {
    return false;
  }
}

function pluck(freq, time, vel = 1) {
  const osc = ctx.createOscillator();
  osc.type = 'triangle';
  osc.frequency.value = freq;
  const osc2 = ctx.createOscillator();
  osc2.type = 'sine';
  osc2.frequency.value = freq * 2.001;
  const gain = ctx.createGain();
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 2100;
  gain.gain.setValueAtTime(0.001, time);
  gain.gain.linearRampToValueAtTime(0.16 * vel, time + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.001, time + 0.55);
  osc.connect(gain); osc2.connect(gain);
  gain.connect(lp); lp.connect(master);
  osc.start(time); osc2.start(time);
  osc.stop(time + 0.6); osc2.stop(time + 0.6);
}

function drum(time, accent = false) {
  const len = 0.09;
  const buf = ctx.createBuffer(1, ctx.sampleRate * len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) {
    data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / data.length, 2);
  }
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = accent ? 190 : 150;
  bp.Q.value = 1.2;
  const g = ctx.createGain();
  g.gain.value = accent ? 0.4 : 0.22;
  src.connect(bp); bp.connect(g); g.connect(master);
  src.start(time);
}

// ---- boss stings -------------------------------------------------
// short synthesized fanfares layered over the loop; the loop ducks
// while they play so the sting cuts through the mix

function duckThenRestore(len) {
  if (!master) return;
  const now = ctx.currentTime;
  const restore = master.gain.value;
  master.gain.cancelScheduledValues(now);
  master.gain.setValueAtTime(restore, now);
  master.gain.linearRampToValueAtTime(restore * 0.25, now + 0.1);
  master.gain.setValueAtTime(restore * 0.25, now + Math.max(len - 0.5, 0.2));
  master.gain.linearRampToValueAtTime(restore, now + len);
}

// brass-ish stab: three detuned saws through a lowpass
function stab(dest, freq, time, dur, vel = 1, type = 'sawtooth') {
  const g = ctx.createGain();
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 1600;
  g.gain.setValueAtTime(0.001, time);
  g.gain.linearRampToValueAtTime(0.2 * vel, time + 0.02);
  g.gain.setValueAtTime(0.2 * vel, time + dur * 0.55);
  g.gain.exponentialRampToValueAtTime(0.001, time + dur);
  for (const cents of [0, 9, -9]) {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq * Math.pow(2, cents / 1200);
    o.connect(g);
    o.start(time);
    o.stop(time + dur + 0.05);
  }
  g.connect(lp);
  lp.connect(dest);
}

// deep timpani-ish hit: pitched drop + short noise thump
function boom(dest, time, vel = 1) {
  const o = ctx.createOscillator();
  o.type = 'sine';
  o.frequency.setValueAtTime(120, time);
  o.frequency.exponentialRampToValueAtTime(42, time + 0.28);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.55 * vel, time);
  g.gain.exponentialRampToValueAtTime(0.001, time + 0.55);
  o.connect(g);
  g.connect(dest);
  o.start(time);
  o.stop(time + 0.6);

  const len = 0.1;
  const buf = ctx.createBuffer(1, ctx.sampleRate * len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) {
    data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / data.length, 2);
  }
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 130;
  bp.Q.value = 0.9;
  const ng = ctx.createGain();
  ng.gain.value = 0.4 * vel;
  src.connect(bp);
  bp.connect(ng);
  ng.connect(dest);
  src.start(time);
}

// own output bus so the sting isn't ducked along with the loop
function stingBus() {
  const g = ctx.createGain();
  g.gain.value = Math.min(volume * 1.1, 1);
  g.connect(ctx.destination);
  return g;
}

function readyForSting() {
  if (volume <= 0.001) return false;
  if (!ensureCtx()) return false;
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return true;
}

let droneNodes = null;
function startDrone() {
  const g = ctx.createGain();
  g.gain.value = 0.05;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 500;
  const oscs = [N(0, -1), N(7, -1)].map((f) => {
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = f;
    o.connect(lp);
    o.start();
    return o;
  });
  lp.connect(g); g.connect(master);
  droneNodes = { g, lp, oscs };
}

function schedule() {
  if (!playing) return;
  // after being backgrounded the clock may be far ahead of the last
  // scheduled note — skip forward instead of burst-playing the backlog
  if (nextNoteTime < ctx.currentTime - 0.05) {
    nextNoteTime = ctx.currentTime + 0.06;
  }
  while (nextNoteTime < ctx.currentTime + 0.35) {
    const bar = Math.floor(step / 16);
    const idx = step % 16;
    const phrase = PHRASES[ORDER[bar % ORDER.length]];
    const semi = phrase[idx];
    if (semi !== null && Math.random() > 0.06) {
      const jitter = (Math.random() - 0.5) * 0.014;
      pluck(N(semi), nextNoteTime + jitter, 0.8 + Math.random() * 0.35);
      if (Math.random() < 0.22) pluck(N(semi, -1), nextNoteTime + jitter, 0.35);
    }
    if (idx % 4 === 0) drum(nextNoteTime, idx === 0);
    nextNoteTime += STEP;
    step += 1;
  }
  timer = setTimeout(schedule, 120);
}

export const music = {
  start() {
    if (playing || volume <= 0.001) return;
    if (!ensureCtx()) return;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    playing = true;
    nextNoteTime = ctx.currentTime + 0.1;
    step = 0;
    startDrone();
    schedule();
  },
  stop() {
    playing = false;
    if (timer) clearTimeout(timer);
    if (droneNodes) {
      try { droneNodes.oscs.forEach((o) => o.stop()); } catch { /* ok */ }
      droneNodes = null;
    }
  },
  setVolume(v) {
    volume = Math.max(0, Math.min(v, 1));
    if (master) master.gain.value = volume * 0.9;
    if (volume <= 0.001) this.stop();
    else if (!playing) this.start(); // start() creates the AudioContext itself
  },
  // called from inside a user gesture: browsers (iOS especially) only
  // let an AudioContext start/resume synchronously within one
  unlock() {
    if (volume <= 0.001) return;
    if (!playing) { this.start(); return; }
    this.resume();
  },
  // called when the tab becomes visible again — iOS parks the context
  // in 'suspended'/'interrupted' when the app is minimized
  resume() {
    if (!ctx || !playing) return;
    if (ctx.state !== 'running') {
      try { ctx.resume().catch(() => {}); } catch { /* ok */ }
    }
    if (timer) clearTimeout(timer);
    schedule();
  },
  isPlaying: () => playing,

  // ominous fanfare when a checkpoint boss stomps in (~3s):
  // D · D · F, a held tritone scream, then one final low slam
  bossJingle() {
    if (!readyForSting()) return;
    const bus = stingBus();
    const t0 = ctx.currentTime + 0.05;
    duckThenRestore(3.2);
    boom(bus, t0, 1.1);
    stab(bus, N(0, -1), t0, 0.3, 1);
    boom(bus, t0 + 0.35, 0.9);
    stab(bus, N(0, -1), t0 + 0.35, 0.3, 1);
    stab(bus, N(3, -1), t0 + 0.7, 0.35, 1.05);
    boom(bus, t0 + 1.05, 1.2);
    stab(bus, N(6, -1), t0 + 1.05, 1.0, 1.25);  // the tritone scream
    stab(bus, N(6, 0), t0 + 1.05, 1.0, 0.5);
    boom(bus, t0 + 2.1, 1.35);
    stab(bus, N(0, -2), t0 + 2.1, 0.9, 1.2);
    stab(bus, N(0, -1), t0 + 2.1, 0.9, 0.7);
  },

  // shorter, cheekier sting for a mini-boss (~1.4s): quick rising
  // minor arpeggio with a thump on the last note
  miniJingle() {
    if (!readyForSting()) return;
    const bus = stingBus();
    const t0 = ctx.currentTime + 0.05;
    duckThenRestore(1.6);
    stab(bus, N(0, 0), t0, 0.16, 0.9, 'square');
    stab(bus, N(3, 0), t0 + 0.16, 0.16, 0.95, 'square');
    boom(bus, t0 + 0.32, 0.9);
    stab(bus, N(7, 0), t0 + 0.32, 0.55, 1.05, 'square');
    stab(bus, N(7, -1), t0 + 0.32, 0.55, 0.5);
  },
};
