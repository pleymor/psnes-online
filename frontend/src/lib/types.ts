export interface KeyConfig {
  up: string;
  down: string;
  left: string;
  right: string;
  a: string;
  b: string;
  x: string;
  y: string;
  l: string;
  r: string;
  start: string;
  select: string;
}

export interface RoomPlayer {
  userId: string;
  displayName: string;
  avatar?: string;
  port: 1 | 2 | null;
  isReady: boolean;
  keyConfig: KeyConfig;
}

export interface Room {
  id: string;
  gameId: string;
  gameTitle: string;
  hostId: string;
  players: RoomPlayer[];
  status: 'waiting' | 'playing';
  createdAt: Date;
}
