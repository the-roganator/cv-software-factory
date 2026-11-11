import { GATE_ANNOTATION_CHARS, MAX_GATE_ANNOTATIONS, type PayloadOf } from '@software-factory/events';
import { validate } from '@software-factory/events/schemas';
import { describe, expect, it } from 'vitest';
import { countsNote } from '../../src/gates/counts.ts';
import type { CheckRun, PullRequestState } from '../../src/github/reads.ts';
import { APP_SLUG, asEvent, gateEvents, gateRecord, REVIEW_GATE_CHECK } from '../../src/line/gates.ts';

const SHA = 'a'.repeat(40);
const MERGED = 'c'.repeat(40);

const pr = (change: Partial<PullRequestState> = {}): PullRequestState => ({
  number: 12,
  state: 'open',
  merged: false,
  mergeCommit: null,
  mergedBy: null,
  head: { ref: 'factory/1001-search', sha: SHA },
  base: { ref: 'main', sha: MERGED },
  draft: true,
  nodeId: 'PR_12',
  ...change,
});

const run = (id: number, name: string, conclusion: string | null, app = 'github-actions'): CheckRun => ({
  id,
  name,
  status: conclusion ? 'completed' : 'in_progress',
  conclusion,
  app,
  startedAt: '2026-10-05T10:00:00Z',
  completedAt: conclusion ? '2026-10-05T10:02:00Z' : null,
  title: conclusion === 'failure' ? 'Two tests fail' : null,
});

const nothing = gateRecord([]);

describe('the gates, as events', () => {
  it('start with the required checks, and record each as it finishes', () => {
    const drafts = gateEvents(
      pr(),
      [run(1, 'test', 'success'), run(2, 'journeys', null)],
      ['test', 'journeys', 'lint'],
      nothing,
    );
    expect(drafts.map((d) => d.type)).toEqual(['gates.started', 'gate.finished']);
    expect(drafts[0]?.payload).toEqual({ pullRequest: 12, commit: SHA, checks: ['test', 'journeys', 'lint'] });
    expect(drafts[1]?.payload).toEqual({
      pullRequest: 12,
      commit: SHA,
      check: 'test',
      conclusion: 'success',
      required: true,
      durationMs: 120_000,
    });
  });

  it('read a pull request as unmerged again once the work went back to Plan for one of its own', () => {
    const merged = { type: 'pull-request.merged', payload: { commit: SHA } };
    expect(gateRecord([merged]).merged).toBe(true);
    expect(gateRecord([merged, { type: 'work.returned', payload: { from: 'verify', to: 'plan' } }]).merged).toBe(false);
    expect(gateRecord([merged, { type: 'work.returned', payload: { from: 'review', to: 'build' } }]).merged).toBe(true);
  });

  it('finish when every required check and every other one has finished, failing on a required failure', () => {
    const record = gateRecord([
      { type: 'gates.started', payload: { commit: SHA } },
      { type: 'gate.finished', payload: { commit: SHA, check: 'test' } },
    ]);
    const runs = [run(1, 'test', 'success'), run(3, 'journeys', 'failure'), run(4, 'tests first', 'failure')];
    const drafts = gateEvents(pr(), runs, ['test', 'journeys', 'lint'], record);
    // Lint, required, has not started: not done yet.
    expect(drafts.map((d) => d.type)).toEqual(['gate.finished', 'gate.finished']);
    const done = gateEvents(pr(), [...runs, run(5, 'lint', 'success')], ['test', 'journeys', 'lint'], record);
    expect(done.at(-1)).toMatchObject({
      type: 'gates.finished',
      payload: { conclusion: 'failed', failed: ['journeys'], passed: 2 },
    });
    expect(done.find((d) => d.type === 'gate.finished' && d.payload.check === 'tests first')?.payload).toMatchObject({
      required: false,
      conclusion: 'failure',
      summary: 'Two tests fail',
    });
  });

  it('record what a failed check said was wrong, cut to fit, and nothing for one that named nothing or passed', () => {
    const said = { path: 'test/app.test.ts', message: '"files > keeps nothing of the other files" was deleted' };
    const many = Array.from({ length: 14 }, (_, i) => ({
      path: `test/${i}.test.ts`,
      message: `"case ${i}" was deleted`,
    }));
    const runs = [
      { ...run(1, 'test integrity', 'failure'), annotations: [said] },
      { ...run(2, 'types', 'failure'), annotations: [] },
      { ...run(3, 'lint', 'failure'), annotations: [{ path: 'src/a.ts', message: 'x'.repeat(400) }, ...many] },
      // GitHub keeps a passing run's notices: they say nothing of a failure.
      { ...run(4, 'test', 'success'), annotations: [said] },
    ];
    const drafts = gateEvents(pr(), runs, ['test integrity', 'types', 'lint', 'test'], nothing);
    const finished = (check: string) =>
      drafts.find((d) => d.type === 'gate.finished' && d.payload.check === check)?.payload as
        | PayloadOf<'gate.finished'>
        | undefined;
    expect(finished('test integrity')?.annotations).toEqual([said]);
    expect(finished('types')).not.toHaveProperty('annotations');
    expect(finished('test')).not.toHaveProperty('annotations');
    const lint = finished('lint')?.annotations ?? [];
    expect(lint).toHaveLength(MAX_GATE_ANNOTATIONS);
    expect(lint[0]?.message).toHaveLength(GATE_ANNOTATION_CHARS);
    expect(lint[0]?.message.endsWith('…')).toBe(true);
    expect(lint[1]).not.toHaveProperty('cut');
    // Each is a valid event, as the store will take it.
    for (const draft of drafts)
      expect(validate(asEvent('1015', draft, '2026-11-02T06:50:49.000Z'))).toEqual({ ok: true });
    // The same runs again say nothing new: what a check said is recorded with it, once.
    const record = gateRecord(drafts.map(({ type, payload }) => ({ type, payload })));
    expect(gateEvents(pr(), runs, ['test integrity', 'types', 'lint', 'test'], record)).toEqual([]);
  });

  it('record what a scan counted from its own notice on GitHub Actions’ run alone, and nothing that does not parse', () => {
    const counts = {
      before: { critical: 0, high: 2, medium: 5, low: 11, unknown: 1 },
      after: { critical: 0, high: 0, medium: 3, low: 9, unknown: 0 },
    };
    const note = countsNote('image scan', counts);
    const lockfile = countsNote('lockfile scan', counts);
    const runs: CheckRun[] = [
      // Counted whatever the scan concluded: a failed scan's counts are what it saw.
      { ...run(1, 'gates / image scan', 'failure'), notices: [note], annotations: [] },
      { ...run(2, 'gates / lockfile scan', 'success'), notices: [lockfile.replace('high 2', 'high lots')] },
      // A check that is no scan, with a scan's notice on it, counts nothing.
      { ...run(3, 'gates / tests', 'success'), notices: [note] },
      // Another app's run of a scan's name is not GitHub Actions': its notice is not taken.
      { ...run(4, 'image scan', 'success', 'some-other-app'), notices: [countsNote('image scan', counts)] },
      // Nor does another app's later run of the same name hide Actions' own counts.
      { ...run(5, 'gates / image scan', 'success', 'some-other-app') },
    ];
    const required = ['gates / image scan', 'gates / lockfile scan', 'gates / tests'];
    const drafts = gateEvents(pr(), runs, required, nothing);
    const finished = (check: string) =>
      drafts.find((d) => d.type === 'gate.finished' && d.payload.check === check)?.payload as
        | PayloadOf<'gate.finished'>
        | undefined;
    expect(finished('gates / image scan')?.findings).toEqual(counts);
    expect(finished('gates / lockfile scan')).not.toHaveProperty('findings');
    expect(finished('gates / tests')).not.toHaveProperty('findings');
    expect(finished('image scan')).not.toHaveProperty('findings');
    for (const draft of drafts)
      expect(validate(asEvent('1015', draft, '2026-11-11T04:00:00.000Z'))).toEqual({ ok: true });
  });

  it('mark a path cut to fit what an event records, as a push marks one', () => {
    const long = `test/${'deep/'.repeat(50)}app.test.ts`;
    const drafts = gateEvents(
      pr(),
      [{ ...run(1, 'test integrity', 'failure'), annotations: [{ path: long, message: 'x' }] }],
      ['test integrity'],
      nothing,
    );
    const finished = drafts.find((d) => d.type === 'gate.finished')?.payload as PayloadOf<'gate.finished'>;
    expect(finished.annotations?.[0]).toMatchObject({ cut: true, message: 'x' });
    expect(finished.annotations?.[0]?.path).toHaveLength(200);
    for (const draft of drafts)
      expect(validate(asEvent('1015', draft, '2026-11-02T06:50:49.000Z'))).toEqual({ ok: true });
  });

  it('take a check run again by its latest run, and leave out the factory’s own', () => {
    const runs = [run(1, 'test', 'failure'), run(2, 'test', 'success'), run(3, 'factory review', null, APP_SLUG)];
    const drafts = gateEvents(pr(), runs, ['test'], nothing);
    expect(drafts.at(-1)).toMatchObject({ type: 'gates.finished', payload: { conclusion: 'passed', failed: [] } });
    expect(drafts[0]?.payload).toMatchObject({ checks: ['test'] });
  });

  it('leave out the review gate’s check, required or not: it waits for Martin, who looks once the gates are done', () => {
    const runs = [run(1, 'test', 'success'), run(2, REVIEW_GATE_CHECK, 'failure', 'review-app')];
    const drafts = gateEvents(pr(), runs, ['test', REVIEW_GATE_CHECK], nothing);
    expect(drafts[0]?.payload).toMatchObject({ checks: ['test'] });
    expect(drafts.map((d) => d.type)).toEqual(['gates.started', 'gate.finished', 'gates.finished']);
    expect(drafts.at(-1)).toMatchObject({ payload: { conclusion: 'passed', failed: [], passed: 1 } });
    // Not posted yet, as before the review App is set up: nothing waits for it either.
    expect(gateEvents(pr(), [runs[0] as CheckRun], ['test', REVIEW_GATE_CHECK], nothing).at(-1)).toMatchObject({
      type: 'gates.finished',
      payload: { conclusion: 'passed' },
    });
    // A job of GitHub Actions' by that name is not the review App's, and counts as any check does.
    const job = gateEvents(pr(), [run(1, 'test', 'success'), run(2, REVIEW_GATE_CHECK, 'failure')], ['test'], nothing);
    expect(job.at(-1)).toMatchObject({ payload: { conclusion: 'passed', passed: 1 } });
    expect(job.filter((d) => d.type === 'gate.finished').map((d) => d.payload.check)).toContain(REVIEW_GATE_CHECK);
  });

  it('append nothing they have already said, and nothing before a check has started', () => {
    expect(gateEvents(pr(), [], ['test'], nothing)).toEqual([]);
    const record = gateRecord([
      { type: 'gates.started', payload: { commit: SHA } },
      { type: 'gate.finished', payload: { commit: SHA, check: 'test' } },
      { type: 'gates.finished', payload: { commit: SHA } },
    ]);
    expect(gateEvents(pr(), [run(1, 'test', 'success')], ['test'], record)).toEqual([]);
  });

  it('know a check by the name they recorded, so one named past 80 characters is recorded once', () => {
    const long = `journeys / ${'a'.repeat(90)}`;
    const first = gateEvents(pr(), [run(1, long, 'success')], [long], nothing);
    const finished = first.filter((d) => d.type === 'gate.finished');
    expect(finished.map((d) => (d.payload as { check: string }).check)).toEqual([long.slice(0, 80)]);
    const record = gateRecord(first.map(({ type, payload }) => ({ type, payload })));
    expect(gateEvents(pr(), [run(1, long, 'success')], [long], record)).toEqual([]);
  });

  it('record Martin’s merge, and close a work item whose pull request closed unmerged', () => {
    expect(
      gateEvents(pr({ state: 'closed', merged: true, mergeCommit: MERGED, mergedBy: 'mrogan' }), [], [], nothing),
    ).toEqual([
      {
        type: 'pull-request.merged',
        actor: 'martin',
        summary: 'Martin merged PR #12',
        payload: { number: 12, commit: MERGED, by: 'martin' },
      },
    ]);
    expect(gateEvents(pr({ state: 'closed' }), [], [], nothing)[0]).toMatchObject({
      type: 'work-item.closed',
      payload: { outcome: 'no-change' },
    });
    const merged = gateRecord([{ type: 'pull-request.merged', payload: {} }]);
    expect(gateEvents(pr({ state: 'closed', merged: true, mergeCommit: MERGED }), [], [], merged)).toEqual([]);
  });

  it('record, with a merge, what the gates on the merged commit did since the last read, before it', () => {
    const record = gateRecord([
      { type: 'gates.started', payload: { commit: SHA } },
      { type: 'gate.finished', payload: { commit: SHA, check: 'test' } },
    ]);
    const merged = pr({ state: 'closed', merged: true, mergeCommit: MERGED, mergedBy: 'mrogan' });
    const runs = [run(1, 'test', 'success'), run(2, 'journeys', 'success')];
    const drafts = gateEvents(merged, runs, ['test', 'journeys'], record);
    expect(drafts.map((d) => d.type)).toEqual(['gate.finished', 'gates.finished', 'pull-request.merged']);
    expect(drafts[0]?.payload).toMatchObject({ commit: SHA, check: 'journeys' });
    expect(drafts[1]?.payload).toMatchObject({ commit: SHA, conclusion: 'passed', passed: 2 });
    // Recorded, the merge ends what the pull request has to say.
    const after = gateRecord([
      ...drafts.map((d) => ({ type: d.type, payload: d.payload })),
      { type: 'gates.started', payload: { commit: SHA } },
      { type: 'gate.finished', payload: { commit: SHA, check: 'test' } },
    ]);
    expect(gateEvents(merged, runs, ['test', 'journeys'], after)).toEqual([]);
  });

  it('finish a round at a merge once its required checks have, whatever else still runs', () => {
    const merged = pr({ state: 'closed', merged: true, mergeCommit: MERGED, mergedBy: 'mrogan' });
    const runs = [run(1, 'test', 'success'), run(2, 'tests first', null)];
    expect(gateEvents(merged, runs, ['test'], nothing).map((d) => d.type)).toEqual([
      'gates.started',
      'gate.finished',
      'gates.finished',
      'pull-request.merged',
    ]);
    // Open, the same round waits for every check.
    expect(gateEvents(pr(), runs, ['test'], nothing).map((d) => d.type)).toEqual(['gates.started', 'gate.finished']);
  });

  it('finish a round at a merge on the checks that have finished, with none required or one still running', () => {
    const merged = pr({ state: 'closed', merged: true, mergeCommit: MERGED, mergedBy: 'mrogan' });
    const runs = [run(1, 'test', 'success'), run(2, 'tests first', null)];
    // No check required: the one still running is left out, as nothing reads it after the merge.
    const none = gateEvents(merged, runs, [], nothing);
    expect(none.map((d) => d.type)).toEqual([
      'gates.started',
      'gate.finished',
      'gates.finished',
      'pull-request.merged',
    ]);
    expect(none[2]?.payload).toMatchObject({ conclusion: 'passed', passed: 1, failed: [] });
    expect(none[2]?.summary).toBe('PR #12 merged before tests first finished');
    // A required check still running, as when the admin bypassed the ruleset to merge: the round ends all the same.
    const bypassed = gateEvents(merged, runs, ['test', 'tests first'], nothing);
    expect(bypassed.map((d) => d.type)).toEqual([
      'gates.started',
      'gate.finished',
      'gates.finished',
      'pull-request.merged',
    ]);
    expect(bypassed[2]?.payload).toMatchObject({ conclusion: 'passed', failed: [] });
    // Open, both wait for every check.
    expect(gateEvents(pr(), runs, [], nothing).map((d) => d.type)).toEqual(['gates.started', 'gate.finished']);
  });

  it('wait for the merge commit when GitHub says a pull request merged before it names one', () => {
    expect(gateEvents(pr({ state: 'closed', merged: true, mergeCommit: null }), [], [], nothing)).toEqual([]);
  });

  it('close a work item whose pull request closed unmerged as verified while a cleared look stands on its hold', () => {
    const cleared = {
      for: 'release' as const,
      outcome: 'cleared' as const,
      sense: 'probe' as const,
      check: 'search answers',
      release: '6d8f9c7b54-3',
      version: 'd728dbe',
      against: 'c0ffee0',
      carried: ['1033'],
    };
    expect(gateEvents(pr({ state: 'closed' }), [], [], nothing, { look: cleared, by: 'martin' })).toEqual([
      {
        type: 'work-item.closed',
        actor: 'martin',
        summary: 'PR #12 was closed unmerged, its signal cleared: verified',
        payload: {
          outcome: 'verified',
          reason:
            'The probe’s check “search answers” passed twice in a row on d728dbe, a release that carried work item #1033, not this one’s fix',
        },
      },
    ]);
    // The line's own close, caught after a crash, is the factory's.
    expect(gateEvents(pr({ state: 'closed' }), [], [], nothing, { look: cleared, by: 'factory' })[0]?.actor).toBe(
      'factory',
    );
    // A merge is a merge, whatever cleared.
    expect(
      gateEvents(pr({ state: 'closed', merged: true, mergeCommit: MERGED }), [], [], nothing, {
        look: cleared,
        by: 'martin',
      })[0],
    ).toMatchObject({ type: 'pull-request.merged' });
  });
});
