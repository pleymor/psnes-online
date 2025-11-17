<script lang="ts">
  import { onMount, createEventDispatcher } from 'svelte';
  import { socket } from '$lib/api/socket';
  import { language } from '$lib/stores/language';
  import { t } from '$lib/i18n/translations';

  export let roomId: string;
  export let gameId: string;

  const dispatch = createEventDispatcher();

  interface Save {
    id: string;
    name: string;
    slotNumber: number;
    createdAt: string;
    updatedAt: string;
  }

  let saves: Save[] = [];
  let showCreateForm = false;
  let saveName = '';
  let loading = false;
  let selectedSlot = 1;

  onMount(async () => {
    await loadSaves();

    // Listen for save events
    $socket?.on('game:saved', () => {
      loadSaves();
    });
  });

  async function loadSaves() {
    try {
      const res = await fetch(`/api/games/${gameId}/saves`, {
        credentials: 'include'
      });

      if (res.ok) {
        saves = await res.json();
      }
    } catch (error) {
      console.error('Failed to load saves:', error);
    }
  }

  async function createSave() {
    if (!saveName.trim()) {
      saveName = `${t($language, 'slot')} ${selectedSlot}`;
    }

    loading = true;

    $socket?.emit('game:save', {
      roomId,
      slotNumber: selectedSlot,
      name: saveName
    });

    // Listen for save confirmation
    const saveHandler = () => {
      showCreateForm = false;
      saveName = '';
      loadSaves();
      loading = false;
      dispatch('notification', {
        message: t($language, 'saveCreated'),
        type: 'success'
      });
      $socket?.off('game:saved', saveHandler);
    };

    $socket?.once('game:saved', saveHandler);

    // Handle errors
    const errorHandler = (error: any) => {
      loading = false;
      dispatch('notification', {
        message: t($language, 'failedToSave'),
        type: 'error'
      });
      $socket?.off('error', errorHandler);
    };

    $socket?.once('error', errorHandler);
  }

  function loadSave(save: Save) {
    $socket?.emit('game:load', {
      roomId,
      saveId: save.id
    });

    // Listen for load confirmation
    const loadHandler = () => {
      dispatch('notification', {
        message: t($language, 'saveLoaded'),
        type: 'success'
      });
      dispatch('close');
      $socket?.off('game:loaded', loadHandler);
    };

    $socket?.once('game:loaded', loadHandler);

    // Handle errors
    const errorHandler = (error: any) => {
      dispatch('notification', {
        message: t($language, 'failedToLoad'),
        type: 'error'
      });
      $socket?.off('error', errorHandler);
    };

    $socket?.once('error', errorHandler);
  }

  function getAvailableSlots(): number[] {
    const usedSlots = new Set(saves.map(s => s.slotNumber));
    const available: number[] = [];

    for (let i = 1; i <= 10; i++) {
      if (!usedSlots.has(i)) {
        available.push(i);
      }
    }

    return available;
  }

  function formatDate(dateString: string): string {
    const date = new Date(dateString);
    return date.toLocaleString($language);
  }

  $: availableSlots = getAvailableSlots();
  $: if (availableSlots.length > 0) {
    selectedSlot = availableSlots[0];
  }
</script>

<div class="saves-manager">
  <div class="header">
    <h3>{t($language, 'saves')}</h3>
    {#if availableSlots.length > 0}
      <button class="btn-create" on:click={() => showCreateForm = !showCreateForm}>
        + {t($language, 'createSave')}
      </button>
    {/if}
  </div>

  {#if showCreateForm}
    <div class="create-form">
      <div class="field">
        <label for="slot">{t($language, 'slot')}</label>
        <select id="slot" bind:value={selectedSlot}>
          {#each availableSlots as slot}
            <option value={slot}>{t($language, 'slot')} {slot}</option>
          {/each}
        </select>
      </div>

      <div class="field">
        <label for="name">{t($language, 'saveName')}</label>
        <input
          id="name"
          type="text"
          bind:value={saveName}
          placeholder="{t($language, 'slot')} {selectedSlot}"
          maxlength="50"
        />
      </div>

      <div class="actions">
        <button class="btn-save" on:click={createSave} disabled={loading || availableSlots.length === 0}>
          {loading ? '...' : t($language, 'save')}
        </button>
        <button class="btn-cancel" on:click={() => { showCreateForm = false; saveName = ''; }}>
          {t($language, 'cancel')}
        </button>
      </div>
    </div>
  {/if}

  <div class="saves-list">
    {#if saves.length === 0}
      <p class="empty">{t($language, 'noSaves')}</p>
    {:else}
      {#each saves.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) as save}
        <div class="save-item">
          <div class="save-info">
            <div class="save-header">
              <strong>{save.name}</strong>
              <span class="slot-badge">{t($language, 'slot')} {save.slotNumber}</span>
            </div>
            <small>{t($language, 'savedOn')} {formatDate(save.updatedAt)}</small>
          </div>
          <button class="btn-load" on:click={() => loadSave(save)}>
            {t($language, 'loadState')}
          </button>
        </div>
      {/each}
    {/if}
  </div>
</div>

<style>
  .saves-manager {
    background: #1a1a1a;
    border-radius: 8px;
    padding: 1.5rem;
  }

  .header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1.5rem;
  }

  h3 {
    margin: 0;
    font-size: 1.25rem;
    color: white;
  }

  .btn-create {
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    color: white;
    border: none;
    padding: 0.5rem 1rem;
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.875rem;
    transition: transform 0.2s;
  }

  .btn-create:hover {
    transform: translateY(-2px);
  }

  .create-form {
    background: #252525;
    border-radius: 8px;
    padding: 1rem;
    margin-bottom: 1.5rem;
  }

  .field {
    margin-bottom: 1rem;
  }

  .field:last-of-type {
    margin-bottom: 1.5rem;
  }

  label {
    display: block;
    margin-bottom: 0.5rem;
    color: #ddd;
    font-size: 0.875rem;
  }

  input, select {
    width: 100%;
    padding: 0.5rem;
    background: #1a1a1a;
    border: 1px solid #444;
    border-radius: 4px;
    color: white;
    font-size: 0.875rem;
  }

  .actions {
    display: flex;
    gap: 0.5rem;
  }

  .btn-save {
    flex: 1;
    background: #4caf50;
    color: white;
    border: none;
    padding: 0.5rem;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.875rem;
    transition: background 0.2s;
  }

  .btn-save:hover:not(:disabled) {
    background: #45a049;
  }

  .btn-save:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .btn-cancel {
    flex: 1;
    background: #444;
    color: white;
    border: none;
    padding: 0.5rem;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.875rem;
    transition: background 0.2s;
  }

  .btn-cancel:hover {
    background: #555;
  }

  .saves-list {
    max-height: 400px;
    overflow-y: auto;
  }

  .empty {
    text-align: center;
    color: #666;
    padding: 2rem 0;
    margin: 0;
  }

  .save-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 1rem;
    background: #252525;
    border-radius: 6px;
    margin-bottom: 0.75rem;
    transition: background 0.2s;
  }

  .save-item:hover {
    background: #2a2a2a;
  }

  .save-info {
    flex: 1;
  }

  .save-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.25rem;
  }

  .save-header strong {
    color: white;
    font-size: 0.95rem;
  }

  .slot-badge {
    background: rgba(102, 126, 234, 0.2);
    color: #667eea;
    padding: 0.125rem 0.5rem;
    border-radius: 4px;
    font-size: 0.75rem;
    font-weight: 500;
  }

  .save-info small {
    color: #888;
    font-size: 0.75rem;
  }

  .btn-load {
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    color: white;
    border: none;
    padding: 0.5rem 1rem;
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.875rem;
    transition: transform 0.2s;
    white-space: nowrap;
  }

  .btn-load:hover {
    transform: translateY(-2px);
  }

  /* Scrollbar styling */
  .saves-list::-webkit-scrollbar {
    width: 8px;
  }

  .saves-list::-webkit-scrollbar-track {
    background: #1a1a1a;
    border-radius: 4px;
  }

  .saves-list::-webkit-scrollbar-thumb {
    background: #444;
    border-radius: 4px;
  }

  .saves-list::-webkit-scrollbar-thumb:hover {
    background: #555;
  }
</style>
