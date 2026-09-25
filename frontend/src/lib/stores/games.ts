import { get, writable } from 'svelte/store';
import { user } from './user';
import {
  coversToForget,
  readLibrarySnapshot,
  snapshotOf,
  writeLibrarySnapshot
} from '../games/library-snapshot';
import { COVERS_CACHE } from '../pwa/cache-policy';

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
  /**
   * Le titre alternatif de la fiche, et d'où elle vient.
   *
   * À part des champs fusionnés au-dessus, parce qu'ils ne décrivent pas le
   * jeu : ils servent au formulaire de correction. `metadataAltTitle` est le
   * seul champ descriptif que rien n'affiche, donc le seul qu'un formulaire
   * effacerait sans que personne le voie ; `metadataSource` dit si corriger
   * est même proposé - une fiche livrée avec le catalogue perdrait l'édition
   * au déploiement suivant.
   */
  metadataAltTitle?: string | null;
  metadataSource?: string | null;
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
    void keepForOffline(loaded);
  } catch {
    // Voir ci-dessus : l'écran garde ce qu'il affichait.
  }
}

/**
 * La copie hors-ligne de la bibliothèque, pour ce compte (#71 §7.4).
 *
 * Chaque réponse de `/api/games` la remplace - c'est le rafraîchissement au
 * retour du réseau - et une jaquette que la nouvelle réponse ne cite plus sort
 * du cache du service worker : la fiche a changé, l'ancienne image mentirait.
 * Rien ici n'est bloquant : l'écran en ligne n'attend pas sa copie.
 */
async function keepForOffline(loaded: Game[]): Promise<void> {
  const account = get(user);
  if (!account || account.isAnonymous) return;
  try {
    const next = snapshotOf(account.id, loaded as never, Date.now());
    const previous = await readLibrarySnapshot(account.id);
    await writeLibrarySnapshot(next);
    const stale = coversToForget(previous, next);
    if (stale.length && typeof caches !== 'undefined') {
      const cache = await caches.open(COVERS_CACHE);
      await Promise.all(stale.map((url) => cache.delete(url)));
    }
  } catch {
    // Stockage refusé : la bibliothèque hors-ligne sera celle d'avant, ou vide.
  }
}
