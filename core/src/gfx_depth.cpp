/*
 * The one window this frontend opens onto snes9x's internals.
 *
 * Everything else in this core goes through libretro, which hands over a
 * composited frame and nothing more. But the PPU already computes, per pixel,
 * which layer and which priority won it - that is how it composites at all -
 * and it keeps the answer in GFX.ZBuffer, one byte per pixel, cleared at the
 * start of every frame (gfx.cpp, S9xStartScreenRefresh). Reading it is free;
 * recovering it from the outside is not possible at all.
 *
 * Read-only, and called only after retro_run() has finished a frame. It
 * changes no emulator state, so a core built with this file still produces
 * bit-identical frames and savestates - the property lockstep netplay rests
 * on.
 *
 * C++ because gfx.h is reached the way the rest of snes9x reaches it; the
 * accessors are extern "C" so psnes_core.c can call them.
 */

#include "gfx.h"

/* snes9x's own handle on the PPU register file, already in C linkage because
 * tile.c reads it. Including ppu.h to reach PPU.BGMode instead drags in
 * cpuexec.h and half the emulator; the register is the same fact and 0x2105 is
 * where PPU.BGMode is set from (ppu.cpp, case 0x2105). */
extern "C" unsigned char *tile_FillRAM;

extern "C" {

/*
 * The BG mode, because the priority byte alone does not name a layer.
 *
 * snes9x writes D + Zh or D + Zl, and the (Zh, Zl) pair a background gets
 * depends on the mode: in mode 1, BG1 is 47/43 and BG2 46/42; in mode 3, BG1
 * is 47/39 and BG2 43/35. So 43 means BG1 in one mode and BG2 in the other,
 * and any table that maps priority to a distance has to be read together with
 * the mode that produced it.
 *
 * BG3Priority comes along because mode 1 uses it to move BG3 from 7 to 17 -
 * the trick that floats a status bar over everything.
 *
 * This is the mode at the END of the frame. A game that changes mode partway
 * down the screen - a mode 7 playfield under a mode 1 HUD is the usual shape -
 * renders rows this value does not describe.
 */
unsigned int pn_gfx_bg_mode(void)
{
    return tile_FillRAM ? (unsigned int)(tile_FillRAM[0x2105] & 0x07) : 0u;
}

unsigned int pn_gfx_bg3_priority(void)
{
    return tile_FillRAM && (tile_FillRAM[0x2105] & 0x08) ? 1u : 0u;
}

const unsigned char  *pn_gfx_zbuffer(void)    { return GFX.ZBuffer; }
const unsigned char  *pn_gfx_subzbuffer(void) { return GFX.SubZBuffer; }
const unsigned short *pn_gfx_screen(void)     { return GFX.Screen; }
unsigned int          pn_gfx_real_ppl(void)   { return GFX.RealPPL; }
unsigned int          pn_gfx_screen_size(void){ return GFX.ScreenSize; }

}
