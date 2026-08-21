/**
 * Si un joueur a la ROM du jeu choisi - avec un troisième état.
 *
 * `unknown` n'est pas de la prudence décorative : la colonne `crc32` de `Game`
 * est nullable, donc un jeu enregistré sans checksum ne permet aucune
 * comparaison. Afficher « ne l'a pas » dans ce cas serait faux.
 *
 * Et ce que `has` affirme est plus étroit qu'il n'y paraît : le joueur a
 * enregistré cette ROM dans sa bibliothèque. Pas que le fichier soit
 * accessible maintenant - il vit sur sa machine, derrière une permission de
 * dossier qui peut avoir expiré. L'invite de localisation reste le filet.
 */
export type RomAvailability = 'has' | 'missing' | 'unknown';

export function romAvailability(facts: {
  gameCrc32: string | null | undefined;
  playerOwnsChecksum: boolean;
}): RomAvailability {
  if (!facts.gameCrc32) return 'unknown';
  return facts.playerOwnsChecksum ? 'has' : 'missing';
}
