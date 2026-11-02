/**
 * Needs you (`projection/needs.ts`): a card per open hold, oldest first, each answer it takes beside what it does from
 * the line's own `ANSWERS`, Approve keyed on a guardrail's hold; Martin's answers today, his words kept from visitors on
 * a hold about a visitor's report; and the samples' own holds. And the console's copy of the guardrails' holds, held to
 * the access table.
 */
import { answersTo, HOLD_CAUSES, type HoldCause, type PayloadOf } from '@software-factory/events';
import { describe, expect, it } from 'vitest';
import { GUARDRAIL_HOLDS as TABLE } from '../../../../policy/access.ts';
import { GUARDRAIL_HOLDS } from '../../web/src/access.ts';
import { project, projectSheet } from '../../web/src/projection/index.ts';
import { foldItems } from '../../web/src/projection/items.ts';
import { needsView } from '../../web/src/projection/needs.ts';
import { END, payloads, SAMPLES, work } from './support.ts';

const START = Date.parse('2026-10-03T09:00:00Z');
const hold = (cause: HoldCause, extra: Partial<PayloadOf<'hold.started'>> = {}): PayloadOf<'hold.started'> => ({
  stage: 'build',
  kind: 'held',
  cause,
  reason: `Held: ${cause}`,
  ...extra,
});

describe('Needs you', () => {
  it('keeps the console’s list of the guardrails’ holds to the access table', () => {
    expect([...GUARDRAIL_HOLDS]).toEqual([...TABLE]);
  });

  it('draws a card per open hold, oldest first, each with the hold’s id and the answers it takes', () => {
    const gates = work('2001', START)
      .open()
      .add(30, 'hold.started', 'factory', hold('gates', { stage: 'gates' }));
    const question = work('2002', START)
      .open()
      .add(10, 'hold.started', 'planner', hold('question', { stage: 'plan', kind: 'question', question: 'Which?' }));
    const answered = work('2003', START)
      .open()
      .add(5, 'hold.started', 'factory', hold('failures'))
      .add(6, 'hold.answered', 'martin', { decision: 'approved' });
    const events = [...gates.events, ...question.events, ...answered.events];
    const t = START + 90 * 60_000;
    const { holds } = needsView(foldItems(events), t);
    expect(holds.map((need) => need.workItem)).toEqual(['2002', '2001']);
    const [planner, gate] = holds;
    expect(planner).toMatchObject({
      hold: question.events[1]?.id,
      kicker: 'The planner asks',
      stage: 'plan',
      waited: '1h',
      evidence: { kind: 'question', question: 'Which?' },
    });
    expect(planner?.answers.map((a) => [a.answer, a.stepUp])).toEqual([
      ['approved', false],
      ['answered', false],
      ['rejected', false],
    ]);
    expect(gate).toMatchObject({ kicker: 'Held by a gate', waited: '1h' });
    // Whole units only: an hour and a half is still "1h", a day and two hours "1d".
    expect(needsView(foldItems(events), t + 30 * 60_000).holds[1]?.waited).toBe('1h');
    expect(needsView(foldItems(events), START + 26 * 3_600_000).holds[0]?.waited).toBe('1d');
    // Approving a guardrail's hold asks for the passkey; its other answers never do.
    expect(gate?.answers.map((a) => [a.answer, a.stepUp])).toEqual([
      ['approved', true],
      ['answered', false],
      ['rejected', false],
    ]);
    expect(gate?.answers[0]?.does).toBe('Sends it back to the coder for one more round, past the gates’ limit.');
    expect(gate?.answers[1]?.does).toBe('Sends it back to the coder, with your words as the reason.');
  });

  it('offers only the answers that do something, and says what each does for every cause', () => {
    // A canary's hold is the release's card, drawn from its events (below), not one of the holds'.
    for (const cause of HOLD_CAUSES.filter((c) => c !== 'canary')) {
      const item = work('2010', START).open().add(1, 'hold.started', 'factory', hold(cause));
      const [need] = needsView(foldItems(item.events), START + 3_600_000).holds;
      expect(
        need?.answers.map((a) => a.answer),
        cause,
      ).toEqual(answersTo(cause));
      for (const row of need?.answers ?? []) expect(row.does, `${cause}: ${row.answer}`).toMatch(/\.$/);
      expect(need?.kicker, cause).toBeTruthy();
    }
    const deploy = work('2011', START)
      .open()
      .add(1, 'hold.started', 'factory', hold('deploy', { stage: 'release', kind: 'approval' }));
    expect(needsView(foldItems(deploy.events), END).holds[0]?.answers).toEqual([
      expect.objectContaining({ answer: 'rejected', stepUp: false }),
    ]);
  });

  it('keeps a hold of triage’s waiting after words, and says so in Answered today', () => {
    const t = Date.parse('2026-10-03T15:00:00Z');
    const finding = work('2020', Date.parse('2026-10-03T10:00:00Z'))
      .open('planner-finding')
      .add(
        1,
        'hold.started',
        'triage',
        hold('finding', {
          stage: 'triage',
          defect: { fingerprint: { route: '/about', class: 'broken-link' }, symptom: 'broken-link' },
        }),
      )
      .add(60, 'hold.answered', 'martin', { decision: 'answered', answer: 'Leave it for a sense' });
    const { holds, answered } = needsView(foldItems(finding.events), t);
    expect(holds.map((need) => need.workItem)).toEqual(['2020']);
    expect(holds[0]?.answers[1]?.does).toBe('Kept with the hold. It stays held until you approve or reject it.');
    expect(answered).toEqual([
      {
        at: finding.at(60),
        workItem: '2020',
        how: 'Answered in words, still held',
        words: 'Leave it for a sense',
        did: undefined,
      },
    ]);
  });

  it('lists today’s answers newest first, with what each did, and keeps a visitor from his words on a report', () => {
    const day = Date.parse('2026-10-03T12:00:00');
    const report = work('2030', day)
      .open('visitor-report')
      .add(0, 'signal.received', 'widget', { ...payloads.signal, sense: 'report', report: { page: '/search' } })
      .add(1, 'hold.started', 'triage', hold('suggestion', { stage: 'triage', kind: 'approval' }))
      .add(30, 'hold.answered', 'martin', { decision: 'answered', report: true });
    const gates = work('2031', day)
      .open()
      .add(1, 'hold.started', 'factory', hold('gates', { stage: 'gates' }))
      .add(40, 'hold.answered', 'martin', { decision: 'answered', answer: 'Keep the test' });
    // Yesterday's answer is not today's.
    const before = work('2032', day - 86_400_000)
      .open()
      .add(1, 'hold.started', 'factory', hold('failures'))
      .add(2, 'hold.answered', 'martin', { decision: 'approved' });
    const { holds, answered } = needsView(
      foldItems([...before.events, ...report.events, ...gates.events]),
      day + 3_600_000,
    );
    expect(holds.map((need) => [need.workItem, need.kicker])).toEqual([['2030', 'A visitor suggests']]);
    expect(answered).toEqual([
      {
        at: gates.at(40),
        workItem: '2031',
        how: 'Answered in words',
        words: 'Keep the test',
        did: 'Sent back to the coder.',
      },
      { at: report.at(30), workItem: '2030', how: 'Answered in words, still held', words: 'kept', did: undefined },
    ]);
  });

  it('shows a gate’s output from the pull request in hand, and none for a deploy a release in flight already ends', () => {
    const failed = (pullRequest: number, output: string) =>
      ({
        pullRequest,
        commit: 'a'.repeat(40),
        check: 'Unit tests',
        conclusion: 'failure',
        required: true,
        durationMs: 1000,
        output,
      }) satisfies PayloadOf<'gate.finished'>;
    const pushed = (number: number) =>
      ({
        number,
        branch: `factory/2040-${number}`,
        commit: 'a'.repeat(40),
        files: [],
        whole: [],
      }) as unknown as PayloadOf<'pull-request.pushed'>;
    const gates = work('2040', START)
      .open()
      .add(1, 'pull-request.pushed', 'coder', pushed(7))
      .add(2, 'gate.finished', 'actions', failed(7, 'the first pull request failed'))
      .add(3, 'pull-request.pushed', 'coder', pushed(8))
      .add(4, 'hold.started', 'factory', hold('gates', { stage: 'gates' }));
    const [need] = needsView(foldItems(gates.events), START + 3_600_000).holds;
    expect(need?.evidence).toEqual({ kind: 'words', text: 'Held: gates' });

    const release = {
      release: 'r-1',
      version: 'v0.9.5',
      previous: 'v0.9.4',
      watched: true,
      steps: null,
      dryRun: true,
    } as PayloadOf<'release.started'>;
    const deploy = work('2041', START)
      .open()
      .add(1, 'pull-request.merged', 'factory', { number: 9, commit: 'b'.repeat(40), by: 'martin' })
      .add(2, 'release.started', 'rollouts', release)
      .add(3, 'hold.started', 'factory', hold('deploy', { stage: 'release', kind: 'approval' }));
    expect(needsView(foldItems(deploy.events), START + 3_600_000).holds).toEqual([]);
  });

  it('shows the files a coder needs and why, not an old refusal of the fence, on a scope hold the coder asked for', () => {
    const needs = [
      { path: 'test/flags-preview.test.ts', reason: 'It assumes / asks no flag; every page now does.' },
      { path: 'test/home.test.ts', reason: 'It expects the old heading.' },
    ];
    const reason =
      'The coder needs 2 files outside the spec’s scope to meet its criteria: test/flags-preview.test.ts, test/home.test.ts';
    const item = work('2010', START)
      .open()
      .add(5, 'action.refused', 'factory', {
        mechanism: 'scope-fence',
        guardrails: [11],
        action: 'Push the coder’s round 1 to a new pull request',
        output: 'scope: src/pages/\nrefused src/server.ts +1 −1',
      })
      .add(30, 'hold.started', 'coder', hold('scope', { reason, needs }));
    const [need] = needsView(foldItems(item.events), START + 60 * 60_000).holds;
    expect(need).toMatchObject({
      kicker: 'Held to its scope',
      stage: 'build',
      evidence: {
        kind: 'needs',
        heading: reason,
        needs: [
          {
            path: 'test/flags-preview.test.ts',
            reason: 'It assumes / asks no flag; every page now does.',
            barred: false,
          },
          { path: 'test/home.test.ts', reason: 'It expects the old heading.', barred: false },
        ],
      },
    });
    expect(need?.answers.find((a) => a.answer === 'approved')).toMatchObject({
      does: 'The planner writes the spec again, told the coder needed those files.',
      stepUp: true,
    });
    // Every file Martin's approval sends the planner is on the card, never cut.
    const many = Array.from({ length: 20 }, (_, i) => ({
      path: `test/${i}.test.ts`,
      reason: 'It expects the old page.',
    }));
    const long = work('2012', START)
      .open()
      .add(30, 'hold.started', 'coder', hold('scope', { reason, needs: many }));
    const shown = needsView(foldItems(long.events), START + 60 * 60_000).holds[0]?.evidence;
    expect(shown?.kind === 'needs' && shown.needs).toHaveLength(20);
    // A file no scope may name is said first in the reason that heads them, so he can reject rather than approve, and
    // marked among the files, since a reason cut to fit may not reach it.
    const never =
      'The coder needs a file outside the spec’s scope to meet its criteria, and no scope may name deploy/app.yaml: deploy/app.yaml';
    const barred = work('2013', START)
      .open()
      .add(
        30,
        'hold.started',
        'coder',
        hold('scope', {
          reason: never,
          needs: [
            { path: 'deploy/app.yaml', reason: 'x', barred: true },
            { path: 'test/home.test.ts', reason: 'y' },
          ],
        }),
      );
    const [barredNeed] = needsView(foldItems(barred.events), START + 60 * 60_000).holds;
    // Approve says the planner takes in only what a scope may name.
    expect(barredNeed?.answers.find((a) => a.answer === 'approved')?.does).toBe(
      'The planner writes the spec again, told to take in the files a scope may name, or reject it.',
    );
    expect(needsView(foldItems(barred.events), START + 60 * 60_000).holds[0]?.evidence).toEqual({
      kind: 'needs',
      heading: never,
      needs: [
        { path: 'deploy/app.yaml', reason: 'x', barred: true },
        { path: 'test/home.test.ts', reason: 'y', barred: false },
      ],
    });
    // The fence's own hold still shows what it printed.
    const fenced = work('2011', START)
      .open()
      .add(5, 'action.refused', 'factory', {
        mechanism: 'scope-fence',
        guardrails: [11],
        action: 'Push the coder’s round 1 to a new pull request',
        output: 'scope: src/pages/\nrefused src/server.ts +1 −1',
      })
      .add(30, 'hold.started', 'factory', hold('scope'));
    expect(needsView(foldItems(fenced.events), START + 60 * 60_000).holds[0]).toMatchObject({
      kicker: 'Held to its scope',
      evidence: { kind: 'output', heading: 'scope fence' },
    });
  });

  it('says what a deploy waits for in each state, links its pull request, and says it waits for Martin once its checks pass', () => {
    const merged = work('2042', START)
      .open()
      .add(1, 'pull-request.merged', 'martin', { number: 9, commit: 'b'.repeat(40), by: 'martin' })
      .add(1, 'hold.started', 'factory', hold('deploy', { stage: 'release', kind: 'approval' }));
    const at = (t: number) => {
      const items = foldItems(merged.events.filter((e) => Date.parse(e.ts) <= merged.at(t)));
      const [need] = needsView(items, merged.at(t)).holds;
      return { need, outcome: items[0]?.outcome };
    };
    const head = (n: number) => String(n).repeat(40);
    const steps: [PayloadOf<'deploy.changed'>, string, string][] = [
      [
        { pullRequest: 41, commit: head(1), state: 'checking' },
        'Its deploy’s checks are running',
        'Deploy #41 carries it, and its checks are running; once they pass, merging it is yours, on GitHub.',
      ],
      [
        { pullRequest: 41, commit: head(1), state: 'failed', failed: ['Integration tests', 'Secret scan'] },
        'Its deploy’s checks failed',
        'Deploy #41 carries it, and Integration tests and Secret scan failed on it. A newer build moves it on, and its checks run again.',
      ],
      [
        { pullRequest: 41, commit: head(2), state: 'passed' },
        'Waiting for your deploy',
        'Deploy #41 carries it, and its checks passed: merging it is yours, on GitHub, and a release that carries it ends this wait by itself.',
      ],
      [
        { pullRequest: 41, commit: head(2), state: 'closed' },
        'Its deploy was closed',
        'Deploy #41 was closed unmerged; the next build’s deploy pull request carries it.',
      ],
      [
        { pullRequest: 42, commit: head(3), state: 'merged' },
        'Its deploy merged',
        'Deploy #42, which carries it, merged; its release starts once Argo CD syncs, and ends this wait by itself.',
      ],
    ];
    // None yet: its image is being built and signed, and there is nothing to link.
    expect(at(2).need).toMatchObject({ kicker: 'Its deploy is being built', link: undefined });
    expect(String((at(2).need?.evidence as { text?: string } | undefined)?.text)).toMatch(
      /^Merged at \d\d:\d\d\. The App opens the deploy pull request that carries it once its image is built and signed; merging that will be yours, on GitHub\.$/,
    );
    expect(at(2).outcome).toBe('deploying');
    steps.forEach(([change, kicker, text], i) => {
      merged.add(10 + i, 'deploy.changed', 'factory', change);
      const { need, outcome } = at(10 + i);
      expect(need?.kicker).toBe(kicker);
      expect(
        String((need?.evidence as { text?: string } | undefined)?.text).replace(/^Merged at \d\d:\d\d\. /, ''),
      ).toBe(text);
      expect(need?.link).toEqual({
        href: `https://github.com/the-roganator/cv-worlds-worst-website/pull/${change.pullRequest}`,
        label: `Deploy #${change.pullRequest} on GitHub`,
      });
      // Only once its checks pass is it Martin's: then its card says Needs you, flashing, and Needs you counts it.
      expect(outcome).toBe(change.state === 'passed' ? 'needs-you' : 'deploying');
      expect(need?.forMartin).toBe(change.state === 'passed');
    });
  });

  it('says when his words stay his, on a work item a visitor’s report opened', () => {
    const report = work('2050', START)
      .open('visitor-report')
      .add(0, 'signal.received', 'widget', { ...payloads.signal, sense: 'report', report: { page: '/search' } })
      .add(1, 'hold.started', 'factory', hold('question', { stage: 'plan', kind: 'question', question: 'Which?' }));
    const plain = work('2051', START).open().add(1, 'hold.started', 'factory', hold('failures'));
    const holds = needsView(foldItems([...report.events, ...plain.events]), START + 3_600_000).holds;
    expect(holds.map((need) => [need.workItem, need.aboutReport])).toEqual([
      ['2050', true],
      ['2051', false],
    ]);
  });

  it('shows the samples’ holds, the visitor’s suggestion among them, and its words answered today', () => {
    const { needs } = project(SAMPLES, END);
    expect(needs.holds.map((need) => [need.workItem, need.cause])).toEqual([
      ['1274', 'gates'],
      ['1300', 'question'],
      ['1334', 'spec'],
      ['1311', 'merge'],
      ['1315', 'scope'],
      ['1317', 'tests-first'],
      ['1319', 'spend'],
      ['1329', 'suggestion'],
      ['1323', 'review'],
      ['1321', 'deploy'],
    ]);
    const merge = needs.holds.find((need) => need.cause === 'merge');
    expect(merge?.answers.map((a) => a.answer)).toEqual(['answered', 'rejected']);
    expect(merge?.link?.href).toMatch(/\/pull\/\d+$/);
    expect(needs.holds.find((need) => need.cause === 'spend')?.link?.href).toBe('?view=settings');
    expect(needs.answered).toEqual([
      expect.objectContaining({ workItem: '1329', how: 'Answered in words, still held', words: 'kept' }),
    ]);
  });

  it('heads a held work item’s sheet with its card in Needs you, and an improvement’s with its flag’s', () => {
    const { needs, flags } = project(SAMPLES, END);
    // Every hold's card, the same on its sheet as in Needs you, tickets and improvements alike.
    for (const need of needs.holds) {
      expect(projectSheet(project(SAMPLES, END), need.workItem)?.needs).toEqual({ hold: need, flag: undefined });
    }
    // A flag waiting for Martin to widen it, beside the flag's own row.
    const [flag] = flags.needs;
    const sheet = projectSheet(project(SAMPLES, END), flag?.workItem ?? '');
    expect(sheet?.needs).toEqual({ hold: undefined, flag });
    expect(sheet?.flag?.row).toEqual(flags.flags.find((row) => row.name === flag?.flag));
    // Nothing waits on a work item closed, or held for nobody.
    expect(projectSheet(project(SAMPLES, END), '1271')?.needs).toEqual({ hold: undefined, flag: undefined });
  });

  it('leaves the sheet’s card once its hold is answered, as Needs you does', () => {
    const item = work('2060', START)
      .open()
      .add(10, 'hold.started', 'planner', hold('question', { stage: 'plan', kind: 'question', question: 'Which?' }))
      .add(20, 'hold.answered', 'martin', { decision: 'approved' });
    expect(projectSheet(project(item.events, START + 15 * 60_000), '2060')?.needs.hold?.kicker).toBe(
      'The planner asks',
    );
    expect(projectSheet(project(item.events, START + 25 * 60_000), '2060')?.needs.hold).toBeUndefined();
  });
});
