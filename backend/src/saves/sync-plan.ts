/**
 * Ce qu'une sauvegarde venue d'un appareil a le droit de faire à celles qui
 * sont déjà sur le serveur (#71).
 *
 * Le local fait autorité : chaque appareil écrit d'abord chez lui, et le
 * serveur reçoit ensuite, par une file qui peut attendre des heures. Deux
 * appareils peuvent donc avoir avancé chacun de leur côté, et c'est ici, et
 * nulle part ailleurs, que leur rencontre se décide.
 *
 * La règle est celle d'`import-plan.ts`, prolongée plutôt que contredite :
 * **une synchronisation n'efface jamais rien**. Là où `import-plan.ts` garde
 * la SRAM en place et demande au joueur, la synchronisation ne peut demander à
 * personne - elle tourne quand le réseau revient, souvent sans écran - donc
 * elle garde les deux :
 *
 *  - la plus récente devient la SRAM, l'autre est gardée comme une sauvegarde
 *    datée (`kind = 'sram'`), qu'on peut restaurer. Un emplacement de plus, et
 *    une heure de la soirée de quelqu'un de moins à perdre ;
 *  - un savestate qui en remplace un autre ne le remplace que si c'est bien
 *    celui que le joueur a vu ; sinon les deux restent ;
 *  - la sauvegarde rapide (`__quick__`), la plus réécrite du produit et donc
 *    celle qui fabriquera tous les conflits, est nommée ici exprès : la plus
 *    récente reste LA sauvegarde rapide, l'autre est gardée sous
 *    `KEPT_STATE_NAME`, datée. La perdre coûterait peu, mais « peu » n'est pas
 *    une règle qu'on peut prouver, et « rien » en est une.
 *
 * « Plus récente » veut dire : jouée plus tard, d'après l'heure de l'appareil
 * au moment de l'écriture locale (`savedAt`), pas d'après l'heure d'arrivée au
 * serveur. Sans cela l'appareil resté hors-ligne, qui arrive le dernier,
 * gagnerait toujours, même avec une partie plus ancienne. `Game.sramUpdatedAt`
 * porte donc désormais ce moment-là, borné à l'heure du serveur pour qu'une
 * horloge en avance ne gagne pas tous les conflits à venir.
 *
 * Pur, et à part de la route, pour la raison qu'`import-plan.ts` donne de
 * lui-même : rien ici ne pilote un handler Express dans un test, donc une règle
 * écrite dans une route est une règle que personne ne peut prouver.
 */

/** Le nom d'une sauvegarde rapide - le même sentinelle que `frontend/src/lib/saves/quick.ts`. */
export const QUICK_SAVE_NAME = '__quick__';

/**
 * Le nom sous lequel un savestate perdant est gardé.
 *
 * Un sentinelle et non une phrase : le serveur ne connaît pas la langue du
 * joueur, et `saves/identity.ts` côté client en fait « Gardée à la synchro »
 * suivi de la date, qui est ce qui distingue deux sauvegardes gardées.
 */
export const KEPT_STATE_NAME = '__kept__';

/** Le nom d'une SRAM gardée : sa date suffit, `kind` dit ce qu'elle est. */
export const KEPT_SRAM_NAME = '__sram__';

/* ----------------------------------------------------------------- SRAM */

export interface StoredSram {
  bytes: Uint8Array;
  /** `Game.sramUpdatedAt`, en millisecondes. C'est aussi la version comparée à `base`. */
  updatedAt: number;
}

export interface IncomingSram {
  bytes: Uint8Array;
  /**
   * Le `sramUpdatedAt` que l'appareil a vu la dernière fois qu'il s'est
   * synchronisé, ou null s'il ne s'est jamais synchronisé pour ce compte.
   * C'est la preuve qu'une écriture descend de ce qui est stocké.
   */
  base: number | null;
  /** Quand l'appareil a écrit cette SRAM chez lui. */
  savedAt: number;
}

export type SramPlan =
  /** Rien n'était stocké : l'arrivée devient la SRAM. */
  | { kind: 'write'; updatedAt: number }
  /** L'appareil avait vu ce qui est stocké : sa SRAM en descend, elle la remplace. */
  | { kind: 'fast-forward'; updatedAt: number }
  /** Les mêmes octets : déjà reçus, par cette requête rejouée ou par une autre. */
  | { kind: 'same'; updatedAt: number }
  /** Divergence, l'arrivée est plus récente : elle devient la SRAM, le stocké est gardé daté. */
  | { kind: 'incoming-wins'; updatedAt: number; keep: { savedAt: number } }
  /** Divergence, le stocké est plus récent : il reste, l'arrivée est gardée datée. */
  | { kind: 'stored-wins'; updatedAt: number; keep: { savedAt: number } };

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Le moment qu'une écriture pose dans `sramUpdatedAt`.
 *
 * Jamais dans le futur du serveur, et toujours strictement après la version
 * remplacée : `base` compare des nombres, et deux versions qui portent le même
 * nombre rendraient la comparaison aveugle à ce qui les sépare.
 */
function stamp(savedAt: number, now: number, after: number | null): number {
  const bounded = Math.min(savedAt, now);
  return after === null ? bounded : Math.max(bounded, after + 1);
}

export function planSramSync(
  stored: StoredSram | null,
  incoming: IncomingSram,
  now: number
): SramPlan {
  if (!stored) return { kind: 'write', updatedAt: stamp(incoming.savedAt, now, null) };

  if (sameBytes(stored.bytes, incoming.bytes)) {
    return { kind: 'same', updatedAt: stored.updatedAt };
  }

  if (incoming.base !== null && incoming.base === stored.updatedAt) {
    return { kind: 'fast-forward', updatedAt: stamp(incoming.savedAt, now, stored.updatedAt) };
  }

  // Les deux ont avancé depuis un ancêtre commun, ou l'appareil n'en a jamais
  // eu : rien ne prouve que l'un contienne l'autre. Les deux restent.
  if (incoming.savedAt > stored.updatedAt) {
    return {
      kind: 'incoming-wins',
      updatedAt: stamp(incoming.savedAt, now, stored.updatedAt),
      keep: { savedAt: stored.updatedAt }
    };
  }
  return {
    kind: 'stored-wins',
    updatedAt: stored.updatedAt,
    keep: { savedAt: Math.min(incoming.savedAt, now) }
  };
}

/* ------------------------------------------------------------ savestates */

/** Ce qu'il faut savoir d'un savestate déjà stocké - jamais son contenu. */
export interface StoredState {
  id: string;
  name: string;
  slotNumber: number;
  kind: 'state' | 'sram';
  updatedAt: number;
}

export interface IncomingState {
  name: string;
  savedAt: number;
  /**
   * Le savestate que le joueur a choisi d'écraser, tel qu'il l'a vu. Absent
   * pour une nouvelle sauvegarde, et pour une sauvegarde rapide prise
   * hors-ligne, où personne n'a pu voir la liste du serveur.
   */
  replaces?: { id: string; updatedAt: number } | null;
}

export type StatePlan =
  | { kind: 'create'; name: string; slotNumber: number; savedAt: number }
  | { kind: 'overwrite'; id: string; savedAt: number }
  /**
   * La sauvegarde rapide : l'arrivée est plus récente. L'ancienne est
   * renommée - gardée, datée de son propre moment - et l'arrivée prend le nom.
   */
  | { kind: 'take-quick'; renameId: string; slotNumber: number; savedAt: number }
  /** La sauvegarde rapide : l'arrivée est plus ancienne, elle est gardée datée à côté. */
  | { kind: 'keep-beside-quick'; slotNumber: number; savedAt: number };

export function planStateSync(
  existing: readonly StoredState[],
  incoming: IncomingState,
  now: number
): StatePlan {
  const savedAt = Math.min(incoming.savedAt, now);
  // Au-dessus du plus haut, jamais dans un trou : la règle de `nextFreeSlot`
  // et d'`import-plan.ts`, pour la même raison.
  const nextSlot = existing.reduce((highest, s) => Math.max(highest, s.slotNumber), 0) + 1;

  const target = incoming.replaces
    ? existing.find(s => s.id === incoming.replaces!.id && s.kind === 'state')
    : undefined;
  const untouched = !!target && target.updatedAt === incoming.replaces!.updatedAt;

  if (incoming.name === QUICK_SAVE_NAME) {
    const quick = existing.find(s => s.name === QUICK_SAVE_NAME && s.kind === 'state');
    if (!quick) return { kind: 'create', name: QUICK_SAVE_NAME, slotNumber: nextSlot, savedAt };
    // Le joueur écrase la sauvegarde rapide qu'il a vue : c'est son geste,
    // pas un conflit.
    if (untouched && target!.id === quick.id) return { kind: 'overwrite', id: quick.id, savedAt };
    if (savedAt > quick.updatedAt) {
      return { kind: 'take-quick', renameId: quick.id, slotNumber: nextSlot, savedAt };
    }
    return { kind: 'keep-beside-quick', slotNumber: nextSlot, savedAt };
  }

  if (untouched) return { kind: 'overwrite', id: target!.id, savedAt };
  // Remplacée ailleurs, ou supprimée depuis : écraser détruirait ce que
  // l'autre appareil a écrit. Les deux restent.
  return { kind: 'create', name: incoming.name, slotNumber: nextSlot, savedAt };
}
