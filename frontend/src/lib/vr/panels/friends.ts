/**
 * The friends lectern: presence, and nothing else.
 *
 * Every action a friends list normally offers is out of reach in here.
 * Inviting opens a room and a room leads to lockstep, which this version does
 * not do. Adding a friend needs a pseudonym typed, and an immersive session has
 * no keyboard. Removing one is a management gesture and belongs on the flat
 * page with the rest of them.
 *
 * So this panel is a shopfront, and it says so rather than leaving somebody
 * hunting for an invite button that does not exist. Seeing who is online is a
 * reason to come back, and the data already arrives over the socket, so it is
 * nearly free.
 *
 * Presence is the entire point, which is why the sort puts the people who are
 * here first: a list that buries two online friends under forty offline ones
 * has discarded its own value.
 */

import type { PanelSize, Region } from '../panel';

export const FRIENDS_PANEL_SIZE: PanelSize = { width: 800, height: 600 };

const PAD = 24;
const HEADER = 56;
const ROW_H = 56;
const FOOTER = 44;

/** No scrolling here - there is nothing to press, so a cap is honest. */
export const FRIENDS_VISIBLE_ROWS = Math.floor(
  (FRIENDS_PANEL_SIZE.height - HEADER - FOOTER - PAD) / ROW_H
);

export interface FriendRow {
  id: string;
  pseudo: string;
  online: boolean;
  /** The game's title, when they are in one. */
  playing: string | null;
}

export interface FriendsLabels {
  heading: string;
  online: string;
  offline: string;
  nobody: string;
  readOnly: string;
}

export function friendRows(
  friends: readonly { friend: { id: string; pseudo: string } }[],
  online: ReadonlyMap<string, boolean>,
  playingByUserId: ReadonlyMap<string, string>
): FriendRow[] {
  const rows = friends.map((entry) => ({
    id: entry.friend.id,
    pseudo: entry.friend.pseudo,
    // An id the presence map has never heard of is offline. It is what a
    // freshly opened socket looks like before `friends:online` arrives, and
    // guessing "online" there would show everyone as present for a second.
    online: online.get(entry.friend.id) === true,
    playing: playingByUserId.get(entry.friend.id) ?? null
  }));

  // A stable partition, not a comparator: Array.prototype.sort is stable in
  // every engine this runs on, but saying it in two filters means nobody has
  // to remember that.
  return [...rows.filter((r) => r.online), ...rows.filter((r) => !r.online)].slice(
    0,
    FRIENDS_VISIBLE_ROWS
  );
}

/** Deliberately empty. See the header. */
export function layoutFriendsPanel(_rows: readonly FriendRow[]): Region[] {
  return [];
}

export function drawFriendsPanel(
  ctx: CanvasRenderingContext2D,
  rows: readonly FriendRow[],
  _regions: readonly Region[],
  labels: FriendsLabels
): void {
  const { width, height } = FRIENDS_PANEL_SIZE;

  ctx.save();
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#14141c';
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = '#ffffff';
  ctx.font = '600 30px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(labels.heading, PAD, HEADER / 2);

  if (rows.length === 0) {
    // A blank panel reads as one that failed to load.
    ctx.textAlign = 'center';
    ctx.font = '20px system-ui, sans-serif';
    ctx.fillStyle = '#a0a0b0';
    ctx.fillText(labels.nobody, width / 2, height / 2);
    ctx.restore();
    return;
  }

  rows.forEach((row, index) => {
    const y = HEADER + index * ROW_H + ROW_H / 2;

    ctx.beginPath();
    ctx.fillStyle = row.online ? '#3ddc84' : '#4a4a58';
    ctx.arc(PAD + 8, y, 7, 0, Math.PI * 2);
    ctx.fill();

    ctx.textAlign = 'left';
    ctx.fillStyle = row.online ? '#ffffff' : '#8a8a98';
    ctx.font = '22px system-ui, sans-serif';
    ctx.fillText(row.pseudo, PAD + 30, y);

    // The game rather than a bare dot: "online" tells you nothing you would
    // act on, "playing Zelda" is the thing worth looking over for.
    ctx.fillStyle = '#8a8a98';
    ctx.font = '18px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(
      row.playing ?? (row.online ? labels.online : labels.offline),
      width - PAD,
      y
    );
  });

  ctx.textAlign = 'center';
  ctx.fillStyle = '#6a6a78';
  ctx.font = 'italic 17px system-ui, sans-serif';
  ctx.fillText(labels.readOnly, width / 2, height - FOOTER / 2);

  ctx.restore();
}
