/**
 * Quels jeux du compte cet appareil peut ouvrir.
 *
 * Le serveur tient l'identité d'un jeu, jamais ses octets, et ceux-ci vivent
 * sur la machine du joueur. Un compte vu depuis un téléphone promet donc des
 * jeux que ce téléphone ne peut pas trouver, et chaque lancement coûte alors un
 * geste que la liste n'avait pas annoncé. Cette fonction est l'endroit unique
 * où l'écran cesse de mentir.
 *
 * Pure et sans DOM pour la même raison que le reste de `roms/` : c'est la seule
 * règle qui décide de ce que le joueur voit, et se tromper ici fait disparaître
 * des jeux qu'il possède réellement.
 */

/** Le strict minimum qu'une entrée de bibliothèque doit porter. */
export interface Identified {
	crc32?: string | null;
}

/**
 * Les jeux de `games` que cet appareil sait résoudre, dans l'ordre reçu.
 *
 * L'ordre est conservé parce que le tri appartient à l'appelant : la page trie
 * par titre avant de filtrer, et refaire ce choix ici le lui volerait.
 *
 * Une entrée **sans checksum** passe le filtre. Elle n'a pas d'octets à trouver
 * puisqu'elle n'a pas encore d'identité, et c'est justement l'écran de la
 * bibliothèque qui offre de la lui donner. La masquer la rendrait irréparable.
 */
export function deviceLibrary<T extends Identified>(
	games: T[],
	resolvable: Iterable<string>
): T[] {
	const here = new Set(resolvable);
	return games.filter((game) => !game.crc32 || here.has(game.crc32));
}
