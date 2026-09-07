/**
 * Pourquoi la session bascule en room zone, mesuré plutôt que supposé.
 *
 * Symptôme rapporté depuis le casque : à l'entrée, la session est stationnaire
 * une fraction de seconde puis passe en room zone, et il faut sortir de la
 * zone pour se voir proposer de revenir en stationnaire.
 *
 * L'énumération complète de ce que cette page demande à WebXR est courte :
 * `support.ts` appelle `isSessionSupported`, `xr-session.ts` appelle
 * `requestSession('immersive-vr')` SANS dictionnaire d'init, puis
 * `requestReferenceSpace('local')`, et three en demande un second, du même
 * type. Aucune demande de sol, aucune limite, aucune feature optionnelle,
 * nulle part. La page demande donc le strict minimum, et trois passages sur ce
 * sujet ont conclu qu'aucune API web n'atteint la boîte de dialogue système.
 *
 * Ce module existe pour trancher avec des données plutôt qu'une quatrième
 * hypothèse. Il est temporaire : une fois la question réglée, il part.
 *
 * L'ORDRE est la seule chose subtile ici. Demander `bounded-floor` est
 * peut-être exactement ce qui provisionne la roomscale, donc la sonde tombe
 * APRÈS la fenêtre d'observation - un instrument qui mesure sa propre
 * conséquence est pire que pas d'instrument. `vr-boundary-probe.test.ts` le
 * vérifie plutôt que de le laisser à la vigilance du prochain lecteur.
 */

/** Combien de temps l'état de visibilité est échantillonné. */
export const SAMPLE_WINDOW_MS = 2500;
const SAMPLE_EVERY_MS = 100;
/** Quand la sonde tombe : après la fenêtre, pour ne rien provoquer dedans. */
export const PROBE_DELAY_MS = 3000;

export interface Sample {
  /** Millisecondes depuis l'octroi de la session. */
  at: number;
  state: string;
}

/**
 * Les seuls échantillons qui apprennent quelque chose : les changements.
 *
 * Vingt-cinq tics identiques noieraient la transition qu'on cherche, et
 * `log-shipper.ts` lotit par cent entrées - un échantillonnage brut par
 * session en dépenserait un quart pour rien.
 */
export function transitions(samples: readonly Sample[]): Sample[] {
  const kept: Sample[] = [];
  let last: string | null = null;
  for (const sample of samples) {
    if (sample.state === last) continue;
    kept.push(sample);
    last = sample.state;
  }
  return kept;
}

/** Le peu de `XRSession` que ce module touche. */
export interface ProbeableSession {
  visibilityState: string;
  requestReferenceSpace(type: string): Promise<unknown>;
}

export interface BoundaryReport {
  /** Les changements d'état de visibilité sur la fenêtre. */
  visibility: Sample[];
  /**
   * Ce que le runtime accorde alors qu'on ne l'a jamais demandé.
   *
   * La spec dit qu'une feature non demandée doit être REFUSÉE. Un succès ici
   * prouverait donc que le runtime a provisionné la roomscale de lui-même, ce
   * qui répondrait à la question - et rendrait la page innocente.
   */
  grants: Record<string, string>;
  /** Combien de points la limite déclare, quand il y en a une. */
  boundsPoints: number | null;
}

/**
 * Observe la session, puis la sonde, et rend un rapport.
 *
 * `now` et `sleep` sont des paramètres pour la raison que tout ce dossier
 * donne : pour être exerçable sans casque.
 */
export async function probeBoundary(
  session: ProbeableSession,
  now: () => number = () => Date.now(),
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms))
): Promise<BoundaryReport> {
  const start = now();
  const samples: Sample[] = [];

  while (now() - start < SAMPLE_WINDOW_MS) {
    samples.push({ at: now() - start, state: session.visibilityState });
    await sleep(SAMPLE_EVERY_MS);
  }

  await sleep(Math.max(0, PROBE_DELAY_MS - (now() - start)));

  const grants: Record<string, string> = {};
  let boundsPoints: number | null = null;

  for (const type of ['bounded-floor', 'local-floor', 'unbounded']) {
    try {
      const space = await session.requestReferenceSpace(type);
      grants[type] = 'granted';
      const bounds = (space as { boundsGeometry?: unknown[] })?.boundsGeometry;
      if (Array.isArray(bounds)) boundsPoints = bounds.length;
    } catch (err) {
      // Le refus est le comportement conforme, donc c'est une information
      // aussi utile que le succès - et pas une erreur à signaler.
      grants[type] = err instanceof Error ? err.name : 'rejected';
    }
  }

  return { visibility: transitions(samples), grants, boundsPoints };
}
