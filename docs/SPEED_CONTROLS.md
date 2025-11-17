# Emulation Speed Controls

## Overview

PSNES supports dynamic emulation speed control, allowing you to speed up, slow down, or unlock the frame rate for maximum performance during gameplay.

## Keyboard Shortcuts

### Quick Controls

| Key | Action |
|-----|--------|
| `Tab` | Toggle between normal speed (1x) and unlimited speed (MAX) |
| `+` or `=` | Increase speed (cycle through presets) |
| `-` | Decrease speed (cycle through presets) |

### Speed Presets

The emulator supports the following speed presets:

| Speed | FPS | Description | Use Case |
|-------|-----|-------------|----------|
| **0.5x** | 30 FPS | Slow motion | Precise platforming, studying game mechanics |
| **1x** | 60 FPS | Normal speed | Default gameplay experience |
| **2x** | 120 FPS | Double speed | Grinding, traveling, fast-forwarding cutscenes |
| **3x** | 180 FPS | Triple speed | Extreme fast-forward |
| **MAX** | Unlimited | Maximum CPU speed | Fastest possible execution, speedruns |

## Visual Feedback

When you change the emulation speed, a speed indicator appears in the top-right corner of the screen:

```
┌─────────────────┐
│       ⚡        │
│      MAX        │
│ Tab: Toggle     │
│   +/-: Adjust   │
└─────────────────┘
```

**Indicator Details:**
- **Lightning bolt (⚡)**: Pulses to show active speed mode
- **Speed label**: Shows current speed (e.g., "2x", "MAX")
- **Blue glow**: Normal/fixed speeds (0.5x - 3x)
- **Red glow**: Unlimited speed (MAX)
- **Auto-hide**: Disappears after 2 seconds

## Technical Implementation

### Backend Architecture

#### Speed Modes

1. **Fixed Speed (0.5x - 3x)**
   - Uses `setInterval()` with calculated frame timing
   - Frame time = `(1000ms / 60 FPS) / speed_multiplier`
   - Example: 2x speed = 8.33ms per frame (120 FPS)

2. **Unlimited Speed (MAX)**
   - Uses `setImmediate()` for zero-delay frame execution
   - Runs frames as fast as the CPU can process them
   - No artificial frame limiting
   - Controlled by `unlimitedSpeedActive` flag

#### Key Components

**File**: `backend/src/emulator/snes-emulator.ts`

```typescript
interface EmulatorConfig {
  speed?: number; // 1.0 = normal, 2.0 = 2x, 0 = unlimited
}

class SNESEmulator {
  setSpeed(speed: number): void;
  getSpeed(): number;
}
```

**File**: `backend/src/emulator/manager.ts`

```typescript
class EmulatorManager {
  setEmulatorSpeed(roomId: string, speed: number): void;
  getEmulatorSpeed(roomId: string): number | null;
}
```

**File**: `backend/src/websocket/index.ts`

```typescript
socket.on('game:setSpeed', (data: { roomId: string; speed: number }) => {
  emulatorManager.setEmulatorSpeed(data.roomId, data.speed);
  io.to(data.roomId).emit('game:speedChanged', { speed: data.speed });
});
```

### Frontend Architecture

**File**: `frontend/src/lib/components/GameCanvas.svelte`

```typescript
// Speed presets
const speedPresets = [0.5, 1.0, 2.0, 3.0, 0]; // 0 = unlimited

// Speed control functions
function toggleSpeed()    // Tab key
function increaseSpeed()  // + key
function decreaseSpeed()  // - key
function setSpeed(speed)  // Send to backend via WebSocket
```

## Multiplayer Synchronization

Speed changes are synchronized across all players in a room:

1. Player A presses `Tab` to enable MAX speed
2. Frontend emits `game:setSpeed` to backend
3. Backend updates emulator speed
4. Backend broadcasts `game:speedChanged` to all players in room
5. All players see the speed indicator update

**Note**: Speed changes affect all players. This prevents desynchronization in multiplayer sessions.

## Performance Considerations

### Unlimited Speed (MAX)

**Pros:**
- Maximum possible execution speed
- Great for single-player speedruns
- Useful for fast-forwarding through known sections

**Cons:**
- High CPU usage (100% on one core)
- May cause frame drops on slower systems
- Audio may become choppy at extreme speeds
- WebSocket bandwidth increases due to more frames/second

**Recommendations:**
- Use on modern CPUs (2015+)
- Monitor CPU temperature during extended use
- Consider lower multiplier speeds (2x, 3x) for better stability

### Fixed Speed Multipliers

**2x-3x speeds:**
- More predictable performance
- Better audio quality
- Lower CPU usage than unlimited
- Smoother experience on mid-range systems

## Pause/Resume Behavior

Speed settings are preserved when pausing and resuming:

```
1. Start game at 1x speed
2. Press Tab → MAX speed (unlimited)
3. Press Escape → Pause (speed setting retained)
4. Press Escape → Resume (continues at MAX speed)
```

## API Reference

### WebSocket Events

#### Client → Server

**`game:setSpeed`**
```typescript
{
  roomId: string;  // Room identifier
  speed: number;   // Speed multiplier (0 = unlimited)
}
```

#### Server → Client

**`game:speedChanged`**
```typescript
{
  speed: number;   // New speed multiplier
}
```

### Backend API

**Set Speed**
```typescript
emulatorManager.setEmulatorSpeed(roomId: string, speed: number): void
```

**Get Current Speed**
```typescript
emulatorManager.getEmulatorSpeed(roomId: string): number | null
```

## Browser Console Usage

For testing or advanced control, you can change speed via browser console:

```javascript
// Get the socket connection
const socket = window.$socket;

// Set speed to 2x
socket.emit('game:setSpeed', { roomId: 'your-room-id', speed: 2 });

// Set unlimited speed
socket.emit('game:setSpeed', { roomId: 'your-room-id', speed: 0 });

// Set slow motion
socket.emit('game:setSpeed', { roomId: 'your-room-id', speed: 0.5 });
```

## Troubleshooting

### Speed doesn't change
- **Check**: Ensure game is running (not paused)
- **Fix**: Resume the game before changing speed

### Unlimited speed freezes the game
- **Cause**: Old implementation issue (fixed in current version)
- **Fix**: Update to latest version with `unlimitedSpeedActive` flag

### Speed indicator doesn't appear
- **Check**: Browser console for errors
- **Fix**: Refresh the page to reload frontend code

### Audio becomes distorted at high speeds
- **Expected**: Audio playback may struggle at 3x+ speeds
- **Workaround**: Use lower speed multipliers (2x) for better audio

### CPU usage at 100%
- **Expected**: Unlimited speed uses maximum CPU
- **Workaround**: Use fixed speed multipliers instead of MAX

## Future Enhancements

Planned improvements for speed control:

- [ ] Frame skip option for even faster speeds
- [ ] Audio pitch correction at different speeds
- [ ] Per-player speed settings in multiplayer
- [ ] Speed presets customization in settings
- [ ] Hotkey remapping
- [ ] Speed history/favorites
- [ ] Frame advance (single-step debugging)

## Credits

Speed control implementation based on:
- **libretro API**: Core emulation framework
- **snes9x-next**: SNES emulation core
- **Node.js**: `setImmediate()` for unlimited speed
- **Socket.IO**: Real-time speed synchronization

---

**Last Updated**: 2025-11-16
**Version**: 1.0.0
**Compatibility**: PSNES v1.0+
