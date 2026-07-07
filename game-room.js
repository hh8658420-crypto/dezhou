'use strict';

const { createDeck, shuffleDeck, evaluateSeven, settleSidePots } = require('./poker');

const MAX_PLAYERS = 6;
const STARTING_CHIPS = 5000;
const SMALL_BLIND = 10;
const BIG_BLIND = 20;
const TURN_MS = 25000;

class GameRoom {
  constructor(code, hostToken, onChange) {
    this.code = code;
    this.hostToken = hostToken;
    this.onChange = onChange;
    this.players = [];
    this.phase = 'waiting';
    this.board = [];
    this.deck = [];
    this.dealerSeat = -1;
    this.currentPlayerId = null;
    this.currentBet = 0;
    this.minRaise = BIG_BLIND;
    this.handNo = 0;
    this.deadline = null;
    this.timer = null;
    this.actedSinceRaise = new Set();
    this.lastResult = null;
    this.logs = [];
  }

  addLog(text) {
    this.logs.push({ text, at: Date.now() });
    this.logs = this.logs.slice(-20);
  }

  getPlayerByToken(token) {
    return this.players.find((p) => p.token === token);
  }

  getPlayerById(id) {
    return this.players.find((p) => p.id === id);
  }

  addOrReconnectPlayer({ id, token, socketId, name }) {
    const existing = this.getPlayerByToken(token);
    if (existing) {
      existing.socketId = socketId;
      existing.connected = true;
      existing.name = cleanName(name || existing.name);
      this.addLog(`${existing.name} 已重新连接`);
      this.notify();
      return existing;
    }

    if (this.players.length >= MAX_PLAYERS) throw new Error('房间已满');
    const freeSeat = [...Array(MAX_PLAYERS).keys()].find((seat) => !this.players.some((p) => p.seat === seat));
    const player = {
      id,
      token,
      socketId,
      name: cleanName(name),
      seat: freeSeat,
      chips: STARTING_CHIPS,
      hand: [],
      bet: 0,
      totalBet: 0,
      folded: false,
      allIn: false,
      connected: true,
      lastAction: '等待'
    };
    this.players.push(player);
    this.addLog(`${player.name} 加入了房间`);
    this.notify();
    return player;
  }

  disconnect(socketId) {
    const player = this.players.find((p) => p.socketId === socketId);
    if (!player) return;
    player.connected = false;
    this.addLog(`${player.name} 已断线，保留座位`);

    if (this.phase === 'waiting') {
      // Waiting-room seats stay available for reconnect, but do not block a game.
      this.notify();
      return;
    }

    if (this.currentPlayerId === player.id) {
      setTimeout(() => {
        if (this.currentPlayerId !== player.id || player.connected) return;
        const callAmount = Math.max(0, this.currentBet - player.bet);
        this.performAction(player.id, callAmount === 0 ? 'check' : 'fold', null, true);
      }, 800);
    } else {
      this.notify();
    }
  }

  canStart(requestToken) {
    return requestToken === this.hostToken && this.phase === 'waiting' && this.availablePlayers().length >= 2;
  }

  availablePlayers() {
    return this.players.filter((p) => p.chips > 0 && p.connected);
  }

  activePlayers() {
    return this.players.filter((p) => p.hand.length === 2 && !p.folded);
  }

  actionablePlayers() {
    return this.activePlayers().filter((p) => !p.allIn);
  }

  nextSeatAfter(seat, predicate) {
    for (let offset = 1; offset <= MAX_PLAYERS; offset += 1) {
      const candidate = (seat + offset) % MAX_PLAYERS;
      const player = this.players.find((p) => p.seat === candidate && predicate(p));
      if (player) return player;
    }
    return null;
  }

  startHand() {
    if (this.phase !== 'waiting') throw new Error('牌局正在进行中');
    const participants = this.availablePlayers();
    if (participants.length < 2) throw new Error('至少需要两名在线且有筹码的玩家');

    this.clearTimer();
    this.handNo += 1;
    this.phase = 'preflop';
    this.board = [];
    this.deck = shuffleDeck(createDeck());
    this.currentBet = 0;
    this.minRaise = BIG_BLIND;
    this.lastResult = null;
    this.actedSinceRaise.clear();

    for (const player of this.players) {
      player.hand = [];
      player.bet = 0;
      player.totalBet = 0;
      player.folded = !participants.includes(player);
      player.allIn = false;
      player.lastAction = participants.includes(player) ? '等待行动' : (player.chips <= 0 ? '筹码不足' : '离线');
    }

    const dealer = this.nextSeatAfter(this.dealerSeat, (p) => participants.includes(p)) || participants[0];
    this.dealerSeat = dealer.seat;

    // Deal one card at a time, beginning left of the dealer.
    let cursor = dealer.seat;
    for (let round = 0; round < 2; round += 1) {
      for (let i = 0; i < participants.length; i += 1) {
        const recipient = this.nextSeatAfter(cursor, (p) => participants.includes(p));
        recipient.hand.push(this.deck.pop());
        cursor = recipient.seat;
      }
      cursor = dealer.seat;
    }

    let smallBlindPlayer;
    let bigBlindPlayer;
    if (participants.length === 2) {
      smallBlindPlayer = dealer;
      bigBlindPlayer = this.nextSeatAfter(dealer.seat, (p) => participants.includes(p));
    } else {
      smallBlindPlayer = this.nextSeatAfter(dealer.seat, (p) => participants.includes(p));
      bigBlindPlayer = this.nextSeatAfter(smallBlindPlayer.seat, (p) => participants.includes(p));
    }

    this.commitChips(smallBlindPlayer, SMALL_BLIND);
    smallBlindPlayer.lastAction = `小盲 ${smallBlindPlayer.bet}`;
    this.commitChips(bigBlindPlayer, BIG_BLIND);
    bigBlindPlayer.lastAction = `大盲 ${bigBlindPlayer.bet}`;
    this.currentBet = Math.max(smallBlindPlayer.bet, bigBlindPlayer.bet);

    const firstActor = this.nextSeatAfter(bigBlindPlayer.seat, (p) => this.isActionable(p));
    this.currentPlayerId = firstActor ? firstActor.id : null;
    this.addLog(`第 ${this.handNo} 手牌开始`);

    if (!firstActor) this.advanceStreet();
    else this.beginTurn();
  }

  commitChips(player, requested) {
    const amount = Math.max(0, Math.min(player.chips, Math.floor(requested)));
    player.chips -= amount;
    player.bet += amount;
    player.totalBet += amount;
    if (player.chips === 0) player.allIn = true;
    return amount;
  }

  isActionable(player) {
    return player.hand.length === 2 && !player.folded && !player.allIn;
  }

  legalActions(playerId) {
    const player = this.getPlayerById(playerId);
    if (!player || this.currentPlayerId !== playerId || !this.isActionable(player)) return null;
    const callAmount = Math.max(0, this.currentBet - player.bet);
    const maxTotal = player.bet + player.chips;
    const minRaiseTo = this.currentBet === 0 ? BIG_BLIND : this.currentBet + this.minRaise;
    return {
      canFold: true,
      canCheck: callAmount === 0,
      canCall: callAmount > 0 && player.chips > 0,
      canRaise: maxTotal > this.currentBet,
      canAllIn: player.chips > 0,
      callAmount: Math.min(callAmount, player.chips),
      minRaiseTo: Math.min(minRaiseTo, maxTotal),
      maxRaiseTo: maxTotal
    };
  }

  performAction(playerId, action, amount, automatic = false) {
    const player = this.getPlayerById(playerId);
    const legal = this.legalActions(playerId);
    if (!player || !legal) throw new Error('现在不是你的行动回合');

    this.clearTimer();
    const callBefore = Math.max(0, this.currentBet - player.bet);
    let raised = false;

    if (action === 'fold') {
      player.folded = true;
      player.lastAction = automatic ? '超时弃牌' : '弃牌';
    } else if (action === 'check') {
      if (!legal.canCheck) throw new Error('当前不能过牌');
      player.lastAction = automatic ? '自动过牌' : '过牌';
    } else if (action === 'call') {
      if (!legal.canCall) throw new Error('当前不能跟注');
      const paid = this.commitChips(player, callBefore);
      player.lastAction = player.allIn ? `全下跟注 ${paid}` : `跟注 ${paid}`;
    } else if (action === 'raise') {
      if (!legal.canRaise) throw new Error('当前不能加注');
      const target = Math.floor(Number(amount));
      if (!Number.isFinite(target)) throw new Error('请输入有效加注金额');
      if (target <= this.currentBet) throw new Error('加注金额必须高于当前下注');
      const maxTarget = player.bet + player.chips;
      if (target > maxTarget) throw new Error('筹码不足');
      const isAllInRaise = target === maxTarget;
      const minimum = this.currentBet === 0 ? BIG_BLIND : this.currentBet + this.minRaise;
      if (target < minimum && !isAllInRaise) throw new Error(`最小加注到 ${minimum}`);

      const oldBet = this.currentBet;
      this.commitChips(player, target - player.bet);
      this.currentBet = player.bet;
      const raiseSize = this.currentBet - oldBet;
      if (raiseSize >= this.minRaise) this.minRaise = raiseSize;
      raised = true;
      player.lastAction = player.allIn ? `全下到 ${player.bet}` : `加注到 ${player.bet}`;
    } else if (action === 'allin') {
      if (!legal.canAllIn) throw new Error('当前不能全下');
      const oldBet = this.currentBet;
      this.commitChips(player, player.chips);
      if (player.bet > this.currentBet) {
        this.currentBet = player.bet;
        const raiseSize = this.currentBet - oldBet;
        if (raiseSize >= this.minRaise) this.minRaise = raiseSize;
        raised = true;
      }
      player.lastAction = `全下 ${player.bet}`;
    } else {
      throw new Error('未知操作');
    }

    if (raised) this.actedSinceRaise = new Set([player.id]);
    else this.actedSinceRaise.add(player.id);

    this.addLog(`${player.name}：${player.lastAction}`);

    const remaining = this.activePlayers();
    if (remaining.length === 1) {
      this.awardUncontested(remaining[0]);
      return;
    }

    if (this.isBettingRoundComplete()) {
      this.advanceStreet();
      return;
    }

    const next = this.nextSeatAfter(player.seat, (p) => this.isActionable(p));
    if (!next) {
      this.advanceStreet();
      return;
    }
    this.currentPlayerId = next.id;
    this.beginTurn();
  }

  isBettingRoundComplete() {
    const actionable = this.actionablePlayers();
    if (actionable.length === 0) return true;
    return actionable.every((p) => p.bet === this.currentBet && this.actedSinceRaise.has(p.id));
  }

  resetRoundBets() {
    for (const player of this.players) player.bet = 0;
    this.currentBet = 0;
    this.minRaise = BIG_BLIND;
    this.actedSinceRaise.clear();
  }

  burn() {
    if (this.deck.length) this.deck.pop();
  }

  advanceStreet() {
    this.clearTimer();
    if (this.activePlayers().length <= 1) {
      this.awardUncontested(this.activePlayers()[0]);
      return;
    }

    if (this.phase === 'preflop') {
      this.resetRoundBets();
      this.burn();
      this.board.push(this.deck.pop(), this.deck.pop(), this.deck.pop());
      this.phase = 'flop';
      this.addLog('翻牌圈');
    } else if (this.phase === 'flop') {
      this.resetRoundBets();
      this.burn();
      this.board.push(this.deck.pop());
      this.phase = 'turn';
      this.addLog('转牌圈');
    } else if (this.phase === 'turn') {
      this.resetRoundBets();
      this.burn();
      this.board.push(this.deck.pop());
      this.phase = 'river';
      this.addLog('河牌圈');
    } else if (this.phase === 'river') {
      this.showdown();
      return;
    }

    const actionable = this.actionablePlayers();
    if (actionable.length <= 1) {
      // Everyone else is all-in: reveal remaining board immediately.
      setTimeout(() => this.advanceStreet(), 650);
      this.currentPlayerId = null;
      this.notify();
      return;
    }

    const first = this.nextSeatAfter(this.dealerSeat, (p) => this.isActionable(p));
    this.currentPlayerId = first ? first.id : null;
    if (first) this.beginTurn();
    else this.advanceStreet();
  }

  awardUncontested(winner) {
    this.clearTimer();
    const amount = this.potAmount();
    winner.chips += amount;
    this.currentPlayerId = null;
    this.phase = 'showdown';
    this.lastResult = {
      title: `${winner.name} 赢得底池`,
      detail: `其他玩家均已弃牌，获得 ${amount} 娱乐筹码`,
      winners: [{ id: winner.id, name: winner.name, amount, handName: '未摊牌' }],
      pots: []
    };
    this.addLog(`${winner.name} 赢得 ${amount}`);
    this.finishHandLater();
  }

  showdown() {
    this.clearTimer();
    this.phase = 'showdown';
    this.currentPlayerId = null;

    const { payouts, pots } = settleSidePots(this.players, this.board, this.dealerSeat);
    const winners = [];
    for (const player of this.players) {
      const amount = payouts.get(player.id) || 0;
      if (amount > 0) {
        player.chips += amount;
        const evaluation = evaluateSeven([...player.hand, ...this.board]);
        winners.push({ id: player.id, name: player.name, amount, handName: evaluation.name });
      }
    }

    this.lastResult = {
      title: winners.length === 1 ? `${winners[0].name} 获胜` : '底池已分配',
      detail: winners.map((w) => `${w.name}：${w.handName}，获得 ${w.amount}`).join('；'),
      winners,
      pots
    };
    this.addLog(this.lastResult.detail || '摊牌完成');
    this.finishHandLater();
  }

  finishHandLater() {
    this.notify();
    this.timer = setTimeout(() => {
      this.phase = 'waiting';
      this.currentPlayerId = null;
      this.deadline = null;
      for (const player of this.players) {
        player.bet = 0;
        player.totalBet = 0;
        player.hand = [];
        player.folded = false;
        player.allIn = false;
        player.lastAction = player.chips > 0 ? '等待下一局' : '筹码不足';
      }
      this.notify();
    }, 6500);
  }

  potAmount() {
    return this.players.reduce((sum, p) => sum + p.totalBet, 0);
  }

  beginTurn() {
    this.clearTimer();
    this.deadline = Date.now() + TURN_MS;
    this.notify();
    const actingId = this.currentPlayerId;
    this.timer = setTimeout(() => {
      if (this.currentPlayerId !== actingId) return;
      const player = this.getPlayerById(actingId);
      if (!player) return;
      const callAmount = Math.max(0, this.currentBet - player.bet);
      try {
        this.performAction(actingId, callAmount === 0 ? 'check' : 'fold', null, true);
      } catch (error) {
        this.addLog(`自动操作失败：${error.message}`);
        this.notify();
      }
    }, TURN_MS + 100);
  }

  clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.deadline = null;
  }

  notify() {
    if (typeof this.onChange === 'function') this.onChange(this);
  }

  publicStateFor(viewerToken) {
    const viewer = this.getPlayerByToken(viewerToken);
    const revealAll = this.phase === 'showdown';
    return {
      code: this.code,
      phase: this.phase,
      handNo: this.handNo,
      board: this.board,
      pot: this.potAmount(),
      currentBet: this.currentBet,
      dealerSeat: this.dealerSeat,
      currentPlayerId: this.currentPlayerId,
      deadline: this.deadline,
      smallBlind: SMALL_BLIND,
      bigBlind: BIG_BLIND,
      hostPlayerId: this.getPlayerByToken(this.hostToken)?.id || null,
      meId: viewer?.id || null,
      legalActions: viewer ? this.legalActions(viewer.id) : null,
      lastResult: this.lastResult,
      logs: this.logs,
      players: this.players
        .slice()
        .sort((a, b) => a.seat - b.seat)
        .map((p) => ({
          id: p.id,
          name: p.name,
          seat: p.seat,
          chips: p.chips,
          bet: p.bet,
          folded: p.folded,
          allIn: p.allIn,
          connected: p.connected,
          lastAction: p.lastAction,
          cardCount: p.hand.length,
          hand: viewer?.id === p.id || (revealAll && !p.folded) ? p.hand : []
        }))
    };
  }
}

function cleanName(name) {
  const value = String(name || '玩家').trim().replace(/[<>]/g, '').slice(0, 12);
  return value || '玩家';
}

module.exports = {
  GameRoom,
  MAX_PLAYERS,
  STARTING_CHIPS,
  SMALL_BLIND,
  BIG_BLIND,
  TURN_MS
};
