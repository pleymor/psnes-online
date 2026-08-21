# Thin Top Bar and Profile Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the permanent sidebar with a thin top bar and a `/profile` page, so that settings live on a page instead of in a navigation menu, friends are consulted on demand instead of always shown, and ROMs are configured once by folder instead of added game by game.

**Architecture:** Two pure functions carry the only logic that can be wrong invisibly — which form the ROM panel takes, and reading the stored shader preference — and both are unit-tested. Everything else is rehousing existing components: `ControlsSettings`, `LanguageSelector` and `FriendsList` change container, not content. The `AddGames` modal is deleted and its folder path becomes a panel on the profile page.

**Tech Stack:** SvelteKit 4 (Svelte 4 reactivity rules apply), TypeScript, `node --import tsx --test`.

**Spec:** `docs/superpowers/specs/2026-08-21-profile-and-top-bar-design.md` — read it before Task 1. This is the first of five pieces; the plan argues from the spec and the spec wins where they differ.

## Global Constraints

- **The signed-out landing page keeps its own `LanguageSelector`.** The top bar exists only when signed in, and the profile page is unreachable signed out — so removing it would leave someone who reads neither language with no way to change it. Verified by hand in Task 6.
- **The ROM panel has two forms and the fallback appears only where it is needed.** Folder selection is gated on `'showDirectoryPicker' in window` (`local-library.ts:30`), which is Chromium-only. Dropping the single-file path would leave Firefox and Safari with a permanently empty library and no recourse.
- **Neither the profile page nor the pause menu owns the display setting.** `localStorage` owns it, under the key `psnes-shader`. Both read at mount and write on change; they never coexist on screen.
- **`FriendsList` and `ControlsSettings` are reused, not rewritten.** 875 and 715 lines that work. Refactoring them here would make this piece unreadable.
- **No avatar changing.** No API exists: the avatars router only serves files for reading, the user router only handles controls, and the avatar comes from Google. It is a separate, fifth piece.
- **No lobby, no controller picker, no lobby indicator.** Pieces B, C and D.
- **Two spaces** in `.svelte` files, **tabs** in `frontend/src/lib/**/*.ts`. **No new runtime dependencies.**
- **A new test file must be added to the `test:ui` script** in the root `package.json` — it lists its files explicitly, so an unlisted file silently never runs.
- Measured baseline: **204 tests passing** (37 netplay / 11 core / 90 ui / 66 backend), `npm run check --workspace frontend` at **0 errors, 19 warnings in 10 files**. `node` is not on the default PATH; prefix commands with `export PATH="$HOME/.nvm/versions/node/v20.19.6/bin:$PATH"`.

---

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `frontend/src/lib/roms/source-state.ts` | Which form the ROM panel takes, as a pure function over already-gathered facts. No IO. |
| `frontend/src/lib/stores/shader-preference.ts` | The single reader and writer for `psnes-shader`, validating against the known ids. |
| `frontend/src/lib/components/TopBar.svelte` | The thin bar: title, friends menu, avatar link. |
| `frontend/src/lib/components/RomSourcePanel.svelte` | The profile page's ROM section, in both its forms. |
| `frontend/src/routes/profile/+page.svelte` | The profile page and its sections. |
| `core/test/profile.test.ts` | Unit tests for both pure functions. |
| `docs/superpowers/verification/2026-08-21-profile-and-top-bar.md` | What was verified and what still needs a human. |

**Modified:**

| File | Change |
|---|---|
| `frontend/src/routes/+page.svelte` | Sidebar removed, `TopBar` added, `AddGames` entry points removed. |
| `frontend/src/lib/components/{SoloRoom,LockstepRoom,P2PRoom}.svelte` | Read the shader preference through the shared reader. |
| `package.json` | Register `core/test/profile.test.ts` in `test:ui`. |

**Deleted:**

| File | Why |
|---|---|
| `frontend/src/lib/components/AddGames.svelte` | Its folder path becomes `RomSourcePanel`; its single-file path moves there too; the modal itself has no reason to exist. |

**Task order and why:** the pure functions first, because they are the only testable part and everything consumes them. Then their adoption at the four existing call sites, so the shader reader has consumers immediately instead of being dead code for three tasks. Then the profile page, which needs both. Then the bar, which removes the sidebar. Then the deletion, last, because the sidebar removal takes one of `AddGames`' two entry points with it.

---

## Task 1: The two pure functions

**Files:**
- Create: `frontend/src/lib/roms/source-state.ts`
- Create: `frontend/src/lib/stores/shader-preference.ts`
- Create: `core/test/profile.test.ts`
- Modify: `package.json` (the `test:ui` script)

**Interfaces:**
- Consumes: `VALID_SHADER_IDS` from `frontend/src/lib/components/ShaderSelector.svelte` — a `readonly string[]` whose first entry is `''` for "no shader".
- Produces:
  - `type RomSourceState = { kind: 'folder'; name: string } | { kind: 'folder-stale'; name: string } | { kind: 'no-folder' } | { kind: 'unsupported' }`
  - `function romSourceState(facts: RomSourceFacts): RomSourceState`
  - `interface RomSourceFacts { supported: boolean; folderName?: string; accessGranted?: boolean }`
  - `function readShaderPreference(storage: PreferenceStorage): string`
  - `function writeShaderPreference(storage: PreferenceStorage, id: string): void`
  - `interface PreferenceStorage { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }`

### Why these two and nothing else

Almost all of this piece is interface, and interface is not testable in this repo — no browser harness. The lesson from the previous branch is that the untestable part must be **reduced**, not accepted; and that branch reduced the wrong thing, wrapping a pure class around six lines that were never in danger while leaving the risky code in a component.

These two are the parts that can be wrong without anyone seeing it. The panel's form decides whether two browsers can add a game at all. The preference reader is currently reimplemented at four call sites, and one of them had forgotten to purge a stale value until a review found it.

- [ ] **Step 1: Write the failing tests**

Create `core/test/profile.test.ts`:

```ts
/**
 * The two decisions behind the profile page that can be wrong invisibly.
 *
 * Everything else in that work is layout, which this repo cannot test. These
 * two are not: which form the ROM panel takes decides whether Firefox and
 * Safari can add a game at all, and the shader preference reader replaces four
 * hand-rolled copies, one of which had forgotten to purge a stale value.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { romSourceState } from '../../frontend/src/lib/roms/source-state.js';
import {
  readShaderPreference,
  writeShaderPreference
} from '../../frontend/src/lib/stores/shader-preference.js';

/** A storage that records what was done to it. */
function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    removed: [] as string[],
    getItem(key: string) {
      return data.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      data.set(key, value);
    },
    removeItem(key: string) {
      data.delete(key);
      this.removed.push(key);
    }
  };
}

test('a browser without the directory API is reported as unsupported', () => {
  // This is the case that decides whether Firefox and Safari can add a game.
  const state = romSourceState({ supported: false });

  assert.equal(state.kind, 'unsupported');
});

test('unsupported wins even if a folder name is somehow remembered', () => {
  // A handle stored by a previous browser, or a shared profile. The API is what
  // decides, not the leftover.
  const state = romSourceState({ supported: false, folderName: 'roms', accessGranted: true });

  assert.equal(state.kind, 'unsupported');
});

test('supported with no folder asks for one', () => {
  const state = romSourceState({ supported: true });

  assert.equal(state.kind, 'no-folder');
});

test('a folder with access is reported with its name', () => {
  const state = romSourceState({ supported: true, folderName: 'SNES', accessGranted: true });

  assert.deepEqual(state, { kind: 'folder', name: 'SNES' });
});

test('a folder whose permission has lapsed is distinguished from no folder at all', () => {
  // Different remedies: one needs a click to re-grant, the other needs a pick.
  // Collapsing them would tell the player to choose a folder they already chose.
  const state = romSourceState({ supported: true, folderName: 'SNES', accessGranted: false });

  assert.deepEqual(state, { kind: 'folder-stale', name: 'SNES' });
});

test('a folder name with no access flag is treated as stale, not granted', () => {
  // Absence of a yes is not a yes.
  const state = romSourceState({ supported: true, folderName: 'SNES' });

  assert.equal(state.kind, 'folder-stale');
});

test('a known shader id is read back', () => {
  const storage = fakeStorage({ 'psnes-shader': 'xbrz/6xbrz-linear' });

  assert.equal(readShaderPreference(storage), 'xbrz/6xbrz-linear');
});

test('no stored preference reads as no shader', () => {
  const storage = fakeStorage();

  assert.equal(readShaderPreference(storage), '');
});

test('an unknown id is purged, not returned', () => {
  // xbrz-freescale was delisted after it produced framebuffer errors. A profile
  // that still holds it must not keep costing a fetch and a notice.
  const storage = fakeStorage({ 'psnes-shader': 'xbrz/xbrz-freescale' });

  assert.equal(readShaderPreference(storage), '');
  assert.deepEqual(storage.removed, ['psnes-shader'], 'the stale value must be removed, not just ignored');
});

test('writing a shader id stores it', () => {
  const storage = fakeStorage();

  writeShaderPreference(storage, 'crt/crt-easymode');

  assert.equal(storage.data.get('psnes-shader'), 'crt/crt-easymode');
});

test('writing the empty id removes the key rather than storing an empty string', () => {
  // Otherwise the key lingers and every reader has to treat '' and absent the
  // same way, which is the sort of thing one of them will forget.
  const storage = fakeStorage({ 'psnes-shader': 'anti-aliasing/fxaa' });

  writeShaderPreference(storage, '');

  assert.equal(storage.data.has('psnes-shader'), false);
  assert.deepEqual(storage.removed, ['psnes-shader']);
});

test('writing an unknown id is refused rather than stored', () => {
  const storage = fakeStorage();

  writeShaderPreference(storage, 'not/a/shader');

  assert.equal(storage.data.has('psnes-shader'), false, 'a value no reader would accept must not be written');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
export PATH="$HOME/.nvm/versions/node/v20.19.6/bin:$PATH"
node --import tsx --test core/test/profile.test.ts
```

Expected: FAIL, every test, with `Cannot find module '.../roms/source-state.js'`. That is the correct first failure; do not proceed until you have seen it.

- [ ] **Step 3: Write the ROM source state**

Create `frontend/src/lib/roms/source-state.ts`. Tabs.

```ts
/**
 * Which form the profile page's ROM panel takes.
 *
 * A pure function over facts already gathered, deliberately: the gathering
 * needs `showDirectoryPicker`, IndexedDB and a permission prompt, none of which
 * exist under Node - and this decision is the one in that panel that can be
 * wrong without anyone seeing it. Getting `unsupported` wrong leaves Firefox
 * and Safari with an empty library and no way to add anything.
 */

export interface RomSourceFacts {
	/** Whether this browser can remember a folder at all. */
	supported: boolean;
	/** The remembered folder's name, if there is one. */
	folderName?: string;
	/** Whether the browser still grants access to it. */
	accessGranted?: boolean;
}

export type RomSourceState =
	| { kind: 'folder'; name: string }
	| { kind: 'folder-stale'; name: string }
	| { kind: 'no-folder' }
	| { kind: 'unsupported' };

export function romSourceState(facts: RomSourceFacts): RomSourceState {
	// The API decides first. A folder name left by another browser, or by a
	// shared profile, must not make an unsupported browser look capable.
	if (!facts.supported) return { kind: 'unsupported' };

	if (!facts.folderName) return { kind: 'no-folder' };

	// Absence of a granted flag is not a grant. Permission on a stored folder
	// lapses between sessions and re-granting needs a gesture, so this is a
	// state the player can act on - and a different action from picking a
	// folder they already picked.
	return facts.accessGranted
		? { kind: 'folder', name: facts.folderName }
		: { kind: 'folder-stale', name: facts.folderName };
}
```

- [ ] **Step 4: Write the shader preference reader**

Create `frontend/src/lib/stores/shader-preference.ts`. Tabs.

```ts
/**
 * The one place that reads and writes the stored shader choice.
 *
 * Four call sites hand-rolled this - the home page, both netplay rooms and the
 * solo room - and one of them had forgotten to purge a value that is no longer
 * a valid shader, which cost it a CDN round trip and a user-facing notice for
 * a preset that had been delisted. One function, one test, four callers.
 *
 * Takes its storage rather than reaching for `localStorage`, so it can be
 * tested without a browser.
 */

import { VALID_SHADER_IDS } from '../components/ShaderSelector.svelte';

const KEY = 'psnes-shader';

export interface PreferenceStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem(key: string): void;
}

/**
 * The stored shader id, or '' for none.
 *
 * An id no longer in the offered list is removed rather than returned:
 * `xbrz-freescale` was delisted after its viewport scaling produced framebuffer
 * errors, and a profile that still holds it would keep paying for it.
 */
export function readShaderPreference(storage: PreferenceStorage): string {
	const stored = storage.getItem(KEY) || '';
	if (!stored) return '';
	if (!VALID_SHADER_IDS.includes(stored)) {
		storage.removeItem(KEY);
		return '';
	}
	return stored;
}

/**
 * Stores a shader id, or removes the key for ''.
 *
 * Removing rather than storing an empty string means no reader has to treat ''
 * and absent as the same thing - which is exactly the sort of equivalence one
 * of four readers eventually forgets.
 */
export function writeShaderPreference(storage: PreferenceStorage, id: string): void {
	if (!id) {
		storage.removeItem(KEY);
		return;
	}
	// A value no reader would accept is worse than no value: it would be purged
	// on the next read anyway, after costing a round trip.
	if (!VALID_SHADER_IDS.includes(id)) return;
	storage.setItem(KEY, id);
}
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
export PATH="$HOME/.nvm/versions/node/v20.19.6/bin:$PATH"
node --import tsx --test core/test/profile.test.ts
```

Expected: PASS, 12 tests.

Note: this test file imports from a `.svelte` file (`ShaderSelector.svelte`, for `VALID_SHADER_IDS`) through `shader-preference.ts`. If `tsx` cannot resolve that import under Node, **stop and report it** rather than working around it — the fix would be to move `VALID_SHADER_IDS` into a plain `.ts` module, which is a decision for the controller, not a detour to take alone.

- [ ] **Step 6: Register the test file and verify it runs**

Append `core/test/profile.test.ts` to the `test:ui` script in `package.json`. That script lists its files explicitly, so an unlisted file silently never runs.

```bash
export PATH="$HOME/.nvm/versions/node/v20.19.6/bin:$PATH"
npm run test:ui 2>&1 | grep -cE "unsupported|shader id"
npm run test:all 2>&1 | grep -E "^# (pass|fail)"
```

Expected: the first returns non-zero, proving the new file is in the run. The second shows the ui group up by 12 to 102, and nothing else changed.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/lib/roms/source-state.ts frontend/src/lib/stores/shader-preference.ts core/test/profile.test.ts package.json
git commit -m "Decide the ROM panel's form and read the shader preference in one place"
```

---

## Task 2: Adopt the shared reader at the four call sites

**Files:**
- Modify: `frontend/src/routes/+page.svelte`
- Modify: `frontend/src/lib/components/SoloRoom.svelte`
- Modify: `frontend/src/lib/components/LockstepRoom.svelte`
- Modify: `frontend/src/lib/components/P2PRoom.svelte`

**Interfaces:**
- Consumes: `readShaderPreference(storage)` and `writeShaderPreference(storage, id)` from Task 1.
- Produces: nothing for later tasks.

### Why now rather than later

The function would otherwise be dead code for three tasks, and dead code is how a plan ships an abstraction nobody uses. Adopting it immediately also proves it against four real call sites before anything is built on it.

- [ ] **Step 1: Find every site**

```bash
grep -n "psnes-shader" frontend/src/routes/+page.svelte frontend/src/lib/components/{SoloRoom,LockstepRoom,P2PRoom}.svelte
```

Expected: reads and writes across all four. Note each one before changing it — some purge an invalid value and some do not, and that difference is the reason this task exists.

- [ ] **Step 2: Replace each read and write**

In each file, import the shared pair:

```ts
  import { readShaderPreference, writeShaderPreference } from '$lib/stores/shader-preference';
```

Replace a read of the form `localStorage.getItem('psnes-shader') || ''` — plus whatever validation and purging surrounds it — with:

```ts
      const storedShader = readShaderPreference(localStorage);
```

Replace a write of the form `if (next) localStorage.setItem('psnes-shader', next); else localStorage.removeItem('psnes-shader');` with:

```ts
    writeShaderPreference(localStorage, next);
```

Delete the validation that each site had rolled itself: `VALID_SHADER_IDS.includes(...)` guards around the read, and the `localStorage.removeItem` that followed. The shared reader does it. If a file no longer uses `VALID_SHADER_IDS` for anything else, remove that import too — `svelte-check` will tell you.

- [ ] **Step 3: Verify no site still speaks to storage directly**

```bash
export PATH="$HOME/.nvm/versions/node/v20.19.6/bin:$PATH"
grep -rn "psnes-shader" frontend/src --include=*.svelte
npm run check --workspace frontend 2>&1 | tail -3
npm run test:all 2>&1 | grep -E "^# (pass|fail)"
```

Expected: the grep returns **nothing** — the key's name now lives only in `shader-preference.ts`. 0 errors, and all tests still passing.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/routes/+page.svelte frontend/src/lib/components/SoloRoom.svelte frontend/src/lib/components/LockstepRoom.svelte frontend/src/lib/components/P2PRoom.svelte
git commit -m "Read the shader preference through one reader instead of four copies"
```

---

## Task 3: The ROM source panel

**Files:**
- Create: `frontend/src/lib/components/RomSourcePanel.svelte`

**Interfaces:**
- Consumes: `romSourceState`, `RomSourceState` from Task 1; `supportsDirectoryPicker`, `chooseDirectory`, `storedDirectory`, `ensureAccess` from `$lib/roms/local-library`; `offerFile` from `$lib/roms/provider`.
- Produces: the `RomSourcePanel` component, taking no props and dispatching `changed` when the library may have gained games.

### The signatures this uses, read from source

- `supportsDirectoryPicker(): boolean`
- `chooseDirectory(): Promise<boolean>` — prompts, stores the handle, returns whether one was chosen
- `storedDirectory(): Promise<FileSystemDirectoryHandle | undefined>`
- `ensureAccess(handle: FileSystemDirectoryHandle): Promise<boolean>`
- `offerFile(file: File, expected: string): Promise<Uint8Array>` — note it takes an expected checksum, so it is **not** the right call for adding an unknown file; the single-file path here needs `checksumOf` and `romBytes` from `local-library` instead. Confirm both before using them:

```bash
grep -n "export async function checksumOf\|export async function romBytes" frontend/src/lib/roms/local-library.ts
```

- [ ] **Step 1: Create the component**

Create `frontend/src/lib/components/RomSourcePanel.svelte`:

```svelte
<script lang="ts">
  /**
   * Where this machine's ROMs come from.
   *
   * Replaces the "add games" modal. ROMs stopped living on the server, so the
   * library is a list of identities and the files come from a folder - which
   * makes configuring the folder once the right shape, and adding games one at
   * a time the shape of before.
   *
   * It has two forms, and the second is not a consolation prize shown
   * everywhere: folder selection needs `showDirectoryPicker`, which only
   * Chromium has. Without the single-file fallback, Firefox and Safari would
   * have a permanently empty library and no recourse.
   */
  import { createEventDispatcher, onMount } from 'svelte';
  import { language } from '$lib/stores/language';
  import { t } from '$lib/i18n/translations';
  import { romSourceState, type RomSourceState } from '$lib/roms/source-state';
  import {
    supportsDirectoryPicker,
    chooseDirectory,
    storedDirectory,
    ensureAccess
  } from '$lib/roms/local-library';

  const dispatch = createEventDispatcher();

  let state: RomSourceState = { kind: 'no-folder' };
  let busy = false;
  let error = '';

  /**
   * Gathers the facts, then lets the pure function decide.
   *
   * The split is deliberate: the gathering needs three browser APIs and a
   * permission check, and the decision is the part that can be wrong without
   * anyone seeing it.
   */
  async function refresh(): Promise<void> {
    const supported = supportsDirectoryPicker();
    if (!supported) {
      state = romSourceState({ supported: false });
      return;
    }
    const handle = await storedDirectory();
    if (!handle) {
      state = romSourceState({ supported: true });
      return;
    }
    state = romSourceState({
      supported: true,
      folderName: handle.name,
      accessGranted: await ensureAccess(handle)
    });
  }

  async function pickFolder(): Promise<void> {
    busy = true;
    error = '';
    try {
      if (await chooseDirectory()) dispatch('changed');
      await refresh();
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
    }
  }

  onMount(refresh);
</script>

<section class="rom-source">
  <h3>{t($language, 'romSource')}</h3>

  {#if state.kind === 'unsupported'}
    <p class="explain">{t($language, 'romFolderUnsupported')}</p>
    <!-- The single-file path lives here and only here: shown where a folder
         cannot be remembered, so it costs nothing to anyone else. -->
    <slot name="fallback" />
  {:else if state.kind === 'folder'}
    <p class="current">{t($language, 'romFolderCurrent')} <strong>{state.name}</strong></p>
    <button on:click={pickFolder} disabled={busy}>{t($language, 'romFolderChange')}</button>
  {:else if state.kind === 'folder-stale'}
    <p class="explain">
      {t($language, 'romFolderStale')} <strong>{state.name}</strong>
    </p>
    <button on:click={pickFolder} disabled={busy}>{t($language, 'romFolderRegrant')}</button>
  {:else}
    <p class="explain">{t($language, 'romsStayLocal')}</p>
    <button on:click={pickFolder} disabled={busy}>{t($language, 'chooseRomFolder')}</button>
  {/if}

  {#if error}
    <p class="error">{error}</p>
  {/if}
</section>

<style>
  .rom-source {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.5rem;
  }

  h3 {
    margin: 0;
  }

  .explain,
  .current {
    margin: 0;
    color: #aaa;
    font-size: 0.9rem;
  }

  .error {
    margin: 0;
    color: #f87171;
    font-size: 0.9rem;
  }

  button {
    background: #333;
    border: 2px solid transparent;
    color: #fff;
    padding: 0.4rem 0.75rem;
    border-radius: 6px;
    cursor: pointer;
  }

  button:disabled {
    opacity: 0.5;
    cursor: default;
  }
</style>
```

- [ ] **Step 2: Add the five translation keys**

`romsStayLocal` and `chooseRomFolder` already exist — confirm before adding duplicates:

```bash
grep -n "romsStayLocal:\|chooseRomFolder:" frontend/src/lib/i18n/translations.ts
```

Add the five that do not, in the English block next to `chooseRomFolder`:

```ts
    romSource: 'Where your ROMs come from',
    romFolderCurrent: 'Current folder:',
    romFolderChange: 'Change folder',
    romFolderStale: 'This browser needs permission again for',
    romFolderRegrant: 'Grant access',
    romFolderUnsupported: 'This browser cannot remember a folder, so games are added one file at a time.',
```

And in the French block next to its `chooseRomFolder`:

```ts
    romSource: 'D’où viennent tes ROM',
    romFolderCurrent: 'Dossier actuel :',
    romFolderChange: 'Changer de dossier',
    romFolderStale: 'Ce navigateur redemande l’autorisation pour',
    romFolderRegrant: 'Autoriser',
    romFolderUnsupported: 'Ce navigateur ne sait pas mémoriser un dossier, donc les jeux s’ajoutent fichier par fichier.',
```

- [ ] **Step 3: Verify**

```bash
export PATH="$HOME/.nvm/versions/node/v20.19.6/bin:$PATH"
npm run check --workspace frontend 2>&1 | tail -3
```

Expected: 0 errors. The warning count may rise by one for the unused `fallback` slot until Task 4 fills it — note the number in your report either way.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/lib/components/RomSourcePanel.svelte frontend/src/lib/i18n/translations.ts
git commit -m "Configure the ROM folder in one panel, with a fallback only where it is needed"
```

---

## Task 4: The profile page

**Files:**
- Create: `frontend/src/routes/profile/+page.svelte`
- Modify: `frontend/src/lib/i18n/translations.ts`

**Interfaces:**
- Consumes: `RomSourcePanel` (Task 3), `readShaderPreference`/`writeShaderPreference` (Task 1), plus the existing `ControlsSettings`, `LanguageSelector`, `SHADERS`, the `user` store, and `POST /api/games/refresh-metadata`.
- Produces: the `/profile` route.

### What it does not do

No avatar changing. No API exists — the avatars router only serves files for reading and the avatar comes from Google — so it would need an upload endpoint with type validation, a size cap and a storage location. That is an untrusted-file surface and a separate piece.

- [ ] **Step 1: Read the pieces you are reusing**

```bash
grep -n "export let" frontend/src/lib/components/ControlsSettings.svelte
grep -n "export const SHADERS" -A10 frontend/src/lib/components/ShaderSelector.svelte
grep -n "export interface User" -A8 frontend/src/lib/stores/user.ts
```

`ControlsSettings` takes `roomId` (empty means "save to the profile only") and `currentConfig: KeyConfig`. `SHADERS` is a list of `{ id, name }` where `name` is a translation key. Confirm these before writing the markup rather than trusting this plan.

- [ ] **Step 2: Create the page**

Create `frontend/src/routes/profile/+page.svelte`:

```svelte
<script lang="ts">
  /**
   * Everything the sidebar used to hold that was not navigation.
   *
   * A route rather than a modal: it carries enough to deserve an address, and
   * an address can be shared, opened in a tab, and left with the back button.
   *
   * Sections are ordered by what someone came for - identity first, settings
   * next, signing out last because it is the destructive one.
   */
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { user } from '$lib/stores/user';
  import { language } from '$lib/stores/language';
  import { t } from '$lib/i18n/translations';
  import type { KeyConfig } from '$lib/types';
  import ControlsSettings from '$lib/components/ControlsSettings.svelte';
  import LanguageSelector from '$lib/components/LanguageSelector.svelte';
  import RomSourcePanel from '$lib/components/RomSourcePanel.svelte';
  import { SHADERS } from '$lib/components/ShaderSelector.svelte';
  import { readShaderPreference, writeShaderPreference } from '$lib/stores/shader-preference';

  let keyConfig: KeyConfig | null = null;
  let shader = '';
  let refreshing = false;
  let refreshMessage = '';

  onMount(async () => {
    // localStorage owns the display setting; this page and the pause menu both
    // read it at mount and write it on change. They never coexist on screen,
    // so there is nothing to keep in sync.
    shader = readShaderPreference(localStorage);

    const res = await fetch('/api/user/controls', { credentials: 'include' });
    if (res.ok) keyConfig = await res.json();
  });

  function chooseShader(id: string): void {
    shader = id;
    writeShaderPreference(localStorage, id);
  }

  async function refreshMetadata(): Promise<void> {
    refreshing = true;
    refreshMessage = '';
    try {
      const res = await fetch('/api/games/refresh-metadata', {
        method: 'POST',
        credentials: 'include'
      });
      refreshMessage = res.ok
        ? t($language, 'metadataUpdated')
        : t($language, 'metadataUpdateFailed');
    } catch {
      refreshMessage = t($language, 'metadataUpdateFailed');
    } finally {
      refreshing = false;
    }
  }

  async function logout(): Promise<void> {
    await fetch('/auth/logout', { method: 'POST', credentials: 'include' });
    user.set(null);
    void goto('/');
  }
</script>

<div class="profile">
  <a class="back" href="/">← {t($language, 'backToLibrary')}</a>

  <section class="identity">
    <div class="avatar">
      {#if $user?.avatar}
        <img src={$user.avatar} alt={$user.displayName} />
      {:else}
        <span class="placeholder">👤</span>
      {/if}
    </div>
    <div class="who">
      <h2>{$user?.displayName ?? ''}</h2>
      <p class="email">{$user?.email ?? ''}</p>
    </div>
  </section>

  <RomSourcePanel>
    <span slot="fallback"><slot /></span>
  </RomSourcePanel>

  <section>
    <h3>{t($language, 'controls')}</h3>
    {#if keyConfig}
      <ControlsSettings currentConfig={keyConfig} on:saved={(e) => (keyConfig = e.detail.config)} />
    {/if}
  </section>

  <section class="display">
    <h3>{t($language, 'display')}</h3>
    <div class="shaders">
      {#each SHADERS as option}
        <button class:on={shader === option.id} on:click={() => chooseShader(option.id)}>
          {t($language, option.name)}
        </button>
      {/each}
    </div>
  </section>

  <section>
    <h3>{t($language, 'language')}</h3>
    <LanguageSelector />
  </section>

  <section>
    <h3>{t($language, 'library')}</h3>
    <button on:click={refreshMetadata} disabled={refreshing}>
      {refreshing ? t($language, 'updating') : t($language, 'updateMetadata')}
    </button>
    {#if refreshMessage}<p class="note">{refreshMessage}</p>{/if}
  </section>

  <section class="danger">
    <button class="logout" on:click={logout}>{t($language, 'logout')}</button>
  </section>
</div>

<style>
  .profile {
    max-width: 48rem;
    margin: 0 auto;
    padding: 1.5rem;
    display: flex;
    flex-direction: column;
    gap: 2rem;
  }

  .back {
    color: #aaa;
    text-decoration: none;
    align-self: flex-start;
  }

  .identity {
    display: flex;
    align-items: center;
    gap: 1.5rem;
  }

  .avatar {
    width: 6rem;
    height: 6rem;
    border-radius: 50%;
    overflow: hidden;
    background: #333;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }

  .avatar img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .placeholder {
    font-size: 2.5rem;
  }

  h2,
  h3 {
    margin: 0;
  }

  .email {
    margin: 0.25rem 0 0;
    color: #aaa;
  }

  .shaders {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin-top: 0.5rem;
  }

  button {
    background: #333;
    border: 2px solid transparent;
    color: #fff;
    padding: 0.4rem 0.75rem;
    border-radius: 6px;
    cursor: pointer;
  }

  button.on {
    background: #3a4a5a;
    border-color: #667eea;
  }

  button:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .note {
    margin: 0.5rem 0 0;
    color: #aaa;
    font-size: 0.9rem;
  }

  .logout {
    background: #7f1d1d;
  }
</style>
```

- [ ] **Step 3: Add the missing translation keys**

Check which already exist before adding:

```bash
grep -n "backToLibrary:\|metadataUpdated:\|metadataUpdateFailed:\|language:\|library:" frontend/src/lib/i18n/translations.ts
```

Add whichever are absent, to both locales. English:

```ts
    backToLibrary: 'Back to the library',
    metadataUpdated: 'Metadata updated.',
    metadataUpdateFailed: 'Could not update the metadata.',
    library: 'Library',
```

French:

```ts
    backToLibrary: 'Retour à la bibliothèque',
    metadataUpdated: 'Métadonnées mises à jour.',
    metadataUpdateFailed: 'Impossible de mettre à jour les métadonnées.',
    library: 'Bibliothèque',
```

If `language:` is absent, add `language: 'Language'` and `language: 'Langue'` — but check first, because `$language` is also a store name and the grep will show both.

- [ ] **Step 4: Verify**

```bash
export PATH="$HOME/.nvm/versions/node/v20.19.6/bin:$PATH"
npm run check --workspace frontend 2>&1 | tail -3
npm run test:all 2>&1 | grep -E "^# (pass|fail)"
```

Expected: 0 errors, all tests passing.

The nested `<slot>` inside `RomSourcePanel`'s `fallback` slot in Step 2 is a placeholder for the single-file control, which Task 5 moves here from `AddGames`. If `svelte-check` objects to a `<slot>` in a page component, **report it** and leave the slot empty for now rather than inventing the control early — Task 5 owns it.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/routes/profile/+page.svelte frontend/src/lib/i18n/translations.ts
git commit -m "Give the settings a page instead of a navigation menu"
```

---

## Task 5: The thin top bar, and the sidebar goes

**Files:**
- Create: `frontend/src/lib/components/TopBar.svelte`
- Modify: `frontend/src/routes/+page.svelte`

**Interfaces:**
- Consumes: the `user` store, the existing `FriendsList` component.
- Produces: the `TopBar` component, taking `activeRooms: any[]` to pass through to `FriendsList`.

### The constraint that is easy to break

The bar exists only when signed in. The signed-out landing page has its own presentation and its own `LanguageSelector`, and it **keeps it** — someone who reads neither language must be able to change it before signing in, and the profile page is unreachable to them.

So: add the bar to the signed-in branch only, and do not touch the landing branch's selector.

- [ ] **Step 1: Create the bar**

Create `frontend/src/lib/components/TopBar.svelte`:

```svelte
<script lang="ts">
  /**
   * Navigation and identity, and nothing else.
   *
   * The sidebar this replaces held four settings, a permanently visible friends
   * list and an "add games" button. Settings went to /profile, friends became a
   * menu opened on demand, and adding games stopped being a repeated action
   * when ROMs went local.
   *
   * Only rendered when signed in. The landing page keeps its own language
   * selector, because /profile is unreachable to someone who has not signed in.
   */
  import { user } from '$lib/stores/user';
  import { language } from '$lib/stores/language';
  import { t } from '$lib/i18n/translations';
  import FriendsList from './FriendsList.svelte';

  export let activeRooms: any[] = [];

  let showFriends = false;
</script>

<header class="top-bar">
  <a class="brand" href="/">🎮 PSNES</a>

  <div class="right">
    <button class="bar-button" class:on={showFriends} on:click={() => (showFriends = !showFriends)}>
      {t($language, 'friends')}
    </button>

    <a class="avatar" href="/profile" title={$user?.displayName ?? ''}>
      {#if $user?.avatar}
        <img src={$user.avatar} alt={$user.displayName} />
      {:else}
        <span class="placeholder">👤</span>
      {/if}
    </a>
  </div>
</header>

{#if showFriends}
  <!-- A dropdown on a wide screen, the whole screen on a narrow one: a friends
       list in a narrow column is not readable, which is the same reason the
       pause panel makes the same split. -->
  <div class="friends-drawer">
    <FriendsList {activeRooms} compact={true} />
  </div>
{/if}

<style>
  .top-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.5rem 1rem;
    background: #1a1a1a;
    border-bottom: 1px solid #2e2e2e;
  }

  .brand {
    color: #fff;
    text-decoration: none;
    font-weight: 600;
  }

  .right {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .bar-button {
    background: #2a2a2a;
    border: 2px solid transparent;
    color: #fff;
    padding: 0.35rem 0.7rem;
    border-radius: 6px;
    cursor: pointer;
  }

  .bar-button.on {
    background: #3a4a5a;
    border-color: #667eea;
  }

  .avatar {
    width: 2rem;
    height: 2rem;
    border-radius: 50%;
    overflow: hidden;
    background: #333;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .avatar img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .friends-drawer {
    position: absolute;
    right: 1rem;
    top: 3rem;
    width: 24rem;
    max-height: 70vh;
    overflow-y: auto;
    background: #1a1a1a;
    border: 1px solid #2e2e2e;
    border-radius: 8px;
    z-index: 100;
  }

  /* Too narrow for a column: take the screen, same reason as the pause panel. */
  @media (max-width: 700px) {
    .friends-drawer {
      position: fixed;
      inset: 3rem 0 0;
      width: auto;
      max-height: none;
      border-radius: 0;
    }
  }
</style>
```

- [ ] **Step 2: Put it on the page and take the sidebar out**

In `frontend/src/routes/+page.svelte`:

Add the import next to the others:

```ts
  import TopBar from '$lib/components/TopBar.svelte';
```

Find the signed-in branch's `<nav class="sidebar-nav">` block. Delete it entirely — from the opening `<nav` to its closing `</nav>` — including all four nav-section divs it contains. Put `<TopBar {activeRooms} />` at the top of the signed-in branch instead, before the library.

Then delete the CSS the sidebar owned: the `.sidebar-nav`, `.nav-section`, `.nav-button` and `.user-profile` rules and their variants. `svelte-check` reports unused selectors as warnings, so it will tell you what you missed — the warning count is the check, and it should not rise.

Leave the landing branch, its `<LanguageSelector />` and everything else about the signed-out state exactly as it is.

- [ ] **Step 3: Verify, including the constraint**

```bash
export PATH="$HOME/.nvm/versions/node/v20.19.6/bin:$PATH"
npm run check --workspace frontend 2>&1 | tail -3
grep -c "LanguageSelector" frontend/src/routes/+page.svelte
npm run test:all 2>&1 | grep -E "^# (pass|fail)"
```

Expected: 0 errors. The `LanguageSelector` count must be **1** — the landing page keeps its own, and the sidebar's copy is gone with the sidebar. If it is 0, the constraint is broken and the landing page has no way to change language; if it is 2, the sidebar was not fully removed.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/lib/components/TopBar.svelte frontend/src/routes/+page.svelte
git commit -m "Trade a permanent sidebar for a thin bar and a friends menu"
```

---

## Task 6: Delete AddGames

**Files:**
- Delete: `frontend/src/lib/components/AddGames.svelte`
- Modify: `frontend/src/routes/+page.svelte`
- Modify: `frontend/src/routes/profile/+page.svelte`

**Interfaces:**
- Consumes: `RomSourcePanel`'s `fallback` slot (Task 3), the profile page (Task 4).
- Produces: nothing.

### Why last

The sidebar removal in Task 5 took one of `AddGames`' two entry points. Deleting it before that would have left a dangling reference; deleting it after leaves only the second entry point — the large button on the empty library — to remove.

- [ ] **Step 1: Move the single-file control to the profile page**

Read what `AddGames` does for a single file before moving it:

```bash
grep -n "onFileChosen" -A18 frontend/src/lib/components/AddGames.svelte
grep -n "ACCEPT" frontend/src/lib/components/AddGames.svelte | head -2
```

Then fill `RomSourcePanel`'s `fallback` slot in `frontend/src/routes/profile/+page.svelte` with a file input driving the same logic — a hidden `<input type="file">` with the same `accept` list, and the same handler body, adapted to set the page's own `error` and progress state. Replace the placeholder:

```svelte
  <RomSourcePanel>
    <span slot="fallback"><slot /></span>
  </RomSourcePanel>
```

with the input and its button. Keep the legal notice `AddGames` showed — it is a claim the app makes about ownership and deleting the modal is not a reason to stop making it:

```svelte
    <p class="legal">{t($language, 'legalUploadWarning')}</p>
```

- [ ] **Step 2: Remove the second entry point**

In `frontend/src/routes/+page.svelte`, delete the `showUpload` state, the `<AddGames>` block, its import, and the large button on the empty library (`btn-upload-large`). The empty library should instead point at the profile page:

```svelte
      <a class="empty-cta" href="/profile">{t($language, 'romSource')}</a>
```

- [ ] **Step 3: Delete the component**

```bash
git rm frontend/src/lib/components/AddGames.svelte
```

- [ ] **Step 4: Verify nothing references it**

```bash
export PATH="$HOME/.nvm/versions/node/v20.19.6/bin:$PATH"
grep -rn "AddGames\|showUpload\|btn-upload-large" frontend/src
npm run check --workspace frontend 2>&1 | tail -3
npm run test:all 2>&1 | grep -E "^# (pass|fail)"
```

Expected: the grep returns **nothing**. 0 errors, all tests passing, and the warning count back to its baseline of 19 now that the `fallback` slot is filled and the sidebar's CSS is gone.

- [ ] **Step 5: Commit**

```bash
git add -A frontend/src
git commit -m "Delete the add-games modal: configuring a folder replaced it"
```

---

## Task 7: Verification

**Files:**
- Create: `docs/superpowers/verification/2026-08-21-profile-and-top-bar.md`

**Interfaces:** consumes everything from Tasks 1-6.

### Why this is a task

The two pure functions are tested. The bar, the page, the dropdown and the deletion are not testable in this repo — no browser harness. This is the compensating control, and its output is a written record that keeps the two apart.

- [ ] **Step 1: Capture the mechanical checks**

```bash
export PATH="$HOME/.nvm/versions/node/v20.19.6/bin:$PATH"
npm run test:all 2>&1 | grep -E "^# (tests|pass|fail)"
npm run check --workspace frontend 2>&1 | tail -3
npm run build --workspace frontend 2>&1 | tail -3
grep -rn "psnes-shader" frontend/src --include=*.svelte
grep -rn "AddGames\|showUpload" frontend/src
grep -c "LanguageSelector" frontend/src/routes/+page.svelte
```

The last three matter: the first two must return nothing, and the count must be exactly 1.

- [ ] **Step 2: Walk the browser checklist**

- [ ] Signed in, the bar shows the brand, a friends button and the avatar. No sidebar.
- [ ] The avatar goes to `/profile`, and the back link returns to the library.
- [ ] The profile page shows the avatar larger, the display name and the email.
- [ ] Controls open, save, and survive a reload.
- [ ] Choosing a shader on the profile page, then starting a game, shows that shader — the two views share `localStorage` and this is what proves it.
- [ ] Changing the shader in the pause menu, then returning to the profile page, shows the new value.
- [ ] Updating the metadata reports success or failure.
- [ ] Signing out returns to the landing page.
- [ ] **The landing page still has its language selector.** The constraint most easily lost, and the one that locks out someone who reads neither language.
- [ ] The friends menu opens as a dropdown on a wide window and takes the screen on a narrow one.
- [ ] **On Chromium:** the ROM panel offers a folder, remembers it, and shows its name afterwards.
- [ ] **On Firefox or Safari:** the panel says a folder cannot be remembered and offers the file-by-file path. Add a game that way and confirm it appears in the library. If this fails, the library is permanently empty on that browser — the worst outcome this piece can produce.
- [ ] Revoke the folder permission (Chromium site settings) and reload: the panel should offer to grant access again, not to pick a folder you already picked.

- [ ] **Step 3: Write and commit the record**

Create `docs/superpowers/verification/2026-08-21-profile-and-top-bar.md` with the captured output, the checklist and each item's outcome, and anything observed but not fixed.

```bash
git add docs/superpowers/verification/2026-08-21-profile-and-top-bar.md
git commit -m "Record what the chrome rework was checked for"
```

---

## Self-Review

**1. Spec coverage.** Each spec section against a task:

| Spec section | Task |
|---|---|
| Why (sidebar holds settings, friends always visible, add-games obsolete) | Tasks 5 and 6 |
| Rehousing table: add games → ROM panel | Tasks 3 and 6 |
| Rehousing: controls, display, metadata, language, logout → profile | Task 4 |
| Rehousing: friends → dropdown | Task 5 |
| Rehousing: avatar → link to /profile | Task 5 |
| The bar exists only signed in; landing keeps its selector | Task 5 Step 3 (the count check) and Task 7 |
| The profile page as a route, sections in order | Task 4 |
| No avatar changing | honoured by omission; Task 4 states it |
| The ROM panel's two forms, browser honesty | Tasks 1 and 3 |
| The "already the case on Firefox" note | Task 7's checklist wording |
| Display setting in both places, localStorage owns it | Tasks 1, 2 and 4 |
| Friends list reused, dropdown/full-screen split | Task 5 |
| Testable: the two pure functions | Task 1, 12 tests |
| Not testable: bar, page, dropdown, deletion | Task 7 |
| Refuses: no lobby, no controller picker, no indicator | honoured by omission |
| Refuses: no FriendsList/ControlsSettings refactor | Tasks 4 and 5 reuse them as-is |

No gaps found.

**2. Placeholder scan.** No TBD, no "add error handling", no "similar to Task N". Every code step carries its code. Task 7 is prose because its deliverable is an observation, and each item names what to look for.

**3. Type consistency.** Names crossing task boundaries:

- `RomSourceState` and `romSourceState` — Task 1 defines, Task 3 consumes. The four `kind` values match on both sides: `folder`, `folder-stale`, `no-folder`, `unsupported`.
- `RomSourceFacts` fields `supported`/`folderName`/`accessGranted` — Task 1 defines, Task 3's `refresh()` fills all three.
- `readShaderPreference` / `writeShaderPreference` / `PreferenceStorage` — Task 1 defines, Tasks 2 and 4 consume. Both take storage first.
- `RomSourcePanel`'s `fallback` slot — Task 3 declares, Task 4 places a placeholder in, Task 6 fills.
- `TopBar`'s `activeRooms` prop — Task 5 defines and passes to `FriendsList`, which already declares `activeRooms: any[]`.

Two things found and fixed while checking:

- An earlier draft had Task 3's single-file path calling `offerFile(file, expected)`. That signature takes an **expected checksum**, so it is for confirming a known ROM, not adding an unknown one. Task 3 now says so and points at `checksumOf`/`romBytes`, with a command to confirm both exist.
- An earlier draft deleted `AddGames` in Task 5, before the profile page had anywhere to put the single-file control. Reordered: Task 6 moves the control and then deletes, so no step leaves the fallback unimplemented while the modal is already gone.

## Risks recorded, not solved

- **`shader-preference.ts` imports from a `.svelte` file** for `VALID_SHADER_IDS`. Task 1 Step 5 says to stop and report if `tsx` cannot resolve it under Node rather than working around it, because the fix — moving that constant to a plain `.ts` module — touches four other importers and is a controller decision.
- **`FriendsList` is used with `compact={true}`** in the dropdown, a mode it already supports but which was written for small screens rather than for a 24rem drawer. It may look wrong at that width. Task 7's checklist covers it; the remedy, if needed, is a width, not a rewrite.
- **The profile page reads `/api/user/controls` directly** rather than through a store, so opening it always costs a request. Acceptable for a settings page; worth knowing if it later becomes a tab someone flips to often.
