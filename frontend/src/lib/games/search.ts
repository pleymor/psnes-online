/**
 * Trouver un jeu dans sa propre bibliothèque.
 *
 * `catalogue-search.ts` fait le même travail côté serveur, sur les 1475
 * fiches livrées, et il n'est pas flou : exact, préfixe, sous-chaîne, rien
 * d'autre. Ici ce sont les jeux du joueur, et ce qu'il tape est ce dont il se
 * souvient - des initiales, un titre sans ses accents, un mot du milieu. La
 * règle est écrite pure et sans rien de propre à la bibliothèque pour pouvoir
 * servir au catalogue le jour où on voudra l'y porter.
 *
 * Ce qu'elle NE fait pas, dit ici pour que personne ne le découvre en le
 * cherchant : elle tolère les lettres manquantes, pas les inversions.
 * « Zleda » ne trouve pas « Zelda ». Le couvrir demande une distance
 * d'édition et un seuil à régler ; sur une bibliothèque qu'on a sous les yeux
 * le prix n'en valait pas la peine, sur le catalogue il le vaudra sans doute.
 */

/** En dessous, une requête correspond à presque tout et ordonne au hasard. */
const MIN_QUERY = 2;

/**
 * Ce qui compte dans un titre, une fois retiré ce que personne ne tape.
 *
 * Les accents partent (personne ne tape « Pokémon »), la casse aussi, et tout
 * ce qui n'est ni lettre ni chiffre devient une espace - un nom de fichier de
 * dump est un buisson de tirets, de parenthèses et de crochets, et un titre
 * porte des deux-points que la recherche ne doit pas exiger.
 */
export function normalise(text: string): string {
	return text
		.normalize('NFD')
		// La plage des diacritiques, en échappements : écrite en caractères
		// littéraux elle est invisible dans la source, donc impossible à relire.
		.replace(/[\u0300-\u036f]/g, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, ' ')
		.trim();
}

/** Les initiales des mots : « Donkey Kong Country » donne « dkc ». */
function initials(text: string): string {
	return text
		.split(' ')
		.map((word) => word[0] ?? '')
		.join('');
}

/** Toutes les lettres de `query`, dans l'ordre, quelque part dans `text`. */
function isSubsequence(text: string, query: string): boolean {
	let at = 0;
	for (const char of query) {
		at = text.indexOf(char, at);
		if (at === -1) return false;
		at += 1;
	}
	return true;
}

/**
 * Plus bas est meilleur ; null quand rien ne correspond.
 *
 * L'ordre des paliers est l'essentiel de la règle : les initiales passent
 * devant une sous-séquence éparpillée, sinon trois lettres ramèneraient la
 * moitié de la bibliothèque dans un ordre qui ne veut rien dire.
 */
export function score(candidate: string, query: string): number | null {
	const text = normalise(candidate);
	if (!text) return null;

	if (text === query) return 0;
	if (text.startsWith(query)) return 1;
	if (text.split(' ').some((word) => word.startsWith(query))) return 2;
	if (text.includes(query)) return 3;
	if (initials(text).includes(query)) return 4;
	if (isSubsequence(text, query)) return 5;
	return null;
}

/** Ce que la recherche regarde d'un jeu : ce que la carte montre. */
export interface Searchable {
	title: string;
	/** Tant que rien ne l'a identifié, c'est ce qu'il affiche. */
	filename?: string;
}

export function searchGames<T extends Searchable>(games: T[], query: string): T[] {
	const wanted = normalise(query);
	if (wanted.length < MIN_QUERY) return games;

	return games
		.map((game, index) => {
			const scores = [score(game.title, wanted), score(game.filename ?? '', wanted)]
				.filter((s): s is number => s !== null);
			return { game, index, rank: scores.length > 0 ? Math.min(...scores) : null };
		})
		.filter((row): row is { game: T; index: number; rank: number } => row.rank !== null)
		.sort((a, b) => {
			if (a.rank !== b.rank) return a.rank - b.rank;
			// À égalité, le titre le plus court : celui qui n'est QUE ce qu'on a
			// tapé est le plus probable. Puis la position de départ, pour que la
			// grille ne danse pas sous le curseur à chaque frappe.
			const byLength = a.game.title.length - b.game.title.length;
			return byLength !== 0 ? byLength : a.index - b.index;
		})
		.map((row) => row.game);
}
