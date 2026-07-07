'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateSeven, compareEvaluations, settleSidePots } = require('../src/poker');

function cards(text) {
  const rankMap = { T: 10, J: 11, Q: 12, K: 13, A: 14 };
  return text.trim().split(/\s+/).map((token) => ({
    rank: rankMap[token[0]] || Number(token[0]),
    suit: token[1].toUpperCase()
  }));
}

test('royal flush beats four of a kind', () => {
  const royal = evaluateSeven(cards('AS KS QS JS TS 2D 3C'));
  const quads = evaluateSeven(cards('9S 9H 9D 9C AS 2D 3C'));
  assert.equal(royal.name, '同花顺');
  assert.equal(quads.name, '四条');
  assert.equal(compareEvaluations(royal, quads), 1);
});

test('wheel straight is recognized as five-high', () => {
  const wheel = evaluateSeven(cards('AS 2H 3D 4C 5S KD QH'));
  assert.equal(wheel.name, '顺子');
  assert.deepEqual(wheel.vector, [4, 5]);
});

test('side pots are split among eligible winners', () => {
  const board = cards('2S 3S 4S 9D KC');
  const players = [
    { id: 'a', seat: 0, totalBet: 100, folded: false, hand: cards('AS 5S') },
    { id: 'b', seat: 1, totalBet: 300, folded: false, hand: cards('KH KD') },
    { id: 'c', seat: 2, totalBet: 300, folded: false, hand: cards('9H 9C') }
  ];
  const result = settleSidePots(players, board, 0);
  assert.equal(result.payouts.get('a'), 300);
  assert.equal(result.payouts.get('b'), 400);
  assert.equal(result.payouts.get('c'), 0);
});
