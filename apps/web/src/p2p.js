import { NET } from '@dtc/shared/config.js';

// ============================================================
// Peer-to-peer acceleration mesh (WebRTC datachannels).
//
// This is NOT a return to the old serverless P2P architecture. The
// authoritative server still owns the simulation and still receives every
// input; this layer runs *alongside* it and carries exactly one thing:
// each player's own pose, straight to the other players in the room.
//
// Why it helps. A player's position is already client-declared — main.js
// predicts it locally and sends the resulting x/z/yaw to the server, which
// only clamps it (sim.setInput). So the same number can travel two ways:
//
//   via server:  me -> [long haul] -> server -> [long haul] -> you
//   via P2P:     me -> you
//
// When both players sit on the same continent and the server does not, the
// direct path is several times shorter, and its jitter is low enough that
// the receiving side can interpolate on a much shallower buffer. Nothing
// about trust changes: a peer can only claim the position it was already
// claiming to the server, and the server keeps deciding what that position
// *means* (collisions, aggro, damage).
//
// Why signalling rides the existing socket. The room already has a
// reliable, authenticated channel to every member, so there is no reason to
// discover peers through a public relay network — that discovery step, not
// WebRTC itself, is what made the earlier P2P setup flaky. The server
// forwards opaque SDP/ICE between two players in one room and does nothing
// else.
//
// Why failure is free. If negotiation never completes (symmetric NAT with
// no TURN, blocked UDP, a browser without WebRTC), no pose ever arrives,
// every peer stays marked stale, and the renderer keeps using the
// authoritative snapshot exactly as it does today. There is no fallback
// path to get wrong because the fallback is the normal path, always running.
// ============================================================

// Public STUN only. TURN would guarantee connectivity but costs money to
// run, and here a failed connection is not a broken match — it is simply
// the server path, which is what every player gets today. Point these at a
// TURN server via env if you ever want the last ~15% of links to succeed.
function iceServers() {
  const list = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  const url = import.meta.env?.VITE_TURN_URL;
  if (url) {
    list.push({
      urls: url,
      username: import.meta.env?.VITE_TURN_USER || undefined,
      credential: import.meta.env?.VITE_TURN_PASS || undefined,
    });
  }
  return list;
}

const supported = () => typeof RTCPeerConnection === 'function';

export class P2PMesh {
  // `signal(to, data)` hands a payload to the transport (net.js -> socket).
  constructor({ selfId, signal }) {
    this.selfId = selfId;
    this.signal = signal;
    this.peers = new Map();   // peerId -> peer record
    this.onPose = null;       // (peerId, pose) => {}
    this.onJump = null;       // (peerId, dur) => {}
    this.enabled = NET.P2P && supported();
    this._pingTimer = null;
    if (this.enabled) {
      this._pingTimer = setInterval(() => this._probe(), NET.P2P_PING_INTERVAL * 1000);
    }
  }

  // Reconcile the mesh against the room roster (driven by the lobby).
  setPeers(ids) {
    if (!this.enabled) return;
    const want = new Set(ids);
    for (const id of want) if (!this.peers.has(id)) this._connect(id);
    for (const id of [...this.peers.keys()]) if (!want.has(id)) this._drop(id);
  }

  // ---- connection setup ------------------------------------------------

  // Both sides learn about each other at the same moment, so something has
  // to break the tie or they trade offers and collide. Comparing ids is
  // enough: exactly one side of any pair is the lower one.
  _isOfferer(peerId) { return this.selfId < peerId; }

  // `asAnswerer` forces the passive role regardless of id order — used when
  // an offer arrives for a link we already had (the other side reconnected
  // and rebuilt its mesh), where counter-offering would just collide.
  _connect(peerId, asAnswerer = false) {
    let pc;
    try {
      pc = new RTCPeerConnection({ iceServers: iceServers() });
    } catch {
      this.enabled = false;   // no WebRTC here — server path handles everything
      return null;
    }

    const peer = {
      id: peerId, pc, dc: null,
      pendingIce: [],         // candidates that beat the remote description
      haveRemote: false,
      rtt: 0, lastRx: 0, open: false,
    };
    this.peers.set(peerId, peer);

    pc.onicecandidate = (e) => {
      if (e.candidate) this.signal(peerId, { ice: e.candidate });
    };
    pc.onconnectionstatechange = () => {
      // A dead link is not an error worth surfacing: mark it closed and let
      // the renderer fall back. A later lobby update may retry it.
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        peer.open = false;
      }
    };

    if (!asAnswerer && this._isOfferer(peerId)) {
      // unreliable + unordered: a stale pose is worthless, so never spend
      // latency retransmitting one — the next packet is 33ms away
      const dc = pc.createDataChannel('dtc', { ordered: false, maxRetransmits: 0 });
      this._bindChannel(peer, dc);
      this._negotiate(peer);
    } else {
      pc.ondatachannel = (e) => this._bindChannel(peer, e.channel);
    }
    return peer;
  }

  async _negotiate(peer) {
    try {
      const offer = await peer.pc.createOffer();
      await peer.pc.setLocalDescription(offer);
      this.signal(peer.id, { sdp: peer.pc.localDescription });
    } catch { /* link stays down; server path continues */ }
  }

  _bindChannel(peer, dc) {
    peer.dc = dc;
    dc.binaryType = 'arraybuffer';
    dc.onopen = () => { peer.open = true; };
    dc.onclose = () => { peer.open = false; };
    dc.onerror = () => { peer.open = false; };
    dc.onmessage = (e) => this._receive(peer, e.data);
  }

  // Inbound signalling, routed by the server and stamped with the sender.
  async onSignal(from, data) {
    if (!this.enabled || !data) return;
    let peer = this.peers.get(from);
    // A fresh offer for a link we already negotiated means the other side
    // rebuilt its mesh (it reconnected). Renegotiating in place would fight
    // the existing description, so start that link over as the answerer.
    if (peer && data.sdp?.type === 'offer' && peer.haveRemote) {
      this._drop(from);
      peer = null;
    }
    // an offer can also land before the lobby update that announces the peer
    if (!peer) peer = this._connect(from, data.sdp?.type === 'offer');
    if (!peer) return;

    try {
      if (data.sdp) {
        await peer.pc.setRemoteDescription(data.sdp);
        peer.haveRemote = true;
        // candidates that arrived before the description could be applied
        for (const c of peer.pendingIce.splice(0)) {
          try { await peer.pc.addIceCandidate(c); } catch { /* stale */ }
        }
        if (data.sdp.type === 'offer') {
          const answer = await peer.pc.createAnswer();
          await peer.pc.setLocalDescription(answer);
          this.signal(from, { sdp: peer.pc.localDescription });
        }
      } else if (data.ice) {
        if (peer.haveRemote) await peer.pc.addIceCandidate(data.ice);
        else peer.pendingIce.push(data.ice);
      }
    } catch { /* malformed or out-of-order — the link just stays down */ }
  }

  _drop(id) {
    const peer = this.peers.get(id);
    if (!peer) return;
    try { peer.dc?.close(); } catch { /* already gone */ }
    try { peer.pc.close(); } catch { /* already gone */ }
    this.peers.delete(id);
  }

  // ---- traffic ---------------------------------------------------------

  _send(peer, msg) {
    if (!peer.open || peer.dc?.readyState !== 'open') return;
    try { peer.dc.send(JSON.stringify(msg)); } catch { peer.open = false; }
  }

  _broadcast(msg) {
    if (!this.enabled) return;
    for (const peer of this.peers.values()) this._send(peer, msg);
  }

  // our own predicted pose, at NET.P2P_HZ
  sendPose(x, z, yaw, moving) {
    this._broadcast({ k: 'p', x, z, y: yaw, m: moving ? 1 : 0 });
  }

  // a jump is a discrete hop the sender predicts locally; peers need to
  // start the same arc, and the P2P copy beats the server event
  sendJump(dur) { this._broadcast({ k: 'j', d: dur }); }

  // Probe live links, and retry dead ones. A link can fail for reasons that
  // clear up (a candidate that lost a race, a network that changed), and
  // since the match runs fine without it there is no cost to trying again —
  // only the offerer retries, so the two sides don't rebuild in lockstep.
  _probe() {
    const t = Date.now();
    for (const peer of [...this.peers.values()]) {
      if (peer.pc.connectionState === 'failed') {
        const id = peer.id;
        this._drop(id);
        if (this._isOfferer(id)) this._connect(id);
        continue;
      }
      this._send(peer, { k: 'q', t });
    }
  }

  _receive(peer, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    peer.lastRx = performance.now() / 1000;
    switch (msg.k) {
      case 'p':
        this.onPose?.(peer.id, { x: msg.x, z: msg.z, yaw: msg.y, moving: msg.m === 1 });
        break;
      case 'j':
        this.onJump?.(peer.id, msg.d);
        break;
      case 'q':
        this._send(peer, { k: 'a', t: msg.t });   // echo the probe
        break;
      case 'a':
        peer.rtt = Date.now() - msg.t;
        break;
      default: break;
    }
  }

  // ---- introspection (netstat overlay) ---------------------------------

  stats() {
    const now = performance.now() / 1000;
    const out = [];
    for (const peer of this.peers.values()) {
      out.push({
        id: peer.id,
        state: peer.pc.connectionState,
        live: peer.open && (now - peer.lastRx) < NET.P2P_STALE,
        rtt: peer.rtt,
      });
    }
    return out;
  }

  destroy() {
    if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null; }
    for (const id of [...this.peers.keys()]) this._drop(id);
  }
}
