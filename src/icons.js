// ============================================================
// Tiny inline-SVG icon set (no emoji, no external files).
// All icons are 24x24, drawn with currentColor so they follow
// the surrounding text color.
// ============================================================

const S = (body, fill = false) =>
  `<svg viewBox="0 0 24 24" fill="${fill ? 'currentColor' : 'none'}" stroke="currentColor" ` +
  `stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

const ICONS = {
  // classes
  axe: S('<path d="M14 6l4 4"/><path d="M6.5 21.5L15 13"/><path d="M13 5c2-2 6-2 8 0-1 3-3 5-6 6l-3-3c0-1 .3-2.2 1-3z" fill="currentColor" stroke="none"/>'),
  shield: S('<path d="M12 3l7 3v5c0 4.5-3 8.5-7 10-4-1.5-7-5.5-7-10V6z"/><path d="M12 3v18"/>'),
  bow: S('<path d="M4 20C10 18 18 10 20 4"/><path d="M4 20L20 4" stroke-dasharray="1 3"/><path d="M13 11l6 6M19 13v4h-4" />'),
  orb: S('<circle cx="12" cy="10" r="6"/><path d="M8 20h8M10 16l-1 4M14 16l1 4"/><path d="M9.5 8a3 3 0 0 1 3-2" />'),
  // resources / hud
  coin: S('<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3.5"/>'),
  gem: S('<path d="M7 4h10l4 5-9 11L3 9z"/><path d="M3 9h18M12 20L8.5 9l3.5-5 3.5 5z"/>'),
  gemcrack: S('<path d="M7 4h10l4 5-9 11L3 9z"/><path d="M12 4l-2 5 3 4-2 7"/>'),
  wave: S('<path d="M3 12c2-3 4-3 6 0s4 3 6 0 4-3 6 0"/><path d="M3 17c2-3 4-3 6 0s4 3 6 0 4-3 6 0"/>'),
  link: S('<path d="M10 14a4 4 0 0 0 6 0l3-3a4 4 0 0 0-6-6l-1.5 1.5"/><path d="M14 10a4 4 0 0 0-6 0l-3 3a4 4 0 0 0 6 6l1.5-1.5"/>'),
  skull: S('<path d="M12 3a8 8 0 0 0-8 8c0 3 1.5 5 3 6v3h10v-3c1.5-1 3-3 3-6a8 8 0 0 0-8-8z"/><circle cx="9" cy="11" r="1.6" fill="currentColor" stroke="none"/><circle cx="15" cy="11" r="1.6" fill="currentColor" stroke="none"/><path d="M10.5 20v-2.5M13.5 20v-2.5"/>'),
  swords: S('<path d="M4 4l11 11M20 4L9 15"/><path d="M13 17l4 4M11 17l-4 4M7 15l2 2M17 15l-2 2"/>'),
  tent: S('<path d="M12 4L2 20h20z"/><path d="M12 12l-4 8M12 12l4 8"/>'),
  star: S('<path d="M12 3l2.7 5.7 6.3.8-4.6 4.3 1.2 6.2-5.6-3-5.6 3 1.2-6.2L3 9.5l6.3-.8z"/>'),
  crown: S('<path d="M4 18h16l1-9-5 3-4-6-4 6-5-3z"/>'),
  // build items
  rock: S('<path d="M8 20l-4-4 1-6 5-4 6 1 4 5-2 7z"/><path d="M9 6l2 5-6 3M17 7l-4 4 3 6"/>'),
  ballista: S('<path d="M4 15C8 9 16 9 20 15"/><path d="M12 4v13"/><path d="M9 7l3-3 3 3"/><path d="M8 20h8"/>'),
  catapult: S('<path d="M4 20h16"/><path d="M6 20L16 6"/><circle cx="17.5" cy="5.5" r="2.5"/><path d="M10 20l-2-5"/>'),
  cannon: S('<path d="M3 10l12-4 2 5-11 6z"/><circle cx="9" cy="18" r="2.5"/><path d="M17 6l3-3"/>'),
  // actions / misc
  play: S('<path d="M7 4l13 8-13 8z" fill="currentColor" stroke="none"/>'),
  copy: S('<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'),
  share: S('<circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="5" r="2.5"/><circle cx="18" cy="19" r="2.5"/><path d="M8.2 10.8l7.6-4.6M8.2 13.2l7.6 4.6"/>'),
  gear: S('<circle cx="12" cy="12" r="3.2"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5 5l2.1 2.1M16.9 16.9L19 19M19 5l-2.1 2.1M7.1 16.9L5 19"/>'),
  x: S('<path d="M5 5l14 14M19 5L5 19"/>'),
  music: S('<path d="M9 18V5l11-2v13"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/>'),
  speaker: S('<path d="M4 9v6h4l5 4V5L8 9z" fill="currentColor" stroke="none"/><path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11"/>'),
  sparkle: S('<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 16l.9 2.1L22 19l-2.1.9L19 22l-.9-2.1L16 19l2.1-.9z"/>'),
  heart: S('<path d="M12 20s-7-4.5-9-9c-1.2-2.8.5-6 3.5-6 2 0 3.5 1.2 4.5 3 1-1.8 2.5-3 4.5-3 3 0 4.7 3.2 3.5 6-2 4.5-9 9-9 9z"/>'),
};

// icon('coin')            -> inline svg string, 1em sized
// icon('coin', 'ico-lg')  -> with an extra css class
export function icon(name, cls = '') {
  const svg = ICONS[name] || ICONS.gem;
  return `<span class="ico ${cls}">${svg}</span>`;
}

// swap every <i data-icon="name"> placeholder in the document
export function mountIcons(root = document) {
  for (const el of root.querySelectorAll('[data-icon]')) {
    el.outerHTML = icon(el.dataset.icon, el.className || '');
  }
}
