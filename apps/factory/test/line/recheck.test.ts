/**
 * The line looking again at held and waiting work items: after a release that did not carry their fix, and at the end
 * of a wait for a spec that overlaps one in flight.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type NewEvent, type PayloadOf, VERSIONS } from '@software-factory/events';
import { DiskArtifacts, EventWriter, nextWorkItem } from '@software-factory/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Database, freshDatabase } from '../../../../packages/store/test/database.ts';
import { GitHubWorkerError } from '../../src/github/worker-client.ts';
import { Line, type LineOptions } from '../../src/line/worker.ts';
import type { VerifyAnswer } from '../../src/probes/verify.ts';
import { quiet } from '../github/fake.ts';
import { CANARY, commitOf, STABLE } from '../release/fixtures.ts';
import { FakeGitHub, FakeProbes, FakeSteps, MAIN } from './fakes.ts';

let database: Database;
let events: EventWriter;
let now = Date.parse('2026-10-17T13:00:00Z');
beforeEach(async () => {
  database = await freshDatabase('recheck');
  events = new EventWriter(database.as.line, {
    kind: 'real',
    artifacts: new DiskArtifacts(mkdtempSync(join(tmpdir(), 'artifacts-'))),
  });
  now = Date.parse('2026-10-17T13:00:00Z');
});
afterEach(() => database?.end());

const event = <K extends NewEvent['type']>(
  workItem: string | null,
  type: K,
  payload: PayloadOf<K>,
  actor: NewEvent['actor'] = 'factory',
) =>
  ({
    id: crypto.randomUUID(),
    ts: new Date(now).toISOString(),
    work_item: workItem,
    type,
    version: VERSIONS[type],
    actor,
    summary: `${type} for the test`,
    payload,
    artifacts: [],
  }) as NewEvent;

const NEW = commitOf(CANARY);
const OLD = commitOf(STABLE);
const SCOPE = ['src/departments.ts', 'test/departments.test.ts'];

/** An open ticket a probe saw on the version before, with `symptom` if given, that the line has not taken. */
async function ticketed(route: string, symptom?: PayloadOf<'signal.received'>['symptom']): Promise<string> {
  const workItem = await nextWorkItem(database.as.triage);
  await events.append([
    event(
      workItem,
      'work-item.opened',
      { kind: 'defect-fix', title: `No alt text on ${route}`, sample: false },
      'triage',
    ),
    event(
      workItem,
      'ticket.opened',
      {
        title: `No alt text on ${route}`,
        category: 'accessibility',
        severity: 'degraded',
        fingerprint: { route, class: 'missing-alt' },
        traces: [],
      },
      'triage',
    ),
    event(
      workItem,
      'signal.received',
      { sense: 'probe', check: route, route, version: OLD, ...(symptom ? { symptom } : {}) },
      'probe',
    ),
  ]);
  return workItem;
}

/** A ticket a probe saw on the version before, with its spec, on the line at `stage`, with issue `issue`. */
async function planned(
  stage: string,
  issue: number,
  scope = SCOPE,
  route = '/departments/:department',
  symptom?: PayloadOf<'signal.received'>['symptom'],
): Promise<string> {
  const workItem = await nextWorkItem(database.as.triage);
  await events.append([
    event(workItem, 'work-item.opened', { kind: 'defect-fix', title: 'A redirect loop', sample: false }, 'triage'),
    event(
      workItem,
      'ticket.opened',
      {
        title: `A redirect loop on ${route}`,
        category: 'errors',
        severity: 'broken',
        fingerprint: { route, class: 'redirect-loop' },
        traces: [],
      },
      'triage',
    ),
    event(
      workItem,
      'signal.received',
      {
        sense: 'probe',
        check: route === '/departments/:department' ? 'departments' : route,
        route,
        version: OLD,
        ...(symptom ? { symptom } : {}),
      },
      'probe',
    ),
    event(
      workItem,
      'spec.written',
      {
        outcome: 'Each department page loads.',
        criteria: [{ given: 'a department', when: 'it is opened', expect: 'it loads', from: 'the ticket' }],
        scope,
        risks: [],
        rollout: 'Ships as it is.',
      },
      'planner',
    ),
  ]);
  await database.owner`insert into line (work_item, stage, issue) values (${workItem}, ${stage}, ${issue})`;
  return workItem;
}

/** A planned work item whose pull request #`number` is open, held for `cause`. */
async function held(cause: PayloadOf<'hold.started'>['cause'], github: FakeGitHub, number = 12): Promise<string> {
  const workItem = await planned('held', number - 1);
  const stage = cause === 'merge' ? 'review' : 'gates';
  await events.append([
    event(
      workItem,
      'pull-request.pushed',
      {
        number,
        title: 'fix(departments): stop the redirect loop',
        branch: `factory/${workItem}-a-redirect-loop`,
        attempt: 1,
        testsFirst: true,
        files: [{ path: 'src/departments.ts', added: 1, removed: 1 }],
        whole: [{ path: 'src/departments.ts', added: 1, removed: 1 }],
      },
      'coder',
    ),
    event(workItem, 'hold.started', {
      stage,
      kind: cause === 'merge' ? 'approval' : 'held',
      cause,
      reason: 'Held for the test',
    }),
  ]);
  github.pulls.set(number, {
    number,
    state: 'open',
    merged: false,
    mergeCommit: null,
    mergedBy: null,
    head: { ref: `factory/${workItem}-a-redirect-loop`, sha: 'f'.repeat(40) },
    base: { ref: 'main', sha: MAIN },
    draft: false,
    nodeId: `PR_${number}`,
  });
  return workItem;
}

/** A release of `version` promoted, carrying `carrying` or on the line itself. */
async function promoted(carrying: string | null, release = 'f00dfeed01', version = NEW, dryRun = false) {
  const payload = { release, version, previous: OLD, commit: version, watched: !dryRun, dryRun };
  const image = { digest: `sha256:${'d'.repeat(64)}`, signed: true, admitted: true };
  await events.append([
    event(carrying, 'release.started', { ...payload, steps: null, ...(dryRun ? {} : { image }) }, 'rollouts'),
    event(carrying, 'release.promoted', payload, 'rollouts'),
  ]);
}

const CLEARED: VerifyAnswer = { outcome: 'cleared', version: NEW, runs: ['passed', 'passed'] };

function line(probes: FakeProbes, options: Partial<LineOptions> = {}) {
  const github = new FakeGitHub();
  const it = new Line({
    sql: database.as.line,
    events,
    steps: new FakeSteps(database.as.gateway, {}),
    github,
    log: quiet,
    me: 'test',
    now: () => new Date(now),
    release: null,
    verify: { probes },
    ...options,
  });
  return { line: it, github };
}

const pass = async (it: Line) => {
  await it.tick();
  await it.idle();
};

const payloads = async <K extends NewEvent['type']>(workItem: string, type: K) =>
  (
    await database.as.line<{ payload: PayloadOf<K> }[]>`
      select payload from events where work_item = ${workItem} and type = ${type} order by seq`
  ).map((r) => r.payload);

const stage = async (workItem: string) =>
  (await database.as.line<{ stage: string }[]>`select stage from line where work_item = ${workItem}`)[0]?.stage;

describe('a held work item looked at again after a release', () => {
  it('closes a hold of the line’s own as verified when the signal cleared, with its issue and pull request', async () => {
    const probes = new FakeProbes(CLEARED);
    const { line: it, github } = line(probes);
    const workItem = await held('gates', github);
    // Another work item's fix, which the line no longer has in hand.
    const other = await nextWorkItem(database.as.triage);
    await events.append([
      event(other, 'work-item.opened', { kind: 'defect-fix', title: 'Another', sample: false }, 'triage'),
    ]);
    await promoted(other);
    await pass(it); // the probe looks again
    expect(await payloads(workItem, 'signal.rechecked')).toEqual([
      {
        for: 'release',
        outcome: 'cleared',
        sense: 'probe',
        check: 'departments',
        release: 'f00dfeed01',
        version: NEW,
        against: OLD,
        carried: [other],
        since: OLD,
      },
    ]);
    expect(probes.asked).toEqual([{ sense: 'probe', check: 'departments', route: '/departments/:department' }]);
    await pass(it); // and the work item closes
    expect(await payloads(workItem, 'work-item.closed')).toEqual([
      {
        outcome: 'verified',
        reason: `The probe’s check “departments” passed twice in a row on ${NEW.slice(0, 7)}, a version released since ${OLD.slice(0, 7)}, where its signal was last seen, with the fix of work item #${other}, not this one’s`,
      },
    ]);
    const acts = github.acts.filter((a) => a.action === 'closeIssue' || a.action === 'closePullRequest');
    expect(acts.map((a) => [a.action, a.args.number])).toEqual([
      ['closeIssue', 11],
      ['closePullRequest', 12],
    ]);
    expect(acts[0]?.args).toMatchObject({
      reason: 'completed',
      comment: expect.stringMatching(/^Verified in production/),
    });
    expect(acts[1]?.args.comment).toMatch(/^Closed unmerged: the defect this fixes is gone from production\./);
    expect(github.pulls.get(12)?.state).toBe('closed');
    // Its pull request, closed, says nothing more.
    now += 60_000;
    await pass(it);
    expect(await payloads(workItem, 'work-item.closed')).toHaveLength(1);
  });

  it('closes a hold of the line’s own as verified when the signal cleared, though its issue is gone', async () => {
    const probes = new FakeProbes(CLEARED);
    const { line: it, github } = line(probes);
    const workItem = await held('gates', github);
    await promoted(null);
    await pass(it); // the probe looks again
    github.refusing.set('closeIssue', new GitHubWorkerError(404, 'not-found', 'Not Found'));
    await pass(it); // and the work item closes in this pass, with no issue to close
    expect(await payloads(workItem, 'work-item.closed')).toMatchObject([{ outcome: 'verified' }]);
    expect(github.acts.filter((a) => a.action === 'closeIssue')).toEqual([]);
  });

  it('closes as verified when Martin closes its pull request on a clearance, though its issue is gone', async () => {
    const probes = new FakeProbes(CLEARED);
    const { line: it, github } = line(probes);
    const workItem = await held('merge', github);
    await promoted(null);
    await pass(it);
    await pass(it);
    const pull = github.pulls.get(12);
    if (pull) pull.state = 'closed';
    github.refusing.set('closeIssue', new GitHubWorkerError(410, 'gone', 'Gone'));
    now += 60_000;
    await pass(it);
    expect(await payloads(workItem, 'work-item.closed')).toMatchObject([{ outcome: 'verified' }]);
    expect(github.acts.filter((a) => a.action === 'closeIssue')).toEqual([]);
  });

  it('records the look on a hold for Martin’s merge, and closes it as verified when he closes its pull request', async () => {
    const probes = new FakeProbes(CLEARED);
    const { line: it, github } = line(probes);
    const workItem = await held('merge', github);
    await promoted(null);
    await pass(it);
    await pass(it);
    expect(await payloads(workItem, 'signal.rechecked')).toMatchObject([{ outcome: 'cleared', carried: [] }]);
    expect(await payloads(workItem, 'work-item.closed')).toEqual([]);
    expect(await stage(workItem)).toBe('held');
    expect(github.acts.map((a) => a.action)).toEqual([]);
    // Martin closes it in GitHub.
    const pull = github.pulls.get(12);
    if (pull) pull.state = 'closed';
    now += 60_000;
    await pass(it);
    expect(await payloads(workItem, 'work-item.closed')).toEqual([
      expect.objectContaining({ outcome: 'verified', reason: expect.stringMatching(/none of the factory’s fixes$/) }),
    ]);
    expect(github.acts.map((a) => [a.action, a.args.reason])).toEqual([['closeIssue', 'completed']]);
  });

  it('closes with no change when he closes it after a signal on that version ended the clearance', async () => {
    const probes = new FakeProbes(CLEARED);
    const { line: it, github } = line(probes);
    const workItem = await held('merge', github);
    await promoted(null);
    await pass(it);
    await events.append([
      event(
        workItem,
        'signal.received',
        { sense: 'probe', check: 'departments', route: '/departments/:department', version: NEW },
        'probe',
      ),
    ]);
    const pull = github.pulls.get(12);
    if (pull) pull.state = 'closed';
    now += 60_000;
    await pass(it);
    expect(await payloads(workItem, 'work-item.closed')).toMatchObject([{ outcome: 'no-change' }]);
  });

  it('looks at nothing for a dry run’s release, nor for a release a signal was seen on', async () => {
    const probes = new FakeProbes(CLEARED);
    const { line: it, github } = line(probes, { dryRun: true });
    const workItem = await held('gates', github);
    await promoted(null, 'dry-run-1', 'e'.repeat(40), true);
    await pass(it);
    expect(probes.asked).toEqual([]);
    await promoted(null, 'f00dfeed01');
    await events.append([
      event(
        workItem,
        'signal.received',
        { sense: 'probe', check: 'departments', route: '/departments/:department', version: NEW },
        'probe',
      ),
    ]);
    await pass(it);
    expect(probes.asked).toEqual([]);
    expect(await payloads(workItem, 'signal.rechecked')).toEqual([]);
  });

  it('looks again when a sense cannot tell, and stops after the policy’s wait, recording nothing', async () => {
    const probes = new FakeProbes({ outcome: 'unsure', version: NEW, runs: ['unsure'], message: 'timed out' });
    const { line: it, github } = line(probes, { verifyEveryMs: 60_000, verifyWaitMs: 3_600_000 });
    const workItem = await held('gates', github);
    await promoted(null);
    await pass(it);
    await pass(it);
    expect(probes.asked).toHaveLength(1);
    now += 60_000;
    await pass(it);
    expect(probes.asked).toHaveLength(2);
    now += 3_600_000;
    await pass(it);
    expect(probes.asked).toHaveLength(2);
    expect(await payloads(workItem, 'signal.rechecked')).toEqual([]);
  });

  it('looks at one work item at a time across the line', async () => {
    // The probes answer only when the test lets them, so the first look is still in hand as the line goes on.
    let answer = () => {};
    const asked: string[] = [];
    const probes = {
      verify: async (request: { route: string }): Promise<VerifyAnswer> => {
        asked.push(request.route);
        await new Promise<void>((resolve) => {
          answer = resolve;
        });
        return { outcome: 'persists', version: NEW, runs: ['failed', 'failed'] };
      },
    };
    const { line: it, github } = line(probes as unknown as FakeProbes);
    const first = await held('gates', github, 12);
    const second = await held('gates', github, 14);
    await promoted(null);
    await it.tick();
    await expect.poll(() => asked.length).toBe(1);
    await it.tick();
    expect(asked).toHaveLength(1);
    answer();
    await it.idle();
    await it.tick();
    await expect.poll(() => asked.length).toBe(2);
    answer();
    await it.idle();
    const looked = async () =>
      (await payloads(first, 'signal.rechecked')).length + (await payloads(second, 'signal.rechecked')).length;
    expect(await looked()).toBe(2);
    // A signal that persists leaves both held.
    expect([await stage(first), await stage(second)]).toEqual(['held', 'held']);
  });
});

describe('a spec that overlaps work in flight', () => {
  it('waits after Plan, and closes as verified when the work it waited on is verified and its signal is gone', async () => {
    const probes = new FakeProbes(CLEARED);
    const { line: it, github } = line(probes);
    const first = await held('merge', github);
    const second = await planned('plan', 30, ['src/departments.ts']);
    await pass(it);
    expect(await payloads(second, 'wait.started')).toEqual([
      {
        on: [first],
        files: ['src/departments.ts'],
        reason: `Waits for #${first}, whose spec also changes src/departments.ts`,
      },
    ]);
    expect(await stage(second)).toBe('waiting');
    // The first merges, is released and verified.
    await events.append([event(first, 'pull-request.merged', { number: 12, commit: 'c'.repeat(40), by: 'martin' })]);
    await promoted(first);
    await events.append([event(first, 'work-item.closed', { outcome: 'verified', reason: 'Its fix cleared it' })]);
    await pass(it); // the second looks again, as its wait ends (and the release would set off a look too)
    expect(await payloads(second, 'signal.rechecked')).toMatchObject([
      { outcome: 'cleared', version: NEW, carried: [first] },
    ]);
    await pass(it);
    expect(await payloads(second, 'work-item.closed')).toMatchObject([{ outcome: 'verified' }]);
    expect(github.acts.filter((a) => a.action === 'closeIssue').map((a) => a.args.number)).toEqual([30]);
    expect(github.acts.filter((a) => a.action === 'closePullRequest')).toEqual([]);
  });

  it('goes on to Build when its signal is still there once the work it waited on closed', async () => {
    const probes = new FakeProbes({ outcome: 'persists', version: OLD, runs: ['failed', 'failed'] });
    const { line: it, github } = line(probes);
    const first = await held('merge', github);
    const second = await planned('plan', 30, ['src/departments.ts']);
    await promoted(null, 'f00dfeed00', OLD);
    await pass(it);
    expect(await stage(second)).toBe('waiting');
    await events.append([event(first, 'work-item.closed', { outcome: 'no-change', reason: 'Martin closed it' })]);
    await pass(it);
    expect(await payloads(second, 'signal.rechecked')).toMatchObject([{ for: 'wait', outcome: 'persists' }]);
    await pass(it);
    // The coder is asked for: the fake has none, so the step fails, but the work item is at Build.
    expect(await stage(second)).toBe('build');
  });

  it('never waits on a work item that waits on it, and not at all for a line of one', async () => {
    const probes = new FakeProbes(CLEARED);
    const { line: it } = line(probes);
    // The first came back to Plan with a new spec, and the second already waits on it.
    const first = await planned('plan', 20, ['src/departments.ts']);
    const second = await planned('waiting', 30, ['src/departments.ts']);
    const reason = `Waits for #${first}, whose spec also changes src/departments.ts`;
    await events.append([event(second, 'wait.started', { on: [first], files: ['src/departments.ts'], reason })]);
    await pass(it);
    expect(await payloads(first, 'wait.started')).toEqual([]);
    expect(await stage(first)).toBe('build');

    const third = await planned('plan', 31, ['src/departments.ts']);
    await pass(line(probes, { only: third }).line);
    expect(await payloads(third, 'wait.started')).toEqual([]);
  });
});

describe('17 October again: two tickets for one defect', () => {
  /**
   * Two probe checks on two pages saw one defect, so triage opened two tickets with different fingerprints, and both
   * specs scope the same file. The second waits after Plan; the first merges, is released and verified; then the
   * second's sense looks again, at the release that carried the first's fix.
   */
  async function story(second: VerifyAnswer['outcome']) {
    const probes = {
      asked: [] as string[],
      verify: async (request: { route: string }): Promise<VerifyAnswer> => {
        probes.asked.push(request.route);
        const outcome = request.route === '/departments' ? second : 'cleared';
        return { outcome, version: NEW, runs: outcome === 'cleared' ? ['passed', 'passed'] : ['failed', 'failed'] };
      },
    };
    const { line: it, github } = line(probes as unknown as FakeProbes);
    const first = await held('merge', github);
    const waiter = await planned('plan', 30, ['src/departments.ts'], '/departments');
    await pass(it);
    expect(await stage(waiter)).toBe('waiting');
    // Martin merges the first's pull request, and a release carries it.
    github.merge(12);
    now += 60_000;
    await pass(it);
    await promoted(first);
    for (let i = 0; i < 6; i++) {
      now += 60_000;
      await pass(it);
    }
    return { first, waiter, github };
  }

  it('closes the waiting one as verified when the release that carried the first’s fix cleared its signal', async () => {
    const { first, waiter, github } = await story('cleared');
    expect(await payloads(first, 'work-item.closed')).toMatchObject([{ outcome: 'verified' }]);
    expect(await payloads(waiter, 'signal.rechecked')).toMatchObject([
      { outcome: 'cleared', release: 'f00dfeed01', version: NEW, carried: [first] },
    ]);
    expect(await payloads(waiter, 'work-item.closed')).toEqual([
      {
        outcome: 'verified',
        reason: `The probe’s check “/departments” passed twice in a row on ${NEW.slice(0, 7)}, a version released since ${OLD.slice(0, 7)}, where its signal was last seen, with the fix of work item #${first} (pull request #12), not this one’s`,
      },
    ]);
    expect(github.acts.filter((a) => a.action === 'closeIssue').map((a) => a.args.number)).toEqual([11, 30]);
    expect(await payloads(waiter, 'pull-request.pushed')).toEqual([]);
  });

  it('sends the waiting one on to Build when its signal is still there once the first is verified', async () => {
    const { first, waiter } = await story('persists');
    expect(await payloads(first, 'work-item.closed')).toMatchObject([{ outcome: 'verified' }]);
    const looks = await payloads(waiter, 'signal.rechecked');
    expect(looks.at(-1)).toMatchObject({ for: 'wait', outcome: 'persists', carried: [first] });
    expect(await payloads(waiter, 'work-item.closed')).toEqual([]);
    expect(await stage(waiter)).toBe('build');
  });
});

describe('an open ticket a release since already fixed', () => {
  /** A work item whose pull request #`number` merged, carried by a release promoted since the tickets were seen. */
  async function fixed(number = 120): Promise<string> {
    const fixer = await nextWorkItem(database.as.triage);
    await events.append([
      event(fixer, 'work-item.opened', { kind: 'defect-fix', title: 'No alt text on /', sample: false }, 'triage'),
      event(fixer, 'pull-request.merged', { number, commit: NEW, by: 'martin' }, 'martin'),
    ]);
    await database.owner`insert into line (work_item, stage) values (${fixer}, 'ended')`;
    await promoted(fixer);
    return fixer;
  }

  it('closes as verified as the line takes it, crediting the fix, with no issue opened and no planner', async () => {
    const probes = new FakeProbes(CLEARED);
    const { line: it, github } = line(probes);
    const ticket = await ticketed('/products');
    const fixer = await fixed();
    const next = await ticketed('/basket');
    await pass(it); // the line takes the ticket, and the probe looks again
    expect(await payloads(ticket, 'signal.rechecked')).toEqual([
      {
        for: 'take',
        outcome: 'cleared',
        sense: 'probe',
        check: '/products',
        release: 'f00dfeed01',
        version: NEW,
        against: OLD,
        carried: [fixer],
        since: OLD,
        merged: [{ workItem: fixer, pullRequest: 120 }],
      },
    ]);
    await pass(it); // it closes, and the line takes the next ticket at once
    expect(await payloads(ticket, 'work-item.closed')).toEqual([
      {
        outcome: 'verified',
        reason: `The probe’s check “/products” passed twice in a row on ${NEW.slice(0, 7)}, a version released since ${OLD.slice(0, 7)}, where its signal was last seen, with the fix of work item #${fixer} (pull request #120)`,
      },
    ]);
    expect(github.acts.filter((a) => a.action === 'openIssue' || a.action === 'closeIssue')).toEqual([]);
    expect(await stage(ticket)).toBe('ended');
    await pass(it);
    expect(await stage(next)).toBeDefined();
  });

  it('says the releases since carried none of the factory’s fixes only when they carried none', async () => {
    const { line: it } = line(new FakeProbes(CLEARED));
    const ticket = await ticketed('/products');
    await promoted(null);
    await pass(it);
    await pass(it);
    expect(await payloads(ticket, 'work-item.closed')).toEqual([
      {
        outcome: 'verified',
        reason: `The probe’s check “/products” passed twice in a row on ${NEW.slice(0, 7)}, a version released since ${OLD.slice(0, 7)}, where its signal was last seen, with none of the factory’s fixes`,
      },
    ]);
  });

  it('goes on to Plan when its signal is still there, and is not looked at again', async () => {
    const probes = new FakeProbes({ outcome: 'persists', version: NEW, runs: ['failed', 'failed'] });
    const { line: it, github } = line(probes);
    const ticket = await ticketed('/products');
    await fixed();
    await pass(it);
    expect(await payloads(ticket, 'signal.rechecked')).toMatchObject([{ for: 'take', outcome: 'persists' }]);
    await pass(it);
    expect(github.acts.filter((a) => a.action === 'openIssue')).toHaveLength(1);
    expect(await payloads(ticket, 'work-item.closed')).toEqual([]);
    expect(probes.asked).toHaveLength(1);
  });

  it('credits the fix though triage recorded a signal on the version before after the release', async () => {
    const { line: it } = line(new FakeProbes(CLEARED));
    const ticket = await ticketed('/products');
    const fixer = await fixed();
    // A late signal, on the version before the promotion: it says nothing of the release since.
    await events.append([
      event(
        ticket,
        'signal.received',
        { sense: 'probe', check: '/products', route: '/products', version: OLD },
        'probe',
      ),
    ]);
    await pass(it);
    expect(await payloads(ticket, 'signal.rechecked')).toMatchObject([
      { for: 'take', outcome: 'cleared', since: OLD, carried: [fixer] },
    ]);
  });

  it('goes on to Plan at once when the sense cannot tell, unsure', async () => {
    const probes = new FakeProbes({ outcome: 'unsure', version: NEW, runs: ['errored'] } as unknown as VerifyAnswer);
    const { line: it, github } = line(probes);
    const ticket = await ticketed('/products');
    await fixed();
    await pass(it);
    expect(await payloads(ticket, 'signal.rechecked')).toMatchObject([{ for: 'take', outcome: 'unsure' }]);
    await pass(it);
    expect(github.acts.filter((a) => a.action === 'openIssue')).toHaveLength(1);
  });

  it('is not looked at when its signal was seen on the stable version, or no release is known', async () => {
    const probes = new FakeProbes(CLEARED);
    const { line: it, github } = line(probes);
    const ticket = await ticketed('/products');
    await pass(it);
    expect(github.acts.filter((a) => a.action === 'openIssue')).toHaveLength(1);
    expect(probes.asked).toEqual([]);
    expect(await payloads(ticket, 'signal.rechecked')).toEqual([]);
  });

  it('closes beside a verified fix of the same sense and symptom, naming the fix, and leaves others open', async () => {
    const probes = new FakeProbes(CLEARED);
    // One work item at a time, so the line takes none of the tickets while the fix goes through.
    const { line: it, github } = line(probes, { take: 1 });
    const first = await planned('held', 11, SCOPE, '/', 'missing-alt');
    await events.append([
      event(
        first,
        'pull-request.pushed',
        {
          number: 120,
          title: 'fix(home): give the images alt text',
          branch: `factory/${first}-no-alt-text`,
          attempt: 1,
          testsFirst: true,
          files: [{ path: 'src/home.ts', added: 1, removed: 1 }],
          whole: [{ path: 'src/home.ts', added: 1, removed: 1 }],
        },
        'coder',
      ),
      event(first, 'hold.started', { stage: 'review', kind: 'approval', cause: 'merge', reason: 'Held for the test' }),
    ]);
    github.pulls.set(120, {
      number: 120,
      state: 'open',
      merged: false,
      mergeCommit: null,
      mergedBy: null,
      head: { ref: `factory/${first}-no-alt-text`, sha: 'f'.repeat(40) },
      base: { ref: 'main', sha: MAIN },
      draft: false,
      nodeId: 'PR_120',
    });
    const beside = await ticketed('/products', 'missing-alt');
    const unlike = await ticketed('/basket', 'broken-image');
    github.merge(120);
    now += 60_000;
    await pass(it);
    await promoted(first);
    for (let i = 0; i < 4; i++) {
      now += 60_000;
      await pass(it);
    }
    expect(await payloads(first, 'work-item.closed')).toMatchObject([{ outcome: 'verified' }]);
    expect(await payloads(beside, 'signal.rechecked')).toMatchObject([
      { for: 'fix', outcome: 'cleared', carried: [first], merged: [{ workItem: first, pullRequest: 120 }] },
    ]);
    expect(await payloads(beside, 'work-item.closed')).toEqual([
      {
        outcome: 'verified',
        reason: `The probe’s check “/products” passed twice in a row on ${NEW.slice(0, 7)}, a version released since ${OLD.slice(0, 7)}, where its signal was last seen, with the fix of work item #${first} (pull request #120)`,
      },
    ]);
    // No event on the fix's own work item names it: the credit is the ticket's.
    expect(await payloads(first, 'signal.rechecked')).toEqual([]);
    expect(await payloads(unlike, 'signal.rechecked')).toEqual([]);
    expect(await payloads(unlike, 'work-item.closed')).toEqual([]);
    expect(await stage(beside)).toBeUndefined();
  });
});
