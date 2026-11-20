// main.ts — the entrypoint lifecycle for the github-core-clone-01 contest.
//
// The trial harness starts an environment server beside this process and
// tells us where it lives through MAKEFUN_ENV_URL. This file is the whole
// handshake between the two:
//
//   1. start the forge from app.ts on a kernel-chosen (ephemeral) port,
//   2. announce that port to the env with POST /register,
//   3. poll GET /done until the env says the suite has finished,
//   4. stop the server and leave with exit code 0.
//
// The forge itself lives entirely in app.ts; nothing here answers a route.
// Every call to the env carries a per-request timeout and is retried on a
// short exponential backoff, because one dropped packet must not end a
// run. Two answers end the retrying at once: the env refusing the
// register outright (400/405) is fatal, and the env reporting done ends
// the wait. Without MAKEFUN_ENV_URL there is nobody to talk to, so we
// stop immediately with exit code 1.

import { createApp } from './app.ts';

const ENV_URL_VAR = 'MAKEFUN_ENV_URL';

/** How long one request to the env may take before it counts as failed. */
const REQUEST_TIMEOUT_MS = 30_000;
/** The first pause between retries; it doubles after every failure. */
const FIRST_RETRY_MS = 250;
/** The longest pause between retries. */
const MAX_RETRY_MS = 2_000;
/** How long a clean shutdown may wait for open connections to drain. */
const SHUTDOWN_GRACE_MS = 2_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function describeFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A retry ladder that starts at FIRST_RETRY_MS, doubles, and caps at MAX_RETRY_MS. */
class RetryLadder {
  #waitMs = FIRST_RETRY_MS;

  /** Pause for the current rung, then step to the next one. */
  async rest(): Promise<void> {
    const pause = this.#waitMs;
    this.#waitMs = Math.min(MAX_RETRY_MS, this.#waitMs * 2);
    await sleep(pause);
  }
}

interface EnvReply {
  status: number;
  body: unknown;
}

/**
 * One JSON round trip with the env. The reply body is parsed when it is
 * JSON and null otherwise, so a bare error status still yields a usable
 * answer. Network failures and timeouts throw.
 */
async function callEnv(origin: string, path: string, init: RequestInit): Promise<EnvReply> {
  const response = await fetch(`${origin}${path}`, {
    ...init,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

/**
 * Announce our port to the env. 200 means the env took it, 409 means
 * another register already won and ours changes nothing, and either way we
 * go on. 400 and 405 mean the request itself is wrong, so there is no
 * point retrying. Anything else, a dropped connection included, is
 * retried until the env answers.
 */
async function registerWithEnv(origin: string, port: number): Promise<void> {
  const ladder = new RetryLadder();
  for (;;) {
    let reply: EnvReply;
    try {
      reply = await callEnv(origin, '/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
      });
    } catch (error) {
      console.error(`register attempt failed: ${describeFailure(error)}; trying again`);
      await ladder.rest();
      continue;
    }
    if (reply.status === 200 || reply.status === 409) {
      console.log(`registered port ${port} with the env (status ${reply.status})`);
      return;
    }
    if (reply.status === 400 || reply.status === 405) {
      throw new Error(`the env refused registration with status ${reply.status}`);
    }
    console.error(`register answered ${reply.status}; trying again`);
    await ladder.rest();
  }
}

/**
 * Poll GET /done until the env answers {"done": true}. A failed poll, a
 * non-JSON answer, or a false is all the same: wait a rung and ask again.
 * This never gives up on its own; only the env saying done ends it.
 */
async function waitForDone(origin: string): Promise<void> {
  const ladder = new RetryLadder();
  for (;;) {
    let reply: EnvReply;
    try {
      reply = await callEnv(origin, '/done', { method: 'GET' });
    } catch (error) {
      console.error(`done poll failed: ${describeFailure(error)}; trying again`);
      await ladder.rest();
      continue;
    }
    const body = reply.body as { done?: unknown } | null;
    if (body !== null && typeof body === 'object' && body.done === true) {
      console.log('the env reports the suite is done');
      return;
    }
    await ladder.rest();
  }
}

/** Stop the server, dropping lingering keep-alive connections after a short grace period. */
async function stopServer(server: ReturnType<typeof createApp>): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    setTimeout(() => {
      server.closeAllConnections();
      resolve();
    }, SHUTDOWN_GRACE_MS).unref();
  });
}

async function main(): Promise<number> {
  const origin = (process.env[ENV_URL_VAR] ?? '').replace(/\/+$/, '');
  if (origin === '') {
    console.error(`${ENV_URL_VAR} is not set; there is no env to register with`);
    return 1;
  }

  const server = createApp();
  const port = await new Promise<number>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once('error', onError);
    server.listen(0, () => {
      server.removeListener('error', onError);
      const bound = server.address();
      if (bound === null || typeof bound === 'string') {
        reject(new Error('the server did not bind to a TCP port'));
        return;
      }
      resolve(bound.port);
    });
  });
  console.log(`forge listening on port ${port}`);

  try {
    await registerWithEnv(origin, port);
    await waitForDone(origin);
  } catch (error) {
    console.error(`fatal: ${describeFailure(error)}`);
    await stopServer(server);
    return 1;
  }

  await stopServer(server);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(`fatal: ${describeFailure(error)}`);
    process.exit(1);
  });
