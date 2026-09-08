/**
 * Where the screen and the three panels sit, and why it is a pure function.
 *
 * None of these numbers will be right first time - they are reasoned starting
 * points, not measurements, and the only way to settle them is a headset on a
 * head. Keeping them in one module with no three.js import is what makes
 * tuning them a one-file change instead of a hunt through scene code.
 *
 * What the tests pin is not the numbers but the relationships that make the
 * "cockpit" layout the thing that was chosen: the panels are nearer than the
 * screen (legibility follows angular distance, which is what ruled out putting
 * all three on one 3 m arc), they are below eye level, and they are exact
 * mirrors. Break any of those and it is a different design.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  sceneLayout,
  eyeDistance,
  angularWidth,
  pixelsPerDegree,
  verticalSpan,
  QUEST_3_PIXELS_PER_DEGREE
} from '../../frontend/src/lib/vr/layout.js';
import { TABLET_PANEL_SIZE } from '../../frontend/src/lib/vr/panels/controls.js';
import { LIBRARY_PANEL_SIZE } from '../../frontend/src/lib/vr/panels/library.js';
import { FRIENDS_PANEL_SIZE } from '../../frontend/src/lib/vr/panels/friends.js';
import { PROFILE_PANEL_SIZE } from '../../frontend/src/lib/vr/panels/profile.js';
import {
  DEFAULT_SHAPE,
  SCREEN_ANGLES,
  SCREEN_DISTANCES,
  SCREEN_HEIGHTS,
  type ScreenShape
} from '../../frontend/src/lib/vr/screen-shape.js';

/** Les 250 réglages atteignables : cinq distances, cinq tailles, cinq
 *  hauteurs, deux formes. Assez peu pour être balayés en entier plutôt
 *  qu'échantillonnés. */
const EVERY_SHAPE: ScreenShape[] = SCREEN_DISTANCES.flatMap((distance) =>
  SCREEN_ANGLES.flatMap((angle) =>
    SCREEN_HEIGHTS.flatMap((height) => [
      { distance, angle, height, curved: true },
      { distance, angle, height, curved: false }
    ])
  )
);

const here = path.dirname(fileURLToPath(import.meta.url));

test('layout.ts imports nothing from three', () => {
  // The whole point of this module is that it is tunable and testable without
  // a renderer. A stray `import * as THREE` here would take both away, and it
  // is the sort of import that arrives while adding "just one Vector3".
  const source = readFileSync(
    path.resolve(here, '..', '..', 'frontend', 'src', 'lib', 'vr', 'layout.ts'),
    'utf8'
  );
  assert.equal(/from ['"]three['"]/.test(source), false, 'layout.ts must stay three-free');
});

test('the screen is a wide arc at arm-and-then-some length', () => {
  const { screen } = sceneLayout('crt', DEFAULT_SHAPE);
  assert.equal(screen.distance, 2.5);
  assert.ok(screen.arc > 0.9 && screen.arc < 1.2, 'about 60 degrees of arc, in radians');
  assert.equal(screen.centerY, 0, 'straight ahead: y is measured from the eyes');
});

test('the screen takes its shape from the aspect preference', () => {
  const crt = sceneLayout('crt', DEFAULT_SHAPE).screen;
  const square = sceneLayout('square', DEFAULT_SHAPE).screen;

  // Arc length is the screen's width; the height follows the ratio the player
  // chose, so 'crt' is the 4:3 the games were composed for.
  const crtWidth = crt.distance * crt.arc;
  const squareWidth = square.distance * square.arc;
  assert.ok(Math.abs(crtWidth / crt.height - 4 / 3) < 1e-9);
  assert.ok(Math.abs(squareWidth / square.height - 8 / 7) < 1e-9);
  assert.ok(crt.height < square.height, '4:3 is a shorter picture than 8:7 at one width');
});

test('the panels are nearer than the screen, which is the whole of the choice', () => {
  const { screen, library, friends, profile } = sceneLayout('crt', DEFAULT_SHAPE);
  for (const [name, panel] of [['library', library], ['friends', friends], ['profile', profile]] as const) {
    const [x, , z] = panel.position;
    const distance = Math.hypot(x, z);
    assert.ok(
      distance < screen.distance,
      `${name} must be nearer than the screen: legibility follows angular distance`
    );
  }
});

test('the panels sit below eye level, to be found by looking down', () => {
  const eye = 1.75;
  // `sceneLayout('crt', eye)` traînait ici depuis une signature où le second
  // argument etait une hauteur d'oeil. Bun ne typait rien, l'argument etait
  // ignore, et le test passait - jusqu'a ce que le second argument devienne la
  // forme de l'ecran, ou 1.75 aurait donne un ecran NaN qu'aucune assertion de
  // ce test ne regarde.
  const { library, friends, profile } = sceneLayout('crt', DEFAULT_SHAPE);
  assert.ok(library.position[1] < eye);
  assert.ok(friends.position[1] < eye);
  assert.ok(profile.position[1] < library.position[1], 'the band is the lowest: it is used least');
});

test('the two lecterns are exact mirrors', () => {
  const { library, friends } = sceneLayout('crt', DEFAULT_SHAPE);
  // A tolerance rather than equality: these come out of Math.sin and Math.cos,
  // whose exact sign symmetry is not something the language guarantees. A
  // picometre of asymmetry is not a layout bug; a centimetre would be, and
  // this still catches that.
  const mirrors = (a: number, b: number, what: string) =>
    assert.ok(Math.abs(a - b) < 1e-12, `${what}: ${a} vs ${b}`);

  mirrors(library.position[0], -friends.position[0], 'library left, friends right');
  mirrors(library.position[1], friends.position[1], 'same height');
  mirrors(library.position[2], friends.position[2], 'same depth');
  mirrors(library.rotation[1], -friends.rotation[1], 'each yaws inward by the same amount');
  mirrors(library.rotation[0], friends.rotation[0], 'both pitch back identically');
  assert.equal(library.width, friends.width);
  assert.equal(library.height, friends.height);
});

test('everything is in front of the player', () => {
  const layout = sceneLayout('crt', DEFAULT_SHAPE);
  for (const panel of [layout.library, layout.friends, layout.profile]) {
    assert.ok(panel.position[2] < 0, 'three.js looks down -Z; a positive z is behind the head');
  }
});

test('the lecterns pitch back so a lowered panel faces raised eyes', () => {
  const { library } = sceneLayout('crt', DEFAULT_SHAPE);
  assert.ok(library.rotation[0] < 0, 'a negative pitch tips the top away and the face upward');
  assert.ok(Math.abs(library.rotation[0]) > 0.5, 'and by a real amount, not a token degree');
});

test('every height is measured from the eyes, never from a floor', () => {
  /*
   * `local` puts the origin at the head, so a positive y would hang the scene
   * above the player's gaze - which is exactly what the old floor-relative
   * numbers did whenever the fallback fired, and nobody ever saw it because
   * the Quest always granted the floor.
   */
  const layout = sceneLayout('crt', DEFAULT_SHAPE);
  assert.equal(layout.screen.centerY, 0);

  for (const [name, placement] of [
    ['library', layout.library],
    ['friends', layout.friends],
    ['profile', layout.profile]
  ] as const) {
    assert.ok(placement.position[1] < 0, `${name} hangs above the eyes instead of below them`);
    assert.ok(
      placement.position[1] > -1.2,
      `${name} is down where a floor would be, which is what this change removed`
    );
  }
});

/*
 * A panel's metres and its canvas pixels have to be the same shape.
 *
 * `panel-mesh.ts` maps each canvas onto its plane with uv 0..1 on both axes,
 * so the two aspect ratios multiply: a 0.7 x 0.5 m lectern carrying an
 * 800 x 600 canvas stretches every glyph horizontally by 1.4 / 1.3333, which
 * is five per cent. Small, invisible as a defect, and it makes all the text
 * very slightly wrong everywhere - which is the sort of thing that reads as
 * "the fonts look off in VR" and never gets diagnosed.
 *
 * The band was already exact. The lecterns were not, and this test is what
 * keeps the next edit to either number honest, since nothing else connects
 * `layout.ts` to the panel modules' canvas sizes.
 */
test('every panel is shaped like its own canvas, or its text is stretched', () => {
  const { library, friends, profile, tablet } = sceneLayout('crt', DEFAULT_SHAPE);

  const pairs = [
    ['library', library, LIBRARY_PANEL_SIZE],
    ['friends', friends, FRIENDS_PANEL_SIZE],
    ['profile', profile, PROFILE_PANEL_SIZE],
    ['tablet', tablet, TABLET_PANEL_SIZE]
  ] as const;

  for (const [name, placement, canvas] of pairs) {
    const metres = placement.width / placement.height;
    const pixels = canvas.width / canvas.height;
    assert.ok(
      Math.abs(metres / pixels - 1) < 0.002,
      `${name} is ${(metres / pixels).toFixed(4)}x wider in metres than in pixels`
    );
  }
});

/*
 * Angular size, which is the only thing legibility answers to.
 *
 * This file's header already says it - "legibility follows angular distance,
 * which is what ruled out putting all three on one 3 m arc" - but nothing
 * measured it, and the lecterns were reported from inside a headset as too
 * small to read without leaning in. At 30 degrees of view an 18px title on an
 * 800px canvas lands around ten display pixels of cap height on a Quest 3,
 * and ten is not enough. Hence a floor on the angle.
 *
 * `eyeDistance` gets its own test because getting it wrong is easy and I did:
 * `LECTERN_DISTANCE` is the HORIZONTAL radius, and the drop is the other leg
 * of the triangle, so the panel is further from the eyes than that constant
 * says. Every angle computed from the radius alone is overstated.
 */
test('the distance to a panel counts the drop, not just the radius', () => {
  const { library, profile } = sceneLayout('crt', DEFAULT_SHAPE);

  // A lectern 1.06 out and 0.45 down is 1.15 away, not 1.06.
  const [x, y, z] = library.position;
  assert.ok(Math.abs(eyeDistance(library) - Math.hypot(x, y, z)) < 1e-9);
  assert.ok(
    eyeDistance(library) > Math.hypot(x, z),
    'a panel below eye level is further away than its radius'
  );

  // The band is straight ahead and well below, so its drop dominates even more.
  assert.ok(eyeDistance(profile) > 1.2);
});

test('the lecterns are wide enough in view to be read from where they sit', () => {
  const { library, friends } = sceneLayout('crt', DEFAULT_SHAPE);

  for (const [name, panel] of [['library', library], ['friends', friends]] as const) {
    assert.ok(
      angularWidth(panel) >= 40,
      `${name} spans only ${angularWidth(panel).toFixed(1)} degrees, which reads as too small`
    );
  }
});

/*
 * And the canvas has to match the headset, in both directions.
 *
 * Under the display's own figure and the canvas is the limit: the text is
 * magnified and soft, which is the trap in enlarging a panel's metres without
 * enlarging its canvas. Far over it and the pixels are drawn and thrown away -
 * which is also what made mipmaps on these panels a pure loss, since there was
 * no detail below the display's reach for them to protect.
 *
 * A band rather than a target, because neither end is a cliff.
 */
test('every panel carries about as many canvas pixels as the headset can show', () => {
  const layout = sceneLayout('crt', DEFAULT_SHAPE);
  const pairs = [
    ['library', layout.library, LIBRARY_PANEL_SIZE],
    ['friends', layout.friends, FRIENDS_PANEL_SIZE],
    ['profile', layout.profile, PROFILE_PANEL_SIZE],
    ['tablet', layout.tablet, TABLET_PANEL_SIZE]
  ] as const;

  for (const [name, placement, canvas] of pairs) {
    const ratio = pixelsPerDegree(placement, canvas) / QUEST_3_PIXELS_PER_DEGREE;
    assert.ok(
      ratio > 0.85 && ratio < 1.15,
      `${name} carries ${ratio.toFixed(3)}x the headset's pixels per degree`
    );
  }
});

/*
 * L'étendue verticale d'un panneau, tangage compris.
 *
 * Le cas de contrôle en premier, parce que c'est ce qui a manqué la première
 * fois : un panneau basculé de -90 degrés est à plat, face au ciel, donc son
 * bord « haut » est le plus ÉLOIGNÉ du joueur et se lit près de l'horizon. Une
 * version signée à l'envers passe toutes les assertions symétriques et échoue
 * uniquement celle-là - elle avait produit une marge de 8,3 degrés là où la
 * vérité est un chevauchement.
 */
test('un panneau a plat face au ciel a son bord haut au loin', () => {
  const flat = {
    position: [0, 0, -1] as [number, number, number],
    rotation: [-Math.PI / 2, 0, 0] as [number, number, number],
    width: 1,
    height: 1
  };
  const span = verticalSpan(flat);
  assert.ok(Math.abs(span.top) < 0.001, `bord haut a ${span.top.toFixed(2)} deg, attendu ~0`);
  assert.ok(Math.abs(span.bottom) < 0.001, `bord bas a ${span.bottom.toFixed(2)} deg, attendu ~0`);
});

test('sans tangage l etendue est symetrique', () => {
  const span = verticalSpan({
    position: [0, 0, -1],
    rotation: [0, 0, 0],
    width: 1,
    height: 1
  });
  assert.ok(Math.abs(span.top - 26.565) < 0.01);
  assert.ok(Math.abs(span.bottom + 26.565) < 0.01);
});

test('un tangage arriere descend le bord bas, parce qu il le rapproche', () => {
  const base = {
    position: [0, 0, -1] as [number, number, number],
    rotation: [0, 0, 0] as [number, number, number],
    width: 1,
    height: 1
  };
  const tipped = { ...base, rotation: [-Math.PI / 6, 0, 0] as [number, number, number] };
  assert.ok(
    verticalSpan(tipped).bottom < verticalSpan(base).bottom,
    'le bord bas se rapproche du joueur, donc son elevation descend'
  );
});

/*
 * Qui occulte qui, et pourquoi ce test a changé de sujet.
 *
 * La tablette est à 1,5 m et le bandeau à 1,0 m : ils peuvent se chevaucher en
 * angle sans se toucher, et le plus proche gagne. Le plus proche est le
 * BANDEAU - donc la sortie n'est jamais masquée, contrairement à ce que la
 * première version de cette conception affirmait. Ce qui est en jeu est la
 * lisibilité du bas de la tablette, où le panneau des contrôles dessine sa
 * bande de mapping fixe.
 */
test('le bandeau ne mange pas le bas de la tablette', () => {
  const { tablet, profile } = sceneLayout('crt', DEFAULT_SHAPE);

  assert.ok(
    eyeDistance(profile) < eyeDistance(tablet),
    'si le bandeau cessait d etre le plus proche, ce test protegerait le mauvais bord'
  );

  const marge = verticalSpan(tablet).bottom - verticalSpan(profile).top;
  assert.ok(
    marge > 1,
    `le bas de la tablette est a ${marge.toFixed(1)} deg du haut du bandeau, donc derriere lui`
  );
});

/*
 * L'invariance d'occlusion, désormais sur les cinquante réglages.
 *
 * C'est ce test qui a fixé la borne basse de `SCREEN_DISTANCES`. Écrit sur le
 * seul réglage livré, il passait avec 0,8 m de marge ; ouvert à la grille
 * entière il refusait 1,8 m, et c'est comme ça que le cran le plus proche est
 * devenu 2,0 m plutôt qu'un chiffre choisi à vue.
 *
 * La marge est descendue de 0,8 à 0,4 m avec cette ouverture, et c'est une
 * concession assumée : 0,8 était un choix de conception fait quand l'écran
 * était fixe, jamais mesuré, et le joueur qui rapproche volontairement son
 * écran fait ce troc lui-même. Ce que le test tient encore est qu'il reste de
 * la séparation à TOUS les crans - sans quoi la tablette cesserait de flotter
 * pour devenir un autocollant sur l'image.
 */
test('la tablette flotte devant l ecran a tous les reglages', () => {
  for (const shape of EVERY_SHAPE) {
    const { tablet, screen } = sceneLayout('crt', shape);
    const separation = screen.distance - eyeDistance(tablet);
    assert.ok(
      separation > 0.4,
      `a ${shape.distance} m il ne reste que ${separation.toFixed(2)} m de parallaxe`
    );
  }
});

test('le bandeau reste le plus proche des trois surfaces, a tous les reglages', () => {
  // L'ordre bandeau < tablette < ecran est ce qui garantit que la sortie n'est
  // jamais cachee. Un ecran rapproche ne doit pas pouvoir renverser cet ordre.
  for (const shape of EVERY_SHAPE) {
    const { tablet, profile, screen } = sceneLayout('crt', shape);
    assert.ok(eyeDistance(profile) < eyeDistance(tablet), 'le bandeau passe derriere la tablette');
    assert.ok(eyeDistance(tablet) < screen.distance, 'la tablette passe derriere l ecran');
  }
});

/*
 * Le défaut rapporté depuis le casque, et ce qui le tenait.
 *
 * « la distance ne regle pas la distance mais la hauteur, et pas en m mais en
 * cm ». La premiere version tenait la taille ANGULAIRE constante d'un cran de
 * distance a l'autre, ce qui rendait la largeur PHYSIQUE proportionnelle a la
 * distance : de 2,09 m a 4,50 m de large, et de 1,57 m a 3,38 m de haut. Vu de
 * l'origine de la session l'image ne bougeait pas d'un dixieme de degre - donc
 * le reglage ne se voyait pas - et vu d'un oeil qui n'est PAS a cette origine,
 * son seul effet visible etait une derive verticale : 3 degres pour 20 cm de
 * decalage, mesures. Un joueur ne se tient jamais exactement la ou il etait au
 * dernier recentrage.
 *
 * La taille est donc physique maintenant, nominale a 2,5 m, et la distance
 * deplace un objet de taille fixe - une television dans une piece. Ces deux
 * tests sont ce qui empeche d'y revenir.
 */
test('reculer l ecran le rapetisse, ce qui est tout ce qu on demande a ce reglage', () => {
  for (const angle of SCREEN_ANGLES) {
    for (const curved of [true, false]) {
      const angles = SCREEN_DISTANCES.map(
        (distance) => sceneLayout('crt', { distance, angle, height: 0, curved }).screen.arc
      );
      for (let i = 1; i < angles.length; i++) {
        assert.ok(
          angles[i] < angles[i - 1],
          `a ${angle} deg nominal, reculer de ${SCREEN_DISTANCES[i - 1]} a ${SCREEN_DISTANCES[i]} m ` +
            `laisse l angle a ${((angles[i] * 180) / Math.PI).toFixed(1)}° : le reglage est invisible`
        );
      }
    }
  }
});

test('la taille physique de l image ne depend pas de la distance', () => {
  // C'est la moitie du defaut qui se voyait : le bord haut montait de 90 cm en
  // metres d'un bout de l'echelle a l'autre, ce qui deplacait l'image
  // verticalement des que l'oeil n'etait pas a l'origine.
  for (const angle of SCREEN_ANGLES) {
    for (const curved of [true, false]) {
      const heights = SCREEN_DISTANCES.map(
        (distance) => sceneLayout('crt', { distance, angle, height: 0, curved }).screen.height
      );
      for (const height of heights) {
        assert.ok(
          Math.abs(height - heights[0]) < 1e-9,
          `l image mesure ${height.toFixed(2)} m de haut ici et ${heights[0].toFixed(2)} m ailleurs`
        );
      }
    }
  }
});

test('la taille nominale est la taille vue a la distance de reference', () => {
  // 2,5 m et 60 degres est ce qui a ete livre : le reglage par defaut doit
  // rendre exactement cette geometrie, sinon la mise a jour deplace l ecran de
  // tout le monde.
  const { screen } = sceneLayout('crt', DEFAULT_SHAPE);
  assert.ok(Math.abs((screen.arc * 180) / Math.PI - 60) < 1e-9);
  assert.equal(screen.distance, 2.5);
  assert.equal(screen.centerY, 0);
});

test('la hauteur deplace le centre de l image, et elle seule', () => {
  const flat = sceneLayout('crt', { ...DEFAULT_SHAPE, height: -0.4 }).screen;
  const high = sceneLayout('crt', { ...DEFAULT_SHAPE, height: 0.4 }).screen;

  assert.equal(flat.centerY, -0.4);
  assert.equal(high.centerY, 0.4);
  // Ni la distance, ni l angle, ni la taille : sinon « hauteur » serait un
  // deuxieme reglage de taille, l erreur exacte qui vient d etre corrigee.
  assert.equal(flat.distance, high.distance);
  assert.equal(flat.arc, high.arc);
  assert.equal(flat.height, high.height);
});

test('plat ou courbe, l ecran couvre le meme angle a la distance de reference', () => {
  /*
   * L'egalite exacte n'est possible qu'a une seule distance, et c'est de la
   * geometrie, pas un compromis : un arc de longueur L vu de d couvre L/d, une
   * corde de longueur L couvre 2 atan(L/2d). Deux formes de meme largeur
   * physique ne peuvent pas couvrir le meme angle partout. Chaque forme prend
   * donc la largeur qui lui fait couvrir l'angle nominal a 2,5 m, et ailleurs
   * les deux restent proches - ce qui suffit a ce que basculer reste un
   * reglage de FORME et non une seconde taille.
   */
  for (const angle of SCREEN_ANGLES) {
    const curved = sceneLayout('crt', { distance: 2.5, angle, height: 0, curved: true }).screen;
    const flat = sceneLayout('crt', { distance: 2.5, angle, height: 0, curved: false }).screen;
    assert.ok(Math.abs(curved.arc - flat.arc) < 1e-9, `a 2,5 m et ${angle} deg nominal`);
  }

  for (const distance of SCREEN_DISTANCES) {
    for (const angle of SCREEN_ANGLES) {
      const curved = sceneLayout('crt', { distance, angle, height: 0, curved: true }).screen;
      const flat = sceneLayout('crt', { distance, angle, height: 0, curved: false }).screen;
      const ecart = Math.abs(((curved.arc - flat.arc) * 180) / Math.PI);
      // 7,3 degres au pire, mesures : l ecran le plus large au cran le plus
      // proche, ou l arc atteint 100 degres et la corde sature vers 93. La
      // borne est juste au-dessus de ce pire cas, pas un chiffre rond choisi a
      // vue - c est ce qui la rend capable de voir une regression.
      assert.ok(ecart < 8, `a ${distance} m et ${angle} deg nominal, ${ecart.toFixed(1)}° d ecart`);
      assert.ok(flat.height > curved.height, 'un plat plus large est aussi plus haut, a ratio egal');
    }
  }
});

test('l image garde son ratio quelle que soit la forme', () => {
  // Un plat a qui on donnerait la largeur du courbe serait etire
  // verticalement - et ca se lit comme un bug de decodage, loin du layout.
  for (const curved of [true, false]) {
    const screen = sceneLayout('crt', { distance: 3.0, angle: 70, height: 0, curved }).screen;
    const width = curved
      ? screen.distance * screen.arc
      : 2 * screen.distance * Math.tan(screen.arc / 2);
    assert.ok(Math.abs(width / screen.height - 4 / 3) < 1e-9, `forme courbe=${curved}`);
  }
});

/** La part de l image qui depasse au-dessus de la tablette. */
function partAuDessus(shape: ScreenShape): number {
  const { tablet, screen } = sceneLayout('crt', shape);
  const image = verticalSpan({
    position: [0, screen.centerY, -screen.distance],
    rotation: [0, 0, 0],
    width: screen.distance * screen.arc,
    height: screen.height
  });
  return (image.top - verticalSpan(tablet).top) / (image.top - image.bottom);
}

/*
 * Deux bornes, et c'est la hauteur reglable qui a impose de les separer.
 *
 * Flotter devant l ecran implique d en masquer une part, et ce test bornait
 * cette part a 35 % - une valeur ecrite quand il n y avait qu une geometrie.
 * Elle ne peut pas tenir sur les 250 reglages : un petit ecran, loin et
 * descendu de 40 cm, ne laisse plus que 12 % au-dessus (mesure). Ce n est pas
 * une panne, c est le troc que le joueur vient de faire lui-meme, et la
 * rangee « Hauteur » est juste devant lui pour le defaire.
 *
 * Le reglage livre garde donc la propriete pour laquelle elle avait ete
 * ecrite, et la grille garde un plancher : il doit toujours rester de l image
 * a voir, sinon la tablette cesserait d etre une surface qui flotte devant le
 * jeu pour devenir un cache.
 */
test('au reglage livre, la moitie de l image reste au-dessus de la tablette', () => {
  assert.ok(partAuDessus(DEFAULT_SHAPE) > 0.4, `${(partAuDessus(DEFAULT_SHAPE) * 100).toFixed(0)}%`);
});

test('quel que soit le reglage, il reste de l image au-dessus de la tablette', () => {
  for (const shape of EVERY_SHAPE) {
    const reste = partAuDessus(shape);
    assert.ok(
      reste > 0.1,
      `a ${shape.distance} m / ${shape.angle} deg / ${shape.height * 100} cm il ne reste ` +
        `que ${(reste * 100).toFixed(0)}% de l image au-dessus`
    );
  }
});
