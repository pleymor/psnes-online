/**
 * Le jeu d'un salon, ou rien.
 *
 * Depuis qu'un salon peut exister avant qu'un jeu soit choisi, dix
 * gestionnaires d'événements socket - sauvegardes, slots, SRAM - n'ont plus de
 * garantie que `room.gameId` existe. Ils passent tous par ici plutôt que de
 * répéter le même `if` dix fois : une garde répétée dix fois sera oubliée à la
 * onzième, et un accesseur unique est une fonction que le test fixe.
 *
 * Ne pas utiliser dans `room-view.ts`. Décrire un salon sans jeu est
 * exactement ce que la vue doit savoir faire.
 */
export interface GameOfRoom {
  gameId: string;
  gameTitle: string;
}

export function requireGame(room: { gameId?: string; gameTitle?: string }): GameOfRoom | null {
  if (!room.gameId || !room.gameTitle) return null;
  return { gameId: room.gameId, gameTitle: room.gameTitle };
}
