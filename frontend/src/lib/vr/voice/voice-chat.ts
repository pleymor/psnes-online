/**
 * La voix entre amis en VR : un micro, une connexion par ami, une oreille dans la scène.
 *
 * CE QUI PASSE PAR LE SERVEUR : la signalisation, et elle seule. L'offre, la
 * réponse et les candidats ICE de chaque négociation vont par `vr:voice:signal`
 * sur le socket déjà ouvert, et `backend/src/websocket/vr-voice.ts` ne les
 * relaie qu'entre deux amis du même espace. L'audio, lui, part en WebRTC d'un
 * casque à l'autre. Rien n'est enregistré, nulle part.
 *
 * UNE CONNEXION À PART, JAMAIS CELLE DU LOCKSTEP. `ZnetWebRtcTransport` porte
 * les manettes d'une partie et son en-tête dit pourquoi il ne veut rien d'autre
 * sur son fil. La voix a ses propres `RTCPeerConnection`, sa propre
 * signalisation et son propre `AudioContext` : elle ne peut ni retarder un
 * paquet de manette ni partager la file du son du jeu.
 *
 * RIEN DANS LA BOUCLE DE RENDU SAUF LES POSITIONS. `spatialize()` est la seule
 * méthode appelée à chaque image, et elle n'écrit que des `AudioParam`. Lire
 * les niveaux, décider qui parle et baisser le jeu se fait sur un minuteur à
 * dix hertz, hors de l'image.
 *
 * LE MICRO N'EST DEMANDÉ QUE QUAND QUELQU'UN EST LÀ. Entrer en VR seul ne le
 * touche pas ; le premier ami qui arrive le demande ; le dernier qui s'en va
 * le rend - l'indicateur du casque s'éteint avec lui.
 */
import '$lib/polyfills';
import SimplePeer from 'simple-peer';
import type { SignalSocket } from '$lib/znet/webrtc-transport';
import type { Pose, PeerPose } from '../lobby/roster';
import {
  DISTANCE,
  SILENT,
  gameGainFor,
  listenerFrame,
  micShown,
  rmsLevel,
  sourcePosition,
  speakingStep,
  type ListenerFrame,
  type MicState,
  type SpeakingState
} from './spatial';

/**
 * Les serveurs STUN que le lockstep utilise déjà (`znet/webrtc-transport.ts`).
 *
 * AUCUN TURN, et ce n'est pas un oubli de ce module : le dépôt n'en configure
 * aucun. Derrière certains NAT symétriques ou pare-feu d'entreprise, deux
 * casques ne trouveront pas de chemin direct, et la voix ne s'établira pas -
 * là où le lockstep, lui, se replie sur le relais socket. Un TURN est une
 * décision d'infrastructure (un serveur, de la bande passante, des
 * identifiants) qui appartient à l'exploitant.
 */
export const VOICE_ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' }
];

/** Ce que le navigateur doit faire au micro : une voix, pas une musique. */
export const MIC_CONSTRAINTS: MediaStreamConstraints = {
  audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  video: false
};

/** Dix lectures de niveau par seconde : assez pour un anneau, rien pour le CPU. */
const LEVEL_POLL_MS = 100;

/** Combien de fois on reconstruit une négociation morte avant d'attendre un nouvel évènement. */
const MAX_ATTEMPTS = 3;
const RETRY_MS = 2000;

export interface VoicePeerState {
  id: string;
  connected: boolean;
  speaking: boolean;
  /** Coupé par moi, chez moi seulement. */
  muted: boolean;
}

export interface VoiceState {
  /** Où j'en suis : `null` hors voix. */
  space: string | null;
  mic: MicState;
  /** Je parle, d'après mon propre micro - pour savoir qu'il marche. */
  selfSpeaking: boolean;
  peers: VoicePeerState[];
}

export interface VoiceChatOptions {
  socket: SignalSocket;
  /** À chaque changement visible : micro, pairs, qui parle. Au plus dix fois par seconde. */
  onChange?: (state: VoiceState) => void;
  /** Le gain à appliquer au jeu - baissé quand un ami parle. */
  onGameGain?: (gain: number) => void;
  /** Injectable pour les tests ; par défaut `navigator.mediaDevices.getUserMedia`. */
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  /** Pour la page, qui sait se cacher. Par défaut `document`. */
  doc?: Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'>;
  log?: (message: string, detail?: unknown) => void;
}

interface Remote {
  id: string;
  initiator: boolean;
  peer: SimplePeer.Instance | null;
  attempts: number;
  retry: ReturnType<typeof setTimeout> | null;
  connected: boolean;
  /** Les signaux arrivés avant que la connexion n'existe. */
  pending: SimplePeer.SignalData[];
  element: HTMLAudioElement | null;
  source: MediaStreamAudioSourceNode | null;
  analyser: AnalyserNode | null;
  gain: GainNode | null;
  panner: PannerNode | null;
  speaking: SpeakingState;
  muted: boolean;
  /** Le flux qu'on a déjà branché, pour ne pas le rebrancher à une renégociation. */
  stream: MediaStream | null;
}

/** `false` : hors voix. `null` : le lobby. Une chaîne : ce salon de groupe. */
export type VoiceSpace = false | null | string;

function spaceKey(space: VoiceSpace): string | null {
  if (space === false) return null;
  return space === null ? 'lobby' : `room:${space}`;
}

export class VoiceChat {
  private wanted: VoiceSpace = false;
  private joined = false;
  private remotes = new Map<string, Remote>();
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private mic: MediaStream | null = null;
  private micState: MicState = 'idle';
  private micRequest: Promise<MediaStream | null> | null = null;
  private micAnalyser: AnalyserNode | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private selfSpeaking: SpeakingState = SILENT;
  private mutedByMe = false;
  private poll: ReturnType<typeof setInterval> | null = null;
  private samples: Float32Array<ArrayBuffer> = new Float32Array(1024);
  private lastShown = '';
  private lastGameGain = 1;
  private disposed = false;
  private readonly doc: VoiceChatOptions['doc'] | null;

  private readonly onPeers = (event: { peers?: { id: string; initiator: boolean }[] }) => {
    if (!this.joined || this.disposed) return;
    void this.reconcile(Array.isArray(event?.peers) ? event.peers : []);
  };

  private readonly onSignal = (event: { from?: string; signal?: SimplePeer.SignalData }) => {
    if (!this.joined || this.disposed || !event?.from || !event.signal) return;
    const remote = this.remotes.get(event.from);
    if (!remote) return;
    if (!remote.peer) {
      remote.pending.push(event.signal);
      return;
    }
    try {
      remote.peer.signal(event.signal);
    } catch (err) {
      this.log('rejected a voice signal for a negotiation that had moved on', err);
    }
  };

  /** Le socket revient seul, pas l'appartenance : le serveur nous a retirés à la coupure. */
  private readonly onConnect = () => {
    if (this.wanted === false || this.disposed) return;
    this.dropAllPeers();
    this.emitJoin();
  };

  private readonly onDisconnect = () => {
    this.dropAllPeers();
    this.releaseMicIfAlone();
    this.changed();
  };

  /**
   * La page cachée : on raccroche et on rend le micro, puis on revient au retour.
   *
   * Sur un Quest, retirer le casque ou ouvrir le menu système peut cacher la
   * page ; un micro resté ouvert derrière serait exactement l'indicateur qui
   * reste allumé que cette fonctionnalité ne doit pas laisser.
   */
  private readonly onVisibility = () => {
    if (this.disposed || !this.doc) return;
    if (this.doc.visibilityState === 'hidden') {
      if (this.joined) this.hangUp();
      return;
    }
    if (this.wanted !== false && !this.joined) this.emitJoin();
  };

  constructor(private readonly opts: VoiceChatOptions) {
    this.doc = opts.doc ?? (typeof document === 'undefined' ? null : document);
    opts.socket.on('vr:voice:peers', this.onPeers as never);
    opts.socket.on('vr:voice:signal', this.onSignal as never);
    opts.socket.on('connect', this.onConnect as never);
    opts.socket.on('disconnect', this.onDisconnect as never);
    this.doc?.addEventListener('visibilitychange', this.onVisibility);
  }

  /** Entrer dans un espace, en changer, ou sortir (`false`). Idempotent. */
  setSpace(space: VoiceSpace): void {
    if (this.disposed) return;
    if (spaceKey(space) === spaceKey(this.wanted)) return;
    const wasJoined = this.joined;
    this.wanted = space;
    if (wasJoined) this.hangUp();
    if (space !== false) this.emitJoin();
    this.changed();
  }

  get muted(): boolean {
    return this.mutedByMe;
  }

  /** Quelqu'un est-il à l'autre bout : ce qui décide si l'image a des voix à placer. */
  get talking(): boolean {
    return this.remotes.size > 0;
  }

  /**
   * Couper ou rouvrir MON micro.
   *
   * `track.enabled = false` : la piste continue d'exister et envoie du
   * silence, donc rien à renégocier au retour, et le niveau reçu chez l'autre
   * tombe à zéro tout de suite. Le micro reste acquis tant qu'un ami est là :
   * le rouvrir ne redemande rien.
   */
  setMuted(muted: boolean): void {
    this.mutedByMe = muted;
    for (const track of this.mic?.getAudioTracks() ?? []) track.enabled = !muted;
    if (muted) this.selfSpeaking = SILENT;
    this.changed();
  }

  toggleMuted(): void {
    this.setMuted(!this.mutedByMe);
  }

  /** Couper un ami chez moi, sans rien lui dire. */
  setPeerMuted(id: string, muted: boolean): void {
    const remote = this.remotes.get(id);
    if (!remote) return;
    remote.muted = muted;
    if (remote.gain) remote.gain.gain.value = muted ? 0 : 1;
    this.changed();
  }

  /**
   * Redemander le micro après un refus. À appeler depuis un geste du joueur.
   *
   * Si le navigateur a mémorisé le refus, il le redira sans rien montrer ;
   * c'est pourquoi le lutrin dit aussi où l'autoriser.
   */
  retryMic(): void {
    if (this.micState !== 'denied' || this.remotes.size === 0) return;
    this.micState = 'idle';
    this.micRequest = null;
    void this.acquireMic().then((stream) => {
      if (!stream) return;
      for (const remote of this.remotes.values()) {
        try {
          remote.peer?.addStream(stream);
        } catch (err) {
          this.log('could not add the microphone to a voice connection', err);
        }
      }
    });
  }

  /**
   * Une image : l'auditeur sur ma tête, chaque voix sur celle de son ami.
   *
   * La seule méthode de ce module appelée dans la boucle de rendu, et elle ne
   * fait qu'écrire des positions. `mine` est `null` tant que je n'ai pas de
   * pose ; un ami absent de `theirs` - pendant une partie, il n'y a plus de
   * lobby - est posé devant moi, non spatial (`FALLBACK_DISTANCE`).
   */
  spatialize(mine: Pose | null, theirs: ReadonlyMap<string, PeerPose>): void {
    const context = this.context;
    if (!context || this.remotes.size === 0) return;
    const frame = mine ? listenerFrame(mine) : null;
    if (frame) placeListener(context.listener, frame);
    for (const remote of this.remotes.values()) {
      if (!remote.panner) continue;
      const at = sourcePosition(theirs.get(remote.id)?.head ?? null, frame);
      placeSource(remote.panner, at);
    }
  }

  /** L'état tel qu'on le montre. */
  state(): VoiceState {
    return {
      space: this.joined ? spaceKey(this.wanted) : null,
      mic: micShown(this.micState, this.mutedByMe),
      selfSpeaking: this.selfSpeaking.speaking,
      peers: [...this.remotes.values()].map((remote) => ({
        id: remote.id,
        connected: remote.connected,
        speaking: remote.speaking.speaking,
        muted: remote.muted
      }))
    };
  }

  /**
   * Les niveaux bruts, pour les tests de bout en bout seulement.
   *
   * `sending` dit si ma piste part vraiment : c'est ce que « couper » change.
   * `tracks` est l'état de chaque piste du micro, pour prouver qu'elles sont
   * arrêtées après la sortie.
   */
  probe(): { self: number; peers: Record<string, number>; micTracks: string[] } {
    const peers: Record<string, number> = {};
    for (const remote of this.remotes.values()) peers[remote.id] = this.levelOf(remote.analyser);
    return {
      self: this.levelOf(this.micAnalyser),
      peers,
      micTracks: (this.mic?.getAudioTracks() ?? []).map((track) => track.readyState)
    };
  }

  /** Tout rendre : connexions, micro, contexte audio, écouteurs. */
  dispose(): void {
    if (this.disposed) return;
    this.setSpace(false);
    this.disposed = true;
    this.hangUp();
    this.opts.socket.off('vr:voice:peers', this.onPeers as never);
    this.opts.socket.off('vr:voice:signal', this.onSignal as never);
    this.opts.socket.off('connect', this.onConnect as never);
    this.opts.socket.off('disconnect', this.onDisconnect as never);
    this.doc?.removeEventListener('visibilitychange', this.onVisibility);
  }

  private emitJoin(): void {
    if (this.wanted === false) return;
    if (this.doc?.visibilityState === 'hidden') return;
    this.joined = true;
    this.opts.socket.emit('vr:voice:join', { roomId: this.wanted });
    this.startPolling();
  }

  /** Raccrocher : dire au serveur qu'on part, fermer chaque connexion, rendre le micro. */
  private hangUp(): void {
    if (this.joined) this.opts.socket.emit('vr:voice:leave');
    this.joined = false;
    this.dropAllPeers();
    this.releaseMic();
    this.stopPolling();
    if (this.lastGameGain !== 1) {
      this.lastGameGain = 1;
      this.opts.onGameGain?.(1);
    }
    const context = this.context;
    this.context = null;
    this.master = null;
    void context?.close().catch(() => undefined);
    this.changed();
  }

  private async reconcile(peers: readonly { id: string; initiator: boolean }[]): Promise<void> {
    const wanted = new Map(peers.map((peer) => [peer.id, peer.initiator]));

    for (const [id, remote] of this.remotes) {
      if (wanted.has(id)) continue;
      this.dropPeer(remote);
      this.remotes.delete(id);
    }

    const arrivals: Remote[] = [];
    for (const [id, initiator] of wanted) {
      if (this.remotes.has(id)) continue;
      const remote: Remote = {
        id, initiator, peer: null, attempts: 0, retry: null, connected: false,
        pending: [], element: null, source: null, analyser: null, gain: null,
        panner: null, speaking: SILENT, muted: false, stream: null
      };
      this.remotes.set(id, remote);
      arrivals.push(remote);
    }

    this.releaseMicIfAlone();
    this.changed();
    if (arrivals.length === 0) return;

    this.ensureContext();
    // Le micro AVANT la première offre : une offre sans piste obligerait à
    // renégocier une demi-seconde plus tard, pour chaque ami.
    const stream = await this.acquireMic();
    for (const remote of arrivals) {
      // Parti pendant qu'on attendait la permission.
      if (this.remotes.get(remote.id) !== remote || !this.joined) continue;
      this.connect(remote, stream);
    }
  }

  private connect(remote: Remote, stream: MediaStream | null): void {
    if (remote.retry) clearTimeout(remote.retry);
    remote.retry = null;
    remote.attempts += 1;

    const peer = new SimplePeer({
      initiator: remote.initiator,
      trickle: true,
      stream: stream ?? undefined,
      // Sans micro on veut quand même ENTENDRE : l'offre doit réclamer l'audio.
      offerOptions: { offerToReceiveAudio: true, offerToReceiveVideo: false },
      config: { iceServers: VOICE_ICE_SERVERS }
    });
    remote.peer = peer;

    peer.on('signal', (signal) => {
      if (remote.peer !== peer || !this.joined) return;
      this.opts.socket.emit('vr:voice:signal', { to: remote.id, signal });
    });
    peer.on('connect', () => {
      if (remote.peer !== peer) return;
      remote.connected = true;
      remote.attempts = 0;
      this.changed();
    });
    peer.on('stream', (incoming: MediaStream) => {
      if (remote.peer !== peer) return;
      this.attachStream(remote, incoming);
    });
    const lost = (err?: unknown) => {
      if (remote.peer !== peer) return;
      if (err) this.log('voice connection failed', err);
      remote.connected = false;
      remote.peer = null;
      try {
        peer.destroy();
      } catch {
        // Détruire une connexion jamais établie jette dans certains navigateurs.
      }
      this.changed();
      // Encore voulu : on retente, un peu plus tard, un nombre borné de fois.
      if (this.remotes.get(remote.id) !== remote || !this.joined) return;
      if (remote.attempts >= MAX_ATTEMPTS) return;
      remote.retry = setTimeout(() => {
        if (this.remotes.get(remote.id) !== remote || !this.joined) return;
        this.connect(remote, this.mic);
      }, RETRY_MS);
    };
    peer.on('close', () => lost());
    peer.on('error', (err) => lost(err));

    for (const signal of remote.pending.splice(0)) {
      try {
        peer.signal(signal);
      } catch (err) {
        this.log('rejected a queued voice signal', err);
      }
    }
  }

  /**
   * La voix d'un ami dans le graphe : source, analyseur, gain, panoramique HRTF.
   *
   * L'ÉLÉMENT `<audio>` MUET N'EST PAS DÉCORATIF. Chromium ne fait pas couler
   * un flux WebRTC distant dans `createMediaStreamSource` tant que ce flux
   * n'est lu par aucun élément média : sans lui, le graphe reçoit du silence.
   * Il est muet, donc on n'entend que le chemin spatialisé.
   */
  private attachStream(remote: Remote, stream: MediaStream): void {
    if (remote.stream === stream) return;
    this.detachStream(remote);
    const context = this.ensureContext();
    remote.stream = stream;

    const element = new Audio();
    element.muted = true;
    element.srcObject = stream;
    void element.play().catch(() => undefined);
    remote.element = element;

    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    const gain = context.createGain();
    gain.gain.value = remote.muted ? 0 : 1;
    const panner = context.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = DISTANCE.model;
    panner.refDistance = DISTANCE.refDistance;
    panner.rolloffFactor = DISTANCE.rolloffFactor;
    panner.maxDistance = DISTANCE.maxDistance;
    // Posé devant tant que la première image n'a pas dit mieux.
    placeSource(panner, sourcePosition(null, null));

    // L'analyseur AVANT le gain : l'anneau dit qu'il parle même si je l'ai coupé.
    source.connect(analyser);
    source.connect(gain);
    gain.connect(panner);
    panner.connect(this.master!);

    remote.source = source;
    remote.analyser = analyser;
    remote.gain = gain;
    remote.panner = panner;
    void context.resume().catch(() => undefined);
  }

  private detachStream(remote: Remote): void {
    remote.source?.disconnect();
    remote.gain?.disconnect();
    remote.panner?.disconnect();
    remote.analyser?.disconnect();
    if (remote.element) {
      remote.element.pause();
      remote.element.srcObject = null;
    }
    remote.source = null;
    remote.analyser = null;
    remote.gain = null;
    remote.panner = null;
    remote.element = null;
    remote.stream = null;
  }

  private dropPeer(remote: Remote): void {
    if (remote.retry) clearTimeout(remote.retry);
    remote.retry = null;
    const peer = remote.peer;
    remote.peer = null;
    remote.connected = false;
    try {
      peer?.destroy();
    } catch {
      // Voir `lost` : certains navigateurs jettent sur une connexion jamais ouverte.
    }
    this.detachStream(remote);
  }

  private dropAllPeers(): void {
    for (const remote of this.remotes.values()) this.dropPeer(remote);
    this.remotes.clear();
  }

  private ensureContext(): AudioContext {
    if (this.context) return this.context;
    const context = new AudioContext({ latencyHint: 'interactive' });
    const master = context.createGain();
    master.connect(context.destination);
    this.context = context;
    this.master = master;
    void context.resume().catch(() => undefined);
    return context;
  }

  private acquireMic(): Promise<MediaStream | null> {
    if (this.micRequest) return this.micRequest;
    if (this.micState === 'denied') return Promise.resolve(null);
    const getUserMedia = this.opts.getUserMedia
      ?? ((constraints: MediaStreamConstraints) => navigator.mediaDevices.getUserMedia(constraints));
    this.micState = 'asking';
    this.changed();
    const request: Promise<MediaStream | null> = getUserMedia(MIC_CONSTRAINTS).then(
      (stream) => {
        // Rendu entre-temps : la sortie a eu lieu pendant la question, ou une
        // autre demande l'a remplacée. Ce flux-là n'appartient plus à personne,
        // et un flux orphelin est un indicateur de micro qui reste allumé.
        if (this.micRequest !== request || !this.joined || this.remotes.size === 0 || this.disposed) {
          for (const track of stream.getTracks()) track.stop();
          if (this.micRequest === request) {
            this.micRequest = null;
            this.micState = 'idle';
            this.changed();
          }
          return null;
        }
        this.mic = stream;
        this.micState = 'live';
        for (const track of stream.getAudioTracks()) track.enabled = !this.mutedByMe;
        const context = this.ensureContext();
        // Vers un analyseur SEULEMENT, jamais vers les haut-parleurs : on ne
        // s'entend pas soi-même, on se voit parler.
        this.micSource = context.createMediaStreamSource(stream);
        this.micAnalyser = context.createAnalyser();
        this.micAnalyser.fftSize = 1024;
        this.micSource.connect(this.micAnalyser);
        this.changed();
        return stream;
      },
      (err) => {
        if (this.micRequest !== request) return null;
        this.log('microphone refused or unavailable; listening only', err);
        this.micState = 'denied';
        this.micRequest = null;
        this.changed();
        return null;
      }
    );
    this.micRequest = request;
    return request;
  }

  /** Personne à qui parler : on rend le micro, l'indicateur du casque s'éteint. */
  private releaseMicIfAlone(): void {
    if (this.remotes.size === 0) this.releaseMic();
  }

  private releaseMic(): void {
    for (const track of this.mic?.getTracks() ?? []) track.stop();
    this.micSource?.disconnect();
    this.micAnalyser?.disconnect();
    this.mic = null;
    this.micSource = null;
    this.micAnalyser = null;
    this.micRequest = null;
    this.selfSpeaking = SILENT;
    // Un refus reste un refus jusqu'au prochain essai explicite : redemander à
    // chaque arrivée d'ami ferait surgir la question au milieu d'une partie.
    if (this.micState !== 'denied') this.micState = 'idle';
  }

  private levelOf(analyser: AnalyserNode | null): number {
    if (!analyser) return 0;
    if (this.samples.length !== analyser.fftSize) this.samples = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(this.samples);
    return rmsLevel(this.samples);
  }

  private startPolling(): void {
    if (this.poll) return;
    this.poll = setInterval(() => this.sample(), LEVEL_POLL_MS);
  }

  private stopPolling(): void {
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
  }

  /** Hors de l'image : qui parle, et de combien baisser le jeu. */
  private sample(): void {
    const now = performance.now();
    this.selfSpeaking = this.mutedByMe || !this.mic
      ? SILENT
      : speakingStep(this.selfSpeaking, this.levelOf(this.micAnalyser), now);
    let someone = false;
    for (const remote of this.remotes.values()) {
      remote.speaking = speakingStep(remote.speaking, this.levelOf(remote.analyser), now);
      if (remote.speaking.speaking && !remote.muted) someone = true;
    }
    const gain = gameGainFor(someone);
    if (gain !== this.lastGameGain) {
      this.lastGameGain = gain;
      this.opts.onGameGain?.(gain);
    }
    this.changed();
  }

  /** Ne prévient que si quelque chose de VISIBLE a changé. */
  private changed(): void {
    const state = this.state();
    const shown = JSON.stringify(state);
    if (shown === this.lastShown) return;
    this.lastShown = shown;
    this.opts.onChange?.(state);
  }

  private log(message: string, detail?: unknown): void {
    this.opts.log?.(message, detail);
  }
}

/** `positionX.value` là où il existe, `setPosition` ailleurs - Firefox n'a longtemps eu que l'un. */
function placeListener(listener: AudioListener, frame: ListenerFrame): void {
  const [x, y, z] = frame.position;
  const [fx, fy, fz] = frame.forward;
  const [ux, uy, uz] = frame.up;
  if (listener.positionX) {
    listener.positionX.value = x;
    listener.positionY.value = y;
    listener.positionZ.value = z;
    listener.forwardX.value = fx;
    listener.forwardY.value = fy;
    listener.forwardZ.value = fz;
    listener.upX.value = ux;
    listener.upY.value = uy;
    listener.upZ.value = uz;
  } else {
    listener.setPosition(x, y, z);
    listener.setOrientation(fx, fy, fz, ux, uy, uz);
  }
}

function placeSource(panner: PannerNode, [x, y, z]: readonly number[]): void {
  if (panner.positionX) {
    panner.positionX.value = x;
    panner.positionY.value = y;
    panner.positionZ.value = z;
  } else {
    panner.setPosition(x, y, z);
  }
}
