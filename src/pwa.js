// ============================================================
// PWA glue: service-worker registration, install-prompt capture,
// and "am I already installed?" detection.
//
// Important browser reality: there is NO API to force the native
// install dialog on demand. The dialog can only be opened by
// calling .prompt() on a `beforeinstallprompt` event, which only
// Chromium fires, and only once its install criteria are met.
// iOS Safari and Firefox never fire it at all.
//
// So the on-screen install button is ALWAYS shown while the game
// isn't installed. When tapped it uses the native prompt if we
// captured one; otherwise the UI falls back to a short "how to
// install" guide (see ui.js). This module just exposes the state
// the UI needs to make that choice.
// ============================================================

let deferredPrompt = null;        // the captured beforeinstallprompt event (Chromium only)
let installed = false;            // flipped true once appinstalled fires
const listeners = new Set();      // notified whenever install state changes

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

// already installed (running standalone, or installed this session)?
export function isInstalled() { return installed || isStandalone(); }

// do we hold a usable native install prompt right now?
export function hasNativePrompt() { return !!deferredPrompt; }

// subscribe to state changes (prompt captured, app installed, …)
export function onInstallChange(fn) { listeners.add(fn); }
function emit() { for (const fn of listeners) fn(); }

// Fire the browser's native install dialog. Returns:
//   'accepted' | 'dismissed'  — the user's choice
//   null                      — no native prompt available (UI should
//                               fall back to manual instructions)
export async function promptInstall() {
  const ev = deferredPrompt;
  if (!ev) return null;
  deferredPrompt = null; // a prompt can only be used once
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

  // once installed, hide the install UI and drop the spent prompt
  window.addEventListener('appinstalled', () => {
    installed = true;
    deferredPrompt = null;
    emit();
  });

  // a live switch into standalone should also update the UI
  window.matchMedia?.('(display-mode: standalone)')
    .addEventListener?.('change', () => emit());

  // register the service worker only in the built app — in dev it would
  // fight Vite's HMR by serving cached modules
  if (import.meta.env.PROD && 'serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      // resolve against the document base so it works at any subpath
      const swUrl = new URL('sw.js', document.baseURI).href;
      navigator.serviceWorker.register(swUrl).catch(() => { /* offline unavailable — fine */ });
    });
  }
}
