// ============================================================
// Progress save & sync.
//
// Today all progress (heroes, pets, weapons, gold, best wave,
// settings, language) is persisted LOCALLY in localStorage by
// character.js / settings.js / i18n.js — which already works
// fully offline, including inside the installed PWA.
//
// This module adds two things on top of that:
//   1. a single place that can read/replace the whole local
//      progress snapshot (handy for import/export, backups and,
//      eventually, cloud sync);
//   2. an EMPTY online-sync template. There is no backend yet
//      and nothing to sync to, so every remote call is a no-op
//      stub — but the shape (provider + push/pull/merge + a
//      pending-change queue that flushes when the connection
//      returns) is laid out so wiring a real service in later is
//      a matter of filling the stubs, not restructuring.
// ============================================================

// every localStorage key that makes up a player's progress. Keeping the
// list here means the snapshot below always covers the full save.
const PROGRESS_KEYS = [
  'dtc-characters',   // hero roster (name, class, colours, pets, weapons, coins)
  'dtc-active',       // id of the active hero
  'dtc-best-wave',    // best run so far
  'dtc-settings',     // audio / camera / shadow preferences
  'dtc-lang',         // last language in effect
  'dtc-lang-set',     // whether the language was chosen by hand
];

// bump when the snapshot format changes so a future importer can migrate
const SNAPSHOT_VERSION = 1;

// ---------------- local snapshot (works offline) ----------------

// read the entire local progress as one plain object, ready to be
// serialized (export, backup) or handed to a sync provider
export function collectLocalProgress() {
  const data = {};
  for (const key of PROGRESS_KEYS) {
    try {
      const v = localStorage.getItem(key);
      if (v !== null) data[key] = v;
    } catch { /* storage unavailable — skip */ }
  }
  return { version: SNAPSHOT_VERSION, updatedAt: Date.now(), data };
}

// write a snapshot back into localStorage (used by import / a future
// cloud "pull"). Returns true when anything was applied. A reload is
// needed afterwards for the running game to pick the new state up.
export function applyLocalProgress(snapshot) {
  if (!snapshot || typeof snapshot.data !== 'object' || !snapshot.data) return false;
  let applied = false;
  for (const key of PROGRESS_KEYS) {
    if (!(key in snapshot.data)) continue;
    try { localStorage.setItem(key, snapshot.data[key]); applied = true; } catch { /* quota */ }
  }
  return applied;
}

// ============================================================
// Online sync — EMPTY TEMPLATE.
//
// Drop a real implementation into `provider` (REST, Firebase,
// Supabase, a Trystero room, …). Until then every method resolves
// to a harmless no-op and `sync` simply reports "nothing to do".
// ============================================================

// A sync provider only needs three async methods. `null` means
// "not configured" → offline-only, which is the current state.
//
//   provider = {
//     async pull(auth)            -> snapshot | null   (remote → local)
//     async push(snapshot, auth)  -> void              (local → remote)
//     async identify()            -> auth | null       (who is this player)
//   }
let provider = null;

// changes made while offline / signed-out queue up here and flush on the
// next successful sync. Nothing enqueues yet — reserved for the real impl.
const pendingChanges = [];

let syncing = false;

// register a real backend later: setSyncProvider({ pull, push, identify })
export function setSyncProvider(impl) { provider = impl || null; }

export function isSyncConfigured() { return !!provider; }

// queue a change to be pushed once a provider + connection exist
export function queueChange(change) {
  pendingChanges.push({ at: Date.now(), change });
}

// The one entry point. Safe to call any time (boot, on reconnect,
// after a match). Resolves to a small status object.
export async function sync(auth = null) {
  if (!provider) {
    // no backend wired up yet — local save is the source of truth
    return { ok: true, skipped: 'no-provider' };
  }
  if (!navigator.onLine) return { ok: false, skipped: 'offline' };
  if (syncing) return { ok: false, skipped: 'in-progress' };

  syncing = true;
  try {
    const who = auth || (provider.identify ? await provider.identify() : null);

    // 1. pull remote and merge into local
    //    const remote = await provider.pull(who);
    //    const merged = mergeProgress(collectLocalProgress(), remote);
    //    applyLocalProgress(merged);

    // 2. push the (merged) local snapshot back up
    //    await provider.push(merged ?? collectLocalProgress(), who);

    // 3. drain anything that queued while offline
    //    pendingChanges.length = 0;

    return { ok: true, skipped: 'not-implemented', who };
  } catch (err) {
    return { ok: false, error: err };
  } finally {
    syncing = false;
  }
}

// Conflict resolution stub. A real merge would reconcile per-hero
// progress (highest pet level, most coins, best wave, newest edit …).
// For now "most recently updated wins", falling back to whichever side
// actually has data.
export function mergeProgress(local, remote) {
  if (!remote?.data) return local;
  if (!local?.data) return remote;
  return (remote.updatedAt || 0) > (local.updatedAt || 0) ? remote : local;
}

// Wire the browser's connectivity events to an automatic sync attempt.
// Harmless today (sync() no-ops without a provider); ready the moment a
// backend is registered.
export function initSync() {
  if (typeof window === 'undefined') return;
  window.addEventListener('online', () => { sync(); });
  // opportunistic first attempt once the app is up
  sync();
}
