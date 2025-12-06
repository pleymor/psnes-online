<script lang="ts">
  import { notifications } from '$lib/services/notification';
  import { fade, fly } from 'svelte/transition';
</script>

{#if $notifications.length > 0}
  <div class="notification-container">
    {#each $notifications as notification (notification.id)}
      <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
      <div
        class="notification notification-{notification.type}"
        role="alert"
        transition:fly={{ y: -20, duration: 300 }}
        on:click={() => notifications.dismiss(notification.id)}
      >
        <span>{notification.message}</span>
        <button class="close-btn" aria-label="Close">×</button>
      </div>
    {/each}
  </div>
{/if}

<style>
  .notification-container {
    position: fixed;
    top: 20px;
    right: 20px;
    z-index: 9999;
    display: flex;
    flex-direction: column;
    gap: 10px;
    pointer-events: none;
  }

  .notification {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 16px;
    border-radius: 8px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    min-width: 300px;
    max-width: 400px;
    pointer-events: auto;
    cursor: pointer;
    transition: transform 0.2s;
  }

  .notification:hover {
    transform: translateX(-4px);
  }

  .notification span {
    flex: 1;
    font-size: 14px;
  }

  .close-btn {
    background: none;
    border: none;
    font-size: 20px;
    cursor: pointer;
    opacity: 0.7;
    transition: opacity 0.2s;
    padding: 0;
    width: 20px;
    height: 20px;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .close-btn:hover {
    opacity: 1;
  }

  .notification-success {
    background-color: #10b981;
    color: white;
  }

  .notification-error {
    background-color: #ef4444;
    color: white;
  }

  .notification-warning {
    background-color: #f59e0b;
    color: white;
  }

  .notification-info {
    background-color: #3b82f6;
    color: white;
  }
</style>
