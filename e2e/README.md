# End-to-end tests

Playwright suite covering authentication, room authorization and backend
resilience against the running stack.

## Prerequisites

The tests drive a real backend and frontend, and log in through the
`AUTH_MODE=dev` routes (there is no way to complete a Google OAuth round-trip
headlessly). Create a `docker-compose.override.yml` — it is gitignored — with:

```yaml
services:
  backend:
    environment:
      - AUTH_MODE=dev
```

Then start the stack and apply migrations:

```bash
docker compose up -d redis backend frontend
docker compose run --rm db-migration
```

`global-setup.ts` waits for both services and fails with a clear message if the
backend is not in dev auth mode.

## Running

The offline suite (`offline.spec.ts`) is the exception to everything above:
it needs no backend and no dev server, only a production build, since only a
build registers the service worker. `npm run test:e2e:offline` builds the
frontend and serves it with `vite preview` on port 4173 by itself.

```bash
npm run test:e2e        # headless
npm run test:e2e:ui     # Playwright UI mode
```

Browser: the config reuses whichever chromium build is already in
`~/.cache/ms-playwright`, so `playwright install` is not required. Override with
`E2E_CHROMIUM=/path/to/chrome`. Service URLs can be overridden with
`E2E_API_URL` and `E2E_APP_URL`.

## What is covered

| Spec | Covers |
|---|---|
| `app.spec.ts` | Dev login renders the library and fetches `/api/rooms` without a reload; a friend's room badge appears |
| `room-authz.spec.ts` | A non-member cannot act on a room; members (host *and* guest) still can; `/api/rooms` and `rooms:list` are scoped and never carry `keyConfig` |
| `friend-room-presence.spec.ts` | « Dans un salon » suit l'appartenance, trois navigateurs : A crée, B rejoint, A quitte ; C, ami des deux, voit A sortir et B rester, sans rechargement puis après ; quand B part à son tour le salon meurt et B en sort. Le compte dev 4 (`DevFour`) sert de troisième joueur |
| `resilience.spec.ts` | A throwing socket handler does not terminate the backend; endpoints stay up and still require auth |
| `room-lobby-fit.spec.ts` | Le salon en attente, deux joueurs assis, tient dans un écran de 390x844 sans défiler, bouton de lancement à l'écran |
| `offline.spec.ts` | Hors-ligne sans compte (#70), sur un build de production : après une première visite le réseau est coupé, l'accueil bascule seul en solo, une ROM fabriquée par le test se lance depuis un dossier (OPFS), sa SRAM est écrite en `.srm` à côté et retrouvée au rechargement ; même chose par IndexedDB sans sélecteur de dossier ; installabilité Chrome. Config à part : `npm run test:e2e:offline` |
| `offline-sync.spec.ts` | Hors-ligne d'abord avec un compte (#71), sur un build et un vrai backend lancé par `sync-stack.ts` (Redis à côté, `E2E_REDIS_SERVER` si le binaire n'est pas dans le PATH) : bibliothèque hors-ligne avec titres et jaquettes, SRAM écrite sur l'appareil puis envoyée au retour du réseau ; deux navigateurs sur un compte, hors-ligne tous les deux, finissent avec la plus récente en SRAM et l'autre gardée datée ; un échec de synchro visible en jeu et sur le panneau ROM. `npm run test:e2e:sync` |
| `offline-layout.spec.ts` | Hors-ligne, la mise en page d'en ligne (même config que `offline-sync.spec.ts`, `npm run test:e2e:sync`) : une ROM connue du compte et du dossier est une seule carte, avec sa jaquette, en ligne comme hors-ligne ; hors-ligne la barre et l'avatar restent, le tiroir Amis montre l'ami retenu et Inviter y est éteint avec sa raison ; le réseau revenu, l'application quitte le mode hors-ligne sans rechargement. Sans compte, la même grille, Amis éteint faute de compte. Captures côte à côte à 390x844 et 1440x900 dans `e2e/offline-shots/` |
| `room-save-starts.spec.ts` | Dans le salon en attente, un clic sur une sauvegarde lance la partie sans « Démarrer le jeu » (390x844 et 1440x900) ; un double clic n'envoie qu'un `game:start` ; bouton éteint, le clic pose la sauvegarde et dit pourquoi |
| `znet-relay.spec.ts` | Lockstep netplay relay: the room host gets player slot 1, packets cross byte for byte, a stranger cannot join or inject, oversized packets are dropped |

The suite runs serially (`workers: 1`): rooms live in the backend's memory, and
the dev users are shared fixtures, so parallel runs would interfere.

## Notes

- Tests reset friendships between the two dev users as needed, so they can be
  run repeatedly without manual cleanup.
- `connectSocket()` waits for the server's `rooms:list` before returning.
  socket.io drops events that arrive before the server has attached its
  listeners, so emitting immediately after `connect` is not safe.
