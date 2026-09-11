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
import { framebufferScale } from './framebuffer-scale';
import { anchorFrom, roomAnchor } from './anchor';
import { createVrScreen, type VrScreen } from './screen';
import { sceneLayout, screenPlacement, type SceneLayout, type Placement } from './layout';
import type { ScreenShape } from './screen-shape';
import type { PixelAspect } from '$lib/znet/fit';
import { createPanelMesh, type PanelMesh } from './panel-mesh';
import { aimable, hit, type PanelSize } from './panel';
import type { PointerTarget } from './pointer';
import { TRIGGER } from './pad';

export interface VrScene {
  screen: VrScreen;
  layout: SceneLayout;
  scene: THREE.Scene;
  /** Handed to `GovernorOptions.schedule`. */
  schedule: (run: () => void) => void;
  /** Runs every XR frame, before the render. `t` is the XR timestamp, in
   *  milliseconds, exactly as three's animation loop receives it. */
  onFrame: (fn: (t: number) => void) => void;
  attach(session: XRSession): Promise<void>;
  addPanel(id: string, placement: Placement, size: PanelSize): PanelMesh;
  /**
   * Ajoute un objet au groupe `room` : un lieu posé par terre, dont la
   * hauteur ne suit pas la tête. Voir `roomAnchor`.
   */
  addDecor(object: THREE.Object3D): void;
  /**
   * Ajoute un objet au groupe `world`, avec les panneaux.
   *
   * Existe pour le rideau, et le rideau seul. Son dégagement intérieur est
   * mesuré contre l'écran, qui est ancré : le rideau doit donc l'être aussi,
   * et ne peut pas vivre dans `room` avec ce qu'il masque.
   */
  addCurtain(object: THREE.Object3D): void;
  /** `renderer.capabilities.getMaxAnisotropy()`, dont le sol a besoin. */
  maxAnisotropy(): number;
  /**
   * L'origine de `space`, exprimée dans l'espace de référence de CETTE scène.
   *
   * Existe pour mesurer le plancher (`decor/floor.ts`) sans que le reste de
   * l'app ait à connaître `XRFrame`. Rend `null` hors image ou tant que le
   * suivi n'est pas prêt, ce que l'appelant doit traiter comme « redemande »
   * et non comme « pas de sol ».
   */
  poseIn(space: unknown): { y: number } | null;
  /**
   * Re-places the scene in front of the player, at the next frame.
   *
   * Deferred rather than immediate because the viewer's pose only exists
   * inside an XR frame, and two of the three callers are outside one - the
   * reference space's `reset` event, and a button press. See `anchor.ts` for
   * why this is a decision the app has to make at all.
   */
  recenter(): void;
  /**
   * Applies a screen setting the player just changed.
   *
   * Only the screen moves: `layout.screen` is replaced and the mesh
   * re-shaped, while the panels keep the placements they were added with.
   * That is not an optimisation - `addPanel` bakes a placement into a mesh,
   * so re-placing the panels would mean rebuilding them, and `layout.ts` says
   * why they do not need to follow the screen.
   *
   * `layout` is mutated rather than replaced because callers hold it: the
   * shell reads `scene.layout` when it adds its panels.
   */
  reshapeScreen(shape: ScreenShape): void;
  panelsVisible(visible: boolean): void;
  arePanelsVisible(): boolean;
  aimedAt(): PointerTarget | null;
  triggerDown(): boolean;
  inputSources(): Iterable<XRInputSource>;
  dispose(): void;
}

export function createVrScene(opts: {
  aspect: PixelAspect;
  /** Where the player put the screen. See `screen-shape.ts`. */
  shape: ScreenShape;
  onContextLost: () => void;
  /**
   * A throw that escaped the pumped emulation slice or a per-frame callback.
   *
   * Reported, never swallowed: the loop below keeps drawing regardless, and
   * without this the player would be the only witness.
   */
  onFrameError: (err: unknown) => void;
}): VrScene {
  const layout = sceneLayout(opts.aspect, opts.shape);

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

  /*
   * Everything the player looks at, on one group that can be moved.
   *
   * The controllers are deliberately NOT in here. They are driven from the
   * reference space by `renderer.xr.getController`, so they have to stay in
   * it: putting them on this group would move the player's hands whenever the
   * room was re-anchored, which is the one thing in the scene that must never
   * move relative to their body. `aimedAt` already reads world matrices - the
   * comment inside it warns about exactly this - so the rays keep hitting a
   * group that has been transformed.
   */
  const world = new THREE.Group();
  scene.add(world);

  /*
   * Le deuxième groupe : le lieu, par opposition au cockpit.
   *
   * Frère de `world` et non son enfant, précisément parce qu'il ne doit pas
   * hériter de sa hauteur. `roomAnchor` dit pourquoi. Les contrôleurs restent
   * en dehors des deux, comme avant.
   */
  const room = new THREE.Group();
  scene.add(room);

  const screen = createVrScreen(layout.screen);
  /*
   * The whole stack, spread into the world rather than added as a group.
   *
   * A `THREE.Group` would be tidier and would break the pointer: `aimedAt`
   * below calls `intersectObjects(targets, false)`, and that `false` is "do
   * not recurse", so a group in the target list is tested for a hit on the
   * group itself - which has no geometry - and the launch screen becomes
   * unpressable with nothing thrown and nothing logged. The planes are fixed
   * at construction and never added to or removed from, so this one line is
   * the whole of it.
   */
  world.add(...screen.meshes);

  /*
   * The anchor, and the one automatic application of it.
   *
   * `anchored` is what makes the first one happen exactly once. The session is
   * granted while the Quest's boundary dialog is up, so the `local` origin -
   * and with it this whole scene - is fixed to wherever the head was during a
   * dialog the page cannot see or place. Re-anchoring on the first frame that
   * is genuinely `visible` moves that decision to after the dialog, which is
   * the whole of the fix; everything after that is the player's to ask for.
   *
   * Not repeated on every return to `visible`: a player who opens the system
   * menu mid-game and comes back has not asked for the room to move, and
   * having it jump would be worse than whatever made them open the menu.
   */
  let anchored = false;
  let recenterPending = false;

  const pump = createFramePump();
  const perFrame: Array<(t: number) => void> = [];

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

  /*
   * The panels, and no parallel array of their meshes any more.
   *
   * There used to be a `panelMeshes` alongside this, pushed to only in
   * `addPanel`, to keep an allocation out of `aimedAt`. It cannot serve that
   * purpose now: which panels are targets depends on each one's own
   * `mesh.visible`, so the list has to be filtered per call whatever it is
   * built from. `aimable` allocates exactly the array the old `targets` did,
   * so nothing regresses and there is one fewer thing to keep in step.
   */
  const panels: PanelMesh[] = [];
  const panelGroup = new THREE.Group();
  world.add(panelGroup);

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
    // `panels` rather than a parallel mesh array: the rule lives in `panel.ts`
    // now, and it has to see each mesh's own visibility - a panel that is
    // hidden must stop being a target, which `Raycaster` will not do for us.
    const targets: THREE.Object3D[] = aimable(panels, panelGroup.visible).map(
      (panel) => panel.mesh
    );
    // `pressTargets()` rather than `isPanel()` and a mesh: the screen is ten
    // planes now, and only one of them ever carries a panel. It answers with
    // that one or with nothing, so the rule stays in the module that knows it.
    targets.push(...screen.pressTargets());
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

      /*
       * The screen is not in `panels`, so it needs its own lookup rather than
       * a `find` that would silently return undefined and skip the controller.
       *
       * `owns` rather than an identity test against one mesh. This line used
       * to read `first.object === screen.mesh`, and the moment the screen
       * became a stack that comparison started falling through to the `panels`
       * lookup below, which finds nothing and skips the controller - a launch
       * screen that draws perfectly and cannot be pressed, with no error
       * anywhere. Asking the screen whether the hit is one of its own is the
       * question that stays true however many planes it grows.
       */
      if (screen.owns(first.object)) {
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

      /*
       * Foveation off, and this is a correction rather than a preference.
       *
       * three's default is MAXIMUM foveation - `WebXRManager.js:46` says so in
       * as many words, and `:506` applies it on every session - so the edges
       * of the view have been rendering at reduced resolution without anything
       * here asking for that. It is the wrong default for this scene twice
       * over. The screen spans 60 degrees, so most of the picture IS the
       * periphery; and the compositor's resolution zones are fixed to the
       * display rather than to the world, so world content crosses a zone
       * boundary whenever the head turns - which is seen as the picture
       * crawling, not as a soft edge.
       *
       * What it buys back is fill rate, and there is nothing here to spend it
       * on: four unlit quads, two lines, no lights and no shadows.
       */
      renderer.xr.setFoveation(0);

      /*
       * And the resolution to render them at. BEFORE `setSession`, like the
       * reference space above and for the same reason: three reads this while
       * creating the layer (`WebXRManager.js:435`/`:476`), so afterwards it
       * would apply to the next session rather than this one.
       *
       * Asked of the runtime rather than hardcoded - see `framebuffer-scale.ts`.
       */
      renderer.xr.setFramebufferScaleFactor(framebufferScale(session));

      await renderer.xr.setSession(session);
      /*
       * The runtime moved the origin, so the room has to be re-placed.
       *
       * Nobody listened for this before, and three does not either - it only
       * reads poses (`WebXRManager.js:918`). A `reset` is what a system
       * recenter raises, and after one the scene is still sitting at
       * coordinates that meant something in the old space.
       *
       * On three's OWN reference space, not the one `xr-session.ts` holds:
       * three requests its own (`:509`), and that is the one every pose in
       * this loop is expressed in.
       */
      const space = renderer.xr.getReferenceSpace() as
        | (EventTarget & { addEventListener(type: string, fn: () => void): void })
        | null;
      space?.addEventListener('reset', () => void (recenterPending = true));

      renderer.setAnimationLoop((time) => {
        /*
         * The anchor before anything else, so the frame that applies it also
         * draws with it - a render at the old anchor followed by a move is one
         * visible jump, at 72 Hz, for no reason.
         *
         * `visible-blurred` is the state the boundary dialog puts the session
         * in. Waiting for plain `visible` is what makes the first anchor land
         * after the dialog rather than during it.
         */
        if (!anchored && session.visibilityState === 'visible') {
          anchored = true;
          recenterPending = true;
        }
        if (recenterPending) {
          const frame = renderer.xr.getFrame();
          const referenceSpace = renderer.xr.getReferenceSpace();
          // The viewer pose read from WebXR itself rather than from three's
          // camera: it is unambiguously the head in the reference space, with
          // no question of what the camera happens to be parented to.
          const pose = referenceSpace ? frame?.getViewerPose(referenceSpace) : null;
          if (pose) {
            const { position, orientation } = pose.transform;
            const anchor = anchorFrom(
              [position.x, position.y, position.z],
              [orientation.x, orientation.y, orientation.z, orientation.w]
            );
            world.position.set(...anchor.position);
            world.rotation.set(0, anchor.yaw, 0);
            const forRoom = roomAnchor(anchor);
            room.position.set(...forRoom.position);
            room.rotation.set(0, forRoom.yaw, 0);
            recenterPending = false;
          }
          // Left pending when there is no pose yet: tracking that is not ready
          // is a reason to wait a frame, not to anchor to nothing.
        }

        // Order matters: the governor may run a frame, and the render should
        // show that frame rather than the previous one.
        try {
          pump.pump();
          for (const fn of perFrame) fn(time);
        } catch (err) {
          reportFrameError(err);
        }
        renderer.render(scene, camera);
      });
    },

    addPanel(id: string, placement: Placement, size: PanelSize): PanelMesh {
      const panel = createPanelMesh(id, placement, size);
      panels.push(panel);
      panelGroup.add(panel.mesh);
      return panel;
    },
    addDecor: (object) => void room.add(object),
    addCurtain: (object) => void world.add(object),

    maxAnisotropy: () => renderer.capabilities.getMaxAnisotropy(),

    poseIn(space: unknown): { y: number } | null {
      const frame = renderer.xr.getFrame();
      // L'espace de three, pas celui de `xr-session.ts` : c'est celui dans
      // lequel tout, dans cette boucle, est exprimé.
      const reference = renderer.xr.getReferenceSpace();
      if (!frame || !reference || !space) return null;
      /*
       * L'ORDRE des arguments est le piège, et l'inverser ne jette pas - ça
       * rend l'opposé. `getPose(space, baseSpace)` donne la pose de `space`
       * VUE DEPUIS `baseSpace` : on veut l'origine du plancher vue depuis
       * l'œil, donc un y négatif. L'inverse donnerait l'œil vu depuis le
       * plancher, donc un y positif - que `floor.ts` refuse comme « sol au
       * plafond », ce qui est précisément le garde-fou prévu pour ça.
       */
      const pose = frame.getPose(space as XRSpace, reference);
      return pose ? { y: pose.transform.position.y } : null;
    },

    recenter: () => void (recenterPending = true),
    reshapeScreen(shape: ScreenShape): void {
      layout.screen = screenPlacement(opts.aspect, shape);
      screen.reshape(layout.screen);
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
