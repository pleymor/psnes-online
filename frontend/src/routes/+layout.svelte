<script lang="ts">
  import '$lib/polyfills'; // Load Node.js polyfills for browser
  import { onMount, onDestroy } from 'svelte';
  import { get } from 'svelte/store';
  import { goto } from '$app/navigation';
  import { user, userLoading } from '$lib/stores/user';
  import { socket, initializeSocket, waitForSocket } from '$lib/api/socket';
  import { startLogShipping } from '$lib/utils/log-shipper';
  import { createLogger } from '$lib/utils/logger';
  import { linkState } from '$lib/stores/connection';
  import { myRoom } from '$lib/rooms/my-room';
  import { inGame } from '$lib/stores/in-game';
  import { sharing } from '$lib/stores/sharing';
  import { vrActive } from '$lib/vr/entry';
  import NotificationToast from '$lib/components/NotificationToast.svelte';
  import InvitationCard from '$lib/components/InvitationCard.svelte';
  import ShareOffer from '$lib/components/ShareOffer.svelte';
  import PseudoGate from '$lib/components/PseudoGate.svelte';
  import VrShell from '$lib/components/VrShell.svelte';

  const logger = createLogger('AppLayout');

  let socketInitialized = false;

  onMount(async () => {
    // Check authentication
    try {
      // 200 with a null body when nobody is signed in - see the note on the
      // route. `user.set(null)` is then the same no-one the store started as.
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
   * The one place a `room:opened` is acted on.
   *
   * It means "go to this room's page", and it is the server's answer to a game
   * being chosen - by me, or by the other member of my group - and to an
   * invitation accepted into a room that already has a game. It lives here
   * rather than on a page because the whole point is that it reaches a player
   * who is looking at something else.
   *
   * `?from=invitation` is rebuilt from `reason`: the room screen uses it to say
   * so when it lands in a match that is already running.
   */
  function handleRoomOpened({ roomId, reason }: { roomId: string; reason?: string }) {
    if (!roomId) return;
    /*
     * Not while a headset is presenting.
     *
     * A solo launch from VR cannot reach here - `room:opened` is emitted by
     * `room:choose-game` (`websocket/room-handlers.ts:237`), not by
     * `room:create`. But `openRoomForMembers` addresses every member of the
     * room, "both members go, including the one who just chose", so a player
     * who joined a group before putting the headset on would be navigated by
     * their partner's choice - mounting a whole second emulator underneath a
     * session they are still playing in.
     */
    if (get(vrActive)) return;
    const query = reason === 'invitation' ? '?from=invitation' : '';
    void goto(`/room/${roomId}${query}`);
  }

  /**
   * Le partage, écouté ici et pas dans la bibliothèque.
   *
   * Une offre doit atteindre le joueur là où il est - la page de profil, la
   * documentation - exactement l'argument qui a mis `InvitationCard` dans ce
   * layout. `roms/sharing.ts` porte la règle ; ceci ne fait que brancher la
   * socket dessus.
   */
  const share = sharing();

  function onShareOffered(offer: { roomId: string; crc32: string; title: string; from: string }) {
    if (!offer?.roomId || !offer.crc32) return;
    /*
     * Plus de recoupement avec `myRoom`.
     *
     * Il y en avait un, et c'était une façon de perdre le message sans rien
     * gagner : le serveur valide l'appartenance au salon avant de relayer
     * l'offre, et `my-room.ts` ignore délibérément `room:updated`, donc le
     * store local peut être en retard sur ce que le serveur sait déjà. Le
     * 2026-09-10, « l'ami ne voit jamais de message » a été indécidable
     * précisément parce que ce rejet ne disait rien.
     *
     * Journalisé à l'arrivée : les journaux du client remontent au backend,
     * donc la prochaine offre dira elle-même si elle est arrivée jusqu'ici.
     */
    logger.info('a friend offered a game', { crc32: offer.crc32, room: offer.roomId });
    // La décision est journalisée, pas devinée. Le 2026-09-10 j'ai conclu
    // « il a déjà le jeu » d'un refus sans raison, et c'était faux : la
    // preuve ne distinguait pas ce cas d'un « non merci ». Une ligne ici et
    // la question ne se repose plus.
    void share
      .offerReceived(offer)
      .then((decision) => logger.info('the offer was', { decision }))
      .catch((err) => logger.error('the offer could not be handled', err));
  }

  function onShareRequested(data: { roomId: string; from: string; crc32?: string }) {
    // Sans `crc32` c'est une demande de partie, et une salle s'en occupe déjà.
    if (!data?.crc32) return;
    // Et seulement hors salon : dans une partie, `LockstepRoom` répond, avec
    // ses octets déjà chargés et son garde contre les doubles envois.
    if (get(inGame)) return;
    void share.requested(data.from, data.crc32);
  }

  function onShareDeclined(data: { roomId: string; reason?: string }) {
    // Le relais ne l'envoie qu'à un membre du salon concerné ; le recouper
    // ici ne pourrait que le perdre.
    logger.info('the offer came back', { reason: data?.reason ?? 'declined' });
    share.declined(data?.reason ?? null);
  }

  const shareOffered = share.offered;

  /** Le pseudo de celui qui offre : le relais donne un identifiant, pas un nom. */
  $: offeringFriend =
    $myRoom?.players?.find((p) => p.userId === $shareOffered?.from)?.pseudo ?? '';

  /** Held so `onDestroy` can take the listener off the shared socket. */
  let navigator: Awaited<ReturnType<typeof waitForSocket>> = null;

  onMount(async () => {
    navigator = await waitForSocket();
    navigator?.on('room:opened', handleRoomOpened);
    navigator?.on('rom:offer', onShareOffered);
    navigator?.on('rom:request', onShareRequested);
    navigator?.on('rom:offer-declined', onShareDeclined);
  });

  onDestroy(() => {
    navigator?.off('room:opened', handleRoomOpened);
    navigator?.off('rom:offer', onShareOffered);
    navigator?.off('rom:request', onShareRequested);
    navigator?.off('rom:offer-declined', onShareDeclined);
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
      //
      // Et seulement avec un compte : /api/logs est derrière requirePseudo,
      // qui répond 403 à une session anonyme. L'expédition tournerait en
      // refus, ce qui remplit la console d'erreurs au lieu du journal.
      if (!$user.isAnonymous) startLogShipping({ app: 'psnes-frontend' });
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
  {:else if $user && $linkState === 'unreachable'}
    <!--
      Deliberately not "connection lost": this player never had one. The two
      messages above sent the last person to hit this looking for a fault in
      their friends list instead of in their own browser, so this one names the
      symptom they are actually looking at.
    -->
    <div class="link-banner" role="alert">
      Can't reach the game server — friends will show as offline and invitations
      won't arrive. An ad blocker, an antivirus scanning HTTPS, or a restricted
      network can block the connection.
    </div>
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

<!--
  Mounted here rather than in the top bar: an invitation that arrived while the
  player was in a lobby, on their profile or on a room screen used to appear
  nowhere at all.

  The bar reaches all three signed-in pages now - it said "only two" here for
  long enough that the drift was itself worth noticing - but it is still absent
  from the signed-out landing and from a running game, and it disappears the
  moment a room goes fullscreen. The layout is the only place that is on screen
  whatever the player is doing.
-->
<InvitationCard />
<ShareOffer sharing={share} fromName={offeringFriend} />

<!-- Above the <slot />, so a navigation underneath cannot unmount a running
     session. See the component's own header. -->
<VrShell />

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
    /* See the note on .room-container: 100vh is taller than the visible window
       on a phone whose address bar is showing. */
    min-height: 100vh;
    min-height: 100dvh;
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
