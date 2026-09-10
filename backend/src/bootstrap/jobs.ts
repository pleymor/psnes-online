import { Room } from '../types/index.js';
import { restoreRooms, startRoomSnapshots } from '../websocket/room-snapshot.js';
import { markOffline } from '../rooms/presence.js';
import { getDb } from '../db/sqlite.js';
import { deleteExpiredInvitations, deleteInvitationsForRoom } from '../db/invitations.js';
import { sweepAnonymousUsers } from '../db/users.js';
import { abandonedRoomIds } from '../rooms/abandonment.js';
import { loadGameMetadata } from '../services/metadata-loader.js';
import { ensureAvatarsDir } from '../utils/avatar.js';
import { logger } from '../utils/logger.js';

/**
 * Destroys the rooms nobody came back to.
 *
 * Running this at restore is what makes the snapshot TTL a storage bound rather
 * than a lifetime: however long the key sat in Redis, what decides a room's
 * fate is how long it has been empty.
 */
function sweepAbandonedRooms(rooms: Map<string, Room>, now: Date) {
  for (const roomId of abandonedRoomIds(rooms, now)) {
    rooms.delete(roomId);
    deleteInvitationsForRoom(getDb(), roomId);
    logger.info({ roomId }, 'Swept a room nobody came back to');
  }
}

/**
 * Combien de temps une session sans compte laisse sa ligne derrière elle.
 *
 * Personne ne peut se reconnecter dessus : sans ce balayage, chaque lien de
 * salon suivi par un curieux serait une ligne `User` de plus, pour toujours.
 * Vingt-quatre heures et pas une heure : la ligne porte le pseudonyme affiché
 * dans le salon, et un joueur qui ferme son onglet dix minutes doit retrouver
 * sa place - c'est le même raisonnement que les douze heures de l'abandon d'un
 * salon, avec plus de marge parce qu'ici rien ne coûte rien à personne.
 */
const ANONYMOUS_SESSION_TTL_MS = 24 * 3_600_000;

/** Les lignes des sessions sans compte que personne ne reprendra. */
function sweepAnonymousSessions(now: Date): void {
  try {
    const swept = sweepAnonymousUsers(getDb(), new Date(now.getTime() - ANONYMOUS_SESSION_TTL_MS));
    if (swept > 0) logger.info({ swept }, 'Swept anonymous sessions nobody came back to');
  } catch (err) {
    // Comme le balayage des invitations juste à côté : ne pas réussir à faire
    // le ménage ne doit jamais être la raison pour laquelle le serveur ne
    // démarre pas.
    logger.warn({ err }, 'Could not sweep anonymous sessions; carrying on');
  }
}

/**
 * Restores rooms from their Redis snapshot and runs the initial abandoned-room
 * sweep. Must finish before the port opens - the caller awaits this before
 * `httpServer.listen` - so the first client to reconnect finds its room
 * already there rather than racing the restore.
 */
export async function restoreAndSweep(rooms: Map<string, Room>): Promise<void> {
  /*
   * Invitations whose deadline has passed, cleared once at boot.
   *
   * A room that dies cleanly takes its invitations with it, but a crash leaves
   * them behind with nothing to remove them. Nothing ever reads a stale row -
   * `lobby:accept` and the connection-time delivery both check that the room
   * still exists - so this is housekeeping and nothing more, which is exactly
   * why it is wrapped: a failure to tidy up must never be the reason the server
   * cannot start.
   */
  try {
    const swept = deleteExpiredInvitations(getDb(), new Date());
    if (swept > 0) logger.info({ swept }, 'Cleared expired invitations');
  } catch (err) {
    logger.warn({ err }, 'Could not sweep expired invitations; carrying on');
  }

  const bootedAt = new Date();
  await restoreRooms(rooms, room => {
    // A restart dropped everybody, through no action of theirs. An existing
    // `abandonedAt` is kept by markOffline: the deadline began when the room
    // emptied, and a deploy must not hand an abandoned room another twelve hours.
    for (const player of room.players) markOffline(room, player.userId, bootedAt);
  });

  // Once at restore, before the hourly timer is armed - see sweepAbandonedRooms.
  sweepAbandonedRooms(rooms, bootedAt);
  sweepAnonymousSessions(bootedAt);
}

/**
 * Arms the recurring jobs: the hourly abandoned-room sweep and periodic room
 * snapshots. Called after `restoreAndSweep`, before `httpServer.listen` -
 * both are armed before the port opens.
 */
export function startBackgroundJobs(rooms: Map<string, Room>): void {
  // Hourly: twelve hours is the deadline, so an hour of slack costs nothing and
  // keeps this off the hot path. `unref` for the usual reason - a sweep must
  // never be what holds the process open.
  const abandonmentSweep = setInterval(() => {
    const now = new Date();
    sweepAbandonedRooms(rooms, now);
    sweepAnonymousSessions(now);
  }, 60 * 60_000);
  abandonmentSweep.unref();

  startRoomSnapshots(rooms);
}

/**
 * Warms up caches that are nice to have hot but must not delay the port
 * opening: the avatars directory and the game catalogue on a fresh database.
 *
 * `loadGameMetadata` and not `refreshGameMetadata`, since 2026-09-10. The
 * refresh rewrote the whole shipped catalogue at every start - every deploy -
 * and it minted a new id per row, so every game a player had identified
 * against a shipped entry lost its identification and every cover uploaded
 * onto one was deleted with the row. Production had 65 games and two
 * surviving links. Loading only fills an empty catalogue, so a running
 * database is never touched.
 *
 * The cost, chosen by the owner: a change to `snes-metadata.json` no longer
 * reaches production on its own. `bun src/db/catalogue-cli.ts` applies it,
 * without destroying anything - see that file.
 */
export async function warmStartupCaches(): Promise<void> {
  // Ensure avatars directory exists
  await ensureAvatarsDir();
  logger.info('📁 Avatars directory ready');

  // Only ever fills an empty catalogue; an existing one is left alone.
  try {
    await loadGameMetadata();
  } catch (error) {
    logger.warn('⚠️  Failed to load game metadata, but server is still running');
  }
}
