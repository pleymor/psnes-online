/**
 * Lire le classement et l'historique, avec l'échec gardé visible.
 *
 * Le résultat est une union discriminée, et c'est la leçon de
 * `frontend/src/lib/saves/api.ts` : une version antérieure de ce patron
 * traitait « je n'ai pas pu demander » comme « il n'y en a pas », et une
 * session expirée produisait une liste vide, aucune erreur, et une sauvegarde
 * qui en écrasait une autre parce que le formulaire croyait le slot libre.
 *
 * Ici la conséquence serait plus douce et tout aussi fausse : un classement
 * vide parce que le réseau a hoqueté se lirait comme un classement vide parce
 * que personne n'a joué. L'union est ce qui interdit à un appelant de sauter le
 * cas d'échec par accident.
 */

export interface RankedPlayer {
  userId: string;
  pseudo: string;
  discriminator: string;
  avatar: string | null;
  rating: number;
  matches: number;
}

export interface PlayedSide {
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

/** La clé de traduction qui dit pourquoi la lecture n'a pas eu lieu. */
export type RatingsFailure = 'sessionExpired' | 'failedToLoadRatings';

export type RankingResult =
  | { ok: true; players: RankedPlayer[] }
  | { ok: false; reason: RatingsFailure };

export type MatchesResult =
  | { ok: true; matches: PlayedRow[] }
  | { ok: false; reason: RatingsFailure };

/** 401 est « reconnectez-vous » ; tout le reste est « ça n'a pas marché ». */
function reasonFor(status: number): RatingsFailure {
  return status === 401 ? 'sessionExpired' : 'failedToLoadRatings';
}

async function get<T>(url: string): Promise<{ ok: true; data: T } | { ok: false; reason: RatingsFailure }> {
  try {
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) return { ok: false, reason: reasonFor(res.status) };
    return { ok: true, data: (await res.json()) as T };
  } catch {
    return { ok: false, reason: 'failedToLoadRatings' };
  }
}

export async function fetchRanking(crc32: string): Promise<RankingResult> {
  const res = await get<RankedPlayer[]>(`/api/ratings/${crc32}`);
  return res.ok ? { ok: true, players: res.data } : res;
}

/** Un joueur du salon, classé ou non, invité ou non. */
export interface PlayerStanding {
  userId: string;
  pseudo: string;
  discriminator: string;
  avatar: string | null;
  isAnonymous: boolean;
  rating: number | null;
  matches: number | null;
}

export type StandingsResult =
  | { ok: true; standings: PlayerStanding[] }
  | { ok: false; reason: RatingsFailure };

export async function fetchStandings(crc32: string, userIds: string[]): Promise<StandingsResult> {
  if (userIds.length === 0) return { ok: true, standings: [] };
  const query = encodeURIComponent(userIds.join(','));
  const res = await get<PlayerStanding[]>(`/api/ratings/${crc32}?users=${query}`);
  return res.ok ? { ok: true, standings: res.data } : res;
}

export async function fetchMatches(crc32: string): Promise<MatchesResult> {
  const res = await get<PlayedRow[]>(`/api/ratings/${crc32}/matches`);
  return res.ok ? { ok: true, matches: res.data } : res;
}
