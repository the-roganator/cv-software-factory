/**
 * The real line merging through the queue, with only GitHub faked: the review gate's verdict, the autonomy level and
 * auto-merge decide whether the line adds its own pull request to the queue, or holds it for Martin (`merging.ts`).
 */
import { generateKeyPairSync } from 'node:crypto';
import type { PayloadOf } from '@software-factory/events';
import { describe, expect, it } from 'vitest';
import { GitHubWorkerError } from '../../src/github/worker-client.ts';
import { recordBytes, recordHash, type SignedRefusal, signRecord } from '../../src/signed-refusals.ts';
import { clock, event, line, martin, payloads, stage, ticket, types, withLineStore } from './harness.ts';

withLineStore();

const REPO = 'the-roganator/cv-worlds-worst-website';
const { privateKey, publicKey } = generateKeyPairSync('ed25519');

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

/** The review gate's refusal of a head, as the GitHub worker signs it. */
function refusalOf(head: string, key = privateKey): SignedRefusal {
  const facts = {
    repo: REPO,
    number: 12,
    at: '2026-10-06T09:05:00.000Z',
    payload: {
      mechanism: 'review-gate' as const,
      action: `Merge pull request #12 at ${head.slice(0, 7)} in ${REPO}`,
      output: '#12: held for its risk tags: dependency-change',
      guardrails: [2],
      subject: { kind: 'commit', name: head },
    },
  };
  const bytes = recordBytes(facts);
  return JSON.parse(JSON.stringify({ ...facts, record: recordHash(bytes), signature: signRecord(key, bytes) }));
}

/**
 * A ticket carried through plan, build, the gates, review and its description, to its merge; with `integrityAt`, test
 * integrity's run among its gates, finishing then.
 */
async function readyToMerge(options: Parameters<typeof line>[2] = {}, integrityAt?: string) {
  const workItem = await ticket();
  const it = line(undefined, undefined, { refusalKey: publicKey, ...options });
  await it.pass(); // the issue, and the planner
  await it.pass(); // the coder
  it.github.pass();
  if (integrityAt) it.github.integrity(integrityAt);
  await it.pass(); // the gates pass, and the reviewer
  await it.pass(); // the describer
  return { workItem, ...it };
}

const enqueues = (acts: { action: string; args: Record<string, unknown> }[]) =>
  acts.filter((a) => a.action === 'enqueuePullRequest');

describe('the line, merging through the queue', () => {
  it('adds an untagged fix to the queue at Guarded with auto-merge on, and goes on to Release once it merges', async () => {
    await controls({});
    const { workItem, pass, github } = await readyToMerge();
    await pass();
    const head = github.pulls.get(12)?.head.sha;
    expect(enqueues(github.acts)).toEqual([{ action: 'enqueuePullRequest', args: { number: 12, expectedHead: head } }]);
    expect(await payloads(workItem, 'pull-request.enqueued')).toEqual([
      { number: 12, commit: head, rule: 'low-risk', position: 1 },
    ]);
    expect(await types(workItem)).not.toContain('hold.started');
    expect(await stage(workItem)).toBe('review');
    // The queue merges it, and GitHub names the factory, which added it, as the merger.
    await pass();
    expect(enqueues(github.acts)).toHaveLength(1);
    const pr = github.pulls.get(12);
    if (!pr) throw new Error('No pull request #12');
    Object.assign(pr, {
      state: 'closed',
      merged: true,
      mergeCommit: 'c'.repeat(40),
      mergedBy: 'mrogan-software-factory[bot]',
    });
    await pass();
    expect(await payloads(workItem, 'pull-request.merged')).toEqual([
      { number: 12, commit: 'c'.repeat(40), by: 'factory' },
    ]);
    expect((await payloads(workItem, 'hold.started')).at(-1)).toMatchObject({ cause: 'deploy' });
  });

  it('holds it for Martin at Supervised, and with auto-merge off, with the gate’s words and no refusal', async () => {
    const { workItem, pass, github } = await readyToMerge();
    await pass();
    expect(enqueues(github.acts)).toEqual([]);
    expect((await payloads(workItem, 'hold.started')).at(-1)).toMatchObject({
      cause: 'merge',
      reason: expect.stringContaining('at Supervised the line adds nothing to the merge queue'),
      merge: { pullRequest: 12, why: 'level', rule: 'low-risk', approving: false },
    });
    await controls({ autoMerge: false });
    await pass();
    expect((await payloads(workItem, 'hold.started')).at(-1)).toMatchObject({ merge: { why: 'auto-merge' } });
    expect(await types(workItem)).not.toContain('action.refused');
    // Turned on, the next read adds it.
    await controls({});
    await pass();
    expect(await payloads(workItem, 'pull-request.enqueued')).toHaveLength(1);
  });

  it('decides on Martin’s controls as they are this pass, even while what GitHub said is still fresh', async () => {
    await controls({ autoMerge: false });
    // GitHub read at most once a minute, with a minute between the passes that carry it to its merge.
    let at = clock.now;
    const workItem = await ticket();
    const { pass, github } = line(undefined, undefined, {
      refusalKey: publicKey,
      gatesEveryMs: 60_000,
      now: () => new Date(at),
    });
    for (const _ of [1, 2, 3, 4, 5]) {
      at += 61_000;
      if (github.pulls.has(12)) github.pass();
      await pass();
    }
    expect((await payloads(workItem, 'hold.started')).at(-1)).toMatchObject({ merge: { why: 'auto-merge' } });
    // Within the minute GitHub is not asked again, so a check run started since is not seen yet; but the switch he
    // turned on applies at once.
    github.gate = 'pending';
    await controls({});
    await pass();
    expect(await payloads(workItem, 'pull-request.enqueued')).toHaveLength(1);
  });

  it('holds a tagged fix, recording the gate’s refusal once, and adds it once Martin approves its head', async () => {
    await controls({});
    const { workItem, pass, github } = await readyToMerge();
    const head = String(github.pulls.get(12)?.head.sha);
    github.gate = {
      rule: 'held',
      tags: [{ tag: 'dependency-change', because: ['pnpm-lock.yaml'] }],
      refusal: refusalOf(head),
    };
    await pass();
    await pass();
    await pass();
    const refusals = await payloads(workItem, 'action.refused');
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toMatchObject({
      mechanism: 'review-gate',
      guardrails: [2],
      subject: { kind: 'commit', name: head },
      output: '#12: held for its risk tags: dependency-change',
    });
    expect(await payloads(workItem, 'hold.started')).toHaveLength(1);
    expect((await payloads(workItem, 'hold.started'))[0]).toMatchObject({
      cause: 'merge',
      merge: {
        why: 'held',
        rule: 'held',
        tags: [{ tag: 'dependency-change', because: ['pnpm-lock.yaml'] }],
        approving: true,
        said: '#12: held for its risk tags',
      },
    });
    expect(await stage(workItem)).toBe('held');
    expect(enqueues(github.acts)).toEqual([]);
    // Martin approves the head on GitHub: the gate passes it as his approved head, and the line adds it.
    github.gate = { rule: 'martin-approved-head' };
    await pass();
    expect(await payloads(workItem, 'pull-request.enqueued')).toEqual([
      { number: 12, commit: head, rule: 'martin-approved-head', position: 1 },
    ]);
    expect(await payloads(workItem, 'action.refused')).toHaveLength(1);
  });

  it.each(['low-risk', 'held'] as const)(
    'waits on a verdict the gate gave before test integrity finished, refusing nothing, until it judges again (%s)',
    async (rejudged) => {
      await controls({});
      // Test integrity finishes a minute ago; the gate held the head as the pull request opened, before it had run.
      const integrityAt = new Date(clock.now - 60_000).toISOString();
      const early = new Date(clock.now - 10 * 60_000).toISOString();
      const after = new Date(clock.now - 30_000).toISOString();
      const { workItem, pass, github } = await readyToMerge({}, integrityAt);
      const head = String(github.pulls.get(12)?.head.sha);
      const tags = [{ tag: 'dependency-change' as const, because: ['pnpm-lock.yaml'] }];
      github.gate = { rule: 'held', tags, refusal: refusalOf(head), at: early };
      await pass();
      await pass();
      expect(await types(workItem)).not.toContain('action.refused');
      expect(await types(workItem)).not.toContain('hold.started');
      expect(enqueues(github.acts)).toEqual([]);
      expect(await stage(workItem)).toBe('review');
      // The gate judges again once the gates finish: a pass is queued on; a hold is refused once, and held.
      github.gate =
        rejudged === 'held'
          ? { rule: 'held', tags, refusal: refusalOf(head), at: after }
          : { rule: 'low-risk', at: after };
      await pass();
      await pass();
      if (rejudged === 'low-risk') {
        expect(await payloads(workItem, 'pull-request.enqueued')).toEqual([
          { number: 12, commit: head, rule: 'low-risk', position: 1 },
        ]);
        expect(await types(workItem)).not.toContain('action.refused');
        expect(await types(workItem)).not.toContain('hold.started');
      } else {
        expect(await payloads(workItem, 'action.refused')).toHaveLength(1);
        expect(await payloads(workItem, 'hold.started')).toMatchObject([{ cause: 'merge', merge: { why: 'held' } }]);
        expect(enqueues(github.acts)).toEqual([]);
      }
    },
  );

  it('holds for Martin, refusing nothing, when the gate does not judge again after test integrity', async () => {
    await controls({});
    let at = clock.now;
    const integrityAt = new Date(at - 60_000).toISOString();
    const { workItem, pass, github } = await readyToMerge({ now: () => new Date(at) }, integrityAt);
    const head = String(github.pulls.get(12)?.head.sha);
    github.gate = { rule: 'held', refusal: refusalOf(head), at: new Date(at - 10 * 60_000).toISOString() };
    await pass();
    expect(await types(workItem)).not.toContain('hold.started');
    at += 15 * 60_000;
    await pass();
    expect(await types(workItem)).not.toContain('action.refused');
    expect(await payloads(workItem, 'hold.started')).toMatchObject([
      {
        cause: 'merge',
        reason: expect.stringContaining('has not judged #12'),
        merge: { why: 'no-verdict', approving: false },
      },
    ]);
  });

  it('records no refusal it cannot verify, and holds the merge all the same', async () => {
    await controls({});
    const { workItem, pass, github } = await readyToMerge();
    const head = String(github.pulls.get(12)?.head.sha);
    github.gate = { rule: 'held', refusal: refusalOf(head, generateKeyPairSync('ed25519').privateKey) };
    await pass();
    expect(await types(workItem)).not.toContain('action.refused');
    expect((await payloads(workItem, 'hold.started')).at(-1)).toMatchObject({ merge: { why: 'held' } });
  });

  it('records the queue taking it out as an event, with the checks that failed, and holds it', async () => {
    await controls({});
    const { workItem, pass, github } = await readyToMerge();
    await pass();
    expect(await payloads(workItem, 'pull-request.enqueued')).toHaveLength(1);
    github.dequeue(12, 'FAILED_CHECKS', ['test']);
    await pass();
    await pass();
    const head = github.pulls.get(12)?.head.sha;
    expect(await payloads(workItem, 'pull-request.dequeued')).toEqual([
      {
        number: 12,
        commit: head,
        reason: 'failed_checks',
        by: 'github-merge-queue',
        queueCommit: 'd'.repeat(40),
        failed: ['test'],
      },
    ]);
    expect((await payloads(workItem, 'hold.started')).at(-1)).toMatchObject({
      cause: 'merge',
      reason: expect.stringContaining('The merge queue took #12 out (failed_checks): test failed'),
      merge: { why: 'queue', queue: { reason: 'failed_checks', failed: ['test'] } },
    });
    // It does not add that head again.
    expect(enqueues(github.acts)).toHaveLength(1);
  });

  it('records the queue taking it out for a push, by the head it queued, and waits on no queue entry after', async () => {
    await controls({});
    const { workItem, pass, github } = await readyToMerge();
    await pass();
    const queued = github.pulls.get(12)?.head.sha;
    expect(await payloads(workItem, 'pull-request.enqueued')).toMatchObject([{ commit: queued }]);
    // Someone pushes to the branch: GitHub takes it out of the queue, and its read names the new head.
    const pr = github.pulls.get(12);
    if (!pr) throw new Error('No pull request #12');
    pr.head.sha = 'e'.repeat(40);
    github.dequeue(12, 'HEAD_CHANGED');
    github.pass();
    await pass();
    await pass();
    await pass();
    expect(await payloads(workItem, 'pull-request.dequeued')).toMatchObject([
      { number: 12, commit: queued, reason: 'head_changed' },
    ]);
    // Not the head its reviewer passed: held for Martin, not left waiting on the queue.
    expect((await payloads(workItem, 'hold.started')).at(-1)).toMatchObject({ merge: { why: 'unreviewed' } });
    expect(enqueues(github.acts)).toHaveLength(1);
  });

  it('holds a pull request that conflicts with main, saying so, and adds it once it does not', async () => {
    await controls({});
    const { workItem, pass, github } = await readyToMerge();
    github.conflicts = true;
    await pass();
    expect((await payloads(workItem, 'hold.started')).at(-1)).toMatchObject({
      reason: expect.stringContaining('conflicts with main'),
      merge: { why: 'conflict' },
    });
    expect(enqueues(github.acts)).toEqual([]);
    github.conflicts = false;
    await pass();
    expect(await payloads(workItem, 'pull-request.enqueued')).toHaveLength(1);
  });

  it('adds nothing on the gate’s pass alone when the head is not the one its reviewer passed', async () => {
    await controls({});
    const { workItem, pass, github } = await readyToMerge();
    const pr = github.pulls.get(12);
    if (!pr) throw new Error('No pull request #12');
    // Someone pushes to the branch; its gates pass on the new head, and the gate passes it.
    pr.head.sha = 'e'.repeat(40);
    github.pass();
    await pass();
    await pass();
    expect(enqueues(github.acts)).toEqual([]);
    expect((await payloads(workItem, 'hold.started')).at(-1)).toMatchObject({ merge: { why: 'unreviewed' } });
  });

  it('records nothing when the pull request moved before it was queued, and holds one GitHub refuses to add', async () => {
    await controls({});
    const moved = await readyToMerge();
    moved.github.refusing.set('enqueuePullRequest', new GitHubWorkerError(409, 'conflict', 'It moved'));
    await moved.pass();
    expect(await types(moved.workItem)).not.toContain('pull-request.enqueued');
    expect(await types(moved.workItem)).not.toContain('hold.started');
    await moved.pass();
    expect(await payloads(moved.workItem, 'pull-request.enqueued')).toHaveLength(1);
  });

  it('holds one GitHub refuses to add, and does not ask again at that head', async () => {
    await controls({});
    const { workItem, pass, github } = await readyToMerge();
    github.refusing.set('enqueuePullRequest', new GitHubWorkerError(403, 'forbidden', 'Resource not accessible'));
    await pass();
    await pass();
    expect((await payloads(workItem, 'hold.started')).at(-1)).toMatchObject({
      reason: expect.stringContaining('was not added to the merge queue, as it was refused: Resource not accessible'),
      merge: { why: 'refused' },
    });
    expect(await types(workItem)).not.toContain('pull-request.enqueued');
    expect(github.acts.filter((a) => a.action === 'enqueuePullRequest')).toEqual([]);
  });

  it('records one already in the queue at that head, which the line added and did not record, and holds nothing', async () => {
    await controls({});
    const { workItem, pass, github } = await readyToMerge();
    // GitHub took it before the line stopped: asked again, it answers that it cannot add it.
    github.queued.add(12);
    github.refusing.set('enqueuePullRequest', new GitHubWorkerError(422, 'unprocessable', 'Already queued'));
    await pass();
    expect(await payloads(workItem, 'pull-request.enqueued')).toEqual([
      { number: 12, commit: github.pulls.get(12)?.head.sha, rule: 'low-risk', position: 1 },
    ]);
    expect(await types(workItem)).not.toContain('hold.started');
  });

  it('asks again next pass when it cannot read whether GitHub already queued it, and holds nothing', async () => {
    await controls({});
    const { workItem, pass, github } = await readyToMerge();
    github.refusing.set('enqueuePullRequest', new GitHubWorkerError(422, 'unprocessable', 'Already queued'));
    github.failingReads.set('mergeQueue', 1);
    await pass();
    expect(await types(workItem)).not.toContain('hold.started');
    expect(await types(workItem)).not.toContain('pull-request.enqueued');
    await pass();
    expect(await payloads(workItem, 'pull-request.enqueued')).toHaveLength(1);
    expect(await types(workItem)).not.toContain('hold.started');
  });
});
