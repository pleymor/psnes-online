/*
 * `prerender = false`, comme `/room/[id]`, et c'est délibéré.
 *
 * `+layout.ts` pose `prerender = true` pour tout le monde, et
 * `svelte.config.js` exige alors que chaque route prérendue soit nommée dans
 * `prerender.entries` - son commentaire raconte les deux fois où l'oubli a
 * cassé le déploiement. Rien dans la boucle locale ne l'attrape. Une route
 * dynamique servie par le fallback SPA échappe à ce piège par construction.
 */
export const prerender = false;

export function load({ params }) {
  return { crc32: params.crc32 };
}
