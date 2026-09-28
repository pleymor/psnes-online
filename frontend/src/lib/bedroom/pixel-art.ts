/**
 * Le pixel art de la chambre de gamer (fond B), dessiné ici et nulle part ailleurs.
 *
 * Chaque objet est un SVG dont l'unité est le pixel de la SNES : `rect` sur
 * une grille entière, `shape-rendering: crispEdges`, et une taille affichée
 * multiple entière (`SCALE`). C'est ce qui garde les bords nets à toutes les
 * largeurs, là où une image agrandie par le navigateur se floute.
 *
 * Rien n'est copié : pas de console, de manette ni de personnage existants.
 * La télé est une télé, la console une boîte grise, la bestiole un slime.
 */

export const SCALE = 4;

type Rect = [x: number, y: number, w: number, h: number, fill: string];

function svg(w: number, h: number, body: string, scale = SCALE): string {
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w * scale}" height="${h * scale}" shape-rendering="crispEdges" aria-hidden="true">${body}</svg>`;
}

function rects(list: Rect[]): string {
	return list.map(([x, y, w, h, f]) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${f}"/>`).join('');
}

/** Une grille de caractères, un caractère par pixel, `.` pour le vide. */
function sprite(rows: string[], palette: Record<string, string>, ox = 0, oy = 0): string {
	const out: Rect[] = [];
	rows.forEach((row, y) => {
		// Les pixels voisins de même couleur se fondent en un seul rect.
		let x = 0;
		while (x < row.length) {
			const c = row[x];
			let run = 1;
			while (row[x + run] === c) run++;
			if (c !== '.' && palette[c]) out.push([ox + x, oy + y, run, 1, palette[c]]);
			x += run;
		}
	});
	return rects(out);
}

/** Une police 3x5, réduite aux lettres dont la chambre a besoin. */
const GLYPHS: Record<string, string[]> = {
	'1': ['.#.', '##.', '.#.', '.#.', '###'],
	'9': ['###', '#.#', '###', '..#', '###'],
	'0': ['###', '#.#', '#.#', '#.#', '###'],
	H: ['#.#', '#.#', '###', '#.#', '#.#'],
	I: ['###', '.#.', '.#.', '.#.', '###'],
	U: ['#.#', '#.#', '#.#', '#.#', '###'],
	P: ['##.', '#.#', '##.', '#..', '#..'],
	L: ['#..', '#..', '#..', '#..', '###'],
	A: ['.#.', '#.#', '###', '#.#', '#.#'],
	Y: ['#.#', '#.#', '.#.', '.#.', '.#.'],
	S: ['###', '#..', '###', '..#', '###'],
	C: ['###', '#..', '#..', '#..', '###'],
	O: ['###', '#.#', '#.#', '#.#', '###'],
	R: ['##.', '#.#', '##.', '#.#', '#.#'],
	E: ['###', '#..', '##.', '#..', '###'],
	'-': ['...', '...', '###', '...', '...']
};

function text(str: string, x: number, y: number, fill: string): string {
	return [...str]
		.map((ch, i) => (GLYPHS[ch] ? sprite(GLYPHS[ch], { '#': fill }, x + i * 4, y) : ''))
		.join('');
}

/** Le papier peint : rayures et losanges, un carreau de 16 pixels. */
export function wallTile(): string {
	return svg(16, 16, rects([
		[0, 0, 16, 16, '#2a2144'],
		[0, 0, 2, 16, '#322859'],
		[8, 0, 1, 16, '#302654'],
		[4, 3, 1, 1, '#4a3d80'],
		[3, 4, 3, 1, '#4a3d80'],
		[4, 5, 1, 1, '#4a3d80'],
		[12, 11, 1, 1, '#3b3068'],
		[11, 12, 3, 1, '#3b3068'],
		[12, 13, 1, 1, '#3b3068']
	]));
}

/** La fenêtre de nuit : un ciel, une lune, une ville qui ne dort pas. */
export function nightWindow(): string {
	const W = 44;
	const H = 36;
	const stars: Rect[] = [
		[6, 5, 1, 1, '#fff'], [15, 3, 1, 1, '#ffe9a8'], [22, 8, 1, 1, '#fff'],
		[9, 12, 1, 1, '#b9e0ff'], [34, 14, 1, 1, '#fff'], [18, 15, 1, 1, '#ffe9a8'],
		[37, 5, 1, 1, '#b9e0ff'], [4, 17, 1, 1, '#fff']
	];
	const moon = sprite(
		['..###.', '.####.', '###...', '###...', '.####.', '..###.'],
		{ '#': '#fff4c2' },
		28,
		4
	);
	// La ville : des blocs sombres, quelques fenêtres allumées.
	const city: Rect[] = [
		[3, 22, 7, 12, '#15112b'], [10, 18, 6, 16, '#1a1535'], [16, 24, 8, 10, '#15112b'],
		[24, 16, 5, 18, '#1a1535'], [29, 21, 7, 13, '#15112b'], [36, 19, 6, 15, '#1a1535']
	];
	const lit: Rect[] = [
		[5, 24, 1, 1, '#f8d030'], [7, 27, 1, 1, '#f8d030'], [12, 20, 1, 1, '#f8d030'],
		[14, 25, 1, 1, '#ffb347'], [26, 18, 1, 1, '#f8d030'], [26, 23, 1, 1, '#f8d030'],
		[31, 24, 1, 1, '#ffb347'], [38, 21, 1, 1, '#f8d030'], [39, 26, 1, 1, '#f8d030'],
		[19, 27, 1, 1, '#f8d030']
	];
	const frame: Rect[] = [
		[0, 0, W, 2, '#6b4a2b'], [0, H - 2, W, 2, '#6b4a2b'],
		[0, 0, 2, H, '#6b4a2b'], [W - 2, 0, 2, H, '#6b4a2b'],
		[21, 2, 2, H - 4, '#6b4a2b'], [2, 17, W - 4, 2, '#6b4a2b'],
		[0, 0, W, 1, '#8a6239'], [0, 0, 1, H, '#8a6239'],
		// Le rebord.
		[-2, H - 1, W + 4, 3, '#8a6239'], [-2, H + 1, W + 4, 1, '#4a3019']
	];
	return svg(
		W + 4,
		H + 4,
		`<g transform="translate(2 0)">${rects([[2, 2, W - 4, H - 4, '#1b1840'], [2, 2, W - 4, 8, '#221c52']])}${rects(stars)}${moon}${rects(city)}${rects(lit)}${rects(frame)}</g>`
	);
}

/** L'affiche « HI-SCORE » : un slime, un score, du scotch. */
export function scorePoster(): string {
	const slime = sprite(
		[
			'....####....',
			'..##gggg##..',
			'.#gggggggg#.',
			'#ggwkggwkgg#',
			'#ggkkggkkgg#',
			'#gggggggggg#',
			'#gggg##gggg#',
			'.##########.'
		],
		{ '#': '#1e5c18', g: '#5ecb3a', w: '#ffffff', k: '#101018' },
		6,
		11
	);
	return svg(
		24,
		34,
		`${rects([
			[0, 0, 24, 34, '#c42f1c'],
			[1, 1, 22, 32, '#d8492f'],
			[1, 26, 22, 7, '#101018']
		])}${text('HI', 8, 3, '#f8d030')}${slime}${text('999', 6, 27, '#f8d030')}${rects([
			[-1, -1, 5, 3, '#f7efd2cc'],
			[20, -1, 5, 3, '#f7efd2cc']
		])}`
	);
}

/** Le fanion « 1UP », qui pend de travers. */
export function playerPennant(): string {
	return svg(
		40,
		14,
		`${rects([
			[0, 0, 32, 12, '#5647cb'],
			[32, 1, 2, 10, '#5647cb'], [34, 2, 2, 8, '#5647cb'], [36, 3, 2, 6, '#5647cb'], [38, 5, 2, 2, '#5647cb'],
			[0, 12, 34, 1, '#2d2470'],
			[0, 0, 2, 13, '#f7efd2']
		])}${text('1UP', 8, 3, '#ffffff')}${rects([[22, 5, 2, 2, '#f8d030']])}`
	);
}

/** La télé cathodique sur son meuble, la console et la manette devant. */
export function crtCorner(): string {
	const tv: Rect[] = [
		// Les oreilles de lapin.
		[13, 0, 1, 2, '#8f8fa6'], [12, 2, 1, 2, '#8f8fa6'], [11, 4, 1, 2, '#8f8fa6'],
		[26, 0, 1, 2, '#8f8fa6'], [27, 2, 1, 2, '#8f8fa6'], [28, 4, 1, 2, '#8f8fa6'],
		[16, 5, 8, 2, '#3a3a48'],
		// La caisse.
		[2, 7, 36, 28, '#b6af9c'], [2, 7, 36, 2, '#d8d1bd'], [2, 33, 36, 2, '#8a8474'],
		// L'écran, bombé.
		[5, 10, 24, 21, '#10202a'], [6, 11, 22, 19, '#153a3e'],
		// Les boutons.
		[31, 12, 4, 4, '#3a3a48'], [31, 18, 4, 4, '#3a3a48'], [31, 26, 4, 2, '#c42f1c']
	];
	// La lueur de l'écran : des lignes de balayage claires, un reflet.
	const glow: Rect[] = [];
	for (let y = 12; y < 30; y += 2) glow.push([7, y, 20, 1, '#2f8a86']);
	glow.push([8, 13, 3, 1, '#b8fff6'], [8, 14, 1, 3, '#b8fff6']);
	const screen = sprite(
		['..####..', '.#w##w#.', '########', '########', '.#.##.#.'],
		{ '#': '#f8d030', w: '#101018' },
		13,
		17
	);
	const cabinet: Rect[] = [
		[0, 35, 40, 3, '#8a6239'], [0, 35, 40, 1, '#a8783f'],
		[1, 38, 38, 18, '#6b4a2b'], [3, 40, 16, 14, '#4a3019'], [21, 40, 16, 14, '#4a3019'],
		// La console, une boîte grise et ses deux voyants.
		[4, 45, 14, 6, '#9a9aa8'], [4, 45, 14, 1, '#c4c4d0'], [6, 48, 2, 1, '#e85a44'], [9, 48, 5, 1, '#3a3a48'],
		// Le câble de la manette, puis la manette posée devant.
		[18, 49, 6, 1, '#3a3a48'], [23, 50, 1, 4, '#3a3a48'],
		[22, 53, 14, 5, '#9a9aa8'], [23, 54, 1, 3, '#3a3a48'], [22, 55, 3, 1, '#3a3a48'],
		[31, 54, 2, 2, '#c42f1c'], [34, 55, 2, 2, '#c42f1c'], [27, 55, 2, 1, '#3a3a48']
	];
	return svg(40, 58, rects(tv) + rects(glow) + screen + rects(cabinet));
}

/** Une pile de cartouches, rangées debout comme sur une étagère. */
export function cartStack(): string {
	const colors = ['#5647cb', '#c42f1c', '#2f8420', '#e8a33c', '#1d4a86', '#8f3fa8'];
	const out: Rect[] = [];
	colors.forEach((c, i) => {
		const x = i * 5;
		const h = i % 2 ? 22 : 24;
		const y = 26 - h;
		out.push([x, y, 4, h, '#b6af9c'], [x, y, 4, 1, '#d8d1bd'], [x + 1, y + 4, 2, h - 9, c], [x, y + h - 2, 4, 2, '#8a8474']);
	});
	// La planche.
	out.push([-2, 26, 34, 2, '#8a6239'], [-2, 28, 34, 1, '#4a3019']);
	return svg(34, 30, `<g transform="translate(2 0)">${rects(out)}</g>`);
}
