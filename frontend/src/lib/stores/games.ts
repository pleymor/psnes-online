import { writable } from 'svelte/store';

export interface Game {
  id: string;
  title: string;
  filename: string;
  coverUrl?: string;
  uploadedAt: string;
  saves: any[];
  /**
   * CRC32 of the ROM's contents - the game's identity.
   *
   * The bytes live on the player's machine and never on the server, so this is
   * the only link between a library entry and a file on disk. Null on entries
   * created before local ROMs, which need re-linking once.
   */
  crc32?: string | null;
  /**
   * The catalogue entry this game's dump is linked to, if anyone has said.
   *
   * Resolved server-side from the CRC32, not stored on the game: that is what
   * makes one player's answer reach everyone holding the same dump.
   */
  metadataId?: string | null;
  /** Whether nothing at all is known about this game, so the player can say. */
  needsIdentification?: boolean;
  /**
   * When the cartridge's battery save was last written, if it ever was.
   *
   * Already in `/api/games`' answer; declared here because the save export
   * needs to know whether there is anything to carry. A game with no
   * savestates can still hold an in-game save, and that is the one that
   * actually holds progress.
   */
  sramUpdatedAt?: string | null;
  // Metadata fields
  genre?: string;
  publisher?: string;
  developer?: string;
  releaseDate?: string;
  players?: string;
  region?: string;
  description?: string;
}

export const games = writable<Game[]>([]);

/**
 * Récupère les identités du compte et remplit le store.
 *
 * Ici plutôt que dans la page d'accueil parce que deux pages en dépendent. Le
 * profil dit « N jeux de votre compte ne sont pas sur cet appareil », et ce
 * nombre reste nul tant que personne n'a rempli le store : y arriver par un
 * rechargement, un favori ou un onglet neuf laissait donc la ligne muette
 * exactement dans le cas où un joueur perplexe recharge pour comprendre.
 *
 * Le tri par titre appartient à cette fonction : c'est l'ordre dans lequel la
 * grille affiche, et le refaire dans chaque page les ferait diverger.
 *
 * Ne lève pas. Les appelants sont des `onMount`, où un rejet ne produit qu'une
 * promesse non gérée, et garder la liste précédente vaut mieux que la vider
 * parce que le réseau a hoqueté.
 */
export async function loadGames(): Promise<void> {
  try {
    const res = await fetch('/api/games', { credentials: 'include' });
    if (!res.ok) return;
    const loaded: Game[] = await res.json();
    loaded.sort((a, b) => a.title.localeCompare(b.title));
    games.set(loaded);
  } catch {
    // Voir ci-dessus : l'écran garde ce qu'il affichait.
  }
}
