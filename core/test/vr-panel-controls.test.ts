/**
 * Le panneau de remap, sur l'écran courbe.
 *
 * Deux règles portantes, toutes deux héritées de pannes réelles ailleurs dans
 * ce dossier.
 *
 * La ligne qui écoute est marquée par autre chose qu'une couleur : deux états
 * ne différant que par un remplissage produisent un jeu de `fillText`
 * identique, et le test « l'état est visible » n'aurait rien à comparer -
 * exactement le piège où étaient tombées les cartes de preset du pupitre.
 *
 * Les entrées non assignables sont nommées quelque part. Un joueur qui ne voit
 * la croix ni le menu nulle part les croit cassées, et la seule chose qu'il
 * puisse en conclure est que le remap les a mangées.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import {
  CONTROLS_PANEL_SIZE,
  layoutControlsPanel,
  drawControlsPanel,
  type ControlsLabels,
  type ControlsState
} from '../../frontend/src/lib/vr/panels/controls.js';
import { VR_BUTTONS, LETTERS_MAP, assignInput } from '../../frontend/src/lib/vr/pad-map.js';

const LABELS: ControlsLabels = {
  heading: 'Contrôles',
  // La formulation expédiée, pas un bouchon : le test de largeur ci-dessous
  // mesure cette chaîne, et un remplaçant court passerait une vérification que
  // le vrai libellé pourrait échouer.
  press: 'Pressez un bouton — clic du stick droit pour annuler',
  done: 'Retour',
  bindAll: 'Tout configurer',
  restoreDefaults: 'Restaurer les boutons par défaut',
  fixedDpad: 'Croix directionnelle : les deux sticks',
  fixedMenu: 'Menu : clic du stick droit',
  fixedTurbo: 'Accéléré : maintenir le clic du stick gauche',
  langEn: 'English',
  langFr: 'Français',
  button: { a: 'A', b: 'B', x: 'X', y: 'Y', l: 'L', r: 'R', start: 'START', select: 'SELECT' },
  input: {
    XrLeftTrigger: 'Gauche — gâchette',
    XrRightTrigger: 'Droite — gâchette',
    XrLeftSqueeze: 'Gauche — grip',
    XrRightSqueeze: 'Droite — grip',
    XrLeftFaceUpper: 'Gauche — bouton haut',
    XrRightFaceUpper: 'Droite — bouton haut',
    XrLeftFaceLower: 'Gauche — bouton bas',
    XrRightFaceLower: 'Droite — bouton bas',
    XrLeftStickClick: 'Gauche — clic du stick'
  }
};

function state(over: Partial<ControlsState> = {}): ControlsState {
  return { map: LETTERS_MAP, listeningFor: null, language: 'fr', ...over };
}

function recordingContext() {
  const texts: string[] = [];
  const calls: string[] = [];
  const placed: Array<{ text: string; x: number; y: number }> = [];
  /** Le fond de chaque rectangle : c'est par là que passe tout marquage
   *  d'état, donc c'est ce qu'un test de marquage doit regarder. */
  const fills: Array<{ style: string; x: number; y: number }> = [];
  return {
    texts, calls, placed, fills,
    font: '', fillStyle: '', strokeStyle: '', lineWidth: 0,
    textAlign: 'left', textBaseline: 'alphabetic',
    save() {}, restore() {}, clearRect() {},
    fillRect(x: number, y: number) {
      calls.push('fillRect');
      fills.push({ style: String(this.fillStyle), x, y });
    },
    strokeRect() { calls.push('strokeRect'); },
    beginPath() {}, arc() { calls.push('arc'); }, fill() { calls.push('fill'); }, stroke() { calls.push('stroke'); },
    // Le dessin de la manette trace des rectangles arrondis.
    moveTo() {}, lineTo() {}, arcTo() {}, closePath() {},
    drawImage() { calls.push('drawImage'); },
    fillText(text: string, x: number, y: number) {
      texts.push(text);
      calls.push(`fillText:${text}`);
      placed.push({ text, x, y });
    },
    measureText(text: string) { return { width: text.length * 9 }; }
  } as unknown as CanvasRenderingContext2D & {
    texts: string[];
    calls: string[];
    placed: Array<{ text: string; x: number; y: number }>;
    fills: Array<{ style: string; x: number; y: number }>;
  };
}

function draw(s: ControlsState, hoverId: string | null = null) {
  const ctx = recordingContext();
  drawControlsPanel(ctx, s, layoutControlsPanel(s), { labels: LABELS, hoverId });
  return ctx;
}

test('les huit boutons ont chacun leur région', () => {
  const ids = layoutControlsPanel(state()).map((r) => r.id);
  for (const button of ['a', 'b', 'x', 'y', 'l', 'r', 'start', 'select']) {
    assert.ok(ids.includes(`bind:${button}`), `${button} n'est pas cliquable`);
  }
});

/*
 * Un seul préréglage, sans nom.
 *
 * Il y en avait deux, chacun avec un schéma de manette, parce que ce panneau
 * était le seul endroit qui montrait quel bouton Touch portait quel bouton
 * SNES. Le dessin le montre maintenant en entier, donc la carte n'avait plus
 * rien à expliquer et le second préréglage plus rien à départager.
 */
test('le retour au defaut est offert, et il est seul', () => {
  const ids = layoutControlsPanel(state()).map((r) => r.id);
  assert.ok(ids.includes('restore-defaults'));
  assert.equal(ids.filter((id) => id.startsWith('preset:')).length, 0);
  assert.ok(draw(state()).texts.includes(LABELS.restoreDefaults));
});

test('chaque ligne nomme son bouton et l entrée qui le porte', () => {
  const drawn = draw(state()).texts.join('\n');
  assert.ok(drawn.includes('START'), "le bouton START n'est pas nommé");
  assert.ok(
    drawn.includes(LABELS.input[LETTERS_MAP.start]),
    "l'entrée qui porte START n'est pas nommée"
  );
});

test('la ligne qui écoute est marquée autrement que par une couleur', () => {
  const idle = draw(state()).calls;
  const listening = draw(state({ listeningFor: 'a' })).calls;
  assert.notDeepEqual(idle, listening, "rien sur le canvas ne dit qu'une ligne écoute");
});

test('l invite d annulation est dite pendant la capture, et pas avant', () => {
  // Sans elle, un joueur qui a ouvert une capture par erreur n'a aucun moyen de
  // savoir qu'il peut en sortir : tous les autres boutons sont capturables.
  assert.ok(!draw(state()).texts.includes(LABELS.press));
  assert.ok(draw(state({ listeningFor: 'a' })).texts.includes(LABELS.press));
});

test('aucune ligne n est cliquable pendant une capture', () => {
  // Sinon la pression qui lie A peut aussi être lue comme un clic sur B.
  const ids = layoutControlsPanel(state({ listeningFor: 'a' })).map((r) => r.id);
  assert.deepEqual(ids, [], 'le panneau reste cliquable pendant la capture');
});

test('les huit lignes restent dessinées pendant une capture', () => {
  // Elles n'ont plus de région, mais un panneau qui se vide pendant la capture
  // laisserait le joueur sans rien à quoi rapporter le bouton qu'il presse.
  const drawn = draw(state({ listeningFor: 'a' })).texts.join('\n');
  for (const label of ['A', 'B', 'X', 'Y', 'L', 'R', 'START', 'SELECT']) {
    assert.ok(drawn.includes(label), `${label} a disparu pendant la capture`);
  }
});

test('les entrées non assignables sont nommées', () => {
  const drawn = draw(state()).texts.join('\n');
  assert.ok(drawn.includes(LABELS.fixedDpad), "la croix n'est expliquée nulle part");
  assert.ok(drawn.includes(LABELS.fixedMenu), "le menu n'est expliqué nulle part");
});

test('l accéléré est nommé, et seulement tant que son entrée est libre', () => {
  // Le geste ne s'écrit nulle part ailleurs : ni bouton, ni ligne de légende,
  // ni région. Sans cette ligne, un joueur ne peut que le découvrir par
  // accident - et un joueur qui a remappé le clic gauche découvrirait à la
  // place un raccourci annoncé qui ne répond plus.
  const free = draw(state()).texts.join('\n');
  assert.ok(free.includes(LABELS.fixedTurbo), "l'accéléré n'est expliqué nulle part");

  const claimed = draw(state({ map: assignInput(LETTERS_MAP, 'start', 'XrLeftStickClick') }));
  assert.ok(
    !claimed.texts.join('\n').includes(LABELS.fixedTurbo),
    "l'accéléré est annoncé alors qu'un bouton a pris son entrée"
  );
});

test('les deux lignes hors modèle ne bougent pas quand la troisième disparaît', () => {
  // Le bloc est ancré par le haut justement pour ça : un remap sans rapport ne
  // doit pas réagencer le panneau sous le regard du joueur.
  const at = (shot: ReturnType<typeof draw>, text: string) =>
    shot.placed.find((p) => p.text === text)?.y;

  const free = draw(state());
  const claimed = draw(state({ map: assignInput(LETTERS_MAP, 'start', 'XrLeftStickClick') }));

  for (const label of [LABELS.fixedDpad, LABELS.fixedMenu]) {
    assert.equal(at(free, label), at(claimed, label), `${label} a bougé`);
  }
});

test('une map remappée est ce qui est dessiné, pas le preset', () => {
  const custom = assignInput(LETTERS_MAP, 'a', 'XrLeftStickClick');
  const drawn = draw(state({ map: custom })).texts.join('\n');
  assert.ok(drawn.includes(LABELS.input.XrLeftStickClick), "le remap n'est pas montré");
});

/*
 * Le survol se voit sur le dessin, pas sur une ligne.
 *
 * Les huit lignes cliquables sont devenues la manette, et le survol y trace un
 * contour - un cercle pour les boutons de face, un rectangle pour les
 * gâchettes et les pastilles. Sans ce test, tout le bloc de survol de
 * `pad-art.ts` pourrait disparaître sans que rien ne le remarque.
 */
test('un bouton survole sur le dessin est entoure', () => {
  const plain = draw(state()).calls;
  const onFace = draw(state(), 'bind:a').calls;
  const onShoulder = draw(state(), 'bind:l').calls;

  const strokes = (calls: string[]) => calls.filter((c) => c === 'strokeRect').length;
  assert.ok(
    strokes(onShoulder) > strokes(plain),
    'le survol d une gachette ne se voit pas'
  );
  // Un bouton de face est un cercle : son contour passe par stroke(), pas par
  // strokeRect(), donc c'est le nombre d'appels total qui bouge.
  assert.ok(onFace.length > plain.length, 'le survol d un bouton de face ne se voit pas');
});

/*
 * La légende contient le plus long libellé expédié, en entier.
 *
 * Elle n'existe que parce que les noms d'entrées ne tiennent pas sur un bouton
 * de la manette dessinée - « Droite — gâchette » sur 24 px de cercle. Une
 * légende tronquée aurait donc perdu sa seule raison d'être, et la colonne a
 * été élargie contre le dessin plutôt que l'inverse.
 *
 * Ne mesure que les textes de la légende, alignés à gauche : les boutons de
 * langue à côté sont centrés et déjà bornés par leur propre région, et les
 * confondre faisait échouer ce test sur un libellé parfaitement placé.
 */
test('la legende contient le plus long libelle d entree sans le couper', () => {
  const longest = Object.values(LABELS.input).reduce((a, b) => (a.length > b.length ? a : b));
  const custom = assignInput(
    LETTERS_MAP,
    'a',
    (Object.keys(LABELS.input) as Array<keyof typeof LABELS.input>).find(
      (k) => LABELS.input[k] === longest
    )!
  );
  const ctx = draw(state({ map: custom }));
  assert.ok(
    ctx.texts.includes(longest),
    `"${longest}" est coupe dans la legende - elargir la colonne, pas raccourcir le nom`
  );
});

test('aucun texte de la legende ne deborde du panneau', () => {
  const RIGHT_EDGE = 1024 - 40;
  // Les deux colonnes de la légende, alignées à gauche.
  const LEGEND_COLUMNS = [656, 656 + 88];
  for (const listeningFor of [null, 'a'] as const) {
    const ctx = draw(state({ listeningFor }));
    for (const drawn of ctx.placed) {
      if (!LEGEND_COLUMNS.includes(drawn.x)) continue;
      assert.ok(
        drawn.x + drawn.text.length * 9 <= RIGHT_EDGE,
        `"${drawn.text}" atteint ${drawn.x + drawn.text.length * 9}px, le panneau finit a ${RIGHT_EDGE}px`
      );
    }
  }
});

test('le dessin porte les huit boutons, et la legende les nomme tous', () => {
  const ctx = draw(state());
  for (const button of VR_BUTTONS) {
    assert.ok(
      ctx.texts.includes(LABELS.button[button]),
      `${button} n est nomme nulle part dans la legende`
    );
  }
});

test('tout configurer est offert, et nomme', () => {
  const ids = layoutControlsPanel(state()).map((r) => r.id);
  assert.ok(ids.includes('bind-all'));
  assert.ok(draw(state()).texts.includes(LABELS.bindAll));
});

test('tout configurer disparait pendant une capture, comme le reste', () => {
  // Une capture attend une pression physique : toute région encore là la
  // volerait.
  const ids = layoutControlsPanel(state({ listeningFor: 'a' })).map((r) => r.id);
  assert.equal(ids.length, 0);
});

test('aucune région ne sort du panneau ni n en chevauche une autre', () => {
  for (const listeningFor of [null, 'a', 'select'] as const) {
    const regions = layoutControlsPanel(state({ listeningFor }));
    for (const r of regions) {
      assert.ok(r.x >= 0 && r.y >= 0, `${r.id} commence hors panneau`);
      assert.ok(r.x + r.w <= CONTROLS_PANEL_SIZE.width, `${r.id} déborde à droite`);
      assert.ok(r.y + r.h <= CONTROLS_PANEL_SIZE.height, `${r.id} déborde en bas`);
    }
    for (let i = 0; i < regions.length; i++) {
      for (let j = i + 1; j < regions.length; j++) {
        const a = regions[i];
        const b = regions[j];
        const apart =
          a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
        assert.ok(apart, `${a.id} chevauche ${b.id}`);
      }
    }
  }
});

test('le panneau porte de quoi en sortir', () => {
  /*
   * Sans ça le panneau est un cul-de-sac.
   *
   * Le clic du stick droit rappelle les panneaux, il ne rend pas l'écran ; le
   * pupitre n'offre « Retour au jeu » que pendant une partie. Un joueur qui
   * ouvre le remap sans jeu en cours n'avait donc plus aucun moyen de revenir
   * aux options de lancement - l'écran courbe gardait le remap pour le reste
   * de la session.
   */
  const ids = layoutControlsPanel(state()).map((r) => r.id);
  assert.ok(ids.includes('close'), 'aucune sortie depuis le panneau de remap');
});

test('la sortie est nommée', () => {
  assert.ok(draw(state()).texts.includes(LABELS.done), 'la sortie est sans libellé');
});

test('la sortie disparaît pendant une capture, comme tout le reste', () => {
  // Elle est capturable comme les autres boutons : la laisser cliquable
  // pendant l'écoute ferait d'une pression un clic autant qu'une liaison.
  const ids = layoutControlsPanel(state({ listeningFor: 'a' })).map((r) => r.id);
  assert.ok(!ids.includes('close'));
});

/*
 * La langue, arrivée du bandeau.
 *
 * `panels/profile.ts` était un mélange de réglages et de raccourcis ; il est
 * devenu un lanceur, et les réglages sont montés ici, sur le panneau qui a la
 * place. Deux boutons plutôt qu'une bascule : il y a exactement deux langues,
 * et une bascule demanderait au joueur de deviner laquelle est active.
 */
test('les deux langues sont offertes, et il y en a exactement deux', () => {
  const ids = layoutControlsPanel(state()).map((r) => r.id);
  assert.ok(ids.includes('lang:en'));
  assert.ok(ids.includes('lang:fr'));
  assert.equal(ids.filter((id) => id.startsWith('lang:')).length, 2);
});

test('la langue courante est marquée, sinon le joueur ne sait pas laquelle il a', () => {
  const en = draw(state({ language: 'en' }));
  const fr = draw(state({ language: 'fr' }));
  // Le marquage passe par un fond, pas par un texte : ce qui doit différer,
  // c'est le dessin, et les deux états dessinent les mêmes `fillText`.
  assert.notDeepEqual(en.fills, fr.fills, 'les deux langues se dessinent à l identique');
});

test('les deux langues sont nommées', () => {
  const ctx = draw(state());
  assert.ok(ctx.texts.includes(LABELS.langEn));
  assert.ok(ctx.texts.includes(LABELS.langFr));
});

test('les langues disparaissent pendant une capture, comme tout le reste', () => {
  // Une capture attend une pression physique : toute région encore présente
  // volerait celle-là.
  const ids = layoutControlsPanel(state({ listeningFor: 'a' })).map((r) => r.id);
  assert.equal(ids.filter((id) => id.startsWith('lang:')).length, 0);
});
