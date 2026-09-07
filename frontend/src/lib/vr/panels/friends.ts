/**
 * The friends lectern: who is here, and the one action worth reaching for.
 *
 * This panel used to be a shopfront, and said so. The reason it gave was
 * sound and is now expired: "inviting opens a room and a room leads to
 * lockstep, which this version does not do" was written before the headset
 * could play a two-player game, and it can. The other two reasons still hold -
 * adding a friend needs a pseudonym typed and there is no keyboard in an
 * immersive session, and removing one is a management gesture that belongs on
 * the flat page - so those actions are still absent, and deliberately.
 *
 * Nothing here is new machinery. `rooms/actions.ts` already opens the group's
 * room and sends the invitation; `lobby/invitations.ts` already holds the ones
 * addressed to me, at module scope precisely so they stay live while a
 * component is not mounted. This module is a surface over both, and stays
 * pure: layout returns regions, drawing consumes them.
 *
 * Presence is still why the panel exists, which is why the sort puts the
 * people who are here first - a list that buries two online friends under
 * forty offline ones has discarded its own value. The one thing that outranks
 * presence is a friend we have just invited: see `friendRows`.
 *
 * One deliberate hole. The lecterns sit sixty degrees off centre and the
 * panels hide themselves during a game, so an invitation that arrives while
 * somebody is playing waits here until they look. Announcing it in the middle
 * of the view is a spatial question - where, and does it take the trigger away
 * from the game - that this panel is the wrong place to answer.
 */

import { truncate, type PanelSize, type Region } from '../panel';

export const FRIENDS_PANEL_SIZE: PanelSize = { width: 1120, height: 840 };

const PAD = 34;
const HEADER = 78;
const ROW_H = 78;
/**
 * A bottom margin, not a band of text.
 *
 * It used to hold "invitations are not available in VR yet", which this change
 * makes false. Kept at the same size as `PAD` rather than reclaimed for a
 * ninth row: the list wants breathing room under it, and the row count works
 * out identical to what it was with the caption - eight, seven while somebody
 * is asking.
 */
const FOOTER = PAD;

const BUTTON_W = 200;
const BUTTON_H = 56;
const BUTTON_GAP = 22;
/** An incoming invitation is exactly one row tall, and costs the list one. */
const BAND_H = ROW_H;

/** The button column, shared by every row and by the band. */
const BUTTON_X = FRIENDS_PANEL_SIZE.width - PAD - BUTTON_W;
/** Where a row's status text stops, so it never runs under a button. */
const STATUS_RIGHT = BUTTON_X - BUTTON_GAP;
/** Reserved for the status, so the pseudonym has a budget that does not move. */
const STATUS_W = 240;
const PSEUDO_X = PAD + 30;

/**
 * How many friends fit, which depends on whether somebody is asking.
 *
 * There is still no scroll - a cap is the honest answer - and the band an
 * incoming invitation draws takes a row's worth of height, so the list gives
 * one up while it is up. A function rather than a constant because the answer
 * genuinely has two values now.
 */
export function friendsVisibleRows(hasIncoming: boolean): number {
  const band = hasIncoming ? BAND_H : 0;
  return Math.floor((FRIENDS_PANEL_SIZE.height - HEADER - FOOTER - PAD - band) / ROW_H);
}

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
  invite: string;
  /** On the row of the friend this room has asked. */
  invited: string;
  cancel: string;
  accept: string;
  decline: string;
  /** Already interpolated with the inviter's name by the caller, as
   *  `library.ts`' `noneHere` is with its count. An unattributed invitation is
   *  not answerable. */
  incomingFrom: string;
}

/**
 * The visible rows, in the order they are drawn.
 *
 * `cap` is a parameter rather than read from `friendsVisibleRows` in here,
 * because only the caller knows whether an invitation is being shown.
 *
 * `invitedId` outranks presence, and that is a fix rather than a flourish. The
 * sort is presence-first, so a friend who goes offline just after being
 * invited drops behind everyone still here - and on a panel with no scroll,
 * off the bottom. Their row carries the only cancel button there is, so losing
 * it strands the invitation until it expires ten minutes later, with nothing
 * on screen connecting the two.
 */
export function friendRows(
  friends: readonly { friend: { id: string; pseudo: string } }[],
  online: ReadonlyMap<string, boolean>,
  playingByUserId: ReadonlyMap<string, string>,
  cap: number,
  invitedId?: string
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
  const invited = rows.filter((r) => r.id === invitedId);
  const rest = rows.filter((r) => r.id !== invitedId);
  return [
    ...invited,
    ...rest.filter((r) => r.online),
    ...rest.filter((r) => !r.online)
  ].slice(0, cap);
}

/** One invitation this room has out. `myRoom.invitation`, narrowed. */
export interface PendingInvitation {
  id: string;
  toUserId: string;
}

/** One invitation addressed to me. `lobby/invitations.ts`' `Invitation`, narrowed. */
export interface IncomingInvitation {
  id: string;
  fromPseudo: string;
}

export interface FriendsState {
  rows: readonly FriendRow[];
  /** Null when this room has asked nobody. */
  pending: PendingInvitation | null;
  /** Only the first is offered - see `layoutFriendsPanel`. */
  incoming: readonly IncomingInvitation[];
}

/** Where a row's button goes, given the row's index and whether a band is up. */
function buttonAt(index: number, hasIncoming: boolean): Omit<Region, 'id'> {
  const top = HEADER + (hasIncoming ? BAND_H : 0) + index * ROW_H;
  return { x: BUTTON_X, y: top + (ROW_H - BUTTON_H) / 2, w: BUTTON_W, h: BUTTON_H };
}

/**
 * The regions, and the two rules that decide which exist.
 *
 * Only ONLINE friends can be invited. The server would accept an invitation
 * for an absent one - it stores it and pushes it only if a socket is there
 * (`invitation-handlers.ts:174`) - but from inside a headset that produces no
 * answer and no feedback, and the ten-minute expiry would most likely beat
 * them to it. That is the "button that refuses" this panel was right to avoid.
 *
 * And only ONE invitation may be out. `myRoom.invitation` is a single slot
 * (`rooms/my-room.ts:83`), so a second would displace the first in silence and
 * leave the player believing two people had been asked. While one is pending,
 * every Invite button goes and a single Cancel takes its place - carrying the
 * invitation's id, so a press cancels the invitation that was on screen rather
 * than whatever the store holds by the time the trigger falls.
 */
export function layoutFriendsPanel(state: FriendsState): Region[] {
  const regions: Region[] = [];
  const asking = state.incoming[0] ?? null;

  /*
   * The band first, so it wins a tie in `hit()`, which returns the first
   * match. Nothing should overlap it - `vr-panel-friends.test.ts` proves that
   * - but ordering it first means an accidental overlap costs a friend's
   * button rather than the answer to an invitation somebody is waiting on.
   */
  if (asking) {
    const y = HEADER + (BAND_H - BUTTON_H) / 2;
    regions.push({ id: `decline:${asking.id}`, x: BUTTON_X - BUTTON_GAP - BUTTON_W, y, w: BUTTON_W, h: BUTTON_H });
    regions.push({ id: `accept:${asking.id}`, x: BUTTON_X, y, w: BUTTON_W, h: BUTTON_H });
  }

  state.rows.forEach((row, index) => {
    if (state.pending) {
      if (row.id === state.pending.toUserId) {
        regions.push({ id: `cancel-invite:${state.pending.id}`, ...buttonAt(index, !!asking) });
      }
      return;
    }
    if (!row.online) return;
    regions.push({ id: `invite:${row.id}`, ...buttonAt(index, !!asking) });
  });

  return regions;
}

/**
 * One button. Local, like `profile.ts`' and `launch.ts`': each panel styles
 * its own, and centralising them would mean parameterising three different
 * fonts and colour schemes to save nine lines.
 */
function drawButton(
  ctx: CanvasRenderingContext2D,
  region: Region,
  label: string,
  tone: 'quiet' | 'loud',
  hovered: boolean
): void {
  ctx.fillStyle = tone === 'loud' ? '#2f5c3a' : '#22222e';
  ctx.fillRect(region.x, region.y, region.w, region.h);
  ctx.fillStyle = '#ffffff';
  ctx.font = '600 28px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(
    truncate(ctx, label, region.w - 20),
    region.x + region.w / 2,
    region.y + region.h / 2
  );
  if (hovered) {
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 3;
    ctx.strokeRect(region.x - 4, region.y - 4, region.w + 8, region.h + 8);
  }
}

export function drawFriendsPanel(
  ctx: CanvasRenderingContext2D,
  state: FriendsState,
  regions: readonly Region[],
  labels: FriendsLabels,
  hoverId: string | null = null
): void {
  const { width, height } = FRIENDS_PANEL_SIZE;
  const byId = new Map(regions.map((r) => [r.id, r]));
  const asking = state.incoming[0] ?? null;

  ctx.save();
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#14141c';
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = '#ffffff';
  ctx.font = '600 42px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(labels.heading, PAD, HEADER / 2);

  /*
   * The band before the empty check, not after.
   *
   * An invitation can only come from a friend, so an empty list and a pending
   * question should not co-occur - but if they ever did, drawing the "no
   * friends yet" message and returning would hide a question somebody is
   * waiting on an answer to. Cheap insurance against a state nobody planned.
   */
  if (asking) {
    ctx.fillStyle = '#1d2a3a';
    ctx.fillRect(0, HEADER, width, BAND_H);
    ctx.fillStyle = '#ffffff';
    ctx.font = '600 31px system-ui, sans-serif';
    ctx.textAlign = 'left';
    const decline = byId.get(`decline:${asking.id}`);
    const room = (decline ? decline.x : STATUS_RIGHT) - BUTTON_GAP - PAD;
    ctx.fillText(truncate(ctx, labels.incomingFrom, room), PAD, HEADER + BAND_H / 2);

    if (decline) drawButton(ctx, decline, labels.decline, 'quiet', hoverId === decline.id);
    const accept = byId.get(`accept:${asking.id}`);
    if (accept) drawButton(ctx, accept, labels.accept, 'loud', hoverId === accept.id);
  }

  if (state.rows.length === 0) {
    // A blank panel reads as one that failed to load.
    ctx.textAlign = 'center';
    ctx.font = '28px system-ui, sans-serif';
    ctx.fillStyle = '#a0a0b0';
    ctx.fillText(labels.nobody, width / 2, height / 2);
    ctx.restore();
    return;
  }

  const top = HEADER + (asking ? BAND_H : 0);

  state.rows.forEach((row, index) => {
    const y = top + index * ROW_H + ROW_H / 2;
    const invited = state.pending?.toUserId === row.id;

    ctx.beginPath();
    ctx.fillStyle = row.online ? '#3ddc84' : '#4a4a58';
    ctx.arc(PAD + 8, y, 7, 0, Math.PI * 2);
    ctx.fill();

    ctx.textAlign = 'left';
    ctx.fillStyle = row.online ? '#ffffff' : '#8a8a98';
    ctx.font = '31px system-ui, sans-serif';
    ctx.fillText(
      truncate(ctx, row.pseudo, STATUS_RIGHT - STATUS_W - PSEUDO_X - BUTTON_GAP),
      PSEUDO_X,
      y
    );

    /*
     * "Invited" replaces the presence text rather than joining it.
     *
     * The two together would be the panel saying both "they are online" and
     * "we are waiting on them", and the second is the only one the player can
     * act on. `library.ts` makes the same call with its empty-library
     * messages: one line that is true beats two that compete.
     */
    ctx.fillStyle = invited ? '#c8d4ff' : '#8a8a98';
    ctx.font = '25px system-ui, sans-serif';
    ctx.textAlign = 'right';
    const status = invited
      ? labels.invited
      : (row.playing ?? (row.online ? labels.online : labels.offline));
    ctx.fillText(truncate(ctx, status, STATUS_W), STATUS_RIGHT, y);

    const cancel = state.pending && invited ? byId.get(`cancel-invite:${state.pending.id}`) : null;
    if (cancel) {
      drawButton(ctx, cancel, labels.cancel, 'quiet', hoverId === cancel.id);
      return;
    }
    const invite = byId.get(`invite:${row.id}`);
    if (invite) drawButton(ctx, invite, labels.invite, 'loud', hoverId === invite.id);
  });

  ctx.restore();
}
