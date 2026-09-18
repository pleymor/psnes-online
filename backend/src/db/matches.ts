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

/* ------------------------------------------------------------- les lectures */

/**
 * Ce qu'un écran a le droit de savoir d'un joueur classé.
 *
 * La forme publique d'un utilisateur - ce que rend `toPublicUser()` - plus la
 * cote et le nombre de parties. Ni date de création, ni identifiant Google :
 * une requête qui rendrait `SELECT *` exposerait les deux sans que personne le
 * remarque, d'où les colonnes nommées une par une ci-dessous.
 */
export interface RankedPlayer {
  userId: string;
  pseudo: string;
  discriminator: string;
  avatar: string | null;
  rating: number;
  matches: number;
}

/** Un joueur du salon, classé ou non, invité ou non. */
export interface PlayerStanding {
  userId: string;
  pseudo: string;
  discriminator: string;
  avatar: string | null;
  isAnonymous: boolean;
  /** null quand ce joueur n'a jamais joué de partie classée sur ce jeu. */
  rating: number | null;
  matches: number | null;
}

/**
 * Le classement d'un jeu, du plus fort au plus faible.
 *
 * Servi par `Rating_gameCrc32_rating_idx`. Un joueur sans ligne `Rating` n'y
 * figure pas, et c'est voulu : la table ne contient que ceux qui ont joué, et
 * l'absence vaut `INITIAL_RATING` partout où la question se pose.
 *
 * Le départage à cote égale est `matches` croissant puis `pseudo` : sans lui
 * l'ordre de deux joueurs à 1000 dépendrait du plan d'exécution, et la page
 * changerait d'ordre entre deux chargements sans que rien n'ait bougé.
 */
export function rankingFor(
  db: Database, gameCrc32: string, limit: number, offset: number
): RankedPlayer[] {
  return db.prepare(`
    SELECT r.userId, u.pseudo, u.discriminator, u.avatar, r.rating, r.matches
    FROM "Rating" r
    JOIN "User" u ON u.id = r.userId
    WHERE r.gameCrc32 = ?
    ORDER BY r.rating DESC, r.matches ASC, u.pseudo ASC
    LIMIT ? OFFSET ?
  `).all(gameCrc32, limit, offset) as RankedPlayer[];
}

/**
 * Ce que le salon a besoin de savoir de ses deux joueurs.
 *
 * Une ligne par joueur demandé, **même sans cote** - et c'est tout l'intérêt.
 * Un siège sans cote peut vouloir dire deux choses opposées : un compte qui n'a
 * pas encore joué, et qui sera classé au premier combat, ou un invité qui ne le
 * sera jamais, sa colonne étant NULL dès l'insertion depuis #61. Rendre
 * l'absence confondrait les deux, et l'écran dirait « non classé » à quelqu'un
 * à qui il faut dire « invité ».
 *
 * Le fait vient de `User`, sa source, plutôt que d'un champ recopié dans
 * `RoomPlayer` : un salon relu depuis un instantané porterait une valeur
 * périmée, et élargir ce type ferait payer le lobby VR et la présence pour un
 * affichage.
 *
 * `LEFT JOIN` sur `Rating`, donc, et la sélection part de `User`.
 */
export function standingsOf(
  db: Database, gameCrc32: string, userIds: string[]
): PlayerStanding[] {
  // Une liste vide produirait `IN ()`, que SQLite refuse. Court-circuiter est
  // plus honnête que de fabriquer un marqueur qui ne correspond à personne.
  if (userIds.length === 0) return [];
  const marks = userIds.map(() => '?').join(', ');
  const rows = db.prepare(`
    SELECT u.id AS userId, u.pseudo, u.discriminator, u.avatar, u.isAnonymous,
           r.rating, r.matches
    FROM "User" u
    LEFT JOIN "Rating" r ON r.userId = u.id AND r.gameCrc32 = ?
    WHERE u.id IN (${marks})
  `).all(gameCrc32, ...userIds) as Record<string, unknown>[];

  return rows.map(r => ({
    userId: r.userId as string,
    pseudo: r.pseudo as string,
    discriminator: r.discriminator as string,
    avatar: (r.avatar as string | null) ?? null,
    // SQLite n'a pas de booléen, et ce champ décide de ce que l'écran dit :
    // `=== 1` comme `db/users.ts`, jamais un test de véracité.
    isAnonymous: r.isAnonymous === 1,
    rating: (r.rating as number | null) ?? null,
    matches: (r.matches as number | null) ?? null
  }));
}

/** Un joueur tel qu'une ligne d'historique le nomme, ou null. */
interface PlayedSide {
  userId: string;
  pseudo: string;
  discriminator: string;
}

export interface PlayedRow {
  id: string;
  playedAt: number;
  winner: 0 | 1 | 2;
  p1: PlayedSide | null;
  p2: PlayedSide | null;
  p1Health: number;
  p2Health: number;
}

/**
 * L'historique d'un jeu, du plus récent au plus ancien.
 *
 * `LEFT JOIN` des deux côtés, et non `JOIN` : un invité n'a jamais eu
 * d'identifiant, et un compte supprimé a laissé la sienne à NULL. Un `JOIN`
 * ferait disparaître ces parties de l'historique - or elles ont bien eu lieu,
 * et c'est exactement ce que l'écran existe pour montrer.
 */
export function recentMatches(
  db: Database, gameCrc32: string, limit: number, offset: number
): PlayedRow[] {
  const rows = db.prepare(`
    SELECT m.id, m.playedAt, m.winner, m.p1Health, m.p2Health,
           m.p1UserId, u1.pseudo AS p1Pseudo, u1.discriminator AS p1Disc,
           m.p2UserId, u2.pseudo AS p2Pseudo, u2.discriminator AS p2Disc
    FROM "Match" m
    LEFT JOIN "User" u1 ON u1.id = m.p1UserId
    LEFT JOIN "User" u2 ON u2.id = m.p2UserId
    WHERE m.gameCrc32 = ?
    ORDER BY m.playedAt DESC, m.frame DESC
    LIMIT ? OFFSET ?
  `).all(gameCrc32, limit, offset) as Record<string, unknown>[];

  const side = (id: unknown, pseudo: unknown, disc: unknown): PlayedSide | null =>
    typeof id === 'string' && typeof pseudo === 'string' && typeof disc === 'string'
      ? { userId: id, pseudo, discriminator: disc }
      : null;

  return rows.map(r => ({
    id: r.id as string,
    playedAt: r.playedAt as number,
    winner: r.winner as 0 | 1 | 2,
    p1: side(r.p1UserId, r.p1Pseudo, r.p1Disc),
    p2: side(r.p2UserId, r.p2Pseudo, r.p2Disc),
    p1Health: r.p1Health as number,
    p2Health: r.p2Health as number
  }));
}
