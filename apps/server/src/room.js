import { Sim } from '@dtc/shared/sim/sim.js';
import { NET, SIM_DT } from '@dtc/shared/config.js';
import { EV, leanSnap } from '@dtc/shared/protocol.js';

// ============================================================
// One authoritative match. Owns a headless Sim, drives it at a
// fixed timestep, and broadcasts snapshots/events to the room.
//
// The server is the ONLY authority: there is no "host player".
// If the owner (the player allowed to start waves) disconnects,
// ownership transfers and the match keeps running.
// ============================================================

const SNAP_INTERVAL = 1 / NET.SNAP_HZ;
// how long a disconnected player's hero is kept so a brief drop /
// reconnect (tab reload, flaky wifi) restores the SAME character
// instead of dropping them from the match.
const GRACE_MS = 20000;
// how long an empty room lingers before it is torn down.
const EMPTY_MS = 25000;

const now = () => Date.now();
const randId = () => Math.random().toString(36).slice(2, 10);
const randToken = () => Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);

export class Room {
  constructor(code, io) {
    this.code = code;
    this.io = io;
    this.sim = new Sim();
    this.players = new Map();   // playerId -> { playerId, token, socketId, character, graceTimer }
    this.tokenToId = new Map(); // token -> playerId (survives a disconnect within the grace window)
    this.ownerId = null;
    this.started = false;
    this.onEmpty = null;        // set by the hub to unregister a dead room

    this._loop = null;
    this._acc = 0;
    this._last = 0;
    this._time = 0;             // seconds since the loop started
    this._lastSnap = 0;
    this._lastStatic = 0;
    this._emptyTimer = null;
  }

  // Fresh join or a reconnect (matching token) that reclaims the same hero.
  addOrRejoin(socket, character, token) {
    if (this._emptyTimer) { clearTimeout(this._emptyTimer); this._emptyTimer = null; }

    if (token && this.tokenToId.has(token)) {
      const playerId = this.tokenToId.get(token);
      const entry = this.players.get(playerId);
      if (entry) {
        if (entry.graceTimer) { clearTimeout(entry.graceTimer); entry.graceTimer = null; }
        entry.socketId = socket.id;
        if (character) entry.character = character;
        if (!this.sim.getPlayer(playerId)) this._addToSim(playerId, entry.character);
        return { playerId, token, rejoined: true };
      }
    }

    const playerId = randId();
    const tk = randToken();
    this.players.set(playerId, { playerId, token: tk, socketId: socket.id, character, graceTimer: null });
    this.tokenToId.set(tk, playerId);
    this._addToSim(playerId, character);
    if (!this.ownerId) this.ownerId = playerId;
    return { playerId, token: tk, rejoined: false };
  }

  _addToSim(playerId, character) {
    const c = character || {};
    this.sim.addPlayer(playerId, c.name, c.cls, c.colors, c.pet, c.loadout);
  }

  // owner-only: leave the lobby and start the match (lobby -> build)
  begin() {
    if (this.started) return;
    this.sim.start();
    this.started = true;
    this._startLoop();
    this.broadcastLobby();
  }

  handleAct(playerId, act) {
    if (!act || typeof act !== 'object') return;
    if (act.t === 'begin') { if (playerId === this.ownerId) this.begin(); return; }
    // starting a wave / restarting after a defeat is owner-only; everything
    // else (build, jump, pet/weapon swaps, …) is free for any player.
    if ((act.t === 'start' || act.t === 'restart') && playerId !== this.ownerId) return;
    this.sim.handleAction(playerId, act);
  }

  setInput(playerId, data) { this.sim.setInput(playerId, data); }

  // A socket dropped: keep the hero for the grace window, hand off ownership
  // immediately so control isn't stuck on a ghost.
  disconnect(playerId) {
    const entry = this.players.get(playerId);
    if (!entry) return;
    entry.socketId = null;
    if (this.ownerId === playerId) {
      const next = [...this.players.values()].find((e) => e.socketId);
      if (next) this.ownerId = next.playerId;
    }
    if (entry.graceTimer) clearTimeout(entry.graceTimer);
    entry.graceTimer = setTimeout(() => this._removePlayer(playerId), GRACE_MS);
    this.broadcastLobby();
    this._scheduleEmptyCheck();
  }

  _removePlayer(playerId) {
    const entry = this.players.get(playerId);
    if (!entry) return;
    this.sim.removePlayer(playerId);
    this.tokenToId.delete(entry.token);
    this.players.delete(playerId);
    if (this.ownerId === playerId) {
      const next = [...this.players.values()][0];
      this.ownerId = next ? next.playerId : null;
    }
    this.broadcastLobby();
    this._scheduleEmptyCheck();
  }

  connectedCount() {
    let n = 0;
    for (const e of this.players.values()) if (e.socketId) n++;
    return n;
  }

  _scheduleEmptyCheck() {
    if (this.connectedCount() > 0) return;
    if (this._emptyTimer) return;
    this._emptyTimer = setTimeout(() => {
      if (this.connectedCount() === 0) this.onEmpty?.();
    }, EMPTY_MS);
  }

  lobbyPayload() {
    const players = this.sim.players.entities.map((p) => ({
      id: p.id, name: p.name, cls: p.cls, colors: p.colors, host: p.id === this.ownerId,
    }));
    return { code: this.code, ownerId: this.ownerId, players, started: this.started };
  }

  broadcastLobby() { this.io.to(this.code).emit(EV.LOBBY, this.lobbyPayload()); }

  // full snapshot for a late joiner (never a lean one — they have no cache yet)
  currentSnapshot() { return this.started ? this.sim.buildSnapshot() : null; }

  _startLoop() {
    if (this._loop) return;
    this._last = now();
    this._loop = setInterval(() => this._tick(), Math.round(SIM_DT * 1000));
  }

  _tick() {
    const t = now();
    let dt = (t - this._last) / 1000;
    this._last = t;
    if (dt > 0.25) dt = 0.25; // clamp after a stall so the sim never leaps
    this._acc += dt;
    while (this._acc >= SIM_DT) {
      this.sim.step(SIM_DT);
      this._acc -= SIM_DT;
      this._time += SIM_DT;
    }

    const events = this.sim.drainEvents();
    if (events.length) this.io.to(this.code).emit(EV.EV, events);

    if (this._time - this._lastSnap >= SNAP_INTERVAL) {
      this._lastSnap = this._time;
      const snap = this.sim.buildSnapshot();
      // include the static geometry periodically; lean ticks omit it and the
      // client re-merges from its cache
      if (this._time - this._lastStatic >= NET.STATIC_INTERVAL) {
        this._lastStatic = this._time;
        this.io.to(this.code).emit(EV.SNAP, snap);
      } else {
        this.io.to(this.code).emit(EV.SNAP, leanSnap(snap));
      }
    }
  }

  destroy() {
    if (this._loop) { clearInterval(this._loop); this._loop = null; }
    for (const e of this.players.values()) if (e.graceTimer) clearTimeout(e.graceTimer);
    if (this._emptyTimer) clearTimeout(this._emptyTimer);
  }
}
