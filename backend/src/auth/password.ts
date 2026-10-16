/**
 * Le mot de passe, et ce qu'on en garde.
 *
 * `Bun.password` fait argon2id et vit dans le runtime : aucune dépendance à
 * ajouter, aucune compilation native à trustifier. Le backend démarre sous Bun
 * (`bun dist/index.js` dans backend/package.json), donc c'est disponible en
 * production comme en test.
 */

/**
 * Dix caractères, et rien d'autre.
 *
 * Pas de classe de caractères obligatoire : c'est la recommandation NIST
 * SP 800-63B, et une règle de composition produit surtout des mots de passe
 * qui se ressemblent tous. La longueur est ce qui compte.
 */
export const MIN_PASSWORD_LENGTH = 10;

/**
 * Un plafond, pour que hacher ne devienne pas un moyen de faire tourner le
 * processeur à vide : argon2 lit toute l'entrée, et le corps JSON accepté par
 * Express va bien au-delà de ce qu'un humain tape.
 */
export const MAX_PASSWORD_LENGTH = 512;

export function passwordAcceptable(password: unknown): password is string {
  return typeof password === 'string'
    && password.length >= MIN_PASSWORD_LENGTH
    && password.length <= MAX_PASSWORD_LENGTH;
}

export function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, { algorithm: 'argon2id' });
}

/**
 * Rend `false` plutôt que de jeter sur un hash illisible.
 *
 * Une ligne corrompue doit produire « mot de passe incorrect » sur la page de
 * connexion, pas un 500 : le second dirait au visiteur qu'il a trouvé quelque
 * chose, et remplirait le journal d'erreurs sur un chemin qu'un attaquant
 * contrôle.
 */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  try {
    return await Bun.password.verify(password, hash);
  } catch {
    return false;
  }
}

/**
 * Le temps qu'aurait coûté une vérification, quand il n'y a rien à vérifier.
 *
 * Sans cela, `/auth/login` sur une adresse inconnue répond en une milliseconde
 * et sur une adresse connue en cinquante : la durée seule dit qui a un compte
 * ici. Le hash comparé ne correspond à aucun mot de passe.
 *
 * Calculé à la première utilisation plutôt qu'écrit en dur : un hash figé
 * garderait les paramètres d'argon2 d'aujourd'hui, et la durée cesserait de
 * ressembler à celle d'une vraie vérification le jour où Bun les relève.
 */
let decoy: Promise<string> | null = null;

export async function burnTime(): Promise<void> {
  decoy ??= hashPassword('psnes-timing-decoy');
  await verifyPassword('psnes-timing-decoy-mismatch', await decoy);
}
