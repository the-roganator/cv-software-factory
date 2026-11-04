import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  atHead,
  MARTIN,
  type PullRequest,
  QUEUE_BRANCH,
  type Review,
  STACK_LIMIT,
  stackOf,
  target as targetIn,
  together,
  verdict,
} from './review-gate.ts';

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
