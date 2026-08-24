export type AvatarId = 'rust' | 'lime' | 'sky' | 'pink' | 'cream' | 'violet';

export interface Vec3State {
  x: number;
  y: number;
  z: number;
}

export interface PlayerState {
  id: string;
  name: string;
  avatar: AvatarId;
  position: Vec3State;
  yaw: number;
  score: number;
  joinedAt: number;
}

export interface RoomSummary {
  id: string;
  name: string;
  players: number;
  capacity: number;
  round: number;
}

export interface RoomSnapshot {
  id: string;
  name: string;
  players: PlayerState[];
  capacity: number;
  round: number;
  roundEndsAt: number;
  seed: number;
}

export interface ChatMessage {
  id: string;
  playerId: string | 'system';
  name: string;
  text: string;
  at: number;
  kind: 'chat' | 'system';
}

export interface RoomOptions {
  name: string;
  playerName: string;
  avatar: AvatarId;
}

export interface JoinOptions {
  roomId: string;
  playerName: string;
  avatar: AvatarId;
}

export interface JoinResult {
  ok: boolean;
  error?: string;
  room?: RoomSnapshot;
  playerId?: string;
}

export interface ActionEvent {
  playerId: string;
  playerName: string;
  type: 'sneeze' | 'magnet' | 'goose' | 'found';
  at: number;
  position?: Vec3State;
}

export interface MagnetResult {
  distance: number;
  bearing: number;
  strength: 'cold' | 'warm' | 'hot' | 'molten';
}

export interface ServerToClientEvents {
  rooms: (rooms: RoomSummary[]) => void;
  roomState: (state: RoomSnapshot) => void;
  playerJoined: (player: PlayerState) => void;
  playerLeft: (playerId: string) => void;
  playerMoved: (player: Pick<PlayerState, 'id' | 'position' | 'yaw'>) => void;
  chat: (message: ChatMessage) => void;
  action: (action: ActionEvent) => void;
  magnetResult: (result: MagnetResult) => void;
  roundReset: (state: Pick<RoomSnapshot, 'round' | 'roundEndsAt' | 'seed' | 'players'>) => void;
  toast: (message: string) => void;
}

export interface ClientToServerEvents {
  listRooms: () => void;
  createRoom: (options: RoomOptions, callback: (result: JoinResult) => void) => void;
  joinRoom: (options: JoinOptions, callback: (result: JoinResult) => void) => void;
  quickJoin: (options: Omit<JoinOptions, 'roomId'>, callback: (result: JoinResult) => void) => void;
  leaveRoom: () => void;
  move: (position: Vec3State, yaw: number) => void;
  chat: (text: string) => void;
  action: (type: 'sneeze' | 'magnet' | 'goose') => void;
  search: () => void;
}
