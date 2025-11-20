<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { user } from '$lib/stores/user';
  import P2PRoom from '$lib/components/P2PRoom.svelte';

  // Accept props from SvelteKit (even if unused)
  export let data: any = {};
  export let params: any = {};

  let isHost = true;
  let roomId = 'test-room-' + Math.random().toString(36).substr(2, 9);
  let gameId = '';
  let games: any[] = [];
  let selectedGameId = '';
  let started = false;
  let keyConfig: any = null;
  let settingsLoaded = false;

  // Load settings from local storage
  function loadSettings() {
    if (typeof localStorage !== 'undefined') {
      const savedIsHost = localStorage.getItem('p2p-test-isHost');
      const savedRoomId = localStorage.getItem('p2p-test-roomId');
      const savedGameId = localStorage.getItem('p2p-test-gameId');

      if (savedIsHost !== null) {
        isHost = savedIsHost === 'true';
      }
      if (savedRoomId) {
        roomId = savedRoomId;
      }
      if (savedGameId) {
        selectedGameId = savedGameId;
      }
    }
    settingsLoaded = true;
  }

  // Save settings to local storage
  function saveSettings() {
    if (settingsLoaded && typeof localStorage !== 'undefined') {
      localStorage.setItem('p2p-test-isHost', String(isHost));
      localStorage.setItem('p2p-test-roomId', roomId);
      localStorage.setItem('p2p-test-gameId', selectedGameId);
    }
  }

  // Save whenever settings change (after initial load)
  $: if (isHost !== undefined) saveSettings();
  $: if (roomId) saveSettings();
  $: if (selectedGameId) saveSettings();

  async function loadKeyConfig() {
    try {
      const response = await fetch('/api/user/controls', { credentials: 'include' });
      if (response.ok) {
        keyConfig = await response.json();
        console.log('✅ Loaded user key config:', keyConfig);
      } else {
        // Fallback to default if API fails
        console.warn('⚠️ Using default key config tout pourri');
        keyConfig = getDefaultKeyConfig();
      }
    } catch (error) {
      console.error('Failed to load key config:', error);
      keyConfig = getDefaultKeyConfig();
    }
  }

  function getDefaultKeyConfig() {
    return {
      up: 'ArrowUp',
      down: 'ArrowDown',
      left: 'ArrowLeft',
      right: 'ArrowRight',
      a: 'KeyX',
      b: 'KeyZ',
      x: 'KeyS',
      y: 'KeyA',
      l: 'KeyQ',
      r: 'KeyW',
      start: 'Enter',
      select: 'ShiftRight',
    };
  }

  async function loadGames() {
    try {
      const response = await fetch('/api/games', { credentials: 'include' });
      if (response.ok) {
        games = await response.json();
        // Only set default if no game is already selected (from localStorage or otherwise)
        if (games.length > 0 && !selectedGameId) {
          selectedGameId = games[0].id;
        }
      }
    } catch (error) {
      console.error('Failed to load games:', error);
    }
  }

  function startTest() {
    if (!selectedGameId) {
      alert('Please select a game first');
      return;
    }
    gameId = selectedGameId;
    started = true;
  }

  onMount(async () => {
    // Skip auth check for POC testing
    // if (!$user) {
    //   goto('/');
    //   return;
    // }
    loadSettings();
    await loadKeyConfig();
    await loadGames();
  });
</script>

<svelte:head>
  <title>P2P Emulation Test - PSNES</title>
</svelte:head>

{#if !started}
  <div class="setup-screen">
    <div class="setup-container">
      <h1>🎮 P2P Emulation Test</h1>
      <p class="subtitle">Test client-side emulation with WebRTC P2P</p>

      <div class="setup-form">
        <div class="form-group">
          <label>
            <strong>Role:</strong>
            <select bind:value={isHost}>
              <option value={true}>👑 Host (Run emulator)</option>
              <option value={false}>🎮 Guest (Receive stream)</option>
            </select>
          </label>
        </div>

        <div class="form-group">
          <label>
            <strong>Room ID:</strong>
            <input type="text" bind:value={roomId} placeholder="test-room-123" />
          </label>
          <p class="hint">Share this room ID with other players</p>
        </div>

        <div class="form-group">
          <label>
            <strong>Game:</strong>
            <select bind:value={selectedGameId}>
              {#each games as game}
                <option value={game.id}>
                  {game.name || game.title || game.fileName || `Game ${game.id}`}
                </option>
              {/each}
            </select>
          </label>
        </div>

        <button on:click={startTest} class="start-button">
          {isHost ? 'Start as Host' : 'Join as Guest'}
        </button>
      </div>

      <div class="info-box">
        <h3>How it works:</h3>
        <ul>
          <li><strong>Host:</strong> Runs SNES emulator in browser, streams to guests via WebRTC P2P</li>
          <li><strong>Guest:</strong> Receives video/audio stream, sends controller input back</li>
          <li><strong>No server CPU:</strong> Emulation runs on host's device, not VPS</li>
          <li><strong>Low latency:</strong> Direct P2P connection (15-30ms)</li>
        </ul>
      </div>
    </div>
  </div>
{:else if keyConfig}
  <P2PRoom
    {roomId}
    {gameId}
    {isHost}
    {keyConfig}
  />
{:else}
  <div class="loading">Loading...</div>
{/if}

<style>
  .setup-screen {
    min-height: 100vh;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    display: flex;
    justify-content: center;
    align-items: center;
    padding: 2rem;
  }

  .setup-container {
    background: white;
    border-radius: 20px;
    padding: 3rem;
    max-width: 600px;
    width: 100%;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
  }

  h1 {
    margin: 0 0 0.5rem 0;
    color: #333;
    text-align: center;
  }

  .subtitle {
    text-align: center;
    color: #666;
    margin: 0 0 2rem 0;
  }

  .setup-form {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
  }

  .form-group {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .form-group label {
    color: #333;
  }

  .form-group input,
  .form-group select {
    padding: 0.75rem;
    border: 2px solid #ddd;
    border-radius: 8px;
    font-size: 1rem;
    font-family: inherit;
  }

  .form-group input:focus,
  .form-group select:focus {
    outline: none;
    border-color: #667eea;
  }

  .hint {
    font-size: 0.85rem;
    color: #999;
    margin: 0;
  }

  .start-button {
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    color: white;
    border: none;
    padding: 1rem 2rem;
    border-radius: 10px;
    font-size: 1.1rem;
    font-weight: bold;
    cursor: pointer;
    transition: transform 0.2s;
    margin-top: 1rem;
  }

  .start-button:hover {
    transform: translateY(-2px);
  }

  .info-box {
    margin-top: 2rem;
    padding: 1.5rem;
    background: #f5f5f5;
    border-radius: 10px;
  }

  .info-box h3 {
    margin: 0 0 1rem 0;
    color: #333;
  }

  .info-box ul {
    margin: 0;
    padding-left: 1.5rem;
    color: #666;
  }

  .info-box li {
    margin-bottom: 0.5rem;
  }

  .loading {
    display: flex;
    justify-content: center;
    align-items: center;
    min-height: 100vh;
    color: white;
    font-size: 1.5rem;
  }
</style>
