#!/usr/bin/env node
/**
 * The forged inputs for the must-not-merge tests N3, N4 and N5 (.claude/skills/patching-harness/TESTS.md), and X1: a pull
 * request of the scratch App's in a copy, shaped as the App's own, whose change is one the judges must refuse. The input is
 * forged; everything that judges it is real (the worker's queue and watches, CI, the review gate, the merge queue,
 * admission). `./copies.sh reset` deletes every branch but main and baseline, so this runs again after each reset.
 *
 *     node forge.ts <N3a|N3b|N4|N5|X1a|X1b> [--dry-run [--at <branch>]] [--branch <name>] [--as unsigned|other-identity]
 *
 *   N3a  backward: the pin watch's branch and title for the postgres move, pinning an older real tag at its digest now
 *   N3b  a digest not served: the move's right tag, with an invented digest
 *   N4   beyond its pins: the move's real change, and one comment line in another file under deploy/
 *   N5   an image of ours not signed on main: the App's local deploy, pinning the factory at a digest of ours that
 *        build.yml on main never signed (the amd64 manifest inside a signed index, or one another identity signed)
 *   X1a  in the app copy: the scan's runtime-image move (test 10's), made by the copy's own pin step,
 *        with the Node build stage's `FROM` it brings at an older real digest of node under the move's tag, and the
 *        commit's `Pins-made-at` and `Pins-asked` lines claiming that digest, which the gate must not make the move from
 *   X1b  the same, its `Pins-made-at` years before the scan
 *
 * It prints one JSON object: the pull request's number, its branch and head, and what it forged, so the harness can find
 * it and read the judges' verdicts at that head (check runs stay with their commit after the branch moves on).
 * `--dry-run` reads only, prints the diff, branch, title and label, and pushes nothing. `--branch` forges on another
 * branch than the App's own (see the notes on timing in the report: the worker rewrites its own branches).
 *
 * Reads go through `gh` as Martin, and the registry through crane. Writes go through GitHub's API as the scratch App
 * alone (the-roganator-scratch-factory), with an installation token minted here for the one copy forged in, from the
 * Keychain's scratch-factory-github-app-key, kept in memory, never printed or written. Commits are made by
 * `createCommitOnBranch`, as the worker makes its own, so GitHub signs them as the App's.
 */
// biome-ignore-all lint/suspicious/noExplicitAny: it reads GitHub's and the registry's JSON as each gives it, untyped
import { execFileSync } from 'node:child_process';
import { createHash, createSign } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APP, FACTORY } from './catalogue.ts';
import { WORK as CLONES, SKILL } from './paths.ts';

const WORK = join(CLONES, 'factory');

// The scratch App, as app.env and the copy's code name it. Never the real factory App.
const APP_ENV = Object.fromEntries(
  readFileSync(join(SKILL, 'app.env'), 'utf8')
    .split('\n')
    .filter((line) => /^\w+=/.test(line))
    .map((line) => line.split('=', 2) as [string, string]),
);
const APP_ID = APP_ENV.SCRATCH_APP_ID;
const APP_SLUG = APP_ENV.SCRATCH_APP_SLUG;
const KEYCHAIN = 'scratch-factory-github-app-key';
if (APP_ID !== '5774780' || APP_SLUG !== 'the-roganator-scratch-factory')
  throw new Error(`app.env names ${APP_SLUG} (${APP_ID}), not the scratch App`);
const APP_BOT = `${APP_SLUG}[bot]`;

// ── The only doors out ──────────────────────────────────────────────────────────────────────────────────────────────

const COPIES_ONLY = new Set([FACTORY, APP]);
/** The copy forged in: the factory's, but for X1, the app's (set once, in main, before anything is read). */
let REPO = FACTORY;
function repoOk(repo: string) {
  if (!COPIES_ONLY.has(repo)) throw new Error(`forge: ${repo} is not a scratch copy`);
}

function sh(cmd: string, args: string[], input?: string): string {
  return execFileSync(cmd, args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    input,
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  });
}
/** A read of the copy through gh, as Martin. */
function read<T = any>(path: string): T {
  return JSON.parse(sh('gh', ['api', `repos/${REPO}/${path}`])) as T;
}
/** A file's text at a commit, through git's tree and blob, as the worker's guard reads it. */
function fileAt(ref: string, path: string): string {
  return sh('gh', ['api', `repos/${REPO}/contents/${path}?ref=${ref}`, '-H', 'Accept: application/vnd.github.raw']);
}
/** The registry, read with crane: a tag's digest now, or undefined when it is not served. */
function digestOf(reference: string): string | undefined {
  try {
    return sh('crane', ['digest', reference]).trim();
  } catch {
    return undefined;
  }
}
const tagsOf = (repository: string) => sh('crane', ['ls', repository]).split('\n').filter(Boolean);

// ── The scratch App's token, minted here, kept in memory ────────────────────────────────────────────────────────────

const b64url = (data: string | Buffer) => Buffer.from(data).toString('base64url');
let token: string | undefined;
async function appToken(): Promise<string> {
  if (token) return token;
  const pem = Buffer.from(sh('security', ['find-generic-password', '-s', KEYCHAIN, '-w']).trim(), 'base64').toString();
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: APP_ID }))}`;
  const jwt = `${unsigned}.${b64url(createSign('RSA-SHA256').update(unsigned).sign(pem))}`;
  const app = await github('GET', '/app', undefined, jwt);
  if (String(app.id) !== APP_ID || app.slug !== APP_SLUG)
    throw new Error(`the Keychain's key is ${app.slug}'s, not the scratch App's`);
  const installation = await github('GET', `/repos/${REPO}/installation`, undefined, jwt);
  // A token for the copy forged in alone: nothing it is handed can reach another repository.
  const minted = await github(
    'POST',
    `/app/installations/${installation.id}/access_tokens`,
    { repositories: [REPO.split('/')[1]], permissions: { contents: 'write', pull_requests: 'write' } },
    jwt,
  );
  token = minted.token as string;
  return token;
}
/** A call to GitHub's API: with a JWT for the App's own calls, else as the App's installation in the copy. */
async function github(method: string, path: string, body?: unknown, jwt?: string): Promise<any> {
  if (!jwt) {
    const at = /^\/repos\/([^/]+\/[^/]+)\//.exec(path)?.[1];
    if (path !== '/graphql') repoOk(at ?? '');
  }
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${jwt ?? (await appToken())}`,
      'x-github-api-version': '2022-11-28',
      'user-agent': 'patching-harness-forge',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : undefined;
}

// ── What a forgery is ───────────────────────────────────────────────────────────────────────────────────────────────

interface Forgery {
  test: string;
  branch: string;
  title: string;
  /** The label the App's own pull request of this kind carries, if any. */
  label?: string;
  /** The commit message's body, below its headline (X1's forged trailers). */
  body?: string;
  /** Each file's text at main's head, and as the forgery writes it. */
  files: { path: string; before: string; after: string }[];
  forged: Record<string, unknown>;
  /** The judge expected to stop it first, and those behind. */
  expect: string[];
}

/** The pin watch's branch for a move (pin-guard.ts's pinBranchFor, read from the copy, as it is the copy's rule). */
async function pinBranchFor(name: string): Promise<string> {
  const { pinBranchFor: rule } = await import(join(WORK, 'apps/factory/src/github/pin-guard.ts'));
  return rule(name);
}
/** The watch's title (pins.ts's pinTitle). */
const pinTitle = (name: string, to: string) =>
  `chore(pin): move ${name.replace(/[`\r\n]/g, '')} to ${to}`.slice(0, 256);

const POSTGRES_FILE = 'deploy/base/postgres/statefulset.yaml';
const POSTGRES = /^(\s*image:\s*)postgres:((\d+)\.(\d+)(-[\w.]+))@(sha256:[0-9a-f]{64})\s*$/;

/** The postgres pin at main's head: its line, tag and digest, and the tag's line (major and variant). */
function postgresPin(head: string) {
  const text = fileAt(head, POSTGRES_FILE);
  const lines = text.split('\n');
  const index = lines.findIndex((line) => POSTGRES.test(line));
  if (index < 0) throw new Error(`no postgres pin in ${POSTGRES_FILE} at ${head.slice(0, 7)}`);
  const [, lead, tag, major, minor, variant, digest] = POSTGRES.exec(lines[index] as string) as unknown as string[];
  return {
    text,
    lines,
    index,
    lead: lead as string,
    tag: tag as string,
    major: Number(major),
    minor: Number(minor),
    variant: variant as string,
    digest: digest as string,
  };
}
/** The tags on the pin's line (same major, same variant), by minor. */
function postgresLine(major: number, variant: string) {
  const exact = new RegExp(`^${major}\\.(\\d+)${variant.replace(/\./g, '\\.')}$`);
  return tagsOf('docker.io/library/postgres')
    .map((tag) => ({ tag, minor: Number(exact.exec(tag)?.[1] ?? NaN) }))
    .filter((t) => !Number.isNaN(t.minor))
    .sort((a, b) => a.minor - b.minor);
}
/**
 * The move the scan names for postgres, from the latest finished scan on main that lists one; or, with none, the
 * newest tag on the pin's line at its digest now, as the scan resolves a fix (deadlines.ts's newestOf).
 */
function postgresMove(pin: ReturnType<typeof postgresPin>): {
  name: string;
  tag: string;
  digest: string;
  from: string;
} {
  const runs =
    read<any>('actions/workflows/vulnerabilities.yml/runs?branch=main&status=completed&per_page=10').workflow_runs ??
    [];
  const into = mkdtempSync(join(tmpdir(), 'forge-moves-'));
  try {
    for (const run of runs.filter((r: any) => r.event !== 'pull_request').slice(0, 3)) {
      try {
        sh('gh', ['run', 'download', String(run.id), '-R', REPO, '-n', 'moves', '-D', join(into, String(run.id))]);
      } catch {
        continue;
      }
      const moves = JSON.parse(readFileSync(join(into, String(run.id), 'moves.json'), 'utf8')).moves as any[];
      const move = moves.find((m) => m.pins?.some((p: any) => p.file === POSTGRES_FILE));
      const to = /^image (\S+)@(sha256:[0-9a-f]{64})$/.exec(move?.to ?? '');
      if (move && to)
        return { name: move.name, tag: to[1] as string, digest: to[2] as string, from: `the scan's run ${run.id}` };
      break; // The newest scan with moves lists none for postgres: the registry decides.
    }
  } finally {
    rmSync(into, { recursive: true, force: true });
  }
  const newest = postgresLine(pin.major, pin.variant).at(-1);
  if (!newest || newest.minor <= pin.minor)
    throw new Error(`postgres ${pin.tag} has no newer tag on its line: no move to forge on`);
  const digest = digestOf(`docker.io/library/postgres:${newest.tag}`);
  if (!digest) throw new Error(`postgres:${newest.tag} is listed and not served`);
  return { name: 'postgres', tag: newest.tag, digest, from: 'the registry (no scan on main lists a postgres move)' };
}
const repin = (pin: ReturnType<typeof postgresPin>, tag: string, digest: string) => {
  const lines = [...pin.lines];
  lines[pin.index] = `${pin.lead}postgres:${tag}@${digest}`;
  return lines.join('\n');
};

async function forgePin(test: 'N3a' | 'N3b' | 'N4', head: string, branchOver?: string): Promise<Forgery> {
  const pin = postgresPin(head);
  const move = postgresMove(pin);
  const branch = branchOver ?? (await pinBranchFor(move.name));
  const base = { file: POSTGRES_FILE, line: pin.index + 1, was: `${pin.tag}@${pin.digest}` };
  if (test === 'N3a') {
    const older = postgresLine(pin.major, pin.variant)
      .filter((t) => t.minor < pin.minor)
      .at(-1);
    if (!older) throw new Error(`postgres ${pin.tag} has no older tag on its line`);
    const digest = digestOf(`docker.io/library/postgres:${older.tag}`);
    if (!digest) throw new Error(`postgres:${older.tag} is listed and not served`);
    return {
      test,
      branch,
      title: pinTitle(move.name, older.tag),
      label: 'pin',
      files: [{ path: POSTGRES_FILE, before: pin.text, after: repin(pin, older.tag, digest) }],
      forged: {
        ...base,
        to: `${older.tag}@${digest}`,
        what: 'backward: an older real tag on the line, at its digest now',
        move: move.name,
        moveFrom: move.from,
      },
      expect: [
        "the worker's queue (head not the watch's commit)",
        'the review gate: pin-move condition 4, forward on its line',
      ],
    };
  }
  if (test === 'N3b') {
    // A digest nothing serves: the hash of words, checked against the registry.
    const digest = `sha256:${createHash('sha256').update(`forged N3b postgres:${move.tag} ${head}`).digest('hex')}`;
    if (digestOf(`docker.io/library/postgres@${digest}`)) throw new Error('the invented digest is served');
    return {
      test,
      branch,
      title: pinTitle(move.name, move.tag),
      label: 'pin',
      files: [{ path: POSTGRES_FILE, before: pin.text, after: repin(pin, move.tag, digest) }],
      forged: {
        ...base,
        to: `${move.tag}@${digest}`,
        what: "the move's tag, at a digest the registry does not serve",
        realDigest: move.digest,
        move: move.name,
        moveFrom: move.from,
      },
      expect: [
        "the worker's queue (head not the watch's commit)",
        'the review gate: pin-move condition 4 (the tag at its index digest now)',
        'required checks: the `tests` shards and `platform` cannot pull the image',
      ],
    };
  }
  // N4: the move's real change, and one comment line in another file under deploy/.
  const other = 'deploy/base/postgres/kustomization.yaml';
  const text = fileAt(head, other);
  const comment = "# The factory's database: one StatefulSet, its data on the state volume.";
  return {
    test,
    branch,
    title: pinTitle(move.name, move.tag),
    label: 'pin',
    files: [
      { path: POSTGRES_FILE, before: pin.text, after: repin(pin, move.tag, move.digest) },
      { path: other, before: text, after: `${comment}\n${text}` },
    ],
    forged: {
      ...base,
      to: `${move.tag}@${move.digest}`,
      what: `the real move, and a comment added at the top of ${other}`,
      extra: { file: other, line: 1, text: comment },
      move: move.name,
      moveFrom: move.from,
    },
    expect: ["the worker's queue (head not the watch's commit)", 'the review gate: pin-move condition 1, pins only'],
  };
}

/** The copy's own unsigned and other-identity images, as its admission-refusals.sh names them. */
function oursUnsigned(as: 'unsigned' | 'other-identity'): string {
  const script = readFileSync(join(WORK, 'scripts/admission-refusals.sh'), 'utf8');
  const key = as === 'unsigned' ? 'factory_unsigned' : 'factory_other';
  const found = new RegExp(`^${key}=(ghcr\\.io/${REPO}/factory@sha256:[0-9a-f]{64})$`, 'm').exec(script)?.[1];
  if (!found) throw new Error(`the copy's admission-refusals.sh names no ${key} in ${REPO}`);
  if (!digestOf(found)) throw new Error(`${found} is not served`);
  return found;
}

async function forgeDeploy(head: string, as: 'unsigned' | 'other-identity', branchOver?: string): Promise<Forgery> {
  const file = 'deploy/overlays/local/factory-image/kustomization.yaml';
  const text = fileAt(head, file);
  const lines = text.split('\n');
  const name = lines.findIndex((line) => /^\s*name: factory\s*$/.test(line));
  const at = lines.slice(0, name).findLastIndex((line) => /^- digest: sha256:[0-9a-f]{64}$/.test(line));
  if (name < 0 || at < 0 || name - at > 2) throw new Error(`no factory digest in ${file} at ${head.slice(0, 7)}`);
  const image = oursUnsigned(as);
  const digest = image.split('@')[1] as string;
  const was = (lines[at] as string).slice('- digest: '.length);
  if (was === digest) throw new Error(`${file} pins ${digest} already`);
  lines[at] = `- digest: ${digest}`;
  return {
    test: 'N5',
    branch: branchOver ?? 'deploy/local',
    // The deploy watch's title (deploys.ts's deployTitle) for the factory's pin alone, at main's head.
    title: `chore(deploy): run the factory ${head.slice(0, 7)} on the local cluster`,
    label: 'deploy: local',
    files: [{ path: file, before: text, after: lines.join('\n') }],
    forged: {
      file,
      line: at + 1,
      was,
      to: digest,
      image,
      what:
        as === 'unsigned'
          ? 'the amd64 manifest inside a signed build: no signature of its own'
          : 'the arm64 manifest inside a build, signed by other-identity.yml, not build.yml on main',
    },
    expect: [
      "the worker's queue (head not the deploy watch's commit; and it rewrites deploy/local within a poll)",
      'the review gate: exact-pin, each image signed by build.yml on main',
      'admission (verify-images), were it ever merged',
    ],
  };
}

// ── X1: the app's move, with a tag it brings at a digest the scan never named ──────────────────────────────────────

/** The move X1 forges on: test 10's, the runtime image, which brings the Node build stage's `FROM` with it. */
const RUNTIME = 'gcr.io/distroless/nodejs24-debian13';
/** The build stage's `FROM` of Node: its tag and digest, and what follows. */
const NODE_FROM = /^FROM node:(\S+)@(sha256:[0-9a-f]{64})(.*)$/m;

/** The newest finished scan of main whose moves name `name`: the move as moves.json gives it, and when it judged. */
function scannedMove(name: string): { move: any; judged: string; run: number } {
  const runs =
    read<any>('actions/workflows/vulnerabilities.yml/runs?branch=main&status=completed&per_page=10').workflow_runs ??
    [];
  const into = mkdtempSync(join(tmpdir(), 'forge-moves-'));
  try {
    for (const run of runs.filter((r: any) => r.event !== 'pull_request').slice(0, 3)) {
      try {
        sh('gh', ['run', 'download', String(run.id), '-R', REPO, '-n', 'moves', '-D', join(into, String(run.id))]);
      } catch {
        continue;
      }
      const file = JSON.parse(readFileSync(join(into, String(run.id), 'moves.json'), 'utf8'));
      const move = (file.moves as any[]).find((m) => m.name === name);
      if (!move) throw new Error(`the newest scan with moves, run ${run.id}, makes no move of ${name}`);
      return { move, judged: file.judged as string, run: run.id as number };
    }
  } finally {
    rmSync(into, { recursive: true, force: true });
  }
  throw new Error(`no finished scan of ${REPO}'s main kept its moves`);
}

/**
 * X1: the scan's move of the app's runtime image, made by the copy's own pin step on a checkout of main as of
 * the scan's time, as the line's pin step makes it, with the image at the digest the scan named. Then one forgery: the
 * Node build stage's `FROM`, which the move brings, at the same tag but at the digest of an older Node release on its
 * line, a real image of the same repository; and the commit says, in the two lines the gate must not trust, that the pin
 * step was given that digest (X1b: and made the move years before the scan).
 */
async function forgeRuntime(test: 'X1a' | 'X1b', head: string, branchOver?: string): Promise<Forgery> {
  const { move: scanned, judged, run } = scannedMove(RUNTIME);
  const pins = await import(join(WORK, 'apps/runner/src/pins.ts'));
  const { moveOf } = await import(join(WORK, 'apps/factory/src/patching/sends.ts'));
  const move = moveOf(REPO, { ...scanned, lockfile: false, findings: [] });
  if (typeof move === 'string') throw new Error(`the scan's ${RUNTIME} move is not one the pin step makes: ${move}`);
  const dir = mkdtempSync(join(tmpdir(), 'forge-app-'));
  try {
    sh('git', ['clone', '--quiet', '--depth', '1', '--branch', 'main', `https://github.com/${REPO}.git`, dir]);
    const cloned = sh('git', ['-C', dir, 'rev-parse', 'HEAD']).trim();
    if (cloned !== head)
      throw new Error(`main moved while it was read: ${head.slice(0, 7)}, then ${cloned.slice(0, 7)}`);
    const get = (url: string, init?: RequestInit) => fetch(url, { ...init, signal: AbortSignal.timeout(60_000) });
    // As the gate and the line make it: as of the scan's time, the image at the digest the scan named for its tag.
    const [tag = '', digest = ''] = String(move.to).split('@');
    const asked = new Map([[pins.askedKey(move.name, tag), digest]]);
    await pins.writePins(dir, move, {
      pnpm: pins.pnpmIn(process.env),
      get,
      aside: mkdtempSync(join(tmpdir(), 'forge-aside-')),
      now: Date.parse(judged),
      digestOf: pins.remembering(asked, get),
    });
    const changed = sh('git', ['-C', dir, 'diff', '--name-only']).split('\n').filter(Boolean);
    const files = changed.map((path) => ({
      path,
      before: sh('git', ['-C', dir, 'show', `HEAD:${path}`]),
      after: existsSync(join(dir, path)) ? readFileSync(join(dir, path), 'utf8') : '',
    }));
    const dockerfile = files.find((f) => f.path === 'Dockerfile');
    const made = dockerfile && NODE_FROM.exec(dockerfile.after);
    const was = dockerfile && NODE_FROM.exec(dockerfile.before);
    if (!dockerfile || !made || !was)
      throw new Error(`the pin step's move of ${RUNTIME} writes no Node build stage in the Dockerfile`);
    const [, nodeTag = '', realDigest = '', rest = ''] = made;
    // An older release on the target's line (its patch counted down), under the same variant, served and not the
    // digest main pins or the move makes: a real image of node's, which the scan never named for this tag.
    const [, major, minor, patch, variant = ''] = /^(\d+)\.(\d+)\.(\d+)(-\S+)?$/.exec(nodeTag) ?? [];
    let older: { tag: string; digest: string } | undefined;
    for (let p = Number(patch) - 1; p >= 0 && !older; p--) {
      const candidate = `${major}.${minor}.${p}${variant}`;
      const found = digestOf(`docker.io/library/node:${candidate}`);
      if (found && found !== realDigest && found !== was[2]) older = { tag: candidate, digest: found };
    }
    if (!older) throw new Error(`node ${nodeTag} has no older release on its line to forge a digest from`);
    dockerfile.after = dockerfile.after.replace(NODE_FROM, `FROM node:${nodeTag}@${older.digest}${rest}`);
    const at = test === 'X1b' ? '2020-01-01T00:00:00.000Z' : new Date(Date.parse(judged)).toISOString();
    return {
      test,
      branch: branchOver ?? `forged/${test.toLowerCase()}`,
      // The line's title for an image's move (line/moves.ts), as its pull request for test 10 had it.
      title: `fix(deps): move ${RUNTIME}`,
      body: [
        `Forged by the patching harness for test ${test}: the build stage's node:${nodeTag} at ${older.digest}, node:${older.tag}'s.`,
        '',
        `Pins-made-at: ${at}`,
        `Pins-asked: node:${nodeTag}@${older.digest}`,
      ].join('\n'),
      files,
      forged: {
        file: 'Dockerfile',
        line: dockerfile.after.slice(0, dockerfile.after.indexOf(`FROM node:${nodeTag}@`)).split('\n').length,
        was: `${nodeTag}@${realDigest}`,
        to: `${nodeTag}@${older.digest}`,
        olderTag: older.tag,
        madeAt: at,
        what: `the scan's ${RUNTIME} move with node:${nodeTag} pinned at node:${older.tag}'s digest, and trailers claiming it${test === 'X1b' ? ', made in 2020' : ''}`,
        move: RUNTIME,
        moveFrom: `the scan's run ${run}`,
      },
      expect: [
        "the review gate: not a move (the Dockerfile's build stage is not what the scan's moves make), then the code-owned tag holds it",
      ],
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── Making it ───────────────────────────────────────────────────────────────────────────────────────────────────────

function diffOf(files: Forgery['files']): string {
  const dir = mkdtempSync(join(tmpdir(), 'forge-diff-'));
  try {
    return files
      .map(({ path, before, after }) => {
        const [a, b] = [join(dir, 'a'), join(dir, 'b')];
        writeFileSync(a, before);
        writeFileSync(b, after);
        try {
          sh('git', ['diff', '--no-index', '--no-color', a, b]);
          return '';
        } catch (error: any) {
          return String(error.stdout ?? '')
            .replace(/^diff --git .*$/m, `diff --git a/${path} b/${path}`)
            .replace(/^--- .*$/m, `--- a/${path}`)
            .replace(/^\+\+\+ .*$/m, `+++ b/${path}`);
        }
      })
      .join('');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function make(forgery: Forgery, head: string) {
  const { branch, title, label } = forgery;
  // The branch at main's head, made or moved, then one commit on it that GitHub makes and signs as the App's.
  const ref = `heads/${branch}`;
  let exists = true;
  try {
    read(`git/ref/${ref}`);
  } catch {
    exists = false;
  }
  if (exists) await github('PATCH', `/repos/${REPO}/git/refs/${ref}`, { sha: head, force: true });
  else await github('POST', `/repos/${REPO}/git/refs`, { ref: `refs/${ref}`, sha: head });
  const made = await github('POST', '/graphql', {
    query: 'mutation($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { oid } } }',
    variables: {
      input: {
        branch: { repositoryNameWithOwner: REPO, branchName: branch },
        expectedHeadOid: head,
        message: { headline: title, ...(forgery.body ? { body: forgery.body } : {}) },
        fileChanges: {
          additions: forgery.files.map(({ path, after }) => ({
            path,
            contents: Buffer.from(after).toString('base64'),
          })),
          deletions: [],
        },
      },
    },
  });
  if (made.errors) throw new Error(`createCommitOnBranch: ${JSON.stringify(made.errors).slice(0, 300)}`);
  const commit = made.data.createCommitOnBranch.commit.oid as string;
  const body = `Forged by the patching harness for test ${forgery.test} (.claude/skills/patching-harness/TESTS.md): ${forgery.forged.what}. It must not merge.`;
  // GitHub keeps one open pull request for a head into a base: one already open from the branch is the one forged.
  const [owner] = REPO.split('/');
  const open = read<any[]>(`pulls?state=open&head=${owner}:${encodeURIComponent(branch)}&base=main`);
  let number: number;
  let reused = false;
  if (open[0]) {
    if (open[0].user?.login !== APP_BOT)
      throw new Error(`#${open[0].number} from ${branch} is ${open[0].user?.login}'s, not the App's`);
    number = open[0].number;
    reused = true;
    await github('PATCH', `/repos/${REPO}/pulls/${number}`, { title, body });
  } else {
    number = (await github('POST', `/repos/${REPO}/pulls`, { head: branch, base: 'main', title, body })).number;
  }
  if (label) await github('POST', `/repos/${REPO}/issues/${number}/labels`, { labels: [label] });
  return { number, head: commit, reused };
}

async function main() {
  const args = process.argv.slice(2);
  const test = args[0];
  const dry = args.includes('--dry-run');
  const opt = (name: string) => {
    const at = args.indexOf(name);
    return at >= 0 ? args[at + 1] : undefined;
  };
  const branchOver = opt('--branch');
  const as = (opt('--as') ?? 'unsigned') as 'unsigned' | 'other-identity';
  if (!['N3a', 'N3b', 'N4', 'N5', 'X1a', 'X1b'].includes(test ?? '') || !['unsigned', 'other-identity'].includes(as)) {
    console.error(
      'usage: node forge.ts <N3a|N3b|N4|N5|X1a|X1b> [--dry-run [--at <branch>]] [--branch <name>] [--as unsigned|other-identity]',
    );
    process.exit(2);
  }
  const x1 = test === 'X1a' || test === 'X1b';
  if (x1) REPO = APP;
  repoOk(REPO);
  if (branchOver !== undefined && (!/^[\w./-]+$/.test(branchOver) || ['main', 'baseline'].includes(branchOver)))
    throw new Error(`--branch ${branchOver} is not a branch the forge may write`);
  // `--at <ref>`, in a dry run alone: forge against another ref (the `baseline` branch, as main is after a reset).
  const at = opt('--at');
  if (at !== undefined && !dry) throw new Error("--at is for a dry run: a forgery is made on main's head alone");
  const head = read<any>(`git/ref/heads/${at ?? 'main'}`).object.sha as string;
  const forgery = x1
    ? await forgeRuntime(test, head, branchOver)
    : test === 'N5'
      ? await forgeDeploy(head, as, branchOver)
      : await forgePin(test as 'N3a' | 'N3b' | 'N4', head, branchOver);
  const out = {
    test: forgery.test,
    repo: REPO,
    base: head,
    branch: forgery.branch,
    title: forgery.title,
    label: forgery.label,
    forged: forgery.forged,
    expect: forgery.expect,
  };
  if (dry) {
    console.log(diffOf(forgery.files));
    console.log(JSON.stringify({ ...out, dryRun: true, ...(at ? { at } : {}) }, null, 2));
    return;
  }
  const made = await make(forgery, head);
  console.log(
    JSON.stringify(
      { ...out, number: made.number, head: made.head, reused: made.reused, at: new Date().toISOString() },
      null,
      2,
    ),
  );
}

await main();
