'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { GameRoom } = require('../src/game-room');

test('two connected players can start a synchronized hand', () => {
  const room = new GameRoom('ABC123', 'token-a', () => {});
  const a = room.addOrReconnectPlayer({ id: 'a', token: 'token-a', socketId: 'socket-a', name: '甲' });
  const b = room.addOrReconnectPlayer({ id: 'b', token: 'token-b', socketId: 'socket-b', name: '乙' });

  assert.equal(room.canStart('token-a'), true);
  room.startHand();
  assert.equal(room.phase, 'preflop');
  assert.equal(a.hand.length, 2);
  assert.equal(b.hand.length, 2);
  assert.equal(room.potAmount(), 30);
  assert.ok(room.currentPlayerId);

  const stateA = room.publicStateFor('token-a');
  const stateB = room.publicStateFor('token-b');
  assert.equal(stateA.players.find((p) => p.id === 'a').hand.length, 2);
  assert.equal(stateA.players.find((p) => p.id === 'b').hand.length, 0);
  assert.equal(stateB.players.find((p) => p.id === 'b').hand.length, 2);
  room.clearTimer();
});

test('folding heads-up awards the complete pot and preserves total chips', () => {
  const room = new GameRoom('ABC123', 'token-a', () => {});
  room.addOrReconnectPlayer({ id: 'a', token: 'token-a', socketId: 'socket-a', name: '甲' });
  room.addOrReconnectPlayer({ id: 'b', token: 'token-b', socketId: 'socket-b', name: '乙' });
  room.startHand();
  const actor = room.currentPlayerId;
  room.performAction(actor, 'fold');
  assert.equal(room.phase, 'showdown');
  assert.equal(room.players.reduce((sum, p) => sum + p.chips, 0), 10000);
  assert.match(room.lastResult.title, /赢得底池/);
  room.clearTimer();
});
