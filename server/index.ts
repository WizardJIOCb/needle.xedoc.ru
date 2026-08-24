import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server } from 'socket.io';
import type {
  ActionEvent,
  AvatarId,
  ChatMessage,
  ClientToServerEvents,
  JoinResult,
  ServerToClientEvents,
} from '../src/shared/protocol.js';
import {
  MAX_PLAYERS,
  ROUND_MS,
  clampPosition,
  createPlayer,
  createRoom,
  distanceToNeedle,
  safeText,
  snapshot,
  summary,
  type RoomState,
} from './room.js';

const PORT = Number(process.env.PORT || 3088);
const isProduction = process.env.NODE_ENV === 'production';
const app = express();
const httpServer = createServer(app);
const io = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer, {
  cors: { origin: isProduction ? false : true },
  transports: ['websocket', 'polling'],
});
const rooms = new Map<string, RoomState>();
const socketRoom = new Map<string, string>();
const actionCooldowns = new Map<string, Map<string, number>>();

function availableRooms(): RoomState[] {
  return [...rooms.values()].filter((room) => room.players.size < MAX_PLAYERS);
}

function broadcastRooms(): void {
  io.emit('rooms', availableRooms().map(summary));
}

function systemMessage(roomId: string, text: string): void {
  const message: ChatMessage = {
    id: crypto.randomUUID(),
    playerId: 'system',
    name: 'Диспетчер стога',
    text,
    at: Date.now(),
    kind: 'system',
  };
  io.to(roomId).emit('chat', message);
}

function leaveCurrentRoom(socketId: string): void {
  const roomId = socketRoom.get(socketId);
  if (!roomId) return;
  const room = rooms.get(roomId);
  const player = room?.players.get(socketId);
  socketRoom.delete(socketId);
  actionCooldowns.delete(socketId);
  if (!room || !player) return;
  room.players.delete(socketId);
  io.to(roomId).emit('playerLeft', socketId);
  systemMessage(roomId, `${player.name} вышел из сена.`);
  if (room.players.size === 0) {
    if (room.resetTimer) clearTimeout(room.resetTimer);
    rooms.delete(roomId);
  }
  broadcastRooms();
}

function join(socketId: string, room: RoomState, playerName: string, avatar: AvatarId): JoinResult {
  if (room.players.size >= MAX_PLAYERS) return { ok: false, error: 'В комнате уже восемь сенокосцев.' };
  leaveCurrentRoom(socketId);
  const player = createPlayer(socketId, playerName, avatar);
  room.players.set(socketId, player);
  socketRoom.set(socketId, room.id);
  return { ok: true, room: snapshot(room), playerId: socketId };
}

function announceJoin(socketId: string, room: RoomState): void {
  const socket = io.sockets.sockets.get(socketId);
  const player = room.players.get(socketId);
  if (!socket || !player) return;
  socket.join(room.id);
  socket.to(room.id).emit('playerJoined', player);
  systemMessage(room.id, `${player.name} нырнул в стог. Берегите иглу.`);
  broadcastRooms();
}

function nextRound(room: RoomState): void {
  room.round += 1;
  room.seed = Math.floor(Math.random() * 2_000_000_000);
  room.roundEndsAt = Date.now() + ROUND_MS;
  room.resetTimer = undefined;
  for (const player of room.players.values()) {
    const angle = Math.random() * Math.PI * 2;
    player.position = { x: Math.cos(angle) * 12, y: 0, z: Math.sin(angle) * 12 };
  }
  io.to(room.id).emit('roundReset', {
    round: room.round,
    roundEndsAt: room.roundEndsAt,
    seed: room.seed,
    players: [...room.players.values()],
  });
  systemMessage(room.id, `Раунд ${room.round}. Новая игла уже где-то там. Да, мы тоже её потеряли.`);
  broadcastRooms();
}

function cooldownReady(socketId: string, key: string, duration: number): boolean {
  const now = Date.now();
  const current = actionCooldowns.get(socketId) ?? new Map<string, number>();
  if ((current.get(key) ?? 0) > now) return false;
  current.set(key, now + duration);
  actionCooldowns.set(socketId, current);
  return true;
}

io.on('connection', (socket) => {
  socket.emit('rooms', availableRooms().map(summary));

  socket.on('listRooms', () => socket.emit('rooms', availableRooms().map(summary)));

  socket.on('createRoom', (options, callback) => {
    const room = createRoom(options.name);
    while (rooms.has(room.id)) room.id = Math.random().toString(36).slice(2, 7).toUpperCase();
    rooms.set(room.id, room);
    const result = join(socket.id, room, options.playerName, options.avatar);
    callback(result);
    if (result.ok) announceJoin(socket.id, room);
  });

  socket.on('joinRoom', (options, callback) => {
    const room = rooms.get(safeText(options.roomId, 5).toUpperCase());
    if (!room) return callback({ ok: false, error: 'Комната не найдена. Возможно, стог уже увезли.' });
    const result = join(socket.id, room, options.playerName, options.avatar);
    callback(result);
    if (result.ok) announceJoin(socket.id, room);
  });

  socket.on('quickJoin', (options, callback) => {
    let room = availableRooms().sort((a, b) => b.players.size - a.players.size)[0];
    if (!room) {
      room = createRoom('Быстрый стог');
      rooms.set(room.id, room);
    }
    const result = join(socket.id, room, options.playerName, options.avatar);
    callback(result);
    if (result.ok) announceJoin(socket.id, room);
  });

  socket.on('leaveRoom', () => {
    const roomId = socketRoom.get(socket.id);
    if (roomId) socket.leave(roomId);
    leaveCurrentRoom(socket.id);
  });

  socket.on('move', (position, yaw) => {
    const roomId = socketRoom.get(socket.id);
    const room = roomId ? rooms.get(roomId) : undefined;
    const player = room?.players.get(socket.id);
    if (!roomId || !player) return;
    player.position = clampPosition(position);
    player.yaw = Number.isFinite(yaw) ? yaw : 0;
    socket.to(roomId).emit('playerMoved', { id: player.id, position: player.position, yaw: player.yaw });
  });

  socket.on('chat', (rawText) => {
    const roomId = socketRoom.get(socket.id);
    const room = roomId ? rooms.get(roomId) : undefined;
    const player = room?.players.get(socket.id);
    if (!roomId || !player || !cooldownReady(socket.id, 'chat', 450)) return;
    const text = safeText(rawText, 180);
    if (!text) return;
    io.to(roomId).emit('chat', {
      id: crypto.randomUUID(),
      playerId: player.id,
      name: player.name,
      text,
      at: Date.now(),
      kind: 'chat',
    });
  });

  socket.on('action', (type) => {
    const roomId = socketRoom.get(socket.id);
    const room = roomId ? rooms.get(roomId) : undefined;
    const player = room?.players.get(socket.id);
    if (!roomId || !room || !player) return;
    const durations = { sneeze: 8500, magnet: 14000, goose: 1500 } as const;
    if (!(type in durations) || !cooldownReady(socket.id, type, durations[type])) return;
    const action: ActionEvent = {
      playerId: player.id,
      playerName: player.name,
      type,
      at: Date.now(),
      position: player.position,
    };
    io.to(roomId).emit('action', action);
    if (type === 'sneeze') systemMessage(roomId, `${player.name}: АПЧХИ! Стог официально стал менее организованным.`);
    if (type === 'goose') systemMessage(roomId, `Гусь оштрафовал ${player.name} за подозрительно профессиональный поиск.`);
    if (type === 'magnet') {
      const needle = (awaitImportNeedle(room.seed));
      const dx = needle.x - player.position.x;
      const dz = needle.z - player.position.z;
      const distance = Math.hypot(dx, dz);
      const strength = distance < 1.8 ? 'molten' : distance < 4 ? 'hot' : distance < 7 ? 'warm' : 'cold';
      socket.emit('magnetResult', { distance, bearing: Math.atan2(dx, dz), strength });
      systemMessage(roomId, `${player.name} включил магнит и теперь светится как читер. Пользуйтесь моментом.`);
    }
  });

  socket.on('search', () => {
    const roomId = socketRoom.get(socket.id);
    const room = roomId ? rooms.get(roomId) : undefined;
    const player = room?.players.get(socket.id);
    if (!roomId || !room || !player || room.resetTimer || !cooldownReady(socket.id, 'search', 400)) return;
    const distance = distanceToNeedle(room, player);
    if (distance > 1.25) {
      socket.emit('toast', distance < 2.5 ? 'Где-то совсем рядом звякнуло…' : 'Только солома. И немного достоинства.');
      return;
    }
    player.score += 1;
    io.to(roomId).emit('action', {
      playerId: player.id,
      playerName: player.name,
      type: 'found',
      at: Date.now(),
      position: player.position,
    });
    systemMessage(roomId, `${player.name} НАШЁЛ ИГЛУ! Новый стог через 5 секунд.`);
    io.to(roomId).emit('roomState', snapshot(room));
    room.resetTimer = setTimeout(() => nextRound(room), 5000);
  });

  socket.on('disconnect', () => leaveCurrentRoom(socket.id));
});

// Kept sync so action handling stays cheap in the hot path.
function awaitImportNeedle(seed: number) {
  const random = mulberryForServer(seed ^ 0x51e2d);
  const angle = random() * Math.PI * 2;
  const radius = 1.2 + Math.sqrt(random()) * 7.25;
  const x = Math.cos(angle) * radius;
  const z = Math.sin(angle) * radius;
  return { x, z };
}

function mulberryForServer(seed: number): () => number {
  return () => {
    let value = (seed += 0x6d2b79f5);
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

app.get('/api/health', (_request, response) => {
  response.json({ ok: true, service: 'haywire', rooms: rooms.size, players: socketRoom.size, uptime: Math.round(process.uptime()) });
});

if (isProduction) {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const staticDir = path.resolve(currentDir, '../../dist');
  app.use(express.static(staticDir, { maxAge: '7d', immutable: true }));
  app.get('*path', (_request, response) => response.sendFile(path.join(staticDir, 'index.html')));
} else {
  const { createServer: createViteServer } = await import('vite');
  const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' });
  app.use(vite.middlewares);
}

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`HAYWIRE listening on http://0.0.0.0:${PORT} (${isProduction ? 'production' : 'development'})`);
});
