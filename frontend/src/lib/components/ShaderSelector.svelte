<script lang="ts" context="module">
  // Available shaders from libretro/glsl-shaders repository.
  //
  // This list is the single source of truth for both rendering paths: the
  // RetroArch stack and the lockstep WebGL renderer both read it, so removing
  // an entry here removes it from every mode at once.
  //
  // Two are deliberately absent:
  // - xbrz-freescale, because its viewport-based scaling causes WebGL
  //   framebuffer errors in the WASM emulator.
  // - crt-easymode, dropped on the owner's call. It also happened to be the
  //   preset most damaged by the lockstep renderer's final pass running at
  //   source size rather than at the viewport: at 1:1 its scanline term
  //   evaluates to a constant, so the scanlines vanished entirely.
  export const SHADERS = [
    { id: '', name: 'shaderNone' as const },
    { id: 'xbrz/6xbrz-linear', name: 'shaderXbrz6x' as const },
    { id: 'xbrz/5xbrz-linear', name: 'shaderXbrz5x' as const },
    { id: 'xbrz/4xbrz-linear', name: 'shaderXbrz4x' as const },
    { id: 'interpolation/sharp-bilinear-simple', name: 'shaderSharpBilinear' as const },
    { id: 'anti-aliasing/fxaa', name: 'shaderFxaa' as const },
  ] as const;

  export const VALID_SHADER_IDS: readonly string[] = SHADERS.map(s => s.id);
</script>

<script lang="ts">
  import { createEventDispatcher, onMount } from 'svelte';
  import { language } from '$lib/stores/language';
  import { t } from '$lib/i18n/translations';

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
