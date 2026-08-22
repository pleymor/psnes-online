<script lang="ts">
  import { socket } from '$lib/api/socket';
  import { user } from '$lib/stores/user';
  import { language } from '$lib/stores/language';
  import { t } from '$lib/i18n/translations';
  import type { RomAvailability } from '$lib/types';

  export let room: any;
  export let roomId: string;
  /**
   * Who has the room's ROM, keyed by user id, as the server worked it out.
   *
   * A map rather than a field on `room` because the two arrive on different
   * events - see the room page, which owns it. A player with no entry has not
   * been described yet, which is not the same as `unknown`: `unknown` is the
   * server saying there is nothing to compare. No entry means no badge.
   */
  export let rom: Map<string, RomAvailability> = new Map();

  $: player1 = room?.players?.find((p: any) => p.port === 1);
  $: player2 = room?.players?.find((p: any) => p.port === 2);
  $: currentPlayer = room?.players?.find((p: any) => p.userId === $user?.id);
  $: currentPlayerPort = currentPlayer?.port;

  // Nothing to have before a game is picked, so no badge until there is one.
  $: gameChosen = Boolean(room?.gameId);
  $: player1Rom = player1 ? rom.get(player1.userId) : undefined;
  $: player2Rom = player2 ? rom.get(player2.userId) : undefined;

  // Check if only 1 player in the room (single-player mode)
  $: isSinglePlayer = room?.players?.length === 1;

  /**
   * Three states, three labels - and `unknown` is not a quieter `missing`.
   *
   * `missing` says the server looked and this player does not have the ROM.
   * `unknown` says the chosen game carries no checksum, so there was nothing to
   * look for; claiming they do not have it would be a lie the server never told.
   */
  const romLabels = { has: 'romHas', missing: 'romMissing', unknown: 'romUnknown' } as const;
  const romMarks = { has: '✓', missing: '✗', unknown: '?' } as const;

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
    {#if gameChosen && player1Rom}
      <span class="rom rom-{player1Rom}" title={player1Rom === 'unknown' ? t($language, 'romUnknownHint') : ''}>
        <span aria-hidden="true">{romMarks[player1Rom]}</span>
        {t($language, romLabels[player1Rom])}
      </span>
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
    {#if gameChosen && player2Rom}
      <span class="rom rom-{player2Rom}" title={player2Rom === 'unknown' ? t($language, 'romUnknownHint') : ''}>
        <span aria-hidden="true">{romMarks[player2Rom]}</span>
        {t($language, romLabels[player2Rom])}
      </span>
    {/if}
    {#if player2Action}
      <span class="slot-action">{player2Action}</span>
    {/if}
  </button>
</div>

<style>
  .players {
    display: flex;
    gap: 2rem;
    justify-content: center;
    margin: 1rem 0;
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
    min-width: 180px;
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

  .rom {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    font-size: 0.75rem;
    font-weight: 600;
    padding: 0.2rem 0.55rem;
    border-radius: 999px;
    border: 1px solid transparent;
  }

  .rom-has {
    background: rgba(76, 175, 80, 0.15);
    border-color: rgba(76, 175, 80, 0.5);
    color: #7bd47f;
  }

  .rom-missing {
    background: rgba(244, 67, 54, 0.15);
    border-color: rgba(244, 67, 54, 0.5);
    color: #f08a80;
  }

  /* Deliberately neither green nor red: "we cannot tell" is its own answer, and
     dressing it in the missing colours would read as "does not have it". */
  .rom-unknown {
    background: rgba(255, 255, 255, 0.05);
    border-color: #55556b;
    color: #a5a5bd;
    font-style: italic;
    cursor: help;
  }

  @media (max-width: 480px) {
    .players {
      flex-direction: column;
      align-items: center;
    }
  }
</style>
