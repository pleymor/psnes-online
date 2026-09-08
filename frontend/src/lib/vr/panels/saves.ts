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
import { SMW, EDGE, LINER, drawField, statusBox, slot, chromeButton } from './chrome';

export const SAVES_PANEL_SIZE: PanelSize = { width: 1024, height: 768 };

const PAD = 40;
const TITLE_Y = 56;

/*
 * Des lignes pleine largeur, hautes, et quatre au lieu de six.
 *
 * Trois contraintes qui se tiennent l'une l'autre. La vignette ne peut pas
 * dépasser la hauteur de sa ligne ; les deux boutons de ligne veulent être
 * aussi hauts qu'elle pour être visables ; et la somme des lignes plus la
 * barre du bas doit tenir dans 768 px. Une ligne de 84 px - ce qu'elles
 * faisaient - donne une vignette de 60 px de haut, soit 2,4 degrés dans le
 * casque : un timbre. À 132 px, elle en fait 4 - et il ne rentre plus que
 * quatre lignes.
 *
 * Le plafond passe donc de six à quatre, et c'est le troc assumé : quatre
 * sauvegardes qu'on reconnaît valent mieux que six qu'on devine. L'écran de
 * lancement en montre cinq de son côté, et il n'y a de scroll ni ici ni
 * là-bas - un plafond reste la réponse honnête sur un panneau sans barre.
 */
const ROW_X = PAD;
const ROW_Y = 96;
/** La zone qui charge : la vignette et le nom. Les deux boutons sont à côté. */
const ROW_W = 560;
const ROW_H = 132;
const ROW_GAP = 12;

const OVER_X = 620;
const OVER_W = 170;
const DELETE_X = 810;
const DELETE_W = SAVES_PANEL_SIZE.width - PAD - DELETE_X;

/** La question, sur la ligne : deux réponses là où étaient les deux gestes. */
const YES_W = 100;
const NO_W = 100;

const SHOT_MARGIN = 8;
const SHOT_H = ROW_H - SHOT_MARGIN * 2;
/**
 * Le puits au ratio d'une image SNES, pas un rectangle choisi à vue.
 *
 * Il mesurait 96 x 60 pour des images de 256 x 224. `fitContain` ajuste alors
 * sur la hauteur, donc la vignette dessinée faisait 68 x 60 et 28 px de puits
 * restaient vides - un tiers de la boîte perdu sans que rien ne le dise. Le
 * ratio est calculé, plus tapé : 8/7 de la hauteur intérieure, cadre compris.
 */
const SHOT_W = Math.round((SHOT_H - (EDGE + LINER) * 2) * (256 / 224)) + (EDGE + LINER) * 2;
const TEXT_X = SHOT_MARGIN + SHOT_W + 16;

/**
 * Combien de lignes tiennent, et pourquoi il n'y a pas de scroll.
 *
 * Un plafond est la réponse honnête sur un panneau sans barre : le joueur voit
 * les plus récentes, qui sont celles qu'il veut. L'écran de lancement plafonne
 * déjà à cinq pour la même raison. Le scroll de la bibliothèque a coûté un
 * défaut réel - ses flèches recouvraient une tuile et `hit()` avalait la
 * pressée - et rien ici ne le justifie.
 *
 * Quatre, et pas six : la hauteur des lignes est ce qui décide de la taille
 * des vignettes, et six timbres valent moins que quatre images qu'on
 * reconnaît. Voir `ROW_H`.
 */
export const SAVES_VISIBLE = 4;

/*
 * Créer et sortir, en bas plutôt qu'en colonne de droite.
 *
 * La colonne de droite est passée aux deux boutons de ligne : c'est là que le
 * doigt va chercher ce qui agit sur UNE sauvegarde. Ce qui agit sur le panneau
 * descend donc en barre, sous les lignes.
 */
const BTN_H = 76;
const BAR_Y = 676;
const NEW_SAVE_X = PAD;
const NEW_SAVE_W = 460;
const CLOSE_X = 520;
const CLOSE_W = SAVES_PANEL_SIZE.width - PAD - CLOSE_X;

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
  /**
   * L'id de la sauvegarde dont la suppression est en train d'être demandée.
   *
   * Sur la ligne plutôt que dans une modale : la question remplace les deux
   * boutons de cette ligne, le nom reste lisible à côté - c'est la seule chose
   * qui dit laquelle on est en train de perdre - et le reste du panneau
   * continue de fonctionner.
   */
  confirming: string | null;
}

export interface SavesLabels {
  heading: string;
  newSave: string;
  close: string;
  /** Quand le jeu n'en a aucune. */
  empty: string;
  /** Passé à `saveIdentity` - voir sa note sur pourquoi il n'y est pas traduit. */
  quickSave: string;
  /** Réécrit la sauvegarde de cette ligne avec l'état courant. */
  overwrite: string;
  /** `remove` et non `delete`, qui est un mot réservé. */
  remove: string;
  /** La question, posée sur la ligne à la place de sa date. */
  confirmRemove: string;
  yes: string;
  no: string;
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

  const regions: Region[] = [];

  savesRows(state).forEach((row, index) => {
    const box = rowAt(index);
    const asked = state.confirming === row.id;

    /*
     * La ligne interrogée ne se charge plus.
     *
     * Ce n'est pas de la cohérence d'affichage, c'est la garde qui compte : un
     * pointeur laser tenu à bout de bras dérape, et une pressée qui rate
     * « Non » de deux centimètres tomberait sur la ligne et remplacerait la
     * partie en cours par une sauvegarde - en réponse à une question sur sa
     * suppression.
     */
    if (!asked) regions.push({ id: `load:${row.id}`, ...box });

    if (asked) {
      regions.push({ id: `confirm-delete:${row.id}`, x: OVER_X, y: box.y, w: YES_W, h: ROW_H });
      regions.push({ id: 'cancel-delete', x: OVER_X + YES_W + 16, y: box.y, w: NO_W, h: ROW_H });
      return;
    }

    regions.push({ id: `overwrite:${row.id}`, x: OVER_X, y: box.y, w: OVER_W, h: ROW_H });
    regions.push({ id: `delete:${row.id}`, x: DELETE_X, y: box.y, w: DELETE_W, h: ROW_H });
  });

  // Écrire ne dépend pas d'en avoir déjà, et sortir ne dépend de rien : un
  // panneau sans sortie est un état dont personne ne ressort.
  regions.push({ id: 'new-save', x: NEW_SAVE_X, y: BAR_Y, w: NEW_SAVE_W, h: BTN_H });
  regions.push({ id: 'close', x: CLOSE_X, y: BAR_Y, w: CLOSE_W, h: BTN_H });

  return regions;
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
  /*
   * Du verre, pas de l'herbe.
   *
   * Ce panneau vit sur la tablette, qui flotte devant l'écran de jeu - la
   * partie doit rester visible à travers lui. Un champ d'herbe translucide
   * par-dessus une image serait boueux, donc le chrome garde ses cadres et
   * échange son fond. Voir `chrome.ts`.
   */
  drawField(ctx, width, height, 'glass');

  statusBox(ctx, PAD - 14, 12, width - (PAD - 14) * 2, 68);
  ctx.fillStyle = SMW.ink;
  ctx.font = '600 34px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(labels.heading, PAD + 8, 46);

  const rows = savesRows({ ...state, quickSave: labels.quickSave });

  if (rows.length === 0) {
    // Un panneau vide se lit comme un panneau qui n'a pas chargé.
    statusBox(ctx, ROW_X, ROW_Y, ROW_W, ROW_H);
    ctx.textAlign = 'left';
    ctx.font = '24px system-ui, sans-serif';
    ctx.fillStyle = SMW.ink;
    ctx.fillText(truncate(ctx, labels.empty, ROW_W - 60), ROW_X + 24, ROW_Y + ROW_H / 2);
  }

  // Dessinées depuis les lignes et non depuis les régions : il n'y a aucune
  // région pendant qu'une opération est en vol, et c'est précisément là qu'il
  // faut encore voir ce qu'on a.
  rows.forEach((row, index) => {
    /*
     * La boîte de la ligne vient de la mise en page, pas des régions.
     *
     * Deux états n'ont aucune région `load:` - une opération en vol, et la
     * ligne dont on demande la suppression - et ce sont précisément les deux
     * moments où il faut encore voir ce qu'on a. `rowAt` est la seule source
     * de la géométrie ; les régions n'en sont qu'une conséquence.
     */
    const region = { id: '', ...rowAt(index) };
    const asked = state.confirming === row.id;

    statusBox(ctx, region.x, region.y, region.w, region.h);

    const shotBox = {
      x: region.x + SHOT_MARGIN,
      y: region.y + SHOT_MARGIN,
      w: SHOT_W,
      h: SHOT_H
    };
    // Le puits est dessiné avant l'image, comme sur l'écran de lancement :
    // sinon la ligne change de forme quand la vignette arrive.
    slot(ctx, shotBox.x, shotBox.y, shotBox.w, shotBox.h);

    const shot = state.shots.get(row.id);
    if (shot) {
      // Ses propres proportions dans le puits. Le puits a désormais le ratio
      // d'une image SNES (voir `SHOT_W`), donc `fitContain` ne rogne plus
      // rien - mais il reste la seule réponse correcte pour une vignette qui
      // arriverait d'ailleurs.
      const inset = EDGE + LINER;
      const fitted = fitContain(intrinsicSize(shot), {
        x: shotBox.x + inset, y: shotBox.y + inset,
        w: shotBox.w - inset * 2, h: shotBox.h - inset * 2
      });
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

    /*
     * La question prend la place de la date, pas celle du nom.
     *
     * Le rendu a tranché : deux boutons « Oui » et « Non » sur une ligne
     * inchangée ne disent pas ce qui est demandé - un joueur voit « Oui » à
     * quoi ? Le nom reste donc au-dessus, parce que c'est la seule chose qui
     * dit LAQUELLE des quatre on est en train de perdre, et la date cède sa
     * place à la question, parce qu'elle n'apprend rien pendant ce moment-là.
     */
    if (asked) {
      ctx.fillStyle = SMW.accent;
      ctx.font = '600 20px system-ui, sans-serif';
      ctx.fillText(
        truncate(ctx, labels.confirmRemove, textW),
        region.x + TEXT_X,
        region.y + region.h / 2 + 16
      );
    } else if (row.secondary !== null) {
      ctx.fillStyle = '#b8b8f8';
      ctx.font = '20px system-ui, sans-serif';
      ctx.fillText(truncate(ctx, row.secondary, textW), region.x + TEXT_X, region.y + region.h / 2 + 16);
    }

    if (hoverId === `load:${row.id}`) {
      ctx.strokeStyle = SMW.accent;
      ctx.lineWidth = 6;
      ctx.strokeRect(region.x - 4, region.y - 4, region.w + 8, region.h + 8);
    }

    /*
     * Les deux boutons de la ligne, ou la question qui les remplace.
     *
     * Dessinés depuis les régions quand elles existent : elles disparaissent
     * toutes pendant qu'une opération est en vol, et un bouton visable qui
     * ne répond pas est pire qu'un bouton absent.
     */
    if (asked) {
      const yes = byId.get(`confirm-delete:${row.id}`);
      if (yes) chromeButton(ctx, yes, labels.yes, 'warn', hoverId === `confirm-delete:${row.id}`);
      const no = byId.get('cancel-delete');
      if (no) chromeButton(ctx, no, labels.no, 'quiet', hoverId === 'cancel-delete');
      return;
    }

    const over = byId.get(`overwrite:${row.id}`);
    if (over) {
      chromeButton(ctx, over, labels.overwrite, 'quiet', hoverId === `overwrite:${row.id}`, 22);
    }
    const remove = byId.get(`delete:${row.id}`);
    if (remove) {
      /*
       * Discret, pas rouge, et le rendu a corrigé mon premier choix.
       *
       * Le ton d'avertissement était mis ici par analogie avec « Quitter la
       * VR » et « Arrêter » du bandeau. Mais ceux-là agissent ; celui-ci ne
       * fait que POSER une question, et quatre pavés rouges empilés tiraient
       * l'œil vers le seul bouton du panneau qui ne détruit rien. Le rouge est
       * descendu d'un cran, sur le « Oui » qui, lui, ne se défait pas.
       */
      chromeButton(ctx, remove, labels.remove, 'quiet', hoverId === `delete:${row.id}`, 22);
    }
  });

  const newSave = byId.get('new-save');
  if (newSave) chromeButton(ctx, newSave, labels.newSave, 'loud', hoverId === 'new-save');
  const close = byId.get('close');
  if (close) chromeButton(ctx, close, labels.close, 'quiet', hoverId === 'close');

  ctx.restore();
}
