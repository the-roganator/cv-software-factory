import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cutPending, found, GIVEN_LIMIT, PENDING_LIMIT, readVerdict, TAGS } from '../policy/review-verdict.ts';
import {
  atHead,
  judge,
  MARTIN,
  momentary,
  PIN_BACKOFF_MS,
  type PullRequest,
  QUEUE_BRANCH,
  type Review,
  retrying,
  STACK_LIMIT,
  SUMMARY_LIMIT,
  stackOf,
  summaryOf,
  target as targetIn,
  together,
  unsigned,
  verdict,
} from './review-gate.ts';
import { APP_REPO, FACTORY_APP } from './review-routing.ts';

const HEAD = 'a'.repeat(40);
const EARLIER = 'b'.repeat(40);
const APP = 1_234_567;
/** This repository, as a run's pull requests name it. */
const HERE = { url: 'https://api.github.com/repos/o/r' };
const target = (name: string, event: Parameters<typeof targetIn>[1]) => targetIn(name, event, 'o/r');

const pr = (author: number | null): PullRequest => ({
  number: 7,
  state: 'open',
  user: author === null ? null : { id: author },
  head: { sha: HEAD, ref: 'fix/x', repo: { full_name: 'o/r' } },
  base: { ref: 'main', repo: { full_name: 'o/r' } },
});
const review = (id: number, state: string, commit = HEAD): Review => ({ user: { id }, state, commit_id: commit });

describe('the review gate (ADR 0014)', () => {
  it('passes a pull request Martin opened, by his id', () => {
    expect(verdict(pr(MARTIN), [])).toMatchObject({ pass: true });
    // From someone else's fork, his own pull request waits for his approval like any other.
    const fork = { ...pr(MARTIN), head: { sha: HEAD, ref: 'fix/x', repo: { full_name: 'someone/r' } } };
    expect(verdict(fork, [])).toMatchObject({ pass: false });
    expect(verdict({ ...fork, head: { sha: HEAD, ref: 'fix/x', repo: null } }, [])).toMatchObject({ pass: false });
    expect(verdict(fork, [review(MARTIN, 'APPROVED')])).toMatchObject({ pass: true });
  });

  it("holds anyone else's until Martin approves its head", () => {
    expect(verdict(pr(APP), [])).toMatchObject({ pass: false });
    expect(verdict(pr(null), [])).toMatchObject({ pass: false });
    expect(verdict(pr(APP), [review(MARTIN, 'APPROVED')])).toMatchObject({ pass: true });
  });

  it('counts only Martin: no other approval, the App’s included', () => {
    expect(verdict(pr(APP), [review(APP, 'APPROVED'), review(42, 'APPROVED')])).toMatchObject({ pass: false });
  });

  it('holds an approval of an earlier commit: a push since needs his approval again', () => {
    const said = verdict(pr(APP), [review(MARTIN, 'APPROVED', EARLIER)]);
    expect(said.pass).toBe(false);
    expect(said.title).toContain('bbbbbbb');
    // An approval of a commit GitHub no longer names still holds, and says so plainly.
    const gone = verdict(pr(APP), [{ user: { id: MARTIN }, state: 'APPROVED', commit_id: null }]);
    expect(gone).toEqual({
      pass: false,
      title: 'Martin approved an earlier commit, and it has moved since: waits for him to approve aaaaaaa',
    });
  });

  it('judges a pull request into any branch by the same rule: a stacked one’s, a fork’s', () => {
    const stacked = (author: number): PullRequest => ({
      ...pr(author),
      base: { ref: 'fix/below', repo: { full_name: 'o/r' } },
    });
    expect(verdict(stacked(MARTIN), [])).toMatchObject({ pass: true });
    expect(verdict(stacked(APP), [])).toMatchObject({ pass: false });
    expect(verdict(stacked(APP), [review(MARTIN, 'APPROVED', EARLIER)])).toMatchObject({ pass: false });
    expect(verdict(stacked(APP), [review(MARTIN, 'APPROVED')])).toMatchObject({ pass: true });
    const fork = { ...stacked(MARTIN), head: { sha: HEAD, ref: 'fix/x', repo: { full_name: 'someone/r' } } };
    expect(verdict(fork, [])).toMatchObject({ pass: false });
  });

  it('goes by his latest verdict, and a comment is none', () => {
    expect(verdict(pr(APP), [review(MARTIN, 'APPROVED'), review(MARTIN, 'CHANGES_REQUESTED')])).toMatchObject({
      pass: false,
    });
    expect(verdict(pr(APP), [review(MARTIN, 'CHANGES_REQUESTED'), review(MARTIN, 'APPROVED')])).toMatchObject({
      pass: true,
    });
    expect(verdict(pr(APP), [review(MARTIN, 'APPROVED'), review(MARTIN, 'COMMENTED')])).toMatchObject({ pass: true });
    expect(verdict(pr(APP), [review(MARTIN, 'DISMISSED')])).toMatchObject({ pass: false });
  });

  it('judges the pull request a run names: opened or moved, reviewed, or in the merge queue', () => {
    const run = { head_sha: HEAD, head_branch: 'fix/x', head_repository: { owner: { login: 'someone' } } };
    for (const event of ['pull_request', 'pull_request_review']) {
      expect(
        target('workflow_run', {
          workflow_run: {
            ...run,
            event,
            pull_requests: [
              { number: 6, base: { ref: 'main', repo: { url: 'https://api.github.com/repos/someone/r' } } },
              { number: 7, base: { ref: 'other', repo: HERE } },
              { number: 8, base: { ref: 'main', repo: HERE } },
            ],
          },
        }),
      ).toEqual({ kind: 'pull-request', number: 7 }); // any of this repository's: each with its head is judged
      // A stacked pull request, into the branch below it.
      expect(
        target('workflow_run', {
          workflow_run: { ...run, event, pull_requests: [{ number: 8, base: { ref: 'fix/below', repo: HERE } }] },
        }),
      ).toEqual({ kind: 'pull-request', number: 8 });
      // A fork's own pull request, which a run from its branch can name, is not this repository's.
      const theirs = { number: 3, base: { ref: 'main', repo: { url: 'https://api.github.com/repos/someone/r' } } };
      expect(target('workflow_run', { workflow_run: { ...run, event, pull_requests: [theirs] } }).kind).toBe('find');
      // A fork's: GitHub names no pull request, so it is found by its branch and commit.
      expect(target('workflow_run', { workflow_run: { ...run, event, pull_requests: [] } })).toEqual({
        kind: 'find',
        owner: 'someone',
        branch: 'fix/x',
        commit: HEAD,
      });
      // A deleted fork's names no repository: nothing to find.
      expect(
        target('workflow_run', { workflow_run: { ...run, event, head_repository: null, pull_requests: [] } }).kind,
      ).toBe('none');
    }
    const queue = `gh-readonly-queue/main/pr-7-${EARLIER}`;
    expect(target('workflow_run', { workflow_run: { ...run, event: 'merge_group', head_branch: queue } })).toEqual({
      kind: 'queue',
      number: 7,
      commit: HEAD,
    });
    // However long the base commit's suffix.
    const short = { ...run, event: 'merge_group', head_branch: 'gh-readonly-queue/main/pr-7-1a2b3c4' };
    expect(target('workflow_run', { workflow_run: short })).toMatchObject({ kind: 'queue', number: 7 });
  });

  it('judges nothing a run cannot name: another event, or a branch that is not the queue’s into main', () => {
    const run = { head_sha: HEAD, head_branch: `gh-readonly-queue/main/pr-7-${EARLIER}` };
    expect(target('workflow_run', { workflow_run: { ...run, event: 'push' } })).toEqual({
      kind: 'none',
      reason: 'a review is not asked for by push',
    });
    expect(target('workflow_run', { workflow_run: { ...run, event: 'pull_request_target' } }).kind).toBe('none');
    // A queue branch it cannot read fails the queue's commit, naming the branch, so a queued stack shows its name.
    const other = `gh-readonly-queue/other/pr-7-${EARLIER}`;
    const unread = target('workflow_run', { workflow_run: { ...run, event: 'merge_group', head_branch: other } });
    expect(unread).toMatchObject({ kind: 'none', commit: HEAD });
    expect(unread.kind === 'none' && unread.reason).toContain(other);
    expect(target('push', {}).kind).toBe('none');
    // The gate runs on workflow_run alone: a pull request's own event names nothing.
    expect(target('pull_request_target', {}).kind).toBe('none');
  });
});

describe('a head commit’s verdict', () => {
  const at = (number: number, over: Partial<PullRequest> = {}): PullRequest => ({ ...pr(APP), number, ...over });

  it('is on every open pull request in this repository whose head the commit is', () => {
    const listed = [
      at(9),
      at(7, { base: { ref: 'fix/below', repo: { full_name: 'o/r' } } }),
      // Merged, and containing the commit; or open with the commit below its head; or another repository's.
      at(3, { state: 'closed' }),
      at(4, { head: { sha: EARLIER, ref: 'fix/x', repo: { full_name: 'o/r' } } }),
      at(5, { base: { ref: 'main', repo: { full_name: 'someone/r' } } }),
    ];
    expect(atHead(listed, HEAD, 'o/r').map((p) => p.number)).toEqual([7, 9]);
    // The one already found counts, if the list lags behind, and once.
    expect(atHead([], HEAD, 'o/r', at(9)).map((p) => p.number)).toEqual([9]);
    expect(atHead(listed, HEAD, 'o/r', at(9)).map((p) => p.number)).toEqual([7, 9]);
    // A closed one found, with no open one at its head: nothing.
    expect(atHead([], HEAD, 'o/r', at(9, { state: 'closed' }))).toEqual([]);
  });

  it('passes only when each passes, whichever asked, and names those that do not', () => {
    const pass = { pass: true, title: 'Martin approved aaaaaaa' };
    const held = { pass: false, title: 'Waits for Martin to approve aaaaaaa' };
    expect(together([{ number: 7, said: pass }])).toEqual(pass);
    expect(together([{ number: 7, said: held }])).toEqual(held);
    expect(
      together([
        { number: 7, said: pass },
        { number: 9, said: pass },
      ]),
    ).toEqual({
      pass: true,
      title: 'Each of #7, #9 passes',
    });
    expect(
      together([
        { number: 7, said: pass },
        { number: 9, said: held },
      ]),
    ).toEqual({
      pass: false,
      title: '#9: Waits for Martin to approve aaaaaaa',
    });
    // Several held, however many: one line.
    const many = [1, 2, 3, 4, 5, 6, 7].map((number) => ({ number, said: held }));
    expect(together(many)).toEqual({
      pass: false,
      title: '#1, #2, #3, #4, #5 and 2 more do not pass: each waits for Martin',
    });
    // Two pull requests at one commit, from different branches: both runs judge both, and agree.
    const two = [
      { number: 7, said: verdict(at(7), [review(MARTIN, 'APPROVED')]) },
      { number: 9, said: verdict(at(9), []) },
    ];
    expect(together(two).pass).toBe(false);
  });
});

describe('a queued stack', () => {
  /** A pull request from `head` into `base`, opened by the App. */
  const from = (number: number, head: string, base: string, over: Partial<PullRequest> = {}): PullRequest => ({
    ...pr(APP),
    number,
    head: { sha: HEAD, ref: head, repo: { full_name: 'o/r' } },
    base: { ref: base, repo: { full_name: 'o/r' } },
    ...over,
  });
  /** The open pull requests GitHub would list from each branch, as the gate asks for them. */
  const listing = (prs: readonly PullRequest[]) => {
    const asked: string[] = [];
    const below = async (branch: string) => {
      asked.push(branch);
      return prs.filter((each) => each.head.ref === branch);
    };
    return { asked, below };
  };
  // As #665 was queued: #657 into main, and each above it into the branch of the one below.
  const s657 = from(657, 'feat/flags-off', 'main');
  const s658 = from(658, 'feat/flags-compare', 'feat/flags-off');
  const s659 = from(659, 'feat/flags-checked', 'feat/flags-compare');

  it('is one pull request, for one into main, and asks for nothing more', async () => {
    const { asked, below } = listing([]);
    expect(await stackOf(s657, 'o/r', below)).toEqual({ prs: [s657] });
    expect(asked).toEqual([]);
  });

  it('follows each base down to the pull request into main, and is judged from the bottom up', async () => {
    const { asked, below } = listing([s657, s658, s659]);
    expect((await stackOf(s659, 'o/r', below)).prs?.map((p) => p.number)).toEqual([657, 658, 659]);
    expect(asked).toEqual(['feat/flags-compare', 'feat/flags-off']);
    // Every one is judged: one waiting for Martin holds the queue's commit of every pull request above it.
    const held = verdict(s657, []);
    const approved = verdict(s658, [review(MARTIN, 'APPROVED')]);
    expect(
      together([
        { number: 657, said: held },
        { number: 658, said: approved },
      ]),
    ).toEqual({ pass: false, title: '#657: Waits for Martin to approve aaaaaaa' });
  });

  it('counts only an open pull request from this repository’s branch of that name, into this repository', async () => {
    const theirs = from(657, 'feat/flags-off', 'main', {
      head: { sha: HEAD, ref: 'feat/flags-off', repo: { full_name: 'someone/r' } },
    });
    const gone = from(657, 'feat/flags-off', 'main', { head: { sha: HEAD, ref: 'feat/flags-off', repo: null } });
    const elsewhere = from(657, 'feat/flags-off', 'main', { base: { ref: 'main', repo: { full_name: 'someone/r' } } });
    for (const one of [theirs, gone, elsewhere, { ...s657, state: 'closed' }]) {
      expect(await stackOf(s658, 'o/r', listing([one]).below)).toEqual({
        reason: '#658 is into feat/flags-off, which no open pull request here comes from',
      });
    }
    // The listing is GitHub's: one from another branch, however it came back, is not the one below.
    const other = from(9, 'feat/other', 'main');
    expect((await stackOf(s658, 'o/r', async () => [other])).reason).toContain('no open pull request here comes from');
  });

  it('fails when the one below has merged and the one above is not yet into main, until it is', async () => {
    // GitHub retargets the one above to main once the one below merges; the queue's next try judges it as into main.
    expect((await stackOf(s658, 'o/r', listing([]).below)).reason).toBe(
      '#658 is into feat/flags-off, which no open pull request here comes from',
    );
    expect(await stackOf({ ...s658, base: s657.base }, 'o/r', listing([]).below)).toMatchObject({
      prs: [{ number: 658 }],
    });
  });

  it('fails when two pull requests come from the branch below, into different bases', async () => {
    const twice = from(700, 'feat/flags-off', 'fix/elsewhere');
    expect((await stackOf(s658, 'o/r', listing([s657, twice]).below)).reason).toBe(
      '#658 is into feat/flags-off, which #657, #700 all come from: no one stack below it',
    );
  });

  it('fails on a loop, and on a stack deeper than it follows', async () => {
    const a = from(1, 'a', 'b');
    const b = from(2, 'b', 'a');
    expect((await stackOf(a, 'o/r', listing([a, b]).below)).reason).toBe('the stack below #1 comes back to #1');
    const tall = Array.from({ length: STACK_LIMIT + 1 }, (_, i) =>
      from(i + 1, `s${i + 1}`, i === 0 ? 'main' : `s${i}`),
    );
    const top = tall.at(-1) as PullRequest;
    expect((await stackOf(top, 'o/r', listing(tall).below)).reason).toBe(
      `the stack #${top.number} heads is longer than ${STACK_LIMIT} pull requests, which the gate follows`,
    );
    // One fewer is followed to main.
    const fits = tall.at(-2) as PullRequest;
    expect((await stackOf(fits, 'o/r', listing(tall).below)).prs).toHaveLength(STACK_LIMIT);
  });
});

describe("the check's summary", () => {
  it('fits GitHub’s limit, cutting what gave each tag but never a rule, a tag or a head', () => {
    const long = (n: number) => Array.from({ length: GIVEN_LIMIT }, (_, i) => `src/${n}/${'x'.repeat(110)}-${i}.ts`);
    const tags = [found('code-owned', long(1)), found('improvement', long(2)), found('security-headers', long(3))];
    const judged = Array.from({ length: 12 }, (_, i) => ({
      pr: { ...pr(APP), number: i + 1 },
      said: { pass: false, title: 'Held for its risk tags', rule: 'held' as const, tags },
    }));
    const summary = summaryOf(HEAD, judged);
    expect(summary.length).toBeLessThanOrEqual(SUMMARY_LIMIT);
    const read = readVerdict(summary);
    expect(read).toMatchObject({ commit: HEAD });
    if ('error' in read) throw new Error(read.error);
    expect(read.judged.map((j) => [j.number, j.rule, j.tags.map((t) => t.tag)])).toEqual(
      judged.map(({ pr }) => [pr.number, 'held', ['code-owned', 'improvement', 'security-headers']]),
    );
    expect(read.judged[0]?.tags[0]?.more).toBeGreaterThan(0);
    // A short one is not cut.
    const one = readVerdict(summaryOf(HEAD, judged.slice(0, 1)));
    expect('judged' in one && one.judged[0]?.tags[0]?.because).toHaveLength(GIVEN_LIMIT);
  });

  it('carries a hold that waits for a read as pending, and no other', () => {
    const waits = { pass: false, title: 'Waits for test integrity', rule: 'held' as const, tags: [], pending: 'x' };
    const held = {
      pass: false,
      title: 'Held for its risk tags',
      rule: 'held' as const,
      tags: [found('release', ['y'])],
    };
    const read = readVerdict(
      summaryOf(HEAD, [
        { pr: { ...pr(APP), number: 1 }, said: waits },
        { pr: { ...pr(APP), number: 2 }, said: held },
      ]),
    );
    if ('error' in read) throw new Error(read.error);
    expect(read.judged.map((j) => j.pending)).toEqual(['x', undefined]);
    expect('pending' in (read.judged[1] ?? {})).toBe(false);
  });

  it('keeps a pending hold within its bound, and the summary within its limit with it', () => {
    const tags = TAGS.map((t) =>
      found(
        t,
        Array.from({ length: 40 }, (_, i) => `${'p'.repeat(200)}/${i}`),
      ),
    );
    const waits = { pass: false, title: 'Waits', rule: 'held' as const, tags, pending: 'w'.repeat(PENDING_LIMIT * 2) };
    const judged = Array.from({ length: 12 }, (_, i) => ({ pr: { ...pr(APP), number: i + 1 }, said: waits }));
    const summary = summaryOf(HEAD, judged);
    expect(summary.length).toBeLessThanOrEqual(SUMMARY_LIMIT);
    const read = readVerdict(summary);
    if ('error' in read) throw new Error(read.error);
    expect(read.judged.every((j) => j.pending === 'w'.repeat(PENDING_LIMIT))).toBe(true);
  });

  it('cuts a pending hold once, by code points, so a character is never split and the line reads it', () => {
    const reason = `${'x'.repeat(PENDING_LIMIT - 1)}🛑🛑`;
    const waits = { pass: false, title: 'Waits', rule: 'held' as const, tags: [], pending: reason };
    const read = readVerdict(summaryOf(HEAD, [{ pr: pr(APP), said: waits }]));
    if ('error' in read) throw new Error(read.error);
    expect(read.judged[0]?.pending).toBe(`${'x'.repeat(PENDING_LIMIT - 1)}🛑`);
    expect(cutPending(reason)).toBe(read.judged[0]?.pending);
  });
});

describe("the review gate's workflows", () => {
  const gate = readFileSync('.github/workflows/review.yml', 'utf-8');
  const requested = readFileSync('.github/workflows/review-requested.yml', 'utf-8');
  /** A workflow's triggers, the keys under `on:`. */
  const triggers = (workflow: string) =>
    [...(workflow.match(/^on:\n((?: {2}.*\n|\n)*)/m)?.[1] ?? '').matchAll(/^ {2}([\w-]+):/gm)].map((m) => m[1]).sort();

  it('run only main’s copy with the key, and never check out the pull request', () => {
    // workflow_run runs the workflow as main has it; pull_request would run the change's copy. GitHub's default event
    // policy blocks pull_request_target in public repositories.
    expect(triggers(gate)).toEqual(['workflow_call', 'workflow_run']);
    expect(gate).toMatch(/workflow_run:\n {4}workflows: \[review requested\]\n/);
    expect(requested).toMatch(/^name: review requested$/m);
    // The key is in an environment only main may use: a pull request into another branch runs that branch's copy.
    expect(gate).toMatch(/^ {4}environment: review$/m);
    // The review App's Client ID, and its key from that environment or a caller; nothing posts without the key.
    expect(gate).toMatch(
      /client-id: Iv23liFNqAvApddT27zU\n {10}private-key: \$\{\{ secrets\.REVIEW_APP_PRIVATE_KEY \}\}\n/,
    );
    expect(gate).toMatch(/- id: app\n {8}if: env\.HAS_KEY == 'true'\n/);
    expect(gate).toMatch(/^permissions: \{\}$/m);
    // Its job reads this repository, to check out the gate, and pull requests; it writes nothing with its own token.
    // And test integrity's check run, which low-risk needs.
    expect(gate).toMatch(/^ {4}permissions:\n {6}contents: read\n {6}pull-requests: read\n {6}checks: read\n {4}env:/m);
    // The one checkout is this workflow's own commit, main's, and never the pull request's.
    expect(gate.match(/uses: actions\/checkout@/g)).toHaveLength(1);
    expect(gate).toMatch(/ref: \$\{\{ job\.workflow_sha \}\}\n/);
    // Nothing the pull request's author writes reaches a step: its branch names only the concurrency group.
    const steps = gate.slice(gate.indexOf('\njobs:\n'));
    expect(steps).not.toMatch(/github\.event\.(pull_request|workflow_run)\.(head|title|body|user)|github\.head_ref/);
  });

  it('read AUTONOMY as the caller’s variable, in main’s copy, never from an input', () => {
    // A called workflow's `vars` are its caller's; only an admin of that repository can set one.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, as the workflow holds it
    expect(gate).toContain('          AUTONOMY: ${{ vars.AUTONOMY }}\n        run: node scripts/review-gate.ts\n');
    expect(gate).not.toMatch(/inputs/);
    // The gate's modules, and nothing of the pull request's, from main's sparse checkout; cosign for an exact pin.
    expect(gate).toMatch(
      /sparse-checkout: \|\n {12}mise\.toml\n {12}mise\.lock\n {12}scripts\/review-gate\.ts\n {12}scripts\/review-routing\.ts\n {12}policy\/review-verdict\.ts\n/,
    );
    expect(gate).toContain('install_args: node cosign');
  });

  it('check out every module the gate imports', () => {
    // Everything the gate's files import beyond Node is in the sparse checkout, so main's copy runs whole.
    for (const file of ['scripts/review-gate.ts', 'scripts/review-routing.ts', 'policy/review-verdict.ts']) {
      for (const [, path] of readFileSync(file, 'utf-8').matchAll(/^(?:import|export) [^;]*? from '(\.[^']+)';$/gms)) {
        const resolved = new URL(path ?? '', new URL(file, 'file:///r/')).pathname.slice(3);
        expect(gate).toContain(`            ${resolved}\n`);
      }
    }
  });

  it('take the key from a caller by name, and need it from none', () => {
    expect(gate).toMatch(
      /workflow_call:\n {4}secrets:\n {6}REVIEW_APP_PRIVATE_KEY:\n {8}description: .+\n {8}required: false\n/,
    );
  });

  it('key a run by the branch that asked, and a deleted fork’s by its own id', () => {
    // By the asking run's repository and branch, whatever the folding of the expression.
    const group = (gate.match(/^ {2}group: >-\n((?: {4}.*\n)+)/m)?.[1] ?? '').replace(/\s+/g, ' ').trim();
    expect(group).toBe(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, as the workflow holds it
      "review-${{ github.event.workflow_run.head_repository.full_name || format('gone-{0}', github.run_id) }}:${{ github.event.workflow_run.head_branch }}",
    );
  });

  it('read the merge queue’s branch as pr-title.yml does', () => {
    // pr-title.yml matches the branch in bash: the one expression, with the slashes JavaScript escapes left bare.
    const title = readFileSync('.github/workflows/pr-title.yml', 'utf-8');
    expect(title).toContain(`[[ "$QUEUE_BRANCH" =~ ${QUEUE_BRANCH.source.replaceAll('\\/', '/')} ]]`);
    expect(title).toContain('BASH_REMATCH[2]');
  });

  it('ask for it when a pull request into any branch opens or moves, on a review and in the merge queue, holding nothing and running nothing', () => {
    expect(triggers(requested)).toEqual(['merge_group', 'pull_request', 'pull_request_review']);
    // No base filter: a stacked pull request, into the branch below it, needs the check too; `edited` covers its
    // retargeting when the one below merges.
    expect(requested).toMatch(
      /pull_request:\n {4}types: \[opened, reopened, synchronize, ready_for_review, edited, unlabeled\]\n/,
    );
    expect(requested).toMatch(/^permissions: \{\}$/m);
    expect(requested).not.toMatch(/uses:|secrets\./);
  });
});

describe('judging a pull request through the API', () => {
  const run = { repo: APP_REPO, read: 't', token: '', autonomy: '', print: true };
  const theirs: PullRequest = {
    number: 9,
    state: 'open',
    user: { id: FACTORY_APP },
    head: { sha: HEAD, ref: 'factory/9-fix', repo: { full_name: APP_REPO } },
    base: { ref: 'main', repo: { full_name: APP_REPO } },
    changed_files: 1,
  };
  /** GitHub, as the gate reads it: each path's answer, or a status it fails with. */
  const github = (over: Record<string, unknown> = {}) => {
    const answers: Record<string, unknown> = {
      '/pulls/9/reviews': [],
      '/pulls/9/files': [{ filename: 'src/a.ts', status: 'modified', patch: '+const a = 1;' }],
      '/issues/9/events': [],
      '/check-runs?': {
        check_runs: [
          {
            id: 5,
            name: 'gates / test integrity',
            head_sha: HEAD,
            status: 'completed',
            conclusion: 'success',
            app: { slug: 'github-actions' },
            output: { annotations_count: 0 },
          },
        ],
      },
      '/check-runs/5/annotations': [],
      '/contents/.github/CODEOWNERS': '/deploy/ @mrogan\n',
      ...over,
    };
    vi.stubGlobal('fetch', async (url: string) => {
      const path = new URL(url).pathname + new URL(url).search;
      const key = Object.keys(answers)
        .filter((k) => path.includes(k))
        .sort((a, b) => b.length - a.length)[0];
      const answer = key === undefined ? 404 : answers[key];
      if (typeof answer === 'number') return new Response('no', { status: answer });
      return typeof answer === 'string' ? new Response(answer) : Response.json(answer);
    });
  };
  afterEach(() => vi.unstubAllGlobals());

  it("passes the App's untagged pull request with test integrity read", async () => {
    github();
    expect(await judge(run, theirs)).toMatchObject({ pass: true, rule: 'low-risk' });
  });

  it('holds it, posting a verdict, when GitHub fails to give its reviews', async () => {
    github({ '/pulls/9/reviews': 502 });
    const said = await judge(run, theirs);
    expect(said).toMatchObject({ pass: false, rule: 'held' });
    expect(said.title).toContain('could not read');
    // A read that failed is a hold, not a wait: it may fail for ever, and nothing runs the gate again for it.
    expect(said.pending).toBeUndefined();
    // Martin's own still passes: his say needs no review.
    const his = { ...theirs, user: { id: MARTIN } };
    expect(await judge(run, his)).toMatchObject({ pass: true, rule: 'martin-opened' });
  });

  it('holds it when the annotations GitHub gives are not as many as the run says, more or fewer', async () => {
    const warning = { path: 'test/a.test.ts', annotation_level: 'warning', message: 'x' };
    for (const given of [[], [warning, warning]]) {
      github({
        '/check-runs?': {
          check_runs: [
            {
              id: 5,
              name: 'gates / test integrity',
              head_sha: HEAD,
              status: 'completed',
              conclusion: 'success',
              app: { slug: 'github-actions' },
              output: { annotations_count: 1 },
            },
          ],
        },
        '/check-runs/5/annotations': given,
      });
      const said = await judge(run, theirs);
      expect(said).toMatchObject({ pass: false, rule: 'held' });
      // The warnings it did give are a tag, which the level does not pass, so the tag is what it is held for.
      expect(said.title).toContain(
        given.length ? 'Held for its risk tags (test-loosening)' : 'GitHub gave 0 of its 1 annotations',
      );
      // The run has completed, so no new reading is coming: a hold, not a wait.
      expect(said.pending).toBeUndefined();
    }
  });

  it('waits for test integrity while its run is queued or in progress at the head', async () => {
    for (const status of ['queued', 'in_progress']) {
      github({
        '/check-runs?': {
          check_runs: [
            {
              id: 5,
              name: 'gates / test integrity',
              head_sha: HEAD,
              status,
              conclusion: null,
              app: { slug: 'github-actions' },
            },
          ],
        },
      });
      expect(await judge(run, theirs)).toMatchObject({
        pass: false,
        rule: 'held',
        pending: 'test integrity is still running at aaaaaaa',
      });
    }
    // Not run at all yet, the same.
    github({ '/check-runs?': { check_runs: [] } });
    expect(await judge(run, theirs)).toMatchObject({ rule: 'held', pending: 'test integrity has not run at aaaaaaa' });
  });

  describe('an exact pin it could not check', () => {
    const pinPr: PullRequest = { ...theirs, head: { ...theirs.head, ref: 'factory/deploy' } };
    const digest = (c: string) => `sha256:${c.repeat(64)}`;
    const pinFiles = [
      {
        filename: 'deploy/website/kustomization.yaml',
        status: 'modified',
        patch: `@@ -1,3 +1,3 @@\n images:\n-- digest: ${digest('1')}\n+- digest: ${digest('2')}\n   newName: ghcr.io/the-roganator/cv-worlds-worst-website`,
      },
    ];
    const kustomization = `images:\n- digest: ${digest('2')}\n  newName: ghcr.io/the-roganator/cv-worlds-worst-website\n`;
    afterEach(() => vi.useRealTimers());

    it('is tried again, and if it still cannot be made, a wait that names why: never a pass, nor its tags', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout'] });
      let tokens = 0;
      github({
        '/pulls/9/files': pinFiles,
        '/contents/deploy/website/kustomization.yaml': kustomization,
      });
      const answer = globalThis.fetch;
      vi.stubGlobal('fetch', async (url: string) => {
        if (url.startsWith('https://ghcr.io/token')) {
          tokens++;
          return new Response('down', { status: 503 });
        }
        return answer(url);
      });
      const judging = judge(run, pinPr);
      await vi.runAllTimersAsync();
      const said = await judging;
      // Once, and once after each wait, for the digest it sets and the one it replaces: none is kept to answer the next.
      expect(tokens).toBe(2 * (PIN_BACKOFF_MS.length + 1));
      expect(said).toMatchObject({ pass: false, rule: 'held' });
      expect(said.unchecked).toContain('ghcr.io answered 503');
      expect(said.pending).toContain('the gate could not check its exact pin');
      expect(said.title).toContain('Not judged yet: the gate could not check its exact pin');
      // deploy/ is code-owned, and that tag is still found, but it is not what holds it.
      expect(said.tags.map((t) => t.tag)).toEqual(['code-owned']);
      expect(said.title).not.toContain('risk tags');
    });

    it('is a judgement when GHCR answers that the image is not there, said in the hold', async () => {
      github({
        '/pulls/9/files': pinFiles,
        '/contents/deploy/website/kustomization.yaml': kustomization,
      });
      const answer = globalThis.fetch;
      vi.stubGlobal('fetch', async (url: string) => {
        if (url.startsWith('https://ghcr.io/token')) return Response.json({ token: 'x' });
        if (url.startsWith('https://ghcr.io/v2/')) return new Response('none', { status: 404 });
        return answer(url);
      });
      const said = await judge(run, pinPr);
      expect(said).toMatchObject({ pass: false, rule: 'held' });
      expect(said.pending).toBeUndefined();
      expect(said.title).toContain(
        `Not an exact pin: ghcr.io/the-roganator/cv-worlds-worst-website@${'2'.repeat(7)}: ghcr.io answered 404`,
      );
    });
  });
});

describe('trying a check that could not be made again', () => {
  const clock = (start = 0) => {
    let at = start;
    const waits: number[] = [];
    return {
      waits,
      now: () => at,
      sleep: async (ms: number) => {
        waits.push(ms);
        at += ms;
      },
    };
  };
  const failing = (times: number) => {
    let tried = 0;
    return async () => {
      tried++;
      if (tried <= times) throw new Error(`try ${tried}`);
      return 'checked';
    };
  };

  it('tries again after each wait, and stops at the first that answers', async () => {
    const c = clock();
    expect(await retrying(failing(2), [5, 15, 30], 1_000, c)).toBe('checked');
    expect(c.waits).toEqual([5, 15]);
  });

  it('gives the last error once the waits run out, or the next try would start too late', async () => {
    const c = clock();
    await expect(retrying(failing(9), [5, 15], 1_000, c)).rejects.toThrow('try 3');
    const late = clock(990);
    await expect(retrying(failing(9), [5, 15], 1_000, late)).rejects.toThrow('try 2');
    expect(late.waits).toEqual([5]);
  });

  it('tells a missing signature from a look that failed', () => {
    expect(unsigned('Error: no matching signatures: none of the expected identities matched')).toBe(true);
    expect(unsigned('Error: no signatures found')).toBe(true);
    // cosign gathers what it could not verify under "no matching signatures" too.
    expect(unsigned('Error: no matching signatures: Get "https://rekor.sigstore.dev/api": dial tcp: i/o timeout')).toBe(
      false,
    );
    expect(unsigned('Error: no matching signatures: unexpected status code 503')).toBe(false);
    expect(unsigned('Error: getting signatures: GET https://ghcr.io/v2/x: unexpected EOF')).toBe(false);
    expect(unsigned('Error: fetching TUF root: connection refused')).toBe(false);
    expect([408, 429, 500, 502, 503].every(momentary)).toBe(true);
    expect([401, 403, 404].some(momentary)).toBe(false);
  });
});
