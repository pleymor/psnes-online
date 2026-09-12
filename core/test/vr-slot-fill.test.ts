/**
 * Combler les trous d'un calque avec ce qu'on y a déjà vu.
 *
 * Ces tests portent sur les décisions que ce module prend TOUT SEUL, et qu'on
 * ne peut donc pas juger derrière un `WebGLRenderer` : quels calques méritent
 * une mémoire, quand elle est jetée, et - la seule qui compte vraiment - qu'un
 * pixel jamais vu ne soit JAMAIS servi comme s'il était connu. Ce dernier
 * point est la différence entre « approximatif » et « faux sans le savoir ».
 */
import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { createSlotFiller, backgroundOfSlot } from '../../frontend/src/lib/vr/slot-fill.js';
import { VR_SLOT_KEYS } from '../../frontend/src/lib/vr/layer-map.js';

const W = 4;
const H = 2;

/** Une image unie, et un masque qui donne tout l'écran à un seul calque. */
function frame(slot: number, grey: number) {
  const picture = new Uint8ClampedArray(W * H * 4).fill(grey);
  const mask = new Uint8Array(W * H).fill(slot);
  return { picture, mask };
}

const NO_SCROLL = new Uint16Array(8);

test('seuls les fonds ont une mémoire, pas les sprites ni la toile de fond', () => {
  /*
   * La règle qui évite le pire contresens possible. Un plan de sprites est
   * troué PARTOUT où il n'y a pas de sprite, et c'est normal - c'est sa
   * transparence. Le combler peindrait un aplat opaque en travers de l'image.
   * Et la toile de fond n'a pas de défilement du tout : rien à recaler.
   */
  assert.equal(backgroundOfSlot(VR_SLOT_KEYS.indexOf('sprite')), -1);
  assert.equal(backgroundOfSlot(VR_SLOT_KEYS.indexOf('backdrop')), -1);
  assert.equal(backgroundOfSlot(VR_SLOT_KEYS.indexOf('bg1.lo')), 0);
  assert.equal(backgroundOfSlot(VR_SLOT_KEYS.indexOf('bg1.hi')), 0);
  assert.equal(backgroundOfSlot(VR_SLOT_KEYS.indexOf('bg3.hi')), 2);
  assert.equal(backgroundOfSlot(VR_SLOT_KEYS.indexOf('bg4.lo')), 3);
});

test('un calque sans mémoire n_a pas de couche dans l_atlas', () => {
  const filler = createSlotFiller();
  const bg2 = VR_SLOT_KEYS.indexOf('bg2.lo');
  const sprite = VR_SLOT_KEYS.indexOf('sprite');
  const { picture, mask } = frame(bg2, 90);

  const fill = filler.build(picture, mask, (1 << bg2) | (1 << sprite), W, H, W, NO_SCROLL);

  assert.equal(fill.layers, 1, 'un seul fond présent, donc une seule couche');
  assert.ok(fill.layerOf[bg2] >= 0, 'le fond doit en avoir une');
  assert.equal(fill.layerOf[sprite], -1, 'les sprites ne doivent pas en avoir');
});

test('un pixel jamais vu reste transparent, il n_est jamais servi comme du noir', () => {
  /*
   * LE test de ce module. Servir un pixel inconnu comme du noir opaque
   * remplacerait le trou par la même couleur, mais en la faisant passer pour
   * une mesure - donc en la rendant invisible au verdict et impossible à
   * diagnostiquer.
   */
  const filler = createSlotFiller();
  const bg2 = VR_SLOT_KEYS.indexOf('bg2.lo');
  const picture = new Uint8ClampedArray(W * H * 4).fill(120);
  const mask = new Uint8Array(W * H).fill(255);
  mask[0] = bg2;

  const fill = filler.build(picture, mask, 1 << bg2, W, H, W, NO_SCROLL);

  const layer = fill.layerOf[bg2] * W * H * 4;
  assert.equal(fill.data[layer + 3], 255, 'le pixel gagné est connu');
  for (let i = 1; i < W * H; i++) {
    assert.equal(fill.data[layer + i * 4 + 3], 0, `le pixel ${i} n_a jamais été vu`);
  }
});

test('ce qu_un calque a montré survit à l_image où il le perd', () => {
  /*
   * La promesse entière, en un test. Le calque gagne tout l'écran, puis un
   * sprite lui prend un pixel : la couleur d'avant doit rester disponible,
   * sinon il n'y a rien à mettre dans le trou.
   */
  const filler = createSlotFiller();
  const bg2 = VR_SLOT_KEYS.indexOf('bg2.lo');
  const sprite = VR_SLOT_KEYS.indexOf('sprite');
  const first = frame(bg2, 77);
  filler.build(first.picture, first.mask, 1 << bg2, W, H, W, NO_SCROLL);

  const second = frame(bg2, 77);
  second.mask[2] = sprite;
  second.picture[2 * 4] = 250;
  const fill = filler.build(second.picture, second.mask, (1 << bg2) | (1 << sprite), W, H, W, NO_SCROLL);

  const layer = fill.layerOf[bg2] * W * H * 4;
  assert.equal(fill.data[layer + 2 * 4 + 3], 255, 'le pixel caché reste connu');
  assert.equal(fill.data[layer + 2 * 4], 77, 'et garde la couleur du FOND, pas celle du sprite');
});

test('une mémoire dont la prédiction est fausse est jetée', () => {
  /*
   * Le HDMA change le défilement par ligne, et le cœur n'en rend qu'un par
   * image : sur ces images-là, la mémoire ment. Ce qui rend l'approche tenable
   * n'est pas qu'elle ait toujours raison, c'est qu'elle sache quand elle a
   * tort.
   */
  const filler = createSlotFiller();
  const bg2 = VR_SLOT_KEYS.indexOf('bg2.lo');
  const dark = frame(bg2, 10);
  filler.build(dark.picture, dark.mask, 1 << bg2, W, H, W, NO_SCROLL);

  const bright = frame(bg2, 240);
  const fill = filler.build(bright.picture, bright.mask, 1 << bg2, W, H, W, NO_SCROLL);

  assert.ok(!fill.trusted[bg2], 'le verdict doit être défavorable');
  const layer = fill.layerOf[bg2] * W * H * 4;
  // Jetée, puis réapprise dans la même passe : les pixels gagnés cette image
  // sont connus, et ils portent la NOUVELLE couleur.
  assert.equal(fill.data[layer + 3], 255);
  assert.equal(fill.data[layer], 240);
});

test('le défilement recale la mémoire, dans le sens opposé', () => {
  const filler = createSlotFiller();
  const bg2 = VR_SLOT_KEYS.indexOf('bg2.lo');
  const first = frame(bg2, 50);
  // Un seul pixel distinct, pour pouvoir le suivre.
  first.picture[1 * 4] = 200;
  filler.build(first.picture, first.mask, 1 << bg2, W, H, W, NO_SCROLL);

  /*
   * BG2 défile d'un pixel vers la droite : la mémoire doit glisser à gauche.
   *
   * BG2 est `PPU.BG[1]`, donc la PAIRE 1, donc l'indice 2. Le « 2 » du nom et
   * l'indice du tableau ne sont pas le même nombre, et écrire `scroll[2 * 2]`
   * ici décale le défilement d'un fond - un défaut qui se lit comme un calque
   * qui refuse de se recaler pendant qu'un autre le fait deux fois.
   */
  const scroll = new Uint16Array(8);
  scroll[1 * 2] = 1;
  const second = frame(bg2, 50);
  second.mask.fill(255);
  const fill = filler.build(second.picture, second.mask, 1 << bg2, W, H, W, scroll);

  const layer = fill.layerOf[bg2] * W * H * 4;
  assert.equal(fill.data[layer + 0 * 4], 200, 'le pixel doit avoir glissé en 0');
  assert.equal(fill.data[layer + 3 * 4 + 3], 0, 'et le bord entrant être inconnu');
});

test('changer de forme d_image repart d_une mémoire vierge', () => {
  // Une mémoire de 256 de large recalée sur une image de 512 servirait des
  // morceaux de l'ancienne résolution, décalés - le genre de défaut qu'on
  // attribuerait au jeu plutôt qu'à ce fichier.
  const filler = createSlotFiller();
  const bg2 = VR_SLOT_KEYS.indexOf('bg2.lo');
  const first = frame(bg2, 60);
  filler.build(first.picture, first.mask, 1 << bg2, W, H, W, NO_SCROLL);

  const wide = new Uint8ClampedArray(8 * H * 4).fill(60);
  const wideMask = new Uint8Array(8 * H).fill(255);
  const fill = filler.build(wide, wideMask, 1 << bg2, 8, H, 8, NO_SCROLL);

  const layer = fill.layerOf[bg2] * 8 * H * 4;
  for (let i = 0; i < 8 * H; i++) {
    assert.equal(fill.data[layer + i * 4 + 3], 0, `le pixel ${i} doit être vierge`);
  }
});

test('jeter une mémoire efface VRAIMENT ce qu_elle croyait savoir', () => {
  /*
   * Le test précédent ne suffisait pas, et le mutant l'a montré : quand le
   * calque possède tout l'écran, il réapprend dans la même passe exactement ce
   * qu'il vient d'oublier, donc supprimer l'oubli ne change rien d'observable.
   * Ici il ne regagne qu_un pixel, et les sept autres doivent redevenir
   * inconnus - sinon une mémoire jugée menteuse continuerait de servir.
   */
  const filler = createSlotFiller();
  const bg2 = VR_SLOT_KEYS.indexOf('bg2.lo');
  const first = frame(bg2, 10);
  filler.build(first.picture, first.mask, 1 << bg2, W, H, W, NO_SCROLL);

  const second = frame(bg2, 240);
  second.mask.fill(255);
  second.mask[0] = bg2;
  const fill = filler.build(second.picture, second.mask, 1 << bg2, W, H, W, NO_SCROLL);

  assert.ok(!fill.trusted[bg2], 'un pixel sur un qui diverge, c_est un mensonge');
  const layer = fill.layerOf[bg2] * W * H * 4;
  assert.equal(fill.data[layer + 3], 255, 'le pixel regagné est connu');
  for (let i = 1; i < W * H; i++) {
    assert.equal(fill.data[layer + i * 4 + 3], 0, `le pixel ${i} devait être oublié`);
  }
});

test('un calque entièrement caché garde sa mémoire', () => {
  /*
   * Le cas où la mémoire sert le PLUS, et celui qu'un verdict trop zélé
   * détruirait : ne rien pouvoir vérifier n'est pas une raison de jeter. Sans
   * cette exception, un fond passant derrière un sprite plein écran perdrait
   * tout juste au moment où on a besoin de lui, et il n'y aurait jamais de
   * mémoire du tout.
   */
  const filler = createSlotFiller();
  const bg2 = VR_SLOT_KEYS.indexOf('bg2.lo');
  const first = frame(bg2, 50);
  filler.build(first.picture, first.mask, 1 << bg2, W, H, W, NO_SCROLL);

  const second = frame(bg2, 50);
  second.mask.fill(255);
  const fill = filler.build(second.picture, second.mask, 1 << bg2, W, H, W, NO_SCROLL);

  const layer = fill.layerOf[bg2] * W * H * 4;
  for (let i = 0; i < W * H; i++) {
    assert.equal(fill.data[layer + i * 4 + 3], 255, `le pixel ${i} doit rester connu`);
    assert.equal(fill.data[layer + i * 4], 50, `et garder sa couleur`);
  }
});
