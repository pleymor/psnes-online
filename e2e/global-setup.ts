const API = process.env.E2E_API_URL || 'http://localhost:3000';
const APP = process.env.E2E_APP_URL || 'http://localhost:5173';

async function waitFor(label: string, url: string, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        console.log(`  ${label} ready`);
        return;
      }
    } catch {
      // not listening yet
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error(`${label} not ready after ${timeoutMs}ms (${url}). Is \`docker compose up\` running?`);
}

export default async function globalSetup() {
  console.log('e2e global setup:');
  await waitFor('backend', `${API}/health`);
  await waitFor('frontend', APP);

  // The dev server compiles routes on demand; the first navigation can take
  // longer than a test timeout. Warm it here so tests do not absorb that cost.
  await fetch(APP).catch(() => {});

  const mode = await fetch(`${API}/auth/mode`).then(r => r.json());
  if (mode.mode !== 'dev') {
    throw new Error(
      `e2e requires AUTH_MODE=dev (backend reports "${mode.mode}"). ` +
        'Add a docker-compose.override.yml setting AUTH_MODE=dev for the backend service.'
    );
  }
  console.log('  auth mode: dev');
}
