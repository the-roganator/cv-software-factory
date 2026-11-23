/**
 * A required check that fails or hangs on a pin move's own head is run again from a new head: the queue writes the
 * watch's commit again (`commitAgain`), the same tree on the same parent, with a `Checks-run:` line, so GitHub runs
 * every check and the gate afresh. Through the real pin watch, queue and live actions over one fake repository: the
 * watch takes the commit written again as its own, a restarted worker does too (`own-commit.ts`), and after
 * `RUN_TRIES` runs the pull request is told once and the head waits for Martin.
 */
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiskArtifacts } from '@software-factory/store';
import { afterEach, describe, expect, it } from 'vitest';
import { APP_LOGIN, checksRunOf, DryRunActions, LiveActions, withChecksRun } from '../../src/github/actions.ts';
import { BranchRefused } from '../../src/github/branches.ts';
import { RUN_TRIES } from '../../src/github/deploy-queue.ts';
import { DeployRefused } from '../../src/github/deploys.ts';
import { APP_USER, IssueGuard } from '../../src/github/issues.ts';
import { readPinScope } from '../../src/github/pins.ts';
import { client, quiet } from './fake.ts';
import { type Options, worker } from './pin-worker-harness6.ts';
import { day, FACTORY, FakeRepo, FILES, factoryMoves, pinBranchOf, writes } from './pins-harness.ts';

const closing: (() => void)[] = [];
afterEach(() => {
  for (const close of closing.splice(0)) close();
});

const DASHBOARDS = pinBranchOf('example-dashboards');
const ONLY = readPinScope('example-dashboards');

/** A worker over a repository whose required checks conclude at each head as `conclusion` says. */
async function opened(conclusion: NonNullable<Options['conclusion']>) {
  const repo = new FakeRepo(FILES);
  const scanned = repo.main;
  const today = () => day(scanned, factoryMoves());
  const w = await worker(repo, ONLY, today, closing, { conclusion });
  await w.watchOnly();
  const pull = repo.pulls.find((p) => p.head === DASHBOARDS && p.state === 'open');
  if (!pull) throw new Error('the pin watch opened nothing');
  return { repo, today, w, pull, first: repo.refs.get(DASHBOARDS) as string };
}

describe('a failed check on a pin move’s own head', () => {
  it('is run again from the watch’s commit written again, the same tree on the same parent, and queued once it passes', async () => {
    // The platform job hung on the first head and was cancelled by its time limit.
    const failed = new Set<string>();
    const { repo, w, pull, first } = await opened((head, check) =>
      check === 'platform' && failed.has(head) ? 'cancelled' : 'success',
    );
    failed.add(first);
    await w.queueOnly();
    const again = repo.refs.get(DASHBOARDS) as string;
    expect(again).not.toBe(first);
    expect(repo.made.get(again)?.parents).toEqual(repo.made.get(first)?.parents);
    expect(repo.treeOf(again)).toBe(repo.treeOf(first));
    expect(repo.made.get(again)).toMatchObject({ committer: 'web-flow' });
    expect(repo.messages.get(again)).toBe(withChecksRun(repo.messages.get(first) as string, 2));
    expect(w.heads.get(FACTORY, DASHBOARDS)).toBe(again);
    expect(repo.refs.has(`factory/pin-next/${DASHBOARDS.split('/').at(-1)}`)).toBe(false);
    expect(w.enqueued).toEqual([]);
    // The watch takes it as its own and writes nothing; its checks passed there, the queue adds it at that head.
    w.sent.length = 0;
    await w.pass();
    expect(writes(w.sent).filter((s) => s.path === '/graphql' || s.path.includes('/git/refs'))).toEqual([]);
    expect(w.enqueued).toEqual([{ number: pull.number, head: again }]);
  });

  it('is written again no more after RUN_TRIES runs, and the pull request is told once, across a restart', async () => {
    const { repo, today, w, pull } = await opened(() => 'failure');
    for (let i = 0; i < RUN_TRIES + 2; i++) await w.pass();
    const last = repo.refs.get(DASHBOARDS) as string;
    expect(checksRunOf(repo.messages.get(last) as string)).toBe(RUN_TRIES);
    // A worker started again takes the head as the watch's own, writes it no more, and says nothing twice.
    const next = await worker(repo, ONLY, today, closing, { conclusion: () => 'failure' });
    next.sent.length = 0;
    await next.pass();
    await next.pass();
    expect(repo.refs.get(DASHBOARDS)).toBe(last);
    expect(next.heads.get(FACTORY, DASHBOARDS)).toBe(last);
    const said = [...w.sent, ...next.sent].filter(
      (s) => s.method === 'POST' && s.path.endsWith(`/issues/${pull.number}/comments`),
    );
    expect(said).toHaveLength(1);
    expect(JSON.stringify(said[0]?.body)).toContain(`in ${RUN_TRIES} runs`);
    expect([...w.enqueued, ...next.enqueued]).toEqual([]);
  });

  it('is not written again while another required check still runs there', async () => {
    let running = true;
    const { repo, w, first } = await opened((_head, check) =>
      check === 'platform' ? 'failure' : check === 'image builds' && running ? null : 'success',
    );
    await w.queueOnly();
    await w.queueOnly();
    expect(repo.refs.get(DASHBOARDS)).toBe(first);
    running = false;
    await w.queueOnly();
    expect(repo.refs.get(DASHBOARDS)).not.toBe(first);
  });
});

describe('writing a watch’s commit again', () => {
  const live = (repo: FakeRepo) => {
    const { github } = client(repo.routes());
    return new LiveActions(github, {
      guard: new IssueGuard({ openedBy: async () => ({ by: APP_USER, pullRequest: true }) }),
    });
  };

  it('refuses any branch but a pin move’s or a deploy’s, and one that moved since its head was read', async () => {
    const { repo, first } = await opened(() => 'success');
    const actions = live(repo);
    const cart = repo.commitOn('main', { 'README.md': 'cart\n' }, APP_LOGIN, 'web-flow');
    repo.refs.set('factory/1400-cart', cart);
    await expect(actions.commitAgain(FACTORY, 'factory/1400-cart', cart, 2)).rejects.toBeInstanceOf(DeployRefused);
    await expect(actions.commitAgain(FACTORY, 'feat/cart', cart, 2)).rejects.toBeInstanceOf(BranchRefused);
    await expect(actions.commitAgain(FACTORY, DASHBOARDS, cart, 2)).rejects.toMatchObject({ kind: 'conflict' });
    expect(repo.refs.get(DASHBOARDS)).toBe(first);
    expect(repo.refs.get('factory/1400-cart')).toBe(cart);
  });

  it('keeps every other line of the message', () => {
    const made = 'fix(deps): move a\n\nWhy it moves.\n\nCo-Authored-By: someone <someone@example.invalid>';
    const twice = withChecksRun(withChecksRun(made, 2), 3);
    expect(checksRunOf(made)).toBe(1);
    expect(checksRunOf(twice)).toBe(3);
    expect(twice.replace('\n\nChecks-run: 3', '')).toBe(made);
    expect(withChecksRun('chore(pin): move zap', 2)).toBe('chore(pin): move zap\n\nChecks-run: 2');
  });

  it('in a dry run, records it and moves the branch, as the live one would', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'again-dry-'));
    const made = new DryRunActions(new DiskArtifacts(dir), quiet);
    const sha = await made.commitAgain(FACTORY, DASHBOARDS, 'a'.repeat(40), 2);
    expect(made.branchMade(FACTORY, DASHBOARDS)).toBe(sha);
    await expect(made.commitAgain(FACTORY, 'feat/cart', 'a'.repeat(40), 2)).rejects.toBeInstanceOf(BranchRefused);
    const records = readdirSync(dir).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')));
    expect(records.map((r) => [r.action, r.args])).toEqual([
      ['commitAgain', { branch: DASHBOARDS, head: 'a'.repeat(40), run: 2 }],
    ]);
  });
});
