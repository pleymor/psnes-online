import type { Database } from '../db/sqlite.js';
import { findGameByChecksum, findOwnedGameId } from '../db/games.js';

/**
 * La ligne `Game` du joueur lui-même pour la cartouche du salon.
 *
 * `room.gameId` est l'identifiant de celui qui a *choisi* le jeu, et `Game.id`
 * est par utilisateur : deux joueurs possédant la même ROM possèdent deux
 * lignes différentes. Depuis que l'invité peut choisir le jeu depuis sa propre
 * bibliothèque, `room.gameId` n'est plus nécessairement celui de l'hôte - or
 * c'est l'hôte qui écrit la sauvegarde de pile. Écrire avec `room.gameId` et
 * l'identité de l'appelant ne touchait alors aucune ligne, en silence.
 *
 * C'est le checksum qui relie les deux lignes, comme le dit la spec du lobby :
 * `Game(userId, crc32)` est unique, donc la réponse est au plus une ligne.
 *
 * `room.gameId` est essayé en premier, et seulement s'il appartient déjà à
 * l'appelant : c'est le cas courant (le joueur a choisi son propre jeu), c'est
 * exactement la ligne qu'il désigne, et cela répond encore quand la ligne n'a
 * pas de checksum enregistré.
 *
 * Renvoie `null` quand l'appelant ne possède aucune copie : il ne peut
 * sincèrement rien sauvegarder, et l'appelant doit le lui dire plutôt que de
 * laisser une écriture sans effet passer pour un succès.
 */
export function findOwnGameIdForRoom(
  db: Database,
  room: { gameId?: string; gameCrc32?: string },
  userId: string
): string | null {
  if (room.gameId) {
    const mine = findOwnedGameId(db, room.gameId, userId);
    if (mine) return mine;
  }

  if (!room.gameCrc32) return null;
  return findGameByChecksum(db, userId, room.gameCrc32)?.id ?? null;
}
