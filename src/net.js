import { joinRoom as joinNostr, selfId as trysteroId } from 'trystero';
import { joinRoom as joinTorrent } from '@trystero-p2p/torrent';
import { joinRoom as joinMqtt } from '@trystero-p2p/mqtt';
import { joinRoom as joinSupabase } from '@trystero-p2p/supabase';
import { createClient } from '@supabase/supabase-js';
import { NET, SUPABASE } from './config.js';

const useLocalNet = new URLSearchParams(location.search).has('localnet');
// `trysteroId` comes from the 'trystero' (Nostr) package, but every
// transport below re-exports its own `selfId` pulled from the SAME
// underlying @trystero-p2p/core module — that only holds if all four
// trystero-p2p packages resolve to one shared copy of core, which is why
// package.json pins them to matching exact versions (see its dependencies
// block). If that ever drifts, a single browser tab can present a
// different peer id per transport, and the SAME player joining over two
// transports (e.g. Supabase + Nostr) shows up as two separate players.
export const selfId = useLocalNet
  ? `local-${Math.random().toString(36).slice(2, 10)}`
  : trysteroId;

// ============================================================
// Supabase-first peer discovery, with public relays as a *fallback*.
//
// Supabase Realtime Broadcast is a signaling channel WE control (see
// config.SUPABASE). Public Nostr/torrent/MQTT relays go up and down; a
// Supabase project doesn't — so when it's configured it is the ONE, always-
// preferred discovery path. Only the WebRTC handshake ever crosses Supabase;
// once two peers link up, every bit of gameplay data flows directly
// peer-to-peer and never touches it again.
//
// The connection order is a real, staged failover — not a race:
//
//   1. Supabase starts FIRST and ALONE. In the normal case a match forms
//      entirely over Supabase and the public relays are never even opened.
//   2. In parallel we run a lightweight Realtime *health probe* (a throwaway
//      Broadcast channel whose subscribe status we can actually read). While
//      Supabase's own signaling channel is healthy — SUBSCRIBED — we stay on
//      Supabase alone.
//   3. ONLY if the probe reports Supabase can't connect (CHANNEL_ERROR /
//      TIMED_OUT, or no SUBSCRIBED within the timeout) — or if a live
//      Supabase link later drops — do we bring up the fallback pool:
//      a large curated Nostr relay list plus WebTorrent trackers and MQTT
//      brokers, all joined at once so a single reachable one is enough.
//
// This is the behaviour we want: Supabase is the principal transport,
// tried on its own every time, and the relays are touched strictly as a
// backup, never speculatively. Every stage logs to the console so a failing
// Supabase connection is loud and obvious instead of being silently papered
// over by a relay that happened to answer first.
//
// All active transports are merged behind one Net interface; the game layer
// is unaware of the plumbing. Supabase is marked `primary`, so even when the
// fallback pool is up, any peer Supabase can reach is sent to over Supabase.
// ============================================================

// How long (ms) to wait for the Supabase Realtime health probe to report
// SUBSCRIBED before declaring Supabase unreachable and opening the fallback
// relays. A healthy project subscribes in ~1-3s; this only ever elapses in
// full when Supabase genuinely can't be reached.
const SUPABASE_HEALTH_TIMEOUT = 6000;

// A wide mix of well-known, permissive public Nostr relays. Every
// peer connects to all of them, so as long as any single relay is
// reachable by both sides a match can be brokered. `hornetstorage`
// is intentionally excluded — it rejects our ephemeral events with
// "event creation date must be after January 1, 2019", which just
// spams the console without ever helping.
const NOSTR_RELAYS = [
  // rock-solid, always-on relays
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://relay.snort.social',
  'wss://relay.nostr.band',
  'wss://offchain.pub',
  'wss://nostr-pub.wellorder.net',
  'wss://nostr.oxtr.dev',
  'wss://nostr.mom',
  'wss://relay.nostr.bg',
  // additional reachable relays from Trystero's vetted defaults
  'wss://relay.mostr.pub',
  'wss://relay.froth.zone',
  'wss://purplerelay.com',
  'wss://relay.nostr.place',
  'wss://nostr.data.haus',
  'wss://strfry.openhoofd.nl',
  'wss://relay.notoshi.win',
  'wss://nostr.vulpem.com',
];

// Public WebTorrent tracker + MQTT broker pools are handled by the
// respective strategies' own defaults, which are already broad and
// independent of Nostr; we just enable those transports below.

// Supabase is only wired up when a project URL + key are configured;
// otherwise the game runs on the public relays alone. The Supabase project
// URL is Trystero's `appId` for this strategy and the key goes in
// relayConfig.supabaseKey.
const supabaseReady = !!(SUPABASE.URL && SUPABASE.KEY);

// The primary transport: Supabase, when configured. Started first and on its
// own; `primary` makes it the preferred send path whenever it can reach a
// peer (see _initRoom).
const SUPABASE_TRANSPORT = supabaseReady ? {
  name: 'supabase',
  primary: true,
  join: (code) => joinSupabase(
    { appId: SUPABASE.URL, relayConfig: { supabaseKey: SUPABASE.KEY } },
    code,
  ),
} : null;

// The fallback pool: public relays, opened ONLY if Supabase can't connect
// (or isn't configured at all). Each is a named joiner; any that fails to
// initialize is skipped, so one broken strategy can't take the others down.
const FALLBACK_TRANSPORTS = [
  {
    name: 'nostr',
    join: (code) => joinNostr(
      { appId: NET.APP_ID, relayConfig: { urls: NOSTR_RELAYS } },
      code,
    ),
  },
  {
    name: 'torrent',
    join: (code) => joinTorrent({ appId: NET.APP_ID }, code),
  },
  {
    name: 'mqtt',
    join: (code) => joinMqtt({ appId: NET.APP_ID }, code),
  },
];

const ALL_TRANSPORTS = [
  ...(SUPABASE_TRANSPORT ? [SUPABASE_TRANSPORT] : []),
  ...FALLBACK_TRANSPORTS,
];

// Optional debug override: ?net=nostr,torrent forces an exact set of
// transports up in parallel (the old all-at-once behaviour), skipping the
// staged Supabase-first failover. Unknown names are ignored; an empty match
// falls back to the full staged flow (returns null).
function overrideTransports() {
  const wanted = new URLSearchParams(location.search).get('net');
  if (!wanted) return null;
  const allow = new Set(wanted.split(',').map((s) => s.trim().toLowerCase()));
  const picked = ALL_TRANSPORTS.filter((t) => allow.has(t.name));
  return picked.length ? picked : null;
}

const ACTION_NAMES = ['hello', 'input', 'act', 'snap', 'ev', 'lobby'];

// BroadcastChannel transport: lets tabs of the same browser play
// together without touching the network. Used for local testing
// (add ?localnet to the URL); real matches use Trystero/WebRTC.
class LocalRoom {
  constructor(code) {
    this.chan = new BroadcastChannel(`dtc-${code}`);
    this.known = new Set();
    this.onPeerJoin = null;
    this.onPeerLeave = null;
    this.handlers = {};
    this.chan.onmessage = ({ data: m }) => {
      if (m.from === selfId || (m.to && m.to !== selfId)) return;
      if (m.kind === 'join' || m.kind === 'welcome') {
        if (!this.known.has(m.from)) {
          this.known.add(m.from);
          if (m.kind === 'join') this._post({ kind: 'welcome', to: m.from });
          this.onPeerJoin?.(m.from);
        }
      } else if (m.kind === 'leave') {
        if (this.known.delete(m.from)) this.onPeerLeave?.(m.from);
      } else if (m.kind === 'msg') {
        this.handlers[m.name]?.(m.data, { peerId: m.from });
      }
    };
    this._post({ kind: 'join' });
    window.addEventListener('beforeunload', () => this._post({ kind: 'leave' }));
  }

  _post(m) { this.chan.postMessage({ from: selfId, ...m }); }

  makeAction(name) {
    const room = this;
    return {
      send: (data, options) => {
        room._post({ kind: 'msg', name, data, to: options?.target });
        return Promise.resolve();
      },
      set onMessage(fn) { room.handlers[name] = fn; },
    };
  }

  leave() { this._post({ kind: 'leave' }); this.chan.close(); }
}

// ============================================================
// Thin wrapper that fans a single logical room out across every
// available transport. The same object serves host and clients;
// the game layer decides what to send/handle.
//
// Peers are deduplicated across transports by their (shared) peer
// id, so a player reachable on two transports still shows up once.
// Each peer is pinned to the transport that discovered it first
// ("primary transport"); we send to that one only, so no message
// is ever delivered twice.
// ============================================================
export class Net {
  constructor(code) {
    this.code = code;
    this.rooms = [];             // active underlying rooms
    this.peers = new Set();      // unified set of connected peer ids
    this.onPeerJoin = null;
    this.onPeerLeave = null;
    this.handlers = {};          // action name -> fn(data, peerId)
    this._actionsByRoom = new Map(); // room -> { name -> action }
    this._membersByRoom = new Map(); // room -> Set(peerId)
    this._primary = new Map();       // peerId -> room used for sending

    // staged-failover bookkeeping
    this._left = false;              // set by leave(); silences late probe events
    this._fallbackStarted = false;   // fallback relays opened at most once
    this._probeClient = null;        // Supabase health-probe client…
    this._probeChan = null;          // …and its throwaway channel
    this._probeTimer = null;         // "Supabase didn't connect in time" timer

    if (useLocalNet) {
      this._initRoom(new LocalRoom(code));
      return;
    }

    // Debug override (?net=…): bring the named transports up in parallel and
    // skip the staged flow entirely.
    const forced = overrideTransports();
    if (forced) {
      for (const t of forced) this._startTransport(t, code);
      if (this.rooms.length === 0) console.warn('[net] no transports could start (offline?)');
      return;
    }

    if (SUPABASE_TRANSPORT) {
      this._startSupabasePrimary(code);
    } else {
      // No Supabase configured: the public relays ARE the transport.
      console.warn('[net] Supabase signaling not configured — using public relays only');
      this._activateFallback(code, 'no Supabase project configured');
    }
  }

  // Attempt one transport; returns true if its room started. A construction
  // failure is logged and swallowed so it can't take the others down.
  _startTransport(transport, code) {
    try {
      this._initRoom(transport.join(code), transport.primary === true);
      return true;
    } catch (err) {
      console.warn(`[net] transport "${transport.name}" unavailable:`, err);
      return false;
    }
  }

  // Stage 1: bring Supabase up on its own, then watch its Realtime health.
  _startSupabasePrimary(code) {
    console.info('[net] Supabase is the primary signaling transport — connecting on its own…');
    if (!this._startTransport(SUPABASE_TRANSPORT, code)) {
      // Couldn't even construct the Supabase room: fail over immediately.
      this._activateFallback(code, 'Supabase transport failed to initialize');
      return;
    }
    this._probeSupabase(code);
  }

  // Stage 2: a throwaway Broadcast channel whose subscribe status we CAN read
  // (Trystero's supabase room hides its own). SUBSCRIBED => Supabase signaling
  // is live, so we stay on it alone. An error/timeout — or a later drop —
  // opens the fallback relays exactly once.
  _probeSupabase(code) {
    let client;
    try {
      client = createClient(SUPABASE.URL, SUPABASE.KEY);
    } catch (err) {
      this._activateFallback(code, `Supabase client init error: ${err?.message || err}`);
      return;
    }
    this._probeClient = client;
    const chan = client.channel(`dtc-health:${code}`, {
      config: { broadcast: { self: false } },
    });
    this._probeChan = chan;

    this._probeTimer = setTimeout(() => {
      this._probeTimer = null;
      this._activateFallback(code, `Supabase did not connect within ${SUPABASE_HEALTH_TIMEOUT / 1000}s`);
    }, SUPABASE_HEALTH_TIMEOUT);

    chan.subscribe((status, err) => {
      if (this._left) return; // our own teardown; ignore
      if (status === 'SUBSCRIBED') {
        if (this._probeTimer) { clearTimeout(this._probeTimer); this._probeTimer = null; }
        console.info('[net] Supabase signaling is live — running on Supabase alone; relays stay off unless it drops');
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        if (this._probeTimer) { clearTimeout(this._probeTimer); this._probeTimer = null; }
        this._activateFallback(code, `Supabase signaling ${status}${err ? `: ${err.message || err}` : ''}`);
      }
    });
  }

  // Stage 3: open the public-relay fallback pool. Runs at most once, whether
  // triggered by a failed probe, a dropped Supabase link, or no Supabase at
  // all. Supabase (if it recovers) stays primary for routing.
  _activateFallback(code, why) {
    if (this._fallbackStarted || this._left) return;
    this._fallbackStarted = true;
    console.warn(`[net] falling back to public relays (Nostr/WebTorrent/MQTT): ${why}`);
    for (const t of FALLBACK_TRANSPORTS) this._startTransport(t, code);
    if (this.rooms.length === 0) console.warn('[net] no transports could start (offline?)');
  }

  _initRoom(room, preferred = false) {
    this.rooms.push(room);
    const members = new Set();
    this._membersByRoom.set(room, members);

    const actions = {};
    for (const name of ACTION_NAMES) {
      const action = room.makeAction(name);
      // A message is sent over exactly one transport, so handlers can
      // fire directly — no cross-transport de-duplication needed here.
      action.onMessage = (data, context) => this.handlers[name]?.(data, context.peerId);
      actions[name] = action;
    }
    this._actionsByRoom.set(room, actions);

    room.onPeerJoin = (peerId) => {
      members.add(peerId);
      if (!this.peers.has(peerId)) {
        this.peers.add(peerId);
        this._primary.set(peerId, room);
        this.onPeerJoin?.(peerId);
      } else if (preferred && this._primary.get(peerId) !== room) {
        // Peer is already reachable via another transport, but our
        // preferred (Supabase) path just linked it too — route future
        // sends through this one. No join event: the peer is not new.
        this._primary.set(peerId, room);
      }
    };
    room.onPeerLeave = (peerId) => {
      members.delete(peerId);
      const stillOn = this.rooms.find((r) => this._membersByRoom.get(r)?.has(peerId));
      if (stillOn) {
        // Still reachable elsewhere: just repoint sends if the primary left.
        if (this._primary.get(peerId) === room) this._primary.set(peerId, stillOn);
        return;
      }
      if (this.peers.delete(peerId)) {
        this._primary.delete(peerId);
        this.onPeerLeave?.(peerId);
      }
    };
  }

  on(name, fn) { this.handlers[name] = fn; }

  _sendVia(room, name, data, target) {
    const action = this._actionsByRoom.get(room)?.[name];
    if (!action) return;
    try {
      const p = action.send(data, target != null ? { target } : undefined);
      p?.catch?.((err) => console.warn('[net] send failed', name, err));
    } catch (err) {
      console.warn('[net] send failed', name, err);
    }
  }

  send(name, data, target) {
    if (this.peers.size === 0) return;

    if (target != null) {
      const room = this._primary.get(target);
      if (room) this._sendVia(room, name, data, target);
      return;
    }

    // Broadcast. With a single transport we can fan out normally;
    // with several we address each peer on its primary transport so
    // nobody receives the same message twice.
    if (this.rooms.length === 1) {
      this._sendVia(this.rooms[0], name, data, undefined);
      return;
    }
    const byRoom = new Map(); // room -> [peerId]
    for (const peerId of this.peers) {
      const room = this._primary.get(peerId);
      if (!room) continue;
      const ids = byRoom.get(room);
      if (ids) ids.push(peerId);
      else byRoom.set(room, [peerId]);
    }
    for (const [room, ids] of byRoom) this._sendVia(room, name, data, ids);
  }

  leave() {
    this._left = true;
    if (this._probeTimer) { clearTimeout(this._probeTimer); this._probeTimer = null; }
    if (this._probeClient && this._probeChan) {
      try { this._probeClient.removeChannel(this._probeChan); } catch { /* ignore */ }
    }
    this._probeChan = null;
    this._probeClient = null;
    for (const room of this.rooms) {
      try { room.leave(); } catch { /* ignore */ }
    }
    this.rooms = [];
    this._actionsByRoom.clear();
    this._membersByRoom.clear();
    this._primary.clear();
    this.peers.clear();
  }
}
