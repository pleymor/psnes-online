/**
 * Le registre de tout l'art du décor.
 *
 * Deux consommateurs, et c'est ce qui justifie qu'il existe. Les invariants
 * (`vr-decor-art.test.ts`) le balaient, donc un motif inscrit ici est vérifié
 * sans que le test le connaisse. Et l'atlas (`atlas.ts`) s'en sert de source,
 * donc un motif inscrit ici obtient sa place dans la texture sans que le code
 * de rendu change.
 *
 * Le corollaire est la seule règle à retenir : **un motif qui n'est pas ici
 * n'est ni vérifié ni rangé.**
 */
import type { Art } from '../pixels';
import { GROUND_BRICK, GROUND_TURF } from './ground';

export const ALL_ART: Readonly<Record<string, Art>> = {
  groundBrick: GROUND_BRICK,
  groundTurf: GROUND_TURF
};

export type ArtName = keyof typeof ALL_ART;
