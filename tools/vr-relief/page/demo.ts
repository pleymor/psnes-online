/* THROWAWAY. A SNES frame as a stack of flat planes, one per (layer, priority)
 * the PPU actually used, each placed at a distance you can set by hand.
 *
 * Two ways to paint a plane:
 *
 *   masked - the plane shows only the pixels it won. Exact, and holed: what
 *            was behind the thing in front was never drawn, so pulling the
 *            planes apart lets the viewer see through.
 *
 *   filled - the plane's own texture grown into its holes (done on the CPU,
 *            see probe3.ts). No holes; a smear where the layer had a sharp
 *            edge next to one.
 */

import * as THREE from 'three';

interface CapturedFrame {
	name: string;
	mode: number;
	bg3Priority: boolean;
	slots: { key: string; index: number }[];
}

const WIDTH = 256;
const HEIGHT = 224;
const SCREEN_W = 2.0;
const SCREEN_H = (SCREEN_W * HEIGHT) / WIDTH;
const DISTANCE = 2.6;

/** Human labels, and the default distance in "gaps" from the back plane. */
const SLOT_INFO: Record<string, { label: string; gap: number }> = {
	backdrop: { label: 'Fond (ciel)', gap: 0 },
	'bg4.lo': { label: 'BG4 arrière', gap: 0.5 },
	'bg4.hi': { label: 'BG4 avant', gap: 0.8 },
	'bg3.lo': { label: 'BG3 arrière', gap: 1 },
	// BG3 at high priority is the status-bar trick. It belongs on the glass.
	'bg3.hi': { label: 'BG3 avant (HUD)', gap: 0 },
	'bg2.lo': { label: 'BG2 arrière', gap: 2 },
	'bg2.hi': { label: 'BG2 avant', gap: 2.3 },
	'bg1.lo': { label: 'BG1 arrière', gap: 3 },
	'bg1.hi': { label: 'BG1 avant', gap: 3.3 },
	sprite: { label: 'Sprites', gap: 3.6 }
};

const VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/* A pixel belongs to exactly one plane, so masking is a discard rather than a
 * blend: no sorting to get right, and no half-transparent seam between two
 * layers that the SNES composited with hard edges. */
const SLOT_CAPACITY = 10;

const FRAGMENT = /* glsl */ `
  uniform sampler2D masked;
  uniform sampler2D filled;
  uniform sampler2D zmap;
  uniform float slot;
  uniform float fill;
  uniform float myDepth;
  uniform float depths[${SLOT_CAPACITY}];
  varying vec2 vUv;

  /* Uniform arrays cannot be indexed by a computed value in GLSL ES 1.00
   * fragment shaders, so the lookup is a fixed loop. Ten iterations. */
  float depthOfSlot(float which) {
    for (int i = 0; i < ${SLOT_CAPACITY}; i++) {
      if (abs(float(i) - which) < 0.5) return depths[i];
    }
    return 0.0;
  }

  void main() {
    float owner = floor(texture2D(zmap, vUv).r * 255.0 + 0.5);
    bool ours = abs(owner - slot) < 0.5;

    if (ours) {
      gl_FragColor = texture2D(masked, vUv);
      return;
    }

    if (fill < 0.5) discard;

    /*
     * The filled texture is scenery for a hole, and a hole only exists behind
     * something nearer. Where the pixel's real owner sits FURTHER back than
     * this plane, painting here would hide a pixel the player is supposed to
     * see - so this plane keeps out of the way. Where the owner is in front,
     * it covers this extension head-on, and the extension only appears when
     * the viewer moves far enough to look past it. Which is the point.
     */
    if (depthOfSlot(owner) <= myDepth) discard;

    gl_FragColor = texture2D(filled, vUv);
  }
`;

function loadTexture(src: string): Promise<THREE.Texture> {
	return new Promise((resolve, reject) => {
		const image = new Image();
		image.onload = () => {
			const texture = new THREE.Texture(image);
			texture.needsUpdate = true;
			/* Nearest on both. On the depth map it is not a preference: its
			 * values are labels, and an interpolated label is a layer that does
			 * not exist. */
			texture.magFilter = THREE.NearestFilter;
			texture.minFilter = THREE.NearestFilter;
			texture.generateMipmaps = false;
			resolve(texture);
		};
		image.onerror = reject;
		image.src = src;
	});
}

async function main() {
	const captured: CapturedFrame[] = await (await fetch('/generated/manifest.json')).json();
	const frames = await Promise.all(
		captured.map(async (f) => ({
			name: f.name,
			mode: f.mode,
			bg3Priority: f.bg3Priority,
			picture: await loadTexture(`/generated/${f.name}-picture.png`),
			zmap: await loadTexture(`/generated/${f.name}-z.png`),
			depth: `/generated/${f.name}-slots.png`,
			slots: await Promise.all(
				f.slots.map(async (s) => ({
					key: s.key,
					// The value baked into the mask, not this slot's rank in the
					// frame's list: a frame uses only some of the ten.
					index: s.index,
					filled: await loadTexture(`/generated/${f.name}-filled-${s.key}.png`)
				}))
			)
		}))
	);
	let current = frames[0];

	const canvas = document.querySelector<HTMLCanvasElement>('#stage')!;
	const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
	renderer.setPixelRatio(Math.min(2, devicePixelRatio));
	renderer.setClearColor(0x0d0f14);

	const scene = new THREE.Scene();
	const group = new THREE.Group();
	scene.add(group);

	const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 50);
	let yaw = 0;
	let pitch = 0;
	let eye = 0;

	const el = <T extends HTMLElement>(id: string) => document.querySelector<T>(`#${id}`)!;
	const spacingInput = el<HTMLInputElement>('spacing');
	const fillInput = el<HTMLInputElement>('fill');
	const angleInput = el<HTMLInputElement>('angle');
	const eyeInput = el<HTMLInputElement>('eye');
	const frameSelect = el<HTMLSelectElement>('frame');
	const depthImage = el<HTMLImageElement>('depthmap');
	const slotList = el<HTMLDivElement>('slots');
	const presetOut = el<HTMLTextAreaElement>('preset');
	const modeOut = el<HTMLSpanElement>('mode-out');

	/** Rebuilt whenever the frame changes: a frame uses only some slots. */
	let planes: { key: string; mesh: THREE.Mesh; material: THREE.ShaderMaterial; gap: number }[] = [];

	function buildPlanes() {
		for (const p of planes) {
			group.remove(p.mesh);
			p.mesh.geometry.dispose();
			p.material.dispose();
		}
		planes = current.slots.map((s) => {
			const material = new THREE.ShaderMaterial({
				uniforms: {
					masked: { value: current.picture },
					filled: { value: s.filled },
					zmap: { value: current.zmap },
					slot: { value: s.index },
					fill: { value: fillInput.checked ? 1 : 0 },
					myDepth: { value: 0 },
					depths: { value: new Array(SLOT_CAPACITY).fill(0) }
				},
				vertexShader: VERTEX,
				fragmentShader: FRAGMENT
			});
			const mesh = new THREE.Mesh(new THREE.PlaneGeometry(SCREEN_W, SCREEN_H, 1, 1), material);
			group.add(mesh);
			return { key: s.key, mesh, material, gap: SLOT_INFO[s.key]?.gap ?? 1 };
		});
		buildSliders();
	}

	function buildSliders() {
		slotList.replaceChildren();
		for (const plane of planes) {
			const row = document.createElement('label');
			const head = document.createElement('span');
			head.className = 'label-row';
			const name = document.createElement('span');
			name.textContent = SLOT_INFO[plane.key]?.label ?? plane.key;
			const value = document.createElement('b');
			head.append(name, value);

			const input = document.createElement('input');
			input.type = 'range';
			input.min = '0';
			input.max = '5';
			input.step = '0.1';
			input.value = String(plane.gap);

			const show = () => {
				value.textContent = `${(plane.gap * Number(spacingInput.value) * 100).toFixed(0)} cm`;
			};
			input.addEventListener('input', () => {
				plane.gap = Number(input.value);
				show();
				sync();
			});
			plane.mesh.userData.show = show;

			row.append(head, input);
			slotList.append(row);
		}
	}

	function place() {
		const x = Math.sin(yaw) * Math.cos(pitch) * DISTANCE;
		const y = Math.sin(pitch) * DISTANCE;
		const z = Math.cos(yaw) * Math.cos(pitch) * DISTANCE;
		camera.position.set(x + eye * Math.cos(yaw), y, z - eye * Math.sin(yaw));
		camera.lookAt(0, 0, 0);
	}

	function frame() {
		const width = canvas.clientWidth;
		const height = canvas.clientHeight;
		renderer.setSize(width, height, false);
		camera.aspect = width / height;
		camera.updateProjectionMatrix();
		place();
		renderer.render(scene, camera);
		requestAnimationFrame(frame);
	}

	function sync() {
		const spacing = Number(spacingInput.value);

		// Every plane needs every plane's distance, to know whether a pixel it
		// does not own sits in front of it or behind.
		const depths = new Array(SLOT_CAPACITY).fill(0);
		for (const p of planes) depths[current.slots.find((s) => s.key === p.key)!.index] = p.gap * spacing;

		for (const p of planes) {
			p.mesh.position.z = p.gap * spacing;
			p.material.uniforms.fill.value = fillInput.checked ? 1 : 0;
			p.material.uniforms.myDepth.value = p.gap * spacing;
			p.material.uniforms.depths.value = depths;
			(p.mesh.userData.show as (() => void) | undefined)?.();
		}
		eye = Number(eyeInput.value);
		el('spacing-out').textContent = `${(spacing * 100).toFixed(0)} cm`;
		el('angle-out').textContent = `${((yaw * 180) / Math.PI).toFixed(0)}°`;
		el('eye-out').textContent = `${(eye * 100).toFixed(1)} cm`;
		angleInput.value = String((yaw * 180) / Math.PI);
		modeOut.textContent = `mode ${current.mode}${current.bg3Priority ? ' + BG3Priority' : ''}`;
		presetOut.value = JSON.stringify(
			{
				mode: current.mode,
				bg3Priority: current.bg3Priority,
				spacing: Number(spacing.toFixed(3)),
				slots: Object.fromEntries(planes.map((p) => [p.key, Number((p.gap * spacing).toFixed(3))]))
			},
			null,
			2
		);
	}

	// --- drag to orbit ------------------------------------------------------
	let dragging = false;
	let lastX = 0;
	let lastY = 0;
	canvas.addEventListener('pointerdown', (e) => {
		dragging = true;
		lastX = e.clientX;
		lastY = e.clientY;
		canvas.setPointerCapture(e.pointerId);
	});
	canvas.addEventListener('pointerup', () => (dragging = false));
	canvas.addEventListener('pointermove', (e) => {
		if (!dragging) return;
		yaw = THREE.MathUtils.clamp(yaw - (e.clientX - lastX) * 0.005, -1.1, 1.1);
		pitch = THREE.MathUtils.clamp(pitch + (e.clientY - lastY) * 0.005, -0.6, 0.6);
		lastX = e.clientX;
		lastY = e.clientY;
		sync();
	});

	for (const t of frames) {
		const option = document.createElement('option');
		option.value = t.name;
		option.textContent = t.name;
		frameSelect.append(option);
	}
	frameSelect.value = current.name;
	frameSelect.addEventListener('change', () => {
		current = frames.find((t) => t.name === frameSelect.value)!;
		depthImage.src = current.depth;
		buildPlanes();
		sync();
	});

	for (const input of [spacingInput, fillInput, eyeInput]) input.addEventListener('input', sync);
	angleInput.addEventListener('input', () => {
		yaw = (Number(angleInput.value) * Math.PI) / 180;
		sync();
	});
	el<HTMLButtonElement>('reset').addEventListener('click', () => {
		yaw = 0;
		pitch = 0;
		sync();
	});

	depthImage.src = current.depth;
	buildPlanes();
	sync();
	frame();
	document.body.dataset.ready = 'yes';
}

main();
