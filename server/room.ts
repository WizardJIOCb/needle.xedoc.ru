import type { AvatarId, PlayerState, RoomSnapshot, RoomSummary, Vec3State } from '../src/shared/protocol.js';
import { repairMojibake } from '../src/shared/encoding.js';
import { needlePosition, surfaceHeight } from '../src/shared/hay.js';

export { needlePosition, surfaceHeight };

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
  pulledStraws: Set<number>;
  resetTimer?: NodeJS.Timeout;
  roundTimer?: NodeJS.Timeout;
}

export function safeText(value: unknown, maxLength: number, fallback = ''): string {
  const text = typeof value === 'string' ? repairMojibake(value).replace(/[<>\u0000-\u001f]/g, '').trim() : '';
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
    position: { x: Math.cos(angle) * 10.4, y: 0, z: Math.sin(angle) * 10.4 },
    // Camera forward is (-sin(yaw), -cos(yaw)); face the arena centre.
    yaw: Math.PI / 2 - angle,
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
    pulledStraws: new Set(),
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
    pulledStraws: [...room.pulledStraws],
  };
}

export function clampPosition(position: Vec3State): Vec3State {
  const x = Number.isFinite(position.x) ? position.x : 0;
  const y = Number.isFinite(position.y) ? Math.min(7.5, Math.max(0, position.y)) : 0;
  const z = Number.isFinite(position.z) ? position.z : 0;
  const length = Math.hypot(x, z);
  const scale = length > ARENA_RADIUS ? ARENA_RADIUS / length : 1;
  return { x: x * scale, y, z: z * scale };
}

export function distanceToNeedle(room: RoomState, player: PlayerState): number {
  const needle = needlePosition(room.seed);
  return Math.hypot(player.position.x - needle.x, player.position.z - needle.z);
}
