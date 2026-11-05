/**
 * `factory probes`: the journeys a visitor takes, run against the app.
 *
 *     factory probes run
 *     factory probes once
 *
 * `run` looks at the app every few minutes, and at once when its version changes, and leaves a signal in the inbox
 * for each check that has failed twice in a row. `once` runs every check one time and prints what each found,
 * writing nothing to the inbox: for developing a probe. Its requests carry `UNMEASURED`, so on the app's Service they
 * count in none of the app's figures: the objectives and a canary's analysis judge the visitors' requests and the
 * traffic generator's alone. Through Traefik, whose public route removes the header, as from the host, they count like
 * a visitor's.
 *
 * `run` also serves the page reader for triage (`POST /v1/pages` with a path, and `GET /health`) on PORT, 8080 by
 * default; and for the line's Verify, on VERIFY_PORT, 8081 by default, runs a ticket's probe or crawl again
 * (`POST /v1/verify`, `probes/verify.ts`), and checks a feature flag at its stage with the probes, picturing its pages
 * in light and dark (`POST /v1/flag-check`, `probes/flag-check.ts`), one run at a time. Given CANARY_URL, the canary
 * Service's address, it pictures every page on the stable version and on the canary while a canary runs, and compares
 * them (`pictures/take.ts`), with requests that carry `UNMEASURED` too. After each release, it deletes the pictures no release needs any more.
 * And every fifteen seconds it asks whether the console and the app answer, at each address HEALTH_CHECKS names, and
 * counts each answer or failure for the alerts that page Martin when either stops answering (`probes/health.ts`).
 *
 * Settings, from the environment: APP_URL, the app's address; ARTIFACTS_DIR, the artifact store's folder (`once`
 * uses a temporary one without it); DATABASE_URL or the PG* variables, the store's Postgres, as its own role
 * (`factory_probes`); PROBE_INTERVAL, seconds between runs, 300 by default; VERSION_POLL, seconds between looks at the app's
 * version, 15 by default; CRAWL_LIMIT, the most resources a crawl that Verify asks for reads, 150 by default;
 * CANARY_URL, unset by default, when no pictures are taken; HEALTH_CHECKS, the addresses whose answers it counts, as
 * `console=<address> app=<address>` and more of either, none by default.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect, DiskArtifacts } from '@software-factory/store';
import { capturePage } from '../capture.ts';
import { listenOn } from '../listen.ts';
import { log } from '../log.ts';
import { inbox } from '../outbox.ts';
import { PictureIndex } from '../pictures/index.ts';
import { Pictures } from '../pictures/take.ts';
import { flagCheck, flagCheckKey } from '../probes/flag-check.ts';
import { healthChecks, startHealthChecks } from '../probes/health.ts';
import { PROBES, probes } from '../probes/index.ts';
import { readerServer } from '../probes/reader.ts';
import { Jobs, takingTurns, Verifications, verifyCheck, verifyServer } from '../probes/verify.ts';
import { exchange, UNMEASURED, versionOf } from '../senses/http.ts';
import { observeApp } from '../senses/observe.ts';
import { SenseRunner } from '../senses/runner.ts';
import { discover, httpGet } from '../traffic/traffic.ts';

export const USAGE = `  factory probes run
  factory probes once`;

/** The tallest a page's picture is: two screens of the browser's 800, enough to see what a release changed. */
const PICTURE_HEIGHT = 1_600;

const seconds = (name: string, fallback: number): number => {
  const value = Number(process.env[name] ?? fallback);
  if (!(value > 0)) throw new Error(`${name} is a number of seconds, more than none`);
  return value * 1000;
};

export async function run(args: string[]): Promise<number> {
  const [command] = args;
  const app = process.env.APP_URL;
  if ((command !== 'run' && command !== 'once') || args.length !== 1) {
    console.log(`Usage:\n${USAGE}`);
    return 2;
  }
  if (!app) {
    console.error('Set APP_URL to the app’s address, such as http://website.localhost:8080.');
    return 2;
  }
  if (command === 'run' && !process.env.ARTIFACTS_DIR) {
    console.error('Set ARTIFACTS_DIR to the artifact store’s folder.');
    return 2;
  }
  const store = new DiskArtifacts(process.env.ARTIFACTS_DIR ?? (await mkdtemp(join(tmpdir(), 'probes-'))));
  const sense = probes({ app: app.replace(/\/$/, ''), store, log });
  try {
    return command === 'once' ? await once(sense, app) : await loop(sense, app, store);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    return 1;
  } finally {
    await sense.close();
  }
}

async function once(sense: ReturnType<typeof probes>, app: string): Promise<number> {
  const version = await versionOf(app, UNMEASURED);
  console.log(`${app} is running ${version}\n`);
  let failed = 0;
  for (const observation of await sense.pass(version)) {
    const { check, finding, trouble } = observation;
    if (trouble) console.log(`  could not tell  ${check}: ${trouble}`);
    else if (finding) {
      failed++;
      console.log(`  FAIL  ${check}  [${finding.symptom}] ${observation.route}\n        ${finding.message}`);
    } else console.log(`  pass  ${check}`);
  }
  console.log(`\n${failed} failed.`);
  return 0;
}

async function loop(sense: ReturnType<typeof probes>, app: string, store: DiskArtifacts): Promise<number> {
  // Read first: a mistyped address fails the start, rather than leaving the console unwatched.
  const health = healthChecks(process.env.HEALTH_CHECKS);
  const sql = connect(process.env.DATABASE_URL);
  const index = new PictureIndex(sql);
  const runner = new SenseRunner({
    sense,
    log,
    version: () => versionOf(app, UNMEASURED),
    send: inbox(sql, 'probe').send,
    remember: (look, at) => index.remember(look, at),
    every: seconds('PROBE_INTERVAL', 300),
  });
  const canary = process.env.CANARY_URL?.replace(/\/$/, '');
  const pictures =
    canary &&
    new Pictures({
      stable: app.replace(/\/$/, ''),
      canary,
      version: (at) => versionOf(at, UNMEASURED),
      pages: (at) => discover(httpGet(at, { headers: UNMEASURED })),
      shoot: (at, path, { route, version, elements }) =>
        sense.withPage(async (page) => {
          await page.goto(new URL(path, at).href, { waitUntil: 'load' });
          return capturePage(page, store, { route, version, checks: elements, maxHeight: PICTURE_HEIGHT });
        }, UNMEASURED),
      index,
      store,
      log,
    });
  const limit = Number(process.env.CRAWL_LIMIT ?? 150);
  // A verification and a flag's check each run a browser over the journeys: one at a time, whichever is asked.
  const turn = takingTurns();
  const verifications = new Verifications((request) =>
    turn(() => verifyCheck((only) => observeApp(app, only, { store, log, limit }), request)),
  );
  const stable = app.replace(/\/$/, '');
  const allProbes = PROBES.map((p) => ({ sense: 'probe', check: p.id }));
  const flagChecks = new Jobs(
    (request: Parameters<typeof flagCheck>[1]) =>
      turn(() =>
        flagCheck(
          {
            version: () => versionOf(stable, UNMEASURED),
            revision: async () =>
              (await exchange(stable, '/health', { headers: UNMEASURED })).headers['x-flags-revision'],
            // The probes alone, never the crawl, with the device check, as the journeys gate runs them.
            observe: (only, preview) =>
              observeApp(stable, only ?? allProbes, { store, log, limit, device: true, preview }),
            shoot: (path, { route, version, scheme }) =>
              sense.withPage(async (page) => {
                const url = new URL(path, stable);
                if (url.origin !== new URL(stable).origin) throw new Error(`${path} is not a path on the app`);
                // Before the page loads, so it is drawn in the scheme from the first paint.
                await page.emulateMedia({ colorScheme: scheme });
                await page.goto(url.href, { waitUntil: 'load' });
                return capturePage(page, store, { route, version, maxHeight: PICTURE_HEIGHT });
              }, UNMEASURED),
            index,
            store,
            log,
          },
          request,
        ),
      ),
    flagCheckKey,
  );
  const verifier = verifyServer({
    verify: (request) => verifications.ask(request),
    flagCheck: (request) => flagChecks.ask(request),
    log,
  });
  const reader = readerServer({ app, sense, store, version: () => versionOf(app, UNMEASURED), log });
  const port = Number(process.env.PORT ?? 8080);
  const verifyPort = Number(process.env.VERIFY_PORT ?? 8081);
  try {
    await listenOn(reader, port);
    log.info({ port }, 'the page reader is listening');
    await listenOn(verifier, verifyPort);
    log.info({ port: verifyPort }, 'the verification is listening');
  } catch (error) {
    // A port it cannot have: `run` reports it and returns, so nothing left open may keep the process alive.
    if (reader.listening) await new Promise((resolve) => reader.close(resolve));
    await sql.end();
    throw error;
  }
  const stopHealth = startHealthChecks(health);
  if (health.length)
    log.info({ checks: health.map(({ target, address }) => `${target} ${address}`) }, 'checking who answers');
  else log.warn('HEALTH_CHECKS is unset: nothing says whether the console and the app answer');
  const stop = runner.start(seconds('VERSION_POLL', 15));
  const stopPictures = pictures ? pictures.start(seconds('VERSION_POLL', 15)) : async () => {};
  const stopForgetting = forgetFlagPictures(index, store);
  if (pictures) log.info({ canary }, 'pictures are taken while a canary runs');
  await new Promise<void>((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });
  await stop();
  await stopHealth();
  await stopPictures();
  await stopForgetting();
  await new Promise((resolve) => reader.close(resolve));
  await new Promise((resolve) => verifier.close(resolve));
  await sql.end();
  return 0;
}

/** How often a flag's pictures no event came to name are looked for, and how long since its last storing an image is kept. */
const FORGET_FLAG_PICTURES_MS = 6 * 60 * 60_000;
const STORED_LATELY_MS = 10 * 60_000;

/**
 * Forgets a flag's pictures no event came to name, a day after they were taken (`PictureIndex.forgetFlagPictures`),
 * when the worker starts and every six hours, with or without a canary to picture. Gives back how to stop it.
 */
function forgetFlagPictures(index: PictureIndex, store: DiskArtifacts): () => Promise<void> {
  let current: Promise<unknown> = Promise.resolve();
  const forget = () => {
    const unusedSince = new Date(Date.now() - STORED_LATELY_MS);
    current = index
      .forgetFlagPictures(new Date(), (hash) => store.remove(hash, unusedSince))
      .then((deleted) => deleted && log.info({ images: deleted }, 'deleted the flags’ pictures no event names'))
      .catch((error: unknown) => log.warn({ err: String(error) }, 'the flags’ pictures could not be forgotten'));
  };
  forget();
  const timer = setInterval(forget, FORGET_FLAG_PICTURES_MS);
  return async () => {
    clearInterval(timer);
    await current;
  };
}
