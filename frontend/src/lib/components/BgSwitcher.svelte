<script lang="ts">
  /**
   * Le sélecteur des fonds proposés, le temps que l'opérateur choisisse.
   *
   * Flottant, en bas à droite, et repliable : il ne doit rien cacher de ce
   * qu'il sert à juger. Le choix va dans l'adresse (`?bg=`), donc un lien
   * copié montre le même fond.
   */
  import { WALLS, WALL_NAMES, chooseWall, wall } from '$lib/bedroom/choice';

  let open = true;
</script>

<div class="switcher" class:open role="group" aria-label="Fond de la bibliothèque">
  <button class="toggle" on:click={() => (open = !open)} aria-expanded={open} title={open ? 'Replier' : 'Changer de fond'}>
    Fond
  </button>
  {#if open}
    {#each WALLS as id}
      <button
        class="choice"
        class:on={$wall === id}
        aria-pressed={$wall === id}
        title={WALL_NAMES[id]}
        on:click={() => chooseWall(id)}
      >
        {id === 'current' ? 'Actuel' : id.toUpperCase()}
      </button>
    {/each}
    <span class="name">{WALL_NAMES[$wall]}</span>
  {/if}
</div>

<style>
  .switcher {
    position: fixed;
    right: 12px;
    bottom: 12px;
    z-index: 1500;
    display: flex;
    align-items: center;
    gap: 6px;
    max-width: calc(100vw - 24px);
    padding: 6px;
    background: var(--panel);
    border: 3px solid var(--edge);
    border-radius: 12px;
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.4);
  }

  @media (max-width: 560px) {
    .name { display: none; }
  }

  .switcher button {
    font-size: 0.95rem;
    padding: 0.2rem 0.6rem;
    border-width: 2px;
  }

  .toggle {
    background: var(--ground);
  }

  .choice.on {
    background: var(--edge);
    color: var(--panel);
  }

  .name {
    font-family: var(--display);
    font-size: 0.95rem;
    color: var(--label);
    padding: 0 4px 2px;
  }
</style>
