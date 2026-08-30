/**
 * A sliding count of failed lookups, per account.
 *
 * This is the counterpart to the `Pseudo#1234` handle format, not a generic
 * precaution: a pseudonym carries only ten thousand discriminators, so anyone
 * who knows someone's pseudonym can sweep the space. Twenty attempts an hour
 * turns that sweep into five hundred hours for a single pseudonym.
 *
 * Only failures are recorded. That is what makes the ceiling liveable: a
 * player pasting a handle from a chat message gets it right, and twenty typos
 * an hour inconveniences nobody, while enumeration produces nothing but
 * failures.
 *
 * Counted per authenticated account rather than per IP. Reaching the endpoint
 * already costs a Google sign-in, so an attacker must burn accounts; an IP is
 * changed for free.
 *
 * Known limit, and a property of the deployment rather than of this code: the
 * counter lives in memory. It resets on every deploy and would not be shared
 * between replicas. docker-compose runs one backend container, so it holds
 * today.
 */

export interface AttemptLimitOptions {
  max: number;
  windowMs: number;
  /** Injected so the sliding window can be tested without waiting an hour. */
  now?: () => number;
}

export class AttemptLimit {
  private readonly failures = new Map<string, number[]>();
  private readonly max: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(options: AttemptLimitOptions) {
    this.max = options.max;
    this.windowMs = options.windowMs;
    this.now = options.now ?? Date.now;
  }

  /** Drops timestamps that have aged out, and returns those still counting. */
  private live(key: string): number[] {
    const cutoff = this.now() - this.windowMs;
    const kept = (this.failures.get(key) ?? []).filter(at => at > cutoff);
    if (kept.length === 0) this.failures.delete(key);
    else this.failures.set(key, kept);
    return kept;
  }

  blocked(key: string): boolean {
    return this.live(key).length >= this.max;
  }

  /**
   * Compte une tentative.
   *
   * `recordFailure` en est l'ancien nom, gardé parce que la limite du lookup
   * d'amis ne compte effectivement que les échecs. La porte anonyme, elle,
   * compte *toutes* les tentatives : elle crée une ligne quand elle réussit,
   * donc ne compter que les refus laisserait la création de lignes sans
   * plafond - exactement le vecteur de spam qu'une route non authentifiée
   * ouvre.
   */
  record(key: string): void {
    const kept = this.live(key);
    kept.push(this.now());
    this.failures.set(key, kept);
  }

  recordFailure(key: string): void {
    this.record(key);
  }

  /** Exposed for tests and for a future admin surface; nothing else calls it. */
  size(): number {
    return this.failures.size;
  }
}

/**
 * The instance the friend-request route uses.
 *
 * Sweeping is lazy rather than scheduled: `live()` already prunes whatever key
 * it touches, so the only entries that can linger are those of accounts that
 * stopped failing - a handful of numbers each. That avoids a background timer
 * entirely, and with it the trap documented in utils/cache.ts, where an
 * interval with no unref() kept every test that transitively imported the
 * module alive forever.
 */
export const friendLookupLimit = new AttemptLimit({ max: 20, windowMs: 3_600_000 });

/**
 * L'instance de la porte anonyme, comptée par adresse IP.
 *
 * Par IP et non par compte, contrairement à sa voisine : il n'y a par
 * définition aucun compte de l'autre côté de cette porte, donc rien d'autre à
 * compter. Une IP se change gratuitement, ce plafond n'est donc pas une
 * défense contre quelqu'un de déterminé - c'est ce qui empêche un lien partagé
 * un peu trop largement, ou un client en boucle de reconnexion, de remplir la
 * table des joueurs. Le vrai verrou est ailleurs : un anonyme n'entre que dans
 * un salon existant qui a de la place, et sa ligne est balayée au bout d'un
 * jour.
 *
 * Dix par heure : de quoi se tromper de pseudonyme, recharger la page et
 * revenir après une déconnexion, sans laisser tourner une boucle.
 */
export const anonymousDoorLimit = new AttemptLimit({ max: 10, windowMs: 3_600_000 });
