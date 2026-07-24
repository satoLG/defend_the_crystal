import { io } from 'socket.io-client';
import { EV } from '@dtc/shared/protocol.js';
import { normalizeRoomCode } from '@dtc/shared/utils.js';

// ============================================================
// Client transport — a thin wrapper over a single Socket.IO
// connection to the authoritative game server.
//
// This replaces the old peer-to-peer WebRTC/Trystero mesh. There
// is no "host player" anymore: the server owns the simulation, and
// every browser (including whoever created the room) is a plain
// client. All traffic rides one reliable WebSocket, so matches form
// on any network — no STUN/TURN/NAT to fail.
//
// `selfId` is assigned by the server on WELCOME and exposed as a live
// binding, so importers that read it at call time see the real id.
// ============================================================

export let selfId = null;

// Server URL resolution (mirrors the game's existing debug-override style):
//   ?server=<url>  — per-tab override (point a Vercel preview at a Render
//                    preview, or a local build at a deployed server)
//   VITE_SERVER_URL — build-time default (set per environment on Vercel)
//   otherwise       — same host on :3001 (local dev)
function resolveServerUrl() {
  try {
    const q = new URLSearchParams(location.search).get('server');
    if (q) return q;
  } catch { /* no location */ }
  const env = import.meta.env?.VITE_SERVER_URL;
  if (env) return env;
  return `http://${location.hostname}:3001`;
}

export class Net {
  constructor(code, { create = false, character = null } = {}) {
    this.code = code ? normalizeRoomCode(code) : null;
    this.create = create;
    this.character = character;
    this.handlers = {};       // event name -> fn(data)
    this.peers = new Set();   // ids of the OTHER players (derived from lobby)
    this.onPeerJoin = null;
    this.onPeerLeave = null;
    this.onReady = null;      // (welcomeInfo) => {} — fired once identity is assigned
    this.onStatus = null;     // (status) => {} — 'connected'|'reconnecting'|'error'
    this.isOwner = false;

    this._left = false;
    this._welcomed = false;
    this._token = null;       // reconnect token: reclaims the same hero on a drop

    this.socket = io(resolveServerUrl(), {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 800,
      reconnectionDelayMax: 4000,
      timeout: 60000,         // tolerate a Render free-tier cold start (~30-50s)
    });

    this.socket.on('connect', () => this._enter());
    this.socket.io.on('reconnect_attempt', () => { if (!this._left) this.onStatus?.('reconnecting'); });
    this.socket.on('connect_error', () => { if (!this._left) this.onStatus?.('error'); });

    this.socket.on(EV.WELCOME, (info) => {
      selfId = info.selfId;
      this.code = info.code;
      this._token = info.token;
      this._welcomed = true;
      this.isOwner = !!info.isOwner;
      this.onStatus?.('connected');
      this.onReady?.(info);
    });

    this.socket.on(EV.LOBBY, (data) => {
      this.isOwner = data.ownerId === selfId;
      this._updatePeers(data.players || []);
      this.handlers[EV.LOBBY]?.(data);
    });
    this.socket.on(EV.SNAP, (d) => this.handlers[EV.SNAP]?.(d));
    this.socket.on(EV.EV, (d) => this.handlers[EV.EV]?.(d));
    this.socket.on(EV.ERROR, (d) => this.handlers[EV.ERROR]?.(d));
  }

  // On the first connect we CREATE (owner) or JOIN; every later reconnect
  // re-JOINs the same room with our token so the server restores our hero.
  _enter() {
    if (this._left) return;
    if (this.create && !this._welcomed) {
      this.socket.emit(EV.CREATE, { character: this.character });
    } else {
      this.socket.emit(EV.JOIN, { code: this.code, character: this.character, token: this._token });
    }
  }

  _updatePeers(players) {
    const next = new Set(players.filter((p) => p.id !== selfId).map((p) => p.id));
    for (const id of next) {
      if (!this.peers.has(id)) { this.peers.add(id); this.onPeerJoin?.(id); }
    }
    for (const id of [...this.peers]) {
      if (!next.has(id)) { this.peers.delete(id); this.onPeerLeave?.(id); }
    }
  }

  on(name, fn) { this.handlers[name] = fn; }

  // target is ignored (kept for call-site compatibility) — the server is the
  // single destination for every input/action.
  send(name, data) { if (!this._left) this.socket.emit(name, data); }

  leave() {
    this._left = true;
    try { this.socket.emit(EV.LEAVE); } catch { /* ignore */ }
    try { this.socket.disconnect(); } catch { /* ignore */ }
    this.peers.clear();
    this.handlers = {};
  }
}
