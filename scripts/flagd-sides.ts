/**
 * Records which side of a flag at the share stage each of the traffic generator's ids is on, from flagd itself, and
 * keeps it in apps/factory/test/line/flagd-sides.json, which apps/factory/test/line/compare.test.ts holds Verify's own
 * sides to (`apps/factory/src/line/compare.ts`).
 *
 *     node scripts/flagd-sides.ts
 *
 * It runs the flagd image the cluster runs, by the digest deploy/base/flagd/flagd.yaml pins, in Docker, once for each
 * share, reading a file that holds `policy/flags.ts`'s render of two flags at that share, exactly what the admin service
 * writes. For each id it records two answers:
 *
 * - **in-process**: the flag set as flagd's sync service hands it out (`FetchAllFlags`, the payload the app's in-process
 *   provider streams), evaluated with flagd's evaluation library, the one the app evaluates with, in the context the
 *   app builds for a signed request. This is the side the app puts the id on, and the one the test holds Verify to.
 * - **rpc**: flagd's own answer over its evaluation service, which the app does not ask: another implementation of the
 *   `fractional` rule, which a flagd release may change apart from the library. It is kept for contrast; Verify works out
 *   the sides with the library, not by asking flagd.
 *
 * Run it whenever the flagd image, the evaluation library's version, `policy/flags.ts` or the generator's ids change. It
 * needs Docker, and the ports 18013 and 18015 free on 127.0.0.1.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:http2';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { signedContext } from '../apps/factory/src/line/compare.ts';
import { IDS } from '../apps/factory/src/traffic/share.ts';
import { flagsSpec, SHARES, type Share } from '../policy/flags.ts';

const ROOT = join(import.meta.dirname, '..');
const OUT = join(ROOT, 'apps/factory/test/line/flagd-sides.json');
/** Two names, as the sides depend on the name as well as the share. */
export const FLAGS = ['gift-note', 'last-one'] as const;
const NAME = 'flagd-sides';
const EVALUATION = 18013;
const SYNC = 18015;

const image = /image:\s*(ghcr\.io\/open-feature\/flagd:\S+@sha256:[0-9a-f]{64})/.exec(
  readFileSync(join(ROOT, 'deploy/base/flagd/flagd.yaml'), 'utf8'),
)?.[1];
if (!image) throw new Error('No flagd image pinned by digest in deploy/base/flagd/flagd.yaml');
// The library as the factory depends on it: the script is the repository's, not the factory's.
const factory = createRequire(join(ROOT, 'apps/factory/package.json'));
const library = (factory('@openfeature/flagd-core/package.json') as { version: string }).version;
const { FlagdCore } = (await import(
  factory.resolve('@openfeature/flagd-core')
)) as typeof import('../apps/factory/node_modules/@openfeature/flagd-core/index.d.ts');

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The flag set as flagd's sync service hands it out: one unary gRPC call, written by hand, as it has one field. */
function fetchAllFlags(): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = connect(`http://127.0.0.1:${SYNC}`);
    client.on('error', reject);
    const request = client.request({
      ':method': 'POST',
      ':path': '/flagd.sync.v1.FlagSyncService/FetchAllFlags',
      'content-type': 'application/grpc',
      te: 'trailers',
    });
    const chunks: Buffer[] = [];
    let status: string | undefined;
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('trailers', (trailers) => {
      status = String(trailers['grpc-status']);
    });
    request.on('error', reject);
    request.on('end', () => {
      client.close();
      if (status !== '0') return reject(new Error(`FetchAllFlags answered grpc-status ${status}`));
      // A gRPC frame (a byte of compression, four of length), then FetchAllFlagsResponse: field 1, a string.
      const message = Buffer.concat(chunks).subarray(5);
      if (message[0] !== 0x0a) return reject(new Error('FetchAllFlags answered something else'));
      let length = 0;
      let shift = 0;
      let at = 1;
      for (;;) {
        const byte = message[at++] as number;
        length |= (byte & 0x7f) << shift;
        if (!(byte & 0x80)) break;
        shift += 7;
      }
      resolve(message.subarray(at, at + length).toString('utf8'));
    });
    request.end(Buffer.alloc(5));
  });
}

/** flagd's own answer for one id, over its evaluation service. */
async function rpc(flag: string, id: string): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${EVALUATION}/flagd.evaluation.v1.Service/ResolveBoolean`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ flagKey: flag, context: signedContext(id) }),
  });
  if (!response.ok) throw new Error(`flagd answered ${response.status} for ${flag} and ${id}`);
  const { variant } = (await response.json()) as { variant?: string };
  if (variant !== 'on' && variant !== 'off') throw new Error(`flagd put ${id} on no side of ${flag}`);
  return variant;
}

type Recorded = Record<string, Record<Share, { on: string[]; rpcOn: string[] }>>;

async function recordAt(share: Share, recorded: Recorded): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'flagd-sides-'));
  const spec = flagsSpec(Object.fromEntries(FLAGS.map((flag) => [flag, { stage: 'share', share }])), 'r0');
  writeFileSync(join(dir, 'flags.json'), JSON.stringify(spec.flagSpec));
  // One a run before left behind, as a `docker run` that made the container but could not start it does.
  spawnSync('docker', ['rm', '--force', NAME], { stdio: 'ignore' });
  execFileSync('docker', [
    'run',
    '--detach',
    '--name',
    NAME,
    '--publish',
    `127.0.0.1:${EVALUATION}:8013`,
    '--publish',
    `127.0.0.1:${SYNC}:8015`,
    '--volume',
    `${dir}:/flags:ro`,
    image as string,
    'start',
    '--uri',
    'file:/flags/flags.json',
  ]);
  try {
    let payload: string | undefined;
    for (let tries = 0; !payload; tries++) {
      try {
        payload = await fetchAllFlags();
      } catch (error) {
        if (tries > 40) throw error;
        await sleep(250);
      }
    }
    const core = new FlagdCore();
    core.setConfigurations(payload);
    for (const flag of FLAGS) {
      const on: string[] = [];
      const rpcOn: string[] = [];
      for (const id of IDS) {
        if (core.resolveBooleanEvaluation(flag, false, signedContext(id)).variant === 'on') on.push(id);
        if ((await rpc(flag, id)) === 'on') rpcOn.push(id);
      }
      recorded[flag] = { ...recorded[flag], [share]: { on, rpcOn } } as Recorded[string];
    }
  } finally {
    // Removed before the next share's flagd takes its name: `docker stop` of a `--rm` container returns before Docker
    // has removed it, and the next `docker run --name` then finds the name still in use.
    execFileSync('docker', ['rm', '--force', NAME]);
    rmSync(dir, { recursive: true, force: true });
  }
}

const recorded: Recorded = {};
for (const share of SHARES) await recordAt(share, recorded);
writeFileSync(
  OUT,
  `${JSON.stringify(
    {
      how:
        'Recorded by scripts/flagd-sides.ts: flagd run from `image` in Docker, reading policy/flags.ts’s render of ' +
        'both flags at each share; `on` is each id flagd’s sync payload, evaluated with @openfeature/flagd-core at ' +
        '`library` in the app’s context for a signed request, turns on, and `rpcOn` each id flagd’s own ' +
        'evaluation service turns on, which the app does not ask.',
      image,
      library,
      context: signedContext('<id>'),
      sides: recorded,
    },
    null,
    2,
  )}\n`,
);
console.log(`Recorded ${FLAGS.length} flags at ${SHARES.join(', ')}% from ${image} into ${OUT}`);
