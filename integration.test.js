'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { io } = require('socket.io-client');

function emitAck(socket, event, payload = {}) {
  return new Promise((resolve, reject) => {
    socket.timeout(3000).emit(event, payload, (error, response) => {
      if (error) return reject(error);
      if (!response?.ok) return reject(new Error(response?.error || `${event} failed`));
      resolve(response);
    });
  });
}

function waitForState(socket, predicate) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off('roomState', handler);
      reject(new Error('Timed out waiting for room state'));
    }, 4000);
    const handler = (state) => {
      if (!predicate(state)) return;
      clearTimeout(timeout);
      socket.off('roomState', handler);
      resolve(state);
    };
    socket.on('roomState', handler);
  });
}

test('two real Socket.IO clients create, join, and start one hand', { timeout: 12000 }, async (t) => {
  const port = 32000 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(() => child.kill('SIGTERM'));

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server did not start')), 4000);
    child.stdout.on('data', (chunk) => {
      if (String(chunk).includes('server running')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once('exit', (code) => reject(new Error(`Server exited early: ${code}`)));
  });

  const url = `http://127.0.0.1:${port}`;
  const a = io(url, { transports: ['websocket'], reconnection: false });
  const b = io(url, { transports: ['websocket'], reconnection: false });
  t.after(() => { a.close(); b.close(); });

  await Promise.all([
    new Promise((resolve, reject) => { a.once('connect', resolve); a.once('connect_error', reject); }),
    new Promise((resolve, reject) => { b.once('connect', resolve); b.once('connect_error', reject); })
  ]);

  const created = await emitAck(a, 'createRoom', { name: '测试甲' });
  await emitAck(b, 'joinRoom', { name: '测试乙', code: created.code });
  const preflop = waitForState(a, (state) => state.phase === 'preflop');
  await emitAck(a, 'startGame');
  const state = await preflop;

  assert.equal(state.players.length, 2);
  assert.equal(state.pot, 30);
  assert.ok(state.currentPlayerId);
  assert.equal(state.players.find((p) => p.id === state.meId).hand.length, 2);
  assert.equal(state.players.find((p) => p.id !== state.meId).hand.length, 0);
});
