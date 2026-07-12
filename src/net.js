import { joinRoom, selfId as trysteroId } from 'trystero';
import { NET } from './config.js';

const useLocalNet = new URLSearchParams(location.search).has('localnet');
export const selfId = useLocalNet
  ? `local-${Math.random().toString(36).slice(2, 10)}`
  : trysteroId;

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
// Thin wrapper around a Trystero room. Same object serves host
// and clients; the game layer decides what to send/handle.
// Serverless WebRTC: peers find each other through public
// Nostr relays using the room code, then talk directly.
// ============================================================
export class Net {
  constructor(code) {
    this.code = code;
    this.room = null;
    this.peers = new Set();
    this.onPeerJoin = null;
    this.onPeerLeave = null;
    this.handlers = {};
    this._actions = {};

    try {
      this.room = useLocalNet
        ? new LocalRoom(code)
        : joinRoom({ appId: NET.APP_ID }, code);
    } catch (err) {
      console.warn('[net] could not join room (offline?):', err);
      return;
    }

    for (const name of ['hello', 'input', 'act', 'snap', 'ev', 'lobby']) {
      const action = this.room.makeAction(name);
      action.onMessage = (data, context) => this.handlers[name]?.(data, context.peerId);
      this._actions[name] = action;
    }

    this.room.onPeerJoin = (peerId) => {
      this.peers.add(peerId);
      this.onPeerJoin?.(peerId);
    };
    this.room.onPeerLeave = (peerId) => {
      this.peers.delete(peerId);
      this.onPeerLeave?.(peerId);
    };
  }

  on(name, fn) { this.handlers[name] = fn; }

  send(name, data, target) {
    if (!this.room || this.peers.size === 0) return;
    try {
      this._actions[name].send(data, target ? { target } : undefined)
        .catch((err) => console.warn('[net] send failed', name, err));
    } catch (err) {
      console.warn('[net] send failed', name, err);
    }
  }

  leave() {
    try { this.room?.leave(); } catch { /* ignore */ }
    this.room = null;
    this.peers.clear();
  }
}
