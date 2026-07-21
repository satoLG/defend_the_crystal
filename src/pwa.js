// ============================================================
// PWA glue: service-worker registration, install-prompt capture,
// and "am I running as an installed app?" detection.
//
// The install UI (a button on the start screen and one in the
// settings modal) is driven entirely from here: it only becomes
// available once the browser fires `beforeinstallprompt`, and it
// is never available when the game is already running standalone
// (installed) — so the button can't show inside the installed PWA.
// ============================================================

let deferredPrompt = null;        // the captured beforeinstallprompt event
const listeners = new Set();      // notified whenever install availability flips

// running as an installed app? display-mode covers Android/desktop,
// navigator.standalone covers iOS Safari's home-screen web apps
export function isStandalone() {
  return (typeof window !== 'undefined') && (
    window.matchMedia?.('(display-mode: standalone)').matches === true ||
    window.matchMedia?.('(display-mode: fullscreen)').matches === true ||
    window.matchMedia?.('(display-mode: minimal-ui)').matches === true ||
    window.navigator.standalone === true
  );
}

// true only when we hold a usable install prompt AND aren't already installed
export function canInstall() {
  return !!deferredPrompt && !isStandalone();
}

// subscribe to availability changes; fires with the current value on demand
export function onInstallChange(fn) { listeners.add(fn); }
function emit() { for (const fn of listeners) fn(canInstall()); }

// show the browser's native install dialog. Returns the user's choice
// ('accepted' | 'dismissed' | null when nothing to prompt).
export async function promptInstall() {
  const ev = deferredPrompt;
  if (!ev) return null;
  // a prompt can only be used once — drop it and reflect that in the UI
  deferredPrompt = null;
  emit();
  try {
    ev.prompt();
    const choice = await ev.userChoice;
    return choice?.outcome || null;
  } catch {
    return null;
  }
}

export function initPwa() {
  if (typeof window === 'undefined') return;

  window.addEventListener('beforeinstallprompt', (e) => {
    // stop Chrome's default mini-infobar; we surface our own button
    e.preventDefault();
    deferredPrompt = e;
    emit();
  });

  // once installed, the prompt is spent and the buttons should vanish
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    emit();
  });

  // a live switch into standalone (e.g. user installs & the tab reflows)
  // should also hide the install UI
  window.matchMedia?.('(display-mode: standalone)')
    .addEventListener?.('change', () => emit());

  // register the service worker only in the built app — in dev it would
  // fight Vite's HMR by serving cached modules
  if (import.meta.env.PROD && 'serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      // resolve against the document base so it works at any subpath
      // (GitHub Pages project sites live under /<repo>/)
      const swUrl = new URL('sw.js', document.baseURI).href;
      navigator.serviceWorker.register(swUrl).catch(() => { /* offline unavailable — fine */ });
    });
  }
}
