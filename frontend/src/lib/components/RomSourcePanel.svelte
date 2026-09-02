<script lang="ts">
  /**
   * Where this machine's ROMs come from.
   *
   * Replaces the "add games" modal. ROMs stopped living on the server, so the
   * library is a list of identities and the files come from a folder - which
   * makes configuring the folder once the right shape, and adding games one at
   * a time the shape of before.
   *
   * It has two forms, and the second is not a consolation prize shown
   * everywhere: folder selection needs `showDirectoryPicker`, which only
   * Chromium has. Without the single-file fallback, Firefox and Safari would
   * have a permanently empty library and no recourse.
   */
  import { onMount } from 'svelte';
  import { language } from '$lib/stores/language';
  import { t } from '$lib/i18n/translations';
  import { createLogger } from '$lib/utils/logger';
  import { games } from '$lib/stores/games';
  import { romSourceState, type RomSourceState } from '$lib/roms/source-state';
  import { pickerError } from '$lib/roms/picker-error';
  import {
    supportsDirectoryPicker,
    chooseDirectory,
    storedDirectory,
    ensureAccess,
    scanDirectory,
    registerGame,
    forgetIndexed,
    indexedChecksums
  } from '$lib/roms/local-library';
  import { syncFolder } from '$lib/roms/folder-sync';

  const logger = createLogger('RomSourcePanel');

  let state: RomSourceState = { kind: 'no-folder' };
  let busy = false;
  let error = '';
  let progress = '';
  let added = 0;
  let removed = 0;
  let upToDate = false;

  /**
   * Combien de jeux du compte cet appareil ne peut pas ouvrir.
   *
   * La bibliothèque les masque, ce qui est le comportement demandé ; les faire
   * disparaître sans le dire nulle part serait un autre mensonge. Ici est
   * l'endroit : on y vient déjà pour configurer ses ROMs.
   */
  export let missingCount = 0;

  /**
   * Aligne le compte et l'index sur ce que le dossier contient.
   *
   * Appelée depuis pickFolder dès qu'un handle utilisable existe - qu'il vienne
   * d'un nouveau dossier ou d'un accès re-accordé - parce que l'un comme
   * l'autre peut laisser la bibliothèque ignorante de ce qui a changé.
   *
   * La décision vit dans `folder-sync`, testée sans navigateur ; ici il ne
   * reste que le branchement des API et la phrase montrée au joueur.
   */
  async function scanAndRegister(handle: FileSystemDirectoryHandle): Promise<void> {
    progress = t($language, 'scanningFolder');
    const known = new Set(
      $games.map((g) => g.crc32).filter((c): c is string => !!c)
    );
    const result = await syncFolder({
      scan: () => scanDirectory(handle),
      register: registerGame,
      indexed: indexedChecksums,
      forget: forgetIndexed,
      // Le compte sait ce qu'il possède, donc un dossier inchangé ne se
      // prétend pas ajouté - et quarante POST inutiles ne partent pas.
      isKnown: (checksum) => known.has(checksum),
      onProgress: (done, total, filename) => {
        progress = `${done}/${total} · ${filename}`;
      }
    });

    added = result.added;
    removed = result.removed;

    if (result.empty) {
      error = t($language, 'noRomsFound');
      return;
    }

    // Tout échouer ressemble exactement à un scan terminé si on ne le dit pas
    // - le joueur vient de regarder quarante cartouches défiler pour rien. Un
    // dossier déjà à jour, lui, n'est pas une erreur.
    if (result.added === 0 && result.removed === 0) {
      if (result.failed > 0) error = t($language, 'romsNoneAdded');
      else upToDate = true;
    }
    if (result.failed > 0) logger.warn(`${result.failed} ROM(s) refusée(s) sur ${result.total}`);
  }

  /**
   * Gathers the facts, then lets the pure function decide.
   *
   * The split is deliberate: the gathering needs three browser APIs and a
   * permission check, and the decision is the part that can be wrong without
   * anyone seeing it.
   */
  async function refresh(): Promise<void> {
    try {
      const supported = supportsDirectoryPicker();
      if (!supported) {
        state = romSourceState({ supported: false });
        return;
      }
      const handle = await storedDirectory();
      if (!handle) {
        state = romSourceState({ supported: true });
        return;
      }
      state = romSourceState({
        supported: true,
        folderName: handle.name,
        accessGranted: await ensureAccess(handle)
      });
    } catch (err) {
      // A remembered folder that was since moved or deleted must not vanish
      // as an unhandled rejection - the player is left staring at a stale
      // "no folder" state with no idea why.
      const message = pickerError(err);
      if (message) error = message;
    }
  }

  async function pickFolder(): Promise<void> {
    busy = true;
    error = '';
    progress = '';
    added = 0;
    removed = 0;
    upToDate = false;
    try {
      if (await chooseDirectory()) {
        const handle = await storedDirectory();
        if (handle) await scanAndRegister(handle);
      }
      await refresh();
    } catch (err) {
      const message = pickerError(err);
      if (message) error = message;
    } finally {
      busy = false;
      progress = '';
    }
  }

  onMount(refresh);
</script>

<section class="rom-source">
  <h2>{t($language, 'romSource')}</h2>
  {#if missingCount > 0}
    <p class="explain">{missingCount} {t($language, 'gamesNotOnThisDevice')}</p>
  {/if}
  <p class="legal">{t($language, 'legalUploadWarning')}</p>

  {#if state.kind === 'unsupported'}
    <p class="explain">{t($language, 'romFolderUnsupported')}</p>
    <!-- The single-file path lives here and only here: shown where a folder
         cannot be remembered, so it costs nothing to anyone else. -->
    <slot name="fallback" />
  {:else if state.kind === 'folder'}
    <p class="current">{t($language, 'romFolderCurrent')} <strong>{state.name}</strong></p>
    <button on:click={pickFolder} disabled={busy}>{t($language, 'romFolderChange')}</button>
  {:else if state.kind === 'folder-stale'}
    <p class="explain">
      {t($language, 'romFolderStale')} <strong>{state.name}</strong>
    </p>
    <button on:click={pickFolder} disabled={busy}>{t($language, 'romFolderRegrant')}</button>
  {:else}
    <p class="explain">{t($language, 'romsStayLocal')}</p>
    <button on:click={pickFolder} disabled={busy}>{t($language, 'chooseRomFolder')}</button>
  {/if}

  {#if progress}
    <p class="explain">{progress}</p>
  {/if}
  {#if added > 0 && !busy}
    <p class="explain">{added} {t($language, 'gamesAdded')}</p>
  {/if}
  {#if removed > 0 && !busy}
    <p class="explain">{removed} {t($language, 'gamesRemoved')}</p>
  {/if}
  {#if upToDate && !busy}
    <p class="explain">{t($language, 'libraryUpToDate')}</p>
  {/if}
  {#if error}
    <p class="error">{error}</p>
  {/if}
</section>

<style>
  /* The same card look the profile page gives its own sections. Repeated
     here rather than shared, because Svelte scopes styles to the component
     that owns the markup. */
  .rom-source {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.5rem;
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid rgba(255, 255, 255, 0.07);
    border-radius: 14px;
    padding: 1.25rem;
  }

  .rom-source h2 {
    margin: 0 0 0.25rem;
    font-size: 0.8rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: #9aa0b4;
  }

  h2 {
    margin: 0;
  }

  .explain,
  .current {
    margin: 0;
    color: #aaa;
    font-size: 0.9rem;
  }

  .error {
    margin: 0;
    color: #f87171;
    font-size: 0.9rem;
  }

  .legal {
    margin: 0;
    font-size: 0.75rem;
    /* 3.3:1 en #6f6f88 sur le #212121 de ce panneau, à 12px : sous les 4.5
       d'AA, et c'est l'avertissement légal - le paragraphe qu'il est le moins
       acceptable de rendre illisible. Même teinte, éclaircie à 5.62:1. */
    color: #9797aa;
    line-height: 1.4;
  }

  button {
    background: #333;
    border: 2px solid transparent;
    color: #fff;
    padding: 0.4rem 0.75rem;
    border-radius: 6px;
    cursor: pointer;
  }

  button:disabled {
    opacity: 0.5;
    cursor: default;
  }
</style>
