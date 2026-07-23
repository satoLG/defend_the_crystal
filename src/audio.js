import { tiks } from '@rexa-developer/tiks';
import { music } from './music.js';

// ============================================================
// UI / game feedback sounds via tiks (procedural, no files).
// Gameplay events are throttled so a big wave doesn't turn
// into white noise. Also owns the mobile audio lifecycle:
// unlocking WebAudio on iOS and resuming every context after
// the tab is backgrounded/minimized.
// ============================================================

let ready = false;
let sfxVolume = 0.45;
const lastPlayed = {};

export function initAudio() {
  if (ready) return;
  try {
    tiks.init();
    tiks.setTheme('arcade');
    tiks.setVolume(sfxVolume);
    ready = true;
  } catch (err) {
    console.warn('[audio] init failed', err);
  }
}

export function setSfxVolume(v) {
  sfxVolume = Math.max(0, Math.min(v, 1));
  if (ready) {
    try { tiks.setVolume(sfxVolume); } catch { /* ok */ }
  }
}

// best-effort: dig the AudioContext out of the tiks engine so we can
// resume it after iOS "interrupts" it (tiks only self-heals from the
// plain 'suspended' state)
function tiksContext() {
  try {
    for (const v of Object.values(tiks)) {
      if (v && typeof v === 'object' && typeof v.getContext === 'function') {
        return v.getContext();
      }
    }
  } catch { /* ok */ }
  return null;
}

export function resumeSfx() {
  const ctx = tiksContext();
  if (ctx && ctx.state !== 'running') {
    try { ctx.resume().catch(() => {}); } catch { /* ok */ }
  }
}

// A synthesized ETHEREAL portal sound (tiks' little blips can't do this):
// a stack of detuned oscillators that glide UP in pitch while a lowpass
// filter opens, swelling in and fading out over the whole ~2s portal
// animation — one continuous magical rise, no beeps.
function playPortalTone() {
  const ctx = tiksContext();
  if (!ctx || ctx.state !== 'running') return;
  const t0 = ctx.currentTime;
  const dur = 2.0;
  const vol = Math.max(sfxVolume, 0.05) * 0.55;

  const master = ctx.createGain();
  master.gain.setValueAtTime(0.0001, t0);
  master.gain.exponentialRampToValueAtTime(vol, t0 + 0.4);   // swell open
  master.gain.setValueAtTime(vol, t0 + 1.25);                // hold
  master.gain.exponentialRampToValueAtTime(0.0001, t0 + dur); // fade closed
  master.connect(ctx.destination);

  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.Q.value = 7;
  filter.frequency.setValueAtTime(350, t0);
  filter.frequency.exponentialRampToValueAtTime(4200, t0 + 1.35); // shimmer opens up
  filter.connect(master);

  // three voices gliding up an octave-and-a-bit, each a hair louder low
  const voices = [
    { type: 'sine', from: 174, to: 523, gain: 0.5 },
    { type: 'triangle', from: 262, to: 784, gain: 0.28 },
    { type: 'sine', from: 349, to: 1046, gain: 0.16 },
  ];
  const stops = [];
  for (const v of voices) {
    const osc = ctx.createOscillator();
    osc.type = v.type;
    osc.frequency.setValueAtTime(v.from, t0);
    osc.frequency.exponentialRampToValueAtTime(v.to, t0 + 1.45);
    const g = ctx.createGain();
    g.gain.value = v.gain;
    osc.connect(g); g.connect(filter);
    osc.start(t0); osc.stop(t0 + dur + 0.1);
    stops.push(osc);
  }
  // a gentle vibrato on a high sparkle voice for the "magical" shimmer
  const lfo = ctx.createOscillator(); lfo.frequency.value = 6;
  const lfoGain = ctx.createGain(); lfoGain.gain.value = 10;
  const spark = ctx.createOscillator();
  spark.type = 'sine';
  spark.frequency.setValueAtTime(880, t0);
  spark.frequency.exponentialRampToValueAtTime(1760, t0 + 1.45);
  lfo.connect(lfoGain); lfoGain.connect(spark.frequency);
  const sg = ctx.createGain(); sg.gain.value = 0.07;
  spark.connect(sg); sg.connect(filter);
  lfo.start(t0); spark.start(t0);
  lfo.stop(t0 + dur + 0.1); spark.stop(t0 + dur + 0.1);
}

const isIOS = () =>
  /iP(hone|ad|od)/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

// ~6ms of looped silence
const SILENT_WAV =
  'data:audio/wav;base64,UklGRlQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YTAAAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIA=';

// iOS routes WebAudio through the "ambient" session, which the hardware
// mute switch silences; keeping a (silent) <audio> element playing flips
// the session to "playback" so music and SFX are actually audible
let silentEl = null;
function ensurePlaybackSession() {
  if (!isIOS()) return;
  if (!silentEl) {
    silentEl = document.createElement('audio');
    silentEl.setAttribute('playsinline', '');
    silentEl.loop = true;
    silentEl.preload = 'auto';
    silentEl.src = SILENT_WAV;
  }
  silentEl.play().catch(() => { /* retried on the next gesture */ });
}

// Bound permanently: browsers only allow audio to start inside a user
// gesture, and iOS can re-lock contexts after calls/interruptions, so
// every gesture re-arms whatever got silenced. `onGesture` lets the
// game apply current volumes/mutes inside the same gesture.
export function armAudioOnFirstGesture(onGesture) {
  const arm = () => {
    initAudio();
    ensurePlaybackSession();
    onGesture?.();
    resumeSfx();
    music.unlock();
  };
  // pointerdown covers most browsers; touchend is the gesture iOS
  // historically requires for audio unlock
  for (const evt of ['pointerdown', 'touchend', 'keydown']) {
    window.addEventListener(evt, arm);
  }
}

// coming back from a minimized tab / switched app: resume everything
export function bindAudioLifecycle() {
  const resume = () => {
    resumeSfx();
    music.resume();
    if (silentEl) silentEl.play().catch(() => {});
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') resume();
  });
  window.addEventListener('pageshow', resume);
  window.addEventListener('focus', resume);
}

function throttled(name, minGap, fn) {
  const now = performance.now();
  if (lastPlayed[name] && now - lastPlayed[name] < minGap) return;
  lastPlayed[name] = now;
  try { fn(); } catch { /* audio is never fatal */ }
}

export const sfx = {
  click: () => ready && throttled('click', 30, () => tiks.click()),
  hover: () => ready && throttled('hover', 60, () => tiks.hover()),
  place: () => ready && throttled('place', 60, () => tiks.pop()),
  placeTower: () => ready && throttled('placeT', 80, () => { tiks.pop(); tiks.success(); }),
  waveClear: () => ready && throttled('waveClr', 400, () => { tiks.success(); tiks.notify(); }),
  coin: () => ready && throttled('coin', 90, () => tiks.pop()),
  xp: () => ready && throttled('xp', 120, () => tiks.hover()),
  jump: () => ready && throttled('jump', 150, () => tiks.swoosh()),
  hit: () => ready && throttled('hit', 90, () => tiks.click()),
  shoot: () => ready && throttled('shoot', 120, () => tiks.swoosh()),
  melee: () => ready && throttled('melee', 140, () => tiks.swoosh()),
  boom: () => ready && throttled('boom', 150, () => tiks.warning()),
  hurt: () => ready && throttled('hurt', 200, () => tiks.error()),
  levelUp: () => ready && throttled('lvl', 200, () => tiks.success()),
  wave: () => ready && throttled('wave', 400, () => tiks.notify()),
  notify: () => ready && throttled('notify', 200, () => tiks.notify()),
  // soft per-character tick for the typewriter intro
  type: () => ready && throttled('type', 25, () => tiks.hover()),
  // the arrival portal: a continuous ethereal rise (synthesized, see
  // playPortalTone) that swells open and fades closed over the animation
  portal: () => ready && throttled('portal', 400, () => playPortalTone()),
  // gentle "start of a conversation" chime when stepping up to an NPC —
  // softer & less jarring than the old notify
  chat: () => ready && throttled('chat', 350, () => {
    tiks.hover();
    setTimeout(() => { try { tiks.hover(); } catch { /* ok */ } }, 90);
  }),
  breach: () => ready && throttled('breach', 250, () => tiks.warning()),
  error: () => ready && throttled('err', 150, () => tiks.error()),
  success: () => ready && throttled('ok', 150, () => tiks.success()),
  toggle: (on) => ready && throttled('tgl', 60, () => tiks.toggle(on)),
  // class special attacks: layered/staggered tones so they land much
  // harder than the regular one-shot cues
  skill: (cls) => ready && throttled('skill', 250, () => {
    const seq = {
      berserker: [[0, 'swoosh'], [70, 'warning'], [150, 'swoosh']],
      tanker: [[0, 'warning'], [100, 'success'], [220, 'notify']],
      archer: [[0, 'swoosh'], [120, 'swoosh'], [240, 'swoosh'], [360, 'notify']],
      mage: [[0, 'warning'], [130, 'notify'], [260, 'swoosh']],
    }[cls] || [[0, 'notify'], [100, 'warning']];
    for (const [delay, name] of seq) {
      setTimeout(() => { try { tiks[name](); } catch { /* ok */ } }, delay);
    }
  }),
};
