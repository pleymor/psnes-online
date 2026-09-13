# Un centre de notifications — design

Six surfaces de notification cohabitent aujourd'hui, dont deux se recopient et
trois s'ignorent. Il en reste une : un store, un toast, une cloche dans la barre
du haut, et une pastille qui dit combien.

## §0. Ce qui existe, et pourquoi ça ne tient plus

| Surface | Fichier | Boutons | Durée |
|---|---|---|---|
| Store central + toast | `services/notification.ts`, `components/NotificationToast.svelte` | non | 3 s |
| Toast de l'accueil | `routes/+page.svelte` (`showToast`, `toastType`, ✅/❌) | non | 3 s |
| Toast du salon | `routes/room/[id]/+page.svelte` (mêmes noms, autre CSS) | non | 3 s |
| Invitation | `components/InvitationCard.svelte` | Accepter / Refuser | 10 min |
| Offre de jeu | `components/ShareOffer.svelte` | Recevoir / Non merci | tant que l'offre tient |
| Garder la ROM | `components/KeepRomOffer.svelte` | Garder / Non merci | tant qu'on n'a pas répondu |
| VR | `VrShell.svelte` l. 774 | non | miroir du store |

Le store central est déjà appelé depuis huit fichiers
(`quick-actions.ts`, `SaveGameMenu`, `LoadSavesMenu`, `TopBar`, `VrShell`,
`SoloRoom`, `room/[id]/+page.svelte`). Les deux toasts maison ne sont pas une
variante : ce sont deux réimplémentations du même store, avec deux feuilles de
style et deux `setTimeout`. Les trois cartes à boutons, elles, ne sont pas des
doublons — ce sont trois conversations différentes — mais chacune a inventé sa
position fixe, son fond, sa typographie et sa règle de disparition.

**Rien ne se rattrape.** Un toast manqué est perdu ; une carte fermée aussi ;
et un rechargement vide tout. C'est ce que la cloche corrige.

## §1. Le retour en arrière, assumé

`InvitationCard.svelte` porte cette phrase, écrite au moment où elle a été
créée :

> « The badge-and-drawer it replaces was two clicks, on two pages out of the
> whole application. »

La pastille-et-tiroir a donc **déjà été retirée**, et ce design la ramène. Ce
n'est pas un oubli, et il faut dire ce qui a changé pour que la conclusion
s'inverse :

- **Le tiroir d'alors vivait dans `TopBar` et ne portait que les invitations**,
  sur deux pages. La cloche d'ici porte tout, partout, y compris ce qu'aucune
  carte n'a jamais rattrapé — un « échec de sauvegarde » passé pendant qu'on
  regardait ailleurs.
- **Le grief était le coût d'acceptation, pas la pastille.** Il tient toujours :
  répondre depuis le centre coûtera deux clics. Le toast qui passe en garde un
  seul, et c'est lui qui porte la réponse dans le cas courant — celui où l'on
  est devant l'écran quand l'invitation arrive.

**Ce que ça coûte, écrit noir sur blanc :** quelqu'un qui regarde ailleurs
pendant les secondes du toast paiera un clic de plus qu'aujourd'hui pour
accepter une invitation. C'est le prix de l'écran calme demandé, et c'est un
prix, pas un gain déguisé.

## §2. Une notification est une donnée

C'est la contrainte qui décide de toute la forme : **le centre survit au
rechargement**, donc une notification doit s'écrire dans `localStorage`, donc
elle ne peut pas contenir ses actions — une fonction ne se sérialise pas.

Elle les **nomme** :

```ts
export interface Notice {
  readonly id: string;
  /** Ce que c'est. Décide du texte, des boutons, et de ce qu'ils font. */
  readonly kind: NoticeKind;
  /** De quoi rendre le texte et rappeler l'action. Sérialisable, toujours. */
  readonly params: Record<string, string | number>;
  /** Quand elle est née, pour l'ordre et pour la purge. */
  readonly at: number;
  /** Après quoi elle ne vaut plus rien. Absent = pas d'échéance. */
  readonly expiresAt?: number;
}
```

Le registre, à côté, est la seule chose qui ne se sérialise pas — et n'en a
pas besoin, puisqu'il est dans le code :

```ts
export interface NoticeShape {
  /** Le texte, dans la langue courante. */
  text(params: Notice['params'], lang: Lang): string;
  /** Le ton, pour la couleur. */
  tone: 'info' | 'success' | 'error' | 'warning';
  /** Les boutons, s'il y en a. Vide = notification à lire. */
  actions?: readonly NoticeAction[];
}

export interface NoticeAction {
  /** La clé du libellé. */
  readonly label: TranslationKey;
  readonly primary?: boolean;
  /** Ce que fait le clic. Appelée avec les `params` de la notification. */
  run(params: Notice['params']): void | Promise<void>;
}
```

**Ajouter une notification, c'est ajouter une entrée à `NOTICE_SHAPES`.** Un
seul endroit, et le compilateur exige `text` et `tone`. C'est ce qui remplace
« chacun invente sa carte ».

### Pourquoi pas une référence de composant

Un store qui garderait `{ component, props }` serait plus direct et rendrait
n'importe quoi. Il ne se sérialise pas : au rechargement il ne resterait que les
props, sans rien pour les peindre. La persistance demandée l'exclut — ce n'est
pas un goût.

### Ce que le registre ne peut pas porter

Une action qui a besoin d'une **activation transitoire** du navigateur ne
survit pas au rechargement : `ShareOffer` demande l'accès en écriture au dossier
de ROMs au clic sur « Le recevoir », et `requestPermission` exige un geste
récent. Ce n'est pas un problème — l'action reste déclenchée par un vrai clic,
sur le bouton de la notification. Ce qui ne survit pas, c'est l'offre elle-même :
la socket qui la portait est morte avec l'onglet. Voir §5.

## §3. L'API existante ne bouge pas

```ts
notifications.show(message, type, duration)
```

reste, mot pour mot. Elle devient un `kind` particulier — `'raw'` — dont les
`params` portent le message déjà traduit. Les huit appelants ne sont pas
touchés, et `VrShell` continue de lire `$notifications.at(-1)?.message`.

**C'est ce qui rend ce chantier faisable.** Réécrire les huit appelants en même
temps que la charpente, c'est deux chantiers dans un.

Les deux toasts maison, eux, disparaissent : `showToast`, `toastMessage`,
`toastType`, leur `setTimeout` et leur CSS, dans `routes/+page.svelte` et
`routes/room/[id]/+page.svelte`. Leurs appelants passent par `show()`.

## §4. Les trois cartes deviennent trois `kind`

Elles gardent leur logique — `lobby/invitations.ts`, `roms/sharing.ts`,
`roms/keep-offer.ts` sont inchangés — et perdent leur rendu.

| `kind` | Source | Actions |
|---|---|---|
| `invitation` | `invitations` (socket) | `acceptInvitation(id)` / `declineInvitation(id)` |
| `share-offer` | `sharing().offered` | `sharing().accept()` / `sharing().decline()` |
| `keep-rom` | `createKeepOffer()` | `offer.accept()` / `offer.decline()` |

Un pont par source, qui la suit et pose ou retire la notification. Trois
composants supprimés (`InvitationCard`, `ShareOffer`, `KeepRomOffer`), un seul
qui peint.

**`KeepRomOffer` a une particularité à ne pas perdre** : elle est posée pendant
qu'une partie tourne, et son commentaire explique qu'elle est délibérément non
modale pour cette raison. Le centre hérite de la même règle — voir §7.

## §5. Ce qui se persiste, et ce qui se retrouve

`localStorage`, clé `psnes-notices`, sous la forme des préférences de `stores/` :
le module **prend son stockage** plutôt que d'attraper `localStorage`, donc il
se teste sous Bun sans navigateur, comme `share-consent.ts` et
`aspect-preference.ts`.

Trois règles à la lecture :

1. **Ce qui a une échéance dépassée ne ressort pas** — une invitation vaut dix
   minutes, et le serveur refusera celle que le centre proposerait encore.
   `expiresAt` sert surtout **en mémoire** : c'est l'horloge de quinze secondes
   qu'`InvitationCard` tenait elle-même, pour qu'une invitation périmée quitte
   l'écran alors qu'aucun message ne vient l'annoncer — il ne s'est rien passé
   sur le serveur. Le centre hérite de cette horloge ; la règle vaut aussi à la
   relecture, pour le jour où quelque chose de daté se persistera.
2. **Ce qui dépend d'une session morte ne ressort pas.** `share-offer` et
   `keep-rom` vivent sur une socket et une offre en cours : au rechargement
   elles n'ont plus d'interlocuteur. Elles portent un drapeau `live: true` dans
   leur `NoticeShape` et sont purgées au démarrage.
3. **`invitation` ressort sans être relue du stockage**, parce que le serveur la
   renvoie à la reconnexion : le pont la reposera. La persister servirait
   surtout à l'afficher deux fois.

Il ne reste donc en pratique que les notifications à lire. C'est cohérent avec
ce qu'on rattrape : ce qu'on a manqué, pas ce à quoi on doit répondre.

## §6. La cloche, la pastille, et la lecture

Dans `TopBar`, à côté de ce qui s'y trouve déjà.

- **La pastille compte ce que contient le centre.** À l'ouverture, les
  notifications **sans** bouton sont consommées ; celles **avec** restent
  jusqu'au clic sur un de leurs boutons. La pastille retombe donc au nombre de
  demandes en attente, ce qui est exactement ce qu'elle doit dire : « il reste
  des choses à répondre ».
- **Consommer à la fermeture, pas à l'ouverture.** C'est la nuance que la règle
  fait apparaître : vidées à l'ouverture, elles s'effaceraient sous les yeux de
  celui qui vient les lire. Ce qui est là à l'ouverture y reste jusqu'à la
  fermeture, et c'est à la fermeture que les notifications sans bouton sont
  retirées. **Ce qui arrive pendant que le centre est ouvert s'y ajoute**,
  visiblement, et sera consommé à la fermeture comme le reste : figer la liste
  au point de masquer ce qui arrive ferait mentir la pastille.
- **Zéro notification, zéro cloche ?** Non : la cloche reste, sans pastille. Un
  élément de barre qui apparaît et disparaît fait sauter la mise en page, et une
  cloche muette dit « rien de nouveau », ce qui est une information.

## §7. Pendant une partie

`InvitationCard` se retire quand `$inGame` — « a panel over an emulator steals a
click, and accepting would walk the player out of the match ». La règle est
juste et vaut pour toutes les notifications à boutons : le toast ne s'affiche
pas pendant une partie, la notification va directement au centre, la pastille
s'incrémente.

Une exception, celle qui existe déjà : `keep-rom` est née pendant une partie et
doit s'y répondre. Son `NoticeShape` porte `duringGame: true`.

## §8. Ce qui se teste, et ce qui ne se teste pas

Sous Bun, dans `core/test/` — et le fichier doit être **nommé dans `test:ui`**
de `package.json`, sans quoi il ne tourne jamais.

Testable, et c'est l'essentiel de la logique :

- le store : poser, retirer, ordonner, compter ;
- la consommation : ouvrir fige, fermer vide ce qui n'a pas de bouton ;
- la persistance : ce qui s'écrit, ce qui se relit, ce qui se purge (échéance
  dépassée, `live`, entrée illisible) ;
- le registre : tout `kind` a un texte dans les deux langues — un test de parité
  comme `i18n-parity.test.ts`, qui attrape le `kind` ajouté sans traduction ;
- les ponts : une invitation qui arrive pose une notification, une invitation
  acceptée la retire.

Non testable ici, et à regarder dans un navigateur : la cloche, la pastille, la
pile de toasts, et le fait que la carte ne vole pas un clic à l'émulateur. Ce
dépôt a déjà livré un bouton sans habillage qu'aucun test ne voyait
(`GameDetailsModal`, `.share`) — la vérification visuelle n'est pas optionnelle.

## §9. Hors périmètre

- **La VR.** `VrShell` lit la dernière ligne du store et l'affiche sur le
  bandeau du pupitre ; tant que le store garde sa forme, elle continue de
  marcher sans rien changer. Pas de cloche dans le casque : le lobby VR a son
  propre système de pupitres, et y greffer un centre est un autre sujet.
- **Les notifications système du navigateur** (`Notification` du navigateur,
  service worker). Rien ne les demande ici.
- **Le compte plutôt que l'appareil.** Retrouver ses notifications sur un autre
  appareil demande une table, une route et une migration. Écarté au profit du
  stockage local — ce qui suffit à la règle demandée, « survivre au
  rechargement ».
