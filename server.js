'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const express = require('express');
const { Server } = require('socket.io');
const { GameRoom, MAX_PLAYERS } = require('./src/game-room');

const PORT = Number(process.env.PORT) || 3000;
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  pingTimeout: 20000,
  pingInterval: 10000
});

const rooms = new Map();
const socketSessions = new Map();

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    if (filePath.endsWith('sw.js') || filePath.endsWith('manifest.webmanifest')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  }
}));
app.get('/health', (_req, res) => res.json({ ok: true, rooms: rooms.size, time: new Date().toISOString() }));

function makeCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let attempt = 0; attempt < 100; attempt += 1) {
    let code = '';
    for (let i = 0; i < 6; i += 1) code += alphabet[crypto.randomInt(alphabet.length)];
    if (!rooms.has(code)) return code;
  }
  throw new Error('暂时无法生成房间号');
}

function makeId() {
  return crypto.randomUUID();
}

function emitRoom(room) {
  for (const player of room.players) {
    if (!player.socketId) continue;
    io.to(player.socketId).emit('roomState', room.publicStateFor(player.token));
  }
  emitLobby();
}

function lobbyData() {
  return [...rooms.values()]
    .filter((room) => room.phase === 'waiting')
    .map((room) => ({
      code: room.code,
      players: room.players.filter((p) => p.connected).length,
      maxPlayers: MAX_PLAYERS,
      handNo: room.handNo
    }))
    .filter((room) => room.players < room.maxPlayers)
    .slice(0, 30);
}

function emitLobby(target = io) {
  target.emit('lobbyRooms', lobbyData());
}

function requireSession(socket) {
  const session = socketSessions.get(socket.id);
  if (!session) throw new Error('请先加入房间');
  const room = rooms.get(session.roomCode);
  if (!room) throw new Error('房间不存在');
  return { session, room };
}

function replyError(callback, error) {
  if (typeof callback === 'function') callback({ ok: false, error: error.message || '操作失败' });
}

io.on('connection', (socket) => {
  emitLobby(socket);

  socket.on('requestLobby', () => emitLobby(socket));

  socket.on('createRoom', (payload = {}, callback) => {
    try {
      const token = String(payload.token || makeId()).slice(0, 100);
      const code = makeCode();
      const room = new GameRoom(code, token, emitRoom);
      rooms.set(code, room);
      socket.join(code);
      const player = room.addOrReconnectPlayer({
        id: makeId(), token, socketId: socket.id, name: payload.name
      });
      socketSessions.set(socket.id, { roomCode: code, token, playerId: player.id });
      callback?.({ ok: true, code, token });
      emitRoom(room);
    } catch (error) {
      replyError(callback, error);
    }
  });

  socket.on('joinRoom', (payload = {}, callback) => {
    try {
      const code = String(payload.code || '').trim().toUpperCase();
      const room = rooms.get(code);
      if (!room) throw new Error('没有找到这个房间');
      const token = String(payload.token || makeId()).slice(0, 100);
      socket.join(code);
      const player = room.addOrReconnectPlayer({
        id: makeId(), token, socketId: socket.id, name: payload.name
      });
      socketSessions.set(socket.id, { roomCode: code, token, playerId: player.id });
      callback?.({ ok: true, code, token });
      emitRoom(room);
    } catch (error) {
      replyError(callback, error);
    }
  });

  socket.on('startGame', (_payload, callback) => {
    try {
      const { session, room } = requireSession(socket);
      if (!room.canStart(session.token)) throw new Error('只有房主可以开始，且至少需要两名在线玩家');
      room.startHand();
      callback?.({ ok: true });
    } catch (error) {
      replyError(callback, error);
    }
  });

  socket.on('playerAction', (payload = {}, callback) => {
    try {
      const { session, room } = requireSession(socket);
      room.performAction(session.playerId, payload.action, payload.amount);
      callback?.({ ok: true });
    } catch (error) {
      replyError(callback, error);
    }
  });

  socket.on('requestState', (_payload, callback) => {
    try {
      const { session, room } = requireSession(socket);
      socket.emit('roomState', room.publicStateFor(session.token));
      callback?.({ ok: true });
    } catch (error) {
      replyError(callback, error);
    }
  });

  socket.on('disconnect', () => {
    const session = socketSessions.get(socket.id);
    socketSessions.delete(socket.id);
    if (!session) return;
    const room = rooms.get(session.roomCode);
    if (!room) return;
    room.disconnect(socket.id);

    // Delete completely abandoned waiting rooms after a grace period.
    setTimeout(() => {
      const current = rooms.get(room.code);
      if (current && current.phase === 'waiting' && current.players.every((p) => !p.connected)) {
        current.clearTimer();
        rooms.delete(current.code);
        emitLobby();
      }
    }, 10 * 60 * 1000);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Texas Hold'em server running at http://localhost:${PORT}`);
});
