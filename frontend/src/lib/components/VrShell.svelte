<script lang="ts">
  /**
   * The immersive session, mounted once in the layout.
   *
   * It lives beside `InvitationCard` for the reason that component's note at
   * `+layout.svelte:130` gives - the layout is the only place that is on screen
   * whatever the player is doing - and for a second reason of its own: it sits
   * above the `<slot />`, so a navigation underneath cannot unmount it.
   *
   * There is exactly one way out. The quit button, the Quest's system menu and
   * a headset put down on the table all arrive as `sessionend`, and
   * `xr-session.ts` guarantees the handler runs once.
   *
   * `xr-session.ts`'s `end()` only guards against a second call once the first
   * has actually settled - its `finished` flag is set from the `end` event, not
   * from the call itself. Two `leave()`s fired close together (the context-lost
   * path today, an in-VR quit button once one exists) could both reach
   * `session.end()` before either settles. `leaving` below is the guard against
   * that: it makes `leave()` itself re-entrancy-safe regardless of how many
   * places end up calling it.
   *
   * `teardown()` and `closeAnySession()` carry different preconditions, and the
   * three call sites are picked to match them rather than sharing one blindly:
   * `teardown()` assumes the browser's `XRSession` is already gone, which is
   * true only from `openVrSession`'s `onEnd` callback below. Anywhere this
   * component can stop existing without that having happened yet - a failure
   * partway through `enter()`, or an ordinary Svelte unmount - has to check
   * first, because a `session` that is still open with nothing left to call
   * `end()` on it is a player stuck in a black room with no way out but a
   * restart.
   */
  import { onDestroy } from 'svelte';
  import { get } from 'svelte/store';
  import { vrRequested, vrActive } from '$lib/vr/entry';
  import { openVrSession, type VrSession } from '$lib/vr/xr-session';
  import { createVrScene, type VrScene } from '$lib/vr/scene';
  import { createDecor, type Decor } from '$lib/vr/decor/build';
  import { measureFloor } from '$lib/vr/decor/floor';
  import { readAspectPreference } from '$lib/stores/aspect-preference';
  import { notifications } from '$lib/services/notification';
  import { language } from '$lib/stores/language';
  import { t } from '$lib/i18n/translations';
  import { createLogger } from '$lib/utils/logger';
  import { createPointer, sameTarget, type PointerTarget } from '$lib/vr/pointer';
  import {
    LIBRARY_PANEL_SIZE, layoutLibraryPanel, drawLibraryPanel,
    libraryRows, clampScroll, type LibraryState
  } from '$lib/vr/panels/library';
  import {
    FRIENDS_PANEL_SIZE, friendRows, layoutFriendsPanel, drawFriendsPanel, friendsVisibleRows
  } from '$lib/vr/panels/friends';
  import {
    PROFILE_PANEL_SIZE, layoutProfilePanel, drawProfilePanel
  } from '$lib/vr/panels/profile';
  import {
    LAUNCH_PANEL_SIZE, layoutLaunchPanel, drawLaunchPanel, type LaunchLabels
  } from '$lib/vr/panels/launch';
  import { launchOptions } from '$lib/vr/launch-options';
  import { activeRooms, myRoom } from '$lib/rooms/my-room';
  import { menuPressed, readVrPad, activeXrInputs, fastForwardHeld } from '$lib/vr/pad';
  import { readBluetoothPad, bluetoothPadName } from '$lib/vr/bt-pad';
  import type { PadMask } from '$lib/znet/protocol';
  import { STANDARD_PAD, normaliseControlsConfig, type PadConfig } from '$lib/controls/binding';
  import {
    readPadMap, writePadMap, assignInput,
    // Ni `LETTERS_MAP` ni `THUMB_MAP` ne sont importés : leurs boutons ont
    // disparu avec les préréglages, et aucun des deux n'est plus le défaut -
    // mais `readPadMap` honore encore les valeurs stockées `'letters'` et
    // `'thumb'` pour ne reprendre son réglage à personne.
    DEFAULT_MAP,
    type VrPadMap, type VrButton, type XrInput
  } from '$lib/vr/pad-map';
  import {
    TABLET_PANEL_SIZE, layoutControlsPanel, drawControlsPanel,
    type ControlsLabels
  } from '$lib/vr/panels/controls';
  import { layoutOptionsPanel, drawOptionsPanel } from '$lib/vr/panels/options';
  import { layoutScreenPanel, drawScreenPanel } from '$lib/vr/panels/screen-settings';
  import {
    readScreenShape, writeScreenShape, stepDistance, stepAngle, stepHeight,
    DEFAULT_SHAPE, type ScreenShape
  } from '$lib/vr/screen-shape';
  import { layoutReliefPanel, drawReliefPanel } from '$lib/vr/panels/relief';
  import {
    readReliefPreset, writeReliefPreset, stepSlot, stepSpacing,
    DEFAULT_RELIEF, type ReliefPreset
  } from '$lib/vr/relief-preset';
  import { VR_SLOT_KEYS, type VrSlotKey } from '$lib/vr/layer-map';
  import { hasSlot } from '$lib/vr/slot-mask';
  // La séquence appartient au dessin, pas au panneau : c'est son ordre de
  // lecture que « tout configurer » parcourt.
  import { BIND_SEQUENCE, nextInSequence } from '$lib/vr/panels/pad-art';
  import { CaptureGate } from '$lib/controls/capture-gate';
  import { user } from '$lib/stores/user';
  import { games, loadGames } from '$lib/stores/games';
  import { deviceLibrary } from '$lib/roms/device-library';
  import {
    resolvableHere, resolveQuietly, remember, keepReceived, type MissReason
  } from '$lib/roms/provider';
  import { receiveRom, sendRom } from '$lib/roms/transfer';
  import { registerGame } from '$lib/roms/local-library';
  import { romFileName } from '$lib/roms/rom-file';
  import type { PanelMesh } from '$lib/vr/panel-mesh';
  import { loadCore, AudioSink, SocketTransport, UpgradingTransport, type SessionEvent, type Transport } from '$lib/znet';
  import { createSoloEngine, type SoloEngine } from '$lib/rooms/solo-engine';
  import { createLockstepEngine, type LockstepEngine } from '$lib/rooms/lockstep-engine';
  import { createRoom, leaveGroup, chooseGameForGroup, inviteToGroup, cancelGroupInvitation } from '$lib/rooms/actions';
  /*
   * Module-scope stores, which is what makes this reachable from in here at
   * all: `lobby/invitations.ts` attaches its listeners to the socket itself
   * rather than from a component's `onMount`, so the invitations addressed to
   * this player stay current while only the headset is mounted.
   */
  import { invitations, acceptInvitation, declineInvitation } from '$lib/lobby/invitations';
  /*
   * Plus de `quick-actions` ici.
   *
   * `quickLoad` émettait `game:load` sans écouteur, alors que ce composant a
   * son propre chemin - `awaitSave` - qui attache un écouteur cadré, pose un
   * timeout et applique l'état différemment en solo et en lockstep. La réponse
   * du serveur arrivait donc sans personne pour l'appliquer, et le bouton
   * Charger ne faisait rien. Les deux fonctions restent pour le F2/F4 de la
   * page plate, qui a les composants qui écoutent.
   */
  import { fetchSaves, deleteSave, autoSaveName, type SaveSummary } from '$lib/saves/api';
  import { captureState } from '$lib/saves/capture';
  import {
    SAVES_PANEL_SIZE, layoutSavesPanel, drawSavesPanel
  } from '$lib/vr/panels/saves';
  import { gameClick } from '$lib/rooms/game-click';
  import { resumeSaveToRequest } from '$lib/rooms/resume-save';
  import { decodeSram } from '$lib/rooms/sram';
  import { toBase64, fromBase64 } from '$lib/saves/base64';
  import { socket } from '$lib/api/socket';
  import { setLogLabels } from '$lib/utils/log-shipper';
  import type { PsnesCore } from '$lib/znet/core';

  const logger = createLogger('VrShell');

  let session: VrSession | null = null;
  let scene: VrScene | null = null;
  let decor: Decor | null = null;
  /** Le lobby est-il à l'écran. Vrai à l'ouverture : aucune partie ne tourne. */
  let decorShowing = true;

  /** Les six sites qui basculent lobby/jeu passent par ici, et rien d'autre. */
  function showDecor(visible: boolean): void {
    decorShowing = visible;
    decor?.setVisible(visible);
  }

  /**
   * Construit le décor dès que le plancher est mesurable.
   *
   * Appelée à chaque image tant qu'elle n'a pas abouti. `measureFloor` rend
   * `null` tant que le suivi n'a pas donné de pose - les toutes premières
   * images d'une session - et construire avec le repli à ce moment-là ferait
   * de 1,20 m le cas normal plutôt que le cas dégradé. Quelques images de
   * retard sont invisibles : le décor naît caché.
   */
  function ensureDecor(): void {
    if (decor || !scene || !session) return;
    const height = measureFloor({
      floorSpace: () => session?.floorSpace ?? null,
      poseOf: (space) => scene?.poseIn(space) ?? null
    });
    if (height === null) return;

    decor = createDecor({ floorHeight: height, maxAnisotropy: scene.maxAnisotropy() });
    scene.addDecor(decor.decor);
    scene.addCurtain(decor.curtain);
    decor.setVisible(decorShowing);
  }

  /** Guards `leave()` against re-entrant calls - see the header. */
  let leaving = false;

  /** Reassigned in `teardown()`, not just used, so a trigger physically
   *  held across a session boundary can't be read as a stale non-edge and
   *  swallow the next session's first press. */
  let pointer = createPointer();
  let library: PanelMesh | null = null;
  let libraryState: LibraryState = { games: [], ownedTotal: 0, scroll: 0 };
  let friendsPanel: PanelMesh | null = null;
  let friendEntries: Array<{ friend: { id: string; pseudo: string } }> = [];
  let onlineFriends = new Map<string, boolean>();
  let profilePanel: PanelMesh | null = null;
  let hovered: PointerTarget | null = null;
  /** Read once on entry: the picker that would change it does not exist in
   *  here, so it cannot change during a session. */
  let resolvable: string[] = [];

  let engine: SoloEngine | LockstepEngine | null = null;

  /*
   * What saving a game needs, gathered where a game is launched.
   *
   * `core` used to be a local of the launch functions, under a comment saying
   * "nothing outside this function ever reads `core` again once
   * `createSoloEngine` has it - this component's own copy was write-only".
   * That was true until the band gained a Save button: `core.saveState()` is
   * the state, and `core.videoFrame()` is the only way to a thumbnail in a
   * session with no canvas. So the decision is reversed, with a reason.
   *
   * Correctness rests on `engine`, not on clearing this. Every read goes
   * through `saveable()`, which refuses when no engine is running - the same
   * condition that decides whether the buttons exist at all. Clearing it in
   * the teardown paths below is hygiene, not the invariant.
   */
  let saveContext: { roomId: string; gameId: string; core: PsnesCore } | null = null;

  /** Reused: a capture allocates nothing but the pixels it copies. */
  let shotCanvas: HTMLCanvasElement | null = null;

  /**
   * The last emulated frame as a canvas, or null.
   *
   * `captureShot` wants a canvas and an immersive session has none - the
   * picture goes straight from `videoSurface()` into a WebGL texture. But
   * `core.videoFrame()` repacks the same frame tightly, which is exactly an
   * `ImageData`, so a save made in the headset gets a real thumbnail rather
   * than the empty well `panels/launch.ts` draws for a save that has none.
   */
  function frameCanvas(): HTMLCanvasElement | null {
    const ctx = saveable();
    if (!ctx) return null;
    const frame = ctx.core.videoFrame();
    if (!shotCanvas) shotCanvas = document.createElement('canvas');
    if (shotCanvas.width !== frame.width || shotCanvas.height !== frame.height) {
      shotCanvas.width = frame.width;
      shotCanvas.height = frame.height;
    }
    const paint = shotCanvas.getContext('2d');
    if (!paint) return null;
    /*
     * Through `createImageData` rather than the `ImageData` constructor.
     *
     * The constructor's typing insists on a `Uint8ClampedArray<ArrayBuffer>`
     * and `videoFrame()` hands back an `ArrayBufferLike` one, which could in
     * principle be shared - so it needs a cast to compile. Asking the context
     * for the buffer and copying into it needs none, and is the canvas's own
     * way of doing this.
     *
     * The copy is required either way: `videoFrame` reuses its scratch array.
     */
    const image = paint.createImageData(frame.width, frame.height);
    image.data.set(frame.data);
    paint.putImageData(image, 0, 0);
    return shotCanvas;
  }

  /** The save context, but only while there is actually a game to save. */
  function saveable(): { roomId: string; gameId: string; core: PsnesCore } | null {
    return engine && saveContext ? saveContext : null;
  }
  let audio: AudioSink | null = null;

  /** Le multiplicateur, le même que celui du pupitre plat. */
  const FAST_FORWARD_SPEED = 4;

  /**
   * L'accéléré, tenu sur le clic du stick gauche.
   *
   * Un drapeau d'état plutôt qu'un appel par frame, et ce n'est pas une
   * économie : `setMuted(true)` VIDE ce qui est en file
   * (`znet/output.ts:218`), donc le rappeler soixante-douze fois par seconde
   * ne laisserait jamais un échantillon atteindre le casque. Seule la
   * transition parle au gouverneur et au puits.
   *
   * Les deux règles dictées par le propriétaire se partagent entre ici et
   * `pad.ts`, selon ce que chacun peut savoir :
   *
   * - « si ce bouton est assigné, alors c'est le bouton assigné qui gagne » se
   *   lit sur la carte, donc `fastForwardHeld` la tient.
   * - « pour l'instant, le clic en partie à deux ne fait rien » ne se lit que
   *   d'ici : `groupRoomId` est ce qui distingue un lockstep d'un solo, et les
   *   DEUX moteurs exposent `governor.setSpeed` - rien dans le type n'aurait
   *   arrêté un accéléré unilatéral, qui ferait attendre le pair un pas par
   *   frame qui n'arrive plus au rythme convenu.
   *
   * Muet pendant le maintien, pour la raison que `SoloRoom.svelte` a déjà
   * écrite à son propre turbo : le puits joue en temps réel et l'accéléré
   * produit jusqu'à quatre fois plus d'échantillons, donc le nourrir pendant
   * ce temps fait grandir une file qui ne se vide jamais.
   */
  let fastForward = false;

  function setFastForward(on: boolean): void {
    if (on === fastForward) return;
    fastForward = on;
    engine?.governor.setSpeed(on ? FAST_FORWARD_SPEED : 1);
    audio?.setMuted(on);
  }
  /**
   * The room this shell created and therefore owes the server.
   *
   * `createRoom` seats the player in a room, and nothing here used to give it
   * back: every VR game left one alive forever. The room outlived the session,
   * so the library page kept offering "back to the room" for a game that had
   * stopped, and - worse than a stray button - the player's friends saw them
   * as playing indefinitely, because `broadcastRoomUpdate` had no reason to
   * think otherwise.
   *
   * Only overwritten on a relaunch, never left behind: the server's own
   * `leaveCurrentRoom` gives up the previous room on every create, so the id
   * this holds is always the only one outstanding.
   */
  let ownedRoomId: string | null = null;
  /** Shown on the lectern when a launch could not read the file. */
  let launchNotice: string | null = null;

  /**
   * La réponse de l'invité à « garder ce jeu ? », et son défaut.
   *
   * Faux par défaut, et ce n'est pas un hasard : `kept-files.ts` posait que ce
   * qu'un hôte envoie n'entre pas de lui-même sur l'appareil de l'invité, et
   * ne rien répondre doit donc ne rien installer. Il faut le geste pour que le
   * fichier reste.
   */
  let keepReceivedRom = false;

  /**
   * Le transfert en cours, déjà mis en mots, ou null.
   *
   * Une chaîne et non un pourcentage : elle est écrite dans la langue du
   * joueur ici, où `t()` existe, et le panneau ne fait que la dessiner. Elle
   * sert aux DEUX sens - l'invité qui reçoit et l'hôte qui envoie - parce que
   * sans elle la partie de l'hôte a l'air de figer pendant qu'il sert
   * plusieurs mégaoctets.
   */
  let romTransfer: string | null = null;

  /**
   * Les octets du jeu en cours, gardés pour servir un invité sans toucher au
   * disque.
   *
   * Le même rôle que `loadedRom` dans `LockstepRoom.svelte`. Sans lui, une
   * demande arrivée pendant la partie repasserait par `resolveQuietly`, dont
   * le chemin nominal est le dossier - et redemander une permission de dossier
   * depuis un casque est « une danse à part entière » (`vr/door.ts`).
   */
  let loadedRom: Uint8Array | null = null;

  /**
   * Qui est déjà servi, pour ne pas répondre deux fois à la même question.
   *
   * Le demandeur répète sa demande toutes les deux secondes jusqu'au premier
   * morceau, donc deux ou trois exemplaires de la même question sont normaux au
   * démarrage. Les servir tous enverrait la ROM deux ou trois fois.
   */
  const serving = new Set<string>();
  /** The dump whose launch options the screen is showing, or null for the
   * checkerboard. */
  let launchFor: string | null = null;
  /**
   * A save staged before a group exists to carry it.
   *
   * Not "solo only" any more: `launch-options.ts`'s `chosenSaveId` reads this
   * whenever the room holds fewer than two players, which is a lone creator's
   * group room just as much as no room at all - `launch-options.ts` explains
   * why that rule is keyed on being a group rather than on a room existing.
   * Once a friend is really there, `room.resumeSaveId` takes over and this is
   * ignored, per the spec's D5.
   */
  let stagedSaveId: string | null = null;
  /**
   * The room and host-ness a live group game is playing under, and the save
   * still owed a `game:load` once the session first reports `running`.
   *
   * Snapshotted in `launchTogether` rather than read fresh from `$myRoom`
   * everywhere: `onSessionEvent` and `awaitSave`'s reply run outside that
   * function's closure, and `hostId` moving to the other player mid-game must
   * not change which peer this session was built to be.
   */
  let groupRoomId: string | null = null;
  let groupIsHost = false;
  /** Null once asked (or for a guest, who never asks - see `resume-save.ts`),
   * so a `running` after a resync cannot re-request and rewind the game. */
  let pendingResumeSaveId: string | null = null;
  /**
   * A plain `let`, set once in `enter()` and reassigned by the switch in
   * `activate()` - never `$: padMap = readPadMap(localStorage)`. Made
   * reactive, that statement would recompute on the very write it triggers
   * (`writePadMap` touches `localStorage`) and overwrite the assignment
   * before the panel ever repaints with it - the button would appear to do
   * nothing.
   */
  let padMap: VrPadMap = DEFAULT_MAP;

  /**
   * Whether the floating tablet is up.
   *
   * It used to be `tabletOpen`, and it used to be mutually exclusive with
   * `launchFor` because both contents shared the curved screen - "one surface,
   * one content". They share nothing now: the tablet is its own panel at its
   * own depth, so a launch screen and a rebinding can both be true at once,
   * and three guards that existed only to arbitrate that contention go with
   * this rename.
   *
   * A union rather than a boolean now, which is what the second option screen
   * was always going to introduce - the note here used to say so. `null` is
   * lowered.
   *
   * `'options'` is the root: the band opens it, and the two settings screens
   * return to it rather than lowering the tablet, which is the « bouton de
   * retour vers le menu principal d'options » this shape was asked for.
   * `'saves'` is opened straight from the band - it is an action, not a
   * setting - so its own way out lowers the tablet.
   */
  type TabletScreen = 'options' | 'controls' | 'saves' | 'screen' | 'relief' | null;
  let tabletScreen: TabletScreen = null;
  /** The tablet's panel, created in `enter()`. Hidden unless a screen is up. */
  let tabletPanel: PanelMesh | null = null;

  /**
   * Where the player put the screen, read once per session in `enter()`.
   *
   * A plain `let` for the same reason `padMap` is one: made reactive, the
   * statement would recompute on the very write it triggers - `writeScreenShape`
   * touches `localStorage` - and overwrite the step before the panel repaints
   * with it, so « + » would appear to do nothing.
   */
  let screenShape: ScreenShape = DEFAULT_SHAPE;

  /**
   * La profondeur entre les couches, pour le jeu en cours.
   *
   * Par jeu et non par appareil, contrairement à la forme de l'écran : ce qui
   * se règle ici dépend de la façon dont CE jeu empile ses plans, et le réglage
   * qui va à Super Mario World ne veut rien dire pour F-Zero. `relief-preset.ts`
   * l'explique et tient le stockage, indexé sur le CRC32 de la cartouche.
   *
   * `reliefCrc32` est celui du jeu chargé, retenu parce que `launchFor` est
   * remis à null au lancement : sans lui, le premier pas sur le panneau
   * n'aurait plus de clé sous laquelle écrire.
   *
   * Un `let` et non un `$:`, pour la raison de `screenShape` juste au-dessus :
   * `writeReliefPreset` touche `localStorage`, donc une réactive recalculerait
   * sur l'écriture qu'elle vient de déclencher.
   */
  let relief: ReliefPreset = DEFAULT_RELIEF;
  let reliefCrc32: string | null = null;

  /**
   * La table de la manette Bluetooth : celle de la page plate, pas une
   * troisième.
   *
   * `STANDARD_PAD` en attendant la réponse du serveur, et en cas d'échec :
   * c'est le mapping `standard` que toute manette moderne annonce, donc une
   * manette non configurée marche telle quelle. Une table vide aurait rendu la
   * manette muette exactement là où le joueur ne peut rien lire.
   *
   * Un `let` et non un `$:` pour la raison de `padMap` : rien ici ne doit
   * recalculer sur une écriture qu'il vient de déclencher.
   */
  let bluetoothConfig: PadConfig = STANDARD_PAD;
  /**
   * Where « configure every button » has got to, or null outside a sequence.
   *
   * An index into `BIND_SEQUENCE` rather than a copy of the remaining
   * buttons: the order belongs to the drawing (`pad-art.ts`), which is what
   * the player is reading, and one number cannot fall out of step with it.
   */
  let bindSequence: number | null = null;
  /** Ce que l'API a répondu pour le jeu courant, le plus récent d'abord. */
  let savesList: SaveSummary[] = [];
  /**
   * Une écriture ou un chargement est en vol.
   *
   * `awaitSave` n'attend qu'une réponse à la fois - un deuxième appel dépose
   * l'écouteur du premier - donc le panneau se fait inerte le temps de l'aller
   * -retour plutôt que de laisser une deuxième pression perdre la première.
   */
  let savesBusy = false;
  /**
   * La sauvegarde dont la suppression est en train d'être demandée, ou null.
   *
   * Ici et pas dans le panneau parce que c'est un état de session : il doit
   * survivre à un repeint (un survol en repeint) et mourir avec la tablette.
   */
  let savesConfirming: string | null = null;
  /** The button waiting for its new input, or null. */
  let listeningFor: VrButton | null = null;
  /**
   * The same gate the flat controls screen uses.
   *
   * Its rule is the one this needs: an input already consumed cannot be
   * consumed again until it has been let go. The trigger that clicked a row is
   * held at that instant, and without the gate it would bind itself to the row
   * it just opened.
   */
  const captureGate = new CaptureGate();

  /** Who is in a running game, from the rooms the socket already publishes -
   *  the same source `TopBar` hands `FriendsList`. */
  $: playingByUserId = new Map(
    $activeRooms
      .filter((room) => room.status === 'playing')
      .flatMap((room) => room.players.map((p) => [p.userId, room.gameTitle ?? ''] as const))
  );

  // `playingByUserId` is read inside `repaintFriends()`, but Svelte 4 derives a
  // reactive statement's dependencies from the identifiers written in the
  // statement itself, not from what the functions it calls happen to read
  // (`renderer-surface.ts`'s header spells this trap out at length). Naming
  // `playingByUserId` here, not just `friendsPanel`, is what makes a friend
  // starting or ending a game while the panel is up repaint it - dropping this
  // reference would make the statement run once and never again.
  $: if (friendsPanel && playingByUserId) repaintFriends();

  /*
   * The invitations, named here for exactly the reason above.
   *
   * Both stores are read inside `repaintFriends()`, so naming them in this
   * statement is the whole of what makes the lectern follow them: an
   * invitation arriving, being answered, expiring, or being taken back has to
   * repaint the panel, and a statement that mentioned only `friendsPanel`
   * would run once at mount and never again.
   *
   * `$myRoom` bare rather than `$myRoom?.invitation`, which is what it used to
   * say. The panel now reads the room's MEMBERS too - that is what removes the
   * Invite button from a friend who has just joined - and a store field named
   * in the guard is easy to mistake for the dependency. It is not: Svelte 4
   * takes the dependencies from the identifiers written here, and the store
   * emits as a whole. Naming the whole room says out loud what this statement
   * actually follows. Verified by compiling and reading `$$self.$$.update`,
   * which is the only thing that settles a question like this.
   */
  $: if (friendsPanel && ($invitations || $myRoom)) repaintFriends();

  /*
   * The newest notification, mirrored where a headset can see it.
   *
   * `notifications.show` draws DOM toasts, and the page's DOM is not rendered
   * during an immersive session - so `quickSave`'s confirmation reached
   * nobody, which is indistinguishable from a Save button that does nothing.
   * Mirroring the store rather than inventing a second channel means
   * `quick-actions.ts` is untouched, the store's own auto-dismiss provides the
   * lifetime, and anything else raised mid-session becomes visible too.
   */
  $: vrNotice = $notifications.at(-1)?.message ?? null;

  /*
   * `vrNotice` named in the statement, not merely read inside
   * `repaintProfile()` - the same Svelte 4 trap the note above
   * `playingByUserId` spells out.
   *
   * Compared against `undefined` rather than tested for truth, and that is
   * deliberate: `null` is a real value here. A plain `&& vrNotice` would skip
   * the repaint that CLEARS the line, leaving the last message on the band for
   * the rest of the session.
   */
  $: if (profilePanel && vrNotice !== undefined) repaintProfile();

  // The room decides half of what this screen shows - the friend's readiness,
  // the staged save, whether the game changed under us. Not the save itself:
  // that is resolved once at launch, never reactively, or a `room:updated`
  // would push it back down over a running game.
  $: if (launchFor && $myRoom) repaintLaunch();
  /*
   * The library changes underneath too, and `repaintLaunch`'s own guard for a
   * dump that left the library only runs when something calls it. A folder
   * sync or a reload from the flat page - both share this store - would
   * otherwise leave a launch screen advertising a game this device no longer
   * has.
   */
  $: if (launchFor && $games) repaintLaunch();

  /*
   * The other way in.
   *
   * The friend can choose a game from their flat page, and then the room
   * carries it and this player never touched anything. It is also the only
   * path by which a game absent from THIS device can reach the launch screen -
   * the lectern only ever offers what `resolvableHere` returned - so it is the
   * path that earns the `rom-missing` refusal.
   */
  /*
   * No `!tabletOpen` guard any more, and that is the tablet paying for itself.
   *
   * This used to wait for a rebinding to finish: a friend choosing a game
   * would take the curved screen out from under a player halfway through
   * binding a button, leaving `listeningFor` set on a panel nobody was looking
   * at. The two contents sit on different surfaces now, so a friend's choice
   * repaints the screen while the rebinding carries on untouched.
   */
  $: if ($myRoom?.gameCrc32 && $myRoom.gameCrc32 !== launchFor && $myRoom.status === 'waiting') {
    launchFor = $myRoom.gameCrc32;
    stagedSaveId = null;
    repaintLaunch();
  }

  /**
   * Cover art, and the one rule that decides whether this panel exists at all.
   *
   * `coverUrl` comes in two flavours and they need opposite treatment. An
   * uploaded cover is same-origin — `/api/covers/<id>` behind `requireAuth`
   * (`api/covers.ts:9`) — so it needs the session cookie and must NOT carry a
   * `crossOrigin` attribute, which would strip credentials and 401. A cover
   * from the community metadata is an absolute URL to somebody else's host
   * (`raw.githubusercontent.com/libretro-thumbnails/...`,
   * `images.launchbox-app.com/...`), and drawing one of those into a canvas
   * WITHOUT CORS taints it — after which WebGL refuses `texSubImage2D` on the
   * whole texture, so the panel renders with no map and, being transparent,
   * disappears entirely. Not a missing picture: a missing panel.
   *
   * So the attribute is set per URL. GitHub's thumbnails send
   * `Access-Control-Allow-Origin: *` and load fine; launchbox sends no CORS at
   * all, so those fail `onerror` and are skipped — a title with no box art,
   * which is what `drawLibraryPanel` already draws for an unidentified game.
   */
  const covers = new Map<string, CanvasImageSource>();

  /**
   * Save thumbnails, keyed by save id, and the reason they need none of the
   * care above.
   *
   * `Save.screenshot` is a PNG `data:` URL served inline by `/api/games`, not
   * a URL to anybody's host. A `data:` image cannot taint a canvas, so there
   * is no `crossOrigin` to set and no host that can refuse - the only failure
   * left is a malformed payload, which lands in `onerror` and leaves the row
   * with its two lines of text.
   */
  const saveShots = new Map<string, CanvasImageSource>();

  /** Whether a cover lives on somebody else's host, and so needs CORS. */
  function isForeign(url: string): boolean {
    try {
      return new URL(url, location.href).origin !== location.origin;
    } catch {
      // An unparseable URL is not something to reason about; treat it as
      // foreign so it can only ever fail safely.
      return true;
    }
  }

  function repaintLibrary(): void {
    if (!library) return;
    library.regions = layoutLibraryPanel(libraryState);
    const regions = library.regions;
    const notice = launchNotice;
    // One `paint()`, not two: each call rasterises the whole canvas and
    // uploads a texture, so a second call for the notice overlay used to cost
    // a repeat of both for what is really one logical repaint.
    library.paint((ctx) => {
      drawLibraryPanel(ctx, libraryState, regions, {
        labels: {
          heading: t($language, 'library'),
          emptyLibrary: t($language, 'emptyLibrary'),
          emptyLibraryHint: t($language, 'vrAddGamesFlat'),
          noneHere: t($language, 'noneOnThisDevice', { count: libraryState.ownedTotal }),
          noneHereHint: t($language, 'vrAddGamesFlat')
        },
        hoverId: hovered?.panel === 'library' ? hovered.region.id : null,
        covers
      });
      if (notice) {
        ctx.save();
        ctx.fillStyle = '#7a2222';
        // 56 and 28 rather than 40 and 20: these are canvas pixels, and the
        // lectern's canvas grew with everything drawn on it.
        ctx.fillRect(0, 0, LIBRARY_PANEL_SIZE.width, 56);
        ctx.fillStyle = '#ffffff';
        ctx.font = '25px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(notice, LIBRARY_PANEL_SIZE.width / 2, 28);
        ctx.restore();
      }
    });
  }

  function repaintFriends(): void {
    if (!friendsPanel) return;

    const asking = $invitations[0] ?? null;
    const pending = $myRoom?.invitation
      ? { id: $myRoom.invitation.id, toUserId: $myRoom.invitation.toUserId }
      : null;

    /*
     * The cap and the pinned friend both come from the same two facts, so they
     * are computed together: a band costs the list a row, and the friend we
     * have asked is kept at the top because their row carries the only way to
     * take the invitation back (`panels/friends.ts` has the long version).
     */
    const rows = friendRows(
      friendEntries,
      onlineFriends,
      playingByUserId,
      friendsVisibleRows(!!asking),
      pending?.toUserId
    );

    /*
     * Qui est déjà là, ce que seul ce composant sait.
     *
     * `$myRoom.players` porte les `userId`, et le store se met à jour de
     * lui-même quand une invitation est acceptée - dans les deux sens - donc
     * ce simple ensemble suffit à faire disparaître le bouton « Inviter » de
     * la ligne d'un ami qui vient de nous rejoindre. C'est le défaut rapporté :
     * accepter marchait, et sa ligne continuait de proposer de l'inviter.
     *
     * Mon propre id peut y être sans conséquence : la liste ne contient que
     * des amis, donc aucune ligne ne me porte.
     */
    const members = new Set(($myRoom?.players ?? []).map((player) => player.userId));

    const state = { rows, pending, incoming: asking ? [asking] : [], members };
    friendsPanel.regions = layoutFriendsPanel(state);
    const regions = friendsPanel.regions;
    const hoverId = hovered?.panel === 'friends' ? hovered.region.id : null;

    friendsPanel.paint((ctx) =>
      drawFriendsPanel(ctx, state, regions, {
        heading: t($language, 'friends'),
        online: t($language, 'online'),
        offline: t($language, 'offline'),
        nobody: t($language, 'vrNoFriends'),
        invite: t($language, 'vrInvite'),
        invited: t($language, 'vrInvited'),
        cancel: t($language, 'vrCancelInvite'),
        accept: t($language, 'vrAcceptInvite'),
        decline: t($language, 'vrDeclineInvite'),
        inGroup: t($language, 'vrInGroup'),
        incomingFrom: asking
          ? t($language, 'vrInvitesYou', { pseudo: asking.fromPseudo })
          : ''
      }, hoverId)
    );
  }

  function repaintProfile(): void {
    if (!profilePanel) return;
    const state = { pseudo: $user?.pseudo ?? '', playing: engine !== null, notice: vrNotice };
    profilePanel.regions = layoutProfilePanel(state);
    const regions = profilePanel.regions;
    profilePanel.paint((ctx) =>
      drawProfilePanel(ctx, state, regions, {
        labels: {
          options: t($language, 'vrOptions'),
          recenter: t($language, 'vrRecenter'),
          saves: t($language, 'vrSaves'),
          quit: t($language, 'vrQuit'),
          resume: t($language, 'vrResume'),
          stopGame: t($language, 'vrStopGame')
        },
        hoverId: hovered?.panel === 'profile' ? hovered.region.id : null
      })
    );
  }

  function repaintLaunch(): void {
    if (!scene || launchFor === null) return;
    const options = launchOptions({
      library: $games,
      crc32: launchFor,
      room: $myRoom ?? null,
      me: $user?.id ?? '',
      openable: new Set(resolvable ?? []),
      /*
       * Le jeu de la room, pour un dump qui n'est dans aucune entrée.
       *
       * Sans ça `launchOptions` rend null et le bloc ci-dessous remet le
       * damier de test : c'est ce qu'un invité qui ne possédait pas le jeu a
       * eu devant les yeux, sans titre, sans jaquette et sans bouton.
       */
      roomGame:
        $myRoom?.gameCrc32 === launchFor && $myRoom.gameTitle
          ? { title: $myRoom.gameTitle, coverUrl: $myRoom.gameCoverUrl }
          : undefined,
      stagedSaveId,
      // What a save is CALLED, decided by the same `saveIdentity` the flat
      // grid uses. Without these two the headset prints the stored name, and
      // the quick save's stored name is the sentinel `__quick__`.
      locale: $language,
      quickSaveLabel: t($language, 'quickSave')
    });
    // The dump left the library while its screen was up - a folder sync can do
    // that. Back to the test pattern rather than a half-drawn screen.
    if (!options) {
      launchFor = null;
      scene.screen.regions.length = 0;
      scene.screen.showTestPattern();
      showDecor(true);
      return;
    }

    // La jaquette de ce jeu-là : son id est dérivé du dump quand il ne vient
    // pas d'une entrée de bibliothèque, donc `loadCovers` ne l'a jamais vue.
    loadCover(options.game.id, options.game.coverUrl);

    const labels = launchLabels();
    const regions = layoutLaunchPanel(options, labels);
    // Replaced in place: `scene.aimedAt` holds this same array.
    scene.screen.regions.length = 0;
    scene.screen.regions.push(...regions);
    // Before the paint, so a thumbnail already decoded from an earlier visit
    // to this screen is in the map by the time the row is drawn.
    loadSaveShots(options.saves);
    scene.screen.paintPanel(LAUNCH_PANEL_SIZE, (ctx) =>
      drawLaunchPanel(ctx, options, regions, {
        labels,
        hoverId: hovered?.panel === 'screen' ? hovered.region.id : null,
        covers,
        shots: saveShots,
        keepRom: keepReceivedRom,
        transfer: romTransfer
      })
    );
  }

  /**
   * Decodes the save thumbnails this screen is about to draw.
   *
   * Keyed by save id and never evicted while the session lasts: a player moves
   * between the launch screen and a game repeatedly, and re-decoding the same
   * five PNGs each time is work with no visible result. `teardown` clears it
   * with everything else.
   */
  function loadSaveShots(saves: readonly { id: string; screenshot: string | null }[]): void {
    for (const save of saves) {
      if (!save.screenshot || saveShots.has(save.id)) continue;
      const image = new Image();
      image.onload = () => {
        saveShots.set(save.id, image);
        // Les deux surfaces : l'écran de lancement ET le panneau de la
        // tablette. Chacune se garde elle-même, donc appeler les deux est sûr.
        repaintLaunch();
        repaintSaves();
      };
      // A payload that will not decode. The row keeps its name and its date,
      // which is what identifies it anyway - the picture only ever confirmed.
      image.onerror = () => logger.warn('save thumbnail unreadable in VR', save.id);
      image.src = save.screenshot;
    }
  }

  function launchLabels(): LaunchLabels {
    return {
      newGame: t($language, 'vrNewGame'),
      saveLockedByCreator: t($language, 'vrSaveLockedByCreator'),
      launch: t($language, 'vrLaunch'),
      port1: t($language, 'vrPort1'),
      port2: t($language, 'vrPort2'),
      waitingForFriend: t($language, 'vrWaitingForFriend'),
      friendReady: t($language, 'vrFriendReady'),
      romMissing: t($language, 'vrRomMissing'),
      romIncoming: t($language, 'vrRomIncoming'),
      keepQuestion: t($language, 'keepRom'),
      yes: t($language, 'yes'),
      no: t($language, 'no'),
      keepRomLegal: t($language, 'keepRomLegal'),
      alreadyPlaying: t($language, 'vrAlreadyPlaying'),
      noSeat: t($language, 'vrNoSeat'),
      gameChanged: t($language, 'vrGameChanged'),
      friendAway: t($language, 'vrFriendAway'),
      friendAwayBlocked: t($language, 'vrFriendAwayBlocked')
    };
  }

  /** Repeint la tablette, quel que soit l'écran qu'elle porte. */
  function repaintTablet(): void {
    if (tabletScreen === 'options') repaintOptions();
    if (tabletScreen === 'controls') repaintControls();
    if (tabletScreen === 'saves') repaintSaves();
    if (tabletScreen === 'screen') repaintScreenSettings();
    if (tabletScreen === 'relief') repaintRelief();
  }

  function repaintOptions(): void {
    if (!tabletPanel || tabletScreen !== 'options') return;
    tabletPanel.regions = layoutOptionsPanel();
    const regions = tabletPanel.regions;
    tabletPanel.paint((ctx) =>
      drawOptionsPanel(ctx, regions, {
        labels: {
          heading: t($language, 'vrOptions'),
          controls: t($language, 'vrRemapHeading'),
          screen: t($language, 'vrScreen'),
          relief: t($language, 'vrRelief'),
          close: t($language, 'vrRemapDone')
        },
        hoverId: hovered?.panel === 'tablet' ? hovered.region.id : null
      })
    );
  }

  function repaintScreenSettings(): void {
    if (!tabletPanel || tabletScreen !== 'screen') return;
    tabletPanel.regions = layoutScreenPanel(screenShape);
    const regions = tabletPanel.regions;
    tabletPanel.paint((ctx) =>
      drawScreenPanel(ctx, screenShape, regions, {
        labels: {
          heading: t($language, 'vrScreen'),
          distance: t($language, 'vrScreenDistance'),
          size: t($language, 'vrScreenSize'),
          height: t($language, 'vrScreenHeight'),
          shape: t($language, 'vrScreenShape'),
          flat: t($language, 'vrScreenFlat'),
          curved: t($language, 'vrScreenCurved'),
          close: t($language, 'vrRemapDone'),
          /*
           * Formaté ici, pas dans le panneau : la virgule décimale est une
           * question de locale, et le panneau est testé depuis Bun, qui ne
           * résout pas l'alias des traductions. La même frontière que
           * `quickSave` pour le panneau des sauvegardes.
           */
          metres: (value) => `${value.toFixed(1).replace('.', $language === 'fr' ? ',' : '.')} m`,
          degrees: (value) => `${value}°`,
          // Signé, et sans signe à zéro : c'est un écart au niveau des yeux,
          // et « +0 cm » comme « −0 cm » seraient tous les deux faux.
          centimetres: (value) =>
            value === 0
              ? '0 cm'
              : `${value > 0 ? '+' : '−'}${Math.abs(Math.round(value * 100))} cm`
        },
        hoverId: hovered?.panel === 'tablet' ? hovered.region.id : null
      })
    );
  }

  /**
   * Applique une forme d'écran : la géométrie, le stockage, le panneau.
   *
   * Les trois ensemble et dans cet ordre, parce que c'est l'ordre dans lequel
   * le joueur les perçoit : l'écran bouge sous ses yeux pendant qu'il règle -
   * il n'y a pas de bouton « Appliquer », et c'est ce qui rend le panneau
   * utilisable puisque l'écran est juste derrière la tablette. Le repeint
   * vient en dernier parce que les crans de bout d'échelle changent de région
   * avec la valeur.
   */
  function applyScreenShape(next: ScreenShape): void {
    screenShape = next;
    scene?.reshapeScreen(next);
    writeScreenShape(localStorage, next);
    repaintScreenSettings();
  }

  /**
   * Le nom d'un créneau, tel qu'un joueur le lit.
   *
   * Ici plutôt que dans le panneau, comme les formats de nombres : « BG1 » est
   * un nom de matériel qui ne se traduit pas, la moitié haute ou basse se
   * traduit, et la jointure entre les deux est une question de locale. Le
   * panneau est testé depuis Bun, qui ne résout pas l'alias des traductions.
   */
  function reliefSlotLabel(key: VrSlotKey): string {
    if (key === 'backdrop') return t($language, 'vrReliefBackdrop');
    if (key === 'sprite') return t($language, 'vrReliefSprites');
    const [layer, half] = key.split('.');
    const side = half === 'hi' ? 'vrReliefFront' : 'vrReliefBehind';
    return `${layer.toUpperCase()} ${t($language, side)}`;
  }

  function repaintRelief(): void {
    if (!tabletPanel || tabletScreen !== 'relief') return;
    /*
     * Les créneaux de la DERNIÈRE image, relus à chaque repeint.
     *
     * Un créneau sans pixels n'est pas une rangée (`panels/relief.ts` dit
     * pourquoi), et ce que l'image contient dépend du mode BG, qui change
     * quelques fois par partie - jamais pendant qu'un panneau de réglage est
     * levé. Le relire au repeint plutôt que de s'y abonner évite soixante
     * notifications par seconde pour un panneau fermé.
     */
    const present = scene?.screen.presentSlots() ?? 0;
    const state = {
      preset: relief,
      slots: VR_SLOT_KEYS.filter((_, index) => hasSlot(present, index))
    };
    tabletPanel.regions = layoutReliefPanel(state);
    const regions = tabletPanel.regions;
    tabletPanel.paint((ctx) =>
      drawReliefPanel(ctx, state, regions, {
        labels: {
          heading: t($language, 'vrRelief'),
          strength: t($language, 'vrReliefStrength'),
          close: t($language, 'vrRemapDone'),
          slot: reliefSlotLabel,
          // Des centimètres entiers : toute la hauteur de l'échelle en est
          // faite (`RELIEF_DISTANCES`), et « 0,15 m » se lit moins bien que
          // « 15 cm » sur une boîte de 120 px.
          centimetres: (metres) => `${Math.round(metres * 100)} cm`,
          // L'espace avant le pour-cent est français et non anglais, et c'est
          // exactement le genre de détail qui n'a pas sa place dans un module
          // testé sans les traductions.
          percent: (multiplier) =>
            `${Math.round(multiplier * 100)}${$language === 'fr' ? ' ' : ''}%`
        },
        hoverId: hovered?.panel === 'tablet' ? hovered.region.id : null
      })
    );
  }

  /**
   * Applique un relief : la scène, le stockage, le panneau.
   *
   * Le même ordre qu'`applyScreenShape`, et pour la même raison : c'est
   * l'ordre dans lequel le joueur les perçoit. L'image est juste derrière la
   * tablette, donc les plans s'écartent sous ses yeux pendant qu'il presse -
   * il n'y a pas de bouton « Appliquer », et c'est ce qui rend le panneau
   * réglable du tout. Le repeint vient en dernier parce que les crans de bout
   * d'échelle changent de région avec la valeur : repeindre d'abord
   * redessinerait les régions de l'état précédent.
   *
   * L'écriture est sans effet tant qu'aucun jeu n'est chargé (`reliefCrc32`
   * null), et `writeReliefPreset` refuse déjà une clé qui n'est pas un CRC32.
   */
  function applyRelief(next: ReliefPreset): void {
    relief = next;
    scene?.screen.setRelief(next);
    if (reliefCrc32) writeReliefPreset(localStorage, reliefCrc32, next);
    repaintRelief();
  }

  /**
   * Le réglage retenu pour ce jeu, au lancement.
   *
   * Les deux chemins de lancement - solo et à deux - passent par ici, parce
   * que l'écran est construit à l'ouverture de la session et le jeu choisi
   * après : un réglage par jeu ne peut pas être un argument de construction,
   * ce que `setRelief` existe pour dire.
   */
  function loadReliefFor(crc32: string): void {
    reliefCrc32 = crc32;
    relief = readReliefPreset(localStorage, crc32);
    scene?.screen.setRelief(relief);
  }

  function repaintSaves(): void {
    if (!tabletPanel || tabletScreen !== 'saves') return;
    const state = {
      saves: savesList,
      shots: saveShots,
      locale: $language,
      busy: savesBusy,
      confirming: savesConfirming
    };
    tabletPanel.regions = layoutSavesPanel(state);
    const regions = tabletPanel.regions;
    tabletPanel.paint((ctx) =>
      drawSavesPanel(ctx, state, regions, {
        heading: t($language, 'vrSaves'),
        newSave: t($language, 'vrNewSave'),
        close: t($language, 'vrRemapDone'),
        empty: t($language, 'vrNoSaves'),
        // Passé plutôt que traduit dans `saveIdentity` : ce module est testé
        // depuis Bun, qui ne résout pas l'alias des traductions.
        quickSave: t($language, 'quickSave'),
        overwrite: t($language, 'overwrite'),
        remove: t($language, 'delete'),
        confirmRemove: t($language, 'vrDeleteSave'),
        yes: t($language, 'yes'),
        no: t($language, 'no')
      }, hovered?.panel === 'tablet' ? hovered.region.id : null)
    );
  }

  /** Rafraîchit la liste depuis l'API, puis repeint. */
  async function refreshSaves(): Promise<void> {
    const ctx = saveable();
    if (!ctx) return;
    const listed = await fetchSaves(ctx.gameId);
    if (!listed.ok) {
      notifications.show(t($language, listed.reason), 'error');
      /*
       * Repeindre quand même, et c'est le point.
       *
       * L'appelant a posé `busy` avant d'appeler, donc la dernière image du
       * panneau est son état inerte - sans régions. Retourner sans repeindre
       * le laisserait figé et muet pour le reste de la session, et le seul
       * signe serait une notice sur le bandeau, derrière la tablette.
       */
      repaintSaves();
      return;
    }
    savesList = listed.saves;
    loadSaveShots(savesList);
    repaintSaves();
  }

  function repaintControls(): void {
    if (!tabletPanel || tabletScreen !== 'controls') return;
    const state = { map: padMap, listeningFor, language: $language };
    tabletPanel.regions = layoutControlsPanel(state);
    const regions = tabletPanel.regions;
    tabletPanel.paint((ctx) =>
      drawControlsPanel(ctx, state, regions, {
        labels: controlsLabels(),
        hoverId: hovered?.panel === 'tablet' ? hovered.region.id : null
      })
    );
  }

  function controlsLabels(): ControlsLabels {
    return {
      heading: t($language, 'vrRemapHeading'),
      press: t($language, 'vrRemapPress'),
      restoreDefaults: t($language, 'vrRestoreDefaults'),
      done: t($language, 'vrRemapDone'),
      bindAll: t($language, 'vrRemapBindAll'),
      fixedDpad: t($language, 'vrFixedDpad'),
      fixedMenu: t($language, 'vrFixedMenu'),
      fixedTurbo: t($language, 'vrFixedTurbo'),
      /*
       * Lu au moment du peint, et pas gardé dans un état.
       *
       * Une manette qu'on allume ou qu'on éteint pendant la session change
       * cette ligne, et `gamepadconnected` repeint le panneau (voir `enter`).
       * Une copie dans une variable serait une deuxième vérité à tenir à jour.
       */
      fixedPad: (() => {
        const name = bluetoothPadName(gamepadsHere());
        return name
          ? t($language, 'vrPadDetected', { name })
          : t($language, 'vrPadNone');
      })(),
      // Each language named in ITSELF, not in the current one: somebody who
      // has landed in the wrong language has to be able to read their way out.
      langEn: 'English',
      langFr: 'Français',
      // Literals, not translation keys: "A" and "START" are silkscreened on
      // the cartridge pad and identical in both languages. Translating them
      // would invent a divergence between the screen and the plastic.
      button: {
        a: 'A', b: 'B', x: 'X', y: 'Y',
        l: 'L', r: 'R',
        start: 'START', select: 'SELECT'
      },
      input: {
        XrLeftTrigger: t($language, 'vrXrLeftTrigger'),
        XrRightTrigger: t($language, 'vrXrRightTrigger'),
        XrLeftSqueeze: t($language, 'vrXrLeftSqueeze'),
        XrRightSqueeze: t($language, 'vrXrRightSqueeze'),
        XrLeftFaceUpper: t($language, 'vrXrLeftFaceUpper'),
        XrRightFaceUpper: t($language, 'vrXrRightFaceUpper'),
        XrLeftFaceLower: t($language, 'vrXrLeftFaceLower'),
        XrRightFaceLower: t($language, 'vrXrRightFaceLower'),
        XrLeftStickClick: t($language, 'vrXrLeftStickClick')
      }
    };
  }

  /** Opens the remap panel, taking the curved screen from whatever held it. */
  /**
   * Raises the tablet. The curved screen does not move.
   *
   * The `launchFor = null` this function opened with is gone: opening the
   * controls used to abandon the launch screen, because the two fought over
   * one surface. They do not any more, so the game keeps playing and a launch
   * screen keeps its place behind the tablet.
   */
  function openTablet(screen: Exclude<TabletScreen, null>): void {
    tabletScreen = screen;
    listeningFor = null;
    savesBusy = false;
    savesConfirming = null;
    captureGate.reset();
    if (tabletPanel) tabletPanel.mesh.visible = true;
    repaintTablet();
    // Après le premier peint, pas avant : la liste arrive du réseau et le
    // panneau doit exister à l'écran pendant l'attente.
    if (screen === 'saves') void refreshSaves();
  }

  /**
   * Closes the remap panel and gives the screen back.
   *
   * Back to the game's picture while one is running, and to the launch options
   * otherwise - the same two states the screen has when nothing opened this
   * panel in the first place.
   */
  /**
   * Lowers the tablet. There is nothing to hand back.
   *
   * This function used to restore the curved screen - the game's picture if
   * one was running, the launch screen otherwise - because opening the panel
   * had taken it. It never takes it now, so all that remains is to hide the
   * panel and drop its regions.
   *
   * `mesh.visible` is what makes it stop being a pointer target, and only
   * because `aimable` (`panel.ts`) says so: three's raycaster would happily go
   * on hitting a hidden mesh.
   */
  function closeTablet(): void {
    tabletScreen = null;
    bindSequence = null;
    listeningFor = null;
    savesBusy = false;
    savesConfirming = null;
    captureGate.reset();
    if (tabletPanel) {
      tabletPanel.regions.length = 0;
      tabletPanel.mesh.visible = false;
    }
  }

  function loadCovers(list: typeof $games): void {
    for (const game of list) loadCover(game.id, game.coverUrl);
  }

  /**
   * One cover, by the key the panels look it up under.
   *
   * Split out of `loadCovers` because the launch screen now draws a game that
   * is in NO library entry - the room's own, for a guest who does not own it -
   * and that entry's id is derived from the dump (`launch-options.ts`) rather
   * than taken from a row that does not exist.
   */
  function loadCover(id: string, url?: string): void {
    const game = { id, coverUrl: url };
    if (!game.coverUrl || covers.has(game.id)) return;
    const image = new Image();
    // Before `src`, or the attribute does not apply to the request. See the
    // note on `covers` for why this is per-URL rather than always or never.
    if (isForeign(game.coverUrl)) image.crossOrigin = 'anonymous';
    // Both surfaces: the lectern's grid AND the launch screen's jaquette.
    // Repainting only the library is what left the curved screen showing its
    // placeholder rectangle for the whole session - the cover had loaded,
    // nothing asked for it to be drawn again.
    image.onload = () => {
      covers.set(game.id, image);
      repaintLibrary();
      repaintLaunch();
    };
    // A host that sends no CORS headers lands here. Nothing to do: the game
    // keeps its title, and never entering `covers` is what stops a tainted
    // image from reaching the canvas.
    image.onerror = () => logger.warn('cover unavailable in VR', game.coverUrl);
    image.src = game.coverUrl;
  }

  function activate(target: PointerTarget): void {
    /*
     * The friends lectern, which used to have nothing to activate.
     *
     * Every branch here delegates: `rooms/actions.ts` opens the group's room
     * if there is not one yet and sends the invitation,
     * `lobby/invitations.ts` answers the ones addressed to us. No socket
     * traffic is composed in this component, and no invitation state is held
     * here - the repaint reads both stores, so the panel follows the server
     * rather than an optimistic guess that a refusal would leave stranded.
     */
    if (target.panel === 'friends') {
      const id = target.region.id;
      if (id.startsWith('invite:')) {
        // Fire and forget: `inviteToGroup` may have to open a room first, and
        // the panel is repainted by the store update that follows either way.
        void inviteToGroup(id.slice('invite:'.length));
        return;
      }
      if (id.startsWith('cancel-invite:')) {
        cancelGroupInvitation(id.slice('cancel-invite:'.length));
        return;
      }
      if (id.startsWith('accept:')) {
        /*
         * Accepting does not navigate, and must not. The group forms and both
         * players stay where they are - and the `vrActive` guard at
         * `+layout.svelte:62` is what stops `room:opened` from mounting a
         * second emulator underneath this session if the room already has a
         * game. What reaches us instead is `myRoom`, which the launch screen
         * already watches.
         */
        acceptInvitation(id.slice('accept:'.length));
        return;
      }
      if (id.startsWith('decline:')) {
        declineInvitation(id.slice('decline:'.length));
        return;
      }
      return;
    }

    if (target.panel === 'library') {
      if (target.region.id === 'scroll:up' || target.region.id === 'scroll:down') {
        const step = target.region.id === 'scroll:down' ? 1 : -1;
        libraryState = {
          ...libraryState,
          scroll: clampScroll(libraryState.scroll + step, libraryRows(libraryState))
        };
        repaintLibrary();
        return;
      }
      if (target.region.id.startsWith('game:')) {
        const gameId = target.region.id.slice('game:'.length);
        const game = libraryState.games.find((candidate) => candidate.id === gameId);
        // The remap panel used to stand down here, because picking a game
        // handed it the curved screen it was drawn on. It is on the tablet
        // now and keeps whatever it was doing.
        // Stages the launch screen instead of launching straight away: the
        // screen is the only place a save can be chosen or a friend seen.
        /*
         * Not while a launch is in flight.
         *
         * Without this, staging game B over a launching game A left the
         * player looking at B's options while A booted underneath and took
         * the screen - and their click on B's `launch` was silently swallowed
         * by `launch`'s own `launching` guard. Worse, restaging the SAME game
         * cleared `stagedSaveId` before `launch` had read it, so a save the
         * player had explicitly chosen was dropped and the game started fresh
         * with no notice.
         */
        if (launching) return;
        if (!game?.crc32) return;
        const click = gameClick($myRoom);

        // `blocked` means the room is playing: the profile band carries the way
        // back into it, and there is nothing for this click to do.
        if (click.kind === 'blocked') {
          launchNotice = t($language, 'vrAlreadyPlaying');
          repaintLibrary();
          return;
        }

        launchFor = game.crc32;
        stagedSaveId = null;
        launchNotice = null;

        if (click.kind === 'choose-for-group') {
          // This is what opens the room, and it opens it for BOTH of us: the
          // server answers with `room:opened` to every member, which navigates
          // the friend to the room page. It does not navigate this player -
          // `+layout.svelte` returns early while `vrActive` is set, a guard
          // written to prevent an accident that turns out to be the mechanism.
          chooseGameForGroup(click.roomId, { id: game.id, title: game.title });
        }

        repaintLibrary();
        repaintLaunch();
      }
      return;
    }

    if (target.panel === 'profile') {
      const id = target.region.id;
      if (id === 'quit') { void leave(); return; }
      // Ends the GAME and stays in the headset. `quit` above ends the session
      // itself, which was the only way out of a running game and so the only
      // way back to the library: a player who had simply finished had to take
      // the headset off and put it back on.
      if (id === 'stop') { void stopTogether(); return; }
      /*
       * Le menu, plus la panneau de remap directement.
       *
       * Le bandeau n'avait plus de créneau pour un septième bouton : trois
       * colonnes est un plancher (quatre tronquaient les libellés, une
       * troisième rangée ramènerait les cibles à 5,5 degrés), donc le bandeau
       * garde les ACTIONS et les réglages passent derrière une entrée. Voir
       * `panels/options.ts`.
       */
      if (id === 'options') { openTablet('options'); return; }
      /*
       * Puts the room back in front of the player.
       *
       * Deliberately manual as well as automatic. `scene.recenter()` already
       * runs once when the session first becomes genuinely visible - which is
       * what stops the Quest's boundary dialog deciding where the room goes -
       * and again if the runtime moves the origin. Neither covers a player who
       * has simply turned or shifted in their chair, and only they know when
       * that has happened. See `vr/anchor.ts`.
       */
      if (id === 'recenter') { scene?.recenter(); return; }

      /*
       * Back to the game, so the game gets its screen back.
       *
       * This branch was DELETED by a range replacement that swapped the band's
       * two quick-slot buttons for one, and took the handler sitting between
       * them with it. The region kept being drawn and aimed at, and did
       * nothing: a player had to quit the game and relaunch it. Nothing could
       * see that - the panel tests check the region exists, and the dispatch
       * lives in a component they cannot reach - so
       * `vr-regions-handled.test.ts` now reads both sources and refuses an
       * orphan.
       *
       * The launch screen is abandoned rather than kept: `launchFor`
       * surviving here would leave regions on a mesh that is a picture again.
       */
      if (id === 'resume') {
        launchFor = null;
        // `closeTablet()`, not the flag alone: hiding the panel group makes
        // the tablet invisible for now, but its own `mesh.visible` would stay
        // true and it would reappear the next time the panels are recalled.
        closeTablet();
        if (scene) scene.screen.regions.length = 0;
        scene?.screen.showPicture();
        showDecor(false);
        scene?.panelsVisible(false);
        return;
      }

      /*
       * The list, not a quick slot.
       *
       * The band had Save and Load acting on a single overwritten slot, and
       * Load did not work at all - it went through the flat page's
       * `quickLoad`, which emits `game:load` with no listener. The tablet's
       * panel lists, writes and loads through this component's own
       * `awaitSave`.
       */
      if (id === 'saves') {
        if (!saveable()) {
          notifications.show(t($language, 'failedToSave'), 'error');
          return;
        }
        openTablet('saves');
        return;
      }

      // The presets and the language used to be answered here. They live on
      // the remap panel now - `panels/profile.ts`' header says why.
    }

    // Its own panel now, so no ordering against the launch screen's branch is
    // needed: they no longer share `scene.screen.regions`.
    if (target.panel === 'tablet') {
      const id = target.region.id;

      /*
       * Le menu d'options : la racine de la tablette.
       *
       * Sa sortie referme la tablette, là où celle des deux panneaux de
       * réglage remonte ici. C'est ce qui fait de ce panneau une racine
       * plutôt qu'un étage de plus.
       */
      if (tabletScreen === 'options') {
        if (id === 'controls') { openTablet('controls'); return; }
        if (id === 'screen') { openTablet('screen'); return; }
        if (id === 'relief') { openTablet('relief'); return; }
        if (id === 'close') { closeTablet(); return; }
        return;
      }

      /*
       * Les réglages d'écran, appliqués au clic.
       *
       * Les quatre pas n'existent comme régions que s'ils mènent quelque part
       * (`screen-settings.ts`), donc aucune borne n'est vérifiée ici : un
       * `stepDistance` au bout rendrait la même forme, mais il ne peut pas
       * être atteint. La forme dessinée est la même que celle appliquée à la
       * géométrie, ce qui est tout l'intérêt de la faire passer par
       * `applyScreenShape`.
       */
      if (tabletScreen === 'screen') {
        if (id === 'nearer') { applyScreenShape(stepDistance(screenShape, -1)); return; }
        if (id === 'farther') { applyScreenShape(stepDistance(screenShape, 1)); return; }
        if (id === 'smaller') { applyScreenShape(stepAngle(screenShape, -1)); return; }
        if (id === 'bigger') { applyScreenShape(stepAngle(screenShape, 1)); return; }
        if (id === 'lower') { applyScreenShape(stepHeight(screenShape, -1)); return; }
        if (id === 'higher') { applyScreenShape(stepHeight(screenShape, 1)); return; }
        if (id === 'flat') { applyScreenShape({ ...screenShape, curved: false }); return; }
        if (id === 'curved') { applyScreenShape({ ...screenShape, curved: true }); return; }
        // Remonte au menu, pas au jeu : voir `TabletScreen`.
        if (id === 'close') { openTablet('options'); return; }
        return;
      }

      /*
       * Le relief, appliqué au clic lui aussi.
       *
       * Aucune borne vérifiée ici, pour la raison du bloc au-dessus : un pas
       * de bout d'échelle n'existe pas comme région (`panels/relief.ts`), donc
       * il ne peut pas être atteint. La clé du créneau voyage dans
       * l'identifiant parce qu'il y a une paire de boutons par couche
       * présente, et `stepSlot` ignore de lui-même un nom que cette version ne
       * connaît pas.
       */
      if (tabletScreen === 'relief') {
        if (id === 'spacing-less') { applyRelief(stepSpacing(relief, -1)); return; }
        if (id === 'spacing-more') { applyRelief(stepSpacing(relief, 1)); return; }
        if (id.startsWith('slot-in:')) {
          applyRelief(stepSlot(relief, id.slice('slot-in:'.length) as VrSlotKey, -1));
          return;
        }
        if (id.startsWith('slot-out:')) {
          applyRelief(stepSlot(relief, id.slice('slot-out:'.length) as VrSlotKey, 1));
          return;
        }
        if (id === 'close') { openTablet('options'); return; }
        return;
      }

      if (tabletScreen === 'saves') {
        if (id === 'close') { closeTablet(); return; }

        if (id === 'new-save') {
          void writeSave();
          return;
        }

        /*
         * Écraser, sans confirmation mais en gardant le NOM stocké.
         *
         * Le serveur réécrit le nom en même temps que l'état
         * (`game-handlers.ts` : `updateSaveData(db, saveId, data.name, ...)`),
         * donc lui passer un nom neuf renommerait « Avant le boss » en
         * horodatage - et surtout, la sauvegarde rapide cesserait d'être la
         * sauvegarde rapide, sa sentinelle `__quick__` étant précisément son
         * nom stocké. Le nom vient donc de `savesList`, jamais du libellé
         * affiché, qui est déjà une traduction de cette sentinelle.
         *
         * Pas de confirmation : c'est un geste délibéré et répétitif, celui du
         * joueur qui refait son point d'avant-boss. Supprimer, lui, demande.
         */
        if (id.startsWith('overwrite:')) {
          const saveId = id.slice('overwrite:'.length);
          const target = savesList.find((candidate) => candidate.id === saveId);
          if (!target) return;
          void writeSave({ id: target.id, name: target.name });
          return;
        }

        if (id.startsWith('confirm-delete:')) {
          void removeSave(id.slice('confirm-delete:'.length));
          return;
        }

        if (id === 'cancel-delete') {
          savesConfirming = null;
          repaintSaves();
          return;
        }

        // La question, pas la suppression. Voir `SavesState.confirming`.
        if (id.startsWith('delete:')) {
          savesConfirming = id.slice('delete:'.length);
          repaintSaves();
          return;
        }

        if (id.startsWith('load:')) {
          const ctx = saveable();
          if (!ctx) return;
          /*
           * Par `awaitSave`, et c'est tout le correctif.
           *
           * C'est le chemin de ce composant : écouteur cadré sur
           * `game:loaded`, timeout de cinq secondes, et un `apply` qui
           * distingue les deux mondes - en solo il n'y a qu'un coeur et il
           * l'adopte ; en lockstep seul l'hôte agit sur la réponse, l'invité
           * recevant le changement comme une resync ordinaire. `quickLoad`
           * émettait `game:load` sans rien de tout ça.
           */
          savesBusy = true;
          repaintSaves();
          const host = groupIsHost;
          const group = engine !== null && groupRoomId !== null;
          awaitSave(ctx.roomId, id.slice('load:'.length), (bytes, name) => {
            savesBusy = false;
            if (!group) {
              ctx.core.loadState(bytes);
            } else if (host) {
              (engine as LockstepEngine | null)?.adoptState(bytes, `save "${name ?? ''}"`);
            }
            closeTablet();
          });
          return;
        }
        return;
      }
      if (id === 'lang:en' || id === 'lang:fr') {
        language.set(id === 'lang:en' ? 'en' : 'fr');
        // Every panel carries text.
        repaintLibrary();
        repaintFriends();
        repaintProfile();
        repaintControls();
        return;
      }
      if (id.startsWith('bind:')) {
        listeningFor = id.slice('bind:'.length) as VrButton;
        /*
         * Offer the gate what is held RIGHT NOW, and throw the answer away.
         *
         * The trigger that just clicked this row is still down. Without this
         * priming call the gate's next tick would see it as a fresh press and
         * bind the trigger to the row the player only meant to select.
         */
        captureGate.reset();
        captureGate.tick(activeXrInputs(scene?.inputSources() ?? []));
        repaintControls();
        return;
      }
      if (id === 'restore-defaults') {
        // `writePadMap` RETIRE la valeur stockée quand la carte égale le
        // défaut - donc restaurer, c'est littéralement oublier ce qui était
        // stocké.
        writePadMap(localStorage, DEFAULT_MAP);
        // Read back rather than assumed: `readPadMap` is the only thing that
        // decides, and a preset written and not stored - the default is
        // removed, not stored - must still read back correctly.
        padMap = readPadMap(localStorage);
        // Only this panel: the band stopped showing the map when it became a
        // launcher, so there is nothing of the map left there to refresh.
        repaintControls();
        return;
      }
      if (id === 'bind-all') {
        /*
         * The whole drawing, in the order it is read.
         *
         * The gate is primed the same way a single row's is, and for the same
         * reason: the trigger that just pressed this button is still down, so
         * without a throwaway tick the next one would bind the trigger to the
         * first button of the sequence.
         */
        bindSequence = 0;
        listeningFor = BIND_SEQUENCE[0];
        captureGate.reset();
        captureGate.tick(activeXrInputs(scene?.inputSources() ?? []));
        repaintControls();
        return;
      }
      // Remonte au menu d'options, pas au jeu : c'est le retour que ce
      // panneau a toujours dû avoir, et il n'avait rien où remonter avant
      // qu'`options.ts` existe.
      if (id === 'close') { openTablet('options'); return; }
      return;
    }

    if (target.panel === 'screen') {
      const id = target.region.id;

      if (id.startsWith('save:')) {
        const saveId = id === 'save:none' ? null : id.slice('save:'.length);
        const room = $myRoom;
        if (room && room.players.length >= 2) {
          // Staged on the room so the friend sees what they are joining. The
          // server refuses this from anyone but the room's creator, which is
          // why the layout gave these rows no regions in that case - so
          // reaching here at all means it will be accepted.
          $socket?.emit('room:choose-save', { roomId: room.id, saveId });
        } else {
          stagedSaveId = saveId;
        }
        repaintLaunch();
        return;
      }

      /*
       * La réponse à « garder ce jeu ? », prise avant le transfert.
       *
       * Avant, parce que c'est le seul moment où elle ne coûte rien : le
       * transfert n'a pas commencé, personne n'attend, et l'invité choisit en
       * même temps qu'il lance. La poser après aurait retardé la partie des
       * DEUX joueurs pour une question qui ne concerne qu'un appareil.
       */
      if (id === 'keep:yes' || id === 'keep:no') {
        keepReceivedRom = id === 'keep:yes';
        // Et tout de suite si les octets sont déjà là. Voir `keepNow`.
        if (keepReceivedRom) void keepNow();
        repaintLaunch();
        return;
      }

      if (id === 'port:1' || id === 'port:2') {
        const room = $myRoom;
        if (!room) return;
        // One emit: `room:selectPort` sets `isReady` as well, so choosing a
        // controller is also declaring yourself ready.
        $socket?.emit('room:selectPort', { roomId: room.id, port: id === 'port:1' ? 1 : 2 });
        return;
      }

      if (id === 'launch' && launchFor) {
        const room = $myRoom;
        if (room && room.players.length >= 2) {
          // Any member may start: `game:start` asks only for membership, a
          // chosen game and one seated player. The engine is built when
          // `game:started` comes back - not here, because the friend may
          // start it too.
          $socket?.emit('game:start', { roomId: room.id });
          return;
        }
        const game = entryFor(launchFor);
        if (game) void launch(game);
        return;
      }
      return;
    }
  }

  /** Guards `launch()` against overlapping itself - the same shape of problem
   *  `leaving` guards `leave()` against. A second trigger press landing while
   *  the first launch is still mid-flight (neither has reached `engine` yet)
   *  would otherwise slip past the `if (engine)` check below and construct
   *  two engines, both handed the same `scene.schedule`. */
  let launching = false;

  /** The library entry for a dump, by CRC32 - never by game id, for the reason
   * `launch-options.ts` gives at length. */
  function entryFor(crc32: string): (typeof $games)[number] | null {
    return $games.find((game) => game.crc32 === crc32) ?? null;
  }

  async function launch(game: (typeof $games)[number]): Promise<void> {
    if (!scene || launching) return;
    if (!game.crc32) return;

    launching = true;
    try {
      /*
       * `resolveQuietly`, never the picker.
       *
       * `resolvable` was read when the session opened, but a folder handle can
       * lose its permission between then and now. On the flat screen
       * `obtainRom()` answers that by opening `LocateRom`; in here there is no
       * modal to open, so the failure has to be a line on the panel. The game
       * stays in the grid: it exists, it just could not be read this time.
       *
       * `requestPermission: false` is not optional here: the trigger press that
       * got us into `launch()` is a real gesture, so without this the browser's
       * native permission dialog would fire and eject the player from the
       * headset to show it - the exact interruption this panel exists to avoid.
       */
      /*
       * The reason is carried onto the panel, not just logged.
       *
       * `resolveQuietly` answers null for five different situations and used to
       * look identical for all five, which cost a whole headset session: the
       * notice said the file could not be read and nobody could tell whether
       * the permission, the folder, or the file itself was the problem. There
       * is no console in here and the shipped logs are not readable from the
       * headset either, so the panel is the only channel that reaches the
       * person who can see the failure.
       */
      let miss: MissReason | null = null;
      const rom = await resolveQuietly(game.crc32, {
        requestPermission: false,
        onMiss: (reason) => { miss = reason; }
      });
      if (!rom) {
        launchNotice = `${t($language, 'vrRomUnreadable')} [${miss ?? 'unknown'}]`;
        logger.error('vr rom miss', { crc32: game.crc32, reason: miss });
        repaintLibrary();
        return;
      }

      const roomId = await createRoom({ gameId: game.id, gameTitle: game.title, autoStart: true });
      if (!roomId) {
        launchNotice = t($language, 'vrLaunchFailed');
        repaintLibrary();
        return;
      }
      setLogLabels({ roomId, player: 'vr' });
      ownedRoomId = roomId;

      /*
       * A second launch while one is already live - reachable straight from
       * the checklist's own flow: stick-click recalls the panels while the
       * game keeps running, then the player aims at a different tile. Stopped
       * here, and awaited, rather than left running underneath the new one:
       * two governors would otherwise fight over the one pending slot
       * `frame-pump.ts`'s `schedule` holds (both would get the same
       * `scene.schedule`), and the first engine's SRAM interval and
       * AudioContext would leak past it.
       *
       * Placed after the ROM and room are already secured, not before: a
       * launch that is about to fail on either must leave the game already
       * running untouched.
       */
      if (engine) {
        await engine.stop();
        engine = null;
        void audio?.stop();
        audio = null;
      }

      try {
        // Local, not component state: unlike `engine` and `audio`, nothing
        // outside this function ever reads `core` again once
        // `createSoloEngine` has it - the engine keeps its own reference via
        // closure (`solo-engine.ts`), and this component's own copy was
        // write-only.
        const core: PsnesCore = await loadCore();
        audio = new AudioSink();

        /*
         * Re-checked, not trusted from the entry guard at the top of this
         * function: `resolveQuietly` and `createRoom` above are real awaits -
         * `createRoom` up to a 5 s timeout - and a `sessionend` landing during
         * either drives `teardown()`, which nulls `scene` (and everything
         * else) out from under this continuation. Without this, `scene.schedule`
         * below would throw on a null `scene`; `activate()` calls `launch()`
         * with `void`, so that throw would be an unhandled rejection.
         */
        if (!scene) {
          void audio.stop();
          audio = null;
          return;
        }

        // Gathered here because here is where all three exist at once. See
        // `saveContext`'s own note for why `core` stopped being write-only.
        saveContext = { roomId, gameId: game.id, core };

        engine = await createSoloEngine({
          core,
          rom,
          sram: {
            load: () => readRoomSram(roomId),
            save: (bytes) => $socket?.emit('game:saveSram', { roomId, sramData: toBase64(bytes) })
          },
          audio,
          // Les Touch et la manette Bluetooth, fusionnées par `localPad`, qui
          // porte aussi la règle du zéro pendant que les panneaux sont levés.
          readPads: () => ({ pad1: localPad(), pad2: 0 }),
          // Both views, in one call: the layer plane is what cuts the frame
          // into the stack of planes the headset shows. Taking the picture
          // first is safe because the getters `depthSurface()` calls cannot
          // grow the heap, which is the only thing that detaches a view.
          onFrame: (c) => scene?.screen.upload(c.videoSurface(), c.depthSurface()),
          onError: (err) => logger.error('vr engine', err),
          /*
           * The whole reason `GovernorOptions.schedule` exists, and the one line
           * that makes the chain behind it real.
           *
           * Without this the governor falls back to `window.requestAnimationFrame`,
           * which is NOT the display's clock once a headset is presenting - the
           * WebXR spec lets a user agent throttle it freely. The game would still
           * run, which is exactly what makes the omission dangerous: nothing looks
           * broken, and `frame-pump.ts`, the governor's new option and the XR
           * animation loop would all be dead weight.
           */
          schedule: scene.schedule
        });

        /*
         * `createSoloEngine`'s own awaits - the SRAM round trip, up to 5 s,
         * and `audioWorklet.addModule` - are exactly the kind that outlive a
         * closed session. A `sessionend` landing during either already drove
         * `teardown()` above, which nulled `scene`, `engine` and `audio` - and
         * without this check the assignment just above would put a live
         * engine straight back into `engine` right after `teardown()` cleared
         * it, leaking its governor and 30 s SRAM interval forever.
         *
         * Mirrors `SoloRoom.svelte`'s `destroyed` check. This component has no
         * separate flag: `scene` being null after `teardown()` is already the
         * signal, the same one the check above this call reads.
         */
        if (!scene) {
          void engine.stop();
          engine = null;
          giveUpRoom();
          /*
           * Optional, and that is the whole point of this block.
           *
           * The `sessionend` that nulled `scene` also ran `teardown()`, which
           * does `void audio?.stop(); audio = null;` on this same
           * component-scope variable. So by the time we get here `audio` is
           * usually already null, and a bare `audio.stop()` would throw -
           * replacing the accidental crash this guard exists to remove with a
           * second one, in the guard itself. It would be caught by the outer
           * try and logged as "vr engine failed to start", which is a lie:
           * the engine started fine and was then torn down on purpose.
           */
          void audio?.stop();
          audio = null;
          return;
        }

        if (stagedSaveId) {
          const wanted = stagedSaveId;
          // Once. A reconnect must not rewind the game - the same rule the
          // flat path states about `resumeSaveId`.
          stagedSaveId = null;
          awaitSave(roomId, wanted, (bytes) => core.loadState(bytes));
        }

        /*
         * The one resume attempt this session gets, and why it lives here
         * rather than at the click that led to `launch()`: `audio` does not
         * exist yet on a first launch at that point, and holds the PREVIOUS
         * session's closing context on a relaunch. Here it is the context
         * this launch just started via `audio.start()` (inside
         * `createSoloEngine` above), and the XR select that led to this call
         * is as close to a user gesture as this session will ever get.
         *
         * This is very likely a no-op: the document already has sticky
         * activation from the DOM click that entered VR in the first place,
         * so the context should already be `running`. If it is not - some
         * browser did not count the XR select - there is deliberately no
         * in-world prompt for it: a `needsAudioGesture` flag used to zero
         * `pad1` while this was pending and re-fire `resume()` every frame
         * with nothing drawn anywhere to explain why the controller had gone
         * dead - unreachable in practice, and worth deleting rather than
         * building a screen for. The game plays muted instead, and this is
         * the one place that says so, once.
         */
        await audio.resume();
        if (audio.needsGesture) {
          logger.warn('audio context still suspended after resume; game will run muted');
        }

        // The screen becomes a picture again, so it must stop being a
        // pointer target - `scene.aimedAt` holds this same `regions` array.
        launchFor = null;
        scene.screen.regions.length = 0;
        // The new engine's first frame needs the screen back; `upload` will
        // not take it by itself any more.
        scene.screen.showPicture();
        // Avant la première image plutôt qu'après : les plans sont posés à la
        // distance du réglage dès qu'ils portent quelque chose, donc le joueur
        // ne voit jamais l'image plate se déplier.
        loadReliefFor(game.crc32);
        showDecor(false);
        scene?.panelsVisible(false);
        /*
         * Le drapeau, pas le gouverneur : un gouverneur neuf est déjà à 1 et
         * un puits neuf n'est pas muet. Ce qu'il faut remettre, c'est la
         * MÉMOIRE de la transition - un accéléré encore tenu au moment où la
         * partie précédente s'est arrêtée rendrait le prochain
         * `setFastForward(false)` sans effet, et le geste resterait mort
         * jusqu'à un aller-retour complet du clic.
         */
        fastForward = false;
        engine.governor.start();
        // So `resume` is there next time the panels come back, even though
        // they are hidden right now and the paint itself is invisible.
        repaintProfile();
      } catch (err) {
        // `loadCore()` and `createSoloEngine()` were unguarded here: a
        // rejection from either used to be an unhandled promise rejection
        // with no console in the headset, no `launchNotice`, and no cleanup -
        // the panel just sat there, unrepainted and unexplained.
        // `SoloRoom.svelte`'s flat boot catches the same failure class; this
        // is its VR shape.
        logger.error('vr engine failed to start', err);
        launchNotice = t($language, 'vrLaunchFailed');
        repaintLibrary();
        void engine?.stop();
        engine = null;
        void audio?.stop();
        audio = null;
        giveUpRoom();
      }
    } finally {
      launching = false;
    }
  }

  /**
   * La table de la manette, depuis le compte du joueur.
   *
   * La même requête que la page plate (`/api/user/controls`), et le même
   * normaliseur : c'est ce qui garantit qu'une manette configurée sur grand
   * écran se comporte pareil dans le casque. Un échec laisse `STANDARD_PAD`,
   * qui est jouable - dire « impossible de charger tes contrôles » dans un
   * casque n'apporterait rien à quelqu'un qui ne peut rien y faire.
   */
  async function loadBluetoothConfig(): Promise<void> {
    try {
      const res = await fetch('/api/user/controls', { credentials: 'include' });
      if (!res.ok) return;
      bluetoothConfig = normaliseControlsConfig(await res.json()).p1.pad;
      repaintControls();
    } catch (err) {
      logger.warn('vr could not load the pad bindings; keeping the standard mapping', err);
    }
  }

  /**
   * Le masque SNES de CE casque : les Touch et la manette Bluetooth ensemble.
   *
   * Un seul endroit pour les deux chemins - le solo et le lockstep - qui
   * lisaient la même expression en double. Et la fusion est sûre par
   * construction : la spec du module Gamepads de WebXR interdit qu'une manette
   * ordinaire soit exposée comme source XR, donc `session.inputSources` et
   * `navigator.getGamepads()` ne peuvent pas décrire le même bouton. Voir
   * `bt-pad.ts`.
   *
   * Zéro pendant que les panneaux sont levés : la gâchette est alors le
   * pointeur, et laisser les deux la lire ferait d'une pressée de menu un R
   * dans Super Mario World. La manette Bluetooth suit la même règle, sans
   * quoi une pression dessus jouerait pendant qu'on navigue dans un menu.
   */
  function localPad(): PadMask {
    if (!scene || scene.arePanelsVisible()) return 0;
    const visibility = sessionVisibility();
    return (
      readVrPad(scene.inputSources(), padMap, visibility) |
      readBluetoothPad(gamepadsHere(), bluetoothConfig, visibility)
    );
  }

  /** Ce que le navigateur annonce, ou rien là où il n'y en a pas. */
  function gamepadsHere(): Iterable<Gamepad | null> {
    if (typeof navigator === 'undefined' || !navigator.getGamepads) return [];
    return navigator.getGamepads();
  }

  /** The session's own visibility, which is what `readVrPad` gates on. */
  function sessionVisibility(): string {
    return session?.session.visibilityState ?? 'hidden';
  }

  /**
   * The staged save, asked for once and waited on for a bounded time.
   *
   * A one-shot listener that removes itself inside its own handler leaks
   * whenever the handler never runs - a save id the server no longer has, a
   * room already gone, a dropped packet - and this socket outlives the VR
   * session, so the leak outlives it too. Two relaunches would then leave two
   * closures, and a late reply would apply a save to a core whose engine has
   * already been stopped. `readRoomSram` bounds its own one-shot for exactly
   * this reason; this one now does the same, and `teardown` takes it off on
   * the way out.
   *
   * `apply` is a parameter rather than a hardcoded `core.loadState` because
   * solo and a group game disagree on what "loading a save" means once a
   * session exists: solo owns the only core there is, but in lockstep only
   * the host may act on the reply - the guest's copy is meant to arrive as an
   * ordinary resync over the netplay protocol instead (`resume-save.ts`
   * states the rule; `onSessionEvent`'s `'state'` case is where the group
   * caller lives).
   */
  function awaitSave(
    roomId: string,
    saveId: string,
    apply: (bytes: Uint8Array, name?: string) => void
  ): void {
    const sock = $socket;
    if (!sock) return;

    dropSaveListener();
    saveTimer = setTimeout(() => {
      dropSaveListener();
      logger.warn('vr save load never answered', { roomId, saveId });
    }, 5000);

    saveListener = (payload: { saveData?: string; name?: string }) => {
      dropSaveListener();
      if (!payload?.saveData) return;
      try {
        apply(fromBase64(payload.saveData), payload.name);
      } catch (err) {
        logger.error('vr could not decode the save', err);
        launchNotice = t($language, 'vrLaunchFailed');
        repaintLibrary();
      }
    };
    sock.on('game:loaded', saveListener);
    sock.emit('game:load', { roomId, saveId });
  }

  /**
   * Écrit une nouvelle sauvegarde du jeu en cours.
   *
   * `game:save` sans `saveId`, donc une création et jamais un écrasement -
   * c'est la différence avec le F2/F4 de la page plate, qui réutilise l'id de
   * sa sentinelle pour garder un emplacement unique.
   *
   * Le nom vient d'`autoSaveName`, celui-là même que `saveIdentity` reconnaît
   * comme auto-nommé pour n'afficher qu'une ligne. Inventer un autre nom ici
   * aurait donné deux lignes pour une sauvegarde qui n'a rien de plus à dire.
   */
  /**
   * Écrit l'état courant : une sauvegarde neuve, ou par-dessus une existante.
   *
   * Un seul chemin pour les deux, parce que le serveur n'en a qu'un
   * (`game:save`, avec ou sans `saveId`) et que tout le reste - la capture de
   * l'état, la vignette, l'attente de `game:saved`, le rafraîchissement des
   * deux listes - est identique. Deux fonctions auraient divergé sur le
   * rafraîchissement, qui est la partie qu'on oublie : c'est déjà ce qui avait
   * rendu une sauvegarde invisible de sa propre bibliothèque.
   */
  async function writeSave(target?: { id: string; name: string }): Promise<void> {
    const ctx = saveable();
    const sock = $socket;
    if (!ctx || !sock) return;

    savesBusy = true;
    // La question tombe avec l'écriture : elle portait sur un état du panneau
    // que cette écriture vient de remplacer.
    savesConfirming = null;
    repaintSaves();

    const saveData = await captureState({
      saveState: async () => ctx.core.saveState(),
      getCanvas: frameCanvas
    });
    const screenshot = captureThumbnailHere();

    const done = () => {
      sock.off('error', failed);
      savesBusy = false;
      // La liste, pas une insertion à la main : le serveur décide de l'id et
      // de la date, et deviner l'un des deux les ferait diverger.
      void refreshSaves();
      /*
       * Et le store des jeux, sans quoi la sauvegarde n'existe qu'ici.
       *
       * `$games` est rempli une seule fois, par la page d'accueil, et jamais
       * pendant une session VR. Or l'écran de lancement construit sa liste de
       * sauvegardes depuis ce store : une sauvegarde écrite en VR était donc
       * absente de l'endroit où le joueur va naturellement la chercher, tout
       * en existant en base. C'est ce qui a été rapporté comme « je ne la vois
       * plus nulle part ».
       */
      void loadGames();
    };
    const failed = () => {
      sock.off('game:saved', done);
      savesBusy = false;
      notifications.show(t($language, 'failedToSave'), 'error');
      repaintSaves();
    };
    sock.once('game:saved', done);
    sock.once('error', failed);

    sock.emit('game:save', {
      roomId: ctx.roomId,
      // `saveId` absent pour une neuve : le serveur attribue alors l'id et le
      // numéro d'emplacement, et deviner l'un des deux les ferait diverger.
      saveId: target?.id,
      name: target?.name ?? autoSaveName($language),
      saveData,
      screenshot
    });
  }

  /**
   * Supprime une sauvegarde, une fois la question répondue.
   *
   * Par l'API REST et non par le socket : `deleteSave` existe déjà et c'est la
   * page plate qui l'utilise, avec sa propre distinction entre « ta session a
   * expiré » et « ce jeu n'est pas le tien » - deux problèmes aux remèdes
   * différents, et dire à quelqu'un de se reconnecter alors que sa session va
   * bien l'envoie en boucle.
   */
  async function removeSave(saveId: string): Promise<void> {
    const ctx = saveable();
    if (!ctx) return;

    savesBusy = true;
    savesConfirming = null;
    repaintSaves();

    const result = await deleteSave(ctx.gameId, saveId);
    savesBusy = false;

    if (!result.ok) {
      notifications.show(t($language, result.reason), 'error');
      // Repeindre quand même : `busy` a laissé le panneau sans régions, et
      // rendre la main sans repeindre le figerait. La même raison que
      // `refreshSaves`.
      repaintSaves();
      return;
    }

    void refreshSaves();
    /*
     * Et le store des jeux, sinon la sauvegarde supprimée reste sur l'écran de
     * lancement.
     *
     * Le symétrique exact du défaut « je ne la vois plus nulle part » : ce
     * store est rempli une fois par la page d'accueil, l'écran de lancement
     * construit ses listes depuis lui, et une suppression qui ne le touche pas
     * laisse une ligne qui ne charge plus rien.
     */
    void loadGames();
  }

  /** La dernière image du jeu en PNG, ou undefined. Voir `frameCanvas`. */
  function captureThumbnailHere(): string | undefined {
    const canvas = frameCanvas();
    if (!canvas) return undefined;
    try {
      return canvas.toDataURL('image/png');
    } catch (err) {
      // Une vignette manquante laisse la ligne avec son nom et sa date, qui
      // sont ce qui l'identifie - l'image ne faisait que confirmer.
      logger.warn('vr could not capture a save thumbnail', err);
      return undefined;
    }
  }

  /** Taken off in `teardown`: the socket outlives the session. */
  let rejoinRoom: (() => void) | null = null;

  /** Held at component scope so `teardown` can take it off the shared socket. */
  let saveListener: ((payload: { saveData?: string; name?: string }) => void) | null = null;
  /**
   * Held beside it, and cleared by the same function.
   *
   * A local `const` was unreachable from `teardown`, and a superseded
   * `awaitSave` left the old one armed - five seconds later it dropped the
   * NEW listener while logging the old save's id.
   */
  let saveTimer: ReturnType<typeof setTimeout> | null = null;

  function dropSaveListener(): void {
    if (saveTimer !== null) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    if (!saveListener) return;
    $socket?.off('game:loaded', saveListener);
    saveListener = null;
  }

  function readRoomSram(roomId: string): Promise<Uint8Array | null> {
    return new Promise((resolve) => {
      const sock = $socket;
      if (!sock) return resolve(null);
      const timer = setTimeout(() => { sock.off('game:sramLoaded', done); resolve(null); }, 5000);
      function done(data: { sramData: string | null }) {
        sock!.off('game:sramLoaded', done);
        clearTimeout(timer);
        try {
          resolve(data.sramData ? decodeSram(data.sramData) : null);
        } catch {
          // A save that will not decode is not a save. Starting fresh beats
          // refusing to start.
          resolve(null);
        }
      }
      sock.on('game:sramLoaded', done);
      sock.emit('game:loadSram', { roomId });
    });
  }

  /**
   * Garde maintenant ce que cet appareil a déjà en main.
   *
   * Sans ça « Oui » serait un bouton mort la moitié du temps, et c'est un
   * enchaînement réel qui le montre : c'est l'HÔTE qui presse Lancer, donc
   * l'invité n'a que les quelques secondes entre le choix du jeu et ce
   * lancement pour répondre. S'il rate la fenêtre, la partie se joue quand
   * même - le défaut est « ne pas garder » - et la question lui revient sur
   * l'écran de lancement d'après-partie, parce que des octets en cache ne sont
   * pas pour autant sur l'appareil (`resolvableHere` ne voit que le dossier et
   * le magasin). Là, une intention notée pour un transfert qui n'aura plus
   * lieu n'aurait rien gardé.
   *
   * `resolveQuietly` plutôt que `loadedRom` : celui-ci porte les octets du jeu
   * en cours, qui n'est pas forcément celui de l'écran. Et `resolveQuietly`
   * regarde le cache en premier, qui est exactement là où un jeu reçu vit.
   *
   * Rien en main veut dire que le transfert n'a pas eu lieu : la réponse est
   * alors honorée à la réception, par `receiveFromPeer`.
   */
  /**
   * Garder pour de bon : les octets, puis la ligne de bibliothèque.
   *
   * Les deux chemins du casque passent par ici. L'invité peut répondre oui
   * AVANT le transfert, sur l'écran de lancement, ou après coup depuis le même
   * écran ; sans ce partage, l'un des deux gardait les octets sans donner de
   * carte à cliquer - exactement le défaut signalé le 2026-09-10 hors casque.
   *
   * L'échec de l'inscription est avalé et journalisé, comme l'écriture
   * elle-même : la question est déjà refermée, donc rien à l'écran ne pourrait
   * le rapporter, et une promesse rejetée ici remonterait en unhandled
   * rejection dans une session immersive.
   */
  async function keepAndRegister(bytes: Uint8Array, crc32: string): Promise<void> {
    const title = $myRoom?.gameTitle ?? '';
    await keepReceived(bytes, {
      title,
      onFolder: (outcome) => logger.info('the ROM folder', { outcome })
    });
    try {
      await registerGame(crc32, romFileName(title, crc32));
    } catch (err) {
      logger.warn('kept the ROM but could not add it to the library', err);
    }
  }

  async function keepNow(): Promise<void> {
    const crc32 = launchFor;
    if (!crc32) return;

    const bytes = await resolveQuietly(crc32, { requestPermission: false });
    if (!bytes) return;

    await keepAndRegister(bytes, crc32);
    // Relu, sinon l'écran continuerait d'annoncer un envoi pour un jeu qui est
    // désormais sur l'appareil - et la question resterait posée.
    resolvable = await resolvableHere();
    repaintLaunch();
  }

  /**
   * Le jeu, reçu de l'autre joueur, quand cet appareil ne l'a pas.
   *
   * C'est la moitié qui manquait à la VR. Le serveur relaie `rom:request` et
   * `rom:chunk` depuis toujours et `LockstepRoom.svelte` s'en sert : qui n'a
   * pas la cartouche la reçoit, vérifiée contre le CRC32 de la room. Le shell
   * VR, lui, abandonnait - et disait au joueur de sortir du casque, ce que deux
   * joueurs ont dû faire pour de vrai le 2026-09-08.
   *
   * L'hôte recevait encore moins que les autres : le relais ne routait une
   * demande que vers SON socket, donc un hôte sans cartouche n'avait personne
   * à qui demander. La prod l'a montré le 2026-09-09, l'hôte réclamant trois
   * fois en deux minutes pendant que l'invité tenait le dump. Le relais route
   * maintenant vers celui qui ne demande pas, et `launch-options.ts` tient la
   * même règle pour décider si l'écran de lancement bloque.
   *
   * Rend null plutôt que de lever : l'appelant a déjà un chemin pour « pas de
   * ROM », et c'est le bon - le message qu'il pose est le dernier recours.
   */
  async function receiveFromPeer(roomId: string, crc32: string): Promise<Uint8Array | null> {
    const sock = $socket;
    if (!sock) return null;

    try {
      const rom = await receiveRom({
        socket: sock as never,
        roomId,
        expectedCrc32: crc32,
        onProgress: (done, total) => showTransfer('vrReceivingRom', done, total)
      });
      romTransfer = null;

      /*
       * Gardé seulement si l'invité l'a demandé.
       *
       * `remember` met en cache et rien de plus : la partie tourne, et les
       * octets meurent avec l'onglet. `keepReceived` les écrit sur l'appareil,
       * et c'est le geste de l'invité sur son écran de lancement qui décide -
       * disclaimer légal à côté du bouton. `kept-files.ts` porte la règle.
       */
      if (keepReceivedRom) await keepAndRegister(rom, crc32);
      else remember(rom);

      logger.info(`Received the ROM from the host (${rom.byteLength} bytes)`, { crc32 });
      return rom;
    } catch (err) {
      romTransfer = null;
      repaintLaunch();
      logger.warn('the host could not send the ROM', err);
      return null;
    }
  }

  /**
   * Sert le jeu à l'invité qui le demande.
   *
   * Enregistré pour toute la session et pas seulement pendant une partie : la
   * demande arrive quand l'invité démarre, ce qui peut précéder le moment où
   * cet hôte a lui-même lancé - `loadedRom` est alors encore vide, et le
   * `resolveQuietly` silencieux prend le relais depuis le cache ou le store
   * des fichiers gardés.
   */
  async function onRomRequested(data: { roomId: string; from: string; crc32?: string }): Promise<void> {
    const sock = $socket;
    const room = $myRoom;
    if (!sock || !data || !room || data.roomId !== room.id) return;
    // Plus de filtre sur l'hôte : c'est l'autre joueur qui demande, quel que
    // soit son rôle, et ce casque répond s'il tient la cartouche.
    if (serving.has(data.from)) return;

    // Le dump demandé, pas celui du salon. Voir LockstepRoom.
    const crc32 = data.crc32 ?? room.gameCrc32;
    const rom = (crc32 === room.gameCrc32 ? loadedRom : null)
      ?? (crc32 ? await resolveQuietly(crc32, { requestPermission: false }) : null);
    if (!rom) {
      // Dit plutôt que tu : sans ça l'autre attend le timeout de `receiveRom`
      // devant un écran qui ne dit rien.
      logger.warn('a player asked for the ROM but this headset has no copy either');
      sock.emit('rom:unavailable', {
        roomId: room.id,
        to: data.from,
        reason: 'The other player does not have this ROM either'
      });
      return;
    }

    serving.add(data.from);
    try {
      await sendRom({
        socket: sock as never,
        roomId: room.id,
        to: data.from,
        rom,
        onProgress: (done, total) => showTransfer('vrSendingRom', done, total),
        // Une frame fait 14 ms à 72 Hz. Rendre la main à la file de macrotâches
        // entre deux morceaux garde la tranche d'émulation devant le transfert,
        // ce que `LockstepRoom.svelte` fait pour la même raison.
        pause: () => new Promise<void>((resolve) => setTimeout(resolve, 0))
      });
    } finally {
      serving.delete(data.from);
      romTransfer = null;
      repaintLaunch();
    }
  }

  /**
   * Met la progression en mots, et ne repeint que quand elle change.
   *
   * Le rappel tombe à chaque morceau, et un repeint est une rastérisation de
   * 1024 x 768 suivie d'un envoi de texture : les faire tous coûterait plus que
   * le transfert. Le pourcentage entier est la granularité que l'œil peut lire
   * de toute façon.
   */
  function showTransfer(key: 'vrReceivingRom' | 'vrSendingRom', done: number, total: number): void {
    const percent = Math.min(100, Math.round((done / Math.max(1, total)) * 100));
    const line = t($language, key, { percent });
    if (line === romTransfer) return;
    romTransfer = line;
    repaintLaunch();
  }

  function onGameStarted(): void {
    const room = $myRoom;
    if (!room || room.players.length < 2 || !room.gameCrc32) return;
    // A game already running here is the relaunch case, which `launch` guards.
    if (engine) return;
    void launchTogether(room.id, room.gameCrc32, room.hostId === $user?.id);
  }

  async function launchTogether(roomId: string, crc32: string, isHost: boolean): Promise<void> {
    if (launching) return;
    launching = true;
    // Built before the engine exists to own it, so it is this function's own
    // job to close it on every path that abandons it before that handoff -
    // see the two `transport.close()`/`transport?.close()` calls below.
    let transport: Transport | null = null;
    try {
      /*
       * D6: lockstep, and lockstep only.
       *
       * A creator who set streaming or dual from the flat page would
       * otherwise hand a VR peer a `LockstepEngine` built against a
       * `P2PRoom` on the other end - a session with nothing to talk to,
       * failing in mutual silence rather than a stated refusal.
       *
       * `emulationMode` is not in `my-room.ts`'s `RoomView` - round A left it
       * out of the store's type - but `toPublicRoom` (backend) always sends
       * it, on every `room:update`, so it is on the wire and this reads it
       * with a local cast rather than widening a file outside this fix's
       * scope.
       */
      const mode = $myRoom?.emulationMode;
      if (mode && mode !== 'lockstep') {
        // Refused locally, not on the server: the room's game is left alone
        // rather than released, because a mode of streaming or dual is
        // exactly the shape a flat `P2PRoom` on the other end is built to
        // run, and releasing it here could kill a game that is working fine
        // for them.
        launchNotice = t($language, 'vrModeNotLockstep');
        scene?.panelsVisible(true);
        repaintLibrary();
        return;
      }

      // Lets one query pull both players' lines for the same match, exactly
      // as `LockstepRoom.svelte`'s own `boot()` does - the one label the solo
      // path (`launch()` above) has no use for, since it plays alone.
      setLogLabels({ roomId, player: isHost ? 'p1' : 'p2' });

      const rom = (await resolveQuietly(crc32, { requestPermission: false }))
        ?? (await receiveFromPeer(roomId, crc32));
      if (!rom) {
        // The refusal the launch screen already predicted. Saying it twice is
        // better than a black screen.
        launchNotice = t($language, 'vrRomMissing');
        scene?.panelsVisible(true);
        repaintLibrary();
        return;
      }
      // Gardés pour servir l'autre casque sans repasser par le dossier, dont
      // la permission demande une danse à part dans un casque. Voir `loadedRom`.
      loadedRom = rom;

      const core = await loadCore();
      audio = new AudioSink();

      // By path, not through the barrel: it reaches `simple-peer` and
      // `import.meta.env`, exactly as `LockstepRoom.svelte` notes.
      const { ZnetWebRtcTransport } = await import('$lib/znet/webrtc-transport');
      const relay = new SocketTransport($socket as never, roomId);
      transport = new UpgradingTransport(
        relay,
        new ZnetWebRtcTransport($socket as never, roomId, isHost)
      );

      if (!scene) {
        transport.close();
        void audio.stop();
        audio = null;
        return;
      }

      // Snapshotted for `onSessionEvent` and `awaitSave`'s reply, which run
      // outside this function's closure - see the header on the `let`s
      // themselves. `resumeSaveToRequest` is the same rule `LockstepRoom.svelte`
      // follows: null for a guest, who never asks and would discard its own
      // reply anyway (`resume-save.ts`).
      groupRoomId = roomId;
      groupIsHost = isHost;
      pendingResumeSaveId = resumeSaveToRequest($myRoom, $myRoom?.createdBy === $user?.id, null);

      /*
       * The group's game id comes from the room, which is the only place it
       * exists on this path: `launchTogether` is handed a crc32, not an id,
       * because the ROM is what it needs to boot. Left null if the room has
       * no game id, and the press then says so rather than doing nothing -
       * see the `save`/`load` branch.
       */
      const groupGameId = $myRoom?.gameId ?? null;
      saveContext = groupGameId ? { roomId, gameId: groupGameId, core } : null;

      engine = await createLockstepEngine({
        core,
        rom,
        isHost,
        transport,
        sram: {
          load: () => readRoomSram(roomId),
          save: (bytes) => $socket?.emit('game:saveSram', { roomId, sramData: toBase64(bytes) })
        },
        audio,
        joinRelay: () => joinRelay(roomId),
        // One mask - no `pad2: 0` here, because the other pad arrives over the
        // transport. `localPad` merges the Touch controllers with a Bluetooth
        // pad, exactly as the solo path does.
        readLocalInput: localPad,
        onEvent: onSessionEvent,
        // The layer plane alongside the picture, as the solo path takes it.
        onFrame: (c) => scene?.screen.upload(c.videoSurface(), c.depthSurface()),
        onError: (err) => logger.error('vr lockstep', err),
        schedule: scene.schedule
      });

      /*
       * The session may have died while the relay handshake was in flight.
       *
       * `createLockstepEngine` awaits the ROM, the audio device, the cartridge
       * save and the relay - and a headset put down at any of them runs
       * `onDestroy` -> `closeAnySession()`, which nulls `scene`, `engine` and
       * `audio`. The pending promise then resolves onto a corpse and, without
       * this, reassigns `engine`, starts a governor and arms a thirty-second
       * SRAM timer that nothing is left to stop. `scene` being null is the
       * signal, exactly as the solo path reads it above.
       */
      if (!scene) {
        void engine.stop();
        engine = null;
        groupRoomId = null;
        groupIsHost = false;
        pendingResumeSaveId = null;
        giveUpRoom();
        void audio?.stop();
        audio = null;
        return;
      }

      await audio.resume();
      launchFor = null;
      scene.screen.regions.length = 0;
      scene.screen.showPicture();
      // Le même réglage par jeu que le solo, et lu sur CE casque : le relief
      // qui se lit bien dépend de l'optique et de la distance choisie, donc il
      // ne suit pas le joueur chez son ami. Voir `relief-preset.ts`.
      loadReliefFor(crc32);
      showDecor(false);
      scene?.panelsVisible(false);
      // The engine does not start its own governor - `solo-engine.ts` does not
      // either, and `SoloRoom.svelte`'s own `boot()` and this file's `launch()`
      // above are where the flat and solo paths start theirs: starting it
      // inside the engine reaches `requestAnimationFrame`, which does not
      // exist under the node test runner.
      // Voir la même ligne dans `launch()`. Ici l'accéléré ne sera jamais
      // tenu - `groupRoomId` est posé - mais le drapeau doit quand même être
      // propre pour le solo qui suivra cette partie à deux.
      fastForward = false;
      engine.governor.start();
      repaintProfile();
    } catch (err) {
      logger.error('vr lockstep failed to start', err);
      launchNotice = t($language, 'vrLaunchFailed');
      scene?.panelsVisible(true);
      repaintLibrary();
      transport?.close();
      void engine?.stop();
      engine = null;
      groupRoomId = null;
      groupIsHost = false;
      pendingResumeSaveId = null;
      void audio?.stop();
      audio = null;
    } finally {
      launching = false;
    }
  }

  /** Emits `znet:join` and resolves on `znet:joined`, with the same ten-second
   * ceiling the flat path uses. */
  function joinRelay(roomId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = $socket;
      if (!sock) return reject(new Error('Not connected to the server'));
      const timer = setTimeout(() => {
        sock.off('znet:joined', onJoined);
        reject(new Error('The server did not confirm the netplay session'));
      }, 10000);
      const onJoined = () => {
        clearTimeout(timer);
        sock.off('znet:joined', onJoined);
        resolve();
      };
      sock.on('znet:joined', onJoined);
      sock.emit('znet:join', { roomId });
    });
  }

  /**
   * A mid-game notice, painted where it can actually be seen.
   *
   * There is no HUD over the running picture: `frame()` reads
   * `scene.arePanelsVisible()` to decide whether the trigger is a pointer or
   * the SNES R button, and both `readVrPad` call sites zero the pad while the
   * panels are up - so forcing them up for a transient `desync` or
   * `link-lost` would silently take the controller away mid-play, which is a
   * worse surprise than the notice it would carry. Painted onto the library
   * band instead, unseen until the player raises the panels on their own
   * (the menu button, or `vrResume`'s own screen) to check on the game - at
   * which point it is already there instead of needing another frame to
   * catch up.
   *
   * Localised through `NOTICE_FOR` below: it composed
   * `${event.type}: ${event.message}` at first, so a player read "link-lost"
   * off a two-and-a-half-metre screen. The event names belong in the log,
   * which `onSessionEvent` already writes.
   */
  function noteOnLibrary(event: SessionEvent): void {
    /*
     * A sentence, not an identifier.
     *
     * This composed `${event.type}: ${event.message}` - so a player read
     * "link-lost" off a two-metre screen. The event names are for the log,
     * which `onSessionEvent` already writes; what reaches the band has to say
     * what happened and whether to wait.
     */
    launchNotice = t($language, NOTICE_FOR[event.type] ?? 'vrLaunchFailed');
    repaintLibrary();
  }

  /** Only the three the player can act on; the rest never reach the band. */
  const NOTICE_FOR: Partial<Record<SessionEvent['type'], 'vrDesync' | 'vrLinkLost' | 'vrLinkRestored'>> = {
    desync: 'vrDesync',
    'link-lost': 'vrLinkLost',
    'link-restored': 'vrLinkRestored'
  };

  /**
   * Puts the curved screen back on something a player can act on, instead of
   * leaving a dead game's last frame up front and centre.
   *
   * Reopens the launch screen for the room's own game when the library still
   * has it - the same options screen `repaintLaunch` would have shown before
   * the game started - and falls back to the test pattern otherwise, exactly
   * as `repaintLaunch` itself does when a dump leaves the library mid-session.
   */
  function backToLaunchScreen(): void {
    // The remap panel used to be lowered here, because the screen carried one
    // thing at a time and whoever asked for the launch options took it. The
    // tablet is a surface of its own, so a rebinding survives a return to the
    // launch screen - and the player who opened both meant to have both.
    /*
     * Le relief perd son jeu ici, et c'est le seul endroit qui le peut.
     *
     * Les deux arrêts - `stopTogether` et `onGameStopped` - passent par cette
     * fonction. Sans cet oubli, un pas donné sur le panneau de relief pendant
     * qu'aucune partie ne tourne s'écrirait sous le CRC32 de la partie
     * PRÉCÉDENTE, et le joueur retrouverait au prochain lancement un réglage
     * qu'il croyait donner à autre chose.
     */
    reliefCrc32 = null;
    relief = DEFAULT_RELIEF;
    scene?.screen.setRelief(relief);

    const crc32 = $myRoom?.gameCrc32 ?? null;
    if (crc32 && entryFor(crc32)) {
      launchFor = crc32;
      repaintLaunch();
      return;
    }
    launchFor = null;
    if (scene) {
      scene.screen.regions.length = 0;
      scene.screen.showTestPattern();
      showDecor(true);
    }
  }

  /** The whole session event surface: covers every member of `SessionEvent`'s
   *  `type` union, and none may be silent - see `session.ts` for what each
   *  one means. */
  function onSessionEvent(event: SessionEvent): void {
    switch (event.type) {
      case 'state':
        logger.info('vr session', event);
        // Once, and only here: 'running' comes back after every resync too,
        // and re-sending this would rewind a match that had already moved on
        // - `LockstepRoom.svelte`'s own handler states the same rule for the
        // flat path's `resumeSaveId`.
        if (event.message === 'running' && pendingResumeSaveId && groupRoomId) {
          const wanted = pendingResumeSaveId;
          pendingResumeSaveId = null;
          const applyingHost = groupIsHost;
          awaitSave(groupRoomId, wanted, (bytes, name) => {
            // D5: only the host adopts and reseeds the session; the guest
            // gets the change as an ordinary resync over the netplay
            // protocol, exactly like `LockstepRoom.svelte`'s `onSaveLoaded`.
            if (!applyingHost) return;
            (engine as LockstepEngine | null)?.adoptState(bytes, `save "${name ?? ''}"`);
          });
        }
        break;
      case 'resync-start':
      case 'resync-done':
      case 'peer-ready':
      case 'rtt':
        logger.info('vr session', event);
        break;
      case 'desync':
      case 'link-lost':
        logger.warn('vr session', event);
        noteOnLibrary(event);
        break;
      case 'link-restored':
        logger.info('vr session', event);
        noteOnLibrary(event);
        break;
      case 'error':
        logger.error('vr session', event);
        /*
         * An `error` is not always a death.
         *
         * `fail()` sets the session to `'failed'`; a savestate that will not
         * load reports `error` and leaves it running - and that second path
         * is reachable only through the resume this feature added. Ending the
         * game on it would cost the FRIEND their session over a save that
         * merely did not apply, which the flat twin does not do: it shows the
         * text and plays on.
         */
        if (engine && (engine as LockstepEngine).session?.state !== 'failed') {
          noteOnLibrary(event);
          scene?.panelsVisible(true);
          break;
        }
        // Back to the screen that can explain itself, rather than a picture
        // that has stopped moving for no stated reason - `stopTogether`
        // below is what actually puts it there.
        launchNotice = t($language, 'vrLaunchFailed');
        void stopTogether();
        break;
      default: {
        /*
         * An exhaustiveness assertion, not a catch-all.
         *
         * Carrying no `default` at all would not protect this switch: a
         * statement switch with no return is not exhaustiveness-checked, so
         * an unhandled member would silently do nothing - which is what
         * `LockstepRoom.svelte`'s own handler does today with three of the
         * nine.
         *
         * Assigning the narrowed value to `never` is what makes the compiler
         * name the member nobody handled.
         */
        const unhandled: never = event.type;
        logger.warn('vr session event nobody handles', { type: unhandled });
        break;
      }
    }
  }

  /**
   * Ends the game and stays in VR.
   *
   * Two callers, and they are not the same kind of event. `onSessionEvent`
   * reaches here after reporting `error`, and the profile band's `stop` button
   * reaches here because the player asked. The work is identical either way -
   * release the engine, give the room its game back, raise the panels, put the
   * curved screen back on the launch options - so it is one function rather
   * than two that must be kept in step.
   *
   * Deliberately NOT `leave()`: that ends the `XRSession` and drops the player
   * out of the headset. Until this button existed that was the only way out of
   * a running game, because the launch screen only exists while no game holds
   * the screen - so choosing a second game meant leaving VR and coming back.
   *
   * Raises the panels, because the library's notice band that carries the
   * error message is invisible while `panelsVisible` is false, and puts the
   * curved screen itself back on the launch options rather than leaving the
   * dead game's last frame up front and centre - see `backToLaunchScreen`.
   * A session-level `error` is treated as fatal to the game for both
   * players, not just this one: the same lockstep session is what just broke,
   * so `giveUpRoom` releases the room's game rather than only this seat - see
   * its own header for the full reasoning. A deliberate stop wants the same
   * thing for a different reason: the player leaving is one of the two the
   * game needs, so there is no game left to hand back to.
   *
   * Safe in solo, where `giveUpRoom` emits nothing: it is guarded on a room
   * with two players in `playing` status, and solo has no room at all.
   */
  async function stopTogether(): Promise<void> {
    await engine?.stop();
    engine = null;
    saveContext = null;
    void audio?.stop();
    audio = null;
    groupRoomId = null;
    groupIsHost = false;
    pendingResumeSaveId = null;
    giveUpRoom();
    scene?.panelsVisible(true);
    backToLaunchScreen();
    repaintLibrary();
    repaintProfile();
  }

  /**
   * The other side of a group game ending: the friend released it (their own
   * quit button or pause menu, from the flat page), and the server has
   * already told the whole room by the time this fires.
   *
   * Local cleanup only. Unlike `stopTogether`, this never calls `giveUpRoom`
   * - nothing here decided to end the game, so there is nothing to give back
   * that the other player has not already taken care of - and it never
   * touches the socket. Guarded on `engine` so the echo of this player's own
   * `room:release-game` (see `giveUpRoom`) is a safe no-op: `teardown` and
   * `stopTogether` both null `engine` before they can cause that echo.
   */
  function onGameStopped(): void {
    if (!engine) return;
    void engine.stop();
    engine = null;
    void audio?.stop();
    audio = null;
    groupRoomId = null;
    groupIsHost = false;
    pendingResumeSaveId = null;
    scene?.panelsVisible(true);
    backToLaunchScreen();
    repaintLibrary();
    repaintProfile();
  }

  function frame(): void {
    if (!scene) return;

    /*
     * A capture in progress owns the controllers, and owns them first.
     *
     * The right stick click CANCELS here instead of recalling the panels: it
     * is the one input outside the model, so it is the only recall a player
     * can have while every other button is capturable. `activeXrInputs`
     * deliberately never reports it, so cancelling cannot also be captured.
     *
     * Nothing else runs this frame - no pointer, no hover - because the panel
     * carries no regions while it listens.
     */
    if (tabletScreen === 'controls' && listeningFor) {
      const sources = scene.inputSources();
      if (menuPressed(sources)) {
        /*
         * The whole sequence, not just this button.
         *
         * Cancelling and then jumping to the next button would be baffling -
         * the player asked to stop, not to skip - and it is what Escape does
         * on the flat page (`PlayerControls.svelte`'s `cancelSequence`).
         * Somebody who wants one button left alone can end the sequence and
         * point at the others on the drawing.
         */
        bindSequence = null;
        listeningFor = null;
        captureGate.reset();
        repaintControls();
        return;
      }
      /*
       * The cast is sound, and narrow.
       *
       * `CaptureGate` speaks plain strings - it is shared with the flat
       * screen, whose codes are keyboard and standard-pad codes. The only
       * thing this call ever hands it is `activeXrInputs`' output, so the only
       * thing it can hand back is one of those.
       */
      const taken = captureGate.tick(activeXrInputs(sources)) as XrInput | null;
      if (taken) {
        padMap = assignInput(padMap, listeningFor, taken);
        writePadMap(localStorage, padMap);
        // Read back for the same reason the presets are: `readPadMap` is the
        // only thing that decides, and the default is removed rather than
        // stored - so a map that happens to equal it must still read back.
        padMap = readPadMap(localStorage);

        /*
         * Advance, or hand the pointer back.
         *
         * `nextInSequence` returns null past the last button rather than an
         * index that does not exist, which is what stops the capture staying
         * armed on nothing - a player pressing into the void with nothing on
         * screen to say so.
         */
        if (bindSequence === null) {
          listeningFor = null;
        } else {
          const next = nextInSequence(bindSequence);
          bindSequence = next;
          listeningFor = next === null ? null : BIND_SEQUENCE[next];
          // Primed again for the press that has not been released yet.
          if (next !== null) {
            captureGate.reset();
            captureGate.tick(activeXrInputs(sources));
          }
        }

        repaintControls();
        repaintProfile();
      }
      return;
    }

    if (menuPressed(scene.inputSources())) scene.panelsVisible(true);

    /*
     * L'accéléré, avant la sortie anticipée qui suit : c'est le seul geste que
     * ce composant lit manettes en main PENDANT que le jeu tourne.
     *
     * L'ordre des `&&` fait deux choses. Il garde `fastForwardHeld` - le seul
     * terme qui parcoure les manettes - dans le seul cas où la réponse peut
     * être vraie ; et son premier terme est ce qui relâche l'accéléré quand
     * les panneaux reviennent, y compris quand c'est le clic du stick DROIT
     * juste au-dessus qui vient de les rappeler alors que le gauche est
     * toujours enfoncé. Un bouton qui a disparu ne peut pas être relâché -
     * `SoloRoom.svelte` tient la même règle sur son pad tactile.
     */
    setFastForward(
      !scene.arePanelsVisible() &&
        groupRoomId === null &&
        engine !== null &&
        fastForwardHeld(scene.inputSources(), padMap, sessionVisibility())
    );

    /*
     * The panels and the game never read the controllers at the same time.
     * The trigger is the pointer while the panels are up and SNES R while they
     * are down, and letting both read it would make a scroll press jump in
     * Super Mario World.
     */
    if (!scene.arePanelsVisible()) return;

    const tick = pointer.update(scene.aimedAt(), scene.triggerDown());
    if (!sameTarget(tick.hover, hovered)) {
      const before = hovered;
      hovered = tick.hover;
      // Only the panels whose hover actually changed: a panel repaint is a
      // canvas rasterise, and doing it for all three every hover tick would
      // cost more, at 72 Hz, than the emulator itself.
      for (const panel of new Set([before?.panel, hovered?.panel])) {
        if (panel === 'library') repaintLibrary();
        if (panel === 'friends') repaintFriends();
        if (panel === 'profile') repaintProfile();
        /*
         * `repaintTablet`, pas `repaintControls`.
         *
         * La tablette porte cinq écrans et chacun dessine son survol ; appeler
         * le repeint du remap sortait aussitôt sur sa propre garde
         * (`tabletScreen !== 'controls'`) dès qu'un autre écran était levé.
         * Résultat : un pointeur posé sur « + » n'allumait rien sur les
         * réglages d'écran, sur les sauvegardes et sur le relief - le seul
         * retour qui dise « celui-là répondra ».
         */
        if (panel === 'tablet') repaintTablet();
        // The screen carries only the launch options now, so there is nothing
        // left to choose between here.
        if (panel === 'screen') repaintLaunch();
      }
    }
    if (tick.activated) activate(tick.activated);
  }

  /*
   * Named consts, registered in `enter()` below and unregistered with the
   * SAME references in `teardown()`. `FriendsList.svelte` binds these same
   * two socket.io events on the same socket and stays mounted across a VR
   * session; in socket.io v4 `off(event)` with no handler argument removes
   * EVERY listener for that event, not just this component's, so a bare
   * `$socket?.off('friends:online')` here used to also strip `FriendsList`'s
   * listener - it kept rendering, just never updating again, which pointed
   * nowhere near VR as the cause.
   */
  function handleFriendsOnline(list: Array<{ id: string; online: boolean }>): void {
    onlineFriends = new Map(list.map((f) => [f.id, f.online]));
    repaintFriends();
  }

  function handleFriendStatusChanged({ userId, online }: { userId: string; online: boolean }): void {
    // Reassigned, not mutated in place: `onlineFriends` is only read through
    // the explicit `repaintFriends()` call below today, but a `.set()` with
    // no reassignment is invisible to Svelte's reactivity, and
    // `handleFriendsOnline` above already reassigns - keeping both handlers in
    // that shape means neither can quietly become the one Svelte can't see.
    onlineFriends = new Map(onlineFriends).set(userId, online);
    repaintFriends();
  }

  async function enter(): Promise<void> {
    if (session) return;
    try {
      // Read once per session, into the plain `let` above - see its comment
      // for why this cannot be a reactive statement.
      padMap = readPadMap(localStorage);
      // Lue avant la scène, pas après : la géométrie de l'écran est construite
      // dans `createVrScene`, et l'appliquer ensuite ferait apparaître le
      // réglage du joueur comme un saut au premier frame.
      screenShape = readScreenShape(localStorage);
      // Sans await : la table par défaut est déjà jouable, et faire attendre
      // l'ouverture de la session sur une requête réseau serait payer une
      // lenteur visible pour un réglage que presque personne ne change.
      void loadBluetoothConfig();

      scene = createVrScene({
        aspect: readAspectPreference(localStorage),
        shape: screenShape,
        onContextLost: () => {
          logger.warn('the XR webgl context was lost');
          // `show(message, type)` — the store has no `.error()` helper
          // (`services/notification.ts:16`), and a 6 s duration because this
          // one lands on the flat page the player has just been dropped onto.
          notifications.show(t($language, 'vrContextLost'), 'error', 6000);
          void leave();
        },
        // The one witness to a throw out of the XR animation loop. Without it
        // the loop's own guard would keep the world drawable and tell nobody
        // why the game had stopped.
        onFrameError: (err) => logger.error('vr frame', err)
      });

      session = await openVrSession(() => {
        // The single exit. Not `leave()`: the session is already over, and
        // asking it to end again would be the second call this guards against.
        void teardown();
      });

      await scene.attach(session.session as unknown as XRSession);

      /*
       * Armed as early as they can be, not after the panels and the friends
       * fetch below - `frame()` and `vrActive` used to be the LAST two
       * statements of this function, after an unbounded `fetch`. Until they
       * ran: `frame()` did not exist, so nothing on any panel could respond,
       * including the quit region - `profile.ts`'s header calls that the
       * only exit this app offers - and `vrActive` was still false, so the
       * `room:opened` guard at `+layout.svelte:62` was not yet in place for a
       * partner who chose a game during that window.
       *
       * Safe this early: `frame()` reads `library`, `friendsPanel` and
       * `profilePanel`, all still null below, and the repaint calls it can
       * reach already guard on that (`if (!library) return;` and its
       * siblings). `scene.arePanelsVisible()` defaults true with no panels
       * added yet, `aimedAt()` raycasts against an empty mesh list and
       * returns null, and `sameTarget(null, null)` is true - so a frame here
       * finds nothing to do rather than throwing on it.
       */
      scene.onFrame(frame);
      scene.onFrame((t) => {
        ensureDecor();
        decor?.update(t);
      });
      vrActive.set(true);


      // Until a game is launched, this is what the screen carries - and what
      // makes a wrong distance or height obvious.
      scene.screen.showTestPattern();
      showDecor(true);

      library = scene.addPanel('library', scene.layout.library, LIBRARY_PANEL_SIZE);
      resolvable = await resolvableHere();
      libraryState = {
        // `deviceLibrary()` deliberately keeps an entry with no `crc32` - see
        // its own header - because the flat library is where that game gets
        // an identity. There is no identify flow in here (no file picker to
        // launch it from), so that same entry would otherwise become a
        // `game:<id>` tile that highlights and swallows the press without
        // ever launching anything - `panels/library.ts`'s own comment on
        // `layoutLibraryPanel` calls that worse than not listing it at all.
        // Filtered here, not in `deviceLibrary()`, so the flat library keeps
        // offering to identify these; VR just does not list what it cannot
        // act on.
        games: deviceLibrary($games, resolvable).filter((game) => Boolean(game.crc32)),
        ownedTotal: $games.length,
        scroll: 0
      };
      loadCovers(libraryState.games);
      repaintLibrary();

      friendsPanel = scene.addPanel('friends', scene.layout.friends, FRIENDS_PANEL_SIZE);
      try {
        // Bounded the same way `readRoomSram` bounds its own round trip
        // below: a network stall here is the same class of problem the
        // reordering above just fixed for `frame()` and `vrActive` - an
        // await with no ceiling holding something armed for however long it
        // takes, except this one still had no ceiling at all.
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);
        try {
          const res = await fetch('/api/friends', {
            credentials: 'include',
            signal: controller.signal
          });
          if (res.ok) friendEntries = await res.json();
        } finally {
          clearTimeout(timer);
        }
      } catch (err) {
        // A shopfront that failed to load is a shopfront that says "no
        // friends yet". Nothing here is worth ending a session over.
        logger.warn('friends could not be loaded for VR', err);
      }
      $socket?.on('friends:online', handleFriendsOnline);
      $socket?.on('friend:statusChanged', handleFriendStatusChanged);
      $socket?.emit('friends:getOnlineStatus');
      repaintFriends();

      // Neither player's press is the trigger: the room answers `game:started`
      // to both members once either of them asks, and `onGameStarted` reads
      // `$myRoom` fresh rather than trusting anything carried on the event.
      $socket?.on('game:started', onGameStarted);
      /*
       * Servir le jeu, pour toute la session.
       *
       * Pas seulement pendant une partie : la demande arrive quand l'invité
       * démarre, et le serveur la route vers le socket de l'hôte quel que soit
       * l'état de la room. Un écouteur posé plus tard aurait manqué
       * exactement la demande qu'il existe pour entendre.
       */
      $socket?.on('rom:request', onRomRequested);
      /*
       * Une manette allumée pendant la session doit apparaître sur le panneau.
       *
       * `fixedPad` est lu au peint, donc sans ces deux écouteurs la ligne
       * resterait sur « aucune détectée » jusqu'au prochain survol - et c'est
       * précisément le joueur qui vient d'appairer sa manette qui la lirait.
       *
       * Que ces événements arrivent pendant une session immersive fait partie
       * de ce qu'aucune documentation ne dit ; les poser ne coûte rien, et la
       * ligne se rafraîchit de toute façon au prochain survol.
       */
      window.addEventListener('gamepadconnected', repaintControls);
      window.addEventListener('gamepaddisconnected', repaintControls);
      // The friend's own quit reaches this listener the same way - the only
      // path that can tell the *other* player of a netplay room the match is
      // over, exactly as `room-session.ts` states for the flat page.
      $socket?.on('game:stopped', onGameStopped);

      /*
       * `game:started` and `game:stopped` are room-channel events, and
       * `socket.join(room.id)` only ever happens in `room:create` and
       * `joinRoom` (`room:join`'s handler) - never on its own for a socket
       * that reconnects. A VR player who reloads, or opens a fresh tab, then
       * enters VR while already in a group is on a socket the room channel
       * has never seen, exactly the gap the flat room page closes by
       * emitting this on every mount. Without it, pressing Launch here gets
       * `game:start` accepted server-side with nobody left to hear the
       * `game:started` that was supposed to build the engine.
       */
      if ($myRoom) $socket?.emit('room:join', { roomId: $myRoom.id });
      /*
       * And again on every reconnect, which `rooms/room-session.ts:75` calls
       * mandatory in as many words: the socket comes back on its own, but
       * `room:join` does not replay itself. Without this a blip mid-session
       * drops channel membership for good - after which `game:started` and
       * `game:stopped` never arrive again, so a friend's quit leaves the
       * frozen picture this feature spent two rounds removing.
       */
      rejoinRoom = () => {
        const room = get(myRoom);
        if (room) $socket?.emit('room:join', { roomId: room.id });
      };
      $socket?.on('connect', rejoinRoom);

      profilePanel = scene.addPanel('profile', scene.layout.profile, PROFILE_PANEL_SIZE);

      /*
       * The tablet, raised only when asked for.
       *
       * Hidden at session start, and `aimable` (`panel.ts`) is what makes
       * "hidden" mean "not a target" as well as "not drawn" - three's
       * raycaster tests only layers, so without that rule a closed tablet
       * would swallow the presses meant for the lecterns behind it.
       */
      tabletPanel = scene.addPanel('tablet', scene.layout.tablet, TABLET_PANEL_SIZE);
      tabletPanel.mesh.visible = false;
      repaintProfile();
    } catch (err) {
      logger.error('entering VR failed', err);
      notifications.show(t($language, 'vrUnavailable'), 'error', 6000);
      // Not `teardown()`: `openVrSession` may already have resolved before
      // `scene.attach` (or anything after it) threw, in which case the
      // browser's `XRSession` is still open and `teardown()` would only make
      // the app forget it exists. `closeAnySession()` is safe either way.
      closeAnySession();
    }
  }

  async function leave(): Promise<void> {
    if (leaving) return;
    leaving = true;
    try {
      await session?.end();
      // `end()` raises `sessionend`, which runs `teardown`. Nothing more here.
    } finally {
      leaving = false;
    }
  }

  /**
   * Safe from either precondition: ends a session if one is open, which
   * raises `sessionend` and drives `teardown()` through the `onEnd` callback
   * above; tears down directly, with nothing to end, if not.
   *
   * Used at the two sites that cannot promise the session is already closed -
   * a failure partway through `enter()`, and an ordinary Svelte unmount. The
   * component's own invariant is never to be unmounted by navigation, but
   * `onDestroy` still fires on the paths that ignore that invariant, dev-mode
   * HMR chief among them, so it has to go through here rather than straight to
   * `teardown()`.
   */
  function closeAnySession(): void {
    if (session) {
      void leave();
    } else {
      void teardown();
    }
  }

  /**
   * Hands the room back.
   *
   * Called from every path that ends a game without another taking its place:
   * the ordinary exit, a session that died mid-launch, a launch whose engine
   * never started, and a lockstep session `onSessionEvent` gave up on. NOT
   * from the relaunch guard - `createRoom` has already run there, and the
   * server dropped the old room when it did. NOT from `onGameStopped` either
   * - that path did not decide to end the game, the other player did, and
   * there is nothing left here to give back.
   *
   * Two different ways to give a room back, chosen deliberately rather than
   * one applied everywhere.
   *
   * A room this shell created for itself (`ownedRoomId`, solo only) is given
   * up for real, through `leaveGroup`'s `room:leave` - a solo room only ever
   * has one member, so leaving it and destroying it are the same act.
   *
   * A group's room is never left this way. `room:leave` is, in the flat
   * lobby's own words, "what dissolves a group of two" - exactly what
   * quitting a shared GAME must not do. The flat lobby's quit button and its
   * pause-menu twin (`+page.svelte`'s `releaseGame`, `LockstepRoom.svelte`'s
   * `quitToLobby`) both emit `room:release-game` instead: the game is
   * detached, the room and its membership survive, and the friend keeps
   * their seat to pick another game together. Ending a VR player's group
   * game the harsher way, for no reason tied to VR at all, would be a worse
   * exit than the same action already takes on the flat page - so this
   * mirrors `room:release-game` for the group case too.
   *
   * Silent when there is nothing owed, so it is safe to call twice.
   */
  function giveUpRoom(): void {
    if (ownedRoomId) {
      leaveGroup(ownedRoomId);
      ownedRoomId = null;
      return;
    }

    const room = $myRoom;
    if (room && room.players.length >= 2 && room.status === 'playing') {
      $socket?.emit('room:release-game', { roomId: room.id });
    }
  }

  /** Assumes the browser's `XRSession` is already gone. Only `onEnd` above may
   * call this directly - every other exit goes through `closeAnySession()`. */
  async function teardown(): Promise<void> {
    // First, and awaited: it stops the governor and writes the cartridge save
    // one last time, before audio and the scene it renders into are torn down
    // out from under it. `core` needs no line here - it never lived in this
    // component's state, only the engine's own closure, which `engine.stop()`
    // already released.
    await engine?.stop();
    engine = null;
    saveContext = null;
    groupRoomId = null;
    groupIsHost = false;
    pendingResumeSaveId = null;
    // After the engine, so the last cartridge save is written while the room
    // that stores it still exists.
    giveUpRoom();
    // Closes the AudioContext rather than just dropping the reference - the
    // same leak the relaunch guard in `launch()` closes on its own path, but
    // this is the ordinary one: every session that ever launched a game
    // takes it.
    void audio?.stop();
    audio = null;
    decor?.dispose();
    decor = null;
    scene?.dispose();
    scene = null;
    session = null;
    library = null;
    // The same references `enter()` registered - see the comment above
    // `handleFriendsOnline` for why a bare `off(event)` is not safe here.
    $socket?.off('friends:online', handleFriendsOnline);
    $socket?.off('friend:statusChanged', handleFriendStatusChanged);
    $socket?.off('game:started', onGameStarted);
    $socket?.off('game:stopped', onGameStopped);
    $socket?.off('rom:request', onRomRequested);
    window.removeEventListener('gamepadconnected', repaintControls);
    window.removeEventListener('gamepaddisconnected', repaintControls);
    friendsPanel = null;
    friendEntries = [];
    onlineFriends = new Map();
    profilePanel = null;
    tabletPanel = null;
    covers.clear();
    saveShots.clear();
    savesList = [];
    savesBusy = false;
    savesConfirming = null;
    romTransfer = null;
    loadedRom = null;
    tabletScreen = null;
    listeningFor = null;
    captureGate.reset();
    hovered = null;
    pointer = createPointer();
    launchNotice = null;
    // Left set, a quit from the launch screen would show it again on the very
    // next session's screen before anything was clicked - `scene` is fresh,
    // but this `let` is component state and outlives the session that set it.
    launchFor = null;
    stagedSaveId = null;
    // The shared socket outlives this session; a listener left on it would
    // fire against a core that no longer has an engine.
    dropSaveListener();
    if (rejoinRoom) {
      $socket?.off('connect', rejoinRoom);
      rejoinRoom = null;
    }
    vrActive.set(false);
    vrRequested.set(false);
  }

  // The button sets the store; this is the one place that acts on it.
  $: if ($vrRequested && !session) void enter();

  onDestroy(closeAnySession);
</script>

<!-- Nothing is rendered: the whole surface of this component is the headset.
     The renderer's canvas is detached on purpose - it is never displayed on the
     flat page, and inserting it would leave a black rectangle behind the app. -->
