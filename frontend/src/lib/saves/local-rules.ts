/**
 * Les règles des sauvegardes locales, sans navigateur.
 *
 * Tout ce qui décide - quel nom de fichier, où écrire, laquelle de deux
 * copies croire - vit ici, en fonctions pures, pour la raison que
 * `roms/source-state.ts` donne de lui-même : la collecte des faits demande
 * `showDirectoryPicker`, IndexedDB et une permission, rien de cela n'existe
 * sous node, et c'est précisément la décision qui peut être fausse sans que
 * personne le voie. Un mauvais nom de fichier, et la progression du joueur est
 * écrite là où ni RetroArch ni nous ne la relirons.
 *
 * Aucun import `$lib` : `core/test` tourne sous node nu.
 */

/**
 * Un emplacement : la pile de la cartouche, ou un savestate numéroté.
 *
 * `'sram'` et non `0` : la SRAM n'est pas un savestate de plus, c'est la
 * mémoire que le jeu écrit lui-même depuis son propre menu, et les confondre
 * dans un nombre serait inviter quelqu'un à « charger l'emplacement 0 » par
 * dessus une partie en cours.
 */
export type SaveSlot = 'sram' | number;

/** Combien d'emplacements de savestate le menu pause propose. */
export const STATE_SLOTS = 3;

/** Les extensions de ROM que `local-library.ts` reconnaît, dézippées ou non. */
const ROM_EXTENSION = /\.(smc|sfc|fig|swc|mgd|zip)$/i;

/**
 * Le nom d'une ROM sans son extension : ce que tout le reste prend pour base.
 *
 * Seules les extensions de ROM sont retirées. « Chrono Trigger (v1.1).sfc »
 * perd `.sfc` et garde « (v1.1) » ; retirer « la dernière extension » quelle
 * qu'elle soit aurait coupé « Super Mario World v1.0 » après « v1 ».
 */
export function romBaseName(romFilename: string): string {
	const base = romFilename.replace(ROM_EXTENSION, '');
	return base.length > 0 ? base : romFilename;
}

/**
 * Le fichier voisin de la ROM qui porte cet emplacement.
 *
 * `.srm` octet pour octet, parce que c'est ce que RetroArch, Snes9x et bsnes
 * écrivent déjà : c'est la seule chose qui rende « à côté de la ROM » meilleur
 * qu'IndexedDB - le joueur peut rouvrir sa progression ailleurs, et l'emporter
 * en copiant un dossier. `.state1`, `.state2`… n'ont pas cette chance, le
 * format étant celui de notre cœur ; le nom ne sert qu'à être lisible par un
 * humain qui regarde son dossier.
 */
export function saveFileName(romFilename: string, slot: SaveSlot): string {
	const base = romBaseName(romFilename);
	return slot === 'sram' ? `${base}.srm` : `${base}.state${slot}`;
}

/** La clé d'un emplacement dans le magasin de l'appareil. */
export function deviceSaveKey(checksum: string, slot: SaveSlot): string {
	return `${checksum}:${slot === 'sram' ? 'srm' : `state${slot}`}`;
}

/** Les faits dont dépend la destination d'une écriture. */
export interface DestinationFacts {
	/** `showDirectoryPicker` existe dans ce navigateur. */
	supported: boolean;
	/** Un dossier est mémorisé sur cet appareil. */
	folder: boolean;
	/** L'écriture y est accordée, maintenant, sans rien demander. */
	writeGranted: boolean;
	/** Le nom de la ROM dans ce dossier, sans quoi il n'y a pas de voisin. */
	romFilename: string | null;
}

/** Pourquoi une sauvegarde reste dans le navigateur plutôt qu'à côté de la ROM. */
export type DeviceReason =
	/** Firefox et Safari : pas de dossier possible du tout. */
	| 'unsupported'
	/** Aucun dossier choisi sur cet appareil. */
	| 'no-folder'
	/** Un dossier, mais l'écriture n'y est pas accordée. */
	| 'no-permission'
	/** La ROM n'est pas dans le dossier : désignée à la main, par exemple. */
	| 'not-in-folder';

export type SaveDestination = { kind: 'folder' } | { kind: 'device'; reason: DeviceReason };

/**
 * Où va une écriture.
 *
 * Le repli sur l'appareil est silencieux par décision : refuser de jouer
 * faute de permission punirait précisément les navigateurs qui n'y peuvent
 * rien, et une partie sans fichier voisin vaut mieux que pas de partie. La
 * raison est rendue quand même, parce que le panneau ROM la dit au joueur -
 * silencieux en jeu ne veut pas dire caché.
 *
 * L'ordre des tests est celui de `romSourceState` : l'API d'abord, un nom de
 * dossier laissé par un autre navigateur ne doit pas faire paraître capable
 * un navigateur qui ne l'est pas.
 */
export function saveDestination(facts: DestinationFacts): SaveDestination {
	if (!facts.supported) return { kind: 'device', reason: 'unsupported' };
	if (!facts.folder) return { kind: 'device', reason: 'no-folder' };
	if (!facts.writeGranted) return { kind: 'device', reason: 'no-permission' };
	if (!facts.romFilename) return { kind: 'device', reason: 'not-in-folder' };
	return { kind: 'folder' };
}

/** Une copie d'un emplacement, datée. */
export interface StampedSave {
	bytes: Uint8Array;
	/** Millisecondes : `lastModified` d'un fichier, ou l'heure d'écriture en base. */
	savedAt: number;
}

/**
 * Laquelle de deux copies d'un même emplacement croire.
 *
 * Il peut y en avoir deux, et ce n'est pas une anomalie : un joueur qui joue
 * sans permission d'écriture remplit l'appareil, puis accorde l'écriture et
 * remplit le dossier. Croire toujours le dossier lui rendrait une progression
 * plus ancienne que celle qu'il vient de quitter ; croire toujours l'appareil
 * ignorerait un `.srm` qu'il a copié depuis RetroArch. La plus récente gagne,
 * et à égalité le dossier, qui est le fichier que le joueur voit.
 */
export function newestSave(
	folder: StampedSave | null,
	device: StampedSave | null
): { save: StampedSave; from: 'folder' | 'device' } | null {
	if (folder && device) {
		return device.savedAt > folder.savedAt
			? { save: device, from: 'device' }
			: { save: folder, from: 'folder' };
	}
	if (folder) return { save: folder, from: 'folder' };
	if (device) return { save: device, from: 'device' };
	return null;
}

/**
 * La phrase du panneau ROM qui dit où partent les sauvegardes sans compte.
 *
 * Une clé de traduction et non une phrase, pour que le compilateur voie un
 * renommage - la même raison que `DoorMessageKey` dans `anonymous-join.ts`.
 */
export type SaveNoteKey =
	| 'localSavesInFolder'
	| 'localSavesUnsupported'
	| 'localSavesNoFolder'
	| 'localSavesNoPermission';

export function saveNoteKey(facts: Omit<DestinationFacts, 'romFilename'>): SaveNoteKey {
	// Le nom de fichier n'entre pas ici : le panneau parle du dossier, pas d'un
	// jeu, et un jeu désigné à la main n'y est pas encore.
	const destination = saveDestination({ ...facts, romFilename: 'any' });
	if (destination.kind === 'folder') return 'localSavesInFolder';
	switch (destination.reason) {
		case 'unsupported':
			return 'localSavesUnsupported';
		case 'no-folder':
			return 'localSavesNoFolder';
		default:
			return 'localSavesNoPermission';
	}
}
