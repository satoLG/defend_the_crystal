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
};
