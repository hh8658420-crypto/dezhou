'use strict';

const socket = io({ transports: ['websocket', 'polling'] });
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const lobby = $('#lobby');
const game = $('#game');
const nameInput = $('#nameInput');
const roomInput = $('#roomInput');
const createBtn = $('#createBtn');
const joinBtn = $('#joinBtn');
const refreshRoomsBtn = $('#refreshRoomsBtn');
const roomsList = $('#roomsList');
const connectionBadge = $('#connectionBadge');
const roomMeta = $('#roomMeta');
const roomCodeText = $('#roomCodeText');
const copyRoomBtn = $('#copyRoomBtn');
const shareRoomBtn = $('#shareRoomBtn');
const installBtn = $('#installBtn');
const inviteNotice = $('#inviteNotice');
const startBtn = $('#startBtn');
const seatsEl = $('#seats');
const boardCards = $('#boardCards');
const actionPanel = $('#actionPanel');
const raiseSlider = $('#raiseSlider');
const raiseInput = $('#raiseInput');
const timerBar = $('#timerBar');
const toast = $('#toast');
const resultModal = $('#resultModal');

let state = null;
let lobbyRooms = [];
let timerAnimation = null;
let shownResultHand = null;
let deferredInstallPrompt = null;

const storedName = localStorage.getItem('pokerName');
nameInput.value = storedName || `玩家${Math.floor(100 + Math.random() * 900)}`;
const queryRoom = new URLSearchParams(location.search).get('room');
if (queryRoom) {
  roomInput.value = queryRoom.toUpperCase();
  inviteNotice.hidden = false;
}

const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
if (isIOS && !isStandalone) installBtn.hidden = false;

function sessionKey(code) { return `pokerToken:${code}`; }
function currentName() {
  const name = nameInput.value.trim().slice(0, 12) || '玩家';
  localStorage.setItem('pokerName', name);
  return name;
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove('show'), 2600);
}

function setBusy(button, busy) {
  button.disabled = busy;
  button.dataset.original ||= button.textContent;
  button.textContent = busy ? '连接中…' : button.dataset.original;
}

function enterRoom(code, token) {
  if (token) localStorage.setItem(sessionKey(code), token);
  history.replaceState(null, '', `?room=${encodeURIComponent(code)}`);
  lobby.hidden = true;
  game.hidden = false;
  roomMeta.hidden = false;
  roomCodeText.textContent = code;
  document.body.classList.add('in-game');
}

createBtn.addEventListener('click', () => {
  setBusy(createBtn, true);
  socket.emit('createRoom', { name: currentName() }, (response) => {
    setBusy(createBtn, false);
    if (!response?.ok) return showToast(response?.error || '创建失败');
    enterRoom(response.code, response.token);
  });
});

function joinCode(code) {
  const normalized = String(code || '').trim().toUpperCase();
  if (normalized.length !== 6) return showToast('请输入6位房间号');
  setBusy(joinBtn, true);
  socket.emit('joinRoom', {
    code: normalized,
    name: currentName(),
    token: localStorage.getItem(sessionKey(normalized)) || undefined
  }, (response) => {
    setBusy(joinBtn, false);
    if (!response?.ok) return showToast(response?.error || '加入失败');
    enterRoom(response.code, response.token);
  });
}

joinBtn.addEventListener('click', () => joinCode(roomInput.value));
roomInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') joinCode(roomInput.value); });
refreshRoomsBtn.addEventListener('click', () => socket.emit('requestLobby'));
copyRoomBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(roomCodeText.textContent);
    showToast('房间号已复制');
  } catch {
    showToast(`房间号：${roomCodeText.textContent}`);
  }
});

shareRoomBtn.addEventListener('click', async () => {
  const code = roomCodeText.textContent;
  const inviteUrl = new URL(location.origin);
  inviteUrl.searchParams.set('room', code);
  const shareData = {
    title: '巅峰德州好友房',
    text: `加入我的德州扑克房间：${code}`,
    url: inviteUrl.toString()
  };
  try {
    if (navigator.share) {
      await navigator.share(shareData);
      return;
    }
    await navigator.clipboard.writeText(`${shareData.text}
${shareData.url}`);
    showToast('邀请链接已复制');
  } catch (error) {
    if (error?.name !== 'AbortError') showToast(`房间号：${code}`);
  }
});

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  if (!isStandalone) installBtn.hidden = false;
});

installBtn.addEventListener('click', async () => {
  if (deferredInstallPrompt) {
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    installBtn.hidden = true;
    return;
  }
  if (isIOS) {
    showToast('iPhone：点浏览器“分享”→“添加到主屏幕”');
    return;
  }
  showToast('请在浏览器菜单中选择“安装应用”或“添加到主屏幕”');
});

window.addEventListener('appinstalled', () => {
  installBtn.hidden = true;
  showToast('已安装到手机桌面');
});

startBtn.addEventListener('click', () => {
  socket.emit('startGame', {}, (response) => {
    if (!response?.ok) showToast(response?.error || '无法开始');
  });
});

$$('[data-action]').forEach((button) => {
  button.addEventListener('click', () => {
    const action = button.dataset.action;
    const amount = action === 'raise' ? Number(raiseInput.value) : undefined;
    disableActions(true);
    socket.emit('playerAction', { action, amount }, (response) => {
      if (!response?.ok) {
        showToast(response?.error || '操作失败');
        renderActions();
      }
    });
  });
});

raiseSlider.addEventListener('input', () => { raiseInput.value = raiseSlider.value; });
raiseInput.addEventListener('input', () => {
  const value = Math.max(Number(raiseSlider.min), Math.min(Number(raiseSlider.max), Number(raiseInput.value) || 0));
  raiseSlider.value = String(value);
});

socket.on('connect', () => {
  connectionBadge.textContent = '已连接';
  connectionBadge.className = 'connection online';
  const code = new URLSearchParams(location.search).get('room')?.toUpperCase();
  const token = code ? localStorage.getItem(sessionKey(code)) : null;
  if (code && token) {
    socket.emit('joinRoom', { code, token, name: currentName() }, (response) => {
      if (response?.ok) enterRoom(response.code, response.token);
    });
  }
});

socket.on('disconnect', () => {
  connectionBadge.textContent = '连接断开';
  connectionBadge.className = 'connection offline';
});

socket.on('lobbyRooms', (rooms) => {
  lobbyRooms = Array.isArray(rooms) ? rooms : [];
  renderLobbyRooms();
});

socket.on('roomState', (nextState) => {
  state = nextState;
  enterRoom(state.code, localStorage.getItem(sessionKey(state.code)) || '');
  render();
});

function renderLobbyRooms() {
  if (!lobbyRooms.length) {
    roomsList.innerHTML = '<div class="empty-state">暂时没有公开等待中的房间，创建一个吧。</div>';
    return;
  }
  roomsList.innerHTML = lobbyRooms.map((room) => `
    <div class="room-card">
      <div><strong>${escapeHtml(room.code)}</strong><small>${room.players} / ${room.maxPlayers} 玩家 · 已进行 ${room.handNo} 局</small></div>
      <button data-join-room="${escapeHtml(room.code)}">加入</button>
    </div>`).join('');
  $$('[data-join-room]').forEach((button) => button.addEventListener('click', () => joinCode(button.dataset.joinRoom)));
}

function render() {
  if (!state) return;
  roomCodeText.textContent = state.code;
  $('#handNo').textContent = state.handNo;
  $('#phaseText').textContent = phaseName(state.phase);
  $('#potValue').textContent = formatChips(state.pot);
  $('#currentBetText').textContent = formatChips(state.currentBet);
  $('#blindText').textContent = `${state.smallBlind} / ${state.bigBlind}`;
  $('#playersCount').textContent = `${state.players.filter((p) => p.connected).length} / 6 玩家`;
  const me = state.players.find((p) => p.id === state.meId);
  $('#myChipsText').textContent = formatChips(me?.chips || 0);
  boardCards.innerHTML = state.board.map(cardHtml).join('');
  while (boardCards.children.length < 5) boardCards.insertAdjacentHTML('beforeend', '<div class="card-slot"></div>');
  renderSeats();
  renderActions();
  renderLog();
  renderResult();
  startBtn.disabled = !(state.phase === 'waiting' && state.meId === state.hostPlayerId && state.players.filter((p) => p.connected && p.chips > 0).length >= 2);
  startBtn.textContent = state.phase === 'waiting' ? '开始牌局' : '牌局进行中';
  $('#tableHint').textContent = tableHint();
  animateTimer();
}

function renderSeats() {
  const bySeat = new Map(state.players.map((p) => [p.seat, p]));
  seatsEl.innerHTML = [...Array(6).keys()].map((seat) => {
    const p = bySeat.get(seat);
    if (!p) return `<div class="seat seat-${seat} empty-seat"><div class="player-action">等待玩家加入</div></div>`;
    const classes = ['seat', `seat-${seat}`];
    if (p.id === state.currentPlayerId) classes.push('current');
    if (p.folded) classes.push('folded');
    if (!p.connected) classes.push('disconnected');
    const cards = p.hand.length ? p.hand.map(cardHtml).join('') : [...Array(p.cardCount)].map(() => '<div class="card back"></div>').join('');
    return `<div class="${classes.join(' ')}">
      ${cards ? `<div class="hole-cards">${cards}</div>` : ''}
      ${p.bet > 0 ? `<div class="bet-badge">下注 ${formatChips(p.bet)}</div>` : ''}
      <div class="player-head">
        <div class="avatar">${escapeHtml(p.name.slice(0, 1).toUpperCase())}</div>
        <div class="player-name"><strong>${escapeHtml(p.name)}${p.id === state.meId ? '（你）' : ''}</strong><small>${formatChips(p.chips)}</small></div>
        ${p.seat === state.dealerSeat ? '<div class="dealer-chip">D</div>' : ''}
      </div>
      <div class="player-action">${escapeHtml(p.allIn ? 'ALL IN · ' + p.lastAction : p.lastAction)}</div>
    </div>`;
  }).join('');
}

function renderActions() {
  const legal = state.legalActions;
  const isMyTurn = Boolean(legal);
  disableActions(!isMyTurn);
  const buttons = Object.fromEntries($$('[data-action]').map((b) => [b.dataset.action, b]));
  if (!legal) {
    $('#turnStatus').textContent = state.currentPlayerId ? '等待其他玩家行动' : '等待牌局流程';
    return;
  }
  buttons.fold.disabled = !legal.canFold;
  buttons.check.disabled = !legal.canCheck;
  buttons.call.disabled = !legal.canCall;
  buttons.raise.disabled = !legal.canRaise;
  buttons.allin.disabled = !legal.canAllIn;
  buttons.call.textContent = legal.callAmount > 0 ? `跟注 ${formatChips(legal.callAmount)}` : '跟注';
  raiseSlider.min = legal.minRaiseTo;
  raiseSlider.max = legal.maxRaiseTo;
  raiseInput.min = legal.minRaiseTo;
  raiseInput.max = legal.maxRaiseTo;
  if (Number(raiseInput.value) < legal.minRaiseTo || Number(raiseInput.value) > legal.maxRaiseTo) {
    raiseInput.value = legal.minRaiseTo;
    raiseSlider.value = legal.minRaiseTo;
  }
  $('#turnStatus').textContent = legal.callAmount > 0 ? `轮到你：需跟注 ${formatChips(legal.callAmount)}` : '轮到你：可以过牌';
}

function disableActions(disabled) {
  $$('[data-action]').forEach((button) => { button.disabled = disabled; });
  raiseInput.disabled = disabled;
  raiseSlider.disabled = disabled;
}

function renderLog() {
  $('#gameLog').innerHTML = [...state.logs].reverse().map((log) => `<div class="log-line">${escapeHtml(log.text)}</div>`).join('') || '<div class="log-line">暂无记录</div>';
}

function renderResult() {
  if (state.phase === 'showdown' && state.lastResult && shownResultHand !== state.handNo) {
    shownResultHand = state.handNo;
    $('#resultTitle').textContent = state.lastResult.title;
    $('#resultDetail').textContent = state.lastResult.detail;
    resultModal.hidden = false;
  }
  if (state.phase === 'waiting') resultModal.hidden = true;
}

function animateTimer() {
  cancelAnimationFrame(timerAnimation);
  const update = () => {
    if (!state?.deadline) {
      timerBar.style.width = '0%';
      return;
    }
    const remaining = Math.max(0, state.deadline - Date.now());
    timerBar.style.width = `${Math.min(100, remaining / 25000 * 100)}%`;
    if (remaining > 0) timerAnimation = requestAnimationFrame(update);
  };
  update();
}

function tableHint() {
  if (state.phase === 'waiting') return state.players.filter((p) => p.connected).length < 2 ? '邀请至少一位好友加入房间' : (state.meId === state.hostPlayerId ? '点击“开始牌局”发牌' : '等待房主开始');
  if (state.phase === 'showdown') return state.lastResult?.detail || '摊牌结算';
  const current = state.players.find((p) => p.id === state.currentPlayerId);
  return current ? `${current.name} 正在行动` : '正在发出公共牌';
}

function phaseName(phase) {
  return ({ waiting: '等待', preflop: '翻牌前', flop: '翻牌圈', turn: '转牌圈', river: '河牌圈', showdown: '摊牌' })[phase] || phase;
}

function cardHtml(card) {
  const rank = ({ 11: 'J', 12: 'Q', 13: 'K', 14: 'A' })[card.rank] || String(card.rank);
  const suit = ({ S: '♠', H: '♥', D: '♦', C: '♣' })[card.suit] || '?';
  const red = card.suit === 'H' || card.suit === 'D';
  return `<div class="card${red ? ' red' : ''}"><span class="rank">${rank}</span><span class="suit">${suit}</span><span class="big-suit">${suit}</span></div>`;
}

function formatChips(value) { return Number(value || 0).toLocaleString('zh-CN'); }
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
}


if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // 联机功能不依赖离线缓存，注册失败时保持正常网页模式。
    });
  });
}
