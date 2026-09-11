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
import { HILL_LARGE, HILL_SMALL, BUSH, CLOUD } from './scenery';
import {
  PIPE_SHAFT,
  PIPE_SHAFT_SIDE,
  PIPE_LIP,
  PIPE_LIP_SIDE,
  QUESTION_BLOCK,
  BLOCK_SIDE
} from './props';

export const ALL_ART: Readonly<Record<string, Art>> = {
  groundBrick: GROUND_BRICK,
  groundTurf: GROUND_TURF,
  hillLarge: HILL_LARGE,
  hillSmall: HILL_SMALL,
  bush: BUSH,
  cloud: CLOUD,
  pipeShaft: PIPE_SHAFT,
  pipeShaftSide: PIPE_SHAFT_SIDE,
  pipeLip: PIPE_LIP,
  pipeLipSide: PIPE_LIP_SIDE,
  questionBlock: QUESTION_BLOCK,
  blockSide: BLOCK_SIDE
};

export type ArtName = keyof typeof ALL_ART;
