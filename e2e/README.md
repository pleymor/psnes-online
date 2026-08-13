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
docker compose exec backend npx prisma migrate deploy
```

`global-setup.ts` waits for both services and fails with a clear message if the
backend is not in dev auth mode.

## Running

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
| `resilience.spec.ts` | A throwing socket handler does not terminate the backend; endpoints stay up and still require auth |

The suite runs serially (`workers: 1`): rooms live in the backend's memory, and
the dev users are shared fixtures, so parallel runs would interfere.

## Notes

- Tests reset friendships between the two dev users as needed, so they can be
  run repeatedly without manual cleanup.
- `connectSocket()` waits for the server's `rooms:list` before returning.
  socket.io drops events that arrive before the server has attached its
  listeners, so emitting immediately after `connect` is not safe.
