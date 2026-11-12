/**
 * What a worker that asks was refused at the door, tried shape by shape. The door is the real one, asked with raw
 * bodies; the queue's conditions are its own functions.
 */
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiskArtifacts } from '@software-factory/store';
import { listenLocal } from '@software-factory/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { type Actions, LiveActions } from '../../src/github/actions.ts';
import { BranchRefused, pinBranch } from '../../src/github/branches.ts';
import { GitHubError } from '../../src/github/client.ts';
import {
  checksWait,
  type LabelEvents,
  labelWait,
  pinPullWait,
  type QueuePull,
  toldWait,
  verdictWait,
} from '../../src/github/deploy-queue.ts';
import { APP_USER, IssueGuard, MARTIN } from '../../src/github/issues.ts';
import { guardPinBranch, pinBranchFor } from '../../src/github/pin-guard.ts';
import { readPinScope } from '../../src/github/pins.ts';
import type { CheckRun, Reads } from '../../src/github/reads.ts';
import { RefusalRecorder } from '../../src/github/refusals.ts';
import { createWorkerServer } from '../../src/github/server.ts';
import { doorReads } from './door-reads.ts';
import { client, quiet, type Sent } from './fake.ts';

const REPO = 'the-roganator/cv-software-factory';
const APP = 'the-roganator/cv-worlds-worst-website';
const SHA = 'a'.repeat(40);
const PIN = 1040;

let close: (() => void) | undefined;
afterEach(() => close?.());

/** Actions that say which were reached, and do nothing. */
function reaching() {
  const reached: string[] = [];
  const actions = new Proxy({ dryRun: false } as Actions, {
    get: (target, name) =>
      name === 'dryRun'
        ? target.dryRun
        : async () => {
            reached.push(String(name));
            return null;
          },
  });
  return { actions, reached };
}

/** The door, with #1040 the pin watch's pull request, asked with a body as it is sent. */
async function door(options: { reads?: Reads; actions?: Actions; dryRun?: Actions; dryRunReads?: Reads } = {}) {
  const { actions, reached } = reaching();
  const dir = mkdtempSync(join(tmpdir(), 'redteam3-refused-'));
  const asked: [string, number][] = [];
  const reads =
    options.reads ??
    ({
      pullRequest: async (repo: string, number: number) => {
        asked.push([repo, number]);
        return doorReads({ [PIN]: 'factory/pin/zap', 7: 'factory/7-cart' }).pullRequest(repo, number);
      },
    } as unknown as Reads);
  const server = createWorkerServer({
    actions: options.actions ?? actions,
    reads,
    dryRun: options.dryRun,
    dryRunReads: options.dryRunReads,
    repositories: [REPO, APP],
    health: () => ({}),
    recorder: new RefusalRecorder({ artifacts: new DiskArtifacts(dir), log: quiet }),
    log: quiet,
  });
  const { url } = await listenLocal(server);
  close = () => server.close();
  const post = async (action: string, body: string, headers: Record<string, string> = {}) => {
    const response = await fetch(`${url}/v1/actions/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body,
    });
    return { status: response.status, body: (await response.json()) as { error?: string; refusal?: unknown } };
  };
  const kept = () => readdirSync(dir, { recursive: true }).filter((f) => /[0-9a-f]{16}/.test(String(f))).length;
  return { post, reached, asked, kept };
}

describe('red-team 3, refused: the door’s guard and the shapes a number can take', () => {
  it('sees the number in every shape that parses, and refuses the pin pull request each time', async () => {
    const { post, reached } = await door();
    const refusedAsPin = [
      ['comment', `{"repo":"${REPO}","number":1040,"body":"x"}`],
      ['comment', `{"repo":"${REPO}","number":1040.0,"body":"x"}`],
      ['comment', `{"repo":"${REPO}","number":1.04e3,"body":"x"}`],
      ['comment', `{"repo":"${REPO}","number":10400e-1,"body":"x"}`],
      // The last of two is the one JSON keeps, the one the action would take, and the one the guard reads.
      ['comment', `{"repo":"${REPO}","number":7,"number":1040,"body":"x"}`],
      ['comment', `{"number":1040,"body":"x","repo":"${REPO}"}`],
      ['readyForReview', `{"repo":"${REPO}","pullRequest":{"number":1040,"url":"u","nodeId":"PR_other"}}`],
      ['convertToDraft', `{"repo":"${REPO}","pullRequest":{"nodeId":"PR_7","url":"u","number":1040}}`],
      ['enqueuePullRequest', `{"repo":"${REPO}","number":1040,"expectedHead":"${SHA}"}`],
      ['addLabels', `{"repo":"${REPO}","number":1040,"labels":["bug"]}`],
      ['closePullRequest', `{"repo":"${REPO}","number":1040,"comment":"gone"}`],
      ['reopenIssue', `{"repo":"${REPO}","number":1040,"comment":"again"}`],
      ['updatePullRequest', `{"repo":"${REPO}","number":1040,"title":"t"}`],
      ['describeDeploy', `{"repo":"${REPO}","number":1040,"commit":"${SHA}","carries":[]}`],
      ['closeIssue', `{"repo":"${REPO}","number":1040,"reason":"not_planned"}`],
      ['review', `{"repo":"${REPO}","number":1040,"commit":"${SHA}","body":"b","comments":[]}`],
      ['resolveThreads', `{"repo":"${REPO}","number":1040,"threads":[{"path":"a","line":1,"body":"b","reply":"r"}]}`],
    ] as const;
    for (const [action, body] of refusedAsPin) {
      const answer = await post(action, body);
      expect([answer.status, answer.body.error], body).toEqual([422, 'branch-refused']);
    }
    const notParsed = [
      ['comment', `{"repo":"${REPO}","number":"1040","body":"x"}`],
      ['comment', `{"repo":"${REPO}","number":" 1040","body":"x"}`],
      ['comment', `{"repo":"${REPO}","number":"+1040","body":"x"}`],
      ['comment', `{"repo":"${REPO}","number":[1040],"body":"x"}`],
      ['comment', `{"repo":"${REPO}","number":{"number":1040},"body":"x"}`],
      ['comment', `{"repo":"${REPO}","number":1040.5,"body":"x"}`],
      ['comment', `{"repo":"${REPO}","number":-1040,"body":"x"}`],
      ['comment', `{"repo":"${REPO}","number":0,"body":"x"}`],
      ['comment', `{"repo":"${REPO}","number":1e21,"body":"x"}`],
      ['comment', `{"repo":"${REPO}","number":9007199254740993,"body":"x"}`],
      ['comment', `{"repo":"${REPO}","number":null,"body":"x"}`],
      // A second field that names it, in any spelling: no action takes one.
      ['comment', `{"repo":"${REPO}","number":7,"pullRequest":{"number":1040},"body":"x"}`],
      ['comment', `{"repo":"${REPO}","number":7,"pull_number":1040,"body":"x"}`],
      ['comment', `{"repo":"${REPO}","number":7,"issue":1040,"body":"x"}`],
      ['comment', `{"repo":"${REPO}","number":7,"issue_number":1040,"body":"x"}`],
      ['comment', `{"repo":"${REPO}","number":7,"url":"https://github.com/${REPO}/pull/1040","body":"x"}`],
      ['comment', `{"repo":"${REPO}","number":7,"nodeId":"PR_kwDOpin","body":"x"}`],
      ['comment', `{"repo":"${REPO}","__proto__":{"number":1040},"body":"x"}`],
      ['comment', `{"repo":"${REPO}","number":7,"constructor":{"number":1040},"body":"x"}`],
      ['readyForReview', `{"repo":"${REPO}","pullRequest":1040}`],
      ['readyForReview', `{"repo":"${REPO}","pullRequest":[{"number":1040,"url":"u","nodeId":"n"}]}`],
      [
        'readyForReview',
        `{"repo":"${REPO}","pullRequest":{"number":7,"url":"u","nodeId":"n","pullRequest":{"number":1040}}}`,
      ],
      ['readyForReview', `{"repo":"${REPO}","number":7,"pullRequest":{"number":1040,"url":"u","nodeId":"n"}}`],
      // Another repository's name, or this one's in another case.
      ['comment', `{"repo":"The-Roganator/cv-software-factory","number":1040,"body":"x"}`],
      ['comment', `{"repo":"${REPO}/","number":1040,"body":"x"}`],
      ['comment', `{"repo":["${REPO}"],"number":1040,"body":"x"}`],
      ['comment', `[{"repo":"${REPO}","number":1040,"body":"x"}]`],
      // No action the door serves writes a pin branch's commit, or an issue's body.
      [
        'commitPins',
        `{"repo":"${REPO}","branch":"factory/pin/zap","base":"${SHA}","scanned":"${SHA}","message":"m","pins":[]}`,
      ],
      ['updateIssue', `{"repo":"${REPO}","number":1040,"title":"t"}`],
    ] as const;
    for (const [action, body] of notParsed) {
      const answer = await post(action, body);
      expect([400, 404], body).toContain(answer.status);
    }
    expect(reached).toEqual([]);
  });

  it('reads the pull request in the repository the action names, and lets the line’s own and an issue through', async () => {
    const { post, reached, asked } = await door();
    expect((await post('comment', `{"repo":"${REPO}","number":7,"body":"x"}`)).status).toBe(200);
    expect((await post('comment', `{"repo":"${REPO}","number":55,"body":"x"}`)).status).toBe(200);
    expect((await post('comment', `{"repo":"${APP}","number":7,"body":"x"}`)).status).toBe(200);
    expect(asked).toEqual([
      [REPO, 7],
      [REPO, 55],
      [APP, 7],
    ]);
    expect(reached).toEqual(['comment', 'comment', 'comment']);
  });

  it('reaches no action, and signs nothing, when its own read of the pull request fails in any way but not found', async () => {
    const failures = [
      new GitHubError('refused', 'GET answered 403', 403),
      new GitHubError('rate-limited', 'GET answered 403: secondary rate limit', 403),
      new GitHubError('rate-limited', 'GET answered 429', 429),
      new GitHubError('refused', 'GET answered 401', 401),
      new GitHubError('refused', 'GET answered 451', 451),
      new GitHubError('server', 'GET answered 500', 500),
      new GitHubError('server', 'GET answered 502', 502),
      new GitHubError('network', 'GET timed out'),
      new GitHubError('conflict', 'GET answered 422', 422),
      new GitHubError('malformed', 'GET answered with something else'),
      new GitHubError('read-again', 'again'),
      new Error('anything else'),
      new BranchRefused('a read that throws the guard’s own error'),
    ];
    for (const failure of failures) {
      const reads = {
        pullRequest: async () => {
          throw failure;
        },
      } as unknown as Reads;
      const { post, reached, kept } = await door({ reads });
      const answer = await post('enqueuePullRequest', `{"repo":"${REPO}","number":1040,"expectedHead":"${SHA}"}`);
      expect(reached, (failure as Error).message).toEqual([]);
      expect(answer.status, (failure as Error).message).toBeGreaterThanOrEqual(400);
      // The one a read can sign is the guard's own error, thrown by the read: a refusal of the action, which did not run.
      if (!(failure instanceof BranchRefused)) {
        expect(answer.body.refusal, (failure as Error).message).toBeUndefined();
        expect(kept(), (failure as Error).message).toBe(0);
      }
      close?.();
    }
  });

  it('refuses the pin pull request the same when the request asks for a dry run', async () => {
    const dry = reaching();
    const { post, reached } = await door({
      dryRun: dry.actions,
      dryRunReads: doorReads({ [PIN]: 'factory/pin/zap' }),
    });
    const answer = await post('comment', `{"repo":"${REPO}","number":1040,"body":"x"}`, {
      'x-factory-dry-run': 'true',
    });
    expect(answer.status).toBe(422);
    expect([...reached, ...dry.reached]).toEqual([]);
  });

  it('refuses every write to a pin branch by its name, a pull request from one, and the label, before GitHub is asked', async () => {
    const sent: Sent[] = [];
    // A GitHub with no route: any request the actions sent would fail the test with "No fake answer".
    const { github } = client([], sent);
    const guard = new IssueGuard({ openedBy: async () => ({ by: APP_USER, pullRequest: true }) });
    const { post } = await door({ actions: new LiveActions(github, { guard }) });
    const asks = [
      ['setBranch', `{"repo":"${REPO}","branch":"factory/pin/zap","sha":"${SHA}","force":true}`],
      ['setBranch', `{"repo":"${REPO}","branch":"factory/pin-next/zap","sha":"${SHA}"}`],
      ['setBranch', `{"repo":"${REPO}","branch":"factory/pin/zap/deeper","sha":"${SHA}"}`],
      ['deleteBranch', `{"repo":"${REPO}","branch":"factory/pin/zap"}`],
      [
        'commit',
        `{"repo":"${REPO}","branch":"factory/pin/zap","expectedHead":"${SHA}","message":"m","changes":{"additions":[],"deletions":[]}}`,
      ],
      [
        'applyPatch',
        `{"repo":"${REPO}","branch":"factory/pin/zap","expectedHead":"${SHA}","patch":"diff","message":"m"}`,
      ],
      [
        'applyPatch',
        `{"repo":"${REPO}","branch":"factory/pin-next/zap","expectedHead":"${SHA}","patch":"","pins":"diff","message":"m"}`,
      ],
      ['openPullRequest', `{"repo":"${REPO}","head":"factory/pin/zap","base":"main","title":"t","body":""}`],
      ['openPullRequest', `{"repo":"${REPO}","head":"refs/heads/factory/pin/zap","base":"main","title":"t","body":""}`],
      ['openPullRequest', `{"repo":"${REPO}","head":"factory/pin-next/zap","base":"main","title":"t","body":""}`],
      [
        'openPullRequest',
        `{"repo":"${REPO}","head":"factory/7-cart","base":"main","title":"t","body":"","labels":["pin"]}`,
      ],
      [
        'openPullRequest',
        `{"repo":"${REPO}","head":"factory/7-cart","base":"main","title":"t","body":"","labels":["PIN"]}`,
      ],
      [
        'openPullRequest',
        `{"repo":"${REPO}","head":"factory/7-cart","base":"main","title":"t","body":"","labels":["\\tpIn\\n"]}`,
      ],
      ['addLabels', `{"repo":"${REPO}","number":7,"labels":["ok","Pin "]}`],
      ['openIssue', `{"repo":"${REPO}","title":"t","body":"","labels":["\\u00a0pin\\u3000"]}`],
    ] as const;
    for (const [action, body] of asks) {
      const answer = await post(action, body);
      expect([answer.status, answer.body.error], body).toEqual([422, 'branch-refused']);
    }
    // A head GitHub's own grammar cannot hold is not a branch at the door.
    for (const head of [
      'the-roganator:factory/pin/zap',
      'factory/pin/zap ',
      'factory//pin/zap',
      'factory/pin/../pin/zap',
    ]) {
      const answer = await post(
        'openPullRequest',
        JSON.stringify({ repo: REPO, head, base: 'main', title: 't', body: '' }),
      );
      expect(answer.status, head).toBe(400);
    }
    expect(sent.filter((s) => s.path.startsWith('/repos/'))).toEqual([]);
  });

  it('readies the pull request the number names, whatever node id a worker sends beside it', async () => {
    const sent: Sent[] = [];
    const { github } = client(
      [
        { method: 'GET', path: `/repos/${REPO}/pulls/7`, answer: () => ({ body: { node_id: 'PR_7' } }) },
        { method: 'POST', path: '/graphql', answer: () => ({ body: { data: {} } }) },
      ],
      sent,
    );
    const guard = new IssueGuard({ openedBy: async () => ({ by: APP_USER, pullRequest: true }) });
    const { post } = await door({ actions: new LiveActions(github, { guard }) });
    const body = `{"repo":"${REPO}","pullRequest":{"number":7,"url":"u","nodeId":"PR_the_pin_watchs"}}`;
    expect((await post('readyForReview', body)).status).toBe(200);
    const mutation = sent.find((s) => s.path === '/graphql')?.body as { variables: { id: string } };
    expect(mutation.variables.id).toBe('PR_7');
  });
});

describe('red-team 3, refused: the queue’s own conditions', () => {
  const HEAD = 'c'.repeat(40);
  const pull = (over: Partial<QueuePull> = {}): QueuePull => ({
    number: PIN,
    title: 'chore(pin): move zap to 2.17.0',
    draft: false,
    user: { id: APP_USER },
    labels: [{ name: 'pin' }],
    head: { ref: 'factory/pin/zap', sha: HEAD, repo: { full_name: REPO } },
    base: { ref: 'main' },
    ...over,
  });
  const event = (name: string, by: number | null, label = 'pin') => ({
    event: name,
    actor: by === null ? null : { id: by },
    label: { name: label },
  });
  const run = (name: string, app: string, conclusion: string | null = 'success', id = 1): CheckRun => ({
    id,
    name,
    status: conclusion === null ? 'in_progress' : 'completed',
    conclusion,
    app,
    startedAt: null,
    completedAt: null,
    title: null,
  });

  it('takes only the App’s own, from a pin branch of this repository, into main, ready, labelled pin', () => {
    expect(pinPullWait(REPO, pull())).toBeUndefined();
    const not: Partial<QueuePull>[] = [
      { user: { id: MARTIN } },
      { user: { id: 49_699_333 } },
      { user: null },
      { head: { ref: 'factory/pin/zap', sha: HEAD, repo: { full_name: 'someone/cv-software-factory' } } },
      { head: { ref: 'factory/pin/zap', sha: HEAD, repo: null } },
      { head: { ref: 'factory/pin-next/zap', sha: HEAD, repo: { full_name: REPO } } },
      { head: { ref: 'factory/pin/zap/more', sha: HEAD, repo: { full_name: REPO } } },
      { head: { ref: 'factory/pin/Zap', sha: HEAD, repo: { full_name: REPO } } },
      { head: { ref: 'factory/pin/', sha: HEAD, repo: { full_name: REPO } } },
      { head: { ref: 'factory/pin/a..b', sha: HEAD, repo: { full_name: REPO } } },
      { head: { ref: 'factory/pin/zap.lock', sha: HEAD, repo: { full_name: REPO } } },
      { head: { ref: 'factory/7-cart', sha: HEAD, repo: { full_name: REPO } } },
      { head: { ref: 'deploy/local', sha: HEAD, repo: { full_name: REPO } } },
      { base: { ref: 'factory/7-cart' } },
      { base: { ref: 'Main' } },
      { draft: true },
      { labels: [] },
      { labels: [{ name: 'Pin' }] },
      { labels: [{ name: 'pin ' }] },
      { labels: [{ name: 'deploy: local' }] },
    ];
    for (const over of not) expect(pinPullWait(REPO, pull(over))?.waits, JSON.stringify(over)).toBe('not-a-pin');
    expect(() => pinPullWait(APP, pull())).not.toThrow();
    expect(pinPullWait(APP, pull())?.waits).toBe('not-a-pin');
  });

  it('takes the label only when the App alone ever gave it or took it off, and the App never reopened it', () => {
    const ok: LabelEvents = [event('labeled', APP_USER)];
    expect(labelWait(ok, true)).toBeUndefined();
    const not: [LabelEvents, boolean][] = [
      [[], true],
      [ok, false],
      [[event('labeled', MARTIN)], true],
      [[event('labeled', null)], true],
      [[event('labeled', APP_USER), event('labeled', MARTIN)], true],
      [[event('labeled', MARTIN), event('unlabeled', MARTIN), event('labeled', APP_USER)], true],
      [[event('labeled', APP_USER), event('unlabeled', MARTIN), event('labeled', APP_USER)], true],
      [[event('labeled', APP_USER), event('unlabeled', null)], true],
      [[event('labeled', APP_USER, 'Pin')], true],
      [[event('labeled', APP_USER, 'bug')], true],
      [[event('labeled', APP_USER), { event: 'reopened', actor: { id: APP_USER } }], true],
    ];
    for (const [events, whole] of not)
      expect(labelWait(events, whole)?.waits, JSON.stringify(events)).toBe('not-a-pin');
  });

  it('takes the verdict only at this head, as pin-move, not pending; and no check the factory’s App ran', () => {
    const judged = { number: PIN, head: HEAD, rule: 'pin-move' as const, tags: [] };
    expect(verdictWait({ head: HEAD, judged, problem: null }, HEAD, 'pin-move')).toBeUndefined();
    const older = 'd'.repeat(40);
    const not = [
      { head: HEAD, judged: null, problem: 'none' },
      { head: older, judged: { ...judged, head: older }, problem: null },
      { head: HEAD, judged: { ...judged, head: older }, problem: null },
      { head: older, judged, problem: null },
      { head: HEAD, judged: { ...judged, rule: 'exact-pin' as const }, problem: null },
      { head: HEAD, judged: { ...judged, rule: 'martin-approved-head' as const }, problem: null },
      { head: HEAD, judged: { ...judged, rule: 'martin-opened' as const }, problem: null },
      { head: HEAD, judged: { ...judged, rule: 'held' as const }, problem: null },
      { head: HEAD, judged: { ...judged, pending: 'a read' }, problem: null },
    ];
    for (const verdict of not) expect(verdictWait(verdict as never, HEAD, 'pin-move')?.waits).toBe('verdict');

    const required = ['platform', 'lint, types, tests', 'review'];
    const actions = [run('platform', 'github-actions'), run('lint, types, tests', 'github-actions')];
    expect(checksWait(actions, required)).toBeUndefined();
    // The App's own runs, as a worker could post through the door: counted for nothing, passing or failing.
    const app = 'mrogan-software-factory';
    expect(checksWait([run('platform', app), run('lint, types, tests', app)], required)?.waits).toBe('checks');
    expect(checksWait([actions[0] as CheckRun, run('lint, types, tests', app)], required)?.waits).toBe('checks');
    expect(checksWait([...actions, run('platform', app, 'failure', 9)], required)).toBeUndefined();
    expect(
      checksWait(
        [run('platform', 'github-actions', 'failure'), run('platform', app, 'success', 9), actions[1] as CheckRun],
        required,
      )?.waits,
    ).toBe('failed');
    for (const conclusion of ['failure', 'cancelled', 'timed_out', 'action_required', 'stale', 'startup_failure'])
      expect(checksWait([run('platform', 'github-actions', conclusion), actions[1] as CheckRun], required)?.waits).toBe(
        'failed',
      );
    expect(checksWait([run('platform', 'github-actions', null), actions[1] as CheckRun], required)?.waits).toBe(
      'checks',
    );
    expect(checksWait(actions, [])?.waits).toBe('checks');
  });

  /** The pin watch's pull request for `zap`, as it names and titles it. */
  const ZAP = { title: 'chore(pin): move zap to 2.17.0', head: { ref: 'factory/pin/zap', sha: '', repo: null } };

  it('reads PIN_WATCH_ONLY as none unset or blank, * alone as every move, and a name it does not have as no branch', () => {
    for (const none of [undefined, '', ' ', ',', ' , ,'])
      expect(toldWait(readPinScope(none), ZAP)?.waits, String(none)).toBe('not-a-pin');
    for (const every of ['*', ' * ', '*,', ',*']) expect(toldWait(readPinScope(every), ZAP), every).toBeUndefined();
    for (const both of ['*,zap', 'zap, *']) expect(() => readPinScope(both)).toThrow(/stands alone/);
    expect(toldWait(readPinScope(' zap , other '), ZAP)).toBeUndefined();
    for (const other of ['zap2', 'za', 'other', 'factory/pin/zap', 'pin/zap', '**', '***', '-', '.', '?'])
      expect(toldWait(readPinScope(other), ZAP)?.waits, other).toBe('not-a-pin');
    // A name removed since: the worker starts again with the new setting, and its pull request is no longer told.
    expect(toldWait(readPinScope('other'), ZAP)?.waits).toBe('not-a-pin');
  });

  it('folds no name to a branch outside factory/pin/, to pin-next, or to anything guardPinBranch refuses but the empty one', () => {
    const alphabet = [
      ...'abzAZ09',
      ...'./-_ *,:@+~\\\t\n\r\0',
      '..',
      '//',
      '.lock',
      'é',
      'ı',
      'İ',
      'ſ',
      'K',
      '​',
      '‮',
      '😀',
      '%2f',
      'refs/heads/',
      'factory/pin-next/',
      '../',
    ];
    let seed = 20261112;
    const next = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed;
    };
    const branches = new Set<string>();
    for (let i = 0; i < 200_000; i++) {
      const name = Array.from({ length: next() % 100 }, () => alphabet[next() % alphabet.length]).join('');
      const branch = pinBranchFor(name);
      branches.add(branch);
      expect(branch.startsWith('factory/pin/'), JSON.stringify(name)).toBe(true);
      expect(pinBranch(branch)).toBe(true);
      const segment = branch.slice('factory/pin/'.length);
      expect(/^[a-z0-9.-]*$/.test(segment), JSON.stringify(name)).toBe(true);
      if (segment !== '') expect(() => guardPinBranch(branch), JSON.stringify(name)).not.toThrow();
      // A name that folds to nothing names no branch a pull request can be on.
      else expect(() => guardPinBranch(branch)).toThrow(BranchRefused);
    }
  });
});
