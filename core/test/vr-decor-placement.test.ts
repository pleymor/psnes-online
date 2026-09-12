/**
 * Les placements du relief : les règles que la relecture n'attrape pas.
 *
 * Le test ne juge pas la composition - c'est affaire de goût et de casque. Il
 * tient les quatre invariants dont la violation est invisible depuis un
 * terminal et coûteuse dans un casque.
 */
import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { scenery, props, creatures } from '../../frontend/src/lib/vr/decor/placement.js';
import {
  DECOR_NEAR,
  SKY_RADIUS,
  ART_PIXELS_PER_METRE,
  RINGS,
  screenShadow
} from '../../frontend/src/lib/vr/decor/composition.js';
import { ALL_ART } from '../../frontend/src/lib/vr/decor/art/index.js';

test('aucun élément ne vient devant le rideau ni derrière le ciel', () => {
  for (const prop of scenery()) {
    assert.ok(prop.radius >= DECOR_NEAR, `${prop.art} à ${prop.radius} m est trop près`);
    assert.ok(prop.radius <= SKY_RADIUS, `${prop.art} à ${prop.radius} m dépasse le ciel`);
  }
});

test('tout élément désigne un motif qui existe', () => {
  for (const prop of scenery()) {
    assert.ok(ALL_ART[prop.art], `motif inconnu : ${prop.art}`);
  }
});

test('le relief fait vraiment le tour, pas seulement le devant', () => {
  // Le demandeur a choisi 360 degrés. Un décor qui ne couvre que l'avant est
  // la régression silencieuse la plus facile à commettre ici : on compose en
  // regardant droit devant, et on ne se retourne jamais depuis un terminal.
  const quadrants = new Set(
    scenery().map((prop) => Math.floor((((prop.azimuth % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) / (Math.PI / 2)))
  );
  assert.equal(quadrants.size, 4, `quadrants occupés : ${[...quadrants]}`);
});

test('les collines sont fixes et les nuages des billboards', () => {
  // La règle de la spec §6, et elle a une raison dans chaque sens : une
  // colline à vingt mètres qui pivoterait perdrait sa silhouette franche, un
  // nuage fixe montrerait sa tranche.
  for (const prop of scenery()) {
    if (prop.art.startsWith('hill')) assert.equal(prop.facing, 'fixed', prop.art);
    if (prop.art === 'cloud') assert.equal(prop.facing, 'billboard', prop.art);
  }
});

test('les nuages flottent et le reste est posé', () => {
  for (const prop of scenery()) {
    if (prop.art === 'cloud') assert.ok(prop.standing > 2, 'un nuage au sol');
    else assert.equal(prop.standing, 0, `${prop.art} flotte`);
  }
});

test('la composition est déterministe', () => {
  assert.deepEqual(scenery(), scenery());
});

test('aucun objet proche ne vient devant le rideau', () => {
  for (const prop of props()) {
    assert.ok(prop.radius >= DECOR_NEAR, `${prop.front} à ${prop.radius} m`);
  }
});

test('tout objet proche désigne trois motifs qui existent', () => {
  for (const prop of props()) {
    for (const art of [prop.front, prop.side, prop.top]) {
      assert.ok(ALL_ART[art], `motif inconnu : ${art}`);
    }
  }
});

test('les objets proches restent dans la zone où la stéréo voit le volume', () => {
  // La spec §6 : la boîte se justifie sous douze mètres. Plus loin, elle coûte
  // quatre faces pour un volume que personne ne perçoit, et il faut repasser
  // en quad plat.
  for (const prop of props()) {
    assert.ok(prop.radius <= 12, `${prop.front} à ${prop.radius} m ne mérite plus une boîte`);
  }
});

test('un objet proche a une profondeur réelle', () => {
  for (const prop of props()) assert.ok(prop.depth > 0.1, `${prop.front} est plat`);
});

test('aucun objet proche ne se cache derrière l_écran de jeu', () => {
  /*
   * Le défaut que ce test garde a été trouvé dans le casque le 2026-09-11, et
   * il était entier dans le plan : la rangée de blocs `?` était posée aux
   * azimuts -12, 0 et +12 degrés, c'est-à-dire pile derrière l'image du jeu.
   * Trois objets corrects, à la bonne hauteur, avec le bon dessin, et
   * invisibles depuis l'ancre - il fallait marcher six mètres de côté pour
   * les voir.
   *
   * CE QUE CE TEST NE GARDE PAS : les pupitres. Ils couvrent 36 à 84 degrés
   * de chaque côté, mais seulement de -7,8 à -41 degrés d'élévation, donc ils
   * ne cachent que ce qui est posé au sol - la rangée de blocs leur passe
   * au-dessus. La règle complète demanderait de comparer deux bandes
   * d'élévation contre `sceneLayout()`, et elle n'est pas écrite : l'en-tête
   * de `placement.ts` porte les nombres, et c'est tout ce qui tient
   * aujourd'hui le tuyau de devant à 96 degrés.
   *
   * L'ombre de l'écran est CALCULÉE (`screenShadow`) plutôt que constatée,
   * comme `screenReach` l'est pour le rideau : elle vaut 46 degrés, pas les 30
   * du réglage par défaut, et c'est l'écran PLAT au cran le plus proche qui
   * l'emporte - sa largeur se lit à la distance de référence, donc l'approcher
   * l'élargit en angle. Aucune relecture ne donne ce nombre.
   */
  const shadow = screenShadow();
  for (const prop of props()) {
    const width = ALL_ART[prop.front].rows[0].length / ART_PIXELS_PER_METRE;
    // Le bord de l'objet, pas son centre : un bloc d'un mètre à sept mètres
    // déborde de quatre degrés de part et d'autre.
    const half = Math.asin(width / 2 / prop.radius);
    // L'azimut ramené dans (-180, 180] : l'ombre est centrée sur le devant.
    const TURN = 2 * Math.PI;
    const signed = ((((prop.azimuth % TURN) + TURN) % TURN) + Math.PI) % TURN - Math.PI;
    const inner = Math.abs(signed) - half;
    assert.ok(
      inner > shadow,
      `${prop.front} à ${((signed * 180) / Math.PI).toFixed(1)}° : son bord entre à ` +
        `${((inner * 180) / Math.PI).toFixed(1)}°, l'écran en couvre ` +
        `${((shadow * 180) / Math.PI).toFixed(1)}°`
    );
  }
});

/*
 * Ce qui bouge. Les trois règles de confort de la spec §7 sont des
 * CONTRAINTES DE COMPOSITION, donc elles se vérifient ici, sur les nombres,
 * et non dans le code qui anime.
 */

test('rien ne bouge assez vite pour donner la nausée', () => {
  // Moins de sept degrés par seconde. C'est le mouvement rapide près du
  // centre du champ qui rend malade, et le test mesure le RAPPORT de la
  // vitesse au rayon : la règle se viole en rapprochant un goomba, pas en
  // l'accélérant. Rapprocher est d'ailleurs tentant - de près, il se voit.
  for (const creature of creatures()) {
    if (creature.motion.kind !== 'patrol') continue;
    const degreesPerSecond = (creature.motion.speed / creature.radius) * (180 / Math.PI);
    assert.ok(degreesPerSecond < 7, `${creature.frames[0]} file à ${degreesPerSecond} deg/s`);
  }
});

test('rien ne clignote au-dessus de trois hertz, sauf un sprite de la taille d_un genou', () => {
  for (const creature of creatures()) {
    assert.ok(creature.hz <= 8, `${creature.frames[0]} à ${creature.hz} Hz`);
    // Une boucle de deux images à 8 Hz fait quatre alternances par seconde sur
    // un sprite de la taille d'un genou : ce n'est pas un clignotement de
    // grande surface, et c'est la cadence de l'original. Une image unique qui
    // clignoterait, en revanche, n'est qu'un aplat qui bat.
    if (creature.frames.length === 1) assert.ok(creature.hz <= 3, 'un aplat qui clignote');
  }
});

test('toute créature désigne des motifs qui existent, et au moins un', () => {
  for (const creature of creatures()) {
    assert.ok(creature.frames.length >= 1);
    for (const art of creature.frames) assert.ok(ALL_ART[art], `motif inconnu : ${art}`);
  }
});

test('aucune créature ne vient devant le rideau', () => {
  for (const creature of creatures()) {
    assert.ok(creature.radius >= DECOR_NEAR, `${creature.frames[0]} à ${creature.radius} m`);
  }
});

test('la plante sort du tuyau, et non à côté', () => {
  /*
   * Le seul couplage entre deux listes de ce module, et il est réel : une
   * plante carnivore qui pousse à côté de son tuyau ne se lit pas comme un
   * décalage d'un mètre, elle se lit comme un bug. Les deux azimuts doivent
   * donc rester égaux - ce qui a déjà failli se perdre, puisque le tuyau de
   * devant a changé d'azimut pour sortir de l'ombre de l'écran.
   */
  for (const creature of creatures()) {
    if (creature.motion.kind !== 'piranha') continue;
    const hosts = props().filter(
      (prop) => Math.abs(prop.azimuth - creature.azimuth) < 1e-9 && prop.radius === creature.radius
    );
    assert.ok(hosts.length > 0, `aucun tuyau à l'azimut ${creature.azimuth}`);
  }
});

test('le bloc qui pulse bat lentement, et sur des motifs qui existent', () => {
  // Le pulsement n'est pas une créature : c'est la FAÇADE d'une boîte dont la
  // palette tourne, donc il vit sur `BoxProp`. Un mètre de large à hauteur de
  // frappe, ce n'est plus un sprite de la taille d'un genou - d'où les trois
  // hertz de la spec, et non les huit d'un goomba.
  const pulsing = props().filter((prop) => prop.frames);
  assert.ok(pulsing.length > 0, 'aucune boîte ne pulse');
  for (const prop of pulsing) {
    assert.ok(prop.hz !== undefined && prop.hz <= 3, `${prop.front} bat à ${prop.hz} Hz`);
    for (const art of prop.frames ?? []) assert.ok(ALL_ART[art], `motif inconnu : ${art}`);
  }
});

test('la plante ne décolle pas de son tuyau', () => {
  /*
   * Vu dans le casque le 2026-09-11 : à pleine sortie, la tête flottait un
   * demi-mètre AU-DESSUS de la lèvre, détachée, avec du ciel entre les deux.
   * Rien ne l'attrapait - `motion.ts` garde sa course, `creatures()` garde son
   * azimut, et personne ne comparait la course à la hauteur du tuyau.
   *
   * La règle : la BASE de la tête ne doit jamais dépasser le sommet de la
   * lèvre. C'est ce qui fait qu'une plante sort du tuyau plutôt que de planer
   * au-dessus, et c'est pour ça qu'aucune tige n'est nécessaire.
   */
  for (const creature of creatures()) {
    if (creature.motion.kind !== 'piranha') continue;
    const hosts = props().filter(
      (prop) => Math.abs(prop.azimuth - creature.azimuth) < 1e-9 && prop.radius === creature.radius
    );
    const lipTop = Math.max(
      ...hosts.map(
        (prop) => prop.standing + ALL_ART[prop.front].rows.length / ART_PIXELS_PER_METRE
      )
    );
    const risenBase = creature.standing + creature.motion.travel;
    assert.ok(
      risenBase <= lipTop + 1e-9,
      `la tête part de ${risenBase} m alors que la lèvre culmine à ${lipTop} m`
    );
  }
});

test('seuls les collines et les nuages suivent le joueur', () => {
  /*
   * Le drapeau qui permet d'aller partout : le lointain suit la tête, le
   * proche reste posé et s'éloigne vraiment.
   *
   * Il est DÉCLARÉ et non déduit d'un rayon, parce qu'un seuil ne marche pas
   * ici - `scenery()` pose des buissons sur l'anneau des créatures (12 m) ET
   * sur celui des nuages (15 m), donc n'importe quel seuil entre les deux
   * ferait suivre la moitié des buissons et rester l'autre.
   */
  const follows = new Set(scenery().filter((prop) => prop.distant).map((prop) => prop.art));
  assert.deepEqual([...follows].sort(), ['cloud', 'hillLarge', 'hillSmall']);
});

test('rien de proche ne se déclare lointain', () => {
  // Le drapeau dit ce qui suit ; cette règle dit ce qui n'a pas le droit de
  // suivre. Un tuyau ou un buisson qui suivrait le joueur serait un objet dont
  // on ne peut jamais s'approcher, ce qui se voit immédiatement.
  for (const prop of scenery()) {
    if (!prop.distant) continue;
    assert.ok(
      prop.radius >= RINGS.creatures,
      `${prop.art} suit le joueur à ${prop.radius} m, sous l'anneau des créatures`
    );
  }
});
