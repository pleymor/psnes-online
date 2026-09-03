/**
 * The three.js side of the immersive session: what exists, and when it draws.
 *
 * It owns the renderer, the scene, the screen and the frame pump, and it owns
 * exactly one policy: the XR animation loop pumps the governor and then
 * renders. It never decides that a frame exists - `FrameGovernor` does, through
 * the pump - which is what keeps the emulator running at 60.0988 Hz on a 72 or
 * 90 Hz display.
 *
 * A small redundancy is deliberate: `xr-session.ts` already probed for
 * `local-floor` and three requests its own reference space here. The probe is
 * what tells `layout.ts` whether the floor is real or assumed, and three gives
 * no usable answer to that question - so the space is asked for twice and the
 * answer is used once.
 */

import * as THREE from 'three';
import { createFramePump } from './frame-pump';
import { createVrScreen, type VrScreen } from './screen';
import { sceneLayout, type SceneLayout, type Placement } from './layout';
import type { SpaceType } from './xr-session';
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
  attach(session: XRSession, spaceType: SpaceType): Promise<void>;
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
  eyeHeight?: number;
  onContextLost: () => void;
}): VrScene {
  const layout = sceneLayout(opts.aspect, opts.eyeHeight);

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
    if (!panelGroup.visible) return null;

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

      const [first] = raycaster.intersectObjects(panelMeshes, false);
      if (!first?.uv) continue;

      const panel = panels.find((candidate) => candidate.mesh === first.object);
      if (!panel) continue;

      const region = hit(panel.regions, { x: first.uv.x, y: first.uv.y }, panel.size);
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

    async attach(session: XRSession, spaceType: SpaceType): Promise<void> {
      renderer.xr.setReferenceSpaceType(spaceType);
      await renderer.xr.setSession(session);
      renderer.setAnimationLoop(() => {
        // Order matters: the governor may run a frame, and the render should
        // show that frame rather than the previous one.
        pump.pump();
        for (const fn of perFrame) fn();
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
