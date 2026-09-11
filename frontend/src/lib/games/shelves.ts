/**
 * Où poser les étagères sous une grille de jaquettes.
 *
 * Les planches ont d'abord été un fond répété sur la grille : une seule
 * règle CSS, aucun élément, et un pas constant. C'était suffisant tant
 * qu'une planche n'était qu'un motif - mais un motif n'a pas de bords, donc
 * pas de bouts à arrondir, et pas de coin à traiter autrement que le reste.
 * Chaque étagère est maintenant un élément, ce qui demande de savoir
 * combien il y en a et à quelle hauteur : c'est tout ce que ce module fait.
 *
 * Il ne touche à rien. Il reçoit des nombres et rend des nombres, ce qui le
 * rend vérifiable sans navigateur - et c'est utile, parce qu'une planche
 * mal placée traverse une jaquette, et qu'on ne s'en aperçoit qu'à l'oeil.
 */

/**
 * Combien de pistes de `cardWidth` tiennent dans `width`.
 *
 * La même arithmétique que `repeat(auto-fill, <cardWidth>)` : n pistes
 * demandent n-1 gouttières, donc on ajoute une gouttière des deux côtés de
 * la division pour ne pas perdre la dernière piste d'un cheveu.
 *
 * Rend 0 tant que la largeur est inconnue - avant la première mesure, une
 * grille fait zéro pixel de large, et poser des étagères sur une supposition
 * les ferait sauter à la mesure suivante. Zéro colonne, zéro étagère, rien
 * ne bouge.
 */
export function columnsThatFit(width: number, cardWidth: number, columnGap: number): number {
	if (!(width > 0) || !(cardWidth > 0)) return 0;
	const fits = Math.floor((width + columnGap) / (cardWidth + columnGap));
	// Une piste plus large que la grille en laisse quand même une : c'est ce
	// que fait `auto-fill`, et la carte déborde plutôt que de disparaître.
	return Math.max(1, fits);
}

/**
 * La largeur qu'une piste a vraiment, qui n'est pas toujours celle demandée.
 *
 * Le CSS la plafonne : `min(<largeur de carte>, 100%)`. Une jaquette de SNES
 * garde son format et ne s'étire pas pour remplir un écran, mais elle ne
 * peut pas non plus déborder d'un téléphone plus étroit qu'elle - alors elle
 * cède. Les planches se posent donc sur cette largeur-ci, pas sur la valeur
 * nominale, sans quoi elles traverseraient les jaquettes dès qu'elle cède.
 *
 * Le miroir exact de la fonction CSS, et c'est tout ce qu'elle est.
 */
export function trackWidth(width: number, cardWidth: number): number {
	if (!(width > 0)) return 0;
	return Math.min(cardWidth, width);
}

export interface RowLayout {
	/** Combien de jaquettes la grille montre. */
	count: number;
	/** Combien il en tient par rangée. */
	columns: number;
	/** La hauteur d'une rangée, sans la gouttière. */
	rowHeight: number;
	/** La gouttière entre deux rangées. */
	rowGap: number;
}

/**
 * Le bas de chaque rangée, en pixels depuis le haut de la grille.
 *
 * C'est la ligne sur laquelle les cartouches reposent, donc la ligne dont
 * l'étagère se déduit : son dessus passe au-dessus, son chant en dessous.
 * La dernière rangée en a une comme les autres - une étagère qui s'arrête
 * avant la dernière rangée laisse ses jeux en l'air.
 */
export function rowBottoms({ count, columns, rowHeight, rowGap }: RowLayout): number[] {
	if (count <= 0 || columns <= 0) return [];
	const rows = Math.ceil(count / columns);
	return Array.from({ length: rows }, (_, i) => i * (rowHeight + rowGap) + rowHeight);
}
