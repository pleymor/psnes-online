interface CoreInfo {
  cheats?: true
  corename?: string
  savestate?: true
  supportsNoGame?: true
}

/**
 * SNES emulator cores information.
 * Only includes cores relevant for SNES emulation.
 */
export const coreInfoMap: Record<string, CoreInfo> = {
  // bsnes family - High accuracy SNES emulators
  bsnes: { savestate: true },
  bsnes_cplusplus98: { cheats: true, corename: 'bsnes C++98 (v085)', savestate: true },
  bsnes_hd_beta: { corename: 'bsnes-hd beta', savestate: true },
  bsnes_mercury_accuracy: { cheats: true, corename: 'bsnes-mercury Accuracy', savestate: true },
  bsnes_mercury_balanced: { cheats: true, corename: 'bsnes-mercury Balanced', savestate: true },
  bsnes_mercury_performance: { cheats: true, corename: 'bsnes-mercury Performance', savestate: true },
  bsnes2014_accuracy: { cheats: true, corename: 'bsnes 2014 Accuracy', savestate: true },
  bsnes2014_balanced: { cheats: true, corename: 'bsnes 2014 Balanced', savestate: true },
  bsnes2014_performance: { cheats: true, corename: 'bsnes 2014 Performance', savestate: true },

  // Snes9x family - Fast and compatible SNES emulators
  snes9x: { cheats: true, corename: 'Snes9x', savestate: true },
  snes9x2002: { cheats: true, corename: 'Snes9x 2002', savestate: true },
  snes9x2005: { cheats: true, corename: 'Snes9x 2005', savestate: true },
  snes9x2005_plus: { cheats: true, corename: 'Snes9x 2005 Plus', savestate: true },
  snes9x2010: { cheats: true, corename: 'Snes9x 2010', savestate: true },

  // Other SNES cores
  chimerasnes: { cheats: true, corename: 'ChimeraSNES', savestate: true },
  higan_sfc: { corename: 'nSide (Super Famicom Accuracy)', savestate: true },
  higan_sfc_balanced: { corename: 'nSide (Super Famicom Balanced)', savestate: true },
  mednafen_snes: { corename: 'Beetle bsnes', savestate: true },
  mednafen_supafaust: { cheats: true, corename: 'Beetle Supafaust', savestate: true },
  'mesen-s': { corename: 'Mesen-S' },
}
