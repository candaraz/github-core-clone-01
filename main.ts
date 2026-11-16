// Trial lifecycle: bind an ephemeral port, register it with the environment service, serve
// until the environment reports done, then exit 0.
//
// The harness contract, in order: the entry binds port 0 on all interfaces; it POSTs
// {"port": N} to $MAKEFUN_ENV_URL/register (a 400/405 there is a contract error and exits 1,
// anything else is retried, and a 409 means a registration already stands); it answers
// GET /healthz with 200; and it polls GET $MAKEFUN_ENV_URL/done with backoff from 250 ms to
// 2000 ms until {"done": true}, then exits 0. Nothing here depends on the wall clock for
// answers — only for retry timing.

import { Store } from './store.ts';
import { createServer } from './app.ts';

const ENV_URL = process.env.MAKEFUN_ENV_URL ?? '';
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function register(port) {
  const url = `${ENV_URL.replace(/\/$/, '')}/register`;
  let delay = 250;
  const deadline = Date.now() + 15000;
  for (;;) {
    let response = null;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ port }),
      });
    } catch {
      response = null;
    }
    if (response !== null) {
      if (response.status >= 200 && response.status < 300) return;
      if (response.status === 409) return; // a registration already stands
      if (response.status === 400 || response.status === 405) {
        console.error(`register rejected with ${response.status}; exiting`);
        process.exit(1);
      }
    }
    if (Date.now() + delay > deadline) {
      console.error('register did not succeed within the boot budget; exiting');
      process.exit(1);
    }
    await sleep(delay);
    delay = Math.min(delay * 2, 2000);
  }
}

async function waitForDone() {
  const url = `${ENV_URL.replace(/\/$/, '')}/done`;
  let delay = 250;
  for (;;) {
    try {
      const response = await fetch(url, { method: 'GET' });
      if (response.ok) {
        const payload = await response.json();
        if (payload !== null && typeof payload === 'object' && payload.done === true) return;
      }
    } catch {
      // The environment endpoint may not be answering yet; keep polling.
    }
    await sleep(delay);
    delay = Math.min(delay * 2, 2000);
  }
}

async function main() {
  if (ENV_URL === '') {
    console.error('MAKEFUN_ENV_URL is not set; refusing to start without the trial environment');
    process.exit(1);
  }
  const store = new Store();
  const server = createServer({ store, token: TOKEN });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  if (port === 0) {
    console.error('failed to bind an ephemeral port; exiting');
    process.exit(1);
  }
  await register(port);
  await waitForDone();
  server.close();
  process.exit(0);
}

main().catch((error) => {
  console.error('fatal:', error);
  process.exit(1);
});
