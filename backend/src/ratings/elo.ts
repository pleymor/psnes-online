/**
 * Elo, par jeu.
 *
 * Pure et sans base : une liste de parties entre, des cotes sortent. C'est le
 * découpage d'`auth/anonymous.ts` et de `saves/import-plan.ts`, et pour la même
 * raison - une formule écrite dans une route est une formule que personne ne
 * peut prouver.
 *
 * Le pliage est séquentiel : la cote d'une partie dépend de celles que les deux
 * joueurs portaient à ce moment-là, donc l'ordre compte. C'est pourquoi
 * `db/matches.ts` relit tout l'historique d'un jeu dans l'ordre plutôt que
 * d'appliquer un delta à l'arrivée : une partie qui arrive en retard - un pair
 * qui rapporte après une reconnexion - se range à sa place au lieu d'être
 * repliée à la fin.
 */

/** La cote d'un joueur dont on n'a jamais enregistré de partie. */
export const INITIAL_RATING = 1000;

/**
 * Combien une partie peut déplacer.
 *
 * 32 est le choix des petites populations : à une poignée de joueurs, un K
 * faible met des centaines de parties à séparer qui que ce soit. Ce chiffre se
 * change sans rien perdre - `Match` fait autorité et `Rating` en est recalculé.
 */
export const K_FACTOR = 32;

export interface PlayedMatch {
	p1UserId: string;
	p2UserId: string;
	/** Le port qui a gagné, ou 0 pour un double KO. */
	winner: 0 | 1 | 2;
}

export interface Standing {
	rating: number;
	matches: number;
}

/**
 * Les cotes que produit cette suite de parties, dans cet ordre.
 *
 * Le delta est arrondi **une fois**, puis ajouté à l'un et retranché à l'autre.
 * Arrondir les deux cotes séparément ferait fuir un point de temps en temps, et
 * la somme des cotes cesserait d'être conservée sans que personne le voie.
 */
export function fold(matches: readonly PlayedMatch[]): Map<string, Standing> {
	const standings = new Map<string, Standing>();
	const of = (id: string): Standing =>
		standings.get(id) ?? { rating: INITIAL_RATING, matches: 0 };

	for (const match of matches) {
		const p1 = of(match.p1UserId);
		const p2 = of(match.p2UserId);

		const scored = match.winner === 0 ? 0.5 : match.winner === 1 ? 1 : 0;
		const expected = 1 / (1 + 10 ** ((p2.rating - p1.rating) / 400));
		const delta = Math.round(K_FACTOR * (scored - expected));

		standings.set(match.p1UserId, { rating: p1.rating + delta, matches: p1.matches + 1 });
		standings.set(match.p2UserId, { rating: p2.rating - delta, matches: p2.matches + 1 });
	}

	return standings;
}
