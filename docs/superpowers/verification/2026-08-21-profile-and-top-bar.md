# Vérification — barre fine et page de profil

Branche `profile-and-top-bar`. Ce relevé sépare deux choses qu'il est tentant de mélanger : ce qu'une machine a vérifié, et ce que personne n'a encore regardé. La deuxième liste est la plus importante des deux, parce que l'essentiel de ce travail est de l'interface.

## Ce qui est vérifié mécaniquement

Commandes lancées sur `ba78238` :

```
npm run test:all              37 / 11 / 112 / 66  — 0 échec
npm run check --workspace frontend   0 erreur, 16 avertissements
npm run build --workspace frontend   build/profile.html écrit, terminé
```

Contrôles ciblés :

| Contrôle | Attendu | Obtenu |
|---|---|---|
| `grep -rn "psnes-shader" frontend/src --include=*.svelte` | rien — la clé ne vit plus que dans `shader-preference.ts` | rien |
| `grep -rn "AddGames\|showUpload" frontend/src` | rien — la modale est supprimée | rien |
| `grep -c "<LanguageSelector" frontend/src/routes/+page.svelte` | **1** | 1 |
| `grep -rn "async function register" frontend/src` | 1 — une seule copie | 1 |

Sur le dernier contrôle du tableau : le brief du plan demandait `grep -c "LanguageSelector"` égal à 1, ce qui est **inatteignable** — la commande compte des lignes et la ligne d'`import` contient le mot. La forme corrigée est celle du tableau. Un contrôle qui ne peut pas passer est aussi inutile qu'un contrôle qui ne peut pas échouer.

### Ce qui est couvert par des tests

Quatre fonctions pures, 22 tests dans `core/test/profile.test.ts` :

- `romSourceState` — quelle forme le panneau ROM prend. La branche `unsupported` est testée avec un dossier présent *et* l'accès accordé, donc le test prouve la priorité et pas seulement le cas heureux.
- `readShaderPreference` / `writeShaderPreference` — la lecture purge une valeur périmée, et le test l'affirme sur `removed`, pas seulement sur la valeur rendue.
- `pickerError` — un sélecteur annulé n'est pas une erreur. Le test qui compte est celui qui vérifie que la décision se prend sur le **nom** de l'erreur et non sur son texte.
- `romFileProblem` — extension et taille d'un fichier fourni par l'utilisateur. Deux cas y sont volontairement : un fichier **exactement** à la limite doit passer, et une extension en **majuscules** doit passer.

Les trois gardes ont été cassées exprès pour vérifier qu'elles échouent : remettre dans la liste un préréglage retiré fait tomber la suite à 12 réussites et 1 échec ; `pickerError` privée de son test de nom donne 16 réussites et 1 échec ; `romFileProblem` rendant toujours `null` donne 20 réussites et 2 échecs. Un test qui n'échoue jamais ne protège rien.

## Ce que personne n'a encore regardé

À faire dans un navigateur. Les deux premières lignes sont les plus importantes du document.

### Le chemin principal, celui qui a déjà été cassé une fois

- [ ] **Sur Chromium : choisir un dossier de ROM ajoute réellement les jeux à la bibliothèque.** Pas seulement « le dossier est mémorisé et son nom s'affiche » — que les jeux **apparaissent**. Ce comportement avait disparu à la suppression de la modale et a été restauré ; c'est le défaut le plus grave de ce travail et il venait de la conception, pas de l'exécution.
- [ ] La progression s'affiche pendant le scan, puis « N jeux ajoutés ». Un dossier de quarante cartouches n'est pas instantané, et le silence se lit comme un blocage.
- [ ] Un dossier vide dit qu'aucune ROM n'a été trouvée, et non un succès silencieux.
- [ ] Re-choisir le même dossier ne crée pas de doublons. Vérifié côté serveur (le checksum est cherché avant l'insertion, et un index unique double la protection), mais jamais vu à l'écran.
- [ ] Annuler le sélecteur de dossier avec Échap n'affiche **aucune** erreur.

### La chaîne des amis, qui n'a aucun test

- [ ] Ouvrir le tiroir des amis, cliquer un ami, ouvrir sa fiche, le supprimer — et vérifier qu'il disparaît vraiment. Cette chaîne repose sur `bind:this` et un appel de méthode partageant une portée. Si elle est cassée, le bouton a l'air d'avoir fonctionné et rien ne se passe : pas d'erreur, pas d'avertissement, aucun test rouge.
- [ ] Ajouter un ami et accepter une demande depuis le tiroir. Ces deux actions n'existent que dans la disposition complète de la liste ; la disposition compacte les masque.
- [ ] Le tiroir reste sous la barre quand on défile la page.
- [ ] Tiroir déroulant sur fenêtre large, plein écran sur fenêtre étroite.

### La barre et la page

- [ ] Connecté : la barre montre le titre, le bouton amis et l'avatar. Aucune barre latérale.
- [ ] L'avatar mène à `/profile` ; le lien retour ramène à la bibliothèque.
- [ ] `/profile` ouvert directement dans un onglet neuf fonctionne — c'est l'argument qui a fait de cette page une route plutôt qu'une modale, et c'est aussi ce qui faisait échouer le build avant `ba78238`.
- [ ] Le profil affiche l'avatar en grand, le nom et l'adresse.
- [ ] Les contrôles s'ouvrent, s'enregistrent, et survivent à un rechargement.
- [ ] Si le chargement des contrôles échoue, la section le dit au lieu de rester vide.
- [ ] Choisir un shader sur le profil, puis lancer une partie : le shader s'applique. C'est ce qui prouve que les deux vues partagent `localStorage`.
- [ ] Changer le shader dans le menu pause, puis revenir au profil : la nouvelle valeur y est.
- [ ] La mise à jour des métadonnées annonce son succès avec des nombres réels, ou son échec.

### La déconnexion, et son chemin d'échec

- [ ] Se déconnecter ramène à l'accueil.
- [ ] **Échec simulé** (couper le réseau dans les outils de développement, ou bloquer `POST /auth/logout`) : un message apparaît et la session **reste ouverte**. C'est le point qui compte : l'ancien code annonçait la déconnexion quoi qu'il arrive, donc sur une machine partagée il pouvait affirmer que la session était fermée alors qu'elle vivait encore côté serveur.
- [ ] Double-clic sur Déconnexion : le bouton se désactive au lieu d'envoyer deux requêtes.

### La contrainte qu'il est le plus facile de perdre

- [ ] **Déconnecté, l'accueil a toujours son sélecteur de langue.** Quelqu'un qui ne lit aucune des deux langues doit pouvoir changer de langue *avant* de se connecter, et la page de profil lui est inaccessible. Le contrôle mécanique du tableau garde cette ligne, mais il faut l'avoir vue.

### Sur Firefox ou Safari

- [ ] Le panneau dit qu'un dossier ne peut pas être mémorisé, et propose le chemin fichier par fichier.
- [ ] Ajouter un jeu par ce chemin, et le voir apparaître dans la bibliothèque. **Si ceci échoue, la bibliothèque est vide pour toujours sur ce navigateur** — c'est le pire résultat que ce travail puisse produire.
- [ ] Un fichier trop gros, et un fichier de mauvaise extension, sont refusés avec un message.

**À ne pas lire comme une régression** : sur un navigateur sans `showDirectoryPicker`, aucun dossier n'étant mémorisable, l'application redemande de localiser le fichier à chaque partie. C'était déjà le comportement avant ce travail. La tentation de le corriger ici serait une erreur de périmètre.

## Ce que ce travail ne fait pas

Changer d'avatar. Aucune API ne le permet aujourd'hui : le routeur d'avatars ne sert que des fichiers en lecture et l'avatar vient de Google. Le faire demande un point de téléversement, avec validation du type, plafond de taille et emplacement de stockage — une surface de fichier non fiable, qui mérite sa propre conception et sa propre revue plutôt que de voyager en passager dans un changement de mise en page.

## Défauts connus, laissés sciemment

- Le bouton « redonner l'accès » d'un dossier périmé relance le sélecteur complet au lieu de redemander seulement la permission sur la poignée déjà mémorisée. On peut donc devoir re-désigner un dossier déjà choisi.
- `pickerError` n'est pas adopté dans `LocateRom.svelte`, qui garde sa copie en ligne du test `AbortError`. L'extraction est donc à un site près d'être complète.
- Les messages de confirmation de sauvegarde du menu pause n'apparaissent jamais : personne n'écoute l'événement `notification` émis par `PauseMenu`. Antérieur à ce travail.

## Ce que ce travail a appris sur ses propres contrôles

Deux défauts n'ont été trouvés qu'ici, et tous deux parce que le contrôle qui aurait dû les attraper n'existait pas :

**Le build ne tournait dans aucun contrôle sauf le dernier.** `npm run check` type-vérifie, `npm run test:all` lance les tests unitaires ; ni l'un ni l'autre n'appelle le bundler — et le déploiement, lui, c'est `vite build`. La branche a passé six tâches en vert alors qu'elle ne compilait pas. Un contrôle qui tourne après chaque tâche sauf celle qui crée une route ne peut pas attraper une erreur de route. Le build appartient à chaque contrôle, et au minimum à toute tâche qui ajoute une route.

**`noUnusedLocals` est désactivé dans ce projet** (`frontend/tsconfig.json` ne pose que `strict`). Une fonction dont le dernier appelant disparaît ne produit donc ni erreur ni avertissement. Après une suppression de 524 lignes, un `npm run check` vert ne dit rien du code mort — seul un balayage explicite des symboles le dit. Les sélecteurs CSS inutilisés, eux, sont bien signalés, en avertissements : c'est pourquoi le compteur qui descend de 19 à 16 est une information et pas du bruit.
