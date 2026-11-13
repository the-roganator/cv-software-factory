/**
 * The names, through the door. Every way found to write a name that the URL parser,
 * or GitHub, would read as a pin branch or one of the deploy watch's, asked of each action that takes a branch. The
 * door's pattern takes letters, digits, `.`, `_`, `/` and `-` alone, so each is answered 400 before any guard; what the
 * pattern does take and is another branch to git (another case, a `;`-free look-alike) names that other branch.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { readPinScope } from '../../src/github/pins.ts';
import { worker } from './pin-worker-harness6.ts';
import { day, FakeRepo, FILES, factoryMoves, writes } from './pins-harness.ts';

const closing: (() => void)[] = [];
afterEach(() => {
  for (const close of closing.splice(0)) close();
});

const A = 'factory/pin/example-dashboards';
const tail = 'example-dashboards';

/** Each a name some layer could read as `factory/pin/example-dashboards`. */
const ALIASES: [string, string][] = [
  ['a dot segment', `factory/./pin/${tail}`],
  ['a dot-dot segment', `factory/x/../pin/${tail}`],
  ['an escaped dot segment', `factory/%2e/pin/${tail}`],
  ['an escaped dot-dot, mixed case', `factory/x/%2E%2e/pin/${tail}`],
  ['an escaped slash', `factory/pin%2F${tail}`],
  ['an escaped slash, lower case', `factory%2fpin%2f${tail}`],
  ['a doubly escaped slash', `factory/pin%252F${tail}`],
  ['an escaped letter', `factory/%70in/${tail}`],
  ['an escaped backslash', `factory%5Cpin%5C${tail}`],
  ['a backslash', `factory\\pin\\${tail}`],
  ['a tab, which the URL parser takes out', `factory/pi\tn/${tail}`],
  ['a line feed', `factory/pin\n/${tail}`],
  ['a carriage return', `factory/pin\r/${tail}`],
  ['a leading space', ` ${A}`],
  ['a trailing space', `${A} `],
  ['a trailing tab', `${A}\t`],
  ['a leading slash', `/${A}`],
  ['a doubled slash', `factory//pin/${tail}`],
  ['a trailing slash', `${A}/`],
  ['a `;` parameter', `factory/pin;x=1/${tail}`],
  ['a query', `${A}?x=1`],
  ['a fragment', `${A}#x`],
  ['a zero-width space', `factory/pin​/${tail}`],
  ['a full-width letter', `factory/ｐin/${tail}`],
  ['a combining mark', `factory/pín/${tail}`],
  ['a null', `factory/pin\u0000/${tail}`],
  ['refs/heads/ and the name', `refs/heads/${A}`],
  ['heads/ and the name', `heads/${A}`],
  ['the owner and the name', `the-roganator:${A}`],
  ['over 200 characters', `factory/${'a/'.repeat(100)}../pin/${tail}`],
];

describe('no name asked at the door is the pin watch’s branch on the wire', () => {
  it('every alias, by every action that takes a branch, and nothing is written or queued', async () => {
    const repo = new FakeRepo(FILES);
    const scanned = repo.main;
    const w = await worker(repo, readPinScope('example-dashboards'), () => day(scanned, factoryMoves()), closing);
    await w.watchOnly();
    const watchs = repo.refs.get(A) as string;
    // The deploy watch's branches, as they stand between its passes.
    repo.refs.set('deploy/local', repo.main);
    // A branch of the worker's own, with its own commit, to put under the pull request if anything lets it.
    expect((await w.ask('setBranch', { branch: 'factory/7-x', sha: repo.main })).status).toBe(200);
    const made = await w.ask('commit', {
      branch: 'factory/7-x',
      expectedHead: repo.main,
      message: 'theirs',
      changes: {
        additions: [
          { path: 'deploy/base/telemetry/dashboards.yaml', contents: Buffer.from('evil\n').toString('base64') },
        ],
        deletions: [],
      },
    });
    expect(made.status).toBe(200);
    const theirs = made.result as string;
    w.sent.length = 0;

    const answers: string[] = [];
    for (const [what, name] of ALIASES) {
      const asked = [
        await w.ask('setBranch', { branch: name, sha: theirs, force: true }),
        await w.ask('deleteBranch', { branch: name }),
        await w.ask('commit', {
          branch: name,
          expectedHead: watchs,
          message: 'm',
          changes: { additions: [], deletions: [] },
        }),
        await w.ask('applyPatch', { branch: name, expectedHead: watchs, patch: 'x', message: 'm' }),
        await w.ask('openPullRequest', { head: name, base: 'main', title: 't', body: '' }),
      ];
      answers.push(`${what} ${JSON.stringify(name).slice(0, 60)}: ${asked.map((a) => a.status).join(' ')}`);
      for (const a of asked) expect([400, 422]).toContain(a.status);
    }
    // The same for the deploy watch's branch and the branch its commit is made on.
    for (const name of [
      'deploy/./local',
      'deploy/lo\tcal',
      'deploy%2Flocal',
      'factory/deploy/./local',
      'factory/deploy/lo\ncal',
      'factory/deploy%2flocal',
      'factory/./deploy/local',
    ]) {
      for (const action of ['setBranch', 'deleteBranch'] as const) {
        const a = await w.ask(
          action,
          { branch: name, sha: theirs, force: true }.constructor === Object && action === 'setBranch'
            ? { branch: name, sha: theirs, force: true }
            : { branch: name },
        );
        expect(a.status).toBe(400);
      }
    }
    // What the pattern takes, and git reads as another branch: sent as it is asked, and no pin branch.
    for (const name of [
      'factory/PIN/example-dashboards',
      'factory/pin_/example-dashboards',
      'factory/pin-/example-dashboards',
      'factory/pin./example-dashboards',
    ]) {
      const a = await w.ask('setBranch', { branch: name, sha: theirs, force: true });
      expect(a.status).toBe(200);
      expect(repo.refs.get(name)).toBe(theirs);
    }
    // The names themselves, as ever.
    for (const name of [
      A,
      'factory/pin',
      'factory/pin-next',
      'factory/pin-next/example-dashboards',
      'factory/pin/example-dashboards/x',
      'deploy/local',
      'deploy',
      'factory/deploy',
      'factory/deploy/local',
      'factory/deploy/local/x',
    ]) {
      expect((await w.ask('setBranch', { branch: name, sha: theirs, force: true })).status).toBe(422);
      expect((await w.ask('deleteBranch', { branch: name })).status).toBe(422);
    }
    // A branch of its own at the pin branch's commit, or an enqueue, or any action on the pull request by its number.
    expect((await w.ask('setBranch', { branch: 'factory/8-y', sha: watchs })).status).toBe(422);
    const pull = repo.pulls.find((p) => p.head === A);
    if (!pull) throw new Error('no pull request');
    for (const [action, body] of [
      ['enqueuePullRequest', { number: pull.number, expectedHead: watchs }],
      ['updatePullRequest', { number: pull.number, title: 'x' }],
      ['closePullRequest', { number: pull.number, comment: 'x' }],
      ['reopenIssue', { number: pull.number, comment: 'x' }],
      ['addLabels', { number: pull.number, labels: ['x'] }],
      ['comment', { number: pull.number, body: 'x' }],
      ['convertToDraft', { pullRequest: { number: pull.number, url: 'u', nodeId: 'n' } }],
    ] as const) {
      expect((await w.ask(action, body)).status).toBe(422);
    }
    // A pull request into the pin branch is opened (the door reads a head, not a base), and is nothing to the queue.
    const into = await w.ask('openPullRequest', {
      head: 'factory/7-x',
      base: A,
      title: 'into the pin branch',
      body: '',
    });
    expect(into.status).toBe(200);

    expect(repo.refs.get(A)).toBe(watchs);
    expect(repo.refs.get('deploy/local')).toBe(repo.main);
    expect(repo.refs.has('factory/pin-next/example-dashboards')).toBe(false);
    const touched = writes(w.sent).filter(
      (s) =>
        /pin\/example-dashboards|deploy\/local/.test(decodeURIComponent(s.path)) &&
        !/PIN|pin_|pin-\/|pin\.\//.test(s.path),
    );
    expect(touched).toEqual([]);
    await w.queueOnly();
    expect(w.enqueued).toEqual([{ number: pull.number, head: watchs }]);
  });

  it('NOTE (not this change): the door sets a worker’s branch at the deploy branch’s commit, and opens a second pull request with the deploy’s head', async () => {
    const repo = new FakeRepo(FILES);
    const scanned = repo.main;
    const w = await worker(repo, readPinScope('example-dashboards'), () => day(scanned, factoryMoves()), closing);
    await w.watchOnly();
    // The deploy watch's commit, on its branch: a commit of its own, off main.
    const main = repo.main;
    const deploy = repo.push({ 'deploy/overlays/local/images.yaml': 'images: []\n' });
    repo.refs.set('main', main);
    repo.refs.set('deploy/local', deploy);
    // A pin branch's commit is refused (`guardPinHead`); the deploy branch's has no such guard.
    expect((await w.ask('setBranch', { branch: 'factory/8-pin', sha: repo.refs.get(A) })).status).toBe(422);
    const set = await w.ask('setBranch', { branch: 'factory/8-twin', sha: deploy });
    const opened = await w.ask('openPullRequest', {
      head: 'factory/8-twin',
      base: 'main',
      title: 'chore: a twin',
      body: '',
    });
    expect([set.status, opened.status]).toEqual([200, 200]);
    expect(repo.refs.get('factory/8-twin')).toBe(repo.refs.get('deploy/local'));
  });
});
