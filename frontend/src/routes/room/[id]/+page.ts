export const prerender = false;

export function load({ params }) {
  return {
    roomId: params.id
  };
}
