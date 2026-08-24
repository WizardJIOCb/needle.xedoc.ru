import type { AvatarId, PlayerState, RoomSnapshot, RoomSummary, Vec3State } from '../src/shared/protocol.js';

export const MAX_PLAYERS = 8;
export const ROUND_MS = 3 * 60 * 1000;
export const ARENA_RADIUS = 15.5;

export interface RoomState {
  id: string;
  name: string;
  players: Map<string, PlayerState>;
  round: number;
  roundEndsAt: number;
  seed: number;
  resetTimer?: NodeJS.Timeout;
  roundTimer?: NodeJS.Timeout;
}

export function safeText(value: unknown, maxLength: number, fallback = ''): string {
  const text = typeof value === 'string' ? value.replace(/[<>\u0000-\u001f]/g, '').trim() : '';
  return text.slice(0, maxLength) || fallback;
}

export function roomCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 5; i += 1) code += alphabet[Math.floor(Math.random() * alphabet.length)];
  return code;
}

export function createPlayer(id: string, name: string, avatar: AvatarId): PlayerState {
  const angle = Math.random() * Math.PI * 2;
  return {
    id,
    name: safeText(name, 18, 'Сенокосец'),
    avatar,
    position: { x: Math.cos(angle) * 12, y: 0, z: Math.sin(angle) * 12 },
    yaw: angle + Math.PI,
    score: 0,
    joinedAt: Date.now(),
  };
}

export function createRoom(name: string): RoomState {
  return {
    id: roomCode(),
    name: safeText(name, 28, 'Стог без названия'),
    players: new Map(),
    round: 1,
    roundEndsAt: Date.now() + ROUND_MS,
    seed: Math.floor(Math.random() * 2_000_000_000),
  };
}

export function summary(room: RoomState): RoomSummary {
  return { id: room.id, name: room.name, players: room.players.size, capacity: MAX_PLAYERS, round: room.round };
}

export function snapshot(room: RoomState): RoomSnapshot {
  return {
    id: room.id,
    name: room.name,
    players: [...room.players.values()],
    capacity: MAX_PLAYERS,
    round: room.round,
    roundEndsAt: room.roundEndsAt,
    seed: room.seed,
  };
}

export function clampPosition(position: Vec3State): Vec3State {
  const x = Number.isFinite(position.x) ? position.x : 0;
  const z = Number.isFinite(position.z) ? position.z : 0;
  const length = Math.hypot(x, z);
  const scale = length > ARENA_RADIUS ? ARENA_RADIUS / length : 1;
  return { x: x * scale, y: 0, z: z * scale };
}

export function mulberry32(seed: number): () => number {
  return () => {
    let value = (seed += 0x6d2b79f5);
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function surfaceHeight(x: number, z: number): number {
  const r = Math.hypot(x, z);
  if (r >= 9.2) return 0;
  const normalized = r / 9.2;
  const mound = 4.7 * Math.pow(1 - normalized * normalized, 0.72);
  const ripple = Math.sin(x * 1.7) * Math.cos(z * 1.4) * 0.11 * (1 - normalized);
  return Math.max(0, mound + ripple);
}

export function needlePosition(seed: number): Vec3State {
  const random = mulberry32(seed ^ 0x51e2d);
  const angle = random() * Math.PI * 2;
  const radius = 1.2 + Math.sqrt(random()) * 7.25;
  const x = Math.cos(angle) * radius;
  const z = Math.sin(angle) * radius;
  return { x, y: surfaceHeight(x, z) + 0.12, z };
}

export function distanceToNeedle(room: RoomState, player: PlayerState): number {
  const needle = needlePosition(room.seed);
  return Math.hypot(player.position.x - needle.x, player.position.z - needle.z);
}
