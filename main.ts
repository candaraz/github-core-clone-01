// Forge entrypoint: starts the HTTP server, then either registers with the
// trial environment and waits for its done signal (managed mode), or serves
// forever on $PORT for local development (standalone mode).

import { createForgeServer } from './app.ts';

const ENV_URL = process.env.MAKEFUN_ENV_URL ?? '';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function register(port: number): Promise<void> {
  const target = `${ENV_URL.replace(/\/$/, '')}/register`;
  const deadline = Date.now() + 15000;
  for (;;) {
    try {
      const response = await fetch(target, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ port }),
      });
      if (response.status === 200 || response.status === 409) return;
      console.error(`register: unexpected status ${response.status}`);
    } catch (error) {
      console.error(`register: ${(error as Error).message}`);
    }
    if (Date.now() >= deadline) throw new Error('register: timed out after 15s');
    await sleep(250);
  }
}

async function waitForDone(): Promise<void> {
  const target = `${ENV_URL.replace(/\/$/, '')}/done`;
  let delay = 250;
  for (;;) {
    try {
      const response = await fetch(target, { method: 'GET' });
      if (response.ok) {
        const payload = (await response.json()) as { done?: unknown };
        if (payload.done === true) return;
      }
    } catch (error) {
      console.error(`done poll: ${(error as Error).message}`);
    }
    await sleep(delay);
    delay = Math.min(delay * 2, 2000);
  }
}

async function main(): Promise<void> {
  const { server } = createForgeServer();
  const managed = ENV_URL !== '';

  // Let the harness stop the process cleanly: drain the server, then exit.
  // (The done poll is the normal shutdown path; this covers signals.)
  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error('forge: signal received, shutting down');
    server.closeAllConnections?.();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  if (managed) {
    const port = await new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (address && typeof address === 'object') resolve(address.port);
        else reject(new Error('could not determine bound port'));
      });
    });
    console.error(`forge: bound ephemeral port ${port}`);
    await register(port);
    console.error('forge: registered with the trial environment');
    await waitForDone();
    console.error('forge: done signal received, exiting');
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    process.exit(0);
  }

  const port = parseInt(process.env.PORT ?? '3000', 10);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(Number.isFinite(port) ? port : 3000, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const bound = address && typeof address === 'object' ? address.port : port;
  console.log(`forge listening on http://127.0.0.1:${bound} (standalone)`);
}

main().catch((error: unknown) => {
  console.error('fatal:', (error as Error).message);
  process.exit(1);
});
