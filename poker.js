'use strict';

const crypto = require('node:crypto');

const SUITS = ['S', 'H', 'D', 'C'];
const RANKS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
const CATEGORY_NAMES = [
  '高牌', '一对', '两对', '三条', '顺子',
  '同花', '葫芦', '四条', '同花顺'
];

function createDeck() {
  return SUITS.flatMap((suit) => RANKS.map((rank) => ({ rank, suit })));
}

function shuffleDeck(deck) {
  const result = deck.map((card) => ({ ...card }));
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function straightHigh(uniqueRanksDesc) {
  const ranks = [...new Set(uniqueRanksDesc)].sort((a, b) => b - a);
  if (ranks.includes(14)) ranks.push(1);
  for (let i = 0; i <= ranks.length - 5; i += 1) {
    if (ranks[i] - ranks[i + 4] === 4) return ranks[i];
  }
  return 0;
}

function evaluateFive(cards) {
  if (!Array.isArray(cards) || cards.length !== 5) {
    throw new Error('evaluateFive requires exactly five cards');
  }

  const ranks = cards.map((c) => c.rank).sort((a, b) => b - a);
  const counts = new Map();
  for (const rank of ranks) counts.set(rank, (counts.get(rank) || 0) + 1);

  const groups = [...counts.entries()]
    .map(([rank, count]) => ({ rank, count }))
    .sort((a, b) => b.count - a.count || b.rank - a.rank);

  const flush = cards.every((c) => c.suit === cards[0].suit);
  const straight = straightHigh(ranks);

  let vector;
  if (flush && straight) {
    vector = [8, straight];
  } else if (groups[0].count === 4) {
    vector = [7, groups[0].rank, groups[1].rank];
  } else if (groups[0].count === 3 && groups[1].count === 2) {
    vector = [6, groups[0].rank, groups[1].rank];
  } else if (flush) {
    vector = [5, ...ranks];
  } else if (straight) {
    vector = [4, straight];
  } else if (groups[0].count === 3) {
    const kickers = groups.filter((g) => g.count === 1).map((g) => g.rank).sort((a, b) => b - a);
    vector = [3, groups[0].rank, ...kickers];
  } else if (groups[0].count === 2 && groups[1].count === 2) {
    const pairs = groups.filter((g) => g.count === 2).map((g) => g.rank).sort((a, b) => b - a);
    const kicker = groups.find((g) => g.count === 1).rank;
    vector = [2, pairs[0], pairs[1], kicker];
  } else if (groups[0].count === 2) {
    const kickers = groups.filter((g) => g.count === 1).map((g) => g.rank).sort((a, b) => b - a);
    vector = [1, groups[0].rank, ...kickers];
  } else {
    vector = [0, ...ranks];
  }

  return {
    vector,
    category: vector[0],
    name: CATEGORY_NAMES[vector[0]],
    cards: cards.map((card) => ({ ...card }))
  };
}

function compareEvaluations(a, b) {
  const len = Math.max(a.vector.length, b.vector.length);
  for (let i = 0; i < len; i += 1) {
    const av = a.vector[i] || 0;
    const bv = b.vector[i] || 0;
    if (av !== bv) return av > bv ? 1 : -1;
  }
  return 0;
}

function combinations(cards, choose) {
  const result = [];
  function walk(start, current) {
    if (current.length === choose) {
      result.push(current.slice());
      return;
    }
    for (let i = start; i <= cards.length - (choose - current.length); i += 1) {
      current.push(cards[i]);
      walk(i + 1, current);
      current.pop();
    }
  }
  walk(0, []);
  return result;
}

function evaluateSeven(cards) {
  if (!Array.isArray(cards) || cards.length < 5 || cards.length > 7) {
    throw new Error('evaluateSeven requires five to seven cards');
  }
  let best = null;
  for (const combo of combinations(cards, 5)) {
    const evaluation = evaluateFive(combo);
    if (!best || compareEvaluations(evaluation, best) > 0) best = evaluation;
  }
  return best;
}

function settleSidePots(players, board, dealerSeat = 0) {
  const levels = [...new Set(players.map((p) => p.totalBet).filter((n) => n > 0))].sort((a, b) => a - b);
  const payouts = new Map(players.map((p) => [p.id, 0]));
  const pots = [];
  let previous = 0;

  for (const level of levels) {
    const contributors = players.filter((p) => p.totalBet >= level);
    const amount = (level - previous) * contributors.length;
    previous = level;
    if (amount <= 0) continue;

    const eligible = contributors.filter((p) => !p.folded && Array.isArray(p.hand) && p.hand.length === 2);
    if (eligible.length === 0) continue;

    const evaluated = eligible.map((player) => ({
      player,
      evaluation: evaluateSeven([...player.hand, ...board])
    }));
    let best = evaluated[0].evaluation;
    for (const item of evaluated.slice(1)) {
      if (compareEvaluations(item.evaluation, best) > 0) best = item.evaluation;
    }
    const winners = evaluated.filter((item) => compareEvaluations(item.evaluation, best) === 0);
    const base = Math.floor(amount / winners.length);
    let remainder = amount % winners.length;

    const orderedWinners = winners.slice().sort((a, b) => {
      const da = (a.player.seat - dealerSeat + 6) % 6;
      const db = (b.player.seat - dealerSeat + 6) % 6;
      return da - db;
    });

    for (const winner of orderedWinners) {
      const extra = remainder > 0 ? 1 : 0;
      remainder -= extra;
      payouts.set(winner.player.id, payouts.get(winner.player.id) + base + extra);
    }

    pots.push({
      amount,
      winnerIds: orderedWinners.map((w) => w.player.id),
      handName: best.name,
      vector: best.vector
    });
  }

  return { payouts, pots };
}

module.exports = {
  CATEGORY_NAMES,
  createDeck,
  shuffleDeck,
  evaluateFive,
  evaluateSeven,
  compareEvaluations,
  settleSidePots
};
