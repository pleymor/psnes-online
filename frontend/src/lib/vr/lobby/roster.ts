/**
 * Qui est là, et où, à l'instant qu'on dessine.
 *
 * LE SEUL MODULE DU LOBBY QUI A UNE HORLOGE, et c'est pour ça qu'il existe
 * séparément du code qui dessine : sous Bun il n'y a ni casque ni GPU, et
 * l'arithmétique du temps est précisément ce qu'on ne peut vérifier qu'ici.
 *
 * Les instantanés arrivent à 15 Hz et on dessine à 72 ou 90. Sans
 * interpolation, chaque tête saute six fois par seconde. On garde donc les
 * DEUX derniers instantanés par ami et on dessine à `maintenant - 100 ms`,
 * entre les deux qui encadrent cet instant : un retard d'un battement et demi,
 * invisible sur une tête qui marche, et qui absorbe une image réseau perdue.
 *
 * L'HORLOGE EST L'ARRIVÉE LOCALE, jamais une estampille du serveur. Deux
 * horloges qui ne se sont jamais parlé ne peuvent pas dater le même instant,
 * et c'est aussi pourquoi `vr:lobby` ne porte aucun `t` : socket.io est sur
 * TCP, l'ordre est déjà garanti, et un champ de plus n'aurait servi qu'à
 * inviter à s'en servir.
 *
 * ON N'EXTRAPOLE PAS. Passé le dernier instantané on tient la dernière pose.
 * Extrapoler la vitesse d'une tête qui s'est tue enverrait un ami traverser le
 * décor pendant une coupure réseau, et le ramènerait d'un bond au retour.
 */

/** `[x, y, z, qx, qy, qz, qw]`, dans le repère local du décor. */
export type Pose = readonly [number, number, number, number, number, number, number];

export interface PeerSnapshot {
  id: string;
  head: Pose;
  left: Pose | null;
  right: Pose | null;
}

export interface LobbySnapshot {
  peers: readonly PeerSnapshot[];
}

export interface PeerPose {
  head: Pose;
  left: Pose | null;
  right: Pose | null;
}

/**
 * Un battement et demi, à 15 Hz.
 *
 * Pas un réglage de confort : c'est la marge qui permet d'avoir TOUJOURS deux
 * instantanés de part et d'autre de l'instant dessiné, y compris quand l'un
 * des deux s'est perdu en route.
 */
export const INTERPOLATION_DELAY_MS = 100;

/** Un ami qu'on sait nommer : sa pose, et le pseudo à écrire au-dessus. */
export interface NamedPeer {
  readonly pose: PeerPose;
  readonly pseudo: string;
}

/**
 * Ne garde que les identifiants qu'on sait nommer.
 *
 * LA GARANTIE DE DERNIER RECOURS, et c'est pour ça qu'elle vit ici plutôt que
 * dans la boucle de dessin. Même si le serveur se trompait un jour de
 * destinataire, aucun inconnu n'apparaîtrait dans le lobby de personne - mais
 * une règle de sécurité écrite chez celui qui dessine serait invérifiable,
 * puisque `avatars.ts` importe three et que rien sous Bun ne peut l'exécuter.
 * Ici, un test la tient.
 *
 * Le cas qui arrive VRAIMENT n'est pas l'attaque : c'est la seconde pendant
 * laquelle `vr:lobby` a devancé `friends:online`. Un ami sans nom encore connu
 * n'est pas dessiné du tout - ni construit, ni rendu invisible - et il
 * apparaîtra à l'image suivante avec sa plaque.
 *
 * Une carte de plus par image, et c'est assumé : `at()` en alloue déjà une, et
 * quelques amis y tiennent. Filtrer en place demanderait à `createRoster` de
 * connaître la liste d'amis, c'est-à-dire de lier l'horloge à un état qui
 * arrive par un tout autre message.
 */
export function namedOnly(
  peers: ReadonlyMap<string, PeerPose>,
  label: (id: string) => string | null
): ReadonlyMap<string, NamedPeer> {
  const named = new Map<string, NamedPeer>();
  for (const [id, pose] of peers) {
    const pseudo = label(id);
    if (pseudo === null) continue;
    named.set(id, { pose, pseudo });
  }
  return named;
}

export interface Roster {
  /** `at` est l'arrivée LOCALE, en millisecondes. */
  accept(snapshot: LobbySnapshot, at: number): void;
  /** `now` est l'horloge locale ; le retard est appliqué ici. */
  at(now: number): ReadonlyMap<string, PeerPose>;
}

interface Timed {
  readonly at: number;
  readonly peers: ReadonlyMap<string, PeerSnapshot>;
}

function byId(peers: readonly PeerSnapshot[]): ReadonlyMap<string, PeerSnapshot> {
  return new Map(peers.map((peer) => [peer.id, peer]));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Interpole deux orientations par l'arc le plus court.
 *
 * LE RETOURNEMENT DE SIGNE EST TOUT L'INTÉRÊT. Un quaternion et son opposé
 * décrivent la MÊME orientation, et rien dans les nombres ne dit lequel des
 * deux on a reçu. Sans le retournement, deux poses successives d'une tête qui
 * tourne de 190° peuvent arriver avec des signes opposés, et l'interpolation
 * prend alors l'arc de 170° dans l'autre sens : l'ami fait demi-tour. C'est
 * invisible en lisant et évident dans un casque.
 *
 * En deçà de `LINEAR_ENOUGH` on interpole linéairement puis on renormalise :
 * `acos` d'un produit scalaire proche de 1 perd ses chiffres, et `sin(theta)`
 * au dénominateur tend vers zéro.
 */
const LINEAR_ENOUGH = 0.9995;

export function slerp(a: Pose, b: Pose, t: number): Pose {
  const px = lerp(a[0], b[0], t);
  const py = lerp(a[1], b[1], t);
  const pz = lerp(a[2], b[2], t);

  let bx = b[3];
  let by = b[4];
  let bz = b[5];
  let bw = b[6];

  let dot = a[3] * bx + a[4] * by + a[5] * bz + a[6] * bw;
  if (dot < 0) {
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
    dot = -dot;
  }

  let qx: number;
  let qy: number;
  let qz: number;
  let qw: number;

  if (dot > LINEAR_ENOUGH) {
    qx = lerp(a[3], bx, t);
    qy = lerp(a[4], by, t);
    qz = lerp(a[5], bz, t);
    qw = lerp(a[6], bw, t);
  } else {
    const theta = Math.acos(Math.min(1, dot));
    const sinTheta = Math.sin(theta);
    const wa = Math.sin((1 - t) * theta) / sinTheta;
    const wb = Math.sin(t * theta) / sinTheta;
    qx = a[3] * wa + bx * wb;
    qy = a[4] * wa + by * wb;
    qz = a[5] * wa + bz * wb;
    qw = a[6] * wa + bw * wb;
  }

  const norm = Math.hypot(qx, qy, qz, qw) || 1;
  return [px, py, pz, qx / norm, qy / norm, qz / norm, qw / norm];
}

/**
 * Interpole deux poses, en traitant l'apparition et la disparition d'une main.
 *
 * Une main qui vient d'apparaître n'a pas de pose de départ : interpoler
 * depuis `null` donnerait l'origine, donc une manette qui jaillit du sol. Elle
 * prend sa valeur d'arrivée, et symétriquement une main qui disparaît s'en va
 * tout de suite plutôt que de fondre vers un point.
 */
function tween(from: Pose | null, to: Pose | null, t: number): Pose | null {
  if (to === null) return null;
  if (from === null) return to;
  return slerp(from, to, t);
}

export function createRoster(): Roster {
  let older: Timed | null = null;
  let newer: Timed | null = null;

  return {
    accept(snapshot, at) {
      // Un instantané plus ancien que celui qu'on tient déjà remonterait le
      // temps. Socket.io garantit l'ordre, donc c'est une ceinture ; elle
      // coûte une comparaison et évite un saut inexplicable si jamais le
      // transport change un jour.
      if (newer !== null && at <= newer.at) return;
      older = newer;
      newer = { at, peers: byId(snapshot.peers) };
    },

    at(now) {
      const shown = new Map<string, PeerPose>();
      if (newer === null) return shown;

      const when = now - INTERPOLATION_DELAY_MS;

      // La présence est décidée par le DERNIER instantané, et par lui seul :
      // un ami absent de celui-ci est parti, et il ne doit pas survivre dans
      // l'ancien le temps que l'interpolation le rattrape.
      for (const [id, target] of newer.peers) {
        const from = older?.peers.get(id) ?? null;

        // Pas de pose antérieure, pas d'intervalle, ou un instant hors de
        // l'intervalle : on montre la pose d'arrivée. C'est aussi ce qui
        // interdit d'extrapoler au-delà du dernier instantané.
        if (from === null || older === null || when >= newer.at || newer.at <= older.at) {
          shown.set(id, { head: target.head, left: target.left, right: target.right });
          continue;
        }

        const t = (when - older.at) / (newer.at - older.at);
        if (t <= 0) {
          shown.set(id, { head: from.head, left: from.left, right: from.right });
          continue;
        }

        shown.set(id, {
          head: slerp(from.head, target.head, t),
          left: tween(from.left, target.left, t),
          right: tween(from.right, target.right, t)
        });
      }

      return shown;
    }
  };
}
