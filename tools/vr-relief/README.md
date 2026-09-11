# Relief VR — sonde

Un banc d'essai pour une seule question : **peut-on rendre une frame SNES en
relief dans le casque, en séparant ses calques dans l'espace ?**

Il capture quelques frames d'un vrai jeu, en sort le plan de calques que le PPU
a lui-même calculé, et sert une page où l'on écarte les plans à la main.

```bash
bun run vr:relief      # capture, construit la page, sert sur :5275
```

Il faut une ROM : `core/test/roms/`, `backend/roms/`, ou `PSNES_TEST_ROM`. La
capture est muette si elle n'en trouve aucune.

## Ce qu'il y a à voir

Deux réglages portent tout le résultat.

**Les Z-index, par couple (calque, priorité).** Pas par calque : dans Super
Mario All-Stars, le HUD et les nuages sont tous deux BG3, à deux priorités
différentes. Un réglage par calque mettrait le HUD à la distance des nuages.
Le preset JSON en bas du panneau est ce qu'un jeu aurait à retenir.

**Les calques complets.** Un calque n'est dessiné que là où il a gagné le
pixel, donc tout ce qui est devant lui y laisse un trou — et un trou est
exactement ce que le joueur voit à travers quand les plans s'écartent. Rien
dans la frame ne dit ce qu'il y avait derrière : le PPU n'a dessiné ce pixel
qu'une fois, en tant que chose de devant. Chaque calque est donc étendu dans
ses propres trous par dilatation. Décocher la case montre la vérité brute.

Trois façons d'obtenir la vraie information ont été pesées :

1. Re-rendre la frame calque par calque avec `Settings.BG_Forced` — exact, mais
   il faut rejouer la frame depuis un savestate, et les effets raster (le
   dégradé du ciel de Mario en est un) se perdent.
2. Accumuler d'une frame à l'autre en reprojetant par les registres de scroll
   de chaque BG : ce qui est caché maintenant était visible il y a quelques
   frames. C'est la vraie réponse, et elle n'est pas implémentée.
3. La dilatation, ci-dessus. Approximatif — un fond SNES est tuilé, donc le
   prolonger se voit peu, sauf là où le calque avait une arête franche contre
   un trou : il reste une bavure.

## D'où vient la profondeur

`GFX.ZBuffer`, un octet par pixel, remis à zéro au début de chaque frame
(`gfx.cpp`, `S9xStartScreenRefresh`) et rempli au fil des scanlines avec la
priorité du calque qui a gagné le pixel. Le core l'expose en lecture seule
(`core/src/gfx_depth.cpp`, `pn_depth()`), et la traduction priorité → calque
est dans `frontend/src/lib/vr/layer-map.ts`.

Trois choses se sont révélées non négociables, chacune après un faux départ :

- **Il faut lire les deux tampons.** Beaucoup de jeux — celui-ci compris —
  dessinent l'essentiel de leurs calques sur le *sub-screen* et les ramènent
  par color math. Lire `GFX.ZBuffer` seul rend un plan uniformément plat, ce
  qui ressemble à « c'est impossible » et ne l'est pas.
- **Il faut le décalage d'overscan.** libretro remet la frame 7 lignes plus bas
  dans `GFX.Screen` ; lire le ZBuffer à partir de la ligne 0 décale tout le
  masque vers le bas. `pn_depth()` retrouve le décalage depuis le pointeur
  qu'on lui passe.
- **La priorité ne nomme pas un calque sans le mode BG.** En mode 1 BG1 vaut
  47/43 ; en mode 3, 43 est BG2. D'où `pn_depth_bg_mode()`.

## Le coût dans le casque

La crainte était que dix plans en plein écran avec du recouvrement, chacun
échantillonnant deux textures, ne tiennent pas la cadence. **Essayé sur un
Quest en production le 2026-09-11 : la cadence tient.** C'est un constat du
propriétaire du casque, pas un relevé chiffré — personne n'a lu un compteur
de frames — mais c'en est un de première main, là où tout le reste de ce
fichier vient d'une machine de bureau.

L'optimisation qui était préparée n'a donc pas eu à être faite : ne créer que
les plans réellement présents dans la frame plutôt que les dix. Un plan sur
deux ne sert à rien dans un jeu donné, et `slot-mask.ts` renvoie déjà la
liste dans `present`. Elle reste le premier levier si un jeu plus chargé fait
céder la cadence un jour.

La page, elle, ne dira jamais rien du coût : elle affiche une frame figée.

