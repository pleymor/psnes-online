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
import { SMW, EDGE, LINER, drawField, statusBox, ribbon, chromeButton } from './chrome';

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
/*
 * Reculé de la largeur du cadre : les lignes et le bandeau d'invitation sont
 * des boîtes encadrées maintenant, et rendu, « Accepter » venait butter contre
 * le cadre de la sienne - ce qui se lit comme un bouton rogné.
 */
const BUTTON_X = FRIENDS_PANEL_SIZE.width - PAD - BUTTON_W - EDGE - LINER;
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
  /** On the row of a friend who is already here. See `FriendsState.members`. */
  inGroup: string;
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
  /**
   * The user ids already in this player's room.
   *
   * Added because of a reported defect, and its shape is the diagnosis: this
   * panel knew only about INVITATIONS - the one we sent (`pending`) and the
   * ones we receive (`incoming`) - and nothing about who is already here.
   * Accepting an invitation therefore could not change a friend's row, and
   * they kept an Invite button while sitting in the same room. Pressing it
   * would have asked somebody already present to join a room they had not
   * left.
   *
   * A set of ids rather than the room itself: this module stays pure and
   * knows nothing of `RoomView`, exactly as it takes rows rather than the
   * friends store.
   */
  members: ReadonlySet<string>;
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
    /*
     * Already here: nothing to offer, and this comes FIRST.
     *
     * Before the pending branch, because both can be true for one frame - we
     * invite Ada, she accepts, and the invitation's disappearance and the
     * room's new member are two separate updates. Offering to cancel an
     * invitation she has already accepted would be a button that undoes
     * nothing.
     */
    if (state.members.has(row.id)) return;

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
  drawField(ctx, width, height, 'frost');

  statusBox(ctx, PAD - 14, 12, width - (PAD - 14) * 2, HEADER - 24);
  ctx.fillStyle = SMW.ink;
  ctx.font = '600 42px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(labels.heading, PAD + 8, 12 + (HEADER - 24) / 2);

  /*
   * The band before the empty check, not after.
   *
   * An invitation can only come from a friend, so an empty list and a pending
   * question should not co-occur - but if they ever did, drawing the "no
   * friends yet" message and returning would hide a question somebody is
   * waiting on an answer to. Cheap insurance against a state nobody planned.
   */
  if (asking) {
    statusBox(ctx, PAD - 14, HEADER, width - (PAD - 14) * 2, BAND_H);
    ctx.fillStyle = SMW.accent;
    ctx.font = '600 31px system-ui, sans-serif';
    ctx.textAlign = 'left';
    const decline = byId.get(`decline:${asking.id}`);
    const room = (decline ? decline.x : STATUS_RIGHT) - BUTTON_GAP - PAD;
    ctx.fillText(truncate(ctx, labels.incomingFrom, room), PAD, HEADER + BAND_H / 2);

    if (decline) chromeButton(ctx, decline, labels.decline, 'warn', hoverId === decline.id, 28);
    const accept = byId.get(`accept:${asking.id}`);
    if (accept) chromeButton(ctx, accept, labels.accept, 'loud', hoverId === accept.id, 28);
  }

  if (state.rows.length === 0) {
    // A blank panel reads as one that failed to load.
    // Sur une boîte, sinon le texte se perd dans l'herbe.
    const boxW = width - PAD * 2;
    statusBox(ctx, PAD, height / 2 - 50, boxW, 100);
    ctx.textAlign = 'center';
    ctx.font = '28px system-ui, sans-serif';
    ctx.fillStyle = SMW.ink;
    ctx.fillText(truncate(ctx, labels.nobody, boxW - 60), width / 2, height / 2);
    ctx.restore();
    return;
  }

  const top = HEADER + (asking ? BAND_H : 0);

  state.rows.forEach((row, index) => {
    const y = top + index * ROW_H + ROW_H / 2;
    const here = state.members.has(row.id);
    const invited = !here && state.pending?.toUserId === row.id;

    // Un ruban par ligne : sur l'herbe, du texte nu ne se lit pas.
    ribbon(ctx, PAD - 14, top + index * ROW_H + 4, width - (PAD - 14) * 2, ROW_H - 8);

    ctx.beginPath();
    ctx.fillStyle = row.online ? '#2fa34a' : '#8a8a98';
    ctx.arc(PSEUDO_X - 22, y, 8, 0, Math.PI * 2);
    ctx.fill();

    ctx.textAlign = 'left';
    ctx.fillStyle = row.online ? SMW.dark : '#6a6a70';
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
    ctx.fillStyle = here || invited ? '#1a3a8a' : '#6a6a70';
    ctx.font = '25px system-ui, sans-serif';
    ctx.textAlign = 'right';
    /*
     * One line, and being here outranks everything else on it.
     *
     * The rule this row already followed for "Invited" - one line that is
     * true beats two that compete - decides the order: a friend in the room
     * is neither waiting to answer nor merely online, and the game title they
     * would otherwise show is the one this player is in too.
     */
    const status = here
      ? labels.inGroup
      : invited
        ? labels.invited
        : (row.playing ?? (row.online ? labels.online : labels.offline));
    ctx.fillText(truncate(ctx, status, STATUS_W), STATUS_RIGHT, y);

    const cancel = state.pending && invited ? byId.get(`cancel-invite:${state.pending.id}`) : null;
    if (cancel) {
      chromeButton(ctx, cancel, labels.cancel, 'quiet', hoverId === cancel.id, 28);
      return;
    }
    const invite = byId.get(`invite:${row.id}`);
    if (invite) chromeButton(ctx, invite, labels.invite, 'loud', hoverId === invite.id, 28);
  });

  ctx.restore();
}
