<script lang="ts">
  import { user } from '$lib/stores/user';
  import { goto } from '$app/navigation';
  import { onMount } from 'svelte';

  // Accept params prop from SvelteKit (unused but prevents warnings)
  export let params = {};

  onMount(() => {
    if ($user) {
      goto('/library');
    }
  });

  function login() {
    window.location.href = '/auth/google';
  }
</script>

<div class="container">
  <div class="hero">
    <h1>🎮 PSNES Online</h1>
    <p>Play classic SNES games with your friends</p>

    {#if !$user}
      <button on:click={login} class="login-btn">
        Sign in with Google
      </button>
    {/if}
  </div>
</div>

<style>
  .container {
    display: flex;
    justify-content: center;
    align-items: center;
    min-height: 100vh;
    padding: 2rem;
  }

  .hero {
    text-align: center;
    max-width: 600px;
  }

  h1 {
    font-size: 3rem;
    margin-bottom: 1rem;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
  }

  p {
    font-size: 1.25rem;
    color: #a0a0a0;
    margin-bottom: 2rem;
  }

  .login-btn {
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    color: white;
    border: none;
    padding: 1rem 2rem;
    font-size: 1.125rem;
    border-radius: 8px;
    cursor: pointer;
    transition: transform 0.2s;
  }

  .login-btn:hover {
    transform: translateY(-2px);
  }
</style>
