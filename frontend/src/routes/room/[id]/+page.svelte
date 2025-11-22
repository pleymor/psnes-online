<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';
  import { browser } from '$app/environment';
  import { socket } from '$lib/api/socket';
  import { goto } from '$app/navigation';
  import { user } from '$lib/stores/user';
  import { language } from '$lib/stores/language';
  import { t } from '$lib/i18n/translations';
  import ClientEmulator from '$lib/components/ClientEmulator.svelte';
  import RoomPlayers from '$lib/components/RoomPlayers.svelte';
  import PauseMenu from '$lib/components/PauseMenu.svelte';
  import { P2PManager, captureCanvasStream } from '$lib/webrtc/p2p-manager';
  import { initializeAudioCapture, getAudioStream } from '$lib/emulator/audio-capture';
  import type { Room, KeyConfig } from '$lib/types';
  import { DEBUG } from '$lib/config/debug';

  export let data;

  let room: Room | null = null;
  let gameStarted = false;
  let showPauseMenu = false;
  let showToast = false;
  let toastMessage = '';
  let toastType: 'success' | 'error' = 'success';
  let userKeyConfig: KeyConfig = {
    up: 'ArrowUp',
    down: 'ArrowDown',
    left: 'ArrowLeft',
    right: 'ArrowRight',
    a: 'KeyX',
    b: 'KeyZ',
    x: 'KeyS',
    y: 'KeyA',
    l: 'KeyQ',
    r: 'KeyW',
    start: 'Enter',
    select: 'ShiftRight'
  };

  let keyConfig: KeyConfig = userKeyConfig; // Will be updated by reactive statement

  // Client-side emulator state
  let emulatorComponent: ClientEmulator;
  let emulatorInstance: any;
  let p2pManager: P2PManager | null = null;
  let romData: ArrayBuffer | null = null;
  let loading = false;
  let error: string | null = null;
  let guestVideoElement: HTMLVideoElement;
  let guestStream: MediaStream | null = null; // Store stream until video element is ready
  let connectionStatus: 'connecting' | 'connected' | 'disconnected' = 'disconnected';
  let gamepadPollInterval: number | null = null;
  let frameTimestampInterval: number | null = null;
  let videoBufferMonitorInterval: number | null = null; // Monitor video buffer lag
  let lastGamepadState: Record<string, boolean> = {};

  // Latency tracking for guest
  let inputLatency = 0;
  let videoLatency = 0;
  let totalLatency = 0;
  let latencyHistoryInput: number[] = [];
  let latencyHistoryVideo: number[] = [];
  const LATENCY_HISTORY_SIZE = 10;

  // Video latency breakdown (for display)
  let networkLatency = 0;
  let pipelineLatency = 0;

  // P2P connection info
  let connectionType = 'connecting';
  let connectionRTT = 0;

  // Fullscreen state for guest
  let guestContainerElement: HTMLDivElement;

  $: roomId = data.roomId;

  // Get current user's key configuration - prefer user's personal config, then room config, then defaults
  $: currentPlayer = room?.players.find(p => p.userId === $user?.id);
  $: {
    keyConfig = currentPlayer?.keyConfig || userKeyConfig;
  }
  $: playerPort = (currentPlayer?.port ?? null) as 1 | 2 | null; // Get player's selected port (null if spectator)

  // Determine if current player is the room host (the one who runs the emulator)
  // This is based on who created the room, NOT which controller port they chose
  $: isRoomHost = room?.hostId === $user?.id;
  $: isHost = isRoomHost; // Room host runs the emulator
  $: isGuest = !isRoomHost; // Everyone else receives the stream

  // Check if at least one player is ready (has a port)
  $: canStartGame = room?.players.some(p => p.port !== null && p.isReady) ?? false;

  // Attach stream to video element when both are available
  $: if (guestVideoElement && guestStream) {
    guestVideoElement.srcObject = guestStream;

    // CRITICAL: Ultra-low latency optimizations
    try {
      // Inline playback (mobile)
      guestVideoElement.playsInline = true;
      guestVideoElement.setAttribute('playsinline', '');
      guestVideoElement.setAttribute('webkit-playsinline', '');

      // Disable all buffering
      guestVideoElement.preload = 'none';
      // @ts-ignore - Experimental but critical for low latency
      guestVideoElement.disablePictureInPicture = true;

      // CRITICAL: Set video to synchronize to audio, not buffer ahead
      // This prevents the video from buffering multiple frames
      // @ts-ignore
      if (typeof guestVideoElement.setSinkId !== 'undefined') {
        // Use default audio output for sync
        guestVideoElement.setSinkId('').catch(() => {});
      }

      // Disable remote playback (Chromecast, etc.) which adds latency
      // @ts-ignore
      if (guestVideoElement.disableRemotePlayback !== undefined) {
        // @ts-ignore
        guestVideoElement.disableRemotePlayback = true;
      }

      // Firefox-specific: disable audio pitch preservation
      // @ts-ignore
      if (guestVideoElement.mozPreservesPitch !== undefined) {
        // @ts-ignore
        guestVideoElement.mozPreservesPitch = false;
      }

      // Check for requestVideoFrameCallback support (Chrome 83+)
      // @ts-ignore
      if ('requestVideoFrameCallback' in guestVideoElement) {
        if (DEBUG()) console.log('✅ requestVideoFrameCallback available - frame-perfect rendering');
      }

      if (DEBUG()) {
        console.log('✅ Video element optimized for ultra-low latency');
        console.log('   - Buffer disabled');
        console.log('   - PiP disabled');
        console.log('   - Remote playback disabled');
      }

    } catch (e) {
      console.warn('Could not set all low latency video options:', e);
    }

    // Start playback with lowest possible latency
    guestVideoElement.play().then(() => {
      // CRITICAL: Force video to catch up to live edge after initial buffering
      // This prevents the "lag on first launch" issue
      setTimeout(() => {
        try {
          // Skip to the most recent frame (live edge)
          // @ts-ignore - seekToLiveEdge not in standard types but supported in Chrome
          if (typeof guestVideoElement.seekToLiveEdge === 'function') {
            // @ts-ignore
            guestVideoElement.seekToLiveEdge();
          }

          // Alternative: manually sync to current time if buffered
          if (guestVideoElement.buffered.length > 0) {
            const bufferedEnd = guestVideoElement.buffered.end(guestVideoElement.buffered.length - 1);
            const currentTime = guestVideoElement.currentTime;
            const lag = bufferedEnd - currentTime;

            if (lag > 0.1) { // More than 100ms of buffer accumulated
              if (DEBUG()) console.log(`⚡ Skipping ${lag.toFixed(2)}s of buffered video to catch up to live`);
              guestVideoElement.currentTime = bufferedEnd - 0.05; // Stay 50ms behind live edge
            }
          }
        } catch (e) {
          // Ignore errors from seekToLiveEdge
        }
      }, 500); // Wait 500ms for initial buffering, then flush

      // CRITICAL: Continuously monitor and correct video buffer lag
      // This prevents gradual drift over time
      if (!isRoomHost) {
        videoBufferMonitorInterval = window.setInterval(() => {
          try {
            if (guestVideoElement && guestVideoElement.buffered.length > 0) {
              const bufferedEnd = guestVideoElement.buffered.end(guestVideoElement.buffered.length - 1);
              const currentTime = guestVideoElement.currentTime;
              const lag = bufferedEnd - currentTime;

              // If we're more than 200ms behind live, skip forward
              if (lag > 0.2) {
                if (DEBUG()) console.log(`⚡ Auto-correcting ${lag.toFixed(2)}s video lag`);
                guestVideoElement.currentTime = bufferedEnd - 0.05; // Jump to near-live
              }
            }
          } catch (e) {
            // Ignore errors
          }
        }, 2000); // Check every 2 seconds
      }
    }).catch(err => console.error('Failed to play video:', err));
  }

  async function loadROM() {
    if (!room?.gameId) return;

    try {
      loading = true;
      const response = await fetch(`/api/games/${room.gameId}/download`, {
        credentials: 'include'
      });

      if (!response.ok) {
        throw new Error('Failed to load ROM');
      }

      romData = await response.arrayBuffer();
      loading = false;

    } catch (err) {
      console.error('Failed to load ROM:', err);
      error = 'Failed to load game';
      loading = false;
    }
  }

  async function setupP2PConnection() {
    if (!$socket) {
      console.error('❌ Cannot setup P2P: Socket not connected');
      error = 'Socket not connected';
      return;
    }

    try {
      connectionStatus = 'connecting';

      // Join the P2P room via Socket.IO
      await new Promise<void>((resolve) => {
        $socket!.emit('p2p:join', { roomId });
        $socket!.once('p2p:joined', () => {
          resolve();
        });
      });

      // Initialize P2P manager
      // isRoomHost determines who runs the emulator and sends the stream
      p2pManager = new P2PManager($socket, roomId, isRoomHost, {
        onStream: (stream) => {
          // Store stream - reactive statement will attach it when video element is ready
          guestStream = stream;
          connectionStatus = 'connected';
        },
        onData: (data) => {
          // Handle remote input (for room host running the emulator)
          if (data.type === 'input' && isRoomHost) {
            const receivedAt = performance.now();
            const transitTime = receivedAt - data.timestamp;
            if (DEBUG()) console.log(`🎮 [HOST] Received guest input "${data.button}" - Transit time: ${transitTime.toFixed(2)}ms`);

            emulatorComponent?.handleRemoteInput(data.button, data.pressed);

            // Send ACK back to guest with timestamp
            if (p2pManager && data.inputId && data.timestamp) {
              p2pManager.sendData({
                type: 'input_ack',
                inputId: data.inputId,
                timestamp: data.timestamp,
                receivedAt // Add when host received it
              });
            }
          }

          // Handle ACK from host (for guest measuring latency)
          if (data.type === 'input_ack' && !isRoomHost) {
            const now = performance.now();
            const sendTime = data.timestamp;
            const latency = now - sendTime;

            // Calculate one-way trip and host processing time
            const oneWay = latency / 2;
            const hostReceivedAt = data.receivedAt;
            const transitToHost = hostReceivedAt - sendTime;
            const ackTransitBack = now - hostReceivedAt;

            if (DEBUG()) {
              console.log(`📊 [GUEST] Input ACK received:`);
              console.log(`   - Total RTT: ${latency.toFixed(2)}ms`);
              console.log(`   - Transit to host: ${transitToHost.toFixed(2)}ms`);
              console.log(`   - ACK transit back: ${ackTransitBack.toFixed(2)}ms`);
              console.log(`   - Est. one-way: ${oneWay.toFixed(2)}ms`);
            }

            // Update input latency (round-trip time)
            latencyHistoryInput.push(latency);
            if (latencyHistoryInput.length > LATENCY_HISTORY_SIZE) {
              latencyHistoryInput.shift();
            }
            inputLatency = latencyHistoryInput.reduce((a, b) => a + b, 0) / latencyHistoryInput.length;
          }

          // Handle frame timestamp from host (for guest measuring video latency)
          if (data.type === 'frame_timestamp' && !isRoomHost) {
            // Use Date.now() for cross-device synchronization (both host and guest use system time)
            const now = Date.now();
            const frameTime = data.timestamp;
            networkLatency = now - frameTime; // Store for display

            // IMPORTANT: On local network (same PC), Date.now() measures ONLY network transit time (~0-2ms)
            // We need to add estimated encoding/decoding/rendering pipeline latency:
            // - Canvas capture: ~16ms (1 frame @ 60fps)
            // - H.264 encoding: ~5-10ms (with GPU)
            // - Network: measured above
            // - H.264 decoding: ~5-10ms (with GPU)
            // - Video element rendering: ~16ms (1 frame @ 60fps)
            // TOTAL ESTIMATED: ~42-52ms minimum

            const ESTIMATED_PIPELINE_LATENCY = 45; // Conservative estimate
            pipelineLatency = ESTIMATED_PIPELINE_LATENCY; // Store for display
            const vidLatency = networkLatency + pipelineLatency;

            if (DEBUG()) {
              console.log(`📹 [GUEST] Video latency breakdown:`);
              console.log(`   - Network transit: ${networkLatency.toFixed(2)}ms`);
              console.log(`   - Pipeline (capture+encode+decode+render): ~${pipelineLatency}ms`);
              console.log(`   - TOTAL estimated: ${vidLatency.toFixed(2)}ms`);
            }

            // Update video latency
            latencyHistoryVideo.push(vidLatency);
            if (latencyHistoryVideo.length > LATENCY_HISTORY_SIZE) {
              latencyHistoryVideo.shift();
            }
            videoLatency = latencyHistoryVideo.reduce((a, b) => a + b, 0) / latencyHistoryVideo.length;
            totalLatency = inputLatency + videoLatency;

            if (DEBUG()) console.log(`📊 [GUEST] Total latency: ${totalLatency.toFixed(2)}ms (input: ${inputLatency.toFixed(2)}ms + video: ${videoLatency.toFixed(2)}ms)`);
          }
        },
        onConnect: async () => {
          connectionStatus = 'connected';

          // Get connection metrics for display (for guests only)
          if (!isRoomHost && p2pManager) {
            setTimeout(async () => {
              const metrics = await p2pManager!.getConnectionMetrics();
              if (metrics) {
                connectionType = metrics.type;
                connectionRTT = metrics.rtt;
                if (DEBUG()) console.log('📊 Connection metrics:', metrics);
              }
            }, 2000);
          }

          // Host: Send frame timestamps for video latency measurement
          if (isRoomHost && p2pManager) {
            // Send timestamps frequently for better accuracy (every ~100ms = 6 frames at 60fps)
            // Use Date.now() for cross-device synchronization (system clock)
            frameTimestampInterval = window.setInterval(() => {
              if (p2pManager && connectionStatus === 'connected') {
                p2pManager.sendData({
                  type: 'frame_timestamp',
                  timestamp: Date.now() // System time for cross-device sync
                });
              }
            }, 100); // More frequent updates for better latency tracking
            if (DEBUG()) console.log('📹 Started sending frame timestamps (100ms interval) for video latency measurement');
          }
        },
        onClose: () => {
          connectionStatus = 'disconnected';
          if (frameTimestampInterval) {
            clearInterval(frameTimestampInterval);
            frameTimestampInterval = null;
          }
        },
        onError: (err) => {
          console.error('P2P error:', err);
          connectionStatus = 'disconnected';
          if (frameTimestampInterval) {
            clearInterval(frameTimestampInterval);
            frameTimestampInterval = null;
          }
        }
      });

      // If room host, wait for emulator to be ready, then capture stream
      if (isRoomHost) {
        // IMPROVED: Wait adaptively for canvas to be ready with actual content
        // Instead of arbitrary 3s delay, poll until canvas has rendered frames
        let canvas = emulatorComponent?.getCanvas();
        let attempts = 0;
        const maxAttempts = 60; // Max 3 seconds at 50ms intervals

        while ((!canvas || canvas.width === 0 || canvas.height === 0) && attempts < maxAttempts) {
          await new Promise(resolve => setTimeout(resolve, 50));
          canvas = emulatorComponent?.getCanvas();
          attempts++;
        }

        if (DEBUG()) {
          console.log(`🎮 Canvas ready after ${attempts * 50}ms (${attempts} attempts)`);
          console.log('🎮 Canvas:', canvas);
        }

        if (canvas) {
          if (DEBUG()) {
            console.log(`📐 Canvas resolution: ${canvas.width}x${canvas.height} (CSS: ${canvas.offsetWidth}x${canvas.offsetHeight})`);
            console.log(`✅ Using natural canvas resolution for WebRTC streaming`);
          }

          // Capture video from canvas
          const videoStream = captureCanvasStream(canvas, 60);

          // Lock canvas size to prevent resize issues during WebRTC streaming
          emulatorComponent.lockCanvasSize();
          if (DEBUG()) console.log('🔒 Canvas size locked at 256x224');

          // Try to add audio from the captured emulator audio
          const audioStream = getAudioStream();
          if (audioStream) {
            const audioTracks = audioStream.getAudioTracks();
            if (audioTracks.length > 0) {
              if (DEBUG()) console.log('✅ Adding audio tracks to video stream');
              audioTracks.forEach(track => videoStream.addTrack(track));
            } else {
              console.warn('⚠️ No audio tracks in captured stream');
            }
          } else {
            console.warn('⚠️ No audio stream available');
          }

          await p2pManager.initConnection(videoStream);
        } else {
          throw new Error('Failed to get canvas from emulator');
        }
      } else {
        // Guest: just init connection (no local stream)
        await p2pManager.initConnection();
      }

    } catch (err) {
      console.error('Failed to setup P2P:', err);
      error = 'Failed to establish peer connection';
    }
  }

  function handleEmulatorReady(event: CustomEvent) {
    emulatorInstance = event.detail.emulator;

    // Setup P2P after emulator is ready (room host only)
    if (isRoomHost) {
      setupP2PConnection();
    } else {
    }
  }

  function handleGuestKeyDown(e: KeyboardEvent) {
    // Fullscreen toggle with Alt+Enter (for guest)
    if (e.altKey && e.key === 'Enter') {
      e.preventDefault();
      toggleGuestFullscreen();
      return;
    }

    // Guest sends their input to host via P2P (only if not the room host)
    if (isRoomHost || !p2pManager) return;

    for (const [button, keyCode] of Object.entries(keyConfig)) {
      if (e.code === keyCode) {
        e.preventDefault();
        const timestamp = performance.now();
        const inputId = `${button}_${timestamp}`;
        if (DEBUG()) console.log(`⌨️  [GUEST] Sending input "${button}" (pressed) at ${timestamp.toFixed(2)}ms`);
        p2pManager.sendData({
          type: 'input',
          button,
          pressed: true,
          timestamp,
          inputId
        });
        break;
      }
    }
  }

  function handleGuestKeyUp(e: KeyboardEvent) {
    if (isRoomHost || !p2pManager) return;

    for (const [button, keyCode] of Object.entries(keyConfig)) {
      if (e.code === keyCode) {
        e.preventDefault();
        const timestamp = performance.now();
        const inputId = `${button}_${timestamp}`;
        p2pManager.sendData({
          type: 'input',
          button,
          pressed: false,
          timestamp,
          inputId
        });
        break;
      }
    }
  }

  function pollGamepad() {
    if (isRoomHost || !p2pManager) {
      // Room host doesn't send inputs via P2P
      return;
    }

    // IMPORTANT: Only poll gamepad when THIS window has focus
    // This prevents both host and guest from polling the same physical gamepad
    if (!document.hasFocus()) {
      return;
    }

    const gamepads = navigator.getGamepads();
    let physicalGamepadIndex = 0; // Remap physical gamepads to start from index 0

    // Debug: log gamepad detection (only once per second to avoid spam)
    if (Math.random() < 0.016) { // ~1/60th of the time
    }

    for (let i = 0; i < gamepads.length; i++) {
      const gamepad = gamepads[i];
      if (!gamepad) continue;

      // Skip virtual gamepads - only poll real physical controllers
      if (gamepad.id.includes('Virtual Gamepad')) {
        continue;
      }

      // Use remapped index for config matching (physical gamepads start from 0)
      const configIndex = physicalGamepadIndex;
      physicalGamepadIndex++;


      // Check buttons
      for (let j = 0; j < gamepad.buttons.length; j++) {
        const inputCode = `Gamepad${configIndex}Button${j}`; // Use config index
        const isPressed = gamepad.buttons[j].pressed;
        const wasPressed = lastGamepadState[inputCode] || false;

        if (isPressed !== wasPressed) {
          lastGamepadState[inputCode] = isPressed;

          // Find which button this input is mapped to
          for (const [button, mappedInput] of Object.entries(keyConfig)) {
            if (mappedInput === inputCode) {
              const timestamp = performance.now();
              const inputId = `${button}_${timestamp}`;
              p2pManager.sendData({
                type: 'input',
                button,
                pressed: isPressed,
                timestamp,
                inputId
              });
              break;
            }
          }
        }
      }

      // Check axes (for d-pad on some controllers)
      for (let j = 0; j < gamepad.axes.length; j++) {
        const axisValue = gamepad.axes[j];

        // Check positive direction
        const inputCodePlus = `Gamepad${configIndex}Axis${j}Plus`; // Use config index
        const isPressedPlus = axisValue > 0.5;
        const wasPressedPlus = lastGamepadState[inputCodePlus] || false;

        if (isPressedPlus !== wasPressedPlus) {
          lastGamepadState[inputCodePlus] = isPressedPlus;

          for (const [button, mappedInput] of Object.entries(keyConfig)) {
            if (mappedInput === inputCodePlus) {
              const timestamp = performance.now();
              const inputId = `${button}_${timestamp}`;
              p2pManager.sendData({
                type: 'input',
                button,
                pressed: isPressedPlus,
                timestamp,
                inputId
              });
              break;
            }
          }
        }

        // Check negative direction
        const inputCodeMinus = `Gamepad${configIndex}Axis${j}Minus`; // Use config index
        const isPressedMinus = axisValue < -0.5;
        const wasPressedMinus = lastGamepadState[inputCodeMinus] || false;

        if (isPressedMinus !== wasPressedMinus) {
          lastGamepadState[inputCodeMinus] = isPressedMinus;

          for (const [button, mappedInput] of Object.entries(keyConfig)) {
            if (mappedInput === inputCodeMinus) {
              const timestamp = performance.now();
              const inputId = `${button}_${timestamp}`;
              p2pManager.sendData({
                type: 'input',
                button,
                pressed: isPressedMinus,
                timestamp,
                inputId
              });
              break;
            }
          }
        }
      }
    }
  }

  function startGamepadPolling() {
    if (gamepadPollInterval !== null) return; // Already polling

    gamepadPollInterval = window.setInterval(pollGamepad, 8); // Poll at ~120Hz for lower input latency
  }

  function stopGamepadPolling() {
    if (gamepadPollInterval !== null) {
      clearInterval(gamepadPollInterval);
      gamepadPollInterval = null;
      lastGamepadState = {};
    }
  }

  onMount(async () => {
    if (!$socket) {
      goto('/');
      return;
    }

    // Load user's personal control configuration
    try {
      const res = await fetch('/api/user/controls', { credentials: 'include' });
      if (res.ok) {
        const config = await res.json();
        userKeyConfig = config;
      }
    } catch (error) {
      console.error('Failed to load user controls:', error);
    }

    // Join room
    $socket.emit('room:join', { roomId });

    // Listen for room updates
    $socket.on('room:updated', (updatedRoom: Room) => {
      if (updatedRoom.id === roomId) {
        room = updatedRoom;
      }
    });

    $socket.on('game:started', async () => {
      // Set gameStarted first so video element renders
      gameStarted = true;

      // Prevent scrolling when game is active
      if (browser) {
        document.body.style.overflow = 'hidden';
      }

      // Wait for DOM to update
      await tick();

      if (isRoomHost) {
        // Initialize audio capture BEFORE loading emulator
        initializeAudioCapture();

        // Room host: Load ROM and run emulator
        await loadROM();
      } else {
        // Guest: Setup P2P to receive stream (no ROM needed)
        // Video element should now exist, so stream can be attached
        await setupP2PConnection();

        // Listen for guest keyboard input
        window.addEventListener('keydown', handleGuestKeyDown);
        window.addEventListener('keyup', handleGuestKeyUp);

        // Start polling for gamepad input
        startGamepadPolling();
      }
    });

    $socket.on('game:resumed', () => {
      if (isRoomHost && emulatorComponent) {
        emulatorComponent.resume();
      }
      showPauseMenu = false;
    });

    $socket.on('game:stopped', () => {
      gameStarted = false;
      showPauseMenu = false;

      // Stop gamepad polling
      stopGamepadPolling();

      // Stop video buffer monitor
      if (videoBufferMonitorInterval) {
        clearInterval(videoBufferMonitorInterval);
        videoBufferMonitorInterval = null;
      }

      // Cleanup P2P connection
      if (p2pManager) {
        p2pManager.destroy();
        p2pManager = null;
      }

      // Restore scrolling
      if (browser) {
        document.body.style.overflow = '';
      }
    });

    $socket.on('game:loaded', async (data: { saveId: string; saveData: string; slotNumber: number; name: string }) => {
      if (DEBUG()) console.log('📂 Received game:loaded event:', data);

      // Check if save data exists
      if (!data.saveData || data.saveData.length === 0) {
        console.warn('⚠️ No save data available for this save. It may have been created before save state capture was implemented.');
        showToast = true;
        toastMessage = 'Cette sauvegarde ne contient pas de données d\'état';
        toastType = 'error';
        setTimeout(() => {
          showToast = false;
        }, 3000);
        showPauseMenu = false;
        return;
      }

      // Only host loads the save state into emulator
      if (isRoomHost && emulatorComponent) {
        try {
          if (DEBUG()) console.log('📂 Loading save state into emulator:', data.name, 'Data length:', data.saveData.length);

          // Convert base64 string back to Uint8Array
          const saveDataBinary = Uint8Array.from(atob(data.saveData), c => c.charCodeAt(0));
          if (DEBUG()) console.log('📂 Binary data size:', saveDataBinary.length, 'bytes');

          // Convert to Blob (emulator expects a Blob)
          const saveDataBlob = new Blob([saveDataBinary], { type: 'application/octet-stream' });
          if (DEBUG()) console.log('📂 Blob size:', saveDataBlob.size, 'bytes');

          await emulatorComponent.loadState(saveDataBlob);
          if (DEBUG()) console.log('✅ Save state loaded successfully');

          // Close pause menu first
          showPauseMenu = false;

          // Resume the emulator and game state after a small delay
          setTimeout(() => {
            emulatorComponent.resume();
            $socket?.emit('game:resume', { roomId });
            if (DEBUG()) console.log('✅ Emulator resumed');
          }, 100);

          showToast = true;
          toastMessage = 'Sauvegarde chargée avec succès';
          toastType = 'success';
          setTimeout(() => {
            showToast = false;
          }, 3000);
        } catch (error) {
          console.error('❌ Failed to load save state:', error);
          showToast = true;
          toastMessage = 'Échec du chargement de la sauvegarde';
          toastType = 'error';
          setTimeout(() => {
            showToast = false;
          }, 3000);
          showPauseMenu = false;
        }
      } else {
        // Guest: just close the menu
        showPauseMenu = false;
      }
    });

    // Handle Escape key for pause menu
    if (browser) {
      window.addEventListener('keydown', handleKeyDown);
    }
  });

  onDestroy(() => {
    if ($socket) {
      $socket.emit('room:leave', { roomId });
      $socket.off('room:updated');
      $socket.off('game:started');
      $socket.off('game:resumed');
      $socket.off('game:stopped');
      $socket.off('game:loaded');
    }

    // Stop gamepad polling
    stopGamepadPolling();

    // Stop frame timestamp interval
    if (frameTimestampInterval) {
      clearInterval(frameTimestampInterval);
      frameTimestampInterval = null;
    }

    // Stop video buffer monitor
    if (videoBufferMonitorInterval) {
      clearInterval(videoBufferMonitorInterval);
      videoBufferMonitorInterval = null;
    }

    // Cleanup P2P connection
    if (p2pManager) {
      p2pManager.destroy();
      p2pManager = null;
    }

    if (browser) {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keydown', handleGuestKeyDown);
      window.removeEventListener('keyup', handleGuestKeyUp);
      // Restore scrolling when leaving the page
      document.body.style.overflow = '';
    }
  });

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape' && gameStarted) {
      if (!showPauseMenu) {
        // Pause the game
        if (isRoomHost && emulatorComponent) {
          emulatorComponent.pause();
        }
        $socket?.emit('game:pause', { roomId });
        showPauseMenu = true;
      } else {
        // Resume the game
        if (isRoomHost && emulatorComponent) {
          emulatorComponent.resume();
        }
        $socket?.emit('game:resume', { roomId });
      }
    }
  }

  async function startGame() {
    // Request fullscreen before starting the game to ensure user interaction is recent
    if (browser && !document.fullscreenElement) {
      try {
        await document.documentElement.requestFullscreen();
      } catch (err) {
        if (DEBUG()) console.log('Could not enter fullscreen:', err);
      }
    }
    $socket?.emit('game:start', { roomId });
  }

  function leaveRoom() {
    goto('/');
  }

  function toggleGuestFullscreen() {
    if (!guestContainerElement) return;

    if (!document.fullscreenElement) {
      // Enter fullscreen
      guestContainerElement.requestFullscreen().catch(err => {
        console.error('Error attempting to enable fullscreen:', err);
      });
    } else {
      // Exit fullscreen
      document.exitFullscreen();
    }
  }

  function handleControlsSaved(event: CustomEvent<{ config: KeyConfig }>) {
    // Update the room state locally so controls apply immediately
    if (room && currentPlayer) {
      currentPlayer.keyConfig = { ...event.detail.config };
      // Trigger reactivity by reassigning room
      room = { ...room };
    }
  }

  function handleNotification(event: CustomEvent<{ message: string; type: 'success' | 'error' }>) {
    toastMessage = event.detail.message;
    toastType = event.detail.type;
    showToast = true;
    setTimeout(() => {
      showToast = false;
    }, 3000);
  }
</script>

<div class="room-container">
  {#if !gameStarted}
    <div class="lobby">
      <h1>{room?.gameTitle || t($language, 'loading')}</h1>

      {#if room}
        <RoomPlayers {room} {roomId} />

        <div class="actions">
          <button on:click={startGame} class="btn-start" disabled={!canStartGame}>
            {t($language, 'startGame')}
          </button>
          <button on:click={leaveRoom} class="btn-leave">
            {t($language, 'leaveRoom')}
          </button>
        </div>
      {:else}
        <p class="loading">{t($language, 'joiningRoom')}</p>
      {/if}
    </div>
  {:else}
    <!-- Game canvas container -->
    <div class="game-canvas-container">
      {#if loading}
        <div class="loading-overlay">
          <p>Loading game...</p>
        </div>
      {:else if error}
        <div class="error-overlay">
          <p>❌ {error}</p>
        </div>
      {:else if isRoomHost && romData}
        <!-- Room host: Run emulator locally -->
        <ClientEmulator
          {romData}
          {keyConfig}
          {playerPort}
          isHost={true}
          on:ready={handleEmulatorReady}
          bind:this={emulatorComponent}
        />
      {:else if !isRoomHost}
        <!-- Guest: Receive video stream -->
        <div class="guest-stream" bind:this={guestContainerElement}>
          {#if connectionStatus === 'connecting'}
            <div class="connection-status">
              <p>🔄 Connecting to host...</p>
            </div>
          {:else if connectionStatus === 'disconnected'}
            <div class="connection-status error">
              <p>❌ Connection lost</p>
            </div>
          {/if}
          <video
            bind:this={guestVideoElement}
            autoplay
            playsinline
            muted={false}
            style="max-width: 100%; max-height: 100%; image-rendering: pixelated;"
          >
            <!-- Low latency video attributes -->
          </video>

          <!-- Latency indicator for guest -->
          {#if connectionStatus === 'connected' && !isRoomHost}
            <div class="latency-indicator">
              <div class="latency-label">Latence Guest</div>

              <!-- Input latency -->
              <div class="latency-row">
                <span class="latency-name">Input RTT:</span>
                <span class="latency-value">{inputLatency.toFixed(1)}ms</span>
              </div>

              <!-- Video latency breakdown -->
              {#if videoLatency > 0}
                <div class="latency-separator"></div>
                <div class="latency-section-label">Latence Vidéo</div>
                <div class="latency-row latency-sub">
                  <span class="latency-name">• Réseau:</span>
                  <span class="latency-value">{networkLatency.toFixed(1)}ms</span>
                </div>
                <div class="latency-row latency-sub">
                  <span class="latency-name">• Pipeline:</span>
                  <span class="latency-value">~{pipelineLatency}ms</span>
                </div>
                <div class="latency-row">
                  <span class="latency-name">Video Total:</span>
                  <span class="latency-value" style="font-weight: 600;">{videoLatency.toFixed(1)}ms</span>
                </div>

                <div class="latency-separator"></div>
                <div class="latency-row total-row">
                  <span class="latency-name">TOTAL:</span>
                  <span class="latency-value total-value">{totalLatency.toFixed(1)}ms</span>
                </div>
              {/if}

              <!-- Connection info -->
              <div class="latency-separator"></div>
              <div class="latency-row">
                <span class="latency-name">Type:</span>
                <span class="latency-value" class:p2p-direct={connectionType === 'host' || connectionType === 'srflx'} class:p2p-relay={connectionType === 'relay'}>
                  {#if connectionType === 'host'}
                    Direct P2P ✓
                  {:else if connectionType === 'srflx'}
                    P2P (STUN) ✓
                  {:else if connectionType === 'relay'}
                    Relayed ⚠
                  {:else}
                    {connectionType}
                  {/if}
                </span>
              </div>
            </div>
          {/if}
        </div>
      {/if}
    </div>

    {#if showPauseMenu}
      <PauseMenu
        {roomId}
        gameId={room?.gameId || ''}
        {keyConfig}
        emulator={isRoomHost ? emulatorComponent : null}
        on:resume={() => {
          if (isRoomHost && emulatorComponent) {
            emulatorComponent.resume();
          }
          $socket?.emit('game:resume', { roomId });
        }}
        on:quit={() => $socket?.emit('game:stop', { roomId })}
        on:saved={handleControlsSaved}
        on:notification={handleNotification}
      />
    {/if}
  {/if}

  {#if showToast}
    <div class="toast toast-{toastType}">
      <span class="toast-icon">{toastType === 'success' ? '✅' : '❌'}</span>
      <span>{toastMessage}</span>
    </div>
  {/if}
</div>

<style>
  .room-container {
    height: 100vh;
    width: 100vw;
    display: flex;
    justify-content: center;
    align-items: center;
    overflow: hidden;
  }

  .room-container:has(.lobby) {
    padding: 2rem;
  }

  .lobby {
    max-width: 800px;
    width: 100%;
    text-align: center;
  }

  h1 {
    font-size: 2.5rem;
    margin-bottom: 2rem;
  }

  .actions {
    display: flex;
    gap: 1rem;
    justify-content: center;
    margin-top: 2rem;
  }

  .btn-start {
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    color: white;
    border: none;
    padding: 1rem 2rem;
    font-size: 1.125rem;
    border-radius: 8px;
    cursor: pointer;
    transition: all 0.2s;
  }

  .btn-start:hover:not(:disabled) {
    transform: translateY(-2px);
    box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4);
  }

  .btn-start:disabled {
    background: #333;
    color: #666;
    cursor: not-allowed;
    opacity: 0.5;
  }

  .btn-leave {
    background: #333;
    color: white;
    border: none;
    padding: 1rem 2rem;
    font-size: 1.125rem;
    border-radius: 8px;
    cursor: pointer;
  }

  .loading {
    text-align: center;
    color: #888;
    font-size: 1.125rem;
    margin: 2rem 0;
  }

  .toast {
    position: fixed;
    bottom: 2rem;
    right: 2rem;
    background: rgba(42, 42, 42, 0.95);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 8px;
    padding: 1rem 1.5rem;
    display: flex;
    align-items: center;
    gap: 0.75rem;
    z-index: 2000;
    animation: slideIn 0.3s ease-out;
    backdrop-filter: blur(10px);
  }

  .toast-success {
    border-left: 4px solid #4caf50;
  }

  .toast-error {
    border-left: 4px solid #f44336;
  }

  .toast-icon {
    font-size: 1.25rem;
  }

  @keyframes slideIn {
    from {
      transform: translateX(100%);
      opacity: 0;
    }
    to {
      transform: translateX(0);
      opacity: 1;
    }
  }

  /* Game canvas container */
  .game-canvas-container {
    position: relative;
    width: 100%;
    height: 100vh;
    display: flex;
    justify-content: center;
    align-items: center;
    background: #000;
  }

  .loading-overlay, .error-overlay {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    text-align: center;
    font-size: 1.2rem;
    z-index: 10;
  }

  .error-overlay {
    color: #f44336;
  }

  .guest-stream {
    position: relative;
    width: 100%;
    height: 100%;
    display: flex;
    justify-content: center;
    align-items: center;
    background: #000;
  }

  /* Fullscreen mode for guest video */
  .guest-stream:fullscreen {
    background: #000;
  }

  .guest-stream:fullscreen video {
    width: 100vw;
    height: 100vh;
    max-width: 100vw;
    max-height: 100vh;
    object-fit: contain;
  }

  .guest-stream video {
    /* Fill available space while maintaining aspect ratio */
    width: 100%;
    height: 100%;

    /* Contain to maintain aspect ratio without cropping */
    object-fit: contain;

    /* SNES native aspect ratio (8:7 pixel aspect ratio) */
    aspect-ratio: 256 / 224;

    image-rendering: pixelated;
    image-rendering: crisp-edges;

    /* Prevent any layout shifts */
    display: block;
  }

  .connection-status {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    padding: 1rem 2rem;
    background: rgba(0, 0, 0, 0.85);
    border-radius: 8px;
    z-index: 5;
  }

  .connection-status.error {
    border: 2px solid #f44336;
  }

  .latency-indicator {
    position: absolute;
    bottom: 20px;
    left: 20px;
    background: rgba(0, 0, 0, 0.75);
    border: 1px solid #4a9eff;
    border-radius: 8px;
    padding: 10px 14px;
    font-size: 12px;
    color: #fff;
    font-family: 'Courier New', monospace;
    box-shadow: 0 2px 10px rgba(0, 0, 0, 0.5);
    min-width: 160px;
    z-index: 10;
  }

  .latency-label {
    font-weight: bold;
    text-align: center;
    margin-bottom: 6px;
    font-size: 11px;
    color: #4a9eff;
    text-transform: uppercase;
    letter-spacing: 1px;
  }

  .latency-row {
    display: flex;
    justify-content: space-between;
    margin: 3px 0;
    padding: 2px 0;
  }

  .latency-name {
    color: #aaa;
    font-size: 11px;
  }

  .latency-value {
    color: #4aff4a;
    font-weight: bold;
    font-size: 12px;
    text-shadow: 0 0 4px rgba(74, 255, 74, 0.5);
  }

  .latency-value.p2p-direct {
    color: #00ff00;
    text-shadow: 0 0 6px rgba(0, 255, 0, 0.7);
  }

  .latency-value.p2p-relay {
    color: #ffaa00;
    text-shadow: 0 0 6px rgba(255, 170, 0, 0.7);
  }

  .latency-separator {
    height: 1px;
    background: rgba(255, 255, 255, 0.2);
    margin: 4px 0;
  }

  .latency-section-label {
    font-size: 10px;
    color: #8ab4f8;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin: 4px 0 2px 0;
    font-weight: 600;
  }

  .latency-sub {
    margin-left: 8px;
  }

  .latency-sub .latency-name {
    font-size: 10px;
    color: #999;
  }

  .latency-sub .latency-value {
    font-size: 11px;
    color: #7dd87d;
    font-weight: normal;
  }

  .total-row {
    margin-top: 4px;
    padding-top: 4px;
    border-top: 1px solid rgba(74, 158, 255, 0.3);
  }

  .total-row .latency-name {
    font-weight: 700;
    color: #fff;
    font-size: 12px;
  }

  .total-value {
    font-size: 14px !important;
    color: #ffeb3b !important;
    text-shadow: 0 0 8px rgba(255, 235, 59, 0.8) !important;
  }
</style>
