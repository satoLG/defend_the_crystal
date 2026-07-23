import { EV } from '@dtc/shared/protocol.js';
import { makeRoomCode, normalizeRoomCode } from '@dtc/shared/utils.js';
import { Room } from './room.js';

// ============================================================
// Connection router: owns the set of live rooms and wires each
// socket's events to its room. All game logic lives in Room/Sim;
// this layer only creates/finds rooms and forwards messages.
// ============================================================

export function attachHub(io) {
  const rooms = new Map(); // code -> Room

  function freshCode() {
    let code;
    do { code = makeRoomCode(); } while (rooms.has(code));
    return code;
  }

  io.on('connection', (socket) => {
    let room = null;
    let playerId = null;

    const enter = (r, res) => {
      room = r;
      playerId = res.playerId;
      socket.join(r.code);
      socket.emit(EV.WELCOME, {
        selfId: playerId, code: r.code, token: res.token, isOwner: playerId === r.ownerId,
      });
      r.broadcastLobby();
      // a late joiner into a running match needs a full snapshot to start
      // rendering immediately (its cache is empty, so it can't take a lean one)
      if (r.started) {
        const snap = r.currentSnapshot();
        if (snap) socket.emit(EV.SNAP, snap);
      }
    };

    socket.on(EV.CREATE, (msg = {}) => {
      const code = freshCode();
      const r = new Room(code, io);
      r.onEmpty = () => { r.destroy(); rooms.delete(code); };
      rooms.set(code, r);
      enter(r, r.addOrRejoin(socket, msg.character, null));
    });

    socket.on(EV.JOIN, (msg = {}) => {
      const r = rooms.get(normalizeRoomCode(msg.code || ''));
      if (!r) { socket.emit(EV.ERROR, { code: 'no_room', message: 'Room not found' }); return; }
      enter(r, r.addOrRejoin(socket, msg.character, msg.token));
    });

    socket.on(EV.INPUT, (data) => { if (room && playerId) room.setInput(playerId, data); });

    socket.on(EV.ACT, (act) => {
      if (!room || !playerId) return;
      room.handleAct(playerId, act);
      // roster/owner-visible transitions the tick loop doesn't cover
      if (act && (act.t === 'restart')) room.broadcastLobby();
    });

    socket.on(EV.LEAVE, () => {
      if (room && playerId) room.disconnect(playerId);
      room = null; playerId = null;
    });

    socket.on('disconnect', () => {
      if (room && playerId) room.disconnect(playerId);
    });
  });
}
