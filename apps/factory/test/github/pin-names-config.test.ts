/**
 * The check runs at a pin head, the repository's spelling, and the deploy watch's names at the door, each asked again.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { configFromEnv } from '../../src/github/config.ts';
import { readPinScope } from '../../src/github/pins.ts';
import { worker } from './pin-worker-harness.ts';
import { day, FakeRepo, FILES, factoryMoves, pinBranchOf } from './pins-harness.ts';

const closing: (() => void)[] = [];
afterEach(() => {
  for (const close of closing.splice(0)) close();
});

describe('the repository’s spelling', () => {
  const env = (repos: string) => configFromEnv({ GITHUB_REPOSITORIES: repos } as NodeJS.ProcessEnv);
  it('refused at start: another case in owner, in name, among duplicates, with space round it', () => {
    for (const repos of [
      'The-Roganator/cv-software-factory',
      'the-roganator/CV-Software-Factory',
      'the-roganator/cv-software-factory,THE-ROGANATOR/cv-software-factory',
      ' the-roganator/cv-software-factory , the-roganator/Cv-Worlds-Worst-Website ',
    ]) {
      expect(() => env(repos), repos).toThrow(/write it/);
    }
    expect(env(' the-roganator/cv-software-factory ').repositories).toEqual(['the-roganator/cv-software-factory']);
  });

  // No weakness: GitHub's API answers 404 for the name with `.git` (asked read-only on 2026-11-12), so it is no alias.
  it('control: a name with `.git` after it is taken as another repository, which GitHub does not have', () => {
    const { repositories } = env('the-roganator/cv-software-factory.git');
    expect(repositories).toEqual(['the-roganator/cv-software-factory.git']);
  });
});

describe('the door, asked again', () => {
  it('the deploy watch’s names, labels and pull requests are refused; a pin head takes no check run', async () => {
    const repo = new FakeRepo(FILES);
    const scanned = repo.main;
    const w = await worker(repo, readPinScope('example-dashboards'), () => day(scanned, factoryMoves()), closing);
    await w.watchOnly();
    const sha = 'e'.repeat(40);
    for (const branch of [
      'deploy/local',
      'refs/heads/deploy/local',
      'deploy',
      'deploy/local/x',
      'factory/deploy/local',
      'factory/deploy',
      'factory/deploy/local/x',
    ]) {
      for (const [action, body] of [
        ['setBranch', { branch, sha, force: true }],
        ['deleteBranch', { branch }],
        ['commit', { branch, expectedHead: sha, message: 'x', changes: { additions: [], deletions: [] } }],
        ['openPullRequest', { head: branch, base: 'main', title: 'x', body: '' }],
      ] as const) {
        const answer = await w.ask(action, body);
        expect([400, 422], `${action} ${branch}`).toContain(answer.status);
      }
    }
    // Other cases and near names are no branch of the factory's, or another branch altogether.
    for (const branch of ['Deploy/local', 'deploy/Local', 'deploy/local.', 'deploy/aws']) {
      expect((await w.ask('setBranch', { branch, sha, force: true })).status, branch).toBe(422);
    }
    for (const label of ['deploy: local', 'Deploy: Local', ' deploy: local ', 'deploy: local', 'deploy: lo​cal']) {
      const answer = await w.ask('openIssue', { title: 'x', body: '', labels: [label] });
      expect(answer.status, JSON.stringify(label)).toBe(422);
    }
    const deploy = repo.addPull({
      head: 'deploy/local',
      title: 'chore(deploy): run console 1f14f44 on the local cluster',
    });
    for (const [action, body] of [
      ['updatePullRequest', { number: deploy.number, title: 'x' }],
      ['closePullRequest', { number: deploy.number, comment: 'x' }],
      ['reopenIssue', { number: deploy.number, comment: 'x' }],
      ['addLabels', { number: deploy.number, labels: ['x'] }],
      ['comment', { number: deploy.number, body: 'x' }],
      ['convertToDraft', { pullRequest: { number: deploy.number, url: 'x', nodeId: 'x' } }],
      ['enqueuePullRequest', { number: deploy.number, expectedHead: sha }],
    ] as const) {
      expect((await w.ask(action, body)).status, action).toBe(422);
    }
    // An enqueue of any number is refused here.
    expect((await w.ask('enqueuePullRequest', { number: 7, expectedHead: sha })).status).toBe(422);

    // Check runs: at the pin head, and at the pin-next head, refused under any name; a required name anywhere.
    const head = repo.refs.get(pinBranchOf('example-dashboards')) as string;
    const run = { status: 'completed', conclusion: 'success', title: 't', summary: 's' };
    expect((await w.ask('createCheckRun', { name: 'anything', headSha: head, ...run })).status).toBe(422);
    expect((await w.ask('updateCheckRun', { id: 5, headSha: head, ...run })).status).toBe(422);
    repo.refs.set('factory/pin-next/example-dashboards', 'd'.repeat(40));
    expect((await w.ask('createCheckRun', { name: 'anything', headSha: 'd'.repeat(40), ...run })).status).toBe(422);
    expect((await w.ask('createCheckRun', { name: ' Platform ', headSha: sha, ...run })).status).toBe(422);
    // Elsewhere, a run of another name is served, as before.
    expect((await w.ask('createCheckRun', { name: 'anything', headSha: sha, ...run })).status).toBe(200);
  });
});
