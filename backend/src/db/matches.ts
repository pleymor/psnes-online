/**
 * Les parties jouées, et les cotes qu'on en tire.
 *
 * `Match` fait autorité ; `Rating` est effacé et réécrit depuis lui à chaque
 * insertion. Ce n'est pas de la prudence : Elo est un pliage séquentiel, donc
 * une partie qui arrive en retard - un pair qui rapporte après une reconnexion
 * - doit se ranger à sa place et non être repliée à la fin. Rejouer est la
 * façon la plus simple d'obtenir ça, et à cette échelle le coût est nul.
 *
 * Le jour où il cesse de l'être, on passe à l'incrémental sans changer le
 * schéma - ce qui est exactement pourquoi `Match` reste la source de vérité.
 *
 * Trou connu, laissé tel quel : supprimer un compte met `p1UserId`/`p2UserId`
 * à NULL (migration 0008, ON DELETE SET NULL) mais ne déclenche aucun
 * recalcul - celui-ci n'a lieu qu'à l'insertion suivante sur ce même jeu. Les
 * adversaires du compte supprimé gardent donc une cote qui inclut encore ses
 * parties jusqu'au prochain KO sur ce jeu, où elle saute d'un coup en même
 * temps que tout l'historique se replie sans lui. Recalculer à la suppression
 * réglerait ça mais c'est un chantier à part (il faudrait recalculer sur
 * chaque jeu où le compte a joué, pas seulement le prochain qui reçoit une
 * insertion) ; le dire ici suffit pour l'instant.
 */

import { randomUUID } from 'node:crypto';
import type { Database } from './sqlite.js';
import { fold, INITIAL_RATING, type PlayedMatch } from '../ratings/elo.js';

export interface MatchInsert {
  playedAt: number;
  gameCrc32: string;
  roomId: string;
  sessionId: string;
  frame: number;
  /** Null pour un joueur sans compte : pas d'identité durable, pas de colonne. */
  p1UserId: string | null;
  p2UserId: string | null;
  winner: 0 | 1 | 2;
  p1Health: number;
  p2Health: number;
}

/**
 * Ce que le second rapport d'un même KO produit.
 *
 * `disagreement` n'est pas une erreur à écraser : c'est le signal d'une
 * désynchronisation entre les deux pairs, et le seul endroit du système où
 * elle devient visible. Le premier rapport fait foi.
 */
export type RecordOutcome =
  | { kind: 'recorded' }
  | { kind: 'duplicate' }
  | { kind: 'disagreement'; stored: 0 | 1 | 2 };

export function recordMatch(db: Database, match: MatchInsert): RecordOutcome {
  const run = db.transaction((): RecordOutcome => {
    // Lecture avant écriture plutôt qu'un INSERT OR IGNORE : celui-ci
    // avalerait aussi une violation de clé étrangère, donc un vrai défaut.
    // L'index unique reste la garantie ; ceci est le chemin.
    const existing = db.prepare(
      `SELECT winner FROM "Match" WHERE sessionId = ? AND frame = ?`
    ).get(match.sessionId, match.frame) as { winner: number } | undefined;

    if (existing) {
      return existing.winner === match.winner
        ? { kind: 'duplicate' }
        : { kind: 'disagreement', stored: existing.winner as 0 | 1 | 2 };
    }

    db.prepare(`
      INSERT INTO "Match" (id, playedAt, gameCrc32, roomId, sessionId, frame,
                           p1UserId, p2UserId, winner, p1Health, p2Health)
      VALUES (@id, @playedAt, @gameCrc32, @roomId, @sessionId, @frame,
              @p1UserId, @p2UserId, @winner, @p1Health, @p2Health)
    `).run({ id: randomUUID(), ...match });

    // Une partie contre un invité est de l'historique, pas du classement : la
    // requête ci-dessous l'écarte par ses deux IS NOT NULL, donc il n'y a rien
    // à tester ici.
    recomputeRatings(db, match.gameCrc32);
    return { kind: 'recorded' };
  });

  return run();
}

/**
 * Efface et réécrit les cotes de ce jeu depuis tout son historique.
 *
 * L'ordre est `(playedAt, frame)` et non l'ordre d'insertion : c'est ce qui
 * rend le résultat indépendant de la route qu'ont prise les rapports.
 */
function recomputeRatings(db: Database, gameCrc32: string): void {
  const played = db.prepare(`
    SELECT p1UserId, p2UserId, winner FROM "Match"
    WHERE gameCrc32 = ? AND p1UserId IS NOT NULL AND p2UserId IS NOT NULL
    ORDER BY playedAt, frame
  `).all(gameCrc32) as PlayedMatch[];

  db.prepare(`DELETE FROM "Rating" WHERE gameCrc32 = ?`).run(gameCrc32);

  const insert = db.prepare(`
    INSERT INTO "Rating" (userId, gameCrc32, rating, matches) VALUES (?, ?, ?, ?)
  `);
  for (const [userId, standing] of fold(played)) {
    insert.run(userId, gameCrc32, standing.rating, standing.matches);
  }
}

/**
 * La cote de ce joueur sur ce jeu.
 *
 * Absence de ligne = classement initial, et c'est voulu : la table ne contient
 * que ceux qui ont joué. Un appariement partira des possesseurs de la cartouche
 * et joindra ceci à gauche, l'absence valant `INITIAL_RATING` - une constante
 * partagée avec la formule, pas une ligne fantôme à pré-créer.
 */
export function ratingFor(db: Database, userId: string, gameCrc32: string): number {
  const row = db.prepare(
    `SELECT rating FROM "Rating" WHERE userId = ? AND gameCrc32 = ?`
  ).get(userId, gameCrc32) as { rating: number } | undefined;
  return row?.rating ?? INITIAL_RATING;
}
