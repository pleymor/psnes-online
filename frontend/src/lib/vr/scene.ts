/**
 * The three.js side of the immersive session: what exists, and when it draws.
 *
 * It owns the renderer, the scene, the screen and the frame pump, and it owns
 * exactly one policy: the XR animation loop pumps the governor and then
 * renders. It never decides that a frame exists - `FrameGovernor` does, through
 * the pump - which is what keeps the emulator running at 60.0988 Hz on a 72 or
 * 90 Hz display.
 *
 * The reference space is `local`, set here to match what `xr-session.ts`
 * asked for. Both have to say the same thing: three requests its own space
 * rather than reusing the session's (`WebXRManager.js`, whose default is
 * `local-floor`), so a floor-relative type here would ask for a space this
 * session was never granted.
 */

import * as THREE from 'three';
import { createFramePump } from './frame-pump';
import { createVrScreen, type VrScreen } from './screen';
import { sceneLayout, type SceneLayout, type Placement } from './layout';
import type { PixelAspect } from '$lib/znet/fit';
import { createPanelMesh, type PanelMesh } from './panel-mesh';
import { hit, type PanelSize } from './panel';
import type { PointerTarget } from './pointer';
import { TRIGGER } from './pad';

export interface VrScene {
  screen: VrScreen;
  layout: SceneLayout;
  scene: THREE.Scene;
  /** Handed to `GovernorOptions.schedule`. */
  schedule: (run: () => void) => void;
  /** Runs every XR frame, before the render. */
  onFrame: (fn: () => void) => void;
  attach(session: XRSession): Promise<void>;
  addPanel(id: string, placement: Placement, size: PanelSize): PanelMesh;
  panelsVisible(visible: boolean): void;
  arePanelsVisible(): boolean;
  aimedAt(): PointerTarget | null;
  triggerDown(): boolean;
  inputSources(): Iterable<XRInputSource>;
  dispose(): void;
}

export function createVrScene(opts: {
  aspect: PixelAspect;
  onContextLost: () => void;
  /**
   * A throw that escaped the pumped emulation slice or a per-frame callback.
   *
   * Reported, never swallowed: the loop below keeps drawing regardless, and
   * without this the player would be the only witness.
   */
  onFrameError: (err: unknown) => void;
}): VrScene {
  const layout = sceneLayout(opts.aspect);

  const canvas = document.createElement('canvas');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.xr.enabled = true;

  // The flat path falls back to a 2D canvas when the context dies
  // (`renderer-surface.ts`). There is no fallback in here, so the only honest
  // move is to end the session and say so, rather than leave somebody inside a
  // black world wondering whether the game crashed.
  canvas.addEventListener('webglcontextlost', (event) => {
    event.preventDefault();
    opts.onContextLost();
  });

  const scene = new THREE.Scene();
  // Every material is unlit MeshBasicMaterial, so there are no lights. The
  // background is near-black rather than black: a faint gradient gives the eye
  // something to fix on and stops the screen looking like it floats in a void.
  scene.background = new THREE.Color(0x0a0a12);

  const camera = new THREE.PerspectiveCamera(70, 1, 0.05, 50);

  const screen = createVrScreen(layout.screen);
  scene.add(screen.mesh);

  const pump = createFramePump();
  const perFrame: Array<() => void> = [];

  /*
   * Why the render is outside the try below.
   *
   * A throw from the pumped slice or from a per-frame callback used to take
   * `renderer.render()` down with it, and that is the worst shape this loop
   * can fail in: the player is left inside a world that has stopped
   * redrawing - frozen, or black if no frame ever arrived - with the panels
   * unusable and the exit unreachable, because both of those are drawn by the
   * render that no longer happens. Whatever the emulator did, the world still
   * draws, so the right stick still recalls the panels and `quit` still
   * works.
   *
   * Reported once per session. The two throwing paths differ in what they do
   * next and neither wants repeating: a slice that throws never reaches the
   * `schedule()` that ends `FrameGovernor.slice()`, so it is already dead and
   * will never throw again, while a per-frame callback throws afresh on every
   * one of the next seventy-two frames a second. Logging each of those would
   * bury the first line - the only one that names the cause - and blow
   * straight past `log-shipper.ts`'s hundred-entry batch.
   */
  let frameErrorReported = false;
  function reportFrameError(err: unknown): void {
    if (frameErrorReported) return;
    frameErrorReported = true;
    opts.onFrameError(err);
  }

  const panels: PanelMesh[] = [];
  // Rebuilt only in `addPanel`, never inside `aimedAt`: that loop runs twice
  // a frame while panels are visible, and a GC pause there is audible as an
  // audio glitch, same as the raycaster scratch objects below.
  const panelMeshes: THREE.Mesh[] = [];
  const panelGroup = new THREE.Group();
  scene.add(panelGroup);

  /**
   * The two controllers as scene objects, with a ray drawn down each.
   *
   * The ray is not decoration. Without it a player has no idea where they are
   * pointing until something highlights, and nothing highlights until they are
   * already on it - so aiming becomes a search.
   */
  const rayGeometry = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0, 0, -2)
  ]);
  const rayMaterial = new THREE.LineBasicMaterial({ color: 0x7aa2ff, transparent: true, opacity: 0.6 });
  const controllers = [0, 1].map((index) => {
    const controller = renderer.xr.getController(index);
    controller.add(new THREE.Line(rayGeometry, rayMaterial));
    scene.add(controller);
    return controller;
  });

  // Reused every frame rather than allocated: this runs at the headset's
  // refresh rate, and a GC pause is audible as an audio glitch.
  const raycaster = new THREE.Raycaster();
  const origin = new THREE.Vector3();
  const direction = new THREE.Vector3();
  const worldQuaternion = new THREE.Quaternion();

  /**
   * Whichever hand is aiming at a panel.
   *
   * Not "right first": `controllers` comes from `getController(0)` and
   * `getController(1)`, and WebXR hands those out in connection order, not by
   * handedness - so which one this checks first depends on which controller
   * woke up first, not on which hand it is. `triggerDown()` below compounds
   * this rather than working around it: it returns true for EITHER
   * controller, so a press on the hand not being checked first still
   * activates whatever the other hand happens to be pointing at. Both are
   * defensible (a two-controller precondition this scene already has, and a
   * single physical trigger button), but neither is "right hand wins".
   */
  function aimedAt(): PointerTarget | null {
    /*
     * Which meshes are targets, and why the rule moved.
     *
     * It used to be "nothing while the panels are hidden", which was a
     * shorthand for the real rule: the trigger is the SNES R button while a
     * game is running, and letting it also be a pointer would make a shot
     * register as a menu press. The screen is now a target too when it is a
     * launch screen, so the shorthand stopped being true - the rule below is
     * the one that was always meant.
     */
    const targets: THREE.Object3D[] = [];
    if (panelGroup.visible) targets.push(...panelMeshes);
    if (screen.isPanel()) targets.push(screen.mesh);
    if (targets.length === 0) return null;

    for (const controller of controllers) {
      origin.setFromMatrixPosition(controller.matrixWorld);
      /*
       * A controller points down its own -Z, the same convention the camera
       * uses. The WORLD quaternion, not the local one: they are identical
       * today because these are direct children of the scene, which is exactly
       * why the local one would keep working right up until somebody puts the
       * controllers in a group and the rays start pointing somewhere else.
       */
      controller.getWorldQuaternion(worldQuaternion);
      direction.set(0, 0, -1).applyQuaternion(worldQuaternion).normalize();
      raycaster.set(origin, direction);

      const [first] = raycaster.intersectObjects(targets, false);
      if (!first?.uv) continue;
      const uv = { x: first.uv.x, y: first.uv.y };

      // The screen is not in `panels`, so it needs its own lookup rather than
      // a `find` that would silently return undefined and skip the controller.
      if (first.object === screen.mesh) {
        const size = screen.panelSize();
        if (!size) continue;
        const onScreen = hit(screen.regions, uv, size);
        if (onScreen) return { panel: 'screen', region: onScreen };
        continue;
      }

      const panel = panels.find((candidate) => candidate.mesh === first.object);
      if (!panel) continue;

      const region = hit(panel.regions, uv, panel.size);
      if (region) return { panel: panel.id, region };
    }
    return null;
  }

  function triggerDown(): boolean {
    const session = renderer.xr.getSession();
    if (!session) return false;
    for (const source of session.inputSources) {
      if (source.gamepad?.buttons[TRIGGER]?.pressed) return true;
    }
    return false;
  }

  return {
    screen,
    layout,
    scene,
    schedule: pump.schedule,
    onFrame: (fn) => void perFrame.push(fn),

    async attach(session: XRSession): Promise<void> {
      // `local`, matching what `xr-session.ts` asked for, and BEFORE
      // `setSession`: three requests its own space from inside that call, and
      // its default is `local-floor`, so setting this afterwards would ask
      // for a space the session was never granted.
      renderer.xr.setReferenceSpaceType('local');
      await renderer.xr.setSession(session);
      renderer.setAnimationLoop(() => {
        // Order matters: the governor may run a frame, and the render should
        // show that frame rather than the previous one.
        try {
          pump.pump();
          for (const fn of perFrame) fn();
        } catch (err) {
          reportFrameError(err);
        }
        renderer.render(scene, camera);
      });
    },

    addPanel(id: string, placement: Placement, size: PanelSize): PanelMesh {
      const panel = createPanelMesh(id, placement, size);
      panels.push(panel);
      panelMeshes.push(panel.mesh);
      panelGroup.add(panel.mesh);
      return panel;
    },
    panelsVisible: (visible: boolean) => void (panelGroup.visible = visible),
    arePanelsVisible: () => panelGroup.visible,
    aimedAt,
    triggerDown,
    inputSources: () => renderer.xr.getSession()?.inputSources ?? [],

    dispose(): void {
      renderer.setAnimationLoop(null);
      screen.dispose();
      for (const panel of panels) panel.dispose();
      rayGeometry.dispose();
      rayMaterial.dispose();
      renderer.dispose();
    }
  };
}
