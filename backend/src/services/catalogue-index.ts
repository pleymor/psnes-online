/**
 * Le catalogue normalisé une fois par catalogue, plutôt qu'une fois par question.
 *
 * `normalizeTitle` enchaîne treize expressions régulières. La recherche
 * (`catalogue-search.ts`) et l'identification par titre (`metadata-loader.ts`)
 * les lançaient toutes les deux sur le titre ET l'alt-titre des 1475 fiches à
 * chaque appel - quelque 38 000 exécutions de regex pour un résultat qui ne
 * change que lorsque le catalogue change. Mesuré sur le catalogue réel :
 * 1,49 ms par recherche, contre 0,06 ms une fois indexé, pour 1,54 ms de
 * construction payés une seule fois.
 *
 * LE CACHE EST CLAVETÉ SUR LE TABLEAU, et c'est ce qui le rend incapable de
 * devenir périmé. `metadata-loader` ne modifie jamais son cache en place : une
 * contribution appelle `invalidateMetadataCache()`, la lecture suivante
 * fabrique un tableau NEUF, qui rate ce cache-ci et se réindexe. Il n'y a donc
 * pas un second cycle de vie à tenir en phase avec le premier - c'était le
 * risque du même index rangé à côté, et il n'existe pas ici.
 */

import { normalizeTitle } from './normalise-title.js';
import { createLogger } from '../utils/logger.js';
import type { GameMetadata } from '../db/types.js';

const logger = createLogger('CatalogueIndex');

export interface CatalogueRow {
  entry: GameMetadata;
  /** `entry.title` normalisé. */
  title: string;
  /** `entry.altTitle` normalisé, ou null quand la fiche n'en porte pas. */
  altTitle: string | null;
}

export interface CatalogueIndex {
  /** Les fiches dans l'ordre du catalogue, chacune avec ses formes normalisées. */
  rows: CatalogueRow[];
  /**
   * Un titre normalisé - titre ou alt-titre - vers la fiche qui le porte.
   *
   * LA PREMIÈRE du catalogue en cas de doublon, ce qui n'est pas un détail :
   * cette carte remplace un `Array.find`, qui rendait la première, et une Map
   * remplie sans garde rendrait la dernière. Le dump d'un joueur se mettrait
   * alors à pointer sur une autre fiche sans que rien ne le dise.
   */
  byTitle: Map<string, GameMetadata>;
}

const indexed = new WeakMap<GameMetadata[], CatalogueIndex>();

export function catalogueIndex(entries: GameMetadata[]): CatalogueIndex {
  const held = indexed.get(entries);
  if (held) return held;

  /*
   * Le coût de construction, dit une fois par catalogue.
   *
   * C'est l'instrument qui permet de vérifier le gain en production plutôt que
   * de le supposer : une ligne ici et une seule par version du catalogue - donc
   * au démarrage et après chaque contribution - et si jamais elle se mettait à
   * revenir à chaque recherche, c'est que la mémoïsation aurait cessé de
   * prendre. Le silence est le résultat attendu.
   */
  const startedAt = performance.now();
  const rows: CatalogueRow[] = [];
  const byTitle = new Map<string, GameMetadata>();

  for (const entry of entries) {
    const title = normalizeTitle(entry.title);
    const altTitle = entry.altTitle ? normalizeTitle(entry.altTitle) : null;
    rows.push({ entry, title, altTitle });
    // `has` avant `set`, des deux côtés : voir `byTitle`. Le titre avant
    // l'alt-titre au sein d'une même fiche est sans conséquence, puisque les
    // deux désignent cette fiche-là.
    if (!byTitle.has(title)) byTitle.set(title, entry);
    // L'alt-titre seulement s'il reste quelque chose une fois normalisé, et
    // c'est une parité, pas une précaution : le balayage remplacé écrivait
    // `normalizedAltTitle && ...`, donc un alt-titre réduit à rien - « (USA) »
    // seul, par exemple - ne correspondait à aucune requête. Le titre, lui,
    // était comparé sans cette garde, et il la reste.
    if (altTitle && !byTitle.has(altTitle)) byTitle.set(altTitle, entry);
  }

  const index: CatalogueIndex = { rows, byTitle };
  indexed.set(entries, index);
  logger.info(
    { entries: rows.length, titles: byTitle.size, ms: Math.round(performance.now() - startedAt) },
    'Catalogue indexed'
  );
  return index;
}
