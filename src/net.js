import { joinRoom as joinNostr, selfId as trysteroId } from 'trystero';
import { joinRoom as joinTorrent } from '@trystero-p2p/torrent';
import { joinRoom as joinMqtt } from '@trystero-p2p/mqtt';
import { NET } from './config.js';

const useLocalNet = new URLSearchParams(location.search).has('localnet');
export const selfId = useLocalNet
  ? `local-${Math.random().toString(36).slice(2, 10)}`
  : trysteroId;

// ============================================================
// Robust peer discovery.
//
// Trystero's default Nostr strategy only tries a handful of
// relays, chosen deterministically from the app id. When those
// specific relays are down or reject events (a common, transient
// situation with public Nostr infra), two peers never find each
// other even though plenty of *other* relays are healthy.
//
// To make connecting far more reliable we:
//   1. Feed the Nostr strategy a large, curated relay pool (both
//      peers use the exact same list, so overlap is guaranteed
//      and a single healthy relay is enough to connect).
//   2. Join the same room over several *independent* transports
//      at once (Nostr relays, WebTorrent trackers, MQTT brokers).
//      A peer is discovered as soon as ANY transport links them,
//      so all of them have to be down for a match to fail.
//
// The transports run in parallel and are merged behind one Net
// interface; the game layer is unaware of the plumbing.
// ============================================================

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

// Each transport is a named joiner. They are attempted in order and
// any that fails to initialize is skipped, so a single broken
// strategy can never take the others down with it.
const TRANSPORTS = [
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

// Optional override for debugging: ?net=nostr,torrent limits which
// transports are used. Unknown names are ignored.
function activeTransports() {
  const wanted = new URLSearchParams(location.search).get('net');
  if (!wanted) return TRANSPORTS;
  const allow = new Set(wanted.split(',').map((s) => s.trim().toLowerCase()));
  const picked = TRANSPORTS.filter((t) => allow.has(t.name));
  return picked.length ? picked : TRANSPORTS;
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

    if (useLocalNet) {
      this._initRoom(new LocalRoom(code));
      return;
    }

    for (const transport of activeTransports()) {
      try {
        this._initRoom(transport.join(code));
      } catch (err) {
        console.warn(`[net] transport "${transport.name}" unavailable:`, err);
      }
    }
    if (this.rooms.length === 0) {
      console.warn('[net] no transports could start (offline?)');
    }
  }

  _initRoom(room) {
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
