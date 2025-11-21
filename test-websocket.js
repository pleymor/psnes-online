#!/usr/bin/env node

/**
 * Simple low-level WebSocket test
 * Tests the Socket.IO signaling flow without browser complexity
 */

const { io } = require('socket.io-client');

const BACKEND_URL = 'http://localhost:3000';

// Get session cookies from Redis
const HOST_SESSION = 'aTULDy-OJoKuZvOT5nZD74yJyDtnhkpr';
const GUEST_SESSION = 'uqFSrDi3BIvItIsazuNOCA4H8qAiN6AU';

let testRoomId = null;
let signalsExchanged = 0;

console.log('🧪 Testing WebSocket P2P Signaling Flow\n');

// Test 1: Connect HOST
console.log('Step 1: Connecting HOST...');
const hostSocket = io(BACKEND_URL, {
  extraHeaders: {
    cookie: `connect.sid=s%3A${HOST_SESSION}.dummy`
  },
  transports: ['websocket'],
  reconnection: false
});

hostSocket.on('connect', () => {
  console.log('✅ Host connected:', hostSocket.id);

  // Create room with autoStart
  console.log('📝 Creating room with autoStart=true...');
  hostSocket.emit('room:create', {
    gameId: 'test-game-id',
    gameTitle: 'Test Game',
    autoStart: true
  });
});

hostSocket.on('room:created', (room) => {
  console.log('✅ Room created:', room.id);
  console.log('   Status:', room.status);
  console.log('   Players:', room.players.length);
  testRoomId = room.id;
});

hostSocket.on('game:started', () => {
  console.log('✅ Host received game:started event');

  // Join P2P room
  console.log('📡 Host joining P2P room...');
  hostSocket.emit('p2p:join', { roomId: testRoomId });
});

hostSocket.on('p2p:joined', () => {
  console.log('✅ Host joined P2P room');

  // Simulate sending WebRTC offer
  console.log('📡 Host sending mock WebRTC offer...');
  hostSocket.emit('webrtc:signal', {
    roomId: testRoomId,
    signal: {
      type: 'offer',
      sdp: 'mock-sdp-offer-data'
    }
  });
  signalsExchanged++;

  // Wait a bit, then connect guest
  setTimeout(() => {
    console.log('\n─────────────────────────────────────\n');
    connectGuest();
  }, 2000);
});

hostSocket.on('webrtc:signal', (data) => {
  console.log('📡 Host received WebRTC signal:', data.signal.type || 'candidate');
  signalsExchanged++;

  if (data.signal.type === 'answer') {
    console.log('✅ Host received answer from guest - signaling working!');

    // Send ICE candidates
    console.log('📡 Host sending mock ICE candidates...');
    hostSocket.emit('webrtc:signal', {
      roomId: testRoomId,
      signal: {
        candidate: 'mock-ice-candidate-1'
      }
    });
    signalsExchanged++;
  }
});

hostSocket.on('room:updated', (room) => {
  console.log('📢 Host received room:updated - Players:', room.players.length);
});

hostSocket.on('error', (err) => {
  console.error('❌ Host error:', err);
});

hostSocket.on('connect_error', (err) => {
  console.error('❌ Host connection error:', err.message);
  process.exit(1);
});

function connectGuest() {
  console.log('Step 2: Connecting GUEST...');

  const guestSocket = io(BACKEND_URL, {
    extraHeaders: {
      cookie: `connect.sid=s%3A${GUEST_SESSION}.dummy`
    },
    transports: ['websocket'],
    reconnection: false
  });

  guestSocket.on('connect', () => {
    console.log('✅ Guest connected:', guestSocket.id);

    // Join the room
    console.log('📝 Guest joining room:', testRoomId);
    guestSocket.emit('room:join', { roomId: testRoomId });
  });

  guestSocket.on('room:updated', (room) => {
    console.log('✅ Guest received room:updated');
    console.log('   Players:', room.players.length);
    console.log('   Status:', room.status);
  });

  guestSocket.on('game:started', () => {
    console.log('✅ Guest received game:started event');

    // Join P2P room
    console.log('📡 Guest joining P2P room...');
    guestSocket.emit('p2p:join', { roomId: testRoomId });
  });

  guestSocket.on('p2p:joined', () => {
    console.log('✅ Guest joined P2P room');
  });

  guestSocket.on('webrtc:signal', (data) => {
    console.log('📡 Guest received WebRTC signal:', data.signal.type || 'candidate');
    signalsExchanged++;

    if (data.signal.type === 'offer') {
      console.log('✅ Guest received offer from host');

      // Send answer
      console.log('📡 Guest sending mock WebRTC answer...');
      guestSocket.emit('webrtc:signal', {
        roomId: testRoomId,
        signal: {
          type: 'answer',
          sdp: 'mock-sdp-answer-data'
        }
      });
      signalsExchanged++;

      // Test complete after a delay
      setTimeout(() => {
        console.log('\n─────────────────────────────────────\n');
        console.log('📊 Test Results:');
        console.log('   Signals exchanged:', signalsExchanged);

        if (signalsExchanged >= 4) {
          console.log('\n✅✅✅ TEST PASSED');
          console.log('WebSocket signaling is working correctly!');
          console.log('- Host and guest can connect');
          console.log('- Room creation and joining works');
          console.log('- P2P room joining works');
          console.log('- WebRTC signals are relayed properly');
          process.exit(0);
        } else {
          console.log('\n⚠️ TEST PARTIAL - Some signals missing');
          console.log('Expected at least 4 signals (offer, answer, candidates)');
          process.exit(1);
        }
      }, 2000);
    }
  });

  guestSocket.on('error', (err) => {
    console.error('❌ Guest error:', err);
  });

  guestSocket.on('connect_error', (err) => {
    console.error('❌ Guest connection error:', err.message);
    console.log('\n❌ TEST FAILED - Could not connect guest');
    process.exit(1);
  });
}

// Timeout
setTimeout(() => {
  console.log('\n❌ TEST TIMEOUT after 20 seconds');
  console.log('Signals exchanged:', signalsExchanged);
  process.exit(1);
}, 20000);
