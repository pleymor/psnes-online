<script lang="ts">
  /**
   * Everything the sidebar used to hold that was not navigation.
   *
   * A route rather than a modal: it carries enough to deserve an address, and
   * an address can be shared, opened in a tab, and left with the back button.
   *
   * Sections are ordered by what someone came for - identity first, settings
   * next, signing out last because it is the destructive one.
   */
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { user } from '$lib/stores/user';
  import { language } from '$lib/stores/language';
  import { t } from '$lib/i18n/translations';
  import type { KeyConfig } from '$lib/types';
  import ControlsSettings from '$lib/components/ControlsSettings.svelte';
  import LanguageSelector from '$lib/components/LanguageSelector.svelte';
  import RomSourcePanel from '$lib/components/RomSourcePanel.svelte';
  import { SHADERS } from '$lib/shaders';
  import { readShaderPreference, writeShaderPreference } from '$lib/stores/shader-preference';

  let keyConfig: KeyConfig | null = null;
  let shader = '';
  let refreshing = false;
  let refreshMessage = '';

  onMount(async () => {
    // localStorage owns the display setting; this page and the pause menu both
    // read it at mount and write it on change. They never coexist on screen,
    // so there is nothing to keep in sync.
    shader = readShaderPreference(localStorage);

    const res = await fetch('/api/user/controls', { credentials: 'include' });
    if (res.ok) keyConfig = await res.json();
  });

  function chooseShader(id: string): void {
    shader = id;
    writeShaderPreference(localStorage, id);
  }

  async function refreshMetadata(): Promise<void> {
    refreshing = true;
    refreshMessage = '';
    try {
      const res = await fetch('/api/games/refresh-metadata', {
        method: 'POST',
        credentials: 'include'
      });
      if (res.ok) {
        const result = await res.json();
        refreshMessage = t($language, 'metadataUpdated', {
          updated: result.updated,
          skipped: result.skipped
        });
      } else {
        refreshMessage = t($language, 'metadataUpdateFailed');
      }
    } catch {
      refreshMessage = t($language, 'metadataUpdateFailed');
    } finally {
      refreshing = false;
    }
  }

  async function logout(): Promise<void> {
    await fetch('/auth/logout', { method: 'POST', credentials: 'include' });
    user.set(null);
    void goto('/');
  }
</script>

<div class="profile">
  <a class="back" href="/">← {t($language, 'backToLibrary')}</a>

  <section class="identity">
    <div class="avatar">
      {#if $user?.avatar}
        <img src={$user.avatar} alt={$user.displayName} />
      {:else}
        <span class="placeholder">👤</span>
      {/if}
    </div>
    <div class="who">
      <h2>{$user?.displayName ?? ''}</h2>
      <p class="email">{$user?.email ?? ''}</p>
    </div>
  </section>

  <RomSourcePanel />

  <section>
    <h3>{t($language, 'controls')}</h3>
    {#if keyConfig}
      <ControlsSettings currentConfig={keyConfig} on:saved={(e) => (keyConfig = e.detail.config)} />
    {/if}
  </section>

  <section class="display">
    <h3>{t($language, 'display')}</h3>
    <div class="shaders">
      {#each SHADERS as option}
        <button class:on={shader === option.id} on:click={() => chooseShader(option.id)}>
          {t($language, option.name)}
        </button>
      {/each}
    </div>
  </section>

  <section>
    <h3>{t($language, 'language')}</h3>
    <LanguageSelector />
  </section>

  <section>
    <h3>{t($language, 'library')}</h3>
    <button on:click={refreshMetadata} disabled={refreshing}>
      {refreshing ? t($language, 'updating') : t($language, 'updateMetadata')}
    </button>
    {#if refreshMessage}<p class="note">{refreshMessage}</p>{/if}
  </section>

  <section class="danger">
    <button class="logout" on:click={logout}>{t($language, 'logout')}</button>
  </section>
</div>

<style>
  .profile {
    max-width: 48rem;
    margin: 0 auto;
    padding: 1.5rem;
    display: flex;
    flex-direction: column;
    gap: 2rem;
  }

  .back {
    color: #aaa;
    text-decoration: none;
    align-self: flex-start;
  }

  .identity {
    display: flex;
    align-items: center;
    gap: 1.5rem;
  }

  .avatar {
    width: 6rem;
    height: 6rem;
    border-radius: 50%;
    overflow: hidden;
    background: #333;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }

  .avatar img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .placeholder {
    font-size: 2.5rem;
  }

  h2,
  h3 {
    margin: 0;
  }

  .email {
    margin: 0.25rem 0 0;
    color: #aaa;
  }

  .shaders {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin-top: 0.5rem;
  }

  button {
    background: #333;
    border: 2px solid transparent;
    color: #fff;
    padding: 0.4rem 0.75rem;
    border-radius: 6px;
    cursor: pointer;
  }

  button.on {
    background: #3a4a5a;
    border-color: #667eea;
  }

  button:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .note {
    margin: 0.5rem 0 0;
    color: #aaa;
    font-size: 0.9rem;
  }

  .logout {
    background: #7f1d1d;
  }
</style>
