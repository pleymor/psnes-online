<script lang="ts">
  import { socket } from '$lib/api/socket';
  import { user } from '$lib/stores/user';
  import { language } from '$lib/stores/language';
  import { t } from '$lib/i18n/translations';

  export let room: any;
  export let roomId: string;

  $: player1 = room?.players?.find((p: any) => p.port === 1);
  $: player2 = room?.players?.find((p: any) => p.port === 2);
  $: currentPlayer = room?.players?.find((p: any) => p.userId === $user?.id);
  $: currentPlayerPort = currentPlayer?.port;
  $: player1IsHost = Boolean(player1) && player1.userId === room?.hostId;
  $: player2IsHost = Boolean(player2) && player2.userId === room?.hostId;

  // Check if only 1 player in the room (single-player mode)
  $: isSinglePlayer = room?.players?.length === 1;

  /**
   * What clicking a slot would actually do, as a sentence.
   *
   * Rendered rather than left to a hover state: the slots are buttons, but
   * they read as status cards, and on a touch screen there is no hover to
   * discover them with. The occupied case names the swap because the server
   * really does move the other player to the free port - nobody guesses that,
   * and finding it out by accident is unsettling.
   */
  function slotAction(port: 1 | 2, occupant: any): string | null {
    if (isSinglePlayer && port === 2) return null;
    if (currentPlayerPort === port) return null;
    if (occupant && occupant.userId !== $user?.id) {
      return t($language, 'swapWithPlayer', { name: occupant.displayName });
    }
    return t($language, 'takeThisController');
  }

  $: player1Action = slotAction(1, player1);
  $: player2Action = slotAction(2, player2);

  function handlePortClick(port: 1 | 2) {
    // In single-player mode, controller 2 is disabled
    if (isSinglePlayer && port === 2) {
      return;
    }

    // If already on this port, do nothing (no unselecting)
    if (currentPlayerPort === port) {
      return;
    }

    // Select/switch to that port
    $socket?.emit('room:selectPort', { roomId, port });
  }
</script>

<p class="players-hint">{t($language, 'chooseYourController')}</p>

<div class="players">
  <button
    class="player"
    class:mine={player1?.userId === $user?.id}
    aria-pressed={currentPlayerPort === 1}
    class:occupied={player1 && player1?.userId !== $user?.id}
    on:click={() => handlePortClick(1)}
  >
    <span class="port-label">{t($language, 'player1')}</span>
    {#if player1?.avatar}
      <img src={player1.avatar} alt="" class="avatar" />
    {/if}
    <span class="player-name">{player1?.displayName || '—'}</span>
    {#if player1 && player1.online !== true}
      <span class="player-away">{t($language, 'playerAway')}</span>
    {/if}
    {#if player1IsHost}
      <span class="host-note">{t($language, 'hostSavesNote')}</span>
    {/if}
    {#if player1Action}
      <span class="slot-action">{player1Action}</span>
    {/if}
  </button>

  <button
    class="player"
    class:mine={player2?.userId === $user?.id}
    aria-pressed={currentPlayerPort === 2}
    class:occupied={player2 && player2?.userId !== $user?.id}
    class:disabled={isSinglePlayer}
    disabled={isSinglePlayer}
    on:click={() => handlePortClick(2)}
  >
    <span class="port-label">{t($language, 'player2')}</span>
    {#if player2?.avatar}
      <img src={player2.avatar} alt="" class="avatar" />
    {/if}
    <span class="player-name">{player2?.displayName || '—'}</span>
    {#if player2 && player2.online !== true}
      <span class="player-away">{t($language, 'playerAway')}</span>
    {/if}
    {#if player2IsHost}
      <span class="host-note">{t($language, 'hostSavesNote')}</span>
    {/if}
    {#if player2Action}
      <span class="slot-action">{player2Action}</span>
    {/if}
  </button>
</div>

<style>
  /* Information, not an alarm: the seat is still theirs and they are expected
     back, so this says where they are without shouting about it. */
  .player-away {
    font-size: 0.8rem;
    opacity: 0.6;
    font-style: italic;
  }

  /**
   * Two columns of equal width, whatever is written in them.
   *
   * These were flex items sized by their content, and only one of them is the
   * host - so "Host - saves live on their account" (longer still in French) sat
   * on one line and made that card visibly wider than its neighbour. The action
   * line does it too, since "Swap with <name>" carries a name and "Take this
   * controller" does not.
   *
   * `minmax(0, 1fr)` rather than `1fr` is what actually fixes it: a bare `1fr`
   * means `minmax(auto, 1fr)`, and that `auto` floor lets the content push the
   * column wider again. With zero, the columns are equal by construction and
   * the sentence wraps instead.
   */
  .players {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 2rem;
    max-width: 520px;
    margin: 1rem auto;
  }

  .player {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1rem;
    padding: 1.5rem 2rem;
    background: #2a2a2a;
    border: 2px solid #444;
    border-radius: 12px;
    color: #888;
    font-size: 1rem;
    cursor: pointer;
    transition: all 0.2s;
    /* A display name with no spaces would otherwise be an unbreakable line and
       widen its column past the other's, which is the whole thing being fixed. */
    overflow-wrap: anywhere;
  }

  .player:hover:not(:disabled) {
    border-color: #667eea;
    color: #fff;
  }

  .player.mine {
    border-color: #667eea;
    background: rgba(102, 126, 234, 0.15);
    color: #fff;
  }

  .player.occupied {
    border-color: #4caf50;
    color: #fff;
  }

  .player:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .players-hint {
    margin: 0.5rem 0 0;
    text-align: center;
    color: #9aa0b4;
    font-size: 0.85rem;
  }

  /* Always on screen, never hover-only: a hover affordance does not exist on
     a touch screen, which is where this was least discoverable. */
  .slot-action {
    font-size: 0.8rem;
    color: #667eea;
  }

  .player:hover:not(:disabled) .slot-action {
    color: #8fa2ff;
  }

  .port-label {
    font-weight: 700;
    font-size: 1rem;
    padding: 0.35rem 0.75rem;
    background: #444;
    border-radius: 6px;
    color: #aaa;
  }

  .player.mine .port-label {
    background: #667eea;
    color: #fff;
  }

  .player.occupied .port-label {
    background: #4caf50;
    color: #fff;
  }

  .avatar {
    width: 48px;
    height: 48px;
    border-radius: 50%;
    object-fit: cover;
  }

  .player-name {
    font-weight: 600;
    font-size: 1.1rem;
  }

  /* Small on purpose: it names a consequence, not a status to react to. */
  .host-note {
    font-size: 0.7rem;
    color: #9aa0b4;
    text-align: center;
  }

  @media (max-width: 480px) {
    .players {
      grid-template-columns: 1fr;
    }
  }
</style>
