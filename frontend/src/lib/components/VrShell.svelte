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

  const logger = createLogger('VrShell');

  let session: VrSession | null = null;
  let scene: VrScene | null = null;
  /** Guards `leave()` against re-entrant calls - see the header. */
  let leaving = false;

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
      vrActive.set(true);
    } catch (err) {
      logger.error('entering VR failed', err);
      notifications.show(t($language, 'vrUnavailable'), 'error', 6000);
      teardown();
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

  function teardown(): void {
    scene?.dispose();
    scene = null;
    session = null;
    vrActive.set(false);
    vrRequested.set(false);
  }

  // The button sets the store; this is the one place that acts on it.
  $: if ($vrRequested && !session) void enter();

  onDestroy(teardown);
</script>

<!-- Nothing is rendered: the whole surface of this component is the headset.
     The renderer's canvas is detached on purpose - it is never displayed on the
     flat page, and inserting it would leave a black rectangle behind the app. -->
