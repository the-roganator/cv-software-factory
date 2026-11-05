/**
 * ZAP's baseline scan of the console with Martin's session (ADR 0012), as CI runs it and `make zap` does on the Mac:
 *
 *     node apps/console/zap/scan.ts [zap-baseline.py's own options, such as -d]
 *
 * It starts the console's server and the admin service on one origin behind a proxy standing in for Traefik, on a
 * throwaway store (`../e2e/admin.ts`; TEST_DATABASE_URL names a Postgres, or Docker runs one). A browser enrols a
 * passkey with a code from `factory admin enrol` and signs in as Martin's would, with a virtual authenticator, so no
 * sign-in path made for tests exists anywhere. ZAP's baseline scan (`zap-baseline.py`: its spider, then its passive
 * rules, which read what the servers answer and send nothing of their own) then runs in its pinned image, every request
 * carrying the session (`hooks.py`).
 *
 * Every finding fails the scan unless `rules.tsv` keeps an exception for it, with its reason beside it. The report is
 * written to `apps/console/zap-report/`. The console must be built first (`pnpm --filter @software-factory/console
 * build`).
 */
import { spawn } from 'node:child_process';
import { chmodSync, copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { BROWSER_LAUNCH } from '@software-factory/factory/capture';
import { enrolThroughTheDoor, startHarness, virtualPasskey } from '../e2e/admin.ts';

/**
 * ZAP 2.17.0, by digest, moved by hand. It caps the rules but does not fix them: zap-baseline.py, started without
 * `-silent`, updates ZAP's add-ons and installs the beta passive rules as it starts, so each scan takes the newest rules
 * this ZAP can run (docs/COMPONENTS/CI-PIPELINE.md).
 */
const ZAP_IMAGE =
  'ghcr.io/zaproxy/zaproxy:2.17.0@sha256:5ccfff9a411743ab2615136a2edd7416bec9ce41572fa94e935df38c14adb2b6';

const PORT = 18_330;

/**
 * ZAP's own proxy, through which zap-baseline.py drives it. On Linux ZAP shares the host's network, where the port
 * zap-baseline.py picks for itself, at random from the range the kernel gives outgoing connections, can be taken by one
 * (ZAP's own, fetching add-ons as it starts) before ZAP listens on it. This one is below that range as Linux, macOS and
 * Windows set it by default, and clear of the harness's (`PORT` and the one after it), so only a program listening on
 * it could hold it, and then the scan stops at once (`hooks.py`).
 */
const ZAP_PORT = 18_338;

/** The status `hooks.py` ends the scan with when ZAP stops before it answers. */
const ZAP_STOPPED = 4;

/** What the scan must have reached, signed in, and how each must have answered. */
const MUST_REACH: Record<string, number> = {
  'GET /': 200,
  'GET /?view=sign-in': 200,
  'GET /admin/session': 200,
  'POST /admin/sign-in/options': 200,
};

/** Each of `MUST_REACH` that ZAP's record (`hooks.py`) does not show answered as it should be. */
function unreached(file: string): string[] {
  let reached: Record<string, number> = {};
  try {
    reached = JSON.parse(readFileSync(file, 'utf-8'));
  } catch {}
  return Object.entries(MUST_REACH)
    .filter(([request, status]) => reached[request] !== status)
    .map(([request, status]) => `${request}: ${status} expected, ${reached[request] ?? 'not sent'}`);
}
const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPORT = fileURLToPath(new URL('../zap-report/', import.meta.url));

const harness = await startHarness(PORT, 'zap');
let status = 1;
try {
  // Signed in as a browser signs in: the enrolment door, a passkey, and the cookie the service sets.
  const browser = await chromium.launch(BROWSER_LAUNCH);
  const context = await browser.newContext({ baseURL: harness.origin });
  const page = await context.newPage();
  await virtualPasskey(page);
  await enrolThroughTheDoor(page, await harness.code(), 'ZAP');
  const session = await page.evaluate(async () => (await fetch('/admin/session')).json());
  const cookie = (await context.cookies()).find((c) => c.name === '__Host-session');
  await browser.close();
  if (!cookie || typeof session?.token !== 'string') throw new Error('The browser did not sign in');

  // ZAP reads and writes its working folder as its own user.
  const work = mkdtempSync(join(tmpdir(), 'zap-'));
  chmodSync(work, 0o777);
  for (const file of ['rules.tsv', 'hooks.py']) copyFileSync(join(HERE, file), join(work, file));

  // On Linux (CI) ZAP shares the host's network. Docker Desktop reaches the host's loopback through its gateway, named
  // here so that Java takes its IPv4 address.
  const linux = process.platform === 'linux';
  const target = linux ? harness.origin : harness.origin.replace('localhost', 'console.host');
  // Not spawnSync: the proxy and the admin service answer ZAP from this process, so it must keep running.
  const zap = spawn(
    'docker',
    [
      'run',
      '--rm',
      ...(linux ? ['--network', 'host'] : ['--add-host', 'console.host:host-gateway']),
      '--volume',
      `${work}:/zap/wrk:rw`,
      // The values come from this process's environment, so they are never on a command line.
      ...['SF_SESSION_COOKIE', 'SF_CSRF_TOKEN', 'SF_TARGET', 'SF_ORIGIN'].flatMap((name) => ['--env', name]),
      // Nothing left behind that ZAP's user owns and this one could not remove.
      ...['--env', 'PYTHONDONTWRITEBYTECODE=1'],
      ZAP_IMAGE,
      'zap-baseline.py',
      ...['-t', `${target}/`, '-P', String(ZAP_PORT), '-c', 'rules.tsv', '--hook', '/zap/wrk/hooks.py'],
      ...['-r', 'report.html', '-J', 'report.json', '-w', 'report.md'],
      // Anything more is the baseline's own: `-d` to see what it does.
      ...process.argv.slice(2),
    ],
    {
      stdio: 'inherit',
      env: {
        ...process.env,
        SF_SESSION_COOKIE: `${cookie.name}=${cookie.value}`,
        SF_CSRF_TOKEN: session.token,
        SF_TARGET: target,
        SF_ORIGIN: harness.origin,
      },
    },
  );
  const exit = await new Promise<number | null>((resolve) => zap.on('close', resolve));
  rmSync(REPORT, { recursive: true, force: true });
  mkdirSync(REPORT, { recursive: true });
  cpSync(work, REPORT, { recursive: true, filter: (path) => !/\.(py|tsv)$/.test(path) });
  // On Linux what ZAP wrote is its user's; the temporary folder goes with the runner if it cannot go now.
  try {
    rmSync(work, { recursive: true, force: true });
  } catch {}
  // 0: nothing found; 1: a rule set to FAIL; 2: a warning, which is any finding `rules.tsv` keeps no exception for; 3:
  // zap-baseline.py failed; 4: ZAP stopped before it answered (`hooks.py`).
  status = exit ?? 1;
  // A scan that reached nothing would find nothing, and pass: it must have read the page, and Martin's session. When ZAP
  // stopped before it answered, that it reached nothing says no more than ZAP's log above.
  const missed = status === ZAP_STOPPED ? [] : unreached(join(REPORT, 'reached.json'));
  if (missed.length) {
    console.error(`ZAP did not reach, as it should have:\n${missed.map((line) => `  ${line}`).join('\n')}`);
    status = status || 1;
  }
  console.log(status === 0 ? 'ZAP found nothing without a reason kept for it.' : `ZAP failed the scan (${status}).`);
} finally {
  await harness.stop();
}
process.exit(status);
