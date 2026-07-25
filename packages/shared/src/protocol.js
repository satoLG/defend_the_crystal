// ============================================================
// Shared client <-> server protocol.
//
// One place, imported by both apps/web (client) and apps/server
// (authoritative host), so the wire contract can never drift.
// ============================================================

// Socket.IO event names. The gameplay events mirror the old Trystero
// action set (hello/input/act/snap/ev/lobby); the rest are the
// connection lifecycle the server owns now that it is the authority.
export const EV = {
  // client -> server
  CREATE: 'create',   // { character } -> becomes room owner
  JOIN: 'join',       // { code, character, token? }
  INPUT: 'input',     // per-tick movement input for this player
  ACT: 'act',         // a discrete action (build, upgrade, pet/weapon swap, start, …)
  LEAVE: 'leave',     // explicit "sair"
  PING: 'ping',       // { t } -> echoed back as PONG, measures round-trip time
  // server -> client
  WELCOME: 'welcome', // { selfId, code, token, isOwner } — assigns identity
  LOBBY: 'lobby',     // { code, ownerId, players, started }
  SNAP: 'snap',       // authoritative snapshot (full or lean)
  EV: 'ev',           // batched gameplay events
  ERROR: 'err',       // { code, message } — e.g. room not found
  PONG: 'pong',       // { t } — the PING payload, straight back
  // both ways — WebRTC signalling relayed between two players in a room.
  // client -> server: { to, data }; server -> client: { from, data }.
  // The server never inspects `data`; it only routes it to the target's
  // socket, so the peers can negotiate a direct datachannel (see p2p.js).
  SIGNAL: 'sig',
};

// static geometry keys sent only every NET.STATIC_INTERVAL (they change
// rarely); stripped from the lean per-tick snapshots to save bandwidth.
// Clients cache the last full copy and re-merge it into lean ticks.
export const STATIC_KEYS = ['tw', 'ob', 'gr'];

// strip the static geometry collections from a snapshot for a "lean" tick
export function leanSnap(snap) {
  const out = {};
  for (const k in snap) if (!STATIC_KEYS.includes(k)) out[k] = snap[k];
  return out;
}
