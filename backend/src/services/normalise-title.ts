/**
 * Normalizes a game title for better matching
 * Removes region tags, version numbers, and other common suffixes
 *
 * Sorti de `metadata-loader.ts`, où il vivait, pour que `catalogue-index.ts`
 * puisse l'appeler sans fermer un cycle d'imports : le chargeur dépend
 * désormais de l'index, et l'index de cette fonction-ci.
 */
export function normalizeTitle(title: string): string {
  let normalized = title.toLowerCase().trim();

  // Remove file extensions
  normalized = normalized.replace(/\.(smc|sfc|fig|swc|mgd|zip)$/i, '');

  // Remove common suffixes like "# SNES", "# NES", etc.
  normalized = normalized.replace(/\s*#\s*(snes|nes|n64|sfc|gb|gba|gbc|genesis|sega|md)$/gi, '');

  // Remove region tags including language tags
  normalized = normalized.replace(/\s*\((usa|europe|japan|france|germany|spain|italy|uk|world|ntsc|pal|ntsc-j|eur|jpn|usa, europe|eng|fr|de|es|it|pt|beta|proto|unl)\)/gi, '');

  // Remove version/revision tags
  normalized = normalized.replace(/\s*\((rev\s*\d+|v\d+\.\d+|version\s*\d+)\)/gi, '');

  // Remove bracket numbers [!], [b1], etc.
  normalized = normalized.replace(/\s*\[!?\d*\]/g, '');

  // Remove "The" prefix for better matching
  normalized = normalized.replace(/^the\s+/i, '');

  // Normalize punctuation - replace colons, dashes, apostrophes with spaces
  normalized = normalized.replace(/[:'\-–—]/g, ' ');

  // Remove other punctuation
  normalized = normalized.replace(/[.,!?;()]/g, '');

  // Fix common spelling variations
  normalized = normalized.replace(/butouden/g, 'butoden');
  normalized = normalized.replace(/street fighter ii'/g, 'street fighter ii');

  // Remove extra spaces and trim
  normalized = normalized.replace(/\s+/g, ' ').trim();

  return normalized;
}
