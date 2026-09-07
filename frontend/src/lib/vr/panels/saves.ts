/**
 * Les sauvegardes du jeu en cours, sur la tablette.
 *
 * Il existe parce que la VR ne savait que charger, et seulement avant de
 * lancer : l'écran de lancement liste les sauvegardes d'un jeu, et une fois la
 * partie commencée il n'y avait plus rien. Un emplacement rapide unique a été
 * essayé d'abord - deux boutons sur le bandeau, la même sentinelle que le
 * F2/F4 de la page plate - et écarté à l'usage.
 *
 * Ce module ne réinvente pas les noms. `saveIdentity` est la seule réponse à
 * « comment s'appelle cette sauvegarde » et doit le rester : la sauvegarde
 * rapide est stockée sous `__quick__`, sentinelle choisie pour qu'aucun joueur
 * ne puisse la taper, et une deuxième réponse a déjà mis ce `__quick__` sur un
 * écran incurvé. `byNewest` vient avec elle, pour la même raison que
 * `launch-options.ts` l'importe : un plafond sans ordre garderait cinq
 * sauvegardes au hasard.
 *
 * Pur, comme les autres panneaux : la mise en page rend des régions, le dessin
 * les consomme.
 */

import { fitContain, intrinsicSize, truncate, type PanelSize, type Region } from '../panel';
import { byNewest, type SaveSummary } from '$lib/saves/api';
import { saveIdentity } from '$lib/saves/identity';

export const SAVES_PANEL_SIZE: PanelSize = { width: 1024, height: 768 };

const PAD = 40;
const TITLE_Y = 56;

const ROW_X = PAD;
const ROW_Y = 112;
const ROW_W = 620;
const ROW_H = 84;
const ROW_GAP = 10;

const SHOT_MARGIN = 12;
const SHOT_W = 96;
const SHOT_H = ROW_H - SHOT_MARGIN * 2;
const TEXT_X = SHOT_MARGIN + SHOT_W + 16;

/**
 * Combien de lignes tiennent, et pourquoi il n'y a pas de scroll.
 *
 * Un plafond est la réponse honnête sur un panneau sans barre : le joueur voit
 * les plus récentes, qui sont celles qu'il veut. L'écran de lancement plafonne
 * déjà à cinq pour la même raison. Le scroll de la bibliothèque a coûté un
 * défaut réel - ses flèches recouvraient une tuile et `hit()` avalait la
 * pressée - et rien ici ne le justifie.
 */
export const SAVES_VISIBLE = 6;

const BTN_X = 700;
const BTN_W = SAVES_PANEL_SIZE.width - PAD - BTN_X;
const BTN_H = 72;
const NEW_SAVE_Y = ROW_Y;
const CLOSE_Y = ROW_Y + BTN_H + 16;

export interface SavesState {
  saves: readonly SaveSummary[];
  /** Les vignettes déjà chargées, par id de sauvegarde. */
  shots: ReadonlyMap<string, CanvasImageSource>;
  /** Pour `saveIdentity`, qui est locale-dépendante. */
  locale: string;
  /**
   * Une écriture ou un chargement est en vol.
   *
   * `awaitSave` n'attend qu'une réponse à la fois - un deuxième appel dépose
   * l'écouteur du premier - donc une deuxième pression pendant l'attente
   * perdrait silencieusement la première. Le panneau se fait donc inerte, la
   * même règle que celui des contrôles applique pendant une capture.
   */
  busy: boolean;
}

export interface SavesLabels {
  heading: string;
  newSave: string;
  close: string;
  /** Quand le jeu n'en a aucune. */
  empty: string;
  /** Passé à `saveIdentity` - voir sa note sur pourquoi il n'y est pas traduit. */
  quickSave: string;
}

export interface SavesRow {
  id: string;
  primary: string;
  secondary: string | null;
}

/** Les lignes visibles, les plus récentes d'abord et plafonnées. */
export function savesRows(state: {
  saves: readonly SaveSummary[];
  locale: string;
  quickSave?: string;
}): SavesRow[] {
  return byNewest([...state.saves])
    .slice(0, SAVES_VISIBLE)
    .map((save) => {
      const identity = saveIdentity(save, state.locale, state.quickSave);
      return { id: save.id, primary: identity.primary, secondary: identity.secondary ?? null };
    });
}

function rowAt(index: number): Omit<Region, 'id'> {
  return { x: ROW_X, y: ROW_Y + index * (ROW_H + ROW_GAP), w: ROW_W, h: ROW_H };
}

export function layoutSavesPanel(state: SavesState): Region[] {
  // Inerte pendant qu'une opération est en vol. Voir `busy`.
  if (state.busy) return [];

  const regions: Region[] = savesRows(state).map((row, index) => ({
    id: `load:${row.id}`,
    ...rowAt(index)
  }));

  // Écrire ne dépend pas d'en avoir déjà, et sortir ne dépend de rien : un
  // panneau sans sortie est un état dont personne ne ressort.
  regions.push({ id: 'new-save', x: BTN_X, y: NEW_SAVE_Y, w: BTN_W, h: BTN_H });
  regions.push({ id: 'close', x: BTN_X, y: CLOSE_Y, w: BTN_W, h: BTN_H });

  return regions;
}

function drawButton(
  ctx: CanvasRenderingContext2D,
  region: Region,
  label: string,
  hovered: boolean
): void {
  ctx.fillStyle = '#22222e';
  ctx.fillRect(region.x, region.y, region.w, region.h);
  ctx.fillStyle = '#ffffff';
  ctx.font = '600 24px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(
    truncate(ctx, label, region.w - 20),
    region.x + region.w / 2,
    region.y + region.h / 2
  );
  if (hovered) {
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 3;
    ctx.strokeRect(region.x - 4, region.y - 4, region.w + 8, region.h + 8);
  }
}

export function drawSavesPanel(
  ctx: CanvasRenderingContext2D,
  state: SavesState,
  regions: readonly Region[],
  labels: SavesLabels,
  hoverId: string | null = null
): void {
  const { width, height } = SAVES_PANEL_SIZE;
  const byId = new Map(regions.map((r) => [r.id, r]));

  ctx.save();
  /*
   * Le bon filtre de réduction, la même raison que sur les deux autres
   * panneaux qui portent des images : à la qualité par défaut le navigateur
   * échantillonne ponctuellement la réduction et cuit l'aliasing dans le
   * canvas, avant que three ne le voie.
   */
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#101018';
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = '#ffffff';
  ctx.font = '600 34px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(labels.heading, PAD, TITLE_Y);

  const rows = savesRows({ ...state, quickSave: labels.quickSave });

  if (rows.length === 0) {
    // Un panneau vide se lit comme un panneau qui n'a pas chargé.
    ctx.textAlign = 'left';
    ctx.font = '24px system-ui, sans-serif';
    ctx.fillStyle = '#a0a0b0';
    ctx.fillText(truncate(ctx, labels.empty, ROW_W), ROW_X, ROW_Y + ROW_H / 2);
  }

  // Dessinées depuis les lignes et non depuis les régions : il n'y a aucune
  // région pendant qu'une opération est en vol, et c'est précisément là qu'il
  // faut encore voir ce qu'on a.
  rows.forEach((row, index) => {
    const region = byId.get(`load:${row.id}`) ?? { id: '', ...rowAt(index) };

    ctx.fillStyle = '#1c1c26';
    ctx.fillRect(region.x, region.y, region.w, region.h);

    const shotBox = {
      x: region.x + SHOT_MARGIN,
      y: region.y + SHOT_MARGIN,
      w: SHOT_W,
      h: SHOT_H
    };
    // Le puits est dessiné avant l'image, comme sur l'écran de lancement :
    // sinon la ligne change de forme quand la vignette arrive.
    ctx.fillStyle = '#141420';
    ctx.fillRect(shotBox.x, shotBox.y, shotBox.w, shotBox.h);

    const shot = state.shots.get(row.id);
    if (shot) {
      // Ses propres proportions dans le puits : une image SNES fait 256 x 224
      // et le puits est plus large, donc lui passer le puits l'étirerait.
      const fitted = fitContain(intrinsicSize(shot), shotBox);
      ctx.drawImage(shot, fitted.x, fitted.y, fitted.w, fitted.h);
    }

    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const textW = region.w - TEXT_X - 16;
    const single = row.secondary === null;

    ctx.fillStyle = '#ffffff';
    ctx.font = '600 24px system-ui, sans-serif';
    ctx.fillText(
      truncate(ctx, row.primary, textW),
      region.x + TEXT_X,
      single ? region.y + region.h / 2 : region.y + region.h / 2 - 14
    );

    if (row.secondary !== null) {
      ctx.fillStyle = '#9a9aac';
      ctx.font = '20px system-ui, sans-serif';
      ctx.fillText(truncate(ctx, row.secondary, textW), region.x + TEXT_X, region.y + region.h / 2 + 16);
    }

    if (hoverId === `load:${row.id}`) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 3;
      ctx.strokeRect(region.x - 3, region.y - 3, region.w + 6, region.h + 6);
    }
  });

  const newSave = byId.get('new-save');
  if (newSave) drawButton(ctx, newSave, labels.newSave, hoverId === 'new-save');
  const close = byId.get('close');
  if (close) drawButton(ctx, close, labels.close, hoverId === 'close');

  ctx.restore();
}
