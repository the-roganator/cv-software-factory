/**
 * One scan's findings carried the whole way a move of the app's goes, each step given what the step before it made and
 * nothing written by hand between them: the scan's judgement and its moves (deadlines.ts, moves.ts), the state it seals
 * and the worker opens and joins to `moves.json` (state.ts, scanning.ts), the dependency sense's signal (sends.ts), the
 * runner's pin step on a checkout (apps/runner/src/pins.ts), the worker's guard on that step's patch (paths.ts), and the
 * review gate's tags of it (scripts/review-routing.ts). Only the ends are a test's: the findings and targets, in the
 * shapes the scan hands on (`deadlines.json`), and the registries' answers.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { codeOwners, type FileChange, fixTagsHold, tagsOf } from '../../../../scripts/review-routing.ts';
import { PinsHeld, PinsRefused, writePins } from '../../../runner/src/pins.ts';
import { filesIn } from '../../src/github/patches.ts';
import { pinStepRefusals, protectedFrom } from '../../src/github/paths.ts';
import { joined, markOf, type ScanRun } from '../../src/github/scanning.ts';
import { sendsOf } from '../../src/patching/sends.ts';
import { assess, type Sources, stateOf, verdict } from '../../src/vulnerabilities/deadlines.ts';
import { type MoveTag, targetText } from '../../src/vulnerabilities/fixes.ts';
import {
  APP,
  type Context,
  dependabotDirectories,
  directPackages,
  type MovesFile,
  moves,
  movesFile,
} from '../../src/vulnerabilities/moves.ts';
import { type Finding, fingerprint } from '../../src/vulnerabilities/sarif.ts';
import type { Handoff, ReadTarget, TrivyReport } from '../../src/vulnerabilities/scan.ts';
import { newKey, open, readKey, seal } from '../../src/vulnerabilities/state.ts';

/** The app's checkout the path runs on: its pins' files, copied (app-checkout/README.md). */
export const CHECKOUT = fileURLToPath(new URL('./app-checkout', import.meta.url));
export const fileOf = (path: string): string | undefined => {
  try {
    return readFileSync(join(CHECKOUT, path), 'utf8');
  } catch {
    return undefined;
  }
};

export const NOW = Date.parse('2026-11-15T05:00:00Z');
const RUN: ScanRun = {
  id: 4242,
  event: 'schedule',
  conclusion: 'success',
  headSha: 'a'.repeat(40),
  updatedAt: '2026-11-15T05:10:00Z',
  url: 'https://github.invalid/run/4242',
};

/** What the registries answer, for the scan and for the pin step alike: one world, so the two cannot disagree. */
export interface World {
  /** Each image repository's tags. */
  tags?: Record<string, string[]>;
  /** The index digest of `<repository>:<tag>`. */
  digests?: Record<string, string>;
  /** The images, by `<repository>:<tag>`, that give no time they were made, as a reproducible build's gives 1970. */
  undated?: string[];
  /** What a newer image still has, by `<repository>:<tag>`: nothing where it is not named. */
  remains?: Record<string, { package: string; advisory: string }[]>;
  /** Node's releases, newest first, as nodejs.org's index lists them. */
  node?: { version: string; date: string }[];
  /** When npm published `<name>@<version>`. */
  published?: Record<string, string>;
  /** pnpm's update of the checkout's lockfile: each `<name>@<from>` it moves, to what. A copy not named stays. */
  pnpm?: Record<string, string>;
}

const digestIn = (world: World, repository: string, tag: string) => {
  const digest = world.digests?.[`${repository}:${tag}`];
  if (!digest) throw new Error(`${repository}:${tag}: the test's world has no such image`);
  return digest;
};

/** A reference's repository and tag, its digest left off: `node:24-alpine@sha256:…` is `node` and `24-alpine`. */
function split(reference: string) {
  const [named = ''] = reference.split('@');
  const at = named.lastIndexOf(':');
  return at > named.lastIndexOf('/')
    ? { repository: named.slice(0, at), tag: named.slice(at + 1) }
    : { repository: named, tag: '' };
}

function sourcesOf(world: World): Sources {
  return {
    published: async (name, version) => world.published?.[`${name}@${version}`],
    releases: async () => world.node ?? [],
    tags: async (repository) => world.tags?.[repository] ?? [],
    async image(reference): Promise<TrivyReport> {
      const { repository, tag } = split(reference);
      return {
        Metadata: {
          ImageID: 'sha256:image',
          ImageConfig: {
            created: world.undated?.includes(`${repository}:${tag}`) ? '1970-01-01T00:00:00Z' : '2026-11-12T00:00:00Z',
          },
        },
        Results: [
          {
            Class: 'os-pkgs',
            Type: 'unknown',
            Vulnerabilities: (world.remains?.[`${repository}:${tag}`] ?? []).map((each) => ({
              PkgName: each.package,
              VulnerabilityID: each.advisory,
            })),
          },
        ],
      };
    },
    async digest(reference) {
      const { repository, tag } = split(reference);
      return digestIn(world, repository, tag);
    },
    async manifests(reference) {
      const { repository, tag } = split(reference);
      return { digest: digestIn(world, repository, tag), platforms: [] };
    },
    chartVersions: async () => [],
    render: async () => '',
    toolReleases: async () => [],
    tool: async () => undefined,
    k3s: async () => undefined,
    file: fileOf,
    alerts: async () => [],
  };
}

/** The registries as the pin step asks them: each image's manifest by its tag, nodejs.org's index and checksums. */
function getOf(world: World) {
  return async (url: string): Promise<Response> => {
    if (url === 'https://nodejs.org/dist/index.json') return Response.json(world.node ?? []);
    const sums = /^https:\/\/nodejs\.org\/dist\/v([^/]+)\/SHASUMS256\.txt$/.exec(url);
    if (sums) {
      const from = /^node\s*=\s*"([^"]+)"/m.exec(fileOf('mise.toml') ?? '')?.[1] ?? '';
      const names = [...(fileOf('mise.lock') ?? '').matchAll(/nodejs\.org\/dist\/v[^/"]+\/([^/"]+)"/g)].map((m) =>
        (m[1] as string).replaceAll(from, sums[1] as string),
      );
      return new Response(names.map((name) => `${'e'.repeat(64)}  ${name}`).join('\n'));
    }
    const manifest = /^https:\/\/([^/]+)\/v2\/(.+)\/manifests\/([^/]+)$/.exec(url);
    if (manifest) {
      const [, host, path, tag] = manifest as unknown as [string, string, string, string];
      const repository = host === 'registry-1.docker.io' ? path.replace(/^library\//, '') : `${host}/${path}`;
      const digest = world.digests?.[`${repository}:${tag}`];
      return digest
        ? new Response(null, { headers: { 'docker-content-digest': digest } })
        : new Response(null, { status: 404 });
    }
    return new Response(null, { status: 404 });
  };
}

/** The app's checkout in a folder of its own, committed, as the prepare pod has it. */
function checkedOut(): string {
  const dir = mkdtempSync(join(tmpdir(), 'path-'));
  cpSync(CHECKOUT, dir, { recursive: true });
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.invalid', ...args], { cwd: dir });
  git('init', '--quiet');
  git('add', '--all');
  git('commit', '--quiet', '--message', 'base');
  return dir;
}

/** How far one move got, and what each step made of it. */
export interface Carried {
  /** The scan's move, as `moves.json` gives it to anyone. */
  move: { name: string; from: string; to: string; lane: string; pins: string[] };
  /** The sense's signal's move, or why it sent none. */
  sent?: { ecosystem: string; name: string; from: string; to: string };
  notSent?: string;
  /** The pin step: the files it wrote, or why it wrote none. */
  wrote?: string[];
  refused?: string;
  heldForMartin?: string;
  /** The worker's guard on the pin step's patch: its refusals, none when it passes. */
  guard?: string[];
  /** The review gate's tags of the patch, and why a Critical fix's proof could not pass them, if it could not. */
  tags?: string[];
  fixHeld?: string;
  /**
   * Set when the pins the step wrote leave the build stage's Node and mise.toml's apart, which the app's own check
   * (its test/node-pins.test.ts) fails on: the pull request opens with a required check it cannot pass.
   */
  nodeApart?: string;
  /** Where it ends. */
  ends: 'not the line’s' | 'never sent' | 'pin step' | 'guard' | 'pull request';
}

/** The scan's findings, carried: one entry for each move the scan makes of them, in `moves.json`'s order. */
export async function carry(findings: Finding[], targets: ReadTarget[], world: World): Promise<Carried[]> {
  // The scan: its judgement, its moves, `moves.json` and the state, sealed and opened as the worker opens it.
  const handoff: Handoff = {
    repository: APP,
    started: new Date(NOW - 600_000).toISOString(),
    cache: '/nowhere',
    findings,
    excepted: [],
    targets,
  };
  const sources = sourcesOf(world);
  const judged = await assess(handoff, sources, NOW);
  const context: Context = {
    repository: APP,
    app: true,
    dependabot: dependabotDirectories(fileOf('.github/dependabot.yml')),
    direct: new Set(
      targets.filter((target) => target.kind === 'lockfile').flatMap((t) => [...directPackages(fileOf(t.file))]),
    ),
    now: NOW,
  };
  const list = moves(judged.judged, context);
  const { counts, bySeverity } = verdict(judged.rows, false, list);
  const run = String(RUN.id);
  const written = movesFile(list, context, run, [], counts, bySeverity);
  const tags = new Map<string, MoveTag>();
  for (const [index, move] of list.entries())
    for (const each of move.results) tags.set(each, { index: index + 1, run });
  const state = stateOf(
    APP,
    run,
    judged.rows,
    judged.judged.map((each) => ({ ...each.finding, move: tags.get(fingerprint(each.finding)) })),
  );
  const key = readKey(newKey());
  const file = JSON.parse(JSON.stringify(written)) as MovesFile;
  const read = joined(APP, RUN, file, open(seal(state, key), key, APP, run));
  for (const move of read.moves) if (move.withheld) move.mark = markOf(key, APP, move.withheld);

  // The sense.
  const { sends, skipped } = sendsOf({ repository: APP, run: RUN, ...read }, '2026-11-15T05:30:00Z');

  const owners = fileOf('.github/CODEOWNERS') ?? '';
  const out: Carried[] = [];
  const carriedOf = (index: number): Carried => {
    const move = list[index];
    const shown = written.moves[index];
    if (!move || !shown) throw new Error(`no move ${index + 1}`);
    return {
      move: {
        name: move.lockfile ? `${move.name} (withheld)` : shown.name,
        from: move.from,
        to: move.to ? targetText(move.to) : '',
        lane: shown.lane,
        pins: shown.pins.map((pin) => pin.file),
      },
      ends: 'never sent',
    };
  };
  for (const index of list.keys()) out.push(carriedOf(index));
  for (const [index, each] of out.entries()) {
    if (each.move.lane !== 'line') each.ends = 'not the line’s';
    const why = skipped.filter((line) => new RegExp(`^move (\\d+ and )*${index + 1}( and \\d+)*:`).test(line));
    if (why.length) each.notSent = why.join('; ');
  }

  // The line hands the pin step the signal's move as it is (line/worker.ts): its ecosystem, name, from and to.
  for (const send of sends) {
    const sent = send.signal.move;
    if (!sent) continue;
    // Each of the scan's moves this signal carries: one, or the two of a name at two versions.
    const own = out.filter(
      (each) =>
        each.move.lane === 'line' &&
        each.move.name.replace(' (withheld)', '') === sent.name &&
        sent.from.split(',').includes(each.move.from),
    );
    const step: Partial<Carried> & Pick<Carried, 'ends'> = {
      sent: { ecosystem: sent.ecosystem, name: sent.name, from: sent.from, to: sent.to },
      ends: 'pin step',
    };
    const dir = checkedOut();
    try {
      await writePins(dir, sent, {
        pnpm: async (at) => {
          let lock = readFileSync(join(at, 'pnpm-lock.yaml'), 'utf8');
          for (const [from, to] of Object.entries(world.pnpm ?? {})) {
            const name = from.slice(0, from.lastIndexOf('@'));
            lock = lock
              .replaceAll(`${from}:`, `${name}@${to}:`)
              .replaceAll(`${name}: ${from.slice(name.length + 1)}`, `${name}: ${to}`);
          }
          writeFileSync(join(at, 'pnpm-lock.yaml'), lock);
        },
        get: getOf(world),
        aside: mkdtempSync(join(tmpdir(), 'aside-')),
        now: NOW,
      });
      const patch = execFileSync('git', ['-C', dir, 'diff'], { encoding: 'utf8' });
      const files = filesIn(patch);
      step.wrote = files.map((each) => each.path);
      // The worker's guard, as `guard` asks it (github/actions.ts).
      step.guard = pinStepRefusals(
        files.map(({ path, change, patch: each }) => ({ path, change, lines: each.hunks.map((h) => h.lines) })),
        protectedFrom(owners),
      );
      step.ends = step.guard.length ? 'guard' : 'pull request';
      const built = /^FROM node:(\d+\.\d+\.\d+)-/m.exec(readFileSync(join(dir, 'Dockerfile'), 'utf8'))?.[1];
      const pinned = /^node\s*=\s*"([^"]+)"/m.exec(readFileSync(join(dir, 'mise.toml'), 'utf8'))?.[1];
      if (built !== pinned) step.nodeApart = `the Dockerfile builds on Node ${built} and mise.toml pins ${pinned}`;
      if (!step.guard.length) {
        // The review gate reads the pull request's files as GitHub lists them.
        const changes: FileChange[] = files.map((each) => ({
          filename: each.path,
          status: 'modified',
          patch: each.patch.hunks.flatMap((h) => h.lines).join('\n'),
        }));
        const found = tagsOf({
          files: changes,
          complete: true,
          headRef: 'factory/1',
          owners: codeOwners(owners),
          excused: [],
        });
        step.tags = found.map((each) => each.tag);
        const held = fixTagsHold(found);
        if (held) step.fixHeld = held;
      }
    } catch (error) {
      if (error instanceof PinsHeld) step.heldForMartin = error.message;
      else if (error instanceof PinsRefused) step.refused = error.message;
      else throw error;
    }
    for (const each of own) Object.assign(each, step);
    if (!own.length) throw new Error(`the signal for ${sent.name} is of no move the scan made`);
  }
  return out;
}
