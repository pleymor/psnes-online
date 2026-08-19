/**
 * Which save slot to offer, and what each slot currently holds.
 *
 * This lived in SavesManager.svelte as a reactive block that assigned
 * `selectedSlot` while reading `availableSlots`. Svelte treats that as one
 * dependency graph: the <select> binding invalidated `availableSlots` as well
 * as `selectedSlot`, the block re-ran, and it wrote the default back over
 * whatever the player had just clicked. The picker is a function of the saves
 * and nothing else, so it belongs here - out of the framework's reach, and
 * testable without a browser.
 */

/** Ten slots, matching the badge the saves list already prints. */
export const SLOT_COUNT = 10;

/** The little a slot needs to know about a save. Callers may pass richer objects. */
export interface SaveLike {
  slotNumber: number;
  updatedAt: string;
}

export interface Slot<T extends SaveLike> {
  slotNumber: number;
  /** The save occupying this slot, or null when it is free. */
  save: T | null;
}

function inRange(slotNumber: number): boolean {
  return Number.isInteger(slotNumber) && slotNumber >= 1 && slotNumber <= SLOT_COUNT;
}

/**
 * Every slot, in order, each carrying its save.
 *
 * All ten are always returned - including the occupied ones. Overwriting is a
 * normal thing to want, and the previous version, which listed only free
 * slots, made it unreachable once the tenth was used.
 */
export function buildSlots<T extends SaveLike>(saves: T[]): Slot<T>[] {
  const bySlot = new Map<number, T>();
  for (const save of saves) {
    if (inRange(save.slotNumber)) {
      bySlot.set(save.slotNumber, save);
    }
  }

  return Array.from({ length: SLOT_COUNT }, (_, i) => ({
    slotNumber: i + 1,
    save: bySlot.get(i + 1) ?? null
  }));
}

/**
 * The slot to preselect: the first free one, or the oldest save if none is free.
 *
 * Falling back to the oldest is what makes the picker roll - a full library
 * keeps working, and the save the player is least likely to miss is the one
 * offered up. Ties go to the lowest slot number so the choice is stable.
 */
export function pickDefaultSlot(saves: SaveLike[]): number {
  const slots = buildSlots(saves);

  const free = slots.find(slot => slot.save === null);
  if (free) {
    return free.slotNumber;
  }

  let oldest = slots[0];
  for (const slot of slots) {
    if (slot.save!.updatedAt < oldest.save!.updatedAt) {
      oldest = slot;
    }
  }
  return oldest.slotNumber;
}
