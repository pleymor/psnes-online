/**
 * Le début d'une partie, en un seul endroit.
 *
 * Trois sites écrivent `status = 'playing'`, et ils ne veulent pas dire la
 * même chose : `game:start` et la création d'un salon en `autoStart` commencent
 * une partie, `game:resume` termine une pause. Seuls les deux premiers
 * renouvellent la session.
 *
 * Restamper sur une reprise casserait la déduplication autour d'une pause :
 * deux rapports du même KO encadrant la reprise porteraient deux identifiants
 * différents, et la ligne serait écrite deux fois. Le compteur d'images ne
 * repart pas de zéro à la reprise, donc il n'y a rien à protéger là.
 *
 * Écrit à part et en une fonction pour la raison que `rooms/presence.ts`
 * donne : trois sites d'appel déclenchent la transition, et un drapeau posé à
 * deux endroits sur trois est un défaut que personne ne voit.
 */

import { randomUUID } from 'node:crypto';
import type { Room } from '../types/index.js';

/** Un identifiant de session neuf. Le seul endroit qui en fabrique. */
export function newPlaySessionId(): string {
  return randomUUID();
}

/** Une partie commence : le salon joue, et sa session est neuve. */
export function beginPlaySession(room: Room): void {
  room.status = 'playing';
  room.playSessionId = newPlaySessionId();
}
