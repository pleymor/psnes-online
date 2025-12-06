<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { language } from '$lib/stores/language';
  import { t } from '$lib/i18n/translations';
  import { createLogger } from '$lib/utils/logger';

  const dispatch = createEventDispatcher<{
    select: { fileId: string; fileName: string; mimeType: string };
  }>();
  const logger = createLogger('DriveFolderBrowser');

  interface DriveItem {
    id: string;
    name: string;
    mimeType: string;
    isFolder: boolean;
  }

  const ROM_EXTENSIONS = ['.smc', '.sfc', '.fig', '.swc', '.mgd', '.zip'];

  let loading = true;
  let error = '';
  let breadcrumbs: { id: string; name: string }[] = [{ id: 'root', name: 'My Drive' }];
  let currentFolderId = 'root';
  let currentItems: DriveItem[] = [];

  async function loadFolder(folderId: string): Promise<DriveItem[]> {
    try {
      const response = await fetch(`/api/games/drive-folder/${folderId}`, {
        credentials: 'include'
      });

      if (!response.ok) {
        throw new Error('Failed to load folder');
      }

      return await response.json();
    } catch (err: any) {
      logger.error('Failed to load folder:', err);
      throw err;
    }
  }

  async function navigateToFolder(folderId: string, folderName: string) {
    loading = true;
    error = '';

    try {
      const items = await loadFolder(folderId);
      currentItems = items;
      currentFolderId = folderId;

      // Update breadcrumbs
      if (folderId === 'root') {
        breadcrumbs = [{ id: 'root', name: 'My Drive' }];
      } else {
        const existingIndex = breadcrumbs.findIndex(b => b.id === folderId);
        if (existingIndex >= 0) {
          breadcrumbs = breadcrumbs.slice(0, existingIndex + 1);
        } else {
          breadcrumbs = [...breadcrumbs, { id: folderId, name: folderName }];
        }
      }
    } catch (err: any) {
      error = err.message || 'Failed to load folder';
    } finally {
      loading = false;
    }
  }

  function isRomFile(item: DriveItem): boolean {
    if (item.isFolder) return false;
    const ext = item.name.toLowerCase();
    return ROM_EXTENSIONS.some(e => ext.endsWith(e));
  }

  function handleItemClick(item: DriveItem) {
    if (item.isFolder) {
      navigateToFolder(item.id, item.name);
    } else if (isRomFile(item)) {
      dispatch('select', {
        fileId: item.id,
        fileName: item.name,
        mimeType: item.mimeType
      });
    }
  }

  function getFileIcon(item: DriveItem): string {
    if (item.isFolder) return '📁';
    if (isRomFile(item)) return '🎮';
    return '📄';
  }

  // Initialize
  navigateToFolder('root', 'My Drive');
</script>

<div class="drive-browser">
  <nav class="breadcrumbs">
    {#each breadcrumbs as crumb, i}
      {#if i > 0}
        <span class="separator">/</span>
      {/if}
      <button
        class="crumb"
        class:current={i === breadcrumbs.length - 1}
        on:click={() => navigateToFolder(crumb.id, crumb.name)}
        disabled={i === breadcrumbs.length - 1}
      >
        {crumb.name}
      </button>
    {/each}
  </nav>

  {#if error}
    <div class="error-message">{error}</div>
  {/if}

  <div class="items-container">
    {#if loading}
      <div class="loading">{t($language, 'loading')}</div>
    {:else if currentItems.length === 0}
      <div class="empty">This folder is empty</div>
    {:else}
      <ul class="items-list">
        {#each currentItems as item}
          {@const isRom = isRomFile(item)}
          <li>
            <button
              class="item"
              class:folder={item.isFolder}
              class:rom={isRom}
              class:disabled={!item.isFolder && !isRom}
              on:click={() => handleItemClick(item)}
              disabled={!item.isFolder && !isRom}
            >
              <span class="icon">{getFileIcon(item)}</span>
              <span class="name">{item.name}</span>
              {#if item.isFolder}
                <span class="arrow">&rsaquo;</span>
              {/if}
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </div>

  <div class="hint">
    Click on a ROM file (.smc, .sfc, .zip) to select it
  </div>
</div>

<style>
  .drive-browser {
    display: flex;
    flex-direction: column;
    height: 400px;
    background: #1a1a1a;
    border-radius: 8px;
    overflow: hidden;
  }

  .breadcrumbs {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.75rem 1rem;
    background: #252525;
    border-bottom: 1px solid #333;
    flex-wrap: wrap;
  }

  .separator {
    color: #666;
  }

  .crumb {
    background: none;
    border: none;
    color: #4285f4;
    cursor: pointer;
    padding: 0.25rem 0.5rem;
    border-radius: 4px;
    font-size: 0.875rem;
  }

  .crumb:hover:not(:disabled) {
    background: rgba(66, 133, 244, 0.1);
  }

  .crumb.current {
    color: #fff;
    cursor: default;
  }

  .error-message {
    background: rgba(244, 67, 54, 0.15);
    border: 1px solid rgba(244, 67, 54, 0.5);
    padding: 0.75rem 1rem;
    margin: 0.5rem;
    border-radius: 6px;
    color: #f44336;
    font-size: 0.875rem;
  }

  .items-container {
    flex: 1;
    overflow-y: auto;
    padding: 0.5rem;
  }

  .loading,
  .empty {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: #888;
  }

  .items-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .item {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    width: 100%;
    padding: 0.75rem 1rem;
    background: none;
    border: none;
    border-radius: 6px;
    color: #fff;
    cursor: pointer;
    text-align: left;
    font-size: 0.9rem;
  }

  .item:hover:not(:disabled) {
    background: #2a2a2a;
  }

  .item.folder {
    color: #ffd54f;
  }

  .item.rom {
    color: #81c784;
  }

  .item.disabled {
    color: #555;
    cursor: not-allowed;
  }

  .icon {
    font-size: 1.25rem;
    flex-shrink: 0;
  }

  .name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .arrow {
    color: #666;
    font-size: 1.25rem;
  }

  .hint {
    padding: 0.75rem 1rem;
    background: #252525;
    border-top: 1px solid #333;
    color: #888;
    font-size: 0.75rem;
    text-align: center;
  }
</style>
