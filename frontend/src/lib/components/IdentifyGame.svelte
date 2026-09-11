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

  /**
   * La fiche à laquelle ce jeu est déjà rattaché, s'il l'est.
   *
   * Passée entière plutôt que reconstruite ici : la liste la résout déjà côté
   * serveur, et un aller-retour de plus pour des champs qu'on tient déjà
   * n'apporterait qu'une fenêtre de temps où le formulaire s'ouvre vide.
   *
   * `altTitle` en fait partie alors que rien ne l'affiche - c'est justement
   * pour ça : sans lui, enregistrer une correction effacerait un champ que le
   * joueur n'a jamais vu.
   */
  export let entry: {
    id: string;
    source: string | null;
    title: string;
    altTitle: string;
    genre: string;
    publisher: string;
    developer: string;
    releaseDate: string;
    players: string;
    region: string;
    description: string;
  } | null = null;

  /*
   * Corriger est proposé dès qu'il y a une fiche, mais ne veut pas dire la
   * même chose des deux côtés.
   *
   * Une ligne du catalogue livré ne se réécrit pas : le rafraîchissement JSON
   * la supprime et la réinsère, donc la correction vivrait jusqu'au
   * déploiement suivant et pas plus. Le serveur refuse, et c'est juste.
   *
   * Ne pas proposer le bouton du tout était la première réponse, et c'était
   * la mauvaise : sur 1477 fiches, 1475 sont livrées, donc la fonctionnalité
   * était invisible pour à peu près tout le monde - signalé le 2026-09-10 par
   * quelqu'un cherchant le lien sur Donkey Kong Country. Corriger une fiche
   * livrée écrit donc une COPIE communautaire préremplie et y repointe cette
   * copie du jeu. La ligne livrée n'est pas touchée, la correction tient, et
   * elle parvient à tous ceux qui ont le même dump. Le prix est un
   * quasi-doublon dans le catalogue, choisi en connaissance de cause.
   */
  $: correctable = entry !== null;
  $: copying = mode === 'edit' && entry !== null && entry.source !== 'community';

  interface Match {
    id: string;
    title: string;
    altTitle: string | null;
    region: string | null;
    publisher: string | null;
    releaseDate: string | null;
    coverUrl: string | null;
  }

  let mode: 'search' | 'create' | 'edit' = 'search';
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

    /*
     * Plus de cas 409 ici. Le serveur en renvoyait un pour toute copie déjà
     * identifiée, et ce bloc y répondait en écrivant `error` PUIS en émettant
     * `identified` - ce qui ferme la fenêtre. Le message était détruit à
     * l'instant où il était écrit, donc le joueur voyait la modale
     * disparaître sans un mot. Repointer est permis maintenant, donc il n'y a
     * plus de conflit à expliquer, et ce qui reste tombe dans l'erreur
     * générique en dessous, qui elle s'affiche.
     */
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

  /** Ouvre le formulaire sur ce que la fiche dit aujourd'hui. */
  function startEditing() {
    if (!entry) return;
    error = '';
    form = {
      title: entry.title,
      altTitle: entry.altTitle,
      genre: entry.genre,
      publisher: entry.publisher,
      developer: entry.developer,
      releaseDate: entry.releaseDate,
      players: entry.players,
      region: entry.region,
      description: entry.description
    };
    mode = 'edit';
  }

  /**
   * Écrit ce que le formulaire contient, et rend l'identifiant de la fiche.
   *
   * Trois cas, une seule différence entre eux : où le contenu atterrit. Une
   * fiche communautaire est réécrite sur place, ce qui garde son identifiant -
   * donc sa jaquette, son crédit, et les jeux des autres joueurs. Une fiche
   * livrée et une fiche neuve passent toutes deux par `identify`, qui insère
   * et repointe : pour la première c'est une copie, pour la seconde une
   * création, et le serveur n'a pas à faire la différence.
   */
  async function persistForm(): Promise<string | null> {
    // Une seule chose restait à faire : renvoyer l'image. Ne pas réécrire la
    // fiche évite d'en créer une deuxième au deuxième essai.
    if (coverPendingFor) return coverPendingFor;

    if (mode === 'edit' && entry && entry.source === 'community') {
      const res = await fetch(`/api/metadata/${entry.id}`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form)
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload.error || `HTTP ${res.status}`);
      }
      return entry.id;
    }

    return await identify({ entry: form });
  }

  async function submitForm() {
    busy = true;
    error = '';
    try {
      const metadataId = await persistForm();
      if (!metadataId) return;
      try {
        await uploadCover(metadataId);
      } catch (err) {
        // La fiche existe et la copie pointe dessus ; seule l'image manque,
        // donc le bouton devient « réessayer l'image » plutôt que de renvoyer
        // le formulaire.
        coverPendingFor = metadataId;
        error = `${t($language, 'identifyCoverFailed')} ${err instanceof Error ? err.message : ''}`;
        return;
      }
      dispatch('identified', metadataId);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      logger.error('Could not write the entry', err);
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
      <!--
        Deux en-têtes, parce que cet écran répond à deux questions.
        « Rien ici ne reconnaît cette ROM » était affiché dans les deux cas, y
        compris pour un jeu déjà identifié - où c'est simplement faux, et où
        la question n'est pas « qu'est-ce que c'est » mais « ce n'est pas ça ».
        Nommer la fiche actuelle évite en plus de la choisir à nouveau par
        mégarde : elle est en haut des résultats, puisque la recherche part de
        son titre.
      -->
      {#if entry}
        <h2>{t($language, 'identifyChangeTitle')}</h2>
        <p class="explain">{t($language, 'identifyChangeExplain', { title: entry.title })}</p>
      {:else}
        <h2>{t($language, 'identifyGame')}</h2>
        <p class="explain">{t($language, 'identifyExplain')}</p>
      {/if}

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
        {#if correctable}
          <button class="link" on:click={startEditing} disabled={busy}>
            {t($language, 'identifyCorrect')}
          </button>
        {/if}
        <button class="link" on:click={() => (mode = 'create')} disabled={busy}>
          {t($language, 'identifyCreate')}
        </button>
      </div>
    {:else}
      <h2>{t($language, mode === 'edit' ? 'identifyEditTitle' : 'identifyCreateTitle')}</h2>
      <!--
        Trois phrases pour trois effets. Corriger une fiche livrée en écrit une
        copie plutôt que de la modifier, et le dire ici est la seule façon que
        le joueur ait de le savoir avant de valider.
      -->
      <p class="explain">
        {#if copying}
          {t($language, 'identifyCopyExplain')}
        {:else if mode === 'edit'}
          {t($language, 'identifyEditExplain')}
        {:else}
          {t($language, 'identifyCreateExplain')}
        {/if}
      </p>

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
        <button class="primary" on:click={submitForm} disabled={busy}>
          {busy
            ? t($language, 'loading')
            : coverPendingFor
              ? t($language, 'identifyRetryCover')
              : t($language, mode === 'edit' ? 'identifyEditSubmit' : 'identifyCreateSubmit')}
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
    /* `font-family` en plus de la taille : un textarea hérite du monospace du
       navigateur, pas de la page, donc la description s'affichait en chasse
       fixe au milieu de sept champs qui ne l'étaient pas. Visible seulement
       une fois le formulaire ouvert prérempli. */
    font-family: inherit;
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
    border-color: var(--edge);
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
