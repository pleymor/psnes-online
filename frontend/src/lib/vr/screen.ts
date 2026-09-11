/**
 * The curved screen, and the one upload per frame that feeds it.
 *
 * The texture is `stride` pixels wide, not `width`: the mesh's u stops at
 * `width / stride` (see `screen-geometry.ts`), so the padded half of every row
 * is uploaded and never sampled. That trades a little VRAM for no per-frame
 * copy at all, which is the right way round - `videoFrame()`'s repack is
 * 230 KB of memmove sixty times a second.
 *
 * The screen is a STACK of planes now, one per slot in `VR_SLOT_KEYS`, rather
 * than one textured mesh. Every plane carries the same picture and the same
 * geometry; what differs is its `slot` uniform, which makes it discard every
 * pixel another slot won, and its z offset, which is what turns a flat frame
 * into a diorama. Holes are the expected result and are not filled: a layer
 * was only ever drawn where it won the pixel, so everything in front of it
 * leaves a gap, and nothing in the frame records what was behind. Inventing
 * that is a separate, unsolved problem (`tools/vr-relief/README.md` weighs the
 * three ways); the masked stack is exact, and exact is what ships.
 *
 * Nothing here drives anything. `scene.ts` renders when the XR loop says so
 * and `FrameGovernor` decides when a frame exists, which is the rule
 * `znet/webgl-renderer.ts:8` states in capitals for the flat path.
 */

import * as THREE from 'three';
import { screenGeometry, visibleU } from './screen-geometry';
import {
  pictureUniforms,
  PICTURE_VERTEX_SHADER,
  PICTURE_FRAGMENT_SHADER
} from './picture-filter';
import type { ScreenPlacement } from './layout';
import type { DepthSurface, VideoSurface } from '$lib/znet/core';
import type { PanelSize, Region } from './panel';
import { createSlotMaskBuilder, hasSlot, SLOT_COUNT } from './slot-mask';
import { slotDepths } from './slot-depth';
import { DEFAULT_RELIEF, type ReliefPreset } from './relief-preset';
import { paintTestPattern } from './test-pattern';

export interface VrScreen {
  /**
   * Every plane of the stack, in `VR_SLOT_KEYS` order.
   *
   * Fixed at construction and never added to or removed from, which is what
   * lets `scene.ts` add them to the world once. Some of them are invisible on
   * any given frame - see `pressTargets` for why that is not the same thing as
   * them not being there.
   */
  meshes: THREE.Mesh[];
  /**
   * The planes a pointer may hit, which is at most one.
   *
   * A method rather than the whole array because the rule is not "the screen
   * is a target": it is a target only while it is a launch screen, and even
   * then only one plane of it carries the panel. Handing `scene.aimedAt` the
   * ten picture planes would make the running game's picture pressable, and a
   * ray would stop on whichever plane happened to be nearest.
   */
  pressTargets(): THREE.Object3D[];
  /** Whether a raycast hit belongs to this screen. `scene.aimedAt` asks. */
  owns(object: THREE.Object3D): boolean;
  /**
   * The frame, and the layer plane that cuts it into the stack.
   *
   * Two arguments rather than one widened surface, because they are two
   * separate views of wasm memory returned by two separate core calls, and
   * merging them would mean building a throwaway object per frame in the
   * caller - sixty allocations a second, in a loop whose GC pauses are
   * audible. The depth plane is optional on purpose: without one the whole
   * picture lands on the backdrop plane and the screen is flat, which is the
   * honest answer for a core that has no layer plane to give.
   */
  upload(surface: VideoSurface, depth?: DepthSurface): void;
  showTestPattern(): void;
  /**
   * Turns the screen into a canvas and paints it.
   *
   * The paint and the upload are one call for the reason `panel-mesh.ts`
   * gives about its own: a forgotten `needsUpdate` leaves a panel correct in
   * memory and stale on the player's face, which is the most confusing way
   * this shape can fail.
   */
  paintPanel(size: PanelSize, draw: (ctx: CanvasRenderingContext2D) => void): void;
  /**
   * Gives the screen back to the emulator.
   *
   * Explicit, because the alternative was a race the emulator won: see
   * `upload`.
   */
  showPicture(): void;
  /**
   * Moves and re-shapes the screen without disturbing what it is showing.
   *
   * The player can change the screen's distance, angular size and curvature
   * mid-session, so this exists to be called on a live mesh - during a game,
   * with a texture already uploaded, or with a panel painted on it. It keeps
   * the current mode and the current uv range: rebuilding at uMax 1 while the
   * emulator owns the screen would show the player 256 columns of stale
   * memory, which is the trap `paintPanel` already documents from the other
   * side.
   */
  reshape(placement: ScreenPlacement): void;
  /**
   * How far apart the planes stand, changed live.
   *
   * Live because the screen is built when the session opens and the game is
   * chosen afterwards, so a per-game setting cannot be a constructor
   * argument. Nothing is rebuilt: the depths are transforms, so this is ten
   * writes to `position.z`.
   */
  setRelief(preset: ReliefPreset): void;
  /**
   * Which slots the last frame actually contained, as `slot-mask.ts`' bitmask.
   *
   * Exposed because the relief panel offers one row per slot and ten rows do
   * not fit a tablet. Read at the moment the panel is painted rather than
   * subscribed to: this changes on a BG mode switch, which happens a handful
   * of times in a session and never while a settings panel is up, and a
   * callback per frame to feed a panel that is closed would be sixty
   * notifications a second for nothing.
   */
  presentSlots(): number;
  isPanel(): boolean;
  panelSize(): PanelSize | null;
  /** Replaced whenever the launch screen is laid out. `scene.aimedAt` reads it. */
  regions: Region[];
  dispose(): void;
}

/**
 * The texture behind a screen-sized panel, configured once for both callers.
 *
 * Linear both ways and no mipmaps. Nearest is wrong here - this is text and
 * box art on a two-and-a-half-metre screen, and nearest-neighbour text at an
 * angle is unreadable - but so is trilinear, for the reason `panel-mesh.ts`
 * sets out at length: mipmaps were added against a shimmer whose real cause
 * was an aliased canvas, and once that was fixed at source they only softened
 * the text. The picture next door gets the pixel-art filter instead, which is
 * a different problem with a different answer (`picture-filter.ts`).
 */
function panelTextureFor(canvas: HTMLCanvasElement): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  return texture;
}

export function createVrScreen(initial: ScreenPlacement): VrScreen {
  /** Reassigned by `reshape`, which is why this is not the parameter. */
  let placement = initial;
  /** Reassigned by `setRelief`. The ladders and the default are in `relief-preset.ts`. */
  let relief: ReliefPreset = DEFAULT_RELIEF;

  /*
   * The uniforms, shared between the ten materials by holding the same
   * objects rather than by copying values into each.
   *
   * three reads `material.uniforms[name].value` at draw time, so one write
   * here reaches every plane. That is not a micro-optimisation, it is the
   * thing that keeps them in step: ten materials each with their own copy of
   * `texSize` is ten places for a rebuild to forget one, and a plane left on
   * the previous frame's texture size samples the picture at the wrong scale
   * with nothing to say so. `slot` is the only uniform that is per-plane, and
   * it is the only one that never changes after construction.
   */
  const mapUniform: { value: THREE.DataTexture | null } = { value: null };
  const maskUniform: { value: THREE.DataTexture | null } = { value: null };
  const texSizeUniform = { value: new THREE.Vector2(1, 1) };
  const uMaxUniform = { value: 1 };

  const pictureMaterials = Array.from(
    { length: SLOT_COUNT },
    (_, slot) =>
      new THREE.ShaderMaterial({
        vertexShader: PICTURE_VERTEX_SHADER,
        fragmentShader: PICTURE_FRAGMENT_SHADER,
        uniforms: {
          map: mapUniform,
          mask: maskUniform,
          texSize: texSizeUniform,
          uMax: uMaxUniform,
          slot: { value: slot }
        }
      })
  );
  /*
   * Still two KINDS of material, swapped on a mesh, for the reason the single
   * screen had: the picture needs the pixel-art filter in `picture-filter.ts`,
   * which is a shader, while a launch screen is text and box art and wants
   * three's ordinary bilinear path with what `panelTextureFor` sets up.
   * Trying to serve both from one material is what forced the picture to
   * choose between nearest and blur in the first place.
   */
  const panelMaterial = new THREE.MeshBasicMaterial({
    // The SNES palette is already the picture; three's tone mapping would
    // crush it toward grey. The picture's shader says the same thing by
    // leaving `tonemapping_fragment` out.
    toneMapped: false
  });

  /*
   * ONE geometry for the ten planes, and the depth is a transform on top of
   * it.
   *
   * This is the choice the stack turns on, so here is what the other way
   * costs. `screen-geometry.ts` derives every vertex's z from `spec.distance`,
   * so moving a plane by giving it a larger `distance` also makes it
   * physically wider - the arc length is `distance * arc` - while
   * `layout.screenPlacement` computes the height from a FIXED reference
   * distance and would not follow. The planes would end up different shapes,
   * and a stack whose planes are different shapes does not line up even
   * head-on, which is the one thing it has to do.
   *
   * Offsetting `mesh.position.z` instead moves every vertex by the same
   * vector. The planes stay identical, so head-on they differ by a uniform
   * perspective scale about the eye and nothing else - a nearer plane looks
   * bigger, which is what being nearer means, and the whole picture stays the
   * shape the player chose. Sharing the geometry is then free, and one rebuild
   * per reshape instead of ten.
   */
  let geometry = new THREE.BufferGeometry();
  // The material parameter is widened on purpose: it is inferred from the
  // constructor argument, so without this a mesh is typed as taking only a
  // `ShaderMaterial` and swapping in the panel's is a type error.
  const meshes = pictureMaterials.map(
    (material) => new THREE.Mesh<THREE.BufferGeometry, THREE.Material>(geometry, material)
  );
  /**
   * The backdrop plane, which is also the one a panel is painted on.
   *
   * Slot 0 because it is the one slot that is always at depth 0: a launch
   * screen belongs on the glass, where the player put the screen and where
   * `scene.aimedAt` hit-tests it.
   */
  const panelPlane = meshes[0];

  let texture: THREE.DataTexture | null = null;
  let maskTexture: THREE.DataTexture | null = null;
  const maskBuilder = createSlotMaskBuilder();
  /**
   * Which planes have anything to draw, as the bitmask `slot-mask.ts` returns.
   *
   * Starts at the backdrop alone, which is what a picture with no layer plane
   * behind it is: one plane carrying the whole frame, flat.
   */
  let presentSlots = 1;
  /** Rebuilt only when the picture's shape changes - a mode switch, not a
   * frame. */
  let builtFor = { width: -1, height: -1, stride: -1 };

  let panelCanvas: HTMLCanvasElement | null = null;
  let panelCtx: CanvasRenderingContext2D | null = null;
  let panelTexture: THREE.CanvasTexture | null = null;
  let panelAt: PanelSize | null = null;
  /** Which of the two things this screen currently is. */
  let mode: 'picture' | 'panel' = 'picture';
  /** Replaced whenever the launch screen is laid out. `scene.aimedAt` reads it. */
  const regions: Region[] = [];

  /**
   * The uv range the current geometry was built for.
   *
   * Remembered because `reshape` has to rebuild with the SAME range: it is
   * called from a settings panel that knows nothing about whether the picture
   * or a menu currently owns the screen.
   */
  let builtUMax = 1;

  /**
   * Where each plane stands. Called for every change that can move one:
   * a reshape, a relief setting, and entering or leaving panel mode.
   *
   * A panel is pinned to z 0 whatever the relief says. It is one surface, not
   * a frame with layers in it, and pushing it forward would move it out from
   * under the regions `scene.aimedAt` tests the pointer against - a launch
   * screen that looks right and cannot be pressed.
   */
  function applyPlacement(): void {
    const depths = slotDepths(relief);
    meshes.forEach((mesh, slot) => {
      mesh.position.set(0, placement.centerY, mode === 'panel' ? 0 : depths[slot]);
    });
  }

  /** Only the planes with pixels this frame, and in panel mode only the one. */
  function applyPresence(): void {
    meshes.forEach((mesh, slot) => {
      mesh.visible = mode === 'panel' ? mesh === panelPlane : hasSlot(presentSlots, slot);
    });
  }

  function rebuildGeometry(uMax: number): void {
    builtUMax = uMax;
    geometry.dispose();
    const { positions, uvs, indices } = screenGeometry({
      distance: placement.distance,
      arc: placement.arc,
      height: placement.height,
      curved: placement.curved,
      uMax
    });
    geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    for (const mesh of meshes) mesh.geometry = geometry;
  }

  function rebuildPicture(width: number, height: number, stride: number): void {
    mode = 'picture';
    rebuildGeometry(visibleU(width, stride));

    texture?.dispose();
    texture = new THREE.DataTexture(
      new Uint8Array(stride * height * 4),
      stride,
      height,
      THREE.RGBAFormat
    );
    /*
     * LINEAR, where this said nearest for the whole of the project's life.
     *
     * The old comment was "smoothing it is the opposite of what anyone came
     * for", and that is still true - this is not smoothing. The filter in
     * `picture-filter.ts` computes a sample coordinate that sits exactly on a
     * texel centre everywhere except within one display pixel of a texel
     * boundary, and it needs the hardware's bilinear tap to do the blending
     * across that boundary. Left on `NearestFilter` the GPU would snap the
     * coordinate straight back to a centre, the shader would compute its
     * sub-texel offsets for nothing, and the picture would boil exactly as
     * before. These two lines are what make the shader mean anything.
     *
     * Still no mipmaps: the screen never recedes, so they would be generated
     * and never read.
     */
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    texture.colorSpace = THREE.SRGBColorSpace;
    // The core's first row is the top of the frame; a DataTexture's is the
    // bottom. Flipping here is the same single reversal `webgl-renderer.ts`
    // does with its two quads.
    texture.flipY = true;

    maskTexture?.dispose();
    maskTexture = new THREE.DataTexture(
      // Zeroes, so a picture uploaded before any layer plane arrives is all
      // backdrop - one plane, flat - rather than an arbitrary slot per pixel.
      new Uint8Array(stride * height),
      stride,
      height,
      THREE.RedFormat
    );
    /*
     * NEAREST, and this is the opposite decision to the picture's above rather
     * than a copy of the old one.
     *
     * A slot index is a name, not a quantity. Interpolating between slot 3 and
     * slot 5 gives 4, which is a layer neither neighbouring pixel is in, so a
     * bilinear mask would draw a one-pixel fringe of every edge in the frame
     * onto a plane that has nothing else on it. The shader samples at the
     * texel centre for the same reason; both have to say nearest or the fringe
     * comes back from whichever one relented.
     *
     * `flipY` matches the picture's. It must: the two are sampled with one
     * coordinate, so a mask the other way up would cut the frame with its own
     * mirror image - which looks like the layers being assigned at random
     * rather than like anything being upside down.
     */
    maskTexture.magFilter = THREE.NearestFilter;
    maskTexture.minFilter = THREE.NearestFilter;
    maskTexture.generateMipmaps = false;
    maskTexture.flipY = true;

    // The shader indexes the padded texture and stops at `uMax`; both come
    // from one place so they cannot disagree.
    const { texSize, uMax } = pictureUniforms(width, height, stride);
    mapUniform.value = texture;
    maskUniform.value = maskTexture;
    texSizeUniform.value.set(texSize[0], texSize[1]);
    uMaxUniform.value = uMax;
    meshes.forEach((mesh, slot) => {
      mesh.material = pictureMaterials[slot];
    });

    presentSlots = 1;
    applyPlacement();
    applyPresence();

    builtFor = { width, height, stride };
  }

  return {
    meshes,

    upload(surface: VideoSurface, depth?: DepthSurface): void {
      /*
       * A running game does not take the screen back by itself.
       *
       * The mode is authoritative, and it has to be. A game is still running
       * while its player recalls the panels and opens another game's launch
       * screen - `resume` exists precisely so they can go back to it - and its
       * `onFrame` keeps calling this method seventy-two times a second. When
       * this method could switch the mode, it won: the launch screen appeared
       * for exactly one frame, the emulator's picture reclaimed the screen,
       * `isPanel()` went false, and the screen dropped out of `aimedAt`'s
       * targets - so `launch` and the save rows could never be pressed again,
       * and the staged game was unreachable for the rest of the session.
       *
       * The frames are dropped, not queued: the emulator, its audio and its
       * cartridge save all keep running, and only the picture waits. That is
       * what a menu over a running game should do.
       */
      if (mode === 'panel') return;

      if (
        surface.width !== builtFor.width ||
        surface.height !== builtFor.height ||
        surface.stride !== builtFor.stride
      ) {
        rebuildPicture(surface.width, surface.height, surface.stride);
      }

      /*
       * The mask first, because it is the one that copies.
       *
       * The layer plane is read out of wasm memory here and into a buffer this
       * module owns - the LUT pass has to write somewhere - so the view's
       * lifetime ends inside this call and the warning in `depthSurface()`'s
       * header cannot catch us out. The picture below is the other case: it is
       * handed to the texture rather than copied, which is the whole point of
       * `videoSurface()`, and its view "is only valid until the next core call
       * - anything that can grow the heap invalidates it. Upload it and forget
       * it." That is satisfied because the assignment and the upload both
       * happen here, before the core runs again.
       *
       * The shapes are compared rather than assumed equal. They come from the
       * same core call today and cannot differ, but the mask texture was built
       * to the PICTURE's stride: a depth plane of another shape would be
       * uploaded into it row by row against the wrong pitch, and a skewed mask
       * is an unreadable picture with no clue what did it. One flat frame is
       * the better failure.
       */
      if (
        depth &&
        depth.width === builtFor.width &&
        depth.height === builtFor.height &&
        depth.stride === builtFor.stride
      ) {
        const mask = maskBuilder.build(depth);
        maskTexture!.image.data = mask.data;
        maskTexture!.needsUpdate = true;
        if (mask.present !== presentSlots) {
          presentSlots = mask.present;
          applyPresence();
        }
      }

      texture!.image.data = surface.data;
      texture!.needsUpdate = true;
    },

    /**
     * A picture with no emulator behind it.
     *
     * It exists so the geometry, distance, height and aspect can be judged
     * before a ROM is involved. A screen that is too low is obvious against a
     * grid and invisible against Super Mario World.
     *
     * Drawn on the backdrop plane alone, because `rebuildPicture` leaves the
     * mask at zero and nothing here writes to it. That is right rather than a
     * shortcut: a test pattern has no layers, and spreading it over ten planes
     * would put the relief itself into the picture that exists to judge the
     * geometry.
     */
    showTestPattern(): void {
      const width = 256;
      const height = 224;
      const stride = 512;
      rebuildPicture(width, height, stride);
      /*
       * Le dessin lui-même est parti dans `test-pattern.ts`, et pas par goût
       * du rangement : un tampon d'octets se vérifie sous Bun, un maillage
       * three ne s'y construit pas. Tant qu'il était ici, rien ne tenait ses
       * deux diagnostics - la cadence de seize pixels et la marge magenta -
       * et leur perte aurait été silencieuse.
       */
      paintTestPattern(texture!.image.data as Uint8Array, width, height, stride);
      texture!.needsUpdate = true;
    },

    /**
     * Turns the screen into a canvas and paints it.
     *
     * The paint and the upload are one call for the reason `panel-mesh.ts`
     * gives about its own: a forgotten `needsUpdate` leaves a panel correct in
     * memory and stale on the player's face, which is the most confusing way
     * this shape can fail.
     */
    paintPanel(size: PanelSize, draw: (ctx: CanvasRenderingContext2D) => void): void {
      if (!panelCanvas) {
        panelCanvas = document.createElement('canvas');
        panelCanvas.width = size.width;
        panelCanvas.height = size.height;
        panelCtx = panelCanvas.getContext('2d');
        if (!panelCtx) throw new Error('no 2d context for the screen panel');
        panelTexture = panelTextureFor(panelCanvas);
        panelAt = size;
      } else if (panelAt && (panelAt.width !== size.width || panelAt.height !== size.height)) {
        /*
         * A second size, honoured rather than ignored.
         *
         * The canvas is created once, so a later call with different
         * dimensions used to keep the old ones - and `panelSize()`, which is
         * what `scene.aimedAt` hit-tests against, would then report a size the
         * canvas no longer had: every press landing on the wrong region, with
         * the picture looking perfectly correct. Unreachable while the only
         * caller passes one constant, which is exactly the kind of latent
         * branch this project keeps discovering inside a headset.
         */
        panelCanvas.width = size.width;
        panelCanvas.height = size.height;
        panelAt = size;
        // The canvas element is the texture's source; resizing it blanks the
        // pixels, so three has to be told the source changed shape.
        panelTexture!.dispose();
        panelTexture = panelTextureFor(panelCanvas);
        panelMaterial.map = panelTexture;
        panelMaterial.needsUpdate = true;
      }

      if (mode !== 'panel') {
        // uMax 1, not the picture's width/stride: the game's geometry stops
        // half way across the texture, and reusing it would show the player
        // the left half of a launch screen with no clue why.
        rebuildGeometry(1);
        panelMaterial.map = panelTexture;
        panelMaterial.needsUpdate = true;
        panelPlane.material = panelMaterial;
        mode = 'panel';
        /*
         * One plane, and the other nine put away.
         *
         * A panel is not a frame with layers in it, so there is nothing for
         * the stack to separate - and leaving the picture planes up would
         * leave the last frame of the game hanging in front of the menu, each
         * of them still masked, which is the same "menu over a running game"
         * bug the comment in `upload` is a post-mortem of, wearing a different
         * hat. Both the pinning to z 0 and the hiding happen here so that
         * `rebuildPicture` is the single place that undoes them.
         */
        applyPlacement();
        applyPresence();
      }

      draw(panelCtx!);
      panelTexture!.needsUpdate = true;
    },

    /*
     * The one way out of panel mode, and the reason it is a method.
     *
     * `builtFor` is forgotten here rather than when the panel went up. The
     * shape has to be invalidated - otherwise the next frame finds it
     * unchanged, skips the rebuild, and uploads a picture into geometry built
     * for a 1024x768 canvas at full uv. But invalidating it at paint time made
     * `upload` rebuild on its very next call, which is how the emulator used
     * to steal the screen back. Doing it here means the caller decides when
     * the picture returns.
     *
     * The planes stay hidden and the panel material stays on until that
     * rebuild, exactly as the material swap always did: this marks the screen
     * as the emulator's again, it does not draw anything.
     */
    showPicture(): void {
      if (mode === 'picture') return;
      builtFor = { width: -1, height: -1, stride: -1 };
      mode = 'picture';
    },

    reshape(next: ScreenPlacement): void {
      placement = next;
      applyPlacement();
      rebuildGeometry(builtUMax);
    },

    setRelief(next: ReliefPreset): void {
      relief = next;
      applyPlacement();
    },

    presentSlots: () => presentSlots,

    pressTargets: () => (mode === 'panel' ? [panelPlane] : []),
    owns: (object: THREE.Object3D) => meshes.some((mesh) => mesh === object),

    isPanel: () => mode === 'panel',
    panelSize: () => panelAt,
    regions,

    dispose(): void {
      // One geometry for all ten planes, so one dispose - see the comment on
      // `geometry`. The materials are the per-plane thing, and each of them
      // holds a compiled program, so they are the loop.
      geometry.dispose();
      texture?.dispose();
      maskTexture?.dispose();
      panelTexture?.dispose();
      for (const material of pictureMaterials) material.dispose();
      panelMaterial.dispose();
    }
  };
}
