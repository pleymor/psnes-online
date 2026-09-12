/**
 * Le chrome Super Mario World, partagé par tous les panneaux.
 *
 * La direction a été choisie sur maquettes rendues : la boîte de statut bleu
 * nuit à contour noir et liseré blanc du HUD de SMW, les jaquettes dans des
 * logements sable, le tout sur le tileset d'herbe. La grille et le défilement
 * ne changent pas - c'est un habillage, pas une refonte.
 *
 * Ce qui se teste ici est la seule chose qu'une maquette ne dit pas : que les
 * épaisseurs survivent au casque. Une maquette vue à cent pour cent sur un
 * moniteur flatte les traits fins, et ce style repose entièrement sur ses
 * contours - si un contour tombe sous le pixel d'affichage, il ne reste que
 * des rectangles colorés.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import {
  SMW,
  EDGE,
  LINER,
  edgeDegrees,
  fieldFill,
  type Field
} from '../../frontend/src/lib/vr/panels/chrome.js';
import { QUEST_3_PIXELS_PER_DEGREE } from '../../frontend/src/lib/vr/layout.js';

/*
 * Le panneau le plus DENSE en pixels par degré est celui qui pardonne le
 * moins : c'est là qu'un contour de N pixels occupe le moins d'angle. Les
 * panneaux du projet tiennent tous autour de 25 px/degré (l'invariant de
 * `vr-layout.test.ts`), donc c'est ce chiffre qui borne l'épaisseur.
 */
test('un contour couvre plus d un cinquieme de degre dans le casque', () => {
  const deg = edgeDegrees(EDGE, QUEST_3_PIXELS_PER_DEGREE);
  assert.ok(
    deg >= 0.18,
    `un contour de ${EDGE}px ne fait que ${deg.toFixed(3)} deg - il disparaitra`
  );
});

test('le lisere est plus fin que le contour, mais pas invisible', () => {
  assert.ok(LINER < EDGE, 'le lisere doit se lire comme un lisere, pas comme un second contour');
  assert.ok(
    edgeDegrees(LINER, QUEST_3_PIXELS_PER_DEGREE) >= 0.14,
    'un lisere sous un septieme de degre ne se verra pas'
  );
});

/*
 * Les deux champs, et pourquoi il y en a deux.
 *
 * Le chrome SMW est opaque par nature - un champ d'herbe. Mais la tablette
 * flotte devant l'écran de jeu, et la demande était de voir la partie à
 * travers elle. Une herbe translucide sur une image serait boueuse, donc la
 * tablette garde les cadres et la boîte de statut mais échange son champ
 * contre un sombre translucide.
 */
test('le champ d herbe est opaque, celui de la tablette ne l est pas', () => {
  assert.ok(!fieldFill('grass').includes('rgba'), 'l herbe doit etre opaque');
  assert.ok(fieldFill('glass').startsWith('rgba'), 'la tablette doit laisser passer le jeu');
});

test('le champ translucide laisse passer une part utile, sans devenir illisible', () => {
  const alpha = Number(fieldFill('glass').split(',').pop()?.replace(')', ''));
  assert.ok(alpha > 0.5, `alpha ${alpha} : le texte du panneau ne se lirait plus`);
  assert.ok(alpha < 0.9, `alpha ${alpha} : autant le laisser opaque`);
});

test('les quatre champs sont les seuls, et ils sont nommes', () => {
  // Quatre depuis la brique et le depoli des pupitres. Ce test a rougi aux
  // deux ajouts, ce qui est exactement ce qu'on lui demande.
  const fields: Field[] = ['grass', 'glass', 'brick', 'frost'];
  for (const f of fields) assert.ok(fieldFill(f).length > 0);
});

test('le joint de brique se devine, il ne se lit pas', () => {
  /*
   * La lecon de l'herbe, encodee en assertion.
   *
   * `drawField` raconte qu'une premiere version du champ d'herbe se disputait
   * l'attention avec les jaquettes, qui sont ce que le panneau existe pour
   * montrer. Une brique a des joints, donc des lignes franches partout : le
   * meme defaut y serait bien pire. Le joint doit donc etre plus sombre que
   * la brique - sinon il n'y a pas de maconnerie - mais de peu.
   *
   * Un joint noir donnerait un ecart de 71 sur cette echelle. La borne a 40
   * laisse de la marge pour ajuster le gout sans laisser passer une grille.
   */
  const lum = (hex: string): number => {
    const c = (i: number) => parseInt(hex.slice(i, i + 2), 16);
    return 0.2126 * c(1) + 0.7152 * c(3) + 0.0722 * c(5);
  };
  const brick = lum(SMW.brick);
  const joint = lum(SMW.brickJoint);
  assert.ok(joint < brick, 'le joint doit etre plus sombre que la brique');
  assert.ok(brick - joint < 40, `ecart de ${brick - joint} : le joint fait une grille`);
});

/*
 * La palette est celle de la carte du monde, pas une invention.
 *
 * Le contour est presque noir et le liseré blanc : c'est ce couple qui fait
 * lire une boîte SMW, et l'inverser ou l'adoucir suffit à perdre le style.
 */
test('le contour est sombre et le lisere clair, ce qui fait la boite SMW', () => {
  const lum = (hex: string) => {
    const n = parseInt(hex.slice(1), 16);
    return ((n >> 16) + ((n >> 8) & 255) + (n & 255)) / 3;
  };
  assert.ok(lum(SMW.outline) < 40, 'le contour doit etre presque noir');
  assert.ok(lum(SMW.ink) > 220, 'le lisere doit etre presque blanc');
  assert.ok(lum(SMW.box) < 120, 'le fond de la boite de statut doit porter du texte blanc');
});

test('le depoli laisse passer plus que le verre de la tablette, sans devenir clair', () => {
  /*
   * Les deux bornes du voile, et elles tirent en sens contraire.
   *
   * Plus transparent que la tablette : un pupitre lateral n'a que du decor
   * derriere lui, la tablette a l'image du jeu qu'elle doit assombrir pour
   * porter du texte blanc. Mais sombre quand meme - un voile clair sur de
   * l'herbe vive et un comptoir orange rendrait les libelles illisibles, et
   * c'est le meme raisonnement qui a fixe celui de la tablette.
   */
  const alpha = (fill: string): number => Number(fill.split(',')[3].replace(')', ''));
  const frost = alpha(fieldFill('frost'));
  const glass = alpha(fieldFill('glass'));
  assert.ok(frost < glass, `le depoli (${frost}) doit laisser passer plus que le verre (${glass})`);
  assert.ok(frost > 0.4, `a ${frost} le voile ne porte plus son texte`);
});
