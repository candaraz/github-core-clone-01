// Thin launcher: the forge itself is the committed static Go binary ./forge.
// This file only spawns it, forwards stdio and signals, and exits with its
// code. The lifecycle (bind, register, poll for done) lives in the binary.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const binary = join(here, 'forge');

const child = spawn(binary, [], { stdio: 'inherit', env: process.env });

const forward = (signal) => {
  try {
    child.kill(signal);
  } catch {
    // The child already exited; nothing to forward to.
  }
};
process.on('SIGINT', () => forward('SIGINT'));
process.on('SIGTERM', () => forward('SIGTERM'));

child.on('error', (err) => {
  process.stderr.write(`[entry] failed to start ./forge: ${err.message}\n`);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal !== null) {
    // The child died on a signal: die the same way.
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
