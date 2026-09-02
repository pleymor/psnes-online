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
  import { vrRequested, vrActive } from '$lib/vr/entry';
  import { openVrSession, type VrSession } from '$lib/vr/xr-session';
  import { createVrScene, type VrScene } from '$lib/vr/scene';
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
  import { menuPressed } from '$lib/vr/pad';
  import { games } from '$lib/stores/games';
  import { deviceLibrary } from '$lib/roms/device-library';
  import { resolvableHere } from '$lib/roms/provider';
  import type { PanelMesh } from '$lib/vr/panel-mesh';

  const logger = createLogger('VrShell');

  let session: VrSession | null = null;
  let scene: VrScene | null = null;
  /** Guards `leave()` against re-entrant calls - see the header. */
  let leaving = false;

  const pointer = createPointer();
  let library: PanelMesh | null = null;
  let libraryState: LibraryState = { games: [], ownedTotal: 0, scroll: 0 };
  let hovered: PointerTarget | null = null;
  /** Read once on entry: the picker that would change it does not exist in
   *  here, so it cannot change during a session. */
  let resolvable: string[] = [];

  /** Covers are same-origin behind the session cookie (`api/covers.ts:9`), so
   *  they load with no crossOrigin attribute - setting one would break the
   *  cookie AND taint the canvas, and a tainted canvas cannot become a WebGL
   *  texture at all. */
  const covers = new Map<string, CanvasImageSource>();

  function repaintLibrary(): void {
    if (!library) return;
    library.regions = layoutLibraryPanel(libraryState);
    const regions = library.regions;
    library.paint((ctx) =>
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
      })
    );
  }

  function loadCovers(list: typeof $games): void {
    for (const game of list) {
      if (!game.coverUrl || covers.has(game.id)) continue;
      const image = new Image();
      image.onload = () => { covers.set(game.id, image); repaintLibrary(); };
      image.src = game.coverUrl;
    }
  }

  function activate(target: PointerTarget): void {
    if (target.panel !== 'library') return;
    if (target.region.id === 'scroll:up' || target.region.id === 'scroll:down') {
      const step = target.region.id === 'scroll:down' ? 1 : -1;
      libraryState = {
        ...libraryState,
        scroll: clampScroll(libraryState.scroll + step, libraryRows(libraryState))
      };
      repaintLibrary();
      return;
    }
    // Launching arrives in the next task.
  }

  function frame(): void {
    if (!scene) return;

    if (menuPressed(scene.inputSources())) scene.panelsVisible(true);

    /*
     * The panels and the game never read the controllers at the same time.
     * The trigger is the pointer while the panels are up and SNES R while they
     * are down, and letting both read it would make a scroll press jump in
     * Super Mario World.
     */
    if (!scene.arePanelsVisible()) return;

    const tick = pointer.update(scene.aimedAt(), scene.triggerDown());
    if (!sameTarget(tick.hover, hovered)) {
      hovered = tick.hover;
      repaintLibrary();
    }
    if (tick.activated) activate(tick.activated);
  }

  async function enter(): Promise<void> {
    if (session) return;
    try {
      scene = createVrScene({
        aspect: readAspectPreference(localStorage),
        onContextLost: () => {
          logger.warn('the XR webgl context was lost');
          // `show(message, type)` — the store has no `.error()` helper
          // (`services/notification.ts:16`), and a 6 s duration because this
          // one lands on the flat page the player has just been dropped onto.
          notifications.show(t($language, 'vrContextLost'), 'error', 6000);
          void leave();
        }
      });

      session = await openVrSession(() => {
        // The single exit. Not `leave()`: the session is already over, and
        // asking it to end again would be the second call this guards against.
        teardown();
      });

      await scene.attach(session.session as unknown as XRSession, session.spaceType);
      // Until a game is launched, this is what the screen carries - and what
      // makes a wrong distance or height obvious.
      scene.screen.showTestPattern();

      library = scene.addPanel('library', scene.layout.library, LIBRARY_PANEL_SIZE);
      resolvable = await resolvableHere();
      libraryState = {
        games: deviceLibrary($games, resolvable),
        ownedTotal: $games.length,
        scroll: 0
      };
      loadCovers(libraryState.games);
      repaintLibrary();
      scene.onFrame(frame);

      vrActive.set(true);
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
      teardown();
    }
  }

  /** Assumes the browser's `XRSession` is already gone. Only `onEnd` above may
   * call this directly - every other exit goes through `closeAnySession()`. */
  function teardown(): void {
    scene?.dispose();
    scene = null;
    session = null;
    library = null;
    covers.clear();
    hovered = null;
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
