<script lang="ts">
  import { user } from '$lib/stores/user';
  import { goto } from '$app/navigation';

  // Accept params prop from SvelteKit (unused but prevents warnings)
  export let params = {};

  function login() {
    window.location.href = '/auth/google';
  }

  async function logout() {
    await fetch('/auth/logout', {
      method: 'POST',
      credentials: 'include'
    });
    user.set(null);
    goto('/');
  }
</script>

{#if $user}
  <nav class="menu">
    <div class="menu-content">
      <h2>🎮 PSNES Online</h2>
      <div class="menu-actions">
        <a href="/library" class="btn-library">
          Bibliothèque
        </a>
        <button on:click={logout} class="btn-logout">
          Déconnexion
        </button>
      </div>
    </div>
  </nav>
{/if}

<div class="container">
  <div class="hero">
    <h1>🎮 PSNES Online</h1>
    <p>Play classic SNES games with your friends</p>

    <div class="legal-disclaimer">
      <p><strong>⚠️ Legal Warning / Avertissement Légal</strong></p>
      <p><strong>🇬🇧</strong> This platform is provided for educational and preservation purposes. You must legally own the games for which you use ROMs. Using ROMs without owning the original games is illegal. By using this service, you agree to be solely responsible for complying with intellectual property laws.</p>
      <p><strong>🇫🇷</strong> Cette plateforme est fournie à des fins éducatives et de préservation. Vous devez posséder légalement les jeux dont vous utilisez les ROMs. L'utilisation de ROMs sans posséder les jeux originaux est illégale. En utilisant ce service, vous acceptez d'être seul responsable du respect des lois sur la propriété intellectuelle.</p>
    </div>

    {#if !$user}
      <button on:click={login} class="login-btn">
        Sign in with Google
      </button>
    {:else}
      <p class="welcome">Bienvenue {$user.displayName}!</p>
      <a href="/library" class="library-link">
        Accéder à ma bibliothèque →
      </a>
    {/if}
  </div>
</div>

<style>
  .menu {
    background: rgba(30, 30, 30, 0.95);
    border-bottom: 1px solid rgba(255, 255, 255, 0.1);
    padding: 1rem 2rem;
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    z-index: 1000;
    backdrop-filter: blur(10px);
  }

  .menu-content {
    max-width: 1400px;
    margin: 0 auto;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .menu h2 {
    font-size: 1.5rem;
    margin: 0;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
  }

  .menu-actions {
    display: flex;
    gap: 1rem;
  }

  .btn-library {
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    color: white;
    text-decoration: none;
    padding: 0.75rem 1.5rem;
    border-radius: 8px;
    font-size: 1rem;
    transition: transform 0.2s;
    display: inline-block;
  }

  .btn-library:hover {
    transform: translateY(-2px);
  }

  .btn-logout {
    background: #333;
    color: white;
    border: none;
    padding: 0.75rem 1.5rem;
    border-radius: 8px;
    cursor: pointer;
    font-size: 1rem;
    transition: background 0.2s;
  }

  .btn-logout:hover {
    background: #444;
  }

  .container {
    display: flex;
    justify-content: center;
    align-items: center;
    min-height: 100vh;
    padding: 2rem;
    padding-top: 5rem;
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

  .legal-disclaimer {
    background: rgba(255, 152, 0, 0.1);
    border: 1px solid rgba(255, 152, 0, 0.3);
    border-radius: 8px;
    padding: 1.25rem;
    margin: 2rem 0;
    max-width: 700px;
  }

  .legal-disclaimer p {
    font-size: 0.875rem;
    color: #ddd;
    margin-bottom: 0.75rem;
    line-height: 1.6;
    text-align: left;
  }

  .legal-disclaimer p:first-child {
    text-align: center;
    font-size: 1rem;
  }

  .legal-disclaimer p:last-child {
    margin-bottom: 0;
  }

  .legal-disclaimer strong {
    color: #ff9800;
    font-size: 1rem;
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

  .welcome {
    font-size: 1.5rem;
    color: #fff;
    margin-bottom: 1.5rem;
  }

  .library-link {
    display: inline-block;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    color: white;
    text-decoration: none;
    padding: 1rem 2rem;
    font-size: 1.125rem;
    border-radius: 8px;
    transition: transform 0.2s;
  }

  .library-link:hover {
    transform: translateY(-2px);
  }
</style>
