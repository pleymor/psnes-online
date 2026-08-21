<script lang="ts">
  import { createEventDispatcher, onMount } from 'svelte';
  import { language } from '$lib/stores/language';
  import { t } from '$lib/i18n/translations';
  import { SHADERS } from '$lib/shaders';

  export let currentShader: string = '';

  const dispatch = createEventDispatcher();
  let selectedShader = currentShader;

  function selectShader(shaderId: string) {
    selectedShader = shaderId;
    dispatch('select', { shader: shaderId });
  }

  onMount(() => {
    selectedShader = currentShader;
  });
</script>

<div class="shader-selector">
  <h4>{t($language, 'shader')}</h4>

  <div class="shader-list">
    {#each SHADERS as shader}
      <button
        class="shader-option"
        class:selected={selectedShader === shader.id}
        on:click={() => selectShader(shader.id)}
      >
        <span class="shader-name">{t($language, shader.name)}</span>
        {#if selectedShader === shader.id}
          <span class="check-mark">✓</span>
        {/if}
      </button>
    {/each}
  </div>

</div>

<style>
  .shader-selector {
    padding: 0.5rem 0;
  }

  h4 {
    margin: 0 0 1rem 0;
    color: #fff;
    font-size: 1rem;
  }

  .shader-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .shader-option {
    display: flex;
    justify-content: space-between;
    align-items: center;
    background: #333;
    border: 2px solid transparent;
    padding: 0.75rem 1rem;
    border-radius: 6px;
    cursor: pointer;
    transition: all 0.2s;
    text-align: left;
    color: #fff;
  }

  .shader-option:hover {
    background: #444;
    border-color: #555;
  }

  .shader-option.selected {
    background: #3a4a5a;
    border-color: #667eea;
  }

  .shader-name {
    font-size: 0.95rem;
  }

  .check-mark {
    color: #667eea;
    font-size: 1.1rem;
    font-weight: bold;
  }
</style>
