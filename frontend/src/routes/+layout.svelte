<script lang="ts">
  import '$lib/polyfills'; // Load Node.js polyfills for browser
  import { onMount } from 'svelte';
  import { user, userLoading } from '$lib/stores/user';
  import { socket, initializeSocket } from '$lib/api/socket';
  import { startLogShipping } from '$lib/utils/log-shipper';
  import { createLogger } from '$lib/utils/logger';
  import { linkState } from '$lib/stores/connection';
  import NotificationToast from '$lib/components/NotificationToast.svelte';
  import PseudoGate from '$lib/components/PseudoGate.svelte';

  const logger = createLogger('AppLayout');

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
      logger.error('Auth check failed:', error);
    } finally {
      userLoading.set(false);
    }
  });

  /**
   * The gate, and with it the inertness of everything behind it.
   *
   * A player whose pseudonym was assigned rather than chosen has not answered
   * yet. The server refuses their routes and their socket regardless; this is
   * what puts the question in front of them.
   */
  $: needsPseudo = !!$user?.needsPseudo;

  // Initialize socket when user logs in, disconnect when user logs out.
  // Held back while the gate is up: the server disconnects such a socket on
  // sight, so opening one would be a reconnect loop with nothing to show for
  // it.
  $: {
    if ($user && !needsPseudo && !socketInitialized && !$userLoading) {
      // User is logged in and socket not initialized
      initializeSocket();
      socketInitialized = true;
      // Only once signed in: the ingest endpoint requires a session, and
      // there is nothing worth collecting from a logged-out visitor.
      startLogShipping({ app: 'psnes-frontend' });
    } else if (!$user && socketInitialized) {
      // User logged out, clean up socket
      if ($socket) {
        $socket.disconnect();
        socket.set(null);
      }
      socketInitialized = false;
      // A deliberate logout drives the socket to 'offline', not
      // 'reconnecting' - but the banner is about to be hidden by the $user
      // guard below anyway, so reset to the default rather than leave a
      // stale state behind for the next login.
      linkState.set('connected');
    }
  }
</script>

<!--
  `inert` is the native attribute, not a hand-rolled focus trap: it takes the
  whole subtree out of the tab order, out of pointer events and out of the
  accessibility tree at once. A manual trap is defeated by the first autofocus
  somebody adds without thinking about this screen.
-->
<div class="app" inert={needsPseudo}>
  {#if $user && $linkState === 'reconnecting'}
    <div class="link-banner" role="status">Connection lost — reconnecting…</div>
  {:else if $user && $linkState === 'offline'}
    <div class="link-banner" role="status">Connection lost — reload the page to continue.</div>
  {/if}
  <slot />
</div>

<!--
  Mounted once, here, because a toast has to outlive the screen that raised it:
  the pause menu unmounts the moment a save is deleted or the shortcut fires.

  Both the store and this component already existed and neither was used
  anywhere - the pause menu has been dispatching notifications into nothing.
  Deleting a save and quick-saving both need to say so, which is what finally
  made the wiring worth doing.
-->
<NotificationToast />

{#if needsPseudo}
  <PseudoGate />
{/if}

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

  :global(:fullscreen) {
    cursor: none;
  }

  .link-banner {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    z-index: 1000;
    padding: 0.5rem 1rem;
    text-align: center;
    font-size: 0.9rem;
    background: rgba(150, 75, 0, 0.95);
    color: #fff;
  }
</style>
