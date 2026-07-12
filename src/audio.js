import { tiks } from '@rexa-developer/tiks';

// ============================================================
// UI / game feedback sounds via tiks (procedural, no files).
// Gameplay events are throttled so a big wave doesn't turn
// into white noise.
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

// call once on the first user gesture (browsers require it)
export function armAudioOnFirstGesture() {
  const arm = () => { initAudio(); window.removeEventListener('pointerdown', arm); };
  window.addEventListener('pointerdown', arm);
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
  coin: () => ready && throttled('coin', 90, () => tiks.pop()),
  hit: () => ready && throttled('hit', 90, () => tiks.click()),
  shoot: () => ready && throttled('shoot', 120, () => tiks.swoosh()),
  melee: () => ready && throttled('melee', 140, () => tiks.swoosh()),
  boom: () => ready && throttled('boom', 150, () => tiks.warning()),
  hurt: () => ready && throttled('hurt', 200, () => tiks.error()),
  levelUp: () => ready && throttled('lvl', 200, () => tiks.success()),
  wave: () => ready && throttled('wave', 400, () => tiks.notify()),
  notify: () => ready && throttled('notify', 200, () => tiks.notify()),
  breach: () => ready && throttled('breach', 250, () => tiks.warning()),
  error: () => ready && throttled('err', 150, () => tiks.error()),
  success: () => ready && throttled('ok', 150, () => tiks.success()),
  toggle: (on) => ready && throttled('tgl', 60, () => tiks.toggle(on)),
};
