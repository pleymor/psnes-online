/**
 * Où placer une voix, à quel point quelqu'un parle, et de combien baisser le jeu.
 *
 * TOUTE L'ARITHMÉTIQUE DE LA VOIX, ET RIEN QUI TOUCHE UN NAVIGATEUR. Sous Bun
 * il n'y a ni `AudioContext` ni micro, et c'est précisément ce qui peut se
 * tromper sans bruit - un signe de repère, un seuil - qu'on veut pouvoir tenir
 * par un test. `voice-chat.ts` branche les nœuds ; ici on calcule.
 *
 * UN SEUL REPÈRE, CELUI DU DÉCOR. Les têtes des amis arrivent dans le repère de
 * `room` (`roster.ts`), et `scene.poseInRoom()` rend la mienne dans ce même
 * repère. L'auditeur et les sources y sont donc posés tels quels : aucune
 * conversion, donc aucune erreur de signe possible - la règle que
 * `scene.ts` s'impose déjà pour les poses sur le fil.
 */
import type { Pose } from '../lobby/roster';

export type Vec3 = [number, number, number];

/** Tourne `v` par le quaternion d'une pose (`[.., qx, qy, qz, qw]`). */
export function rotate(pose: Pose, v: Vec3): Vec3 {
  const qx = pose[3];
  const qy = pose[4];
  const qz = pose[5];
  const qw = pose[6];
  // t = 2 · (q × v) ; v' = v + w·t + q × t. La forme courte de q·v·q⁻¹.
  const tx = 2 * (qy * v[2] - qz * v[1]);
  const ty = 2 * (qz * v[0] - qx * v[2]);
  const tz = 2 * (qx * v[1] - qy * v[0]);
  return [
    v[0] + qw * tx + (qy * tz - qz * ty),
    v[1] + qw * ty + (qz * tx - qx * tz),
    v[2] + qw * tz + (qx * ty - qy * tx)
  ];
}

export interface ListenerFrame {
  position: Vec3;
  /** Où regarde le nez. -Z dans la convention de three et de WebXR. */
  forward: Vec3;
  up: Vec3;
}

/** L'auditeur Web Audio d'une tête : sa position, son avant et son haut. */
export function listenerFrame(head: Pose): ListenerFrame {
  return {
    position: [head[0], head[1], head[2]],
    forward: rotate(head, [0, 0, -1]),
    up: rotate(head, [0, 1, 0])
  };
}

/**
 * À quelle distance devant soi une voix sans position se fait entendre.
 *
 * Le repli NON SPATIAL. Pendant une partie le lobby est quitté et les poses ne
 * voyagent plus (`VrShell.leaveSharedLobby`) ; une voix qui n'a pas de tête où
 * s'accrocher est posée juste devant l'auditeur et le suit - c'est-à-dire
 * qu'elle sonne au milieu, comme un appel ordinaire. Un mètre et non zéro :
 * une source exactement sur l'auditeur n'a pas de direction, et le HRTF la
 * rend de façon différente selon le navigateur.
 */
export const FALLBACK_DISTANCE = 1;

/**
 * Où poser la voix d'un ami : sur sa tête s'il en a une, devant moi sinon.
 *
 * `listener` est `null` tant que je n'ai pas de pose ; on garde alors la
 * convention par défaut de Web Audio (auditeur à l'origine, regard vers -Z),
 * et le repli tombe au même endroit que ce que l'auditeur par défaut entend
 * comme « devant ».
 */
export function sourcePosition(theirs: Pose | null, listener: ListenerFrame | null): Vec3 {
  if (theirs) return [theirs[0], theirs[1], theirs[2]];
  const at = listener ?? { position: [0, 0, 0] as Vec3, forward: [0, 0, -1] as Vec3 };
  return [
    at.position[0] + at.forward[0] * FALLBACK_DISTANCE,
    at.position[1] + at.forward[1] * FALLBACK_DISTANCE,
    at.position[2] + at.forward[2] * FALLBACK_DISTANCE
  ];
}

/**
 * Le réglage d'atténuation des panoramiques, en un seul endroit.
 *
 * `inverse` avec une référence d'un mètre : en deçà, pleine voix - un ami
 * collé à vous ne hurle pas - et au-delà la voix décroît doucement, à 1/(1 +
 * 0,6·(d-1)). À dix mètres on l'entend encore à un sixième : on sait qu'il
 * parle et d'où, sans le suivre. C'est la règle des mondes partagés, où une
 * conversation se rejoint en marchant vers elle.
 */
export const DISTANCE = {
  model: 'inverse',
  refDistance: 1,
  rolloffFactor: 0.6,
  maxDistance: 50
} as const;

/** Le gain `inverse` de Web Audio, recopié pour que le test dise ce qu'on entend. */
export function distanceGain(distance: number): number {
  const d = Math.min(Math.max(distance, DISTANCE.refDistance), DISTANCE.maxDistance);
  return DISTANCE.refDistance /
    (DISTANCE.refDistance + DISTANCE.rolloffFactor * (d - DISTANCE.refDistance));
}

/** Le niveau efficace d'une trame d'échantillons, 0 pour le silence. */
export function rmsLevel(samples: ArrayLike<number>): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

/**
 * Les deux seuils du « il parle », en niveau efficace.
 *
 * DEUX SEUILS ET UN MAINTIEN, sans quoi l'anneau clignote entre deux syllabes.
 * On s'allume au-dessus de `ON`, on ne s'éteint qu'après `HOLD_MS` passés sous
 * `OFF`. Un micro ouvert dans une pièce calme, après la suppression de bruit du
 * navigateur, se tient bien en dessous de `OFF`.
 */
export const SPEAKING = { ON: 0.02, OFF: 0.01, HOLD_MS: 350 } as const;

export interface SpeakingState {
  speaking: boolean;
  /** Le dernier instant où le niveau était au-dessus de `OFF`. */
  lastLoud: number;
}

export const SILENT: SpeakingState = { speaking: false, lastLoud: -Infinity };

export function speakingStep(state: SpeakingState, level: number, now: number): SpeakingState {
  if (level >= SPEAKING.ON) return { speaking: true, lastLoud: now };
  if (level >= SPEAKING.OFF) {
    return { speaking: state.speaking, lastLoud: state.speaking ? now : state.lastLoud };
  }
  if (state.speaking && now - state.lastLoud < SPEAKING.HOLD_MS) return state;
  return { speaking: false, lastLoud: state.lastLoud };
}

/**
 * Le gain du jeu pendant qu'un ami parle.
 *
 * On baisse, on ne coupe pas : le jeu reste la raison d'être là, et une musique
 * qui disparaît à chaque mot se remarque davantage qu'une voix un peu couverte.
 * Environ -7 dB, ce que font les appels de groupe des consoles.
 */
export const DUCKED_GAME_GAIN = 0.45;

export function gameGainFor(someoneSpeaking: boolean): number {
  return someoneSpeaking ? DUCKED_GAME_GAIN : 1;
}

/**
 * L'état du micro, tel que le badge du poignet et le lutrin le montrent.
 *
 * - `idle` : personne à qui parler, donc le micro n'est même pas demandé.
 * - `asking` : la permission est en cours.
 * - `live` : ouvert, on vous entend.
 * - `muted` : coupé par vous.
 * - `denied` : refusé ou absent. Vous entendez les autres, eux non.
 */
export type MicState = 'idle' | 'asking' | 'live' | 'muted' | 'denied';

/**
 * Ce qu'on affiche : `muted` l'emporte sur `idle`, pour qu'un joueur qui a
 * coupé son micro avant l'arrivée de quiconque le voie toujours coupé.
 */
export function micShown(acquired: MicState, mutedByMe: boolean): MicState {
  if (mutedByMe && acquired !== 'denied') return 'muted';
  return acquired;
}
