/**
 * Qui est là, et où, à l'instant qu'on dessine.
 *
 * LE SEUL MODULE DU LOBBY QUI A UNE HORLOGE, et c'est pour ça qu'il existe
 * séparément du code qui dessine : sous Bun il n'y a ni casque ni GPU, et
 * l'arithmétique du temps est précisément ce qu'on ne peut vérifier qu'ici.
 *
 * Les instantanés arrivent à 15 Hz et on dessine à 72 ou 90. Sans
 * interpolation, chaque tête saute six fois par seconde. On garde donc les
 * TROIS derniers instantanés par ami et on dessine à `maintenant - 100 ms`,
 * entre les deux qui ENCADRENT cet instant : un retard d'un battement et demi,
 * invisible sur une tête qui marche, et qui absorbe une image réseau perdue.
 *
 * TROIS ET PAS DEUX, et c'est arithmétique plutôt qu'un confort. Le battement
 * vaut 66 ms (`BEAT_MS`, backend), donc deux instantanés ne couvrent que 66 ms
 * quand le retard en vaut 100 : l'instant dessiné tombe AVANT le plus ancien
 * des deux pendant les 34 premières millisecondes de chaque battement, et on
 * fige alors sur la pose ancienne avant de rattraper d'un bond. Mesuré sur un
 * ami à 1 m/s : 13 images figées sur 45 et des pointes à 3,2 m/s - exactement
 * la saccade que ce module existe pour supprimer, en dents de scie.
 *
 * Et pas non plus « ramener le retard à un battement », qui encadrerait tout
 * aussi bien : la marge d'un demi-battement est là pour la gigue. Avec un
 * retard d'exactement 66 ms, le moindre instantané en retard pousse l'instant
 * dessiné au-delà du plus récent et fige sur la dernière pose. Sur une ligne
 * domestique cette gigue est réelle.
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

/**
 * Combien d'instantanés on garde, et c'est `INTERPOLATION_DELAY_MS` qui le
 * décide.
 *
 * Il en faut assez pour couvrir le retard : `(KEPT - 1) × BEAT_MS` doit rester
 * supérieur à `INTERPOLATION_DELAY_MS`, sans quoi l'instant dessiné sort de
 * l'histoire conservée par le bas et on fige. À 66 ms de battement, deux
 * instantanés couvrent 66 ms pour un retard de 100 - trois en couvrent 132.
 *
 * Toucher au retard sans toucher à ce nombre est le défaut qu'il faut voir
 * venir ; le test de régularité de `vr-lobby-roster.test.ts` est ce qui le dit.
 */
const KEPT_SNAPSHOTS = 3;

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
  /** Du plus ancien au plus récent, `KEPT_SNAPSHOTS` au plus. */
  const history: Timed[] = [];

  /**
   * La paire d'instantanés qui ENCADRE `when`, ou la plus ancienne à défaut.
   *
   * C'est la ligne qui distingue ce module de sa version à deux instantanés :
   * on ne prend plus les deux derniers aveuglément. On descend du plus récent
   * vers le plus ancien et on s'arrête au premier intervalle qui commence
   * avant l'instant dessiné ; faute de quoi on rend le plus ancien, que
   * l'appelant traitera en « pas encore » plutôt qu'en extrapolation à
   * rebours.
   */
  function bracketing(when: number): { from: Timed; to: Timed } | null {
    for (let i = history.length - 2; i >= 0; i -= 1) {
      const from = history[i];
      const to = history[i + 1];
      if (from.at <= when || i === 0) return { from, to };
    }
    return null;
  }

  return {
    accept(snapshot, at) {
      // Un instantané plus ancien que celui qu'on tient déjà remonterait le
      // temps. Socket.io garantit l'ordre, donc c'est une ceinture ; elle
      // coûte une comparaison et évite un saut inexplicable si jamais le
      // transport change un jour.
      const newest = history[history.length - 1];
      if (newest !== undefined && at <= newest.at) return;
      history.push({ at, peers: byId(snapshot.peers) });
      if (history.length > KEPT_SNAPSHOTS) history.shift();
    },

    at(now) {
      const shown = new Map<string, PeerPose>();
      const newest = history[history.length - 1];
      if (newest === undefined) return shown;

      const when = now - INTERPOLATION_DELAY_MS;
      const pair = bracketing(when);

      // La présence est décidée par le DERNIER instantané, et par lui seul :
      // un ami absent de celui-ci est parti, et il ne doit pas survivre dans
      // les précédents le temps que l'interpolation le rattrape.
      for (const [id, latest] of newest.peers) {
        // Pas d'intervalle du tout, ou un instant passé le dernier instantané :
        // on montre la pose la plus récente. C'est ce qui interdit
        // d'extrapoler au-delà de ce qu'on a reçu.
        if (pair === null || when >= newest.at || pair.to.at <= pair.from.at) {
          shown.set(id, { head: latest.head, left: latest.left, right: latest.right });
          continue;
        }

        // Le but est la pose de `to` et NON la plus récente : quand la paire
        // qui encadre n'est pas la dernière, viser la plus récente ferait
        // traverser deux battements en un.
        const target = pair.to.peers.get(id);
        // Un ami apparu après `to` n'a pas d'intervalle : sa pose brute, comme
        // au tout premier instantané.
        if (target === undefined) {
          shown.set(id, { head: latest.head, left: latest.left, right: latest.right });
          continue;
        }

        const from = pair.from.peers.get(id);
        // Apparu entre les deux : rien d'où partir, donc il prend sa pose
        // d'arrivée plutôt que de glisser depuis l'origine du décor.
        if (from === undefined) {
          shown.set(id, { head: target.head, left: target.left, right: target.right });
          continue;
        }

        const t = (when - pair.from.at) / (pair.to.at - pair.from.at);
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
