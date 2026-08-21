# Une barre fine et une page de profil

Conception. **Premier des quatre morceaux** d'un découpage : celui-ci refait l'habillage. Les trois autres sont le salon sans jeu, l'exposition du choix de manette, et l'indicateur de salon dans la barre.

## Pourquoi

La navbar latérale porte quatre choses qui ne sont pas de la navigation : les contrôles, l'affichage, la mise à jour des métadonnées et l'ajout de jeux. Un menu de navigation qui contient surtout des réglages est un menu mal nommé, et il occupe une colonne entière en permanence.

La liste d'amis y est aussi affichée en permanence — 875 lignes de composant visibles à chaque instant pour une information qu'on consulte par intermittence.

Et « Ajouter des jeux » a perdu sa raison d'être en chemin. Depuis la bascule vers les ROM locales, le serveur ne détient aucun fichier : la bibliothèque n'est plus qu'une liste d'identités, et les fichiers viennent d'un dossier de la machine du joueur. Ajouter les jeux un par un est la forme d'avant. Configurer le dossier une fois est la forme d'après.

## Le relogement, poste par poste

| Aujourd'hui | Demain |
|---|---|
| Ajouter des jeux (modal, 300 lignes) | Un encart « d'où viennent tes ROM » sur la page de profil |
| Contrôles | Page de profil |
| Affichage (sélecteur de shader) | Page de profil, **en plus** du menu pause |
| Mise à jour des métadonnées | Page de profil |
| Liste d'amis, toujours visible | Menu déroulant dans la barre |
| Bloc profil + icône de déconnexion | L'avatar dans la barre, menant à la page de profil |
| Sélecteur de langue dans la navbar | Page de profil |
| Sélecteur de langue sur l'accueil déconnecté | **Inchangé** — voir plus bas |

## La barre

Fine, et elle ne contient que ce qui est de la navigation ou de l'identité : le titre, le menu amis, l'avatar. La navbar latérale disparaît, et la bibliothèque récupère la largeur.

L'avatar mène à `/profile`. C'est un lien, pas un menu déroulant : tout ce qu'on y trouvait est maintenant une page, et un menu qui ne contient qu'une entrée est un détour.

**La barre n'existe que connecté.** L'accueil déconnecté a sa propre présentation — un titre, une accroche, le bouton de connexion — et son sélecteur de langue à lui, qu'il **garde**. C'est important et facile à casser : quelqu'un qui ne lit pas l'anglais doit pouvoir changer la langue *avant* de se connecter. La page de profil ne lui est pas accessible.

## La page de profil

Une route, `/profile`, et non un modal. Elle porte assez de choses pour mériter une adresse, et une adresse se partage, s'ouvre dans un onglet et revient avec le bouton retour.

Ses sections, dans cet ordre — l'identité d'abord parce que c'est ce qu'on vient vérifier, les réglages ensuite, la déconnexion en dernier parce qu'elle est destructive :

**Identité.** L'avatar en grand, le nom affiché, l'adresse. Changer l'avatar.

**D'où viennent tes ROM.** Voir le dossier configuré, en choisir un, en changer. Traité en détail plus bas, parce que ce que le navigateur permet change la forme de cet encart.

**Contrôles.** Le composant `ControlsSettings` existant, réutilisé tel quel — il est déjà monté par le menu pause, donc il sait vivre ailleurs que dans la navbar.

**Affichage.** Le choix de shader. Voir plus bas pour la question des deux emplacements.

**Langue.** Le composant `LanguageSelector` existant.

**Bibliothèque.** La mise à jour des métadonnées, qui appelle `/api/games/refresh-metadata`.

**Déconnexion.**

## L'encart des ROM, et l'honnêteté sur le navigateur

C'est le seul endroit de cette conception où le code doit dire une vérité désagréable plutôt que de proposer un bouton.

Le choix d'un dossier est gardé par `supportsDirectoryPicker()`, qui teste `'showDirectoryPicker' in window` (`local-library.ts:30`). C'est **Chromium uniquement**. Firefox et Safari n'ont pas cette API.

Le flux actuel offre donc deux chemins : le dossier, et un fichier à la fois. Ne garder que le dossier rendrait l'application **inutilisable** sur deux navigateurs — bibliothèque vide, sans recours, sans explication.

L'encart a donc deux formes, et la seconde n'est pas un lot de consolation qu'on affiche partout :

- **Là où le dossier est possible** : le dossier configuré, un bouton pour le choisir ou le changer, et rien d'autre. C'est la forme que cette conception veut.
- **Là où il ne l'est pas** : une phrase disant que ce navigateur ne sait pas mémoriser un dossier, et l'ajout fichier par fichier. Le repli ne s'affiche que là où il est nécessaire, donc il ne pèse sur personne d'autre.

**Une conséquence à ne pas s'attribuer.** Sur un navigateur sans cette API, aucun dossier n'étant mémorisable, l'application redemande de localiser le fichier à chaque partie — `resolveQuietly` rend `null` sans support (`provider.ts:55`) et le jeu tombe sur l'invite de localisation. C'est déjà le comportement actuel. Ce n'est pas causé par ce travail, et il faudra résister à l'envie de le lire comme une régression en testant sur Firefox après coup.

## Les réglages d'affichage, à deux endroits et une seule source

Décision du propriétaire : les deux. Ce qui demande une règle, sinon les deux vues divergent.

**Ni la page ni le menu ne détiennent l'état.** `localStorage` le détient — la clé `psnes-shader`, que quatre lecteurs utilisent déjà. Les deux vues lisent au montage et écrivent au changement. Elles n'ont pas besoin de se parler, parce qu'elles ne coexistent jamais à l'écran : on est soit sur la page de profil, soit en jeu.

Le partage du travail est celui de l'usage : la page sert à régler **avant** de jouer, le menu pause **pendant**, et c'est le menu qui montre l'effet en direct — ce qui est précisément la raison pour laquelle il a été rendu latéral plutôt que couvrant.

## Le menu amis

Le composant `FriendsList` existant est réutilisé, pas réécrit : 875 lignes qui fonctionnent et qui ne demandent qu'un autre contenant.

Déroulant sur grand écran, plein écran sur petit — le même partage que le panneau de pause, et pour la même raison : une liste dans une colonne étroite sur téléphone n'est pas consultable.

## Ce qui est testable ici, et pourquoi ça compte

Presque tout ce morceau est de l'interface, donc invérifiable sans navigateur. La leçon du travail précédent est que la part intestable doit être **réduite**, pas acceptée par habitude — et que sur la branche précédente je l'avais mal réduite, en écrivant une classe pure autour de six lignes qui n'étaient pas en danger tout en laissant le code risqué dans le composant.

Donc, explicitement : deux fonctions pures, testées, et le reste du câblage.

**Quelle forme l'encart des ROM prend.** Une fonction qui, depuis la capacité du navigateur et le dossier éventuellement mémorisé, rend l'état à afficher : dossier configuré, dossier possible mais absent, ou dossier impossible. C'est la seule décision de cette conception qui peut être fausse sans qu'on le voie — un test la fixe, et il fixe aussi le cas qui casse deux navigateurs.

**La lecture et l'écriture du réglage d'affichage.** Un lecteur unique, partagé par la page et le menu, qui valide contre la liste des shaders connus et purge une valeur périmée — ce que les quatre lecteurs actuels font chacun de leur côté, dont un qui l'avait oublié jusqu'à ce qu'une revue le trouve. Une fonction, un test, quatre appelants.

**Non testable, et je le dis plutôt que de le maquiller :** la barre, la page, le menu déroulant, la disparition de la navbar. Vérification à la main, avec sa liste.

## Ce que cette conception refuse de faire

**Pas de salon.** Le salon sans jeu, l'invitation à un ami et le remplacement de l'ancien parcours sont le morceau B. Cette conception ne touche pas au modèle de salon.

**Pas de choix de manette.** Il existe déjà côté serveur — `RoomPlayer.port` vaut 1, 2 ou `null`, et un gestionnaire échange les ports quand celui demandé est occupé. L'exposer est le morceau C, et il dépend de B parce que le lancement est le moment où ça se décide.

**Pas d'indicateur de salon dans la barre.** Les deux avatars côte à côte demandent A et B. Morceau D.

**Pas de refonte de `FriendsList` ni de `ControlsSettings`.** Ils changent de contenant, pas de contenu. Les refondre au passage rendrait ce morceau irrelisable.

## Ce qui vient après

B, le salon sans jeu : rendre `gameId` et `gameTitle` optionnels dans le modèle, l'instantané qui restaure les salons au démarrage et la vue transmise au client ; une invitation avec accord, refus et expiration ; et la suppression de l'ancien parcours par le jeu.

C'est le morceau invasif, et c'est pourquoi celui-ci passe devant : l'habillage est autonome, il livre seul, et il touche l'accueil là où B touchera le serveur.
