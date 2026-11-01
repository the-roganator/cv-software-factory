/**
 * Proves `ci:public-hostile` (policy/guardrails.ts, spec 6 guardrail 10), with workflows.test.ts and
 * review-gate.test.ts: the GitHub worker's guard acts only on the issues and pull requests the factory's App opened,
 * and lets through only the outside reply on anyone else's. Martin's (CODEOWNERS), as every file here is: a change to
 * what they assert is a change to the proof.
 */
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PAYLOADS } from '@software-factory/events/schemas';
import { DiskArtifacts } from '@software-factory/store';
import { listenLocal } from '@software-factory/testing';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { MARTIN as REVIEW_GATE_MARTIN } from '../../../../scripts/review-gate.ts';
import { DRY_RUN_NUMBERS_FROM, DryRunActions, LiveActions } from '../../src/github/actions.ts';
import { IssueGuard, IssueRefused, MARTIN, OUTSIDE_REPLY, openedBy } from '../../src/github/issues.ts';
import { RefusalRecorder } from '../../src/github/refusals.ts';
import { createWorkerServer } from '../../src/github/server.ts';
import { GitHubWorker } from '../../src/github/worker-client.ts';
import { closeIssue } from '../../src/line/issues.ts';
import { calls, quiet, REPO } from '../github/fake.ts';
import { AT, github, records, writes } from '../github/issues-harness.ts';

describe('the issue guard', () => {
  it('knows Martin as the review gate does', () => {
    expect(MARTIN).toBe(REVIEW_GATE_MARTIN);
  });

  it('acts on the issues and pull requests the App opened', async () => {
    const { github: gh, sent } = github();
    const actions = new LiveActions(gh);
    await actions.closeIssue(REPO, 16, 'completed', 'Verified in production.');
    await actions.reopenIssue(REPO, 16, 'It came back.'); // open, so it says nothing and changes nothing
    await actions.comment(REPO, 16, 'Released behind its flag.');
    await actions.comment(REPO, 17, 'A word on its own pull request.');
    await actions.addLabels(REPO, 17, ['deploy: local']);
    expect(writes(sent).map((s) => `${s.method} ${s.path}`)).toEqual([
      `POST /repos/${REPO}/issues/16/comments`,
      `PATCH /repos/${REPO}/issues/16`,
      `POST /repos/${REPO}/issues/16/comments`,
      `POST /repos/${REPO}/issues/17/comments`,
      `POST /repos/${REPO}/issues/17/labels`,
    ]);
  });

  it('refuses every issue action on one the App did not open, before GitHub is asked to change anything', async () => {
    const { github: gh, sent } = github();
    const actions = new LiveActions(gh);
    const attempts: [string, () => Promise<unknown>][] = [
      ["close Martin's issue", () => actions.closeIssue(REPO, 120, 'not_planned', 'Not planned.')],
      ["close Martin's issue without a word", () => actions.closeIssue(REPO, 120, 'completed')],
      ["reopen Martin's issue", () => actions.reopenIssue(REPO, 120, 'It came back.')],
      ["comment on Martin's issue", () => actions.comment(REPO, 120, 'Hello.')],
      ["comment on Martin's pull request", () => actions.comment(REPO, 121, 'Hello.')],
      ["label Martin's pull request", () => actions.addLabels(REPO, 121, ['factory'])],
      ["close an outsider's issue", () => actions.closeIssue(REPO, 130, 'completed')],
      ["comment on an outsider's issue in other words", () => actions.comment(REPO, 130, 'Thanks!')],
      ["label an outsider's issue", () => actions.addLabels(REPO, 130, ['bug'])],
      ["reply to an outsider's pull request", () => actions.comment(REPO, 131, OUTSIDE_REPLY)],
      ["reply to Martin's issue", () => actions.comment(REPO, 120, OUTSIDE_REPLY)],
      ["close a deleted account's issue", () => actions.closeIssue(REPO, 140, 'completed')],
    ];
    for (const [what, attempt] of attempts) {
      await expect(attempt(), what).rejects.toBeInstanceOf(IssueRefused);
    }
    expect(writes(sent)).toEqual([]);
  });

  it('lets the outside reply alone through, word for word, on an issue opened by anyone but Martin or the App', async () => {
    const { github: gh, comments } = github();
    const actions = new LiveActions(gh);
    await actions.comment(REPO, 130, OUTSIDE_REPLY);
    await actions.comment(REPO, 140, OUTSIDE_REPLY);
    await actions.comment(REPO, 130, OUTSIDE_REPLY); // said already: said once
    expect(comments.get(130)).toEqual([{ body: OUTSIDE_REPLY }]);
    expect(comments.get(140)).toEqual([{ body: OUTSIDE_REPLY }]);
  });

  it('keeps each refusal as a valid action.refused by its guard in the artifact store, and logs its hash', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'refusals-'));
    const logged: Record<string, unknown>[] = [];
    const log = pino({ level: 'warn' }, { write: (line: string) => void logged.push(JSON.parse(line)) });
    const { github: gh } = github();
    const guard = new IssueGuard({
      openedBy: openedBy(gh),
      recorder: new RefusalRecorder({ artifacts: new DiskArtifacts(dir), log, now: AT }),
    });
    const refused = await new LiveActions(gh, { guard })
      .closeIssue(REPO, 120, 'not_planned')
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(IssueRefused);
    const [record] = await records(dir);
    expect(record).toEqual({
      type: 'action.refused',
      repo: REPO,
      number: 120,
      at: '2026-10-29T12:00:00.000Z',
      payload: {
        mechanism: 'github-guard',
        action: `Close issue #120 in ${REPO}`,
        output: `${REPO}#120 was opened by user ${MARTIN}, not the factory's App: the factory acts only on the issues and pull requests it opened (guardrail 10).`,
        guardrails: [10],
      },
    });
    expect(PAYLOADS['action.refused'].safeParse(record.payload).success).toBe(true);
    const kept = (refused as IssueRefused).refusal;
    expect(kept?.record).toMatch(/^[0-9a-f]{64}$/);
    expect(await readdir(dir)).toEqual([kept?.record]);
    expect(logged.find((l) => l.msg === 'refused: recorded as action.refused')).toMatchObject({
      mechanism: 'github-guard',
      cause: 'issue',
      number: 120,
      record: kept?.record,
    });
  });
});

describe('the guard on pull requests', () => {
  it('updates a pull request the App opened, and refuses, and records, one anyone else opened', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'refusals-'));
    const { github: gh, sent } = github();
    const guard = new IssueGuard({
      openedBy: openedBy(gh),
      recorder: new RefusalRecorder({ artifacts: new DiskArtifacts(dir), log: quiet, now: AT }),
    });
    const actions = new LiveActions(gh, { guard });
    await actions.updatePullRequest(REPO, 17, { title: 'fix(search): escape the quote', body: 'Described.' });
    await expect(actions.updatePullRequest(REPO, 121, { body: 'Rewritten.' })).rejects.toBeInstanceOf(IssueRefused);
    await expect(actions.updatePullRequest(REPO, 131, { title: 'x' })).rejects.toBeInstanceOf(IssueRefused);
    expect(writes(sent).map((s) => `${s.method} ${s.path}`)).toEqual([`PATCH /repos/${REPO}/pulls/17`]);
    expect((await records(dir)).map((r) => r.payload.action).sort()).toEqual([
      `Update pull request #121 in ${REPO}`,
      `Update pull request #131 in ${REPO}`,
    ]);
  });

  it('refuses every other action on a pull request it did not open, and asks GitHub who opened it once', async () => {
    const { github: gh, sent } = github();
    const actions = new LiveActions(gh);
    const ref = { number: 121, url: '', nodeId: 'PR_121' };
    const SHA40 = 'a'.repeat(40);
    const thread = { path: 'src/a.ts', line: 1, body: 'b', reply: 'r' };
    const attempts: [string, () => Promise<unknown>][] = [
      ['review', () => actions.review(REPO, 121, { commit: SHA40, body: 'b', comments: [] })],
      ['resolve threads', () => actions.resolveThreads(REPO, 121, [thread])],
      ['ready', () => actions.readyForReview(REPO, ref)],
      ['back to draft', () => actions.convertToDraft(REPO, ref)],
      ['close', () => actions.closePullRequest(REPO, 121, 'Closing.')],
      ['describe a deploy', () => actions.describeDeploy(REPO, 121, { commit: SHA40, carries: [] })],
    ];
    for (const [what, attempt] of attempts) {
      await expect(attempt(), what).rejects.toBeInstanceOf(IssueRefused);
    }
    // Who opened it never changes: asked once, and nothing else sent.
    expect(calls(sent).map((s) => `${s.method} ${s.path}`)).toEqual([`GET /repos/${REPO}/issues/121`]);
  });

  it('asks who opened an issue once, even for actions asked at once', async () => {
    const { github: gh, sent } = github();
    const actions = new LiveActions(gh);
    await Promise.all([actions.comment(REPO, 16, 'One.'), actions.comment(REPO, 16, 'Two.')]);
    expect(calls(sent).filter((s) => s.path === `/repos/${REPO}/issues/16`)).toHaveLength(1);
  });

  it('updates in a dry run the pull requests it opened without asking GitHub, and refuses one Martin opened', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dry-run-'));
    const { github: gh, sent } = github();
    const artifacts = new DiskArtifacts(dir);
    const guard = new IssueGuard({
      openedBy: openedBy(gh),
      recorder: new RefusalRecorder({ artifacts, log: quiet, now: AT }),
    });
    const actions = new DryRunActions(artifacts, quiet, AT, undefined, guard);
    const pr = await actions.openPullRequest(REPO, { head: 'factory/1001-cart', base: 'main', title: 't', body: 'b' });
    await actions.updatePullRequest(REPO, pr.number, { body: 'Described.' });
    expect(calls(sent)).toEqual([]);
    await expect(actions.updatePullRequest(REPO, 121, { body: 'Rewritten.' })).rejects.toBeInstanceOf(IssueRefused);
    await expect(actions.review(REPO, 121, { commit: 'a'.repeat(40), body: 'b', comments: [] })).rejects.toBeInstanceOf(
      IssueRefused,
    );
    await expect(actions.closePullRequest(REPO, 121, 'Closing.')).rejects.toBeInstanceOf(IssueRefused);
    await actions.readyForReview(REPO, pr);
    const kept = await records(dir);
    expect(kept.filter((r) => r.action === 'updatePullRequest').map((r) => r.args.number)).toEqual([pr.number]);
    expect(kept.filter((r) => r.action === 'readyForReview').map((r) => r.args.number)).toEqual([pr.number]);
    expect(kept.filter((r) => r.type === 'action.refused')).toHaveLength(3);
  });
});

describe('the issue guard in a dry run', () => {
  async function dryRun() {
    const dir = await mkdtemp(join(tmpdir(), 'dry-run-'));
    const { github: gh, sent } = github();
    const artifacts = new DiskArtifacts(dir);
    const guard = new IssueGuard({
      openedBy: openedBy(gh),
      recorder: new RefusalRecorder({ artifacts, log: quiet, now: AT }),
    });
    const actions = new DryRunActions(artifacts, quiet, AT, undefined, guard);
    return { dir, sent, actions, guard, artifacts };
  }

  it('closes the issues it opened without asking GitHub, even once the worker has started again', async () => {
    const { dir, sent, actions, guard, artifacts } = await dryRun();
    const issue = await actions.openIssue(REPO, { title: 'A broken link', body: '…' });
    expect(issue).toBeGreaterThan(DRY_RUN_NUMBERS_FROM);
    await actions.closeIssue(REPO, issue, 'completed', 'Verified in production.');
    // Started again, it remembers nothing, and a dry run's number is still its own.
    const again = new DryRunActions(artifacts, quiet, AT, undefined, guard);
    await again.reopenIssue(REPO, issue, 'It came back.');
    await again.comment(REPO, issue, 'Released behind its flag.');
    expect(calls(sent)).toEqual([]);
    expect((await records(dir)).map((r) => r.action).sort()).toEqual([
      'closeIssue',
      'comment',
      'openIssue',
      'reopenIssue',
    ]);
  });

  it('passes a real issue the App opened, and refuses, and records the refusal of, one it did not', async () => {
    const { dir, actions } = await dryRun();
    await actions.closeIssue(REPO, 16, 'completed');
    await expect(actions.closeIssue(REPO, 120, 'completed')).rejects.toBeInstanceOf(IssueRefused);
    await expect(actions.comment(REPO, 120, 'Hello.')).rejects.toBeInstanceOf(IssueRefused);
    await actions.comment(REPO, 130, OUTSIDE_REPLY);
    const kept = await records(dir);
    expect(kept.filter((r) => r.action).map((r) => [r.action, r.args.number])).toEqual(
      expect.arrayContaining([
        ['closeIssue', 16],
        ['comment', 130],
      ]),
    );
    expect(kept.filter((r) => r.action)).toHaveLength(2);
    expect(
      kept
        .filter((r) => r.type === 'action.refused')
        .map((r) => r.payload.action)
        .sort(),
    ).toEqual([`Close issue #120 in ${REPO}`, `Comment on issue #120 in ${REPO}`]);
  });

  it('refuses again a comment it refused, rather than taking it as said', async () => {
    const { actions } = await dryRun();
    await expect(actions.comment(REPO, 120, 'Hello.')).rejects.toBeInstanceOf(IssueRefused);
    await expect(actions.comment(REPO, 120, 'Hello.')).rejects.toBeInstanceOf(IssueRefused);
  });
});

describe('the issue guard over HTTP, as the line asks', () => {
  let close: (() => void) | undefined;
  afterEach(() => close?.());

  it("answers a refusal 403, naming its record, and the line's close of an issue leaves it and goes on", async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dry-run-'));
    const { github: gh } = github();
    const artifacts = new DiskArtifacts(dir);
    const made = new DryRunActions(
      artifacts,
      quiet,
      AT,
      undefined,
      new IssueGuard({ openedBy: openedBy(gh), recorder: new RefusalRecorder({ artifacts, log: quiet, now: AT }) }),
    );
    const server = createWorkerServer({
      actions: made,
      dryRun: made,
      repositories: [REPO],
      health: () => ({}),
      log: quiet,
    });
    const { url } = await listenLocal(server);
    close = () => server.close();

    const answer = await fetch(`${url}/v1/actions/closeIssue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: REPO, number: 120, reason: 'not_planned' }),
    });
    expect(answer.status).toBe(403);
    const body = (await answer.json()) as { error: string; message: string; refusal: { record: string } };
    expect(body).toMatchObject({ error: 'issue-refused', message: expect.stringContaining('guardrail 10') });
    expect(JSON.parse(await readFile(join(dir, body.refusal.record), 'utf-8'))).toMatchObject({
      type: 'action.refused',
      number: 120,
    });

    // The line in dry-run: the issue its dry run opened closes; one the App did not open is left, and logged.
    const worker = new GitHubWorker(url, { dryRun: true });
    const warned: unknown[] = [];
    const log = { warn: (...args: unknown[]) => void warned.push(args) };
    const issue = await worker.act('openIssue', REPO, { title: 'A broken link', body: '…' }, { workItem: '1001' });
    await closeIssue(worker, REPO, { number: issue, reason: 'completed', comment: 'Verified.' }, '1001', log);
    await closeIssue(worker, REPO, { number: 120, reason: 'completed', comment: 'Verified.' }, '1002', log);
    // Told apart from an issue that is gone.
    expect(warned).toEqual([
      [expect.objectContaining({ issue: 120 }), 'the GitHub worker refused to close an issue the App did not open'],
    ]);
    const kept = await records(dir);
    expect(kept.filter((r) => r.action === 'closeIssue').map((r) => r.args.number)).toEqual([issue]);
    // Refused twice, at the same moment, in the same words: the store keeps one record of it, by its hash.
    expect(kept.filter((r) => r.type === 'action.refused')).toHaveLength(1);
  });
});
