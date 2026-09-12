/**
 * Comment le joueur tourne au stick droit : par crans, ou en continu.
 *
 * Le réglage existe parce que la sensibilité au mal des transports varie
 * énormément d'une personne à l'autre - c'est la raison pour laquelle tous les
 * jeux VR sérieux offrent les deux, et non un souci de goût. Le CRAN est le
 * défaut : une rotation continue fait tourner TOUT le champ, là où une
 * translation n'en fait défiler qu'une partie, et l'oreille interne ne sent
 * aucun virage pendant ce temps.
 *
 * Dans le `localStorage` et non dans le compte, pour la même raison que
 * `pad-map.ts` : c'est un réglage de CASQUE, pas de personne. Le coût assumé
 * est deux casques, deux réglages.
 */

export type TurnStyle = 'snap' | 'smooth';

const KEY = 'psnes.vr.turnStyle';

/** Ce qu'un stockage absent, illisible ou trafiqué doit donner. */
export const TURN_STYLE_DEFAULT: TurnStyle = 'snap';

export interface PreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Le réglage enregistré, ou le défaut.
 *
 * Toute valeur inconnue rend le défaut plutôt que de jeter : rien n'empêche un
 * joueur d'éditer son `localStorage` à la main, et un réglage illisible n'est
 * pas une raison de refuser d'entrer en VR.
 */
export function readTurnStyle(storage: PreferenceStorage | null | undefined): TurnStyle {
  try {
    const raw = storage?.getItem(KEY);
    return raw === 'snap' || raw === 'smooth' ? raw : TURN_STYLE_DEFAULT;
  } catch {
    return TURN_STYLE_DEFAULT;
  }
}

/** Enregistre, et avale l'échec : un quota plein ne doit pas casser le lobby. */
export function writeTurnStyle(
  storage: PreferenceStorage | null | undefined,
  style: TurnStyle
): void {
  try {
    storage?.setItem(KEY, style);
  } catch {
    // Un stockage refusé laisse le réglage valable pour la session, ce qui est
    // exactement ce qu'un joueur attend d'un mode privé.
  }
}
