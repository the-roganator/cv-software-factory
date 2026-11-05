/**
 * The line adding the app's deploy pull request to the merge queue itself, once its checks have passed, when the review
 * gate passed its head as an exact pin and Martin's level and auto-merge allow (`deploy.ts`); otherwise it waits for
 * Martin, and its record says why. The real line, with only GitHub faked.
 */
import { AUTONOMY, type PayloadOf } from '@software-factory/events';
import { describe, expect, it, vi } from 'vitest';
import { RULES } from '../../../../policy/review-verdict.ts';
import type { ReviewVerdict } from '../../src/github/merging.ts';
import { GitHubWorkerError } from '../../src/github/worker-client.ts';
import { deployWait } from '../../src/line/deploy.ts';
import { waitingHold } from '../../src/line/holds.ts';
import type { FakeGitHub } from './fakes.ts';
import { database, event, events, line, martin, payloads, summaries, ticket, withLineStore } from './harness.ts';

withLineStore();

const sha = (c: string) => c.repeat(40);
const DEPLOY = 30;
const deployHold = { stage: 'release', kind: 'approval', cause: 'deploy', reason: 'Waits for a deploy' } as const;

/** Martin's controls, as the admin service appends them. */
const controls = (set: Partial<PayloadOf<'controls.changed'>>) =>
  martin.append(
    event(
      null,
      'controls.changed',
      {
        autonomy: 'guarded',
        newWork: true,
        autoMerge: true,
        take: null,
        autoRollback: true,
        change: { control: 'auto-merge', before: false, after: true },
        ...set,
      },
      'martin',
    ),
  );

/** A work item merged at `commit` and held for a deploy, on the line. */
async function heldForDeploy(commit: string, route = '/search'): Promise<string> {
  const workItem = await ticket('broken', route);
  await events.append([
    event(workItem, 'pull-request.merged', { number: 15, commit, by: 'martin' }, 'martin'),
    event(workItem, 'hold.started', deployHold),
  ]);
  await database.owner`insert into line (work_item, stage, issue) values (${workItem}, 'held', 14)`;
  return workItem;
}

/** The deploy pull request open on `head`, carrying the fixes merged at 2 and 3, its required check passed. */
function propose(github: FakeGitHub, head: string, number = DEPLOY) {
  github.deploy = { number, commit: sha('3'), pinned: sha('1'), digests: [] };
  github.deployCommits = [sha('2'), sha('3')];
  github.pulls.set(number, {
    number,
    state: 'open',
    merged: false,
    mergeCommit: null,
    mergedBy: null,
    head: { ref: 'deploy/local', sha: head },
    base: { ref: 'main', sha: sha('0') },
    draft: false,
    nodeId: `PR_${number}`,
  });
  github.checks.set(head, [
    {
      id: 1,
      name: 'test',
      status: 'completed',
      conclusion: 'success',
      app: 'github-actions',
      startedAt: '2026-10-06T09:00:00Z',
      completedAt: '2026-10-06T09:05:00Z',
      title: null,
    },
  ]);
}

/** The line with the app's deploy pull request open on `d`, its checks passed, and the gate's rule for its head. */
function lineWith(rule: PayloadOf<'pull-request.enqueued'>['rule'] = 'exact-pin', repo?: string, only?: string) {
  const it = line(undefined, undefined, { deployEveryMs: 0, ...(repo ? { repo } : {}), ...(only ? { only } : {}) });
  it.github.gate = { rule };
  propose(it.github, sha('d'));
  // Every time the line asks, refused or not.
  const asked = vi.spyOn(it.github, 'act');
  const enqueues = () => asked.mock.calls.filter(([action]) => action === 'enqueuePullRequest');
  return { ...it, enqueues };
}

const changes = async (workItem: string) =>
  (await payloads(workItem, 'deploy.changed')).map(({ commit, ...change }) => ({
    head: commit.slice(0, 1),
    ...change,
  }));

describe('why the line does not add a deploy pull request to the merge queue', () => {
  const head = sha('d');
  const judged = (rule: (typeof RULES)[number], extra = {}) => ({
    head,
    judged: { number: DEPLOY, head, rule, tags: [], ...extra },
  });

  it('adds only an exact pin of that head, at Guarded or Lights-out, with auto-merge on', () => {
    for (const autonomy of AUTONOMY) {
      for (const autoMerge of [true, false]) {
        for (const rule of RULES) {
          const wait = deployWait(judged(rule), head, { autonomy, autoMerge });
          const expected =
            rule !== 'exact-pin'
              ? { waits: 'verdict', rule }
              : autonomy === 'supervised'
                ? { waits: 'level' }
                : autoMerge
                  ? undefined
                  : { waits: 'auto-merge' };
          expect(wait, `${autonomy}, auto-merge ${autoMerge}, ${rule}`).toEqual(expected);
        }
      }
    }
  });

  it('waits for a verdict that is pending, missing, or for another head, naming no rule', () => {
    const merging = { autonomy: 'lights-out', autoMerge: true } as const;
    expect(deployWait(judged('exact-pin', { pending: 'test integrity' }), head, merging)).toEqual({ waits: 'verdict' });
    expect(deployWait({ head, judged: null }, head, merging)).toEqual({ waits: 'verdict' });
    expect(deployWait({ ...judged('exact-pin'), head: sha('e') }, head, merging)).toEqual({ waits: 'verdict' });
    expect(deployWait(judged('exact-pin'), sha('e'), merging)).toEqual({ waits: 'verdict' });
  });
});

describe('the line, adding the app’s deploy pull request to the merge queue', () => {
  it('adds an exact pin once at its head, for the first work item it carries, and records it on each until it merges', async () => {
    await controls({});
    const first = await heldForDeploy(sha('2'));
    const second = await heldForDeploy(sha('3'), '/cart');
    const { pass, github, enqueues } = lineWith('exact-pin');
    await pass();
    await pass();
    expect(enqueues()).toEqual([
      ['enqueuePullRequest', expect.any(String), { number: DEPLOY, expectedHead: sha('d') }, { workItem: first }],
    ]);
    for (const workItem of [first, second]) {
      expect(await changes(workItem)).toEqual([
        { head: 'd', pullRequest: DEPLOY, state: 'queued', rule: 'exact-pin', position: 1 },
      ]);
    }
    expect(await summaries(first, 'deploy.changed')).toEqual([
      'Deploy pull request #30 carries it, and the line added it to the merge queue, as the review gate passed it as an exact pin',
    ]);
    // Queued, it waits for the queue, not for Martin.
    expect(await waits(first)).toBeUndefined();

    github.queued.delete(DEPLOY);
    github.merge(DEPLOY);
    await pass();
    expect((await changes(first)).map((c) => c.state)).toEqual(['queued', 'merged']);
    expect(enqueues()).toHaveLength(1);
  });

  it('adds none at Supervised or with auto-merge off, saying why, and adds it once auto-merge is on', async () => {
    const workItem = await heldForDeploy(sha('2'));
    const { pass, enqueues } = lineWith('exact-pin');
    await pass();
    await controls({ autoMerge: false });
    await pass();
    expect(enqueues()).toEqual([]);
    expect(await summaries(workItem, 'deploy.changed')).toEqual([
      'Deploy pull request #30 carries it, and its checks passed: at Supervised the line adds nothing to the merge queue: it waits for Martin to merge it',
      'Deploy pull request #30 carries it, and its checks passed: with auto-merge off it waits for Martin to merge it',
    ]);
    expect(await waits(workItem)).toMatchObject({ cause: 'deploy', pullRequest: DEPLOY });

    await controls({});
    await pass();
    expect(enqueues()).toHaveLength(1);
    expect((await changes(workItem)).map((c) => c.waits ?? c.state)).toEqual(['level', 'auto-merge', 'queued']);
  });

  it('never adds one the gate held, or passed by another rule, whatever the level', async () => {
    await controls({ autonomy: 'lights-out' });
    const workItem = await heldForDeploy(sha('2'));
    const { pass, github, enqueues } = lineWith('held');
    await pass();
    github.gate = { rule: 'lights-out' };
    await pass();
    github.gate = 'none';
    await pass();
    expect(enqueues()).toEqual([]);
    expect((await changes(workItem)).map(({ waits, rule }) => ({ waits, rule }))).toEqual([
      { waits: 'verdict', rule: 'held' },
      { waits: 'verdict', rule: 'lights-out' },
      { waits: 'verdict', rule: undefined },
    ]);
    // The gate's hold of a deploy pull request is no refusal the line records: it records the gate's refusal of a fix.
    expect(await payloads(workItem, 'action.refused')).toEqual([]);
  });

  it('says its checks are running while the gate still judges its head, and is not Martin’s until it has', async () => {
    await controls({});
    const workItem = await heldForDeploy(sha('2'));
    const { pass, github, enqueues } = lineWith('exact-pin');
    github.gate = 'pending';
    await pass();
    // Concluded with a hold only to wait for test integrity, a minute ago: still being judged.
    github.gate = { rule: 'held', pending: 'test integrity has not finished', completedAt: '2026-10-06T08:59:00Z' };
    await pass();
    expect(await changes(workItem)).toEqual([{ head: 'd', pullRequest: DEPLOY, state: 'checking' }]);
    expect(await waits(workItem)).toBeUndefined();
    // Past the wait a fix is given, it is Martin's, saying the gate gave no exact pin.
    github.gate = { rule: 'held', pending: 'test integrity has not finished', completedAt: '2026-10-06T08:40:00Z' };
    await pass();
    expect((await changes(workItem)).at(-1)).toEqual({
      head: 'd',
      pullRequest: DEPLOY,
      state: 'passed',
      waits: 'verdict',
    });
    github.gate = { rule: 'exact-pin' };
    await pass();
    expect(enqueues()).toHaveLength(1);
  });

  it('acting on one work item, adds none that carries another', async () => {
    await controls({});
    const one = await heldForDeploy(sha('2'));
    await heldForDeploy(sha('3'), '/cart');
    const { pass, enqueues } = lineWith('exact-pin', undefined, one);
    await pass();
    expect(enqueues()).toEqual([]);
    expect(await changes(one)).toEqual([{ head: 'd', pullRequest: DEPLOY, state: 'passed' }]);
  });

  it('never adds one on a verdict for an older head', async () => {
    await controls({});
    const workItem = await heldForDeploy(sha('2'));
    const { pass, github, enqueues } = lineWith('exact-pin');
    const read = github.read.bind(github);
    vi.spyOn(github, 'read').mockImplementation(async (name, repo, args) => {
      const answer = await read(name, repo, args);
      if (name !== 'reviewVerdict') return answer;
      // The check on the head judged the pull request as it was before a newer build moved it.
      const verdict = answer as ReviewVerdict;
      return { ...verdict, judged: verdict.judged && { ...verdict.judged, head: sha('c') } } as typeof answer;
    });
    await pass();
    expect(enqueues()).toEqual([]);
    expect(await changes(workItem)).toEqual([{ head: 'd', pullRequest: DEPLOY, state: 'passed', waits: 'verdict' }]);
  });

  it('never adds the factory’s own deploy pull request', async () => {
    await controls({ autonomy: 'lights-out' });
    const workItem = await heldForDeploy(sha('2'));
    const { pass, enqueues } = lineWith('exact-pin', 'the-roganator/cv-software-factory');
    await pass();
    expect(enqueues()).toEqual([]);
    expect(await changes(workItem)).toEqual([{ head: 'd', pullRequest: DEPLOY, state: 'passed' }]);
  });

  it('records the queue taking it out as a wait for Martin, and adds a newer build’s head afresh', async () => {
    await controls({});
    const workItem = await heldForDeploy(sha('2'));
    const { pass, github, enqueues } = lineWith('exact-pin');
    await pass();
    // The queue's checks, each named once however often it ran.
    github.dequeue(DEPLOY, 'failed_checks', ['e2e', 'e2e']);
    await pass();
    await pass();
    expect(enqueues()).toHaveLength(1);
    expect((await changes(workItem)).at(-1)).toEqual({
      head: 'd',
      pullRequest: DEPLOY,
      state: 'dequeued',
      reason: 'failed_checks',
      failed: ['e2e'],
    });
    expect((await summaries(workItem, 'deploy.changed')).at(-1)).toBe(
      'Deploy pull request #30 carries it, and the merge queue took it out (failed_checks): e2e failed. It waits for Martin',
    );
    expect(await waits(workItem)).toMatchObject({ cause: 'deploy', pullRequest: DEPLOY });

    // A newer build moves it to a new head, which is judged and added again.
    propose(github, sha('e'));
    await pass();
    expect(enqueues().map(([, , args]) => args)).toEqual([
      { number: DEPLOY, expectedHead: sha('d') },
      { number: DEPLOY, expectedHead: sha('e') },
    ]);
    expect((await changes(workItem)).at(-1)).toMatchObject({ head: 'e', state: 'queued' });
  });

  it('asks once at a head the GitHub worker refused, records it once, and waits for Martin', async () => {
    await controls({});
    const first = await heldForDeploy(sha('2'));
    const second = await heldForDeploy(sha('3'), '/cart');
    const { pass, github, enqueues } = lineWith('exact-pin');
    github.refusing.set(
      'enqueuePullRequest',
      new GitHubWorkerError(403, 'forbidden', 'deploy/local is not the factory’s', { signed: true }),
    );
    await pass();
    await pass();
    // One request, for one work item, so the worker's signed refusal is relayed once.
    expect(enqueues()).toHaveLength(1);
    expect(enqueues()[0]?.[3]).toEqual({ workItem: first });
    for (const workItem of [first, second]) {
      expect(await changes(workItem)).toEqual([
        {
          head: 'd',
          pullRequest: DEPLOY,
          state: 'passed',
          waits: 'refused',
          said: 'deploy/local is not the factory’s',
        },
      ]);
    }
    expect(await waits(first)).toMatchObject({ cause: 'deploy', pullRequest: DEPLOY });
  });

  it('records nothing when the pull request moved before it was queued, and adds it next pass', async () => {
    await controls({});
    const workItem = await heldForDeploy(sha('2'));
    const { pass, github, enqueues } = lineWith('exact-pin');
    github.refusing.set('enqueuePullRequest', new GitHubWorkerError(409, 'conflict', 'It moved'));
    await pass();
    expect(await changes(workItem)).toEqual([]);
    await pass();
    expect(enqueues()).toHaveLength(2);
    expect((await changes(workItem)).map((c) => c.state)).toEqual(['queued']);
  });

  it('records one already in the queue at that head, which the line added and did not record', async () => {
    await controls({});
    const workItem = await heldForDeploy(sha('2'));
    const { pass, github } = lineWith('exact-pin');
    github.queued.add(DEPLOY);
    github.refusing.set('enqueuePullRequest', new GitHubWorkerError(422, 'unprocessable', 'Already queued'));
    await pass();
    expect(await changes(workItem)).toEqual([
      { head: 'd', pullRequest: DEPLOY, state: 'queued', rule: 'exact-pin', position: 1 },
    ]);
  });

  it('waits for Martin while it conflicts with main', async () => {
    await controls({});
    const workItem = await heldForDeploy(sha('2'));
    const { pass, github, enqueues } = lineWith('exact-pin');
    github.conflicts = true;
    await pass();
    expect(enqueues()).toEqual([]);
    expect(await summaries(workItem, 'deploy.changed')).toEqual([
      'Deploy pull request #30 carries it, and its checks passed: it conflicts with main: it waits for Martin',
    ]);
  });
});

/** The hold that waits for Martin on a work item now, as the alerts read it. */
async function waits(workItem: string) {
  const rows = await database.as.line<{ type: string; payload: unknown; ts: Date }[]>`
    select type, payload, ts from events where work_item = ${workItem} order by seq`;
  return waitingHold(workItem, rows);
}
