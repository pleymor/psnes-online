/**
 * La page du banc d'essai de la voix VR : le vrai `VoiceChat`, sans casque.
 *
 * Aucun navigateur sans casque ne peut ouvrir une session immersive, donc le
 * test descend d'un étage : il pilote le module de voix tel que `VrShell` le
 * pilote - un espace, un micro, des pairs - sur un vrai socket.io et le vrai
 * relais `vr-voice.ts`. Ce que ce banc ne voit pas, la scène et le casque, est
 * écrit dans la liste de vérification de la pull request.
 */
import { io } from 'socket.io-client';
import { VoiceChat, type VoiceState } from '../../frontend/src/lib/vr/voice/voice-chat';

const params = new URLSearchParams(location.search);
const userId = params.get('user') ?? 'anonyme';

const socket = io({ auth: { userId }, transports: ['websocket'] });
/** Chaque flux que le micro a rendu, pour prouver qu'il est arrêté après la sortie. */
const captured: MediaStream[] = [];
let last: VoiceState | null = null;
const gains: number[] = [];

const voice = new VoiceChat({
  socket: socket as never,
  getUserMedia: async (constraints) => {
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    captured.push(stream);
    return stream;
  },
  onChange: (state) => { last = state; },
  onGameGain: (gain) => { gains.push(gain); },
  log: (message, detail) => console.log('[voice]', message, detail ?? '')
});

Object.assign(window, {
  harness: {
    connected: () => socket.connected,
    join: (roomId: string | null) => voice.setSpace(roomId),
    leave: () => voice.setSpace(false),
    mute: (on: boolean) => voice.setMuted(on),
    muteFriend: (id: string, on: boolean) => voice.setPeerMuted(id, on),
    state: () => last ?? voice.state(),
    probe: () => voice.probe(),
    micTracks: () => captured.flatMap((s) => s.getTracks().map((t) => t.readyState)),
    gains: () => gains.slice(),
    dispose: () => voice.dispose()
  }
});
