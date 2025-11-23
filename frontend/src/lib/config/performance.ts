// Performance-related constants and thresholds

// Gamepad polling
export const GAMEPAD_POLL_INTERVAL_MS = 16; // ~60Hz
export const GAMEPAD_AXIS_DEADZONE = 0.15;
export const GAMEPAD_BUTTON_THRESHOLD = 0.5;

// Video streaming
export const ESTIMATED_PIPELINE_LATENCY_MS = 45; // Encoding + network + decoding
export const VIDEO_BUFFER_LAG_THRESHOLD_LOW = 0.1; // 100ms
export const VIDEO_BUFFER_LAG_THRESHOLD_HIGH = 0.2; // 200ms
export const VIDEO_BUFFER_MONITOR_INTERVAL_MS = 2000;

// Latency measurement
export const LATENCY_HISTORY_SIZE = 10;
export const FRAME_TIMESTAMP_INTERVAL_MS = 100;
export const INPUT_ACK_TIMEOUT_MS = 1000;

// Frame rates
export const DEFAULT_TARGET_FPS = 60;
export const FRAME_TIME_MS = 1000 / DEFAULT_TARGET_FPS;

// Network
export const WEBRTC_ICE_TIMEOUT_MS = 10000;
export const P2P_CONNECTION_TIMEOUT_MS = 30000;

// UI
export const NOTIFICATION_DURATION_MS = 3000;
export const MODAL_ANIMATION_DURATION_MS = 200;
export const DEBOUNCE_DELAY_MS = 300;
