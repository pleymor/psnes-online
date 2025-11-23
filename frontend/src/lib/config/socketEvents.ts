// Socket event names as constants to avoid typos and enable IDE autocomplete

// Room events
export const ROOM_EVENTS = {
  LIST: 'rooms:list',
  CREATED: 'room:created',
  UPDATED: 'room:updated',
  UPDATE: 'room:update',
  DESTROYED: 'room:destroyed',
  JOIN: 'room:join',
  LEAVE: 'room:leave',
  SELECT_PORT: 'room:selectPort',
  UNSELECT_PORT: 'room:unselectPort',
  UPDATE_KEY_CONFIG: 'room:updateKeyConfig',
  TOGGLE_READY: 'room:toggleReady'
} as const;

// Game events
export const GAME_EVENTS = {
  START: 'game:start',
  STARTED: 'game:started',
  INPUT: 'game:input',
  PAUSE: 'game:pause',
  PAUSED: 'game:paused',
  RESUME: 'game:resume',
  RESUMED: 'game:resumed',
  STOP: 'game:stop',
  STOPPED: 'game:stopped',
  SAVE: 'game:save',
  SAVED: 'game:saved',
  LOAD: 'game:load',
  LOADED: 'game:loaded',
  SET_SPEED: 'game:setSpeed',
  SPEED_CHANGED: 'game:speedChanged',
  SET_TARGET_FPS: 'game:setTargetFPS',
  TARGET_FPS_CHANGED: 'game:targetFPSChanged'
} as const;

// Friend events
export const FRIEND_EVENTS = {
  GET_ONLINE_STATUS: 'friends:getOnlineStatus',
  ONLINE: 'friends:online',
  STATUS_CHANGED: 'friend:statusChanged',
  REQUEST_RECEIVED: 'friend:requestReceived',
  REQUEST_ACCEPTED: 'friend:requestAccepted',
  REQUEST_REJECTED: 'friend:requestRejected',
  REMOVED: 'friend:removed',
  ROOM_CREATED: 'friend:roomCreated',
  ROOM_STATUS_CHANGED: 'friend:roomStatusChanged'
} as const;

// P2P/WebRTC events
export const P2P_EVENTS = {
  JOIN: 'p2p:join',
  JOINED: 'p2p:joined',
  PEER_JOINED: 'p2p:peer-joined',
  SIGNAL: 'webrtc:signal'
} as const;

// Player events
export const PLAYER_EVENTS = {
  LEFT: 'player:left'
} as const;

// Host events
export const HOST_EVENTS = {
  LEFT: 'host:left'
} as const;

// Generic events
export const GENERIC_EVENTS = {
  ERROR: 'error',
  CONNECT: 'connect',
  DISCONNECT: 'disconnect'
} as const;

// All events combined
export const SOCKET_EVENTS = {
  ...ROOM_EVENTS,
  ...GAME_EVENTS,
  ...FRIEND_EVENTS,
  ...P2P_EVENTS,
  ...PLAYER_EVENTS,
  ...HOST_EVENTS,
  ...GENERIC_EVENTS
} as const;
