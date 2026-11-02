/**
 * Deploy pull requests, opened by the App (ADR 0005). Argo CD deploys only what is in git, so a new image reaches a
 * cluster through a pull request that pins its digest in a profile's overlay. The build workflow builds and pushes
 * images and opens nothing; this watch sees each new image and proposes it.
 *
 * Each repository has one deploy per profile, on one branch, with at most one open pull request. A deploy moves one
 * or more pin files, each pinning images that are built together from one commit: the app's one image; this
 * repository's console, and its factory images. The pull request moves each pin file whose images main has a newer
 * build of, to the newest commit on main that every one of them was built from: one pin file when only one has a
 * newer build, all of them, each at its own commit, when they all have. One pull request, not one each: in one commit
 * they deploy together, in the order Argo CD's sync waves give them, for one verdict of the review gate and one run of
 * the merge queue's checks, which run in full for every pull request it merges. When a newer build is found, the new
 * digests are committed on main's head (signed, through the API), the branch is moved to that commit, and the pull
 * request is opened, or retitled if it was for older builds or other pin files.
 *
 * The branch is never at main's head itself, even for a moment: GitHub closes a pull request whose branch has nothing
 * to merge, and would close the one for the older build, as the App. So the commit is made on a scratch branch of
 * the factory's (`factory/` and the deploy branch's name), started at main's head, and the deploy branch is moved to
 * it in one forced update. The commit goes through `createCommitOnBranch` like every other, so GitHub signs it.
 *
 * The deploy branch is this watch's alone. When main moves on and the build is still the newest (a merge that built no
 * image), the branch is left behind main: the merge queue tests it on main as it will be, so it merges as it is. Only
 * when it conflicts with main, which the queue cannot take (main's pin file changed by other means), is the pin commit
 * made again, the same way, on main's new head, approved or not: a pull request that conflicts cannot merge either
 * way, and Martin's approval counts only on the commit it was given to. GitHub may answer whether it conflicts from
 * main before it moved, so an open pull request found to merge cleanly is asked again every pass.
 *
 * Its title names each pin file's commit, as the build workflow's `changes` job reads them back: `chore(deploy): run
 * console 1f14f44 and the factory 9e0b2d1 on the local cluster`. A build Martin closed a pull request for without
 * merging it is not proposed again, alone or beside another; the next build of that pin file is.
 *
 * A build of one pin file still being signed is waited for before any is proposed, so that the pull request does not
 * open for the others only to move a minute later. One that is still building is not seen yet: the pull request opens
 * for the builds that are there, and moves once it is.
 * A build its pipeline did not sign is left out, unless the open pull request runs an older build of that pin
 * file: then the pull request stays as it is, rather than drop that pin, until the pin file has a build that is signed.
 *
 * Every deploy pull request lists the pull requests it brings, read from GitHub: each commit main has between the
 * one pinned now and the one proposed, for each pin it moves, once however many pins it reaches, its Conventional
 * Commit subject split into columns (`bringsSection`). Main is squash-merged, so each commit is one pull request. A
 * read that fails leaves the list out rather than hold the deploy back, and a later pass fills it in.
 *
 * The app's deploy pull request also says what it carries: the line's work items whose fixes merged between the
 * pinned commit and the proposed one, each with its ticket, issue and pull request. The line works that out from its
 * events and tells the worker (`describeDeploy`); the worker keeps no store. The watch remembers its open
 * proposal (`DeployProposals`), which the line reads to know the range, and keeps the body's Carries section when it
 * moves the pull request to a newer build, until the line says again.
 *
 * Only images their pipeline signed are proposed: every digest must carry the signature of `build.yml` on main of the
 * repository that built it (`signatures.ts`), as admission will require. A build that does not is not proposed, and
 * the watch looks again each pass. The build workflow pushes its images, then signs them, so a build with no signature
 * yet is waited for; one still unsigned after `SIGNING_GRACE_MS`, or one signed by anyone else, is warned of, once.
 *
 * Everything in one pass is read at one commit of main, the head it starts from, so a pin that moves on main while
 * it runs is not reverted.
 */
import type { Logger } from 'pino';
import { parse } from 'yaml';
import { z } from 'zod';
import type { Actions } from './actions.ts';
import type { GitHub } from './client.ts';
import type { Watch } from './poller.ts';
import type { Registry } from './registry.ts';
import { pipeline, type Signatures, UnsignedError } from './signatures.ts';

/** One pin file of a deploy and the images it pins, which are built together from one commit. */
export interface Pin {
  /** What the title says it runs: `console`, `the factory`, or nothing for the app's one image. */
  what: string;
  /** The kustomization that pins the images. */
  file: string;
  /** Each image as kustomize names it, and where it is in GHCR. */
  images: { name: string; image: string }[];
}

/** A repository's deploy to one profile: its one branch, and the pin files its pull request moves. */
export interface DeployTarget {
  repo: string;
  profile: 'local';
  branch: string;
  /** In the order the title names them. */
  pins: Pin[];
}

export const DEPLOYS: DeployTarget[] = [
  {
    repo: 'the-roganator/cv-software-factory',
    profile: 'local',
    branch: 'deploy/local',
    pins: [
      {
        what: 'console',
        file: 'deploy/overlays/local/console-image/kustomization.yaml',
        images: [{ name: 'console', image: 'the-roganator/cv-software-factory/console' }],
      },
      {
        what: 'the factory',
        file: 'deploy/overlays/local/factory-image/kustomization.yaml',
        images: [
          { name: 'factory', image: 'the-roganator/cv-software-factory/factory' },
          { name: 'factory-browser', image: 'the-roganator/cv-software-factory/factory-browser' },
          { name: 'factory-runner', image: 'the-roganator/cv-software-factory/factory-runner' },
        ],
      },
    ],
  },
  {
    repo: 'the-roganator/cv-worlds-worst-website',
    profile: 'local',
    branch: 'deploy/local',
    pins: [
      {
        what: '',
        file: 'deploy/overlays/local/image/kustomization.yaml',
        images: [{ name: 'website', image: 'the-roganator/cv-worlds-worst-website' }],
      },
    ],
  },
];

/** A deploy pull request, or an image a deploy pins, that is not one: asked of the worker, refused. */
export class DeployRefused extends Error {
  override name = 'DeployRefused';
}

/** The target a repository's branch is the deploy branch of; any other branch is refused. */
export function deployTarget(repo: string, branch: string): DeployTarget {
  const target = DEPLOYS.find((t) => t.repo === repo && t.branch === branch);
  if (!target) throw new DeployRefused(`${branch} is not a deploy branch of ${repo}.`);
  return target;
}

/** An image one of a repository's deploys pins, as GHCR names it; any other is refused. */
export function deployedImage(repo: string, image: string): string {
  if (!DEPLOYS.some((t) => t.repo === repo && t.pins.some((p) => p.images.some((i) => i.image === image)))) {
    throw new DeployRefused(`${image} is not an image ${repo} deploys.`);
  }
  return image;
}

/** How long after it first sees a build with no signature the watch warns of it: longer than the signing job takes. */
export const SIGNING_GRACE_MS = 30 * 60_000;

/** Where a deploy's new pins are committed before its deploy branch moves to them. */
export const scratchBranch = (target: DeployTarget) => `factory/${target.branch}`;

/** The label that marks a deploy pull request apart from the release pull request and Martin's own. */
export const deployLabel = (target: DeployTarget) => `deploy: ${target.profile}`;

/** A pin and the commit a deploy pull request runs it at. */
export interface Runs {
  pin: Pin;
  commit: string;
}

/** How a title names one pin at its commit: `console 1f14f44`, or the commit alone for the app's one image. */
const named = ({ pin, commit }: Runs) => `${pin.what ? `${pin.what} ` : ''}${commit.slice(0, 7)}`;

/**
 * A deploy pull request's title, naming each pin it moves at its commit, as the build workflow's `changes` job reads
 * them back: `chore(deploy): run console 1f14f44 and the factory 9e0b2d1 on the local cluster`.
 */
export const deployTitle = (target: DeployTarget, runs: readonly Runs[]) =>
  `chore(deploy): run ${runs.map(named).join(' and ')} on the ${target.profile} cluster`;

/** What a deploy pull request's title says it runs, each pin at its commit as `named` writes it. */
const said = (target: DeployTarget, title: string): string[] => {
  const runs = /^chore\(deploy\): run (.+) on the (\S+) cluster$/.exec(title);
  return runs?.[2] === target.profile ? (runs[1] ?? '').split(' and ') : [];
};

/** Whether a deploy pull request's title says it runs this pin at this commit, alone or beside another. */
export const titleRuns = (target: DeployTarget, title: string, runs: Runs): boolean =>
  said(target, title).includes(named(runs));

/** Whether a deploy pull request's title says it runs this pin, at any commit. */
const titleNames = (target: DeployTarget, title: string, pin: Pin): boolean =>
  said(target, title).some((run) => !pin.what || run.startsWith(`${pin.what} `));

/** What a deploy proposes: the commit, and each image's digest built from it. */
export interface Proposal {
  commit: string;
  /** The commit the pinned images were built from, when their labels say. */
  pinned?: string | undefined;
  digests: { name: string; image: string; digest: string }[];
}

/** A newer build of one of a deploy's pins, which its pull request moves the pin to. */
export interface Move {
  pin: Pin;
  proposal: Proposal;
  /** The pin file on main's head, which the move changes. */
  pinFile: string;
}

/** A deploy of one pin file's open pull request, as its watch last saw or made it. */
export interface DeployProposal {
  number: number;
  /** The commit it runs, and the one pinned on main now, when the pinned images' labels say. */
  commit: string;
  pinned: string | null;
  digests: { name: string; image: string; digest: string }[];
}

/**
 * The open deploy pull request of each deploy of one pin file, by repository and branch, as the watches last saw or
 * made them: what the line reads to say what the app's deploy carries. The watch of a deploy of several pin files,
 * which has no one range of commits, keeps none. It lives as long as the worker; a worker started again knows each one after its watch's
 * first pass that finds the newest build signed. For a minute after Martin merges one, it is still here, until the
 * watch's next pass.
 */
export class DeployProposals {
  readonly #open = new Map<string, DeployProposal>();

  set(target: DeployTarget, proposal: DeployProposal | undefined): void {
    const key = `${target.repo} ${target.branch}`;
    if (proposal) this.#open.set(key, proposal);
    else this.#open.delete(key);
  }

  get(repo: string, branch: string): DeployProposal | null {
    return this.#open.get(`${repo} ${branch}`) ?? null;
  }
}

/** A work item a deploy carries: its ticket's number and title, its issue, and the pull request that merged its fix. */
export interface Carry {
  workItem: string;
  title: string;
  issue: number | null;
  pullRequest: number;
}

/** What a deploy pull request is told it carries, for the commit it runs: at most `MAX_CARRIES`, and how many more. */
export interface Deploy {
  commit: string;
  carries: Carry[];
  more?: number;
}

/** The most work items a Carries section lists by name: the rest are counted. */
export const MAX_CARRIES = 50;

/** Where the Carries section starts and ends in a deploy pull request's body, so it can be found and replaced. */
const CARRIES_START = '<!-- factory: carries -->';
const CARRIES_END = '<!-- factory: /carries -->';

/**
 * A ticket's title as plain text in a table: on one line, without a pipe, and with nothing GitHub would read as
 * markdown, an HTML tag, a reference or a mention (a bare `www.` address may still show as a link). The title is the
 * factory's own, but a cell is no place for markup.
 */
const plain = (title: string) =>
  title
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\\`*_[\]|~#:]/g, (c) => `\\${c}`)
    // After the escapes, which would break the entities.
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/@/g, '&#64;');

/** The Carries section of a deploy pull request's body: the work items its commits bring, or that they bring none. */
export function carriesSection(carries: readonly Carry[], more = 0): string {
  const rows = carries.map(
    (c) => `| ${c.workItem} | ${plain(c.title)} | ${c.issue ? `#${c.issue}` : '–'} | #${c.pullRequest} |`,
  );
  if (more) rows.push(`| | and ${more} more | | |`);
  const all = carries.length + more;
  const said = all
    ? `It carries ${all === 1 ? 'one work item' : `${all} work items`} of the line’s, whose fixes merged since the pinned commit:

| Ticket | Title | Issue | Pull request |
|---|---|---|---|
${rows.join('\n')}`
    : 'It carries none of the line’s work items: no fix of the line’s merged since the pinned commit.';
  return `${CARRIES_START}
### Carries

${said}
${CARRIES_END}`;
}

/** The Carries section a body holds, markers and all, if it holds one. */
export function carriesIn(body: string | null | undefined): string | undefined {
  const start = body?.indexOf(CARRIES_START) ?? -1;
  const end = body?.indexOf(CARRIES_END, start) ?? -1;
  if (!body || start === -1 || end === -1) return undefined;
  return body.slice(start, end + CARRIES_END.length);
}

/** A body with its Carries section replaced by `section`, or with it added at the end where it has none. */
export function withCarries(body: string, section: string): string {
  const kept = carriesIn(body);
  return kept ? body.replace(kept, () => section) : `${body.trimEnd()}\n\n${section}`;
}

/** A commit of main's that a deploy brings: its message, and each of the deploy's pins whose range holds it. */
export interface Brought {
  sha: string;
  message: string;
  reaches: Pin[];
}

/** The commits a deploy brings, newest first: every one read, and how many there are in all. */
export interface Brings {
  /** The pins whose range was read: each pin moved from a commit its pinned images' labels name. */
  pins: Pin[];
  /** The pins it moves from no commit it knows, whose changes are not listed. */
  unranged?: Pin[];
  commits: Brought[];
  /** How many commits it brings: exact when every range was read whole, at least this many when not. */
  count: number;
  whole: boolean;
}

/** The most pull requests a deploy pull request lists: the rest are counted. */
export const MAX_BROUGHT = 50;

/**
 * The most pages of a range's commits read, a hundred to a page: the first, which says how many there are, then the
 * newest. A deploy brings tens of commits; a range of more than a thousand is listed from its newest, and counted.
 */
export const MAX_RANGE_PAGES = 10;

/** Where the list of pull requests starts and ends in a deploy pull request's body, so a pass can tell it is there. */
const BRINGS_START = '<!-- factory: brings -->';
const BRINGS_END = '<!-- factory: /brings -->';

/** Whether a body lists the pull requests its deploy brings. */
export const bringsIn = (body: string | null | undefined): boolean =>
  !!body && body.includes(BRINGS_START) && body.includes(BRINGS_END);

/**
 * A squash commit's subject, `type(scope)!: subject (#N)`, in its parts; one that is not a Conventional Commit keeps
 * its whole first line as the subject, and its pull request's number if it ends with one.
 */
export function conventional(message: string): {
  number: number | null;
  type: string | null;
  scope: string | null;
  breaking: boolean;
  subject: string;
} {
  const line = message.split('\n', 1)[0]?.trim() ?? '';
  const numbered = /^(.*?)\s*\(#(\d+)\)$/.exec(line);
  const rest = numbered?.[1] ?? line;
  const number = numbered ? Number(numbered[2]) : null;
  const parts = /^([a-z]+)(?:\(([^()]+)\))?(!)?: (.+)$/i.exec(rest);
  if (!parts) return { number, type: null, scope: null, breaking: false, subject: rest };
  return {
    number,
    type: parts[1] as string,
    scope: parts[2] ?? null,
    breaking: parts[3] === '!',
    subject: parts[4] as string,
  };
}

/**
 * The section of a deploy pull request's body that lists the pull requests it brings, newest first: each one's
 * number, the pins it reaches when the deploy moves more than one, and its type, scope and subject. A breaking change
 * is marked as its commit marks it, `feat!`. A commit with no pull request's number is named by its commit.
 */
export function bringsSection(target: DeployTarget, brings: Brings): string {
  const url = `https://github.com/${target.repo}`;
  const several = brings.pins.length > 1;
  const shown = brings.commits.slice(0, MAX_BROUGHT);
  const more = brings.count - shown.length;
  const head = several
    ? ['Pull request', 'Reaches', 'Type', 'Scope', 'Subject']
    : ['Pull request', 'Type', 'Scope', 'Subject'];
  const rows = shown.map(({ sha, message, reaches }) => {
    const { number, type, scope, breaking, subject } = conventional(message);
    const cells = [
      number ? `#${number}` : `[\`${sha.slice(0, 7)}\`](${url}/commit/${sha})`,
      ...(several ? [reaches.map((p) => p.what).join(', ')] : []),
      type ? `${plain(type)}${breaking ? '!' : ''}` : '–',
      scope ? plain(scope) : '–',
      plain(subject) || '–',
    ];
    return `| ${cells.join(' | ')} |`;
  });
  if (more > 0) {
    const cells = head.map(() => '');
    cells[head.length - 1] = `and ${brings.whole ? '' : 'at least '}${more} more`;
    rows.push(`| ${cells.join(' | ')} |`.replace(/ {2}/g, ' '));
  }
  const since = several ? 'the commits pinned now' : 'the pinned commit';
  const all = `${brings.whole ? '' : 'at least '}${brings.count === 1 ? 'one pull request' : `${brings.count} pull requests`}`;
  const said = brings.count
    ? `It brings ${all} merged since ${since}, newest first:

| ${head.join(' | ')} |
|${head.map(() => '---').join('|')}|
${rows.join('\n')}`
    : `It brings no pull request: nothing merged since ${since}.`;
  const unranged = brings.unranged?.length
    ? `\n\nWhat ${brings.unranged.map((p) => p.what).join(' and ')} ${brings.unranged.length > 1 ? 'bring is' : 'brings is'} not listed: no commit is pinned for ${brings.unranged.length > 1 ? 'them' : 'it'} to compare with.`
    : '';
  return `${BRINGS_START}
### Pull requests

${said}${unranged}
${BRINGS_END}`;
}

const PIN_FILE = z
  .object({
    images: z
      .array(z.object({ name: z.string(), digest: z.string().optional(), newName: z.string().optional() }))
      .nullable()
      .optional(),
  })
  .nullable();

/** A pin file that does not say what the factory expects of it. */
export class PinFileError extends Error {
  override name = 'PinFileError';
}

function pinEntries(file: string) {
  const parsed = PIN_FILE.safeParse(parse(file));
  if (!parsed.success) throw new PinFileError('The pin file is not a kustomization with images.');
  return parsed.data?.images ?? [];
}

/** The digests a pin file holds, by kustomize name. */
export function pinned(file: string): Map<string, string> {
  return new Map(pinEntries(file).flatMap((i) => (i.digest ? [[i.name, i.digest] as const] : [])));
}

/**
 * Refuses a pin file that names any of these images anywhere but where the deploy has it in GHCR: a digest looked up
 * or written under another name would be another image's, or none.
 */
export function expectNames(file: string, images: readonly { name: string; image: string }[]): void {
  const entries = pinEntries(file);
  for (const { name, image } of images) {
    const entry = entries.find((e) => e.name === name);
    if (entry && entry.newName !== `ghcr.io/${image}`) {
      throw new PinFileError(`The pin file names ${name}'s image ${entry.newName ?? 'nowhere'}, not ghcr.io/${image}.`);
    }
  }
}

/**
 * The pin file with each image moved to its new digest. Only the digests change, as text: the file keeps the layout
 * `kustomize edit` gave it, so the diff is the digests and nothing else.
 */
export function repin(file: string, proposal: Proposal): string {
  expectNames(file, proposal.digests);
  const current = pinned(file);
  let next = file;
  for (const { name, digest } of proposal.digests) {
    const old = current.get(name);
    if (!old) throw new PinFileError(`The pin file has no digest for ${name}.`);
    // A function, so nothing in the digest is read as a replacement pattern.
    next = next.replace(old, () => digest);
  }
  return next;
}

/**
 * What a deploy pull request says: the commit each pin file runs, linked, with the changes since the one pinned now;
 * each image with the start of its digest, since the diff holds them in full; where Argo CD deploys them from; and,
 * when they were read, the pull requests it brings. With the body it had, it keeps that body's Carries section, until
 * the line says what the newer build carries.
 */
export function deployBody(
  target: DeployTarget,
  moves: readonly Pick<Move, 'pin' | 'proposal'>[],
  before?: string | null,
  brings?: Brings,
): string {
  const url = `https://github.com/${target.repo}`;
  const short = (sha: string) => sha.slice(0, 7);
  const at = ({ commit }: Proposal) => `[\`${short(commit)}\`](${url}/commit/${commit})`;
  const since = ({ commit, pinned }: Proposal) =>
    pinned ? `: [the changes since \`${short(pinned)}\`](${url}/compare/${pinned}...${commit})` : '';
  const [first] = moves;
  // One pin says its commit in a sentence; several are listed, each at its own commit.
  const runs =
    moves.length === 1 && first
      ? `Runs ${at(first.proposal)} on the ${target.profile} cluster${since(first.proposal)}.`
      : `Runs on the ${target.profile} cluster:

${moves.map(({ pin, proposal }) => `- ${pin.what} at ${at(proposal)}${since(proposal)}`).join('\n')}`;
  const digests = moves.flatMap((m) => m.proposal.digests);
  const rows = digests.map((d) => `| \`${d.name}\` | \`${d.digest.slice(0, 'sha256:'.length + 12)}…\` |`);
  const overlays = [...new Set(moves.map((m) => `\`${m.pin.file.split('/').slice(0, 3).join('/')}\``))];
  const them = digests.length === 1 ? 'it' : 'them';
  const body = `${runs}

| Image | Digest |
|---|---|
${rows.join('\n')}

Argo CD deploys ${them} from ${overlays.join(' and ')} once this merges. A newer build moves this pull request on rather than opening another.`;
  const listed = brings ? `${body}\n\n${bringsSection(target, brings)}` : body;
  const carries = carriesIn(before);
  return carries ? `${listed}\n\n${carries}` : listed;
}

interface Dependencies {
  github: GitHub;
  registry: Registry;
  signatures: Pick<Signatures, 'verify'>;
  actions: Actions;
  log: Logger;
  now?: () => number;
  /** Where the watch says which pull request is open for its target, and what it proposes. */
  proposals?: DeployProposals;
}

const SHA = z.string().regex(/^[0-9a-f]{40}$/);
const HEAD = z.object({ object: z.object({ sha: SHA }) });
const COMMITS = z.array(z.object({ sha: z.string() }));
const CONTENT = z.object({ content: z.string() });
const PULLS = z.array(
  z.object({
    number: z.number().int().positive(),
    title: z.string(),
    state: z.string(),
    merged_at: z.string().nullable(),
    labels: z.array(z.object({ name: z.string() })),
    body: z.string().nullable().optional(),
  }),
);
const COMPARED = z.object({
  total_commits: z.number().int().nonnegative(),
  commits: z.array(
    z.object({
      sha: SHA,
      commit: z.object({
        message: z.string(),
        committer: z.object({ date: z.string().optional() }).nullable().optional(),
      }),
    }),
  ),
});
// GitHub works out whether a pull request merges cleanly after it is asked, and says null until it has.
const MERGEABLE = z.object({ mergeable: z.boolean().nullable() });

/**
 * The newest of main's commits (newest first, from the head a pass reads) that every image the pin file pins was
 * built from, with each image's digest; or undefined when there is none newer than the pinned one. An image of the pin the file does not pin yet is
 * left out: the change that brings it in pins it.
 */
export async function newerBuild(
  { registry }: Pick<Dependencies, 'registry'>,
  pin: Pin,
  pinFile: string,
  commits: readonly { sha: string }[],
): Promise<Proposal | undefined> {
  expectNames(pinFile, pin.images);
  const pins = pinned(pinFile);
  const images = pin.images.filter((i) => pins.has(i.name));
  if (!images.length) return undefined;
  const tags = await Promise.all(images.map(async (i) => new Set(await registry.tags(i.image))));
  const newest = commits.findIndex((c) => tags.every((t) => t.has(c.sha)));
  if (newest === -1) return undefined;
  const commit = commits[newest]?.sha as string;

  const [first] = images;
  const pinnedDigest = first && pins.get(first.name);
  const pinnedCommit = first && pinnedDigest ? await registry.revision(first.image, pinnedDigest) : undefined;
  if (pinnedCommit) {
    const at = commits.findIndex((c) => c.sha === pinnedCommit);
    // The pin is this build, or a newer one than any this pin has a full set of images for.
    if (at !== -1 && at <= newest) return undefined;
  }
  const digests = await Promise.all(
    images.map(async (i) => ({ ...i, digest: await registry.digest(i.image, commit) })),
  );
  return { commit, pinned: pinnedCommit, digests };
}

/**
 * The commits one pin's move brings, `pinned...commit` as GitHub compares them, oldest first a hundred to a page: the
 * first page, which says how many there are, then the newest pages, up to `MAX_RANGE_PAGES` in all. A comparison of
 * two commits never changes, so it is read, not polled: it would only crowd the polls' cache.
 */
async function range(github: GitHub, repo: string, pinned: string, commit: string) {
  const path = (page: number) => `/repos/${repo}/compare/${pinned}...${commit}?per_page=100&page=${page}`;
  const first = await github.read(repo, path(1), COMPARED);
  const last = Math.ceil(first.total_commits / 100);
  // The newest pages after the first, oldest first, read together.
  const later = Array.from({ length: Math.min(last, MAX_RANGE_PAGES) - 1 }, (_, i) => last - i).reverse();
  const newest = await Promise.all(later.map((page) => github.read(repo, path(page), COMPARED)));
  const commits = [first, ...newest].flatMap((p) => p.commits);
  const unique = [...new Map(commits.map((c) => [c.sha, c])).values()];
  return { total: first.total_commits, commits: unique };
}

/**
 * What a deploy brings: the commits in the range of each pin it moves from a known commit, each once, with the pins
 * it reaches, newest first; undefined when no pin has a range. Main's history is linear, so each commit's place in it
 * (`order`, main's newest commits from the head the pass read, newest first) orders them; one older than those is
 * ordered by when it was committed.
 */
export async function brings(
  github: GitHub,
  repo: string,
  target: DeployTarget,
  moves: readonly Pick<Move, 'pin' | 'proposal'>[],
  order: readonly { sha: string }[],
): Promise<Brings | undefined> {
  const ranged = moves.flatMap(({ pin, proposal }) =>
    proposal.pinned ? [{ pin, pinned: proposal.pinned, commit: proposal.commit }] : [],
  );
  if (!ranged.length) return undefined;
  // Pins moved from the same commit to the same commit, as pins built together are, share one read.
  const ranges = new Map<string, { pinned: string; commit: string; pins: Pin[] }>();
  for (const { pin, pinned, commit } of ranged) {
    const key = `${pinned}...${commit}`;
    const same = ranges.get(key);
    if (same) same.pins.push(pin);
    else ranges.set(key, { pinned, commit, pins: [pin] });
  }
  const each = [...ranges.values()];
  const read = await Promise.all(each.map((r) => range(github, repo, r.pinned, r.commit)));
  const found = new Map<string, { sha: string; message: string; date: string; at: number; reaches: Set<Pin> }>();
  read.forEach(({ commits }, i) => {
    const pins = each[i]?.pins ?? [];
    commits.forEach((c, at) => {
      const seen = found.get(c.sha);
      if (seen) for (const pin of pins) seen.reaches.add(pin);
      else
        found.set(c.sha, {
          sha: c.sha,
          message: c.commit.message,
          date: c.commit.committer?.date ?? '',
          at,
          reaches: new Set(pins),
        });
    });
  });
  const place = new Map(order.map((c, i) => [c.sha, i]));
  const newest = [...found.values()].sort((a, b) => {
    const [pa, pb] = [place.get(a.sha), place.get(b.sha)];
    if (pa !== undefined && pb !== undefined) return pa - pb;
    if (pa !== undefined || pb !== undefined) return pa !== undefined ? -1 : 1;
    // The ranges are listed oldest first: a later place in one is newer.
    return b.date.localeCompare(a.date) || b.at - a.at;
  });
  return {
    pins: ranged.map((r) => r.pin),
    unranged: moves.filter((m) => !m.proposal.pinned).map((m) => m.pin),
    commits: newest.map(({ sha, message, reaches }) => ({
      sha,
      message,
      reaches: target.pins.filter((p) => reaches.has(p)),
    })),
    // Every one read, or more if a range was not read whole: the union is at least as long as its longest range.
    count: Math.max(found.size, ...read.map((r) => r.total)),
    whole: read.every((r) => r.commits.length >= r.total),
  };
}

const runsOf = ({ pin, proposal }: Pick<Move, 'pin' | 'proposal'>): Runs => ({ pin, commit: proposal.commit });

/**
 * Watches one deploy, and opens or moves its pull request when main has a newer build of any of its pins, or makes
 * its commit again on main's head when its pull request conflicts with main.
 */
export function deployWatch(deps: Dependencies, target: DeployTarget): Watch {
  const { github, signatures, actions, log, now = Date.now, proposals = new DeployProposals() } = deps;
  const { repo } = target;
  const label = deployLabel(target);
  // What this worker last proposed, from which newer builds, and at which head of main: a pass does nothing more until
  // any of them moves, and a dry run, which changes nothing in GitHub, records each proposal once.
  // `settled` is false while an open pull request's answer to whether it conflicts may yet change: it is asked again.
  // `listed` is false while its body lacks the pull requests it brings, which a read failed to find: it is read again.
  let proposed: { found: string; title: string; head: string; settled?: false; listed?: false } | undefined;
  // When it first saw each digest with no signature, and the digests it has warned of, so each is said once.
  const waiting = new Map<string, number>();
  const warned = new Set<string>();

  /**
   * Whether every image of a build carries its pipeline's signature: `waiting` while one may yet, `refused` once it
   * is signed by anyone else or has waited longer than signing takes, which is said once.
   */
  const signed = async (proposal: Proposal): Promise<'signed' | 'waiting' | 'refused'> => {
    for (const { image, digest } of proposal.digests) {
      try {
        await signatures.verify(image, digest, pipeline(repo));
      } catch (error) {
        if (!(error instanceof UnsignedError)) throw error;
        const about = { repo, commit: proposal.commit, image, digest, reason: error.message };
        if (error.kind === 'unsigned' && !waiting.has(digest)) {
          waiting.set(digest, now());
          log.info(about, 'waiting for a build to be signed before proposing it');
        }
        const late = error.kind === 'refused' || now() - (waiting.get(digest) ?? 0) >= SIGNING_GRACE_MS;
        if (late && !warned.has(digest)) {
          warned.add(digest);
          log.warn(about, 'did not propose a build its pipeline did not sign');
        }
        return late ? 'refused' : 'waiting';
      }
    }
    return 'signed';
  };

  /**
   * What a deploy brings, or null when it could not be read: the pull request goes without its list, rather than wait
   * for it, and a later pass fills it in.
   */
  const broughtBy = async (
    moves: readonly Move[],
    order: readonly { sha: string }[],
  ): Promise<Brings | undefined | null> => {
    try {
      return await brings(github, repo, target, moves, order);
    } catch (error) {
      log.warn({ repo, err: error }, 'could not read the pull requests a deploy brings: it goes without them for now');
      return null;
    }
  };

  /** Whether a deploy pull request conflicts with main, or GitHub has yet to say. */
  const conflicts = async (number: number): Promise<boolean | undefined> => {
    const { body: pull } = await github.poll(repo, `/repos/${repo}/pulls/${number}`, MERGEABLE);
    return pull.mergeable === null ? undefined : !pull.mergeable;
  };

  return async () => {
    // One head of main for the whole pass: the pin files, the commits and the branch all come from it.
    const { body: main } = await github.poll(repo, `/repos/${repo}/git/ref/heads/main`, HEAD);
    const head = main.object.sha;
    const { body: commits } = await github.poll(repo, `/repos/${repo}/commits?sha=${head}&per_page=100`, COMMITS);
    const found = (
      await Promise.all(
        target.pins.map(async (pin): Promise<Move | undefined> => {
          const { body: file } = await github.poll(repo, `/repos/${repo}/contents/${pin.file}?ref=${head}`, CONTENT);
          const pinFile = Buffer.from(file.content, 'base64').toString('utf-8');
          const proposal = await newerBuild(deps, pin, pinFile, commits);
          return proposal && { pin, proposal, pinFile };
        }),
      )
    ).filter((m) => m !== undefined);
    // Nothing newer than any pin: whatever was proposed has merged.
    if (!found.length) return proposals.set(target, undefined);
    // A build still being signed is waited for, and the pull request for the builds before stays as it is: the others
    // are not proposed without it only to move a minute later. One its pipeline did not sign is left out.
    const states: Awaited<ReturnType<typeof signed>>[] = [];
    for (const move of found) states.push(await signed(move.proposal));
    if (states.includes('waiting')) return;
    const ready = found.filter((_, i) => states[i] === 'signed');
    const refused = found.filter((_, i) => states[i] === 'refused');
    if (!ready.length) return;
    const all = deployTitle(target, ready.map(runsOf));
    const current = proposed?.found === all && proposed.head === head;
    if (current && proposed?.settled !== false && proposed?.listed !== false) return;

    const [owner] = repo.split('/');
    const { body: pulls } = await github.poll(
      repo,
      `/repos/${repo}/pulls?state=all&sort=created&direction=desc&per_page=20&head=${owner}:${encodeURIComponent(target.branch)}`,
      PULLS,
    );
    const existing = pulls.find((p) => p.state === 'open');
    // A pin whose newest build was refused keeps the older one the open pull request runs: moving the pull request
    // without it would drop that pin, so it stays as it is until the pin has a build that is signed.
    if (existing && refused.some((m) => titleNames(target, existing.title, m.pin))) return;
    // A build whose pull request Martin closed without merging is not proposed again, alone or beside another; the
    // next build of that pin is.
    const closed = pulls.filter((p) => p.state === 'closed' && !p.merged_at);
    const moves = ready.filter((m) => !closed.some((p) => titleRuns(target, p.title, runsOf(m))));
    if (moves.length < ready.length && proposed?.found !== all) {
      log.info(
        { repo, commits: ready.filter((m) => !moves.includes(m)).map((m) => m.proposal.commit) },
        'this build’s deploy pull request was closed; waiting for the next',
      );
    }
    if (!moves.length) {
      proposed = { found: all, title: '', head };
      proposals.set(target, undefined);
      return;
    }
    const title = deployTitle(target, moves.map(runsOf));
    const built = moves.map((m) => m.proposal.commit);
    // Kept for the line only for a deploy of one pin file, whose one move says the range of commits it carries.
    const open = (number: number): DeployProposal | undefined => {
      const [only] = moves;
      if (target.pins.length !== 1 || !only) return undefined;
      return {
        number,
        commit: only.proposal.commit,
        pinned: only.proposal.pinned ?? null,
        digests: only.proposal.digests,
      };
    };
    // Whether its body lists the pull requests it brings, or has none to list: until it does, each pass reads again.
    let listed = true;
    if (existing?.title === title) {
      // Opened by an earlier pass that did not get as far as its label.
      if (!existing.labels.some((l) => l.name === label)) await actions.addLabels(repo, existing.number, [label]);
      proposals.set(target, open(existing.number));
      // Opened by a pass whose read of what it brings failed, or before the body listed them.
      if (!bringsIn(existing.body) && moves.some((m) => m.proposal.pinned)) {
        const read = await broughtBy(moves, commits);
        listed = read !== null;
        if (read)
          await actions.updatePullRequest(repo, existing.number, {
            body: deployBody(target, moves, existing.body, read),
            keepCarries: true,
          });
      }
      // Only its list was left to read: whether it conflicts was settled at this head.
      if (current && proposed?.settled !== false) {
        proposed = { found: all, title, head, ...(listed ? {} : { listed: false as const }) };
        return;
      }
      const conflicting = await conflicts(existing.number);
      // Not known yet: the next pass asks again.
      if (conflicting === undefined) return;
      if (!conflicting) {
        proposed = { found: all, title, head, settled: false, ...(listed ? {} : { listed: false as const }) };
        return;
      }
    } else if (!existing && proposed?.title === title) {
      // A dry run's pull request, which GitHub has never heard of: recorded once, and not again as main moves.
      proposed = { found: all, title, head };
      return;
    }

    // Committed off to the side, so the deploy branch goes from its older commit straight to this one (see above).
    // Each pin file moves in the one commit, so that they merge, and deploy, together.
    const scratch = scratchBranch(target);
    await actions.setBranch(repo, scratch, head, { force: true });
    const pins = await actions.commit(repo, {
      branch: scratch,
      expectedHead: head,
      message: title,
      changes: {
        additions: moves.map(({ pin, proposal, pinFile }) => ({
          path: pin.file,
          contents: new TextEncoder().encode(repin(pinFile, proposal)),
        })),
        deletions: [],
      },
    });
    await actions.setBranch(repo, target.branch, pins, { force: true });
    await actions.deleteBranch(repo, scratch);
    // What a new or moved pull request brings, read once its commit is made, so the read never delays that commit
    // past main's head; one made again on main brings what it did.
    const read = existing?.title === title ? undefined : await broughtBy(moves, commits);
    if (read === null) listed = false;
    if (existing?.title === title) {
      log.info(
        { repo, number: existing.number, commits: built },
        'made the deploy pull request again on main, as it conflicted',
      );
    } else if (existing) {
      // Moved, it keeps what the line said it carries, which the newer build carries too, until the line says again.
      const body = deployBody(target, moves, existing.body, read ?? undefined);
      await actions.updatePullRequest(repo, existing.number, { title, body, keepCarries: true });
      proposals.set(target, open(existing.number));
      log.info({ repo, number: existing.number, commits: built }, 'moved the deploy pull request to a newer build');
    } else {
      const made = await actions.openPullRequest(repo, {
        head: target.branch,
        base: 'main',
        title,
        body: deployBody(target, moves, undefined, read ?? undefined),
        labels: [label],
      });
      proposals.set(target, open(made.number));
      log.info({ repo, number: made.number, commits: built }, 'opened a deploy pull request');
    }
    proposed = { found: all, title, head, ...(listed ? {} : { listed: false as const }) };
  };
}
