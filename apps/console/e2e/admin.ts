/**
 * The console and the admin service on one origin, as the cluster serves them, for the browser tests of signing in and
 * of Martin's view, and for the ZAP scan (`apps/console/zap`): a throwaway store holding the samples, each visitor's
 * report with its text as the full events carry it (`full.ts`), the admin service and the console's server on it, each
 * as its own role, and a small proxy in front standing in for Traefik, which sends `/admin/` to the service and
 * everything else to the console's server without the `Cookie` header. So Martin's full events and a visitor's public
 * ones are the same events, from one store. It exists in the tests alone: nothing here is in an image.
 *
 * A browser signs in as Martin's would, with a virtual passkey (Chrome's WebAuthn domain, through the DevTools
 * Protocol) answering the service's own ceremonies, so the service has no way in made for tests.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { createServer, type IncomingMessage, request, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { CDPSession, Page } from '@playwright/test';
import type { NewEvent } from '@software-factory/events';
import { DiskArtifacts, EventWriter } from '@software-factory/store';
import { createDatabase, type Database, PASSWORDS, startPostgres } from '../../../packages/store/test/postgres.ts';
import type { AdminService } from '../../factory/src/admin/service.ts';
import type { RolloutRef } from '../../factory/src/release/rollout-ref.ts';
import { KubeError, type KubeWriter } from '../../factory/src/runners/kube.ts';
import { listenOn } from '../src/listen.ts';
import { full } from './full.ts';

const HERE = fileURLToPath(new URL('..', import.meta.url));
const SAMPLES = fileURLToPath(new URL('../../../packages/samples/log', import.meta.url));
const ARTIFACTS = fileURLToPath(new URL('../../../packages/samples/log/artifacts', import.meta.url));
/** The red-team attacks' test data, which `attacks.spec.ts` loads in place of the samples. */
const ATTACKS = fileURLToPath(new URL('../test/attacks/log', import.meta.url));

/** What the harness's store holds as it starts. */
export type Store = 'samples' | 'attacks' | 'empty';

export interface Harness {
  /** The one origin the browser sees, such as `http://localhost:18325`. */
  origin: string;
  database: Database;
  /** A one-time code, as `factory admin enrol` prints it. */
  code(): Promise<string>;
  /** Whether a request ever reached the console's server with a cookie: the proxy strips it, as Traefik does. */
  cookiesToConsole: number;
  stop(): Promise<void>;
}

/**
 * Starts the store, the admin service, the console's server and the proxy, with the proxy listening on `port`. With
 * `release`, the admin service controls that Rollout, through a stand-in for Kubernetes. The store holds the samples;
 * with `attacks`, the attacks' test data instead, and the service lets every attack be launched, as the flag will; with
 * `empty`, nothing at all, as a new cluster's store does before Martin first starts the line.
 */
export async function startHarness(
  port: number,
  name = 'admin',
  release?: { rollout: RolloutRef; kube: KubeWriter },
  store: Store = 'samples',
): Promise<Harness> {
  const given = process.env.TEST_DATABASE_URL;
  const postgres = given ? { url: given, stop: () => {} } : await startPostgres();
  // What is started so far, stopped in reverse: by `stop`, or when a later part cannot start. Each is stopped whatever
  // the one before it does, and the first that fails is the one `stop` throws.
  const started: (() => Promise<void> | void)[] = [() => postgres.stop()];
  const stop = async () => {
    const failed: unknown[] = [];
    for (const each of started.splice(0).reverse())
      await Promise.resolve()
        .then(each)
        .catch((e) => failed.push(e));
    if (failed.length) throw failed[0];
  };
  try {
    // The same object, not a copy: the proxy counts cookies on it.
    return Object.assign(await startOn(postgres.url, started, port, name, release, store), { stop });
  } catch (error) {
    // Why it could not start, not what stopping the rest said.
    await stop().catch(() => {});
    throw error;
  }
}

/** The rest of the harness on the store at `postgresUrl`, each part pushed on `started` as it starts. */
async function startOn(
  postgresUrl: string,
  started: (() => Promise<void> | void)[],
  port: number,
  name: string,
  release: { rollout: RolloutRef; kube: KubeWriter } | undefined,
  store: Store,
): Promise<Omit<Harness, 'stop'>> {
  const database = await createDatabase(postgresUrl, name);
  started.push(() => database.end());
  const origin = `http://localhost:${port}`;
  // The service logs each request; here only what went wrong. Its logger reads this as its module loads.
  process.env.LOG_LEVEL ??= 'warn';
  const { proxies } = await import('../../factory/src/admin/config.ts');
  const { enrol } = await import('../../factory/src/admin/enrol.ts');
  const { startAdmin } = await import('../../factory/src/admin/service.ts');
  const { endingAt, readLog } = await import('../../factory/src/events.ts');

  // The samples (or the attacks' test data), as `make samples` loads them, by Martin's command line's role, ending now.
  if (store !== 'empty') {
    const events = endingAt(readLog(store === 'attacks' ? ATTACKS : SAMPLES).map(full<NewEvent>), Date.now());
    await new EventWriter(database.operator, { kind: 'sample', artifacts: new DiskArtifacts(ARTIFACTS) }).append(
      events,
    );
  }

  // The admin service as its Deployment runs it, connected as its own role; `localhost` is a secure context, so a
  // passkey and a `Secure` cookie work over plain HTTP here.
  const admin: AdminService = await startAdmin(
    {
      origin,
      rpId: 'localhost',
      trusted: proxies(''),
      port: 0,
      profile: 'local',
      ...(release && { rollout: release.rollout }),
      ...(store === 'attacks' && { attackAvailable: () => true }),
    },
    { sql: database.admin, port: 0, host: '127.0.0.1', ...(release && { kube: release.kube }) },
  );
  started.push(() => admin.stop());
  const adminPort = (admin.server.address() as AddressInfo).port;

  const consolePort = port + 1;
  const reader = new URL(postgresUrl);
  reader.pathname = `/${database.name}`;
  reader.username = 'console_reader';
  reader.password = PASSWORDS.console;
  const console_ = await startConsole(consolePort, { DATABASE_URL: reader.href, ARTIFACTS_DIR: ARTIFACTS });
  started.push(() => stopConsole(console_));

  const harness = {
    origin,
    database,
    code: async () => (await enrol(database.enrol)).code,
    cookiesToConsole: 0,
  };
  const proxy: Server = createServer((req, res) => {
    const toAdmin = (req.url ?? '/').startsWith('/admin/');
    const headers = { ...req.headers };
    if (!toAdmin) {
      if (headers.cookie) harness.cookiesToConsole++;
      delete headers.cookie;
    }
    forward(req, res, toAdmin ? adminPort : consolePort, headers);
  });
  // A port another program holds fails here, at once, rather than when the test times out.
  await listenOn(proxy, port, '127.0.0.1');
  started.push(
    () =>
      new Promise<void>((resolve) => {
        proxy.close(() => resolve());
        proxy.closeAllConnections();
      }),
  );
  return harness;
}

function forward(req: IncomingMessage, res: ServerResponse, port: number, headers: IncomingMessage['headers']) {
  const upstream = request({ host: '127.0.0.1', port, method: req.method, path: req.url, headers }, (answer) => {
    res.writeHead(answer.statusCode ?? 502, answer.headers);
    answer.pipe(res);
  });
  upstream.on('error', () => {
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
  req.pipe(upstream);
}

/**
 * The console's server as the cluster runs it, on `store` (its read-only role's connection and the artifacts' folder),
 * listening on 127.0.0.1 alone. It is up when it says so in its log, not when something answers on its port, which
 * another program could; one holding the port makes it stop, and this throw with why.
 */
export async function startConsole(
  port: number,
  store: { DATABASE_URL: string; ARTIFACTS_DIR: string },
): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['src/server.ts'], {
    cwd: HERE,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      ...store,
      NODE_ENV: 'production',
      // Its log is read here until it says it listens, or why it could not, and passed over after.
      LOG_LEVEL: 'info',
      OTEL_SDK_DISABLED: 'true',
    },
    // What it writes to stderr, a crash as it starts, is the test's to show.
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const output = child.stdout as Readable;
  const lines = createInterface({ input: output });
  let why = '';
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('The console did not start in 10 seconds')), 10_000);
      // `close`, not `exit`: it comes once its output is read to the end, the line that says why included.
      child.once('close', (code) => {
        clearTimeout(timer);
        reject(new Error(`The console stopped as it started, with code ${code}${why && `: ${why}`}`));
      });
      lines.on('line', (line) => {
        const record = parsed(line);
        if (record.level !== undefined && record.level >= 50) why = record.err?.message ?? record.msg ?? '';
        if (record.msg?.startsWith('console listening')) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
  } catch (error) {
    await stopConsole(child);
    throw error;
  } finally {
    // Each request's log line is drained unread from here on, so a full pipe never holds the console up.
    lines.close();
    output.resume();
  }
  return child;
}

/** One of the console's log records, or nothing of one for a line that is not. */
function parsed(line: string): { level?: number; msg?: string; err?: { message?: string } } {
  try {
    return JSON.parse(line) as ReturnType<typeof parsed>;
  } catch {
    return {};
  }
}

export async function stopConsole(child: ChildProcess): Promise<void> {
  // Gone already, by its own exit or a signal: its `exit` has been and will not come again.
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    child.kill('SIGKILL');
  });
}

/**
 * A passkey on this page's device: a virtual authenticator, built in like a laptop's or a phone's, that verifies its
 * user and keeps resident keys, as Martin's do. Each page has its own, with no passkey until one is made.
 */
export async function virtualPasskey(page: Page): Promise<{ cdp: CDPSession; id: string }> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return { cdp, id: authenticatorId };
}

/** Enrols a passkey on the page's device with a code, through the enrolment door, as Martin would. */
export async function enrolThroughTheDoor(page: Page, code: string, name = 'Laptop'): Promise<void> {
  await page.goto('/?view=enrol');
  await page.getByLabel('One-time code').fill(code);
  await page.getByRole('button', { name: 'Check the code' }).click();
  await page.getByLabel('Name this passkey').fill(name);
  await page.getByRole('button', { name: 'Make a passkey' }).click();
  await page.getByText('Passkey made, and you are signed in on this device.').waitFor();
}

/**
 * A stand-in for the app's Rollout as the admin service reads it, merge-patched as Kubernetes would, keeping each patch:
 * at the samples' release in flight (v0.9.13 at 50%).
 */
export class Rollout implements KubeWriter {
  version = 1;
  readonly patches: unknown[] = [];
  /** How many of the next patches to the spec find the Rollout changed, as the controller's writes to it would. */
  specConflicts = 0;
  object: Record<string, unknown> = {
    metadata: { name: 'website', generation: 1, annotations: { 'rollout.argoproj.io/revision': '913' } },
    spec: {
      template: {
        spec: {
          containers: [
            { name: 'website', image: `ghcr.io/the-roganator/cv-worlds-worst-website@sha256:${'9'.repeat(64)}` },
          ],
        },
      },
      strategy: {
        canary: {
          steps: [
            { setWeight: 25 },
            { pause: {} },
            { analysis: {} },
            { setWeight: 50 },
            { pause: {} },
            { analysis: {} },
          ],
        },
      },
    },
    status: {
      observedGeneration: '1',
      currentPodHash: 'v8q7chmx72',
      stableRS: 'p8hwwllxzk',
      currentStepIndex: 4,
      canary: { weights: { canary: { weight: 50 } } },
    },
  };

  async get<T>(path: string, schema: { parse(v: unknown): T }): Promise<T> {
    // The app's endpoints, which Stop the line reads for a pod of the stable version ready to take the traffic back.
    if (path.endsWith('/endpointslices')) {
      const { stableRS } = (this.object as { status: { stableRS: string } }).status;
      const endpoint = { conditions: { ready: true }, targetRef: { kind: 'Pod', name: `website-${stableRS}-x7k2p` } };
      return schema.parse({ items: [{ endpoints: [endpoint] }] });
    }
    const { metadata, ...rest } = this.object as { metadata: object };
    return schema.parse({ ...rest, metadata: { ...metadata, resourceVersion: String(this.version) } });
  }

  async patch(_path: string, body: unknown): Promise<void> {
    const { metadata, ...rest } = body as { metadata?: { resourceVersion?: string } };
    const conflicts = 'spec' in rest && this.specConflicts > 0;
    if (conflicts) this.specConflicts -= 1;
    if (conflicts || (metadata?.resourceVersion && metadata.resourceVersion !== String(this.version))) {
      throw new KubeError(409, 'the object has been modified');
    }
    this.patches.push(rest);
    this.object = merged(this.object, rest) as Record<string, unknown>;
    this.version += 1;
  }

  text = async () => undefined;
  create = async () => {};
  remove = async () => {};
  replace = async () => {};
}

/** A JSON merge patch (RFC 7386). */
function merged(target: unknown, patch: unknown): unknown {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const out: Record<string, unknown> =
    target && typeof target === 'object' && !Array.isArray(target) ? { ...(target as object) } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete out[key];
    else out[key] = merged(out[key], value);
  }
  return out;
}
