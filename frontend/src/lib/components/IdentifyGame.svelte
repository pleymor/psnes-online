<script lang="ts">
  /**
   * Saying which game a ROM is.
   *
   * Two states, and the order matters: searching first, because the answer is
   * usually already in the catalogue and the search field is seeded with the
   * game's current title - so the ordinary case is one click on a result that
   * is already at the top. Writing an entry is the fallback, reached from a
   * link rather than offered as an equal choice, since a duplicate entry is
   * worse than a link to an existing one.
   */
  import { createEventDispatcher, onMount } from 'svelte';
  import { language } from '$lib/stores/language';
  import { t } from '$lib/i18n/translations';
  import { encodeCover } from '$lib/games/cover';
  import { createLogger } from '$lib/utils/logger';

  const logger = createLogger('IdentifyGame');
  const dispatch = createEventDispatcher<{ close: void; identified: string }>();

  export let gameId: string;
  export let title = '';

  interface Match {
    id: string;
    title: string;
    altTitle: string | null;
    region: string | null;
    publisher: string | null;
    releaseDate: string | null;
    coverUrl: string | null;
  }

  let mode: 'search' | 'create' = 'search';
  let query = title;
  let results: Match[] = [];
  let searching = false;
  let busy = false;
  let error = '';
  /** Set when the entry landed but its image did not, so only the image is retried. */
  let coverPendingFor: string | null = null;

  let form = {
    title,
    altTitle: '',
    genre: '',
    publisher: '',
    developer: '',
    releaseDate: '',
    players: '',
    region: '',
    description: ''
  };
  let coverFile: File | null = null;
  let coverPreview = '';

  let searchTimer: ReturnType<typeof setTimeout>;

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape' && !busy) dispatch('close');
  }

  onMount(() => {
    window.addEventListener('keydown', handleKeydown);
    search();
    return () => {
      window.removeEventListener('keydown', handleKeydown);
      clearTimeout(searchTimer);
      if (coverPreview) URL.revokeObjectURL(coverPreview);
    };
  });

  async function search() {
    if (query.trim().length < 2) {
      results = [];
      return;
    }
    searching = true;
    try {
      const res = await fetch(`/api/metadata/search?q=${encodeURIComponent(query)}`, {
        credentials: 'include'
      });
      results = res.ok ? await res.json() : [];
    } catch (err) {
      logger.warn('The catalogue search failed', err);
      results = [];
    } finally {
      searching = false;
    }
  }

  function onQueryInput() {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(search, 200);
  }

  /** Posts the identification and turns the API's answers into something readable. */
  async function identify(body: Record<string, unknown>): Promise<string | null> {
    const res = await fetch(`/api/games/${gameId}/identify`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const payload = await res.json().catch(() => ({}));

    if (res.status === 409) {
      // Not a failure: if this dump is claimed, its metadata already applies
      // everywhere, so this library is simply out of date. Saying what the game
      // is and reloading is more use than an error nobody can act on.
      error = `${t($language, 'identifyAlreadyClaimed')} ${payload.metadata?.title ?? '?'}`;
      dispatch('identified', payload.metadata?.id ?? '');
      return null;
    }
    if (!res.ok) throw new Error(payload.error || `HTTP ${res.status}`);
    return payload.metadataId as string;
  }

  async function linkTo(match: Match) {
    busy = true;
    error = '';
    try {
      const metadataId = await identify({ metadataId: match.id });
      if (metadataId) dispatch('identified', metadataId);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      logger.error('Could not link the game', err);
    } finally {
      busy = false;
    }
  }

  function onCoverChosen(event: Event) {
    const file = (event.currentTarget as HTMLInputElement).files?.[0] ?? null;
    if (coverPreview) URL.revokeObjectURL(coverPreview);
    coverFile = file;
    coverPreview = file ? URL.createObjectURL(file) : '';
  }

  /**
   * Sends the image on its own.
   *
   * Separate from the entry deliberately: the bytes go raw so they skip the
   * global JSON parser's limit, which means two requests - and the entry is
   * created first, so a failed upload leaves a valid, linked entry rather than
   * losing what the player typed.
   */
  async function uploadCover(metadataId: string): Promise<void> {
    if (!coverFile) return;
    const { blob, mime } = await encodeCover(coverFile);
    const res = await fetch(`/api/metadata/${metadataId}/cover`, {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': mime },
      body: blob
    });
    if (!res.ok) {
      const payload = await res.json().catch(() => ({}));
      throw new Error(payload.error || `HTTP ${res.status}`);
    }
  }

  async function createEntry() {
    busy = true;
    error = '';
    try {
      const metadataId = coverPendingFor ?? (await identify({ entry: form }));
      if (!metadataId) return;
      try {
        await uploadCover(metadataId);
      } catch (err) {
        // The entry exists and is linked; only the picture is missing, so the
        // button becomes "try the image again" rather than re-posting the entry.
        coverPendingFor = metadataId;
        error = `${t($language, 'identifyCoverFailed')} ${err instanceof Error ? err.message : ''}`;
        return;
      }
      dispatch('identified', metadataId);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      logger.error('Could not create the entry', err);
    } finally {
      busy = false;
    }
  }

  function year(date: string | null): string {
    return date ? date.slice(0, 4) : '';
  }
</script>

<!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
<div class="backdrop" role="presentation" on:click={() => !busy && dispatch('close')}>
  <div class="modal" role="dialog" aria-modal="true" on:click|stopPropagation>
    {#if mode === 'search'}
      <h2>{t($language, 'identifyGame')}</h2>
      <p class="explain">{t($language, 'identifyExplain')}</p>

      <input
        class="search"
        type="search"
        bind:value={query}
        on:input={onQueryInput}
        placeholder={t($language, 'identifySearchPlaceholder')}
        disabled={busy}
      />

      {#if error}
        <p class="error">{error}</p>
      {/if}

      <ul class="results">
        {#each results as match (match.id)}
          <li>
            <button class="result" on:click={() => linkTo(match)} disabled={busy}>
              {#if match.coverUrl}
                <img src={match.coverUrl} alt="" class="thumb" />
              {:else}
                <span class="thumb">🎮</span>
              {/if}
              <span class="result-text">
                <strong>{match.title}</strong>
                <small>
                  {[match.publisher, match.region, year(match.releaseDate)]
                    .filter(Boolean)
                    .join(' · ')}
                </small>
              </span>
            </button>
          </li>
        {/each}
      </ul>

      {#if !searching && results.length === 0 && query.trim().length >= 2}
        <p class="explain">{t($language, 'identifyNoResults')}</p>
      {/if}

      <div class="actions">
        <button class="secondary" on:click={() => dispatch('close')} disabled={busy}>
          {t($language, 'cancel')}
        </button>
        <button class="link" on:click={() => (mode = 'create')} disabled={busy}>
          {t($language, 'identifyCreate')}
        </button>
      </div>
    {:else}
      <h2>{t($language, 'identifyCreateTitle')}</h2>
      <p class="explain">{t($language, 'identifyCreateExplain')}</p>

      {#if error}
        <p class="error">{error}</p>
      {/if}

      <div class="fields">
        <label>
          {t($language, 'gameTitle')}
          <input bind:value={form.title} disabled={busy} />
        </label>
        <label>
          {t($language, 'genre')}
          <input bind:value={form.genre} disabled={busy} />
        </label>
        <label>
          {t($language, 'publisher')}
          <input bind:value={form.publisher} disabled={busy} />
        </label>
        <label>
          {t($language, 'developer')}
          <input bind:value={form.developer} disabled={busy} />
        </label>
        <label>
          {t($language, 'releaseDate')}
          <input bind:value={form.releaseDate} disabled={busy} placeholder="1994-03-19" />
        </label>
        <label>
          {t($language, 'players')}
          <input bind:value={form.players} disabled={busy} />
        </label>
        <label>
          {t($language, 'region')}
          <input bind:value={form.region} disabled={busy} />
        </label>
      </div>

      <label class="wide">
        {t($language, 'gameDescription')}
        <textarea bind:value={form.description} rows="3" disabled={busy}></textarea>
      </label>

      <label class="wide">
        {t($language, 'coverImage')}
        <input
          type="file"
          accept="image/png,image/jpeg,image/webp"
          on:change={onCoverChosen}
          disabled={busy}
        />
      </label>
      {#if coverPreview}
        <img src={coverPreview} alt="" class="preview" />
      {/if}

      <div class="actions">
        <button class="secondary" on:click={() => (mode = 'search')} disabled={busy}>
          {t($language, 'identifyBackToSearch')}
        </button>
        <button class="primary" on:click={createEntry} disabled={busy}>
          {busy
            ? t($language, 'loading')
            : coverPendingFor
              ? t($language, 'identifyRetryCover')
              : t($language, 'identifyCreateSubmit')}
        </button>
      </div>
    {/if}
  </div>
</div>

<style>
  /* The same modal look LinkRom.svelte uses, repeated rather than shared
     because Svelte scopes styles to the component that owns the markup. */
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.7);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
    padding: 1rem;
  }

  .modal {
    background: #1b1b26;
    border: 1px solid #2c2c3c;
    border-radius: 12px;
    padding: 1.5rem;
    width: 100%;
    max-width: 520px;
    max-height: 85vh;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 0.9rem;
  }

  h2 {
    margin: 0;
    font-size: 1.15rem;
    color: #fff;
  }

  .explain {
    margin: 0;
    font-size: 0.85rem;
    line-height: 1.5;
    color: #8b8ba3;
  }

  .error {
    margin: 0;
    color: #ff8f8f;
    font-size: 0.85rem;
  }

  input,
  textarea {
    background: #12121a;
    border: 1px solid #2c2c3c;
    border-radius: 6px;
    padding: 0.45rem 0.6rem;
    color: #eee;
    font-size: 0.9rem;
    width: 100%;
  }

  .results {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    max-height: 40vh;
    overflow-y: auto;
  }

  .result {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    width: 100%;
    text-align: left;
    background: #12121a;
    border: 1px solid #2c2c3c;
    padding: 0.45rem;
    color: #eee;
  }

  .result:hover:not(:disabled) {
    border-color: #667eea;
  }

  .thumb {
    width: 40px;
    height: 30px;
    object-fit: cover;
    border-radius: 3px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #1f1f2b;
    flex: 0 0 auto;
  }

  .result-text {
    display: flex;
    flex-direction: column;
  }

  .result-text small {
    color: #8b8ba3;
    font-size: 0.75rem;
  }

  .fields {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.5rem;
  }

  label {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    font-size: 0.75rem;
    color: #9aa0b4;
  }

  .preview {
    max-width: 160px;
    border-radius: 6px;
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  button {
    border-radius: 6px;
    padding: 0.5rem 1.1rem;
    font-size: 0.9rem;
    cursor: pointer;
    border: 1px solid transparent;
  }

  button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .secondary {
    background: transparent;
    border-color: #3d3d52;
    color: #b7b7cc;
  }

  .primary {
    /* Pas le #667eea de la marque : 3.66:1 sous du blanc, sous les 4.5
       qu'AA demande. Même teinte, assombrie jusqu'à 4.96:1. */
    background: #4764e6;
    color: #fff;
  }

  .link {
    background: transparent;
    color: #8fa2ff;
    padding-left: 0;
    padding-right: 0;
  }
</style>
