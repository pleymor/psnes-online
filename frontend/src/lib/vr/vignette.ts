/**
 * La vignette : assombrir la périphérie pendant qu'on marche.
 *
 * C'est la seule pièce de la marche qui existe pour le CORPS et non pour
 * l'écran. Le vertige de la VR ne vient pas du mouvement mais du désaccord
 * entre ce que l'œil voit défiler et ce que l'oreille interne ne sent pas
 * bouger - et ce désaccord se lit surtout en périphérie, là où la vision est
 * la plus sensible au flux. Masquer cette périphérie pendant le déplacement
 * supprime l'essentiel du malaise, et c'est le remède standard du milieu.
 *
 * Elle disparaît à l'arrêt. Une vignette permanente coûterait du champ pour
 * rien, et le lobby est un endroit où l'on regarde autour de soi.
 *
 * Un ANNEAU et non un disque troué : le centre reste sans géométrie du tout,
 * donc sans le moindre coût de remplissage sur la zone qui porte l'image du
 * jeu. Et il est enfant de la caméra, donc toujours devant les yeux sans que
 * personne ait à le replacer.
 */
import * as THREE from 'three';

/** Où l'anneau commence, en fraction du champ. Plus petit = plus étouffant. */
const INNER = 0.62;
/** Jusqu'où il va. Au-delà du champ, pour qu'aucun bord ne se voie. */
const OUTER = 1.9;
/** À quelle distance de l'œil. Devant tout, derrière rien. */
const DISTANCE = 0.28;
/** La vitesse à laquelle la vignette est à son maximum, en m/s. */
const FULL_AT = 0.9;
/** L'opacité maximale. Assez pour masquer le flux, pas pour aveugler. */
const DARKEST = 0.72;

export interface Vignette {
  readonly mesh: THREE.Object3D;
  /** Règle l'assombrissement d'après la vitesse du pas, en m/s. */
  setSpeed(speed: number): void;
  dispose(): void;
}

export function createVignette(): Vignette {
  /*
   * Le dégradé est porté par les COULEURS DE SOMMET, pas par une texture.
   *
   * Un anneau de trente-deux segments a soixante-quatre sommets ; leur donner
   * une alpha intérieure nulle et extérieure pleine fait interpoler le dégradé
   * par le matériel, sans canvas, sans texture à téléverser, et sans le flou
   * de filtrage qu'une image de dégradé traîne toujours.
   */
  const geometry = new THREE.RingGeometry(INNER, OUTER, 32, 1);
  const alpha = new Float32Array(geometry.attributes.position.count);
  const position = geometry.attributes.position;
  for (let i = 0; i < position.count; i++) {
    const radius = Math.hypot(position.getX(i), position.getY(i));
    // Le bord intérieur est transparent, l'extérieur opaque.
    alpha[i] = radius <= INNER + 1e-6 ? 0 : 1;
  }
  geometry.setAttribute('aAlpha', new THREE.BufferAttribute(alpha, 1));

  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthTest: false,
    depthWrite: false,
    uniforms: { uOpacity: { value: 0 } },
    vertexShader: `
      attribute float aAlpha;
      varying float vAlpha;
      void main() {
        vAlpha = aAlpha;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform float uOpacity;
      varying float vAlpha;
      void main() {
        gl_FragColor = vec4(0.0, 0.0, 0.0, vAlpha * uOpacity);
      }
    `
  });

  const mesh = new THREE.Mesh(geometry, material);
  // La POSE est posée par `scene.ts`, qui copie celle de la caméra à chaque
  // image ; ici on ne décide que de la taille, à la distance qu'il utilise.
  mesh.scale.setScalar(DISTANCE);
  // Devant tout le reste, et sans profondeur : c'est un voile, pas un objet.
  mesh.renderOrder = 10_000;
  mesh.frustumCulled = false;
  mesh.visible = false;

  return {
    mesh,
    setSpeed(speed: number): void {
      const t = Math.min(1, Math.max(0, speed / FULL_AT));
      const opacity = DARKEST * t * t;
      material.uniforms.uOpacity.value = opacity;
      // Masqué plutôt que transparent quand il ne sert pas : un voile à alpha
      // zéro coûte quand même son remplissage sur tout le pourtour du champ.
      mesh.visible = opacity > 0.002;
    },
    dispose(): void {
      geometry.dispose();
      material.dispose();
    }
  };
}
