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
import { sceneLayout, type SceneLayout } from './layout';
import type { SpaceType } from './xr-session';
import type { PixelAspect } from '$lib/znet/fit';

export interface VrScene {
  screen: VrScreen;
  layout: SceneLayout;
  scene: THREE.Scene;
  /** Handed to `GovernorOptions.schedule`. */
  schedule: (run: () => void) => void;
  /** Runs every XR frame, before the render. */
  onFrame: (fn: () => void) => void;
  attach(session: XRSession, spaceType: SpaceType): Promise<void>;
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

    dispose(): void {
      renderer.setAnimationLoop(null);
      screen.dispose();
      renderer.dispose();
    }
  };
}
