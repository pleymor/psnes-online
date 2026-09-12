/*
 * Le défilement de chaque calque, la deuxième fenêtre sur les entrailles de
 * snes9x - et pour la même raison que la première.
 *
 * `gfx_depth.cpp` dit quel calque a gagné chaque pixel. Ce fichier dit de
 * combien chaque calque a défilé, ce qui est la seule information qui permette
 * de savoir OÙ, dans l'image d'avant, se trouvait ce que le pixel d'aujourd'hui
 * cache. C'est ce qui remplit les trous du relief avec du vrai décor plutôt
 * qu'avec une bavure.
 *
 * Lecture seule, et appelé seulement après que `retro_run()` a fini une frame.
 * Il ne change aucun état de l'émulateur, donc un cœur bâti avec ce fichier
 * produit toujours des frames et des savestates bit à bit identiques - la
 * propriété sur laquelle repose le netplay en lockstep.
 *
 * POURQUOI `ppu.h` ET NON `FillRAM`. `gfx_depth.cpp` lit le mode directement
 * dans le fichier de registres, pour s'épargner cet en-tête. Impossible ici :
 * les registres $210D-$2114 s'écrivent en DEUX fois, à travers un verrou, et
 * FillRAM ne garde que le dernier octet écrit - jamais le décalage résolu.
 * Seul `PPU.BG[n]` porte la valeur que le PPU a réellement employée.
 *
 * CE QUE CETTE VALEUR NE DIT PAS. C'est le défilement à la FIN de la frame. Le
 * HDMA en change en cours d'écran - c'est ainsi que se font les parallaxes par
 * ligne et le ciel dégradé de Super Mario World - et une seule valeur par
 * calque ne décrit pas ces images-là. L'appelant doit donc vérifier sa
 * prédiction plutôt que d'y croire : voir `vr/slot-memory.ts`, qui jette sa
 * mémoire quand elle diverge de ce que le calque vient réellement de dessiner.
 */

/* `snes9x.h` d'abord : `ppu.h` emploie les types de base de snes9x - uint32 et
 * consorts - sans les définir lui-même, donc l'inclure seul ne compile pas.
 * C'est l'ordre que gfx.cpp emploie. */
#include "snes9x.h"
#include "ppu.h"

extern "C" {

/*
 * Les huit valeurs, dans l'ordre : BG1 H, BG1 V, BG2 H, ... BG4 V.
 *
 * Écrites dans un tampon fourni plutôt que rendues par un pointeur sur les
 * entrailles : `PPU` est un état vivant que la frame suivante écrase, alors
 * qu'un tampon recopié appartient à l'appelant.
 */
void pn_gfx_bg_scroll(unsigned short *out)
{
    int i;
    if (!out) return;
    for (i = 0; i < 4; i++)
    {
        out[i * 2]     = (unsigned short)PPU.BG[i].HOffset;
        out[i * 2 + 1] = (unsigned short)PPU.BG[i].VOffset;
    }
}

}
