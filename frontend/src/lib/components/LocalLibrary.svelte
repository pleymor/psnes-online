<script lang="ts">
  /**
   * The home page without an account: the games on this device, and nothing
   * that needs a server (#70).
   *
   * No top bar, because everything in it belongs to an account - friends,
   * invitations, profile, the VR lobby, the save export (§4.4). No covers and
   * no metadata: the title is the file name (§4.3). What is left is a folder,
   * a list and a Play button, which is all solo play needs.
   *
   * The folder gestures mirror `RomSourcePanel`, minus `registerGame`: there
   * is no account to register a game with, and offline the POST could only
   * fail - forty times, once per cartridge.
   */
  import { createEventDispatcher, onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { language } from '$lib/stores/language';
  import { t } from '$lib/i18n/translations';
  import { createLogger } from '$lib/utils/logger';
  import { romSourceState, type RomSourceState } from '$lib/roms/source-state';
  import { pickerError } from '$lib/roms/picker-error';
  import {
    supportsDirectoryPicker,
    chooseDirectory,
    storedDirectory,
    ensureAccess,
    hasAccess,
    hasWriteAccess,
    ensureWriteAccess,
    scanDirectory
  } from '$lib/roms/local-library';
  import { designateFile, resolvableHere } from '$lib/roms/provider';
  import { offlineLibrary, readLibrarySnapshot, type OfflineGame } from '$lib/games/library-snapshot';
  import { formatHandle } from '$lib/pseudo';
  import type { Game } from '$lib/stores/games';
  import GameCard from './GameCard.svelte';
  import SyncStatus from './SyncStatus.svelte';
  import { listLocalGames, rememberTitle, type LocalGame } from '$lib/roms/local-games';
  import { localPlayHref } from '$lib/rooms/local-play';
  import LanguageSelector from './LanguageSelector.svelte';
  import LocalSavesNote from './LocalSavesNote.svelte';
  import SiteFooter from './SiteFooter.svelte';

  /** Why this screen is up: the player asked, or the server never answered. */
  export let why: 'chosen' | 'unreachable';
  /**
   * The account that played on this device, when the server is silent (#71).
   *
   * Set, the screen is that account's library as it was last seen online:
   * titles and covers from the snapshot `stores/games.ts` keeps, filtered by
   * what this device can open - the same filter as the online library - and
   * the state of the save queue that will go to the account when the network
   * is back. Null is #70's screen, unchanged.
   */
  export let account: { id: string; pseudo: string; discriminator: string } | null = null;

  const dispatch = createEventDispatcher<{ signIn: void }>();
  const logger = createLogger('LocalLibrary');

  let games: LocalGame[] | null = null;
  let seen: OfflineGame[] | null = null;
  let state: RomSourceState = { kind: 'no-folder' };
  let busy = false;
  let error = '';
  let checked = 0;
  let fileInput: HTMLInputElement;

  async function refresh(): Promise<void> {
    checked++;
    try {
      const supported = supportsDirectoryPicker();
      const handle = supported ? await storedDirectory() : undefined;
      // Queried only: a page load is not a gesture, and the regrant has its
      // own button below.
      const accessGranted = handle ? await hasAccess(handle).catch(() => false) : false;
      state = romSourceState({
        supported,
        folderName: handle?.name,
        accessGranted,
        writeGranted: accessGranted && handle ? await hasWriteAccess(handle) : false
      });
    } catch (err) {
      const message = pickerError(err);
      if (message) error = message;
    }
    games = await listLocalGames().catch(() => []);
    if (account) {
      const [snapshot, resolvable] = await Promise.all([
        readLibrarySnapshot(account.id).catch(() => null),
        resolvableHere().catch(() => [] as string[])
      ]);
      seen = offlineLibrary({ snapshot, resolvable, local: games });
    }
  }

  /** A snapshot entry, in the shape `GameCard` draws. */
  function asCard(game: OfflineGame): Game {
    return {
      id: game.id,
      title: game.title,
      filename: game.filename,
      coverUrl: game.coverUrl ?? undefined,
      uploadedAt: '',
      saves: [],
      crc32: game.crc32
    };
  }

  async function gesture(run: () => Promise<void>): Promise<void> {
    busy = true;
    error = '';
    try {
      await run();
    } catch (err) {
      const message = pickerError(err);
      if (message) error = message;
      logger.warn('folder gesture failed', err);
    } finally {
      busy = false;
      await refresh();
    }
  }

  const pickFolder = () =>
    gesture(async () => {
      if (!(await chooseDirectory())) return;
      const handle = await storedDirectory();
      if (handle) await scanDirectory(handle);
    });

  const regrant = () =>
    gesture(async () => {
      const handle = await storedDirectory();
      if (handle && (await ensureAccess(handle))) await scanDirectory(handle);
    });

  const allowWriting = () =>
    gesture(async () => {
      const handle = await storedDirectory();
      if (handle) await ensureWriteAccess(handle);
    });

  function onFile(event: Event): void {
    const input = event.currentTarget as HTMLInputElement;
    const files = [...(input.files ?? [])];
    input.value = '';
    void gesture(async () => {
      for (const file of files) {
        const { checksum } = await designateFile(file);
        // `kept-files` keeps the bytes and nothing else; the name is the
        // only title this game will ever have here.
        await rememberTitle(checksum, file.name).catch(() => {});
      }
    });
  }

  onMount(refresh);
</script>

<main class="local">
  <header class="head">
    <h1>🎮 PSNES</h1>
    {#if account}
      <p class="mode">{t($language, 'offlineAccountTitle')}</p>
      <p class="intro" role="status">
        {t($language, 'offlineAccountIntro', { name: formatHandle(account.pseudo, account.discriminator) })}
      </p>
    {:else}
      <p class="mode">{t($language, 'localTitle')}</p>
      <p class="intro" role={why === 'unreachable' ? 'status' : undefined}>
        {t($language, why === 'unreachable' ? 'localIntroUnreachable' : 'localIntroChosen')}
      </p>
    {/if}
    <div class="head-actions">
      <LanguageSelector />
      {#if why === 'chosen' && !account}
        <button class="quiet" on:click={() => dispatch('signIn')}>{t($language, 'localSignIn')}</button>
      {/if}
    </div>
  </header>

  <section class="panel" aria-labelledby="local-roms">
    <h2 id="local-roms">{t($language, 'romSource')}</h2>
    <p class="legal">{t($language, 'legalRomWarning')}</p>

    {#if state.kind === 'folder'}
      <p class="explain">{t($language, 'romFolderCurrent')} <strong>{state.name}</strong></p>
      <div class="row">
        {#if !state.writable}
          <button on:click={allowWriting} disabled={busy}>{t($language, 'romFolderAllowWrite')}</button>
        {/if}
        <button on:click={pickFolder} disabled={busy}>{t($language, 'romFolderChange')}</button>
      </div>
    {:else if state.kind === 'folder-stale'}
      <p class="explain">{t($language, 'romFolderStale')} <strong>{state.name}</strong></p>
      <button on:click={regrant} disabled={busy}>{t($language, 'romFolderRegrant')}</button>
    {:else if state.kind === 'no-folder'}
      <button on:click={pickFolder} disabled={busy}>{t($language, 'chooseRomFolder')}</button>
    {:else}
      <p class="explain">{t($language, 'romFolderUnsupported')}</p>
    {/if}

    <!-- Offered everywhere, not only where a folder is impossible: a single
         file is the quickest way in, and on Firefox and Safari the only one. -->
    <button class="quiet" on:click={() => fileInput.click()} disabled={busy}>
      {t($language, 'localAddFile')}
    </button>
    <input
      bind:this={fileInput}
      class="file"
      type="file"
      accept=".smc,.sfc,.fig,.swc,.mgd,.zip"
      multiple
      on:change={onFile}
      aria-label={t($language, 'localAddFile')}
    />

    <LocalSavesNote refresh={checked} account={!!account} />
    {#if account}
      <SyncStatus />
    {/if}

    {#if error}
      <p class="error" role="alert">{error}</p>
    {/if}
  </section>

  <section class="games" aria-label={t($language, 'library')}>
    {#if account}
      <!-- The online library's cartridges, with the covers the service worker
           kept: offline, a game already seen looks the way it did online. -->
      {#if seen && seen.length === 0}
        <p class="empty">{t($language, 'offlineAccountNoGames')}</p>
      {:else if seen}
        <div class="covers">
          {#each seen as game (game.crc32)}
            <GameCard
              game={asCard(game)}
              details={false}
              on:play={() => goto(localPlayHref(game.crc32))}
            />
          {/each}
        </div>
      {/if}
    {:else if games && games.length === 0}
      <p class="empty">{t($language, 'localNoGames')}</p>
    {:else if games}
      <ul class="grid">
        {#each games as game (game.checksum)}
          <li class="card">
            <span class="title" title={game.filename ?? game.title}>{game.title}</span>
            <button class="play" on:click={() => goto(localPlayHref(game.checksum))}>
              {t($language, 'play')}
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  <!-- Inside the column, as on the library: at the root it floats at its own
       60rem, unrelated to the column above it. -->
  <SiteFooter />
</main>

<style>
  .local {
    flex: 1;
    width: 100%;
    max-width: 64rem;
    margin: 0 auto;
    padding: 1.5rem 1rem 2rem;
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
    --footer-width: 100%;
  }

  .head h1 {
    margin: 0;
    font-family: var(--display);
  }

  .mode {
    margin: 0.25rem 0 0;
    font-family: var(--display);
    color: var(--edge);
  }

  .intro {
    margin: 0.5rem 0 0;
    color: #cfcfdc;
  }

  .head-actions,
  .row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.75rem;
    margin-top: 0.75rem;
  }

  .row {
    margin-top: 0;
  }

  .panel {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.5rem;
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid rgba(255, 255, 255, 0.07);
    border-radius: 14px;
    padding: 1.25rem;
  }

  .panel h2 {
    margin: 0 0 0.25rem;
    font-size: 0.8rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: #9aa0b4;
  }

  .explain {
    margin: 0;
    color: #aaa;
    font-size: 0.9rem;
  }

  .legal {
    margin: 0;
    font-size: 0.75rem;
    color: #9797aa;
    line-height: 1.4;
  }

  .error {
    margin: 0;
    color: #f87171;
    font-size: 0.9rem;
  }

  .file {
    display: none;
  }

  /* A secondary gesture: the same shape, without the gold edge that says
     "this is the thing to press". */
  .quiet {
    border-color: rgba(255, 255, 255, 0.25);
  }

  .empty {
    color: #aaa;
  }

  .grid {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(14rem, 1fr));
    gap: 0.75rem;
  }

  .covers {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 15rem), 1fr));
    gap: 1rem;
  }

  /* The cream of the library's cartridges, without a cover to put on it. */
  .card {
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    gap: 0.75rem;
    min-height: 7rem;
    padding: 0.9rem;
    background: var(--shell);
    color: var(--ink);
    border-radius: 10px;
    box-shadow: 0 3px 0 var(--ridge);
  }

  .title {
    font-family: var(--display);
    font-size: 1.05rem;
    overflow-wrap: anywhere;
  }

  .play {
    align-self: flex-start;
    background: var(--go);
    border-color: var(--go-deep);
  }
</style>
