/**
 * Le rapport d'un KO, et ce qu'on en croit.
 *
 * On croit le client sur parole pour *qui a gagné* : le verdict vient de sa
 * RAM et il n'y a pas d'autre source. On ne le croit pas sur *qui jouait* -
 * l'identité des deux joueurs est lue sur le salon, au moment du rapport,
 * parce que les ports se réassignent en cours de session et parce qu'un
 * client qui nomme les joueurs peut s'attribuer la victoire de n'importe qui.
 *
 * Les deux pairs rapportent le même KO : la déduplication est dans
 * `db/matches.ts`, sur `(sessionId, frame)`. Deux rapporteurs plutôt qu'un
 * n'est pas un gaspillage - un `emit` sur un socket coupé disparaît sans
 * erreur et rien ne le rejoue, donc il faut que les deux tombent au même
 * instant pour perdre la ligne.
 */

import type { Server, Socket } from 'socket.io';
import type { Room } from '../types/index.js';
import { getDb } from '../db/sqlite.js';
import { findUserById } from '../db/users.js';
import { recordMatch } from '../db/matches.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('Match');

interface MatchReport {
  roomId: string;
  frame: number;
  winner: 0 | 1 | 2;
  p1Health: number;
  p2Health: number;
}

/** L'identité classable derrière un port, ou null pour un invité ou un siège vide. */
function rankableAt(room: Room, port: 1 | 2): string | null {
  const player = room.players.find(p => p.port === port);
  if (!player) return null;
  const user = findUserById(getDb(), player.userId);
  // Un anonyme n'a pas d'identité durable : la colonne reste vide dès
  // l'insertion, plutôt que d'attendre le balayage des sessions mortes.
  return user && !user.isAnonymous ? user.id : null;
}

export function registerMatchHandlers(
  socket: Socket,
  _io: Server,
  userId: string,
  rooms: Map<string, Room>
): void {
  socket.on('match:report', (data: MatchReport) => {
    const room = rooms.get(data?.roomId);
    if (!room) return;
    // Un rapport ne peut venir que d'un membre du salon qu'il décrit.
    if (!room.players.some(p => p.userId === userId)) return;

    if (!room.gameCrc32 || !room.playSessionId) {
      // Ne devrait pas arriver : le guetteur ne s'arme que sur un CRC32 connu,
      // et une partie en cours a une session. D'où le bruit plutôt que le
      // silence - c'est le seul endroit où l'anomalie serait visible.
      logger.warn(
        { roomId: room.id, hasCrc32: !!room.gameCrc32, hasSession: !!room.playSessionId },
        'Match reported for a room that cannot be ranked'
      );
      return;
    }

    const outcome = recordMatch(getDb(), {
      playedAt: Date.now(),
      gameCrc32: room.gameCrc32,
      roomId: room.id,
      sessionId: room.playSessionId,
      frame: data.frame,
      p1UserId: rankableAt(room, 1),
      p2UserId: rankableAt(room, 2),
      winner: data.winner,
      p1Health: data.p1Health,
      p2Health: data.p2Health
    });

    if (outcome.kind === 'disagreement') {
      // Les deux pairs ont lu la même RAM et ne sont pas tombés d'accord : ils
      // ne font plus tourner la même machine. Le premier rapport est gardé.
      logger.error(
        { roomId: room.id, frame: data.frame, stored: outcome.stored, reported: data.winner },
        'Peers disagree on who won - the session has desynchronised'
      );
    }
  });
}
