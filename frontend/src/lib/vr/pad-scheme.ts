/**
 * Which Touch preset drives the four SNES action buttons.
 *
 * The issue said not to offer controls settings at all. Choosing between two
 * presets is not rebinding button by button: nobody has to build a mapping, but
 * a player whose thumb lands on the wrong button can fix it in one click. That
 * is the whole of the rectification.
 *
 * The storage discipline is `stores/shader-preference.ts`'s, quoted there:
 * "Removing rather than storing an empty string means no reader has to treat ''
 * and absent as the same thing - which is exactly the sort of equivalence one
 * of four readers eventually forgets."
 *
 * localStorage rather than the account, for v1: no schema change and no
 * migration for a setting that exists in one mode. The honest cost is two
 * headsets, two settings.
 */

import type { PreferenceStorage } from '$lib/stores/shader-preference';

export type VrPadScheme = 'letters' | 'thumb';

export const VR_PAD_KEY = 'psnes-vr-pad';

/** The one a player gets without asking. */
const DEFAULT_SCHEME: VrPadScheme = 'letters';

const SCHEMES: readonly VrPadScheme[] = ['letters', 'thumb'];

function isScheme(value: string): value is VrPadScheme {
  return (SCHEMES as readonly string[]).includes(value);
}

export function readPadScheme(storage: PreferenceStorage): VrPadScheme {
  const stored = storage.getItem(VR_PAD_KEY);
  if (!stored) return DEFAULT_SCHEME;
  if (!isScheme(stored)) {
    storage.removeItem(VR_PAD_KEY);
    return DEFAULT_SCHEME;
  }
  return stored;
}

export function writePadScheme(storage: PreferenceStorage, scheme: VrPadScheme): void {
  if (scheme === DEFAULT_SCHEME) {
    storage.removeItem(VR_PAD_KEY);
    return;
  }
  if (!isScheme(scheme)) return;
  storage.setItem(VR_PAD_KEY, scheme);
}
