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
   * There is no room and no socket here. Since #71 there may be an account,
   * whose saves then also queue for the server (`saves/sync.ts`).
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
  import { localPlayer } from '$lib/rooms/local-play';
  import { offlineAccount } from '$lib/stores/offline-account';
  import { readLibrarySnapshot } from '$lib/games/library-snapshot';
  import type { ControlsConfig } from '$lib/controls/binding';

  $: checksum = $page.url.searchParams.get('rom') ?? '';

  let controls: ControlsConfig = readLocalControls(localStorage);
  let title = '';

  /*
   * Who the saves go to (#71). A player with an account lands here when the
   * server is silent - offline from the start, or dropped mid-evening - and
   * plays exactly as without one: saves on this device. The difference is
   * that they also go into the queue for that account, and leave when the
   * connection is back.
   */
  $: player = $userLoading ? null : localPlayer($user, $offlineAccount);

  $: setPageTitle($language, title || t($language, 'localTitle'));

  // With an account, the title the library showed online - not the file name.
  $: if (player) {
    void readLibrarySnapshot(player)
      .then((seen) => {
        const named = seen?.games.find((g) => g.crc32 === checksum)?.title;
        if (named) title = named;
      })
      .catch(() => {});
  }

  onMount(async () => {
    const games = await listLocalGames().catch(() => []);
    // The file name only where the account's library had nothing better.
    if (!title) title = games.find((g) => g.checksum === checksum)?.title ?? '';
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
  {:else if !$userLoading}
    <!-- Keyed on the checksum, and on who plays: a different game is a
         different machine, and the account decides where its saves go. -->
    {#key `${checksum}:${player ?? ''}`}
      <SoloRoom
        localGame={{ checksum, userId: player }}
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
