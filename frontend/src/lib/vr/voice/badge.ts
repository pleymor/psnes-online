/**
 * Le badge du micro, au poignet gauche : un sprite qu'on ne redessine qu'au changement.
 *
 * Un canvas rasterisé une fois par ÉTAT, pas par image - la règle de
 * `panel-mesh.ts` sur le coût d'une rasterisation à 72 Hz. Il change quand le
 * micro s'ouvre, se coupe ou qu'on se met à parler, soit quelques fois par
 * minute. Ce qu'il porte est décidé par `badge-look.ts`.
 */
import * as THREE from 'three';
import { BADGE_COLORS, badgeCrossed, type BadgeTone } from './badge-look';

const PIXELS = { width: 256, height: 80 } as const;
/** Onze centimètres sur trois et demi : lisible au poignet, sans masquer la manette. */
const METRES = { width: 0.11, height: 0.034 } as const;
/**
 * Au-dessus de la manette et vers le poignet, dans le repère du rayon de visée
 * (-Z devant). Assez haut pour ne pas se confondre avec le rayon.
 */
const OFFSET = new THREE.Vector3(0, 0.055, 0.07);

export interface MicBadge {
  object: THREE.Object3D;
  show(tone: BadgeTone, text: string): void;
  dispose(): void;
}

function drawMic(ctx: CanvasRenderingContext2D, x: number, y: number, crossed: boolean): void {
  ctx.save();
  ctx.strokeStyle = '#ffffff';
  ctx.fillStyle = '#ffffff';
  ctx.lineWidth = 5;
  ctx.lineCap = 'round';
  // La capsule.
  ctx.beginPath();
  ctx.roundRect(x - 9, y - 26, 18, 32, 9);
  ctx.fill();
  // L'arceau et le pied.
  ctx.beginPath();
  ctx.arc(x, y - 6, 17, 0.1 * Math.PI, 0.9 * Math.PI);
  ctx.moveTo(x, y + 11);
  ctx.lineTo(x, y + 22);
  ctx.stroke();
  if (crossed) {
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(x - 22, y - 28);
    ctx.lineTo(x + 22, y + 22);
    ctx.stroke();
  }
  ctx.restore();
}

export function createMicBadge(): MicBadge {
  const canvas = document.createElement('canvas');
  canvas.width = PIXELS.width;
  canvas.height = PIXELS.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('pas de contexte 2d pour le badge du micro');

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
    toneMapped: false
  });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(METRES.width, METRES.height, 1);
  sprite.position.copy(OFFSET);
  sprite.name = 'voice:badge';

  let shown = '';

  return {
    object: sprite,
    show(tone, text) {
      const key = `${tone}|${text}`;
      if (key === shown) return;
      shown = key;
      const { width, height } = PIXELS;
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = BADGE_COLORS[tone];
      ctx.beginPath();
      ctx.roundRect(2, 2, width - 4, height - 4, height / 2 - 2);
      ctx.fill();
      if (tone === 'speaking') {
        ctx.strokeStyle = '#d8ffe6';
        ctx.lineWidth = 4;
        ctx.stroke();
      }
      drawMic(ctx, 40, height / 2 + 2, badgeCrossed(tone));
      ctx.fillStyle = '#ffffff';
      ctx.font = '600 30px system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, 76, height / 2 + 1, width - 90);
      texture.needsUpdate = true;
    },
    dispose() {
      sprite.parent?.remove(sprite);
      texture.dispose();
      material.dispose();
    }
  };
}
