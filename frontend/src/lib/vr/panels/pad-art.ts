/**
 * Une manette SNES dessinée, et les huit boutons qu'on y vise.
 *
 * Elle porte sa propre géométrie plutôt que celle de `SnesPad.svelte`, et
 * c'est une décision plutôt qu'une duplication oubliée. Le pad du DOM lie
 * DOUZE boutons - la croix comprise - et celui-ci en lie HUIT, parce qu'en VR
 * la croix est sur les deux sticks et n'est assignable à rien. Partager la
 * forme entre deux jeux de boutons différents demanderait un module paramétré
 * sur leurs noms, pour aucun gain de correction : la forme d'une manette SNES
 * est une réalité physique fixe, et le mapping a déjà sa source unique dans
 * `pad-map.ts`. Deux dessins du même objet, pas deux vérités concurrentes. En
 * prime, `SnesPad.svelte` n'a pas à être opéré - ses commentaires documentent
 * une collision d'ids `<defs>` et une contrainte WCAG qu'il vaut mieux ne pas
 * réveiller.
 *
 * Tout est exprimé dans une boîte de référence de 520 x 244, puis mis à
 * l'échelle de la boîte que l'appelant donne. Le panneau décide donc où et
 * combien grand, et ce module décide de la manette.
 *
 * La croix est dessinée sans être cliquable. Elle est là pour que le dessin
 * soit une manette et non huit boutons flottants, et `panels/controls.ts`
 * porte à côté la phrase qui dit où elle est vraiment.
 */

import type { Region } from '../panel';
import type { VrButton } from '../pad-map';
import { SMW, EDGE } from './chrome';

/** La boîte de référence : tout ci-dessous est exprimé dedans. */
const VIEW_W = 520;
const VIEW_H = 244;

/** Ce que l'appelant doit respecter pour que le dessin ne soit pas déformé. */
export const PAD_ART_ASPECT = VIEW_W / VIEW_H;

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/*
 * La géométrie, en coordonnées de la boîte de référence.
 *
 * Les boîtes de clic sont volontairement plus petites que les cercles
 * dessinés : à 24 de rayon et 42 d'écart, deux carrés de 48 se chevaucheraient
 * dans le coin, et `hit()` retourne la première correspondance - donc un
 * chevauchement ne se voit pas, il fait juste qu'un bouton ne répond plus pour
 * les pressées qui tombent dans la zone commune. `vr-pad-art.test.ts` refuse
 * tout chevauchement pour cette raison.
 */
/*
 * `y: 26` et non 34 : la boîte de clic d'une gâchette est plus haute que son
 * tracé, et à 34 elle descendait d'une unité dans celle de X. Un chevauchement
 * ne se voit pas - `hit()` retourne la première correspondance - il fait juste
 * qu'un bouton cesse de répondre pour les pressées qui tombent dans la zone
 * commune.
 */
const SHOULDER = { w: 90, h: 34, y: 26, lx: 66, rx: 358 };
const DPAD = { cx: 124, cy: 140, arm: 30, thickness: 26 };
const PILL = { w: 56, h: 20, y: 152, selectX: 196, startX: 262 };
/**
 * Le diamant : X en haut, Y à gauche, A à droite, B en bas.
 *
 * `dx`/`dy` sont plus larges que le strict nécessaire au tracé, et c'est ce
 * qui laisse la place à des boîtes de clic de 48 unités sans qu'elles se
 * chevauchent dans les coins. Un diamant serré serait plus fidèle et
 * inatteignable.
 */
const FACE = { cx: 396, cy: 140, dx: 50, dy: 44, drawn: 22, hit: 24 };
const BODY = { x: 30, y: 64, w: 460, h: 140, r: 30 };

/*
 * Les cibles sont plus grandes que ce qui est dessiné, et volontairement.
 *
 * Une pastille SNES fait 56 x 20 : à 640 px de canvas et 25,6 px par degré,
 * cela donne 0,9 degré de haut, contre 2,5 pour les huit lignes que ce dessin
 * remplace. Fidèle et inatteignable. Le tracé garde donc ses proportions et la
 * boîte de clic est grandie autour de lui - c'est la raison d'être de la
 * séparation entre `padRegions` et `drawPadArt`, et
 * `vr-pad-art.test.ts` borne le côté court de chaque cible.
 */
const PILL_HIT_H = 44;
const SHOULDER_HIT_H = 44;

type Shape = { id: VrButton; x: number; y: number; w: number; h: number };

/** Les huit boîtes de clic, dans la boîte de référence. */
const SHAPES: Shape[] = [
  { id: 'l', x: SHOULDER.lx, y: SHOULDER.y - (SHOULDER_HIT_H - SHOULDER.h) / 2, w: SHOULDER.w, h: SHOULDER_HIT_H },
  { id: 'r', x: SHOULDER.rx, y: SHOULDER.y - (SHOULDER_HIT_H - SHOULDER.h) / 2, w: SHOULDER.w, h: SHOULDER_HIT_H },
  { id: 'x', x: FACE.cx - FACE.hit, y: FACE.cy - FACE.dy - FACE.hit, w: FACE.hit * 2, h: FACE.hit * 2 },
  { id: 'y', x: FACE.cx - FACE.dx - FACE.hit, y: FACE.cy - FACE.hit, w: FACE.hit * 2, h: FACE.hit * 2 },
  { id: 'a', x: FACE.cx + FACE.dx - FACE.hit, y: FACE.cy - FACE.hit, w: FACE.hit * 2, h: FACE.hit * 2 },
  { id: 'b', x: FACE.cx - FACE.hit, y: FACE.cy + FACE.dy - FACE.hit, w: FACE.hit * 2, h: FACE.hit * 2 },
  { id: 'select', x: PILL.selectX, y: PILL.y - (PILL_HIT_H - PILL.h) / 2, w: PILL.w, h: PILL_HIT_H },
  { id: 'start', x: PILL.startX, y: PILL.y - (PILL_HIT_H - PILL.h) / 2, w: PILL.w, h: PILL_HIT_H }
];

/** Ce qui est TRACÉ, quand cela diffère de la cible. */
const DRAWN: Partial<Record<VrButton, { x: number; y: number; w: number; h: number }>> = {
  l: { x: SHOULDER.lx, y: SHOULDER.y, w: SHOULDER.w, h: SHOULDER.h },
  r: { x: SHOULDER.rx, y: SHOULDER.y, w: SHOULDER.w, h: SHOULDER.h },
  select: { x: PILL.selectX, y: PILL.y, w: PILL.w, h: PILL.h },
  start: { x: PILL.startX, y: PILL.y, w: PILL.w, h: PILL.h }
};

/**
 * L'ordre dans lequel « Tout configurer » parcourt les boutons.
 *
 * L'ordre du dessin, lu par groupes de haut en bas : les gâchettes, puis le
 * diamant, puis les pastilles. Dans le diamant : haut, gauche, droite, bas.
 * Ce n'est pas l'ordre de déclaration de `VR_BUTTONS` - un joueur suit ce
 * qu'il voit, pas un tableau - mais le test vérifie que c'en est bien une
 * permutation complète, parce qu'un bouton absent de cette liste ne serait
 * jamais proposé et rien ne le dirait.
 */
export const BIND_SEQUENCE: readonly VrButton[] = [
  'l', 'r', 'x', 'y', 'a', 'b', 'select', 'start'
];

/**
 * L'index suivant dans la séquence, ou null quand elle est finie.
 *
 * Le hors-limites rend null plutôt qu'un index qui n'existe pas : sinon la
 * capture reste armée sur rien après le dernier bouton, et le joueur presse
 * dans le vide sans que rien ne le lui dise. Un index négatif recommence au
 * début, ce qui est la réponse utile pour un appel de démarrage.
 */
export function nextInSequence(index: number): number | null {
  if (index < 0) return 0;
  const next = index + 1;
  return next < BIND_SEQUENCE.length ? next : null;
}

/** Met un point de la boîte de référence à l'échelle de `box`. */
function scaler(box: Box) {
  const kx = box.w / VIEW_W;
  const ky = box.h / VIEW_H;
  return {
    x: (v: number) => box.x + v * kx,
    y: (v: number) => box.y + v * ky,
    w: (v: number) => v * kx,
    h: (v: number) => v * ky,
    /** Pour un rayon : la plus petite des deux échelles, donc jamais ovale. */
    r: (v: number) => v * Math.min(kx, ky)
  };
}

/** Les huit régions cliquables, dans les coordonnées de `box`. */
export function padRegions(box: Box): Region[] {
  const s = scaler(box);
  return SHAPES.map((shape) => ({
    id: `bind:${shape.id}`,
    x: s.x(shape.x),
    y: s.y(shape.y),
    w: s.w(shape.w),
    h: s.h(shape.h)
  }));
}

export interface PadArtState {
  /** Le bouton qui attend une entrée, ou null. */
  listeningFor: VrButton | null;
  /** Le bouton survolé, ou null. */
  hovered: VrButton | null;
}

/** Les couleurs des quatre boutons de face, comme sur le plastique. */
const FACE_PAINT: Record<'x' | 'y' | 'a' | 'b', string> = {
  x: '#2f6bd8',
  y: '#2fa34a',
  a: '#d63a3a',
  b: '#e0b325'
};

/*
 * Le boîtier, dans la palette de la Super Famicom.
 *
 * Gris clair, et non le gris sombre de la première version : sur le champ de
 * verre de la tablette, un boîtier sombre se fondait dans le fond et la
 * manette se lisait comme un aplat. Ce que le rendu a montré, et ce que le
 * contour noir épais ci-dessous corrige avec lui - c'est ce contour qui fait
 * lire du plastique moulé plutôt qu'un rectangle arrondi.
 */
const SHELL = '#cfc7bd';
const SHELL_SHADE = '#a49c92';
const DPAD_PAINT = '#4a4a52';

function rounded(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
  ctx.fill();
}

/**
 * Dessine la manette dans `box`.
 *
 * Les gâchettes d'abord et le corps par-dessus, pour qu'elles aient l'air de
 * passer derrière lui plutôt que d'être posées dessus.
 */
export function drawPadArt(
  ctx: CanvasRenderingContext2D,
  box: Box,
  state: PadArtState
): void {
  const s = scaler(box);

  /*
   * Contour d'abord, forme ensuite, pour chaque pièce.
   *
   * Un contour noir épais est ce qui fait lire cette manette comme du
   * plastique moulé et non comme des rectangles arrondis - et c'est aussi ce
   * qui survit à 25 pixels par degré, où un trait fin disparaît. `EDGE` vient
   * de `chrome.ts` pour que tout le style ait la même épaisseur.
   */
  const o = s.r(EDGE);
  for (const x of [SHOULDER.lx, SHOULDER.rx]) {
    ctx.fillStyle = SMW.outline;
    rounded(ctx, s.x(x) - o, s.y(SHOULDER.y) - o, s.w(SHOULDER.w) + o * 2, s.h(SHOULDER.h) + o * 2, s.r(12));
    ctx.fillStyle = SHELL_SHADE;
    rounded(ctx, s.x(x), s.y(SHOULDER.y), s.w(SHOULDER.w), s.h(SHOULDER.h), s.r(10));
  }

  ctx.fillStyle = SMW.outline;
  rounded(ctx, s.x(BODY.x) - o, s.y(BODY.y) - o, s.w(BODY.w) + o * 2, s.h(BODY.h) + o * 2, s.r(BODY.r + 6));
  ctx.fillStyle = SHELL;
  rounded(ctx, s.x(BODY.x), s.y(BODY.y), s.w(BODY.w), s.h(BODY.h), s.r(BODY.r));

  /*
   * La croix, dessinée et jamais cliquable.
   *
   * Grisée pour le dire sans un mot : elle est sur les deux sticks, et aucun
   * preset ne la déplace. `panels/controls.ts` porte la phrase complète à
   * côté du dessin, parce qu'une couleur seule n'apprend rien.
   */
  for (const [paint, pad] of [[SMW.outline, o], [DPAD_PAINT, 0]] as const) {
    ctx.fillStyle = paint;
    ctx.fillRect(
      s.x(DPAD.cx - DPAD.thickness / 2) - pad,
      s.y(DPAD.cy - DPAD.arm) - pad,
      s.w(DPAD.thickness) + pad * 2,
      s.h(DPAD.arm * 2) + pad * 2
    );
    ctx.fillRect(
      s.x(DPAD.cx - DPAD.arm) - pad,
      s.y(DPAD.cy - DPAD.thickness / 2) - pad,
      s.w(DPAD.arm * 2) + pad * 2,
      s.h(DPAD.thickness) + pad * 2
    );
  }

  for (const shape of SHAPES) {
    const listening = state.listeningFor === shape.id;
    const hovered = state.hovered === shape.id;

    if (shape.id === 'x' || shape.id === 'y' || shape.id === 'a' || shape.id === 'b') {
      const cx = s.x(shape.x + shape.w / 2);
      const cy = s.y(shape.y + shape.h / 2);
      ctx.beginPath();
      ctx.arc(cx, cy, s.r(FACE.drawn) + o, 0, Math.PI * 2);
      ctx.fillStyle = SMW.outline;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(cx, cy, s.r(FACE.drawn), 0, Math.PI * 2);
      ctx.fillStyle = listening ? SMW.ink : FACE_PAINT[shape.id];
      ctx.fill();
      if (hovered) {
        ctx.beginPath();
        ctx.arc(cx, cy, s.r(FACE.drawn) + o, 0, Math.PI * 2);
        ctx.strokeStyle = SMW.accent;
        ctx.lineWidth = Math.max(3, s.r(5));
        ctx.stroke();
      }
      ctx.fillStyle = listening ? '#101018' : '#ffffff';
      ctx.font = `600 ${Math.round(s.r(22))}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(shape.id.toUpperCase(), cx, cy);
      continue;
    }

    // Gâchettes et pastilles : le TRACÉ, pas la cible - elles diffèrent, et
    // c'est ce qui les rend visables sans les rendre grotesques.
    const art = DRAWN[shape.id] ?? shape;
    ctx.fillStyle = SMW.outline;
    rounded(ctx, s.x(art.x) - o, s.y(art.y) - o, s.w(art.w) + o * 2, s.h(art.h) + o * 2, s.r(12));
    ctx.fillStyle = listening ? SMW.ink : SHELL_SHADE;
    rounded(ctx, s.x(art.x), s.y(art.y), s.w(art.w), s.h(art.h), s.r(10));
    if (hovered) {
      ctx.strokeStyle = SMW.accent;
      ctx.lineWidth = Math.max(3, s.r(5));
      ctx.strokeRect(s.x(art.x) - o, s.y(art.y) - o, s.w(art.w) + o * 2, s.h(art.h) + o * 2);
    }
    ctx.fillStyle = listening ? SMW.outline : SMW.dark;
    ctx.font = `600 ${Math.round(s.r(shape.id === 'l' || shape.id === 'r' ? 20 : 14))}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(shape.id.toUpperCase(), s.x(art.x + art.w / 2), s.y(art.y + art.h / 2));
  }
}
