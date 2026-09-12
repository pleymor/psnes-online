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
import { createVignette } from './vignette';
import { createVrScreen, type VrScreen } from './screen';
import { sceneLayout, screenPlacement, type SceneLayout, type Placement } from './layout';
import type { ScreenShape } from './screen-shape';
import type { PixelAspect } from '$lib/znet/fit';
import { createPanelMesh, type PanelMesh } from './panel-mesh';
import { aimable, hit, type PanelSize } from './panel';
import type { PointerTarget } from './pointer';
import { TRIGGER } from './pad';
import { ROOM_DARK, CAMERA_FAR } from './decor/composition';

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
  /**
   * Ajoute un objet au GROUPE DES PANNEAUX.
   *
   * Existe pour le comptoir, et lui seul. Il épouse les panneaux, donc il doit
   * être ancré comme eux ; et en pendant dans leur groupe il s'éteint avec eux
   * quand une partie démarre, sans un état de plus - ce qui lui évite le fondu
   * que le sol, seul autre objet en deçà du rideau, doit porter.
   */
  addFurniture(object: THREE.Object3D): void;
  /** `renderer.capabilities.getMaxAnisotropy()`, dont le sol a besoin. */
  maxAnisotropy(): number;
  /**
   * La position de la tête dans la scène, pour les billboards.
   *
   * Lue sur la caméra XR plutôt que sur `getViewerPose` : c'est celle qui a
   * effectivement servi au rendu de l'image en cours, donc un billboard
   * orienté avec elle ne peut pas être en retard d'une image.
   */
  headPosition(): { x: number; y: number; z: number };
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
   * L'avant et la droite de la caméra, à plat et normalisés.
   *
   * `headPosition` ne suffit pas : elle dit où est le joueur, pas où il
   * regarde. Ces deux vecteurs sont ce qui permet à `walk.ts` de n'avoir
   * AUCUNE convention de repère à porter - et donc à son test de ne pas être
   * dupe de la même erreur de signe que le code.
   */
  headBasis(): { forward: [number, number]; right: [number, number] };
  /**
   * Où le JOUEUR se tient, en mètres dans le plan, depuis l'ancre.
   *
   * Le nom dit le sens, parce que le sens s'est trompé une fois : ce n'est
   * PAS un décalage à ajouter aux groupes. Avancer le joueur, c'est reculer
   * le monde, donc les groupes vont à l'ancre MOINS cette position. La
   * première version ajoutait, et le casque a rendu son verdict en trois
   * mots - « tous les mouvements du stick sont inversés ».
   *
   * Appliqué aux DEUX groupes : `world` porte les panneaux, le rideau et le
   * comptoir, `room` porte le décor. Les déplacer ensemble fait glisser le
   * monde entier autour du joueur, meubles compris, donc il marche PAR
   * RAPPORT à son bureau au lieu de le traîner. N'en déplacer qu'un les
   * séparerait, ce que `decor/build.ts` interdit déjà pour la hauteur.
   */
  setPlayerAt(position: readonly [number, number], yaw: number): void;
  /**
   * À quelle hauteur le joueur se tient, au-dessus du sol.
   *
   * Le monde descend d'autant : monter sur un tuyau, c'est baisser le monde de
   * deux mètres. Les QUATRE groupes bougent ensemble - le lointain comme le
   * proche - sinon le sol resterait sous les pieds pendant que le décor
   * descendrait, et le joueur marcherait sur le ciel.
   */
  setPlayerHeight(height: number): void;
  /**
   * La racine qui SUIT le joueur : ciel, sol, collines, nuages.
   *
   * Elle prend la rotation du joueur mais jamais son déplacement, ce qui fait
   * une plaine sans fin - l'horizon ne s'approche jamais, mais le bureau
   * s'éloigne vraiment. Le rideau est dans la même famille, et il le faut :
   * c'est une cagoule autour de la tête, pas un endroit qu'on peut quitter.
   */
  addFar(object: THREE.Object3D): void;
  /** La vitesse du pas, en m/s : c'est elle qui assombrit la périphérie. */
  setWalkSpeed(speed: number): void;
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
  scene.background = new THREE.Color(ROOM_DARK);

  const camera = new THREE.PerspectiveCamera(70, 1, 0.05, CAMERA_FAR);

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
  /** Où le joueur se tient, depuis l'ancre. Les groupes vont à l'ancre MOINS
   *  cette position : avancer le joueur, c'est reculer le monde. */
  let playerAt: readonly [number, number] = [0, 0];
  /** De combien le joueur a tourné sur lui-même, en radians. */
  let playerYaw = 0;
  /** À quelle hauteur il se tient : zéro sur l'herbe, deux sur un tuyau. */
  let playerHeight = 0;

  /*
   * Le groupe du LOINTAIN : ciel, sol, rideau, collines, nuages.
   *
   * Il tourne avec le joueur mais ne se déplace jamais avec lui. C'est ce qui
   * permet d'aller partout sans sortir du monde : le décor proche reste posé
   * et s'éloigne vraiment, le lointain reste centré sur la tête. On marche
   * dans une plaine sans fin, dont l'horizon ne s'approche pas - le prix
   * assumé pour ne pas avoir à poser un vrai terrain.
   */
  const far = new THREE.Group();
  scene.add(far);
  /*
   * La vignette vit dans la scène et suit la caméra à chaque image, plutôt que
   * d'en être l'ENFANT : la caméra XR de three n'est pas dans le graphe, et
   * lui accrocher des enfants est une façon connue de se retrouver avec un
   * objet qui ne bouge pas. Copier sa pose est deux lignes et ne peut pas
   * mentir.
   */
  const vignette = createVignette();
  scene.add(vignette.mesh);
  /** L'ancre elle-même, gardée pour pouvoir replacer sans la recalculer.
   *  `anchored`, plus haut, est le booléen qui dit si elle a déjà été prise. */
  let anchorAt: { world: [number, number, number]; room: [number, number, number] } = {
    world: [0, 0, 0],
    room: [0, 0, 0]
  };
  /** Les lacets de l'ancre, gardés avec elle pour la même raison. */
  let anchorYaws = { world: 0, room: 0 };

  /**
   * Repose les groupes : l'ancre, moins la position du joueur, tournée de son
   * lacet.
   *
   * La rotation se fait autour de l'ORIGINE DE L'ANCRE, qui est là où le
   * joueur s'est placé - et non autour du groupe, ce qui lui ferait décrire un
   * arc autour d'un point où il n'est pas. C'est le piège de cette fonction,
   * et l'écart avec « autour de la tête physique » se réduit à ce que le
   * joueur a bougé dans sa pièce, soit presque rien assis.
   *
   * Le lointain reçoit la rotation et pas le déplacement, d'où les deux
   * placements et non un.
   */
  function place(): void {
    /*
     * LE MONDE TOURNE AUTOUR DE L'ANCRE, PAS AUTOUR DE L'ORIGINE.
     *
     * La première version faisait tourner la position de l'ancre avec le
     * reste, ce qui plaçait le centre de rotation à l'origine de l'espace de
     * référence - là où le joueur se tenait en ouvrant la session, souvent un
     * mètre derrière lui. Rapporté du casque mot pour mot : « le centre de
     * rotation n'est pas la tête mais est derrière nous ». En gardant
     * `anchorAt` HORS de la rotation, le centre devient l'ancre, qui est la
     * tête au dernier recentrage.
     *
     * Et `playerAt` s'exprime dans le repère LOCAL du décor, celui où
     * `placement.ts` pose ses tuyaux : c'est ce qui permet de comparer la
     * position du joueur aux obstacles sans conversion. La première version
     * l'accumulait dans le repère de la racine, qui en diffère du lacet de
     * l'ancre - d'où des tuyaux qu'on traversait pendant qu'un mur invisible
     * attendait ailleurs.
     */
    const worldYaw = anchorYaws.world - playerYaw;
    const roomYaw = anchorYaws.room - playerYaw;
    const rotated = (x: number, z: number, yaw: number): [number, number] => [
      x * Math.cos(yaw) + z * Math.sin(yaw),
      -x * Math.sin(yaw) + z * Math.cos(yaw)
    ];

    const [wx, wz] = rotated(playerAt[0], playerAt[1], worldYaw);
    world.position.set(
      anchorAt.world[0] - wx,
      anchorAt.world[1] - playerHeight,
      anchorAt.world[2] - wz
    );
    world.rotation.set(0, worldYaw, 0);

    const [rx, rz] = rotated(playerAt[0], playerAt[1], roomYaw);
    room.position.set(
      anchorAt.room[0] - rx,
      anchorAt.room[1] - playerHeight,
      anchorAt.room[2] - rz
    );
    room.rotation.set(0, roomYaw, 0);

    // Le lointain ne prend que la rotation : c'est ce qui fait la plaine sans
    // fin, dont l'horizon ne s'approche jamais.
    far.position.set(anchorAt.room[0], anchorAt.room[1] - playerHeight, anchorAt.room[2]);
    far.rotation.set(0, roomYaw, 0);
  }

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
         * La vignette colle à la caméra. Copier la pose plutôt que parenter :
         * la caméra XR de three n'est pas dans le graphe de la scène, donc lui
         * accrocher un enfant donne un objet qui ne bouge pas.
         */
        const eye = renderer.xr.getCamera();
        vignette.mesh.position.copy(eye.position);
        vignette.mesh.quaternion.copy(eye.quaternion);
        vignette.mesh.translateZ(-0.28);
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
            const forRoom = roomAnchor(anchor);
            anchorAt = { world: [...anchor.position], room: [...forRoom.position] };
            anchorYaws = { world: anchor.yaw, room: forRoom.yaw };
            /*
             * Recentrer remet la marche à zéro.
             *
             * Ce bouton existe pour un joueur qui s'est perdu ; le laisser à
             * trois mètres de son bureau après l'avoir pressé serait le
             * contraire de ce qu'il promet.
             */
            playerAt = [0, 0];
            playerYaw = 0;
            playerHeight = 0;
            place();
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
    addFurniture: (object) => void panelGroup.add(object),

    maxAnisotropy: () => renderer.capabilities.getMaxAnisotropy(),

    headPosition(): { x: number; y: number; z: number } {
      // `renderer.xr.getCamera()` rend la caméra de tableau (les deux yeux) ;
      // sa position est le point milieu, ce qui est exactement le bon repère
      // pour un billboard - viser un œil plutôt que l'autre ferait pivoter le
      // décor de quelques centièmes de degré à chaque image.
      const xr = renderer.xr.getCamera();
      return { x: xr.position.x, y: xr.position.y, z: xr.position.z };
    },

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

    headBasis(): { forward: [number, number]; right: [number, number] } {
      const xr = renderer.xr.getCamera();
      /*
       * Les colonnes de la matrice monde, aplaties. La troisième pointe vers
       * l'ARRIÈRE en convention three, d'où le signe ; la première est la
       * droite.
       *
       * Le cas dégénéré est celui qu'`anchor.ts` documente : tête franchement
       * vers le haut ou le bas, l'avant aplati devient trop court pour donner
       * un cap. La parade est la sienne - prendre le cap sur le vecteur haut.
       */
      const m = xr.matrixWorld.elements;
      let fx = -m[8];
      let fz = -m[10];
      if (Math.hypot(fx, fz) < 0.01) {
        const sign = -m[9] < 0 ? 1 : -1;
        fx = sign * m[4];
        fz = sign * m[6];
      }
      const length = Math.hypot(fx, fz) || 1;
      /*
       * Tourné du lacet du joueur, et c'est indispensable.
       *
       * La caméra vit dans la racine de la scène, donc sa matrice donne le cap
       * PHYSIQUE de la tête - celui du fauteuil. Après une rotation au stick,
       * ce n'est plus ce que le joueur VOIT devant lui. Marcher « tout droit »
       * doit suivre le regard perçu, pas le fauteuil, sans quoi le stick
       * pousse de travers dès le premier cran.
       */
      /*
       * Le lacet de l'ancre s'ajoute à celui du joueur, pour que le pas
       * s'exprime dans le repère où `placement.ts` pose ses tuyaux. Sans lui,
       * les obstacles sont tournés par rapport au joueur d'un angle qui n'est
       * presque jamais nul, et on traverse un tuyau pendant qu'un mur
       * invisible attend ailleurs.
       */
      const into = playerYaw - anchorYaws.room;
      const c = Math.cos(into);
      const s2 = Math.sin(into);
      const rx = (fx / length) * c + (fz / length) * s2;
      const rz = -(fx / length) * s2 + (fz / length) * c;
      const forward: [number, number] = [rx, rz];
      // La droite est l'avant tourné d'un quart de tour : la dériver plutôt
      // que de lire une seconde colonne garantit qu'elles restent un repère.
      return { forward, right: [-forward[1], forward[0]] };
    },

    setPlayerAt(position: readonly [number, number], yaw: number): void {
      playerAt = [position[0], position[1]];
      playerYaw = yaw;
      place();
    },

    addFar: (object) => void far.add(object),

    setPlayerHeight(height: number): void {
      playerHeight = height;
      place();
    },

    setWalkSpeed: (speed: number) => vignette.setSpeed(speed),
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
      vignette.dispose();
      screen.dispose();
      for (const panel of panels) panel.dispose();
      rayGeometry.dispose();
      rayMaterial.dispose();
      renderer.dispose();
    }
  };
}
