/**
 * Où le menu des sauvegardes lit ses sauvegardes : le serveur, ou l'appareil.
 *
 * Un seul menu, en ligne comme hors-ligne - `SaveGameMenu`, `LoadSavesMenu` et
 * la grille qu'ils partagent. Ce qui change entre les deux n'est pas l'écran
 * mais la source, et ce que la source sait faire : hors-ligne, une action qui
 * demande le serveur (supprimer une sauvegarde du compte, restaurer une
 * sauvegarde de cartouche gardée) reste à l'écran, grisée, avec la raison.
 * Une action cachée ressemble à une action qui n'existe pas ; grisée, elle dit
 * qu'elle reviendra.
 *
 * Aucun import `$lib` : `core/test` tourne sous node nu.
 */

import { deleteSave, fetchSaves, type DeleteResult, type SaveSummary, type SavesResult } from './api.js';
import type { UnavailableReason } from '../rooms/anonymous-join.js';

/**
 * Pourquoi une action n'est pas possible ici - une clé de traduction. Les
 * raisons de `onlineControls()` (#97) d'abord, pour que le menu dise la même
 * phrase que le reste de l'écran hors-ligne ; puis deux qui ne tiennent qu'aux
 * sauvegardes.
 */
export type BlockedKey = UnavailableReason | 'saveNotSentYet' | 'legacySlotKept';

export interface SaveShelf {
	list(): Promise<SavesResult>;
	remove(save: SaveSummary): Promise<DeleteResult>;
	/** Null si choisir cette sauvegarde est possible ici ; sinon, pourquoi pas. */
	pickBlocked?(save: SaveSummary): BlockedKey | null;
	/** Null si la supprimer est possible ici ; sinon, pourquoi pas. */
	removeBlocked?(save: SaveSummary): BlockedKey | null;
	/** Une ligne au-dessus de la liste, pour dire d'où elle vient. */
	note?: 'savesOfflineNote' | null;
}

/** Les sauvegardes du compte, sur le serveur - le menu en ligne, tel qu'il a toujours été. */
export function serverShelf(gameId: string): SaveShelf {
	return {
		list: () => fetchSaves(gameId),
		remove: (save) => deleteSave(gameId, save.id)
	};
}

/**
 * Ce qu'une partie hors de tout salon donne au menu : les sauvegardes de
 * l'appareil, et les deux gestes qui s'y appliquent sans serveur.
 */
export interface DeviceSaveActions {
	shelf: SaveShelf;
	/** Écrire l'état courant : une neuve, ou par-dessus `target`. Vrai si c'est écrit ici. */
	write(target: SaveSummary | undefined, name: string): Promise<boolean>;
	/** Mettre cette sauvegarde dans la machine. Vrai si c'est fait. */
	load(save: SaveSummary): Promise<boolean>;
}
