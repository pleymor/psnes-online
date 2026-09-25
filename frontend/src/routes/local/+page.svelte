<script lang="ts">
  /**
   * One game, solo, without an account - and without a network, once the
   * service worker is installed (#70).
   *
   * A static route with the checksum in the query rather than `/local/[crc]`:
   * a static route is prerendered, so it is in the service worker's precache
   * and opens offline by its own URL, not only through the shell fallback.
   *
   * `SoloRoom` does the playing, as in a room; what changes is `localGame`,
   * which sends its saves to `saves/local-store.ts` instead of the socket.
   * There is no room, no game row and no server here at all.
   */
  import { onMount, onDestroy } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import SoloRoom from '$lib/components/SoloRoom.svelte';
  import { user, userLoading } from '$lib/stores/user';
  import { inGame } from '$lib/stores/in-game';
  import { language } from '$lib/stores/language';
  import { t } from '$lib/i18n/translations';
  import { setPageTitle } from '$lib/utils/page-title';
  import { readLocalControls } from '$lib/stores/local-controls';
  import { listLocalGames } from '$lib/roms/local-games';
  import type { ControlsConfig } from '$lib/controls/binding';

  $: checksum = $page.url.searchParams.get('rom') ?? '';

  let controls: ControlsConfig = readLocalControls(localStorage);
  let title = '';

  // A player with an account plays through rooms, whose saves are on the
  // server; two save stores for one account is #71's to reconcile, not this
  // page's to start.
  $: if (!$userLoading && $user) void goto('/');

  $: setPageTitle($language, title || t($language, 'localTitle'));

  onMount(async () => {
    const games = await listLocalGames().catch(() => []);
    title = games.find((g) => g.checksum === checksum)?.title ?? '';
    inGame.set(true);
    document.body.style.overflow = 'hidden';
  });

  onDestroy(() => {
    inGame.set(false);
    if (typeof document !== 'undefined') document.body.style.overflow = '';
  });
</script>

<div class="local-container">
  {#if !checksum}
    <p class="missing">{t($language, 'localRomMissing')}</p>
    <a class="back" href="/">{t($language, 'backToLibrary')}</a>
  {:else}
    <!-- Keyed on the checksum: a different game is a different machine. -->
    {#key checksum}
      <SoloRoom
        localGame={{ checksum }}
        gameCrc32={checksum}
        gameTitle={title}
        {controls}
        on:quit={() => goto('/')}
        on:controlsSaved={(e) => (controls = e.detail.config)}
      />
    {/key}
  {/if}
</div>

<style>
  .local-container {
    /* The room page's box, for the room page's reason: `100dvh` follows the
       visible window on a phone whose address bar is showing. */
    height: 100vh;
    height: 100dvh;
    width: 100vw;
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    overflow: hidden;
  }

  .missing {
    font-family: var(--display);
  }

  .back {
    color: var(--brand-lift);
  }
</style>
