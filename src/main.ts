import { io, type Socket } from 'socket.io-client';
import './styles.css';
import { HaywireGame } from './game';
import type {
  ActionEvent,
  AvatarId,
  ChatMessage,
  ClientToServerEvents,
  JoinResult,
  RoomSnapshot,
  RoomSummary,
  ServerToClientEvents,
} from './shared/protocol';

const avatarColors: Record<AvatarId, string> = {
  rust: '#ff6b35',
  lime: '#d8ff53',
  sky: '#57c7ff',
  pink: '#ff77b7',
  cream: '#ffe4ae',
  violet: '#9b7bff',
};

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <main id="shell">
    <div id="world" aria-hidden="true"></div>
    <div class="grain"></div><div class="vignette"></div>

    <section id="lobby" class="screen">
      <header class="lobby-nav">
        <a class="mini-logo" href="/" aria-label="HAYWIRE"><i></i> HAYWIRE</a>
        <div class="nav-actions">
          <span id="connection"><b></b> подключение</span>
          <button class="text-button" id="how-button">Как играть</button>
        </div>
      </header>
      <div class="hero-grid">
        <div class="hero-copy">
          <p class="eyebrow"><span>01</span> КООПЕРАТИВНЫЙ ХАОС / ДО 8 ИГРОКОВ</p>
          <h1>ИГЛА.<br><em>СТОГ.</em><br>ПАНИКА.</h1>
          <p class="lead">Самая нелепая задача человечества теперь с друзьями, магнитами, неконтролируемым чиханием и очень злым гусём.</p>
          <div class="stat-row">
            <div><strong>8</strong><span>сенокосцев</span></div>
            <div><strong>∞</strong><span>соломинок*</span></div>
            <div><strong>1</strong><span>подлая игла</span></div>
          </div>
          <small>* видеокарта считает, что около тридцати тысяч</small>
        </div>

        <div class="join-card">
          <div class="card-topline"><span>ПРОПУСК В СТОГ</span><b id="online-count">0 В СЕТИ</b></div>
          <label class="field-label" for="player-name">Как тебя будут звать</label>
          <input id="player-name" class="main-input" maxlength="18" placeholder="Сенокосец 3000" autocomplete="nickname" />
          <span class="field-label">Цвет комбинезона</span>
          <div id="avatars" class="avatar-row" role="radiogroup">
            ${Object.entries(avatarColors).map(([id, color], index) => `<button class="avatar ${index === 0 ? 'selected' : ''}" data-avatar="${id}" style="--avatar:${color}" aria-label="Цвет ${id}"><i></i></button>`).join('')}
          </div>
          <button id="quick-join" class="primary-button"><span>Нырнуть в случайный стог</span><b>↗</b></button>
          <div class="or"><span>ИЛИ ПО КОДУ КОМНАТЫ</span></div>
          <div class="code-row">
            <input id="room-code" maxlength="5" placeholder="КОД" autocomplete="off" />
            <button id="code-join" aria-label="Войти по коду">Войти <b>→</b></button>
          </div>
          <button id="create-button" class="outline-button">＋ Создать свой стог</button>
          <p id="join-error" class="form-error" role="alert"></p>
        </div>
      </div>
      <section class="rooms-section">
        <div class="section-heading"><div><span>ЖИВЫЕ КОМНАТЫ</span><h2>Кто уже копается</h2></div><button id="refresh-rooms">↻ Обновить</button></div>
        <div id="rooms-list" class="rooms-list"><div class="empty-room">Ищем свежие стога…</div></div>
      </section>
    </section>

    <section id="hud" class="screen hidden">
      <header class="game-topbar">
        <div class="game-brand"><i></i><span>HAYWIRE</span></div>
        <div id="round-info" class="round-info"><span>РАУНД 1</span><strong>03:00</strong></div>
        <div class="room-pill"><span id="hud-room-name">Стог</span><button id="copy-room" title="Скопировать ссылку">КОД <b id="hud-room-code">—</b> ⧉</button></div>
      </header>
      <aside class="scoreboard">
        <div class="aside-title"><span>СЕНОКОСЦЫ</span><b id="player-count">1 / 8</b></div>
        <div id="player-list"></div>
      </aside>
      <div id="crosshair" class="crosshair"><i></i><i></i><span></span></div>
      <div class="objective"><span>ТЕКУЩАЯ ЗАДАЧА</span><strong>Найди одну иглу</strong><small>Нажми ЛКМ рядом с ней</small></div>
      <div id="magnet-readout" class="magnet-readout hidden"><span>МАГНИТНЫЙ ИМПУЛЬС</span><strong>???</strong><i></i><small>направление на иглу</small></div>
      <div id="event-banner" class="event-banner hidden"><span></span><strong></strong><small></small></div>
      <div id="toast" class="toast hidden"></div>
      <div class="action-dock">
        <button id="sneeze-action" data-key="Q"><i>💨</i><span><b>ЧИХ-БОМБА</b><small>разбросать солому</small></span><kbd>Q</kbd><em></em></button>
        <button id="magnet-action" data-key="E"><i>🧲</i><span><b>МАГНИТ</b><small>узнать направление</small></span><kbd>E</kbd><em></em></button>
        <button id="search-action" data-key="ЛКМ"><i>✦</i><span><b>ПРОВЕРИТЬ</b><small>схватить подозрительное</small></span><kbd>ЛКМ</kbd></button>
      </div>
      <div class="controls-hint"><span>WASD ДВИЖЕНИЕ</span><span>SHIFT БЕГ</span><span>ESC КУРСОР</span></div>
      <section id="chat" class="chat-panel">
        <button id="chat-toggle" class="chat-title"><span>ЧАТ СТОГА</span><b>свернуть —</b></button>
        <div id="chat-messages" class="chat-messages"></div>
        <form id="chat-form"><input id="chat-input" maxlength="180" placeholder="Сообщить важное про сено…" /><button>↑</button></form>
      </section>
      <button id="leave-button" class="leave-button">Покинуть стог</button>
      <div id="mobile-controls">
        <div id="joystick"><i></i></div>
        <div><button data-mobile-action="sneeze">💨</button><button data-mobile-action="magnet">🧲</button><button data-mobile-action="search">✦</button></div>
      </div>
    </section>

    <dialog id="create-dialog" class="modal">
      <button class="modal-close" data-close="create-dialog">×</button>
      <p class="eyebrow"><span>＋</span> НОВАЯ КОМНАТА</p>
      <h2>Назови свой стог</h2>
      <p>До восьми игроков. Комната исчезнет, когда все разойдутся.</p>
      <input id="room-name" class="main-input" maxlength="28" placeholder="Например: Гусиный спецназ" />
      <button id="create-room" class="primary-button"><span>Создать комнату</span><b>↗</b></button>
    </dialog>

    <dialog id="how-dialog" class="modal how-modal">
      <button class="modal-close" data-close="how-dialog">×</button>
      <p class="eyebrow"><span>?</span> ПОЛЕВАЯ ИНСТРУКЦИЯ</p>
      <h2>Это правда игла в стоге</h2>
      <div class="how-grid">
        <article><b>01</b><h3>Копайся</h3><p>Ходи по объёмному стогу, рассматривай соломинки и ищи металлический блеск.</p></article>
        <article><b>02</b><h3>Рискуй</h3><p>Магнит покажет направление, но выдаст всем твою активность. Чих разметает обзор.</p></article>
        <article><b>03</b><h3>Побеждай</h3><p>Подойди к игле и нажми ЛКМ. Сервер проверит расстояние и запишет очко.</p></article>
      </div>
      <div class="warning">⚠ Гусь не является багом. Гусь — это менеджмент.</div>
    </dialog>
  </main>
`;

const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io({ autoConnect: true });
const world = document.querySelector<HTMLDivElement>('#world')!;
const game = new HaywireGame(world, {
  onMove: (position, yaw) => socket.emit('move', position, yaw),
  onSearch: () => socket.emit('search'),
  onAction: (type) => triggerAction(type),
  onGooseHit: () => socket.emit('action', 'goose'),
});

let selectedAvatar: AvatarId = 'rust';
let room: RoomSnapshot | null = null;
let localPlayerId = '';
let roomsCache: RoomSummary[] = [];
let toastTimer = 0;
const cooldowns = new Map<'sneeze' | 'magnet', number>();

const $ = <T extends Element>(selector: string) => document.querySelector<T>(selector)!;
const nameInput = $('#player-name') as HTMLInputElement;
nameInput.value = localStorage.getItem('haywire-name') || '';

function identity() {
  const playerName = nameInput.value.trim() || `Сенокосец ${Math.floor(100 + Math.random() * 900)}`;
  nameInput.value = playerName;
  localStorage.setItem('haywire-name', playerName);
  return { playerName, avatar: selectedAvatar };
}

function setLoading(loading: boolean): void {
  for (const selector of ['#quick-join', '#code-join', '#create-room']) {
    const element = $(selector) as HTMLButtonElement;
    element.disabled = loading;
  }
  $('#join-error').textContent = loading ? 'Раздвигаем солому…' : '';
}

function handleJoin(result: JoinResult): void {
  setLoading(false);
  if (!result.ok || !result.room || !result.playerId) {
    $('#join-error').textContent = result.error || 'Не получилось войти в стог.';
    return;
  }
  room = result.room;
  localPlayerId = result.playerId;
  closeDialogs();
  $('#lobby').classList.add('hidden');
  $('#hud').classList.remove('hidden');
  document.body.classList.add('playing');
  game.enterRoom(result.room, result.playerId);
  updateRoomUi();
  history.replaceState({}, '', `/?room=${result.room.id}`);
  window.setTimeout(() => game.requestControl(), 250);
}

function renderRooms(): void {
  const list = $('#rooms-list');
  list.replaceChildren();
  $('#online-count').textContent = `${roomsCache.reduce((sum, item) => sum + item.players, 0)} В СЕТИ`;
  if (!roomsCache.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-room';
    empty.textContent = 'Пока тихо. Создай первый стог — гусь уже ждёт.';
    list.append(empty);
    return;
  }
  for (const item of roomsCache) {
    const card = document.createElement('button');
    card.className = 'room-card';
    card.innerHTML = `<i></i><div><strong></strong><span></span></div><em></em><b>→</b>`;
    card.querySelector('strong')!.textContent = item.name;
    card.querySelector('span')!.textContent = `КОД ${item.id} · РАУНД ${item.round}`;
    card.querySelector('em')!.textContent = `${item.players} / ${item.capacity}`;
    card.addEventListener('click', () => joinByCode(item.id));
    list.append(card);
  }
}

function joinByCode(code: string): void {
  setLoading(true);
  socket.emit('joinRoom', { roomId: code, ...identity() }, handleJoin);
}

function updateRoomUi(): void {
  if (!room) return;
  $('#hud-room-name').textContent = room.name;
  $('#hud-room-code').textContent = room.id;
  $('#player-count').textContent = `${room.players.length} / ${room.capacity}`;
  $('#round-info span').textContent = `РАУНД ${room.round}`;
  const list = $('#player-list');
  list.replaceChildren();
  [...room.players].sort((a, b) => b.score - a.score).forEach((player, index) => {
    const row = document.createElement('div');
    row.className = `player-row ${player.id === localPlayerId ? 'is-you' : ''}`;
    row.innerHTML = `<i style="--color:${avatarColors[player.avatar]}"></i><span><strong></strong><small></small></span><b></b>`;
    row.querySelector('strong')!.textContent = player.name;
    row.querySelector('small')!.textContent = player.id === localPlayerId ? 'ЭТО ТЫ' : `МЕСТО ${index + 1}`;
    row.querySelector('b')!.textContent = `${player.score} ✦`;
    list.append(row);
  });
}

function addChat(message: ChatMessage): void {
  const list = $('#chat-messages');
  const item = document.createElement('div');
  item.className = `chat-message ${message.kind}`;
  const name = document.createElement('b');
  name.textContent = message.name;
  const text = document.createElement('span');
  text.textContent = message.text;
  item.append(name, text);
  list.append(item);
  while (list.children.length > 40) list.firstElementChild?.remove();
  list.scrollTop = list.scrollHeight;
}

function showToast(text: string): void {
  const toast = $('#toast');
  toast.textContent = text;
  toast.classList.remove('hidden');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.add('hidden'), 2600);
}

function showEvent(action: ActionEvent): void {
  const banner = $('#event-banner');
  const copy = {
    found: ['ИГЛА НАЙДЕНА', action.playerName, 'НОВЫЙ РАУНД ЧЕРЕЗ 5 СЕКУНД'],
    sneeze: ['АПЧХИ!', action.playerName, 'ЛОКАЛЬНАЯ СОЛОМЕННАЯ КАТАСТРОФА'],
    magnet: ['МАГНИТ ВКЛЮЧЁН', action.playerName, 'ЕГО ПОЗИЦИЯ ТЕПЕРЬ НЕ СЕКРЕТ'],
    goose: ['ГУСИНЫЙ НАЛОГ', action.playerName, 'ПОПАЛ ПОД АГРАРНЫЙ НАДЗОР'],
  }[action.type];
  banner.querySelector('span')!.textContent = copy[0];
  banner.querySelector('strong')!.textContent = copy[1];
  banner.querySelector('small')!.textContent = copy[2];
  banner.classList.remove('hidden');
  window.setTimeout(() => banner.classList.add('hidden'), action.type === 'found' ? 4800 : 1900);
}

function triggerAction(type: 'sneeze' | 'magnet'): void {
  const now = Date.now();
  if ((cooldowns.get(type) ?? 0) > now) return;
  const duration = type === 'sneeze' ? 8500 : 14000;
  cooldowns.set(type, now + duration);
  socket.emit('action', type);
  game.playLocalAction(type);
  const button = $(`#${type}-action`) as HTMLButtonElement;
  button.classList.add('cooling');
  const started = performance.now();
  const animate = () => {
    const progress = Math.max(0, 1 - (performance.now() - started) / duration);
    button.style.setProperty('--cooldown', `${progress * 100}%`);
    if (progress > 0) requestAnimationFrame(animate);
    else button.classList.remove('cooling');
  };
  animate();
}

function closeDialogs(): void {
  document.querySelectorAll<HTMLDialogElement>('dialog[open]').forEach((dialog) => dialog.close());
}

socket.on('connect', () => {
  $('#connection').classList.add('online');
  $('#connection').innerHTML = '<b></b> сервер на связи';
  socket.emit('listRooms');
  const code = new URLSearchParams(location.search).get('room');
  if (code && code.length === 5) ($('#room-code') as HTMLInputElement).value = code.toUpperCase();
});
socket.on('disconnect', () => {
  $('#connection').classList.remove('online');
  $('#connection').innerHTML = '<b></b> переподключение';
});
socket.on('rooms', (rooms) => { roomsCache = rooms; renderRooms(); });
socket.on('roomState', (state) => { room = state; game.syncRoom(state); updateRoomUi(); });
socket.on('playerJoined', (player) => {
  if (!room) return;
  room.players.push(player); game.upsertPlayer(player); updateRoomUi();
});
socket.on('playerLeft', (id) => {
  if (!room) return;
  room.players = room.players.filter((player) => player.id !== id); game.removePlayer(id); updateRoomUi();
});
socket.on('playerMoved', (player) => game.movePlayer(player));
socket.on('chat', addChat);
socket.on('toast', showToast);
socket.on('action', (action) => { showEvent(action); game.playNetworkAction(action); });
socket.on('magnetResult', (result) => {
  const readout = $('#magnet-readout');
  readout.querySelector('strong')!.textContent = `${result.distance.toFixed(1)} М · ${result.strength.toUpperCase()}`;
  readout.querySelector('i')!.setAttribute('style', `transform:rotate(${result.bearing - game.yaw}rad)`);
  readout.classList.remove('hidden');
  window.setTimeout(() => readout.classList.add('hidden'), 5500);
});
socket.on('roundReset', (state) => {
  if (!room) return;
  room = { ...room, ...state };
  game.resetRound(state.seed, state.players, localPlayerId);
  updateRoomUi();
});

$('#avatars').addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-avatar]');
  if (!button) return;
  selectedAvatar = button.dataset.avatar as AvatarId;
  document.querySelectorAll('.avatar').forEach((item) => item.classList.toggle('selected', item === button));
});
$('#quick-join').addEventListener('click', () => { setLoading(true); socket.emit('quickJoin', identity(), handleJoin); });
$('#code-join').addEventListener('click', () => joinByCode(($('#room-code') as HTMLInputElement).value.trim().toUpperCase()));
$('#room-code').addEventListener('keydown', (event) => { if ((event as KeyboardEvent).key === 'Enter') joinByCode((event.currentTarget as HTMLInputElement).value.trim().toUpperCase()); });
$('#create-button').addEventListener('click', () => ($('#create-dialog') as HTMLDialogElement).showModal());
$('#create-room').addEventListener('click', () => {
  setLoading(true);
  socket.emit('createRoom', { name: ($('#room-name') as HTMLInputElement).value, ...identity() }, handleJoin);
});
$('#how-button').addEventListener('click', () => ($('#how-dialog') as HTMLDialogElement).showModal());
document.querySelectorAll<HTMLElement>('[data-close]').forEach((button) => button.addEventListener('click', () => ($(`#${button.dataset.close}`) as HTMLDialogElement).close()));
$('#refresh-rooms').addEventListener('click', () => socket.emit('listRooms'));
$('#copy-room').addEventListener('click', async () => {
  if (!room) return;
  const link = `${location.origin}/?room=${room.id}`;
  try { await navigator.clipboard.writeText(link); showToast('Ссылка на стог скопирована'); }
  catch { showToast(`Код комнаты: ${room.id}`); }
});
$('#leave-button').addEventListener('click', () => {
  socket.emit('leaveRoom'); room = null; localPlayerId = ''; game.leaveRoom();
  $('#hud').classList.add('hidden'); $('#lobby').classList.remove('hidden'); document.body.classList.remove('playing');
  history.replaceState({}, '', '/'); socket.emit('listRooms');
});
$('#sneeze-action').addEventListener('click', () => triggerAction('sneeze'));
$('#magnet-action').addEventListener('click', () => triggerAction('magnet'));
$('#search-action').addEventListener('click', () => socket.emit('search'));
$('#chat-toggle').addEventListener('click', () => $('#chat').classList.toggle('collapsed'));
$('#chat-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const input = $('#chat-input') as HTMLInputElement;
  if (input.value.trim()) socket.emit('chat', input.value);
  input.value = ''; game.requestControl();
});
$('#chat-input').addEventListener('focus', () => game.releaseControl());
document.addEventListener('keydown', (event) => {
  if (!room || document.activeElement instanceof HTMLInputElement) return;
  if (event.code === 'KeyQ') triggerAction('sneeze');
  if (event.code === 'KeyE') triggerAction('magnet');
});

const joystick = $('#joystick');
let joystickPointer: number | null = null;
joystick.addEventListener('pointerdown', (event) => {
  const pointer = event as PointerEvent;
  joystickPointer = pointer.pointerId;
  joystick.setPointerCapture(pointer.pointerId);
});
joystick.addEventListener('pointermove', (event) => {
  const pointer = event as PointerEvent;
  if (pointer.pointerId !== joystickPointer) return;
  const rect = joystick.getBoundingClientRect();
  const x = Math.max(-1, Math.min(1, (pointer.clientX - rect.left - rect.width / 2) / (rect.width / 2)));
  const y = Math.max(-1, Math.min(1, (pointer.clientY - rect.top - rect.height / 2) / (rect.height / 2)));
  game.setVirtualMove(x, y); (joystick.firstElementChild as HTMLElement).style.transform = `translate(${x * 24}px, ${y * 24}px)`;
});
joystick.addEventListener('pointerup', () => { joystickPointer = null; game.setVirtualMove(0, 0); (joystick.firstElementChild as HTMLElement).style.transform = ''; });
document.querySelectorAll<HTMLButtonElement>('[data-mobile-action]').forEach((button) => button.addEventListener('click', () => {
  const action = button.dataset.mobileAction;
  if (action === 'search') socket.emit('search'); else triggerAction(action as 'sneeze' | 'magnet');
}));

window.setInterval(() => {
  if (!room) return;
  const remaining = Math.max(0, room.roundEndsAt - Date.now());
  const minutes = Math.floor(remaining / 60000).toString().padStart(2, '0');
  const seconds = Math.floor((remaining % 60000) / 1000).toString().padStart(2, '0');
  $('#round-info strong').textContent = `${minutes}:${seconds}`;
}, 250);
