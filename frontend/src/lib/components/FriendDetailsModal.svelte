<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { language } from '$lib/stores/language';
  import { t } from '$lib/i18n/translations';
  import ConfirmModal from './ConfirmModal.svelte';

  export let friend: any;
  export let friendsSince: string;
  export let friendshipId: string;

  const dispatch = createEventDispatcher();

  let showRemoveConfirm = false;

  function formatDate(dateString: string, lang: 'en' | 'fr'): string {
    const date = new Date(dateString);
    const now = new Date();
    const diffTime = Math.abs(now.getTime() - date.getTime());
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

    if (diffDays < 1) {
      return t(lang, 'today');
    } else if (diffDays === 1) {
      return t(lang, 'dayAgo');
    } else if (diffDays < 30) {
      return t(lang, 'daysAgo', { count: diffDays });
    } else if (diffDays < 365) {
      const months = Math.floor(diffDays / 30);
      return months === 1 ? t(lang, 'monthAgo') : t(lang, 'monthsAgo', { count: months });
    } else {
      const years = Math.floor(diffDays / 365);
      return years === 1 ? t(lang, 'yearAgo') : t(lang, 'yearsAgo', { count: years });
    }
  }

  function handleRemoveFriend() {
    console.log('handleRemoveFriend called');
    showRemoveConfirm = true;
    console.log('showRemoveConfirm set to:', showRemoveConfirm);
  }

  function handleRemoveConfirm() {
    console.log('handleRemoveConfirm called');
    showRemoveConfirm = false;
    dispatch('remove', { friendshipId });
  }

  $: dateText = formatDate(friendsSince, $language);
</script>

<div class="modal-backdrop" on:click={() => dispatch('close')}>
  <div class="modal" on:click|stopPropagation>
    <div class="header">
      <h2>{t($language, 'friendDetails')}</h2>
      <button class="close-btn" on:click={() => dispatch('close')}>×</button>
    </div>

    <div class="content">
      <div class="friend-info">
        <div class="avatar">
          {#if friend.avatar}
            <img src={friend.avatar} alt={friend.displayName} />
          {:else}
            👤
          {/if}
        </div>
        <h3>{friend.displayName}</h3>
        <p class="email">{friend.email}</p>
      </div>

      <div class="details">
        <div class="detail-row">
          <span class="label">{t($language, 'friendsSince')}:</span>
          <span class="value">{dateText}</span>
        </div>
        <div class="detail-row">
          <span class="label">{t($language, 'exactDate')}:</span>
          <span class="value">{new Date(friendsSince).toLocaleDateString()}</span>
        </div>
      </div>

      <div class="actions">
        <button class="btn-remove" on:click={handleRemoveFriend}>
          {t($language, 'removeFriend')}
        </button>
      </div>
    </div>
  </div>
</div>

<style>
  .modal-backdrop {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.85);
    backdrop-filter: blur(8px);
    display: flex;
    justify-content: center;
    align-items: center;
    z-index: 9999;
    animation: fadeIn 0.2s ease-out;
  }

  @keyframes fadeIn {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }

  @keyframes slideUp {
    from {
      transform: translateY(30px);
      opacity: 0;
    }
    to {
      transform: translateY(0);
      opacity: 1;
    }
  }

  .modal {
    background: linear-gradient(135deg, #1e1e1e 0%, #2a2a2a 100%);
    border-radius: 16px;
    max-width: 500px;
    width: 90%;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
    border: 1px solid rgba(255, 255, 255, 0.1);
    animation: slideUp 0.3s ease-out;
  }

  .header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 1.5rem;
    border-bottom: 1px solid #444;
  }

  h2 {
    margin: 0;
    font-size: 1.5rem;
  }

  .close-btn {
    background: none;
    border: none;
    color: #aaa;
    font-size: 2rem;
    cursor: pointer;
    padding: 0;
    width: 32px;
    height: 32px;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: color 0.2s;
  }

  .close-btn:hover {
    color: white;
  }

  .content {
    padding: 2rem;
  }

  .friend-info {
    text-align: center;
    margin-bottom: 2rem;
  }

  .avatar {
    width: 80px;
    height: 80px;
    border-radius: 50%;
    background: #333;
    display: flex;
    justify-content: center;
    align-items: center;
    font-size: 3rem;
    overflow: hidden;
    margin: 0 auto 1rem;
    border: 3px solid #667eea;
  }

  .avatar img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  h3 {
    margin: 0 0 0.5rem 0;
    font-size: 1.5rem;
    color: white;
  }

  .email {
    color: #888;
    font-size: 0.875rem;
    margin: 0;
  }

  .details {
    background: #1a1a1a;
    border-radius: 8px;
    padding: 1.5rem;
    margin-bottom: 1.5rem;
  }

  .detail-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.75rem 0;
  }

  .detail-row:not(:last-child) {
    border-bottom: 1px solid #333;
  }

  .label {
    color: #888;
    font-size: 0.875rem;
  }

  .value {
    color: white;
    font-weight: 500;
  }

  .actions {
    display: flex;
    justify-content: center;
  }

  .btn-remove {
    background: #f44336;
    color: white;
    border: none;
    padding: 0.75rem 2rem;
    border-radius: 8px;
    cursor: pointer;
    font-size: 1rem;
    transition: all 0.2s;
  }

  .btn-remove:hover {
    background: #d32f2f;
    transform: translateY(-2px);
    box-shadow: 0 4px 12px rgba(244, 67, 54, 0.4);
  }

  /* Responsive styles */
  @media (max-width: 768px) {
    .modal {
      width: 95%;
      max-width: none;
      margin: 1rem;
    }

    .content {
      padding: 1.5rem;
    }

    .header {
      padding: 1rem 1.5rem;
    }

    h2 {
      font-size: 1.25rem;
    }

    .avatar {
      width: 64px;
      height: 64px;
      font-size: 2rem;
    }

    h3 {
      font-size: 1.25rem;
    }
  }
</style>

{#if showRemoveConfirm}
  <ConfirmModal
    title={t($language, 'removeFriend')}
    message={t($language, 'confirmRemoveFriend', { name: friend.displayName })}
    confirmText={t($language, 'removeFriend')}
    cancelText={t($language, 'cancel')}
    danger={true}
    on:confirm={handleRemoveConfirm}
    on:cancel={() => showRemoveConfirm = false}
  />
{/if}
