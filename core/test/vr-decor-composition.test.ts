/**
 * Les profondeurs du décor, et la seule d'entre elles qui soit un piège.
 *
 * Le rideau doit passer DERRIÈRE l'écran de jeu quel que soit le réglage du
 * joueur, et l'écran est réglable : cinq distances jusqu'à 4,3 m, cinq
 * angles jusqu'à 80 degrés, cinq hauteurs, deux formes, deux rapports de
 * pixel. Le test recalcule ce pire cas au lieu de constater un nombre - c'est
 * ce qui fait qu'ajouter un cran plus lointain, ou un rapport plus haut, fera
 * rougir ici en nommant la cause.
 *
 * La valeur attendue a été mesurée : 5,281 m, en pixels carrés (8/7, donc
 * l'écran le plus HAUT) et non en crt (4/3, qui donne 5,175 - onze
 * centimètres d'erreur, dans le sens dangereux).
 */
import { test } from 'bun:test';
import assert from 'node:assert/strict';
import {
  screenReach,
  screenShadow,
  CURTAIN_RADIUS,
  CURTAIN_MARGIN,
  ANCHOR_DRIFT,
  DECOR_NEAR,
  SKY_RADIUS,
  RINGS,
  ART_PIXELS_PER_METRE,
  CAMERA_FAR,
  floorRepeat
} from '../../frontend/src/lib/vr/decor/composition.js';
import { SCREEN_ANGLES } from '../../frontend/src/lib/vr/screen-shape.js';

test('le pire cas de l_écran est celui qui a été mesuré', () => {
  assert.ok(
    Math.abs(screenReach() - 5.281) < 0.002,
    `screenReach vaut ${screenReach()}`
  );
});

test('l_ombre de l_écran est plus large que son plus grand réglage', () => {
  /*
   * Le nombre, puis la raison de le calculer.
   *
   * 46,4 degrés, et le piège est qu'aucun réglage ne l'annonce : le plus grand
   * arc réglable est de 80 degrés, soit 40 de demi-angle, et c'est l'écran
   * PLAT rapproché à 2 m qui dépasse - sa largeur est lue à la distance de
   * référence, donc l'approcher l'élargit en angle. Six degrés et demi
   * au-delà de la réponse naïve, seize au-delà du réglage par défaut.
   *
   * La deuxième assertion est celle qui compte : elle interdit de « simplifier
   * » `screenShadow` en `max(SCREEN_ANGLES) / 2`. Le premier nombre bougera le
   * jour où un sixième cran de distance ou d'angle arrive, et il DOIT faire
   * rougir ce test - c'est pour ça qu'il est écrit ici plutôt que déduit.
   */
  assert.ok(
    Math.abs((screenShadow() * 180) / Math.PI - 46.3665) < 0.002,
    `screenShadow vaut ${(screenShadow() * 180) / Math.PI} degrés`
  );
  const naive = (Math.max(...SCREEN_ANGLES) / 2) * (Math.PI / 180);
  assert.ok(
    screenShadow() > naive,
    `l'écran plat rapproché devrait dépasser ${(naive * 180) / Math.PI} degrés`
  );
});

test('le rideau passe derrière l_écran, marge comprise', () => {
  assert.ok(
    screenReach() + CURTAIN_MARGIN <= CURTAIN_RADIUS,
    `${screenReach()} + ${CURTAIN_MARGIN} dépasse le rideau à ${CURTAIN_RADIUS}`
  );
});

test('le rideau passe devant le décor, dérive d_ancre comprise', () => {
  // Le rideau est dans `world` (centré sur l'ancre, comme les panneaux) et le
  // décor dans `room` (dont le y ne suit pas l'ancre). Les deux origines
  // s'écartent verticalement dès que le joueur recentre à une autre hauteur -
  // se lever après avoir joué assis. Sans cette réserve, un décor à 6 m
  // passerait DEVANT un rideau de 5,5 m après une telle dérive, et
  // réapparaîtrait au milieu d'une partie.
  assert.ok(
    CURTAIN_RADIUS + ANCHOR_DRIFT <= DECOR_NEAR,
    `rideau ${CURTAIN_RADIUS} + dérive ${ANCHOR_DRIFT} dépasse le décor à ${DECOR_NEAR}`
  );
});

test('tout anneau de décor est au-delà du rideau et en deçà du ciel', () => {
  for (const [name, radius] of Object.entries(RINGS)) {
    assert.ok(radius >= DECOR_NEAR, `${name} à ${radius} est trop près`);
    assert.ok(radius <= SKY_RADIUS, `${name} à ${radius} dépasse le ciel`);
  }
});

test('le ciel tient sous le far de la caméra', () => {
  assert.ok(SKY_RADIUS < CAMERA_FAR);
});

test('une tuile d_un mètre fait seize pixels d_art', () => {
  assert.equal(ART_PIXELS_PER_METRE, 16);
});

test('la tuile du sol se répète une fois par mètre, soit le diamètre du disque', () => {
  assert.equal(floorRepeat(), SKY_RADIUS * 2);
});
