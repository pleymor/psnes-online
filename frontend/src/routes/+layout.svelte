<script lang="ts">
  import { onMount } from 'svelte';
  import { user, userLoading } from '$lib/stores/user';
  import { socket, initializeSocket } from '$lib/api/socket';

  let socketInitialized = false;

  onMount(async () => {
    // Check authentication
    try {
      const res = await fetch('/auth/me', { credentials: 'include' });
      if (res.ok) {
        const userData = await res.json();
        user.set(userData);
      }
    } catch (error) {
      console.error('Auth check failed:', error);
    } finally {
      userLoading.set(false);
    }
  });

  // Initialize socket when user logs in, disconnect when user logs out
  $: {
    if ($user && !socketInitialized && !$userLoading) {
      // User is logged in and socket not initialized
      initializeSocket();
      socketInitialized = true;
    } else if (!$user && socketInitialized) {
      // User logged out, clean up socket
      if ($socket) {
        $socket.disconnect();
        socket.set(null);
      }
      socketInitialized = false;
    }
  }
</script>

<div class="app">
  <slot />
</div>

<style>
  :global(body) {
    margin: 0;
    padding: 0;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
    background: #1a1a1a;
    color: #ffffff;
  }

  .app {
    min-height: 100vh;
    display: flex;
    flex-direction: column;
  }

  :global(*) {
    box-sizing: border-box;
  }
</style>
