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
import { clock } from '../../web/src/format.ts';
import { project } from '../../web/src/projection/index.ts';
import { foldItems } from '../../web/src/projection/items.ts';
import { needsView } from '../../web/src/projection/needs.ts';
import { projectSheet } from '../../web/src/projection/sheet.ts';
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
      ['replanned', false],
      ['rejected', false],
    ]);
    expect(gate?.answers[0]?.does).toBe('Sends it back to the coder for one more round, past the gates’ limit.');
    expect(gate?.answers[1]?.does).toBe('Sends it back to the coder, with your words as the reason.');
    expect(gate?.answers[2]).toMatchObject({
      label: 'Back to the planner',
      does: 'The planner writes the spec again from your words, and the coder rebuilds the change on it.',
    });
  });

  it('says a hold sent back to the planner went there, with his words, in Answered today', () => {
    const t = Date.parse('2026-10-03T15:00:00Z');
    const review = work('2030', Date.parse('2026-10-03T10:00:00Z'))
      .open()
      .add(1, 'hold.started', 'factory', hold('review', { stage: 'review' }))
      .add(60, 'hold.answered', 'martin', { decision: 'replanned', answer: 'The spec contradicts a test' });
    const { holds, answered } = needsView(foldItems(review.events), t);
    expect(holds).toEqual([]);
    expect(answered).toEqual([
      expect.objectContaining({
        workItem: '2030',
        how: 'Sent back to the planner',
        words: 'The spec contradicts a test',
        did: undefined,
      }),
    ]);
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

  it('says what a deploy waits for in each state, links its pull request, and says it waits for Martin once its checks pass and the line does not queue it', () => {
    // Not a sample's: its deploy pull request is GitHub's, and the card links it.
    const merged = work('2042', START)
      .add(0, 'work-item.opened', 'factory', { kind: 'defect-fix', title: 'Item 2042', sample: false })
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
        { pullRequest: 41, commit: head(2), state: 'passed', waits: 'level' },
        'Waiting for your deploy',
        'Deploy #41 carries it, and its checks passed; at Supervised the line adds nothing to the merge queue: merging it is yours, on GitHub, and at Guarded with auto-merge on the line would add it. A release that carries it ends this wait by itself.',
      ],
      [
        { pullRequest: 41, commit: head(2), state: 'passed', waits: 'verdict', rule: 'held' },
        'Waiting for your deploy',
        'Deploy #41 carries it, and its checks passed; the review gate did not pass it as an exact pin (held), and the line adds only an exact pin to the merge queue: merging it is yours, on GitHub. A release that carries it ends this wait by itself.',
      ],
      [
        { pullRequest: 41, commit: head(2), state: 'passed', waits: 'auto-merge' },
        'Waiting for your deploy',
        'Deploy #41 carries it, and its checks passed; with auto-merge off, merging it is yours, on GitHub; switched on, the line adds it to the merge queue. A release that carries it ends this wait by itself.',
      ],
      [
        { pullRequest: 41, commit: head(2), state: 'passed', waits: 'refused', said: 'Resource not accessible' },
        'Waiting for your deploy',
        'Deploy #41 carries it, and its checks passed; the line was refused when it added it to the merge queue (Resource not accessible): merging it is yours, on GitHub. A release that carries it ends this wait by itself.',
      ],
      [
        { pullRequest: 41, commit: head(2), state: 'queued', rule: 'exact-pin', position: 1 },
        'Its deploy is in the merge queue',
        'Deploy #41 carries it, and the review gate passed it as an exact pin: the line added it to the merge queue, which merges it once its checks pass there.',
      ],
      [
        { pullRequest: 41, commit: head(2), state: 'dequeued', reason: 'failed_checks', failed: ['e2e'] },
        'Waiting for your deploy',
        'Deploy #41 carries it, and the merge queue took it out (failed_checks): e2e failed on its commit. Merging it is yours, on GitHub; a newer build moves it on, and the line tries again.',
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
      // The deploy pull request is the way on only while it is open and its checks have not failed: failed, closed or
      // merged, a newer build or Argo CD moves the fix on, and the card offers no way there.
      expect(need?.way).toEqual(
        ['checking', 'passed', 'queued', 'dequeued'].includes(change.state)
          ? {
              verb: 'Deploy',
              pullRequest: change.pullRequest,
              href: `https://github.com/the-roganator/cv-worlds-worst-website/pull/${change.pullRequest}`,
            }
          : undefined,
      );
      expect(need?.link).toBeUndefined();
      // Only once its checks pass and the line has not queued it, or the queue took it out, is it Martin's: then its
      // card says Needs you, flashing, and Needs you counts it.
      const his = change.state === 'passed' || change.state === 'dequeued';
      expect(outcome).toBe(his ? 'needs-you' : 'deploying');
      expect(need?.forMartin).toBe(his);
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

  describe('a merge the line holds for Martin, by why it does not add it to the merge queue itself', () => {
    const HEAD = '4e1c2a9'.padEnd(40, '0');
    const merge = (
      why: NonNullable<PayloadOf<'hold.started'>['merge']>['why'],
      extra: Partial<NonNullable<PayloadOf<'hold.started'>['merge']>> = {},
      reason = `Held: ${why}`,
    ) =>
      hold('merge', {
        stage: 'review',
        kind: 'approval',
        reason,
        merge: { pullRequest: 1327, head: HEAD, why, approving: false, ...extra },
      });
    const pushed = {
      number: 1327,
      branch: 'factory/2070',
      commit: HEAD,
      files: [],
      whole: [],
    } as unknown as PayloadOf<'pull-request.pushed'>;
    const needOf = (payload: PayloadOf<'hold.started'>, opened = work('2070', START).open()) => {
      const item = opened.add(1, 'pull-request.pushed', 'coder', pushed).add(30, 'hold.started', 'factory', payload);
      return needsView(foldItems(item.events), START + 60 * 60_000).holds[0];
    };

    it('draws the review gate’s hold for its risk tags: its words, a cross for each tag, and Review on GitHub', () => {
      const need = needOf(
        merge('held', {
          rule: 'held',
          said: 'Guarded: the factory’s App opened #1327, so it passes only if low-risk',
          tags: [
            { tag: 'dependency-change', because: ['pnpm-lock.yaml', 'pnpm-workspace.yaml'] },
            { tag: 'test-loosening', because: ['test/search.test.ts'], more: 2 },
          ],
          approving: true,
        }),
      );
      expect(need).toMatchObject({
        kicker: 'Held for its risk tags',
        stage: 'review',
        evidence: {
          kind: 'gate',
          said: 'Guarded: the factory’s App opened #1327, so it passes only if low-risk',
          tags: [
            { tag: 'dependency-change', because: 'pnpm-lock.yaml, pnpm-workspace.yaml' },
            { tag: 'test-loosening', because: 'test/search.test.ts, and 2 more' },
          ],
          clear: ['no path CODEOWNERS gives Martin', 'not a release, not an improvement'],
          head: HEAD,
          approving: true,
        },
        // Martin approves it on GitHub: no Merge, no Approve, and words go to the coder.
        way: undefined,
        review: { pullRequest: 1327, href: undefined, approving: true },
        note: undefined,
      });
      expect(need?.answers.map((a) => [a.label, a.does])).toEqual([
        ['Answer in words', 'Sends it back to the coder, with your words as the reason.'],
        // A sample's pull request never existed, so nothing is left open.
        ['Reject', 'Closes #2070, unmerged.'],
      ]);
      // Its pull request on GitHub, for one that is not a sample's.
      const real = work('2070', START).add(0, 'work-item.opened', 'factory', {
        kind: 'defect-fix',
        title: 'Real',
        sample: false,
      });
      const realNeed = needOf(merge('held', { approving: false }), real);
      expect(realNeed?.review).toEqual({
        pullRequest: 1327,
        href: 'https://github.com/the-roganator/cv-worlds-worst-website/pull/1327',
        approving: false,
      });
      // The line closes the work item and its issue, and leaves the pull request open.
      expect(realNeed?.answers.find((a) => a.answer === 'rejected')?.does).toBe(
        'Closes #2070, unmerged. Its pull request #1327 stays open on GitHub until you close it.',
      );
      // With no tags read, the gate said nothing clear either.
      expect(needOf(merge('held', { tags: undefined }))?.evidence).toMatchObject({ kind: 'gate', tags: [], clear: [] });
      // Held with no tags, for what the gate could not read or trust: the gate's hold, not its tags'.
      for (const tags of [undefined, []]) {
        expect(needOf(merge('held', { rule: 'held', tags }))?.kicker).toBe('Held by the review gate');
      }
      // Its chapter is a hold, as a gate's is.
      const held = work('2072', START).open().add(1, 'pull-request.pushed', 'coder', pushed);
      held.add(30, 'hold.started', 'factory', merge('held', { rule: 'held' }));
      expect(projectSheet(project(held.events, START + 60 * 60_000), '2072')?.chapters.at(-1)).toMatchObject({
        label: 'HELD',
        tone: 'attn',
      });
      // A tag it found is not drawn clear.
      const owned = needOf(merge('held', { tags: [{ tag: 'code-owned', because: ['src/flags/index.ts'] }] }));
      expect(owned?.evidence).toMatchObject({ clear: ['not a release, not an improvement'] });
    });

    it('says what would let the line merge one the level or auto-merge holds', () => {
      expect(needOf(merge('level', { rule: 'low-risk' }))).toMatchObject({
        kicker: 'Waiting for your merge',
        evidence: { kind: 'words', text: 'Held: level' },
        note: 'At Guarded or Lights-out, with auto-merge on, the line would add it to the merge queue itself.',
        way: { verb: 'Merge', pullRequest: 1327 },
        review: undefined,
      });
      expect(needOf(merge('level', { rule: 'lights-out' }))?.note).toBe(
        'At Lights-out, with auto-merge on, the line would add it to the merge queue itself.',
      );
      // Martin's own pull request is his to merge at every level.
      expect(needOf(merge('level', { rule: 'martin-opened' }))?.note).toBeUndefined();
      expect(needOf(merge('auto-merge', { rule: 'low-risk' }))?.note).toBe(
        'With auto-merge on, the line would add it to the merge queue itself.',
      );
      expect(needOf(merge('never'))?.answers.map((a) => a.answer)).toEqual(['answered', 'replanned', 'rejected']);
    });

    it('says why a conflict, or the merge queue, holds it, with the checks that failed on the queue’s commit', () => {
      expect(needOf(merge('conflict'))).toMatchObject({ kicker: 'Conflicts with main', way: { verb: 'Merge' } });
      expect(
        needOf(merge('queue', { queue: { reason: 'failed_checks', failed: ['e2e', 'CodeQL'] } }))?.evidence,
      ).toEqual({ kind: 'output', heading: 'merge queue · failed_checks · PR #1327', text: '✕ e2e\n✕ CodeQL' });
      expect(needOf(merge('queue', { queue: { reason: 'dequeued', failed: [] } }))).toMatchObject({
        kicker: 'Out of the merge queue',
        evidence: { text: 'No check failed on its commit.' },
      });
      expect(needOf(merge('refused'))?.kicker).toBe('The merge queue refused it');
    });

    it('ends the hold as the line adds it to the merge queue, and the sheet says it is there', () => {
      const item = work('2071', START)
        .open()
        .add(1, 'pull-request.pushed', 'coder', { ...pushed, branch: 'factory/2071' })
        .add(30, 'hold.started', 'factory', merge('auto-merge', { rule: 'low-risk' }))
        .add(40, 'pull-request.enqueued', 'factory', { number: 1327, commit: HEAD, rule: 'low-risk' });
      const t = START + 50 * 60_000;
      const view = project(item.events, t);
      expect(view.needs.holds).toEqual([]);
      const items = foldItems(item.events);
      expect(items[0]?.inQueue).toMatchObject({ number: 1327, rule: 'low-risk', at: START + 40 * 60_000 });
      const sheet = projectSheet(view, '2071');
      expect(sheet?.chapters.map((c) => c.label)).toContain('QUEUED');
      expect(sheet?.after).toEqual({
        outcome: 'in-progress',
        text: `In the merge queue since ${clock(START + 40 * 60_000)}: the line added PR #1327, which the review gate passed as low-risk`,
      });
      // Taken out unmerged, it is out of the queue, and the line holds it again.
      const out = item
        .add(45, 'pull-request.dequeued', 'factory', {
          number: 1327,
          commit: HEAD,
          reason: 'failed_checks',
          failed: [],
        })
        .add(46, 'hold.started', 'factory', merge('queue', { queue: { reason: 'failed_checks', failed: [] } }));
      const [again] = foldItems(out.events);
      expect(again?.inQueue).toBeUndefined();
      expect(
        needsView(
          [again].flatMap((i) => i ?? []),
          t,
        ).holds[0]?.kicker,
      ).toBe('Out of the merge queue');
      expect(projectSheet(project(out.events, t), '2071')?.chapters.map((c) => c.label)).toContain('OUT OF QUEUE');
    });

    it('keeps a pull request in the queue when the queue takes out an older commit of it, as the line does', () => {
      const NEWER = 'b'.repeat(40);
      const item = work('2073', START)
        .open()
        .add(1, 'pull-request.pushed', 'coder', { ...pushed, branch: 'factory/2073' })
        .add(40, 'pull-request.enqueued', 'factory', { number: 1327, commit: NEWER, rule: 'low-risk' })
        .add(45, 'pull-request.dequeued', 'factory', {
          number: 1327,
          commit: HEAD,
          reason: 'failed_checks',
          failed: [],
        });
      expect(foldItems(item.events)[0]?.inQueue).toMatchObject({ number: 1327, commit: NEWER });
      // Nor does the sheet say it went out of the queue: it is there still.
      const t = START + 50 * 60_000;
      expect(projectSheet(project(item.events, t), '2073')?.chapters.map((c) => c.label)).not.toContain('OUT OF QUEUE');
      // Once the commit it was added at comes out, it is out.
      const out = item.add(48, 'pull-request.dequeued', 'factory', {
        number: 1327,
        commit: NEWER,
        reason: 'failed_checks',
        failed: [],
      });
      expect(foldItems(out.events)[0]?.inQueue).toBeUndefined();
      expect(
        projectSheet(project(out.events, t), '2073')?.chapters.filter((c) => c.label === 'OUT OF QUEUE'),
      ).toHaveLength(1);
    });

    it('says nothing went out of the queue when a push had already taken it out', () => {
      const item = work('2074', START)
        .open()
        .add(1, 'pull-request.pushed', 'coder', { ...pushed, branch: 'factory/2074' })
        .add(40, 'pull-request.enqueued', 'factory', { number: 1327, commit: HEAD, rule: 'low-risk' })
        .add(42, 'pull-request.pushed', 'coder', { ...pushed, branch: 'factory/2074', attempt: 2 })
        .add(45, 'pull-request.dequeued', 'factory', {
          number: 1327,
          commit: HEAD,
          reason: 'failed_checks',
          failed: [],
        });
      const t = START + 50 * 60_000;
      expect(projectSheet(project(item.events, t), '2074')?.chapters.map((c) => c.label)).not.toContain('OUT OF QUEUE');
    });
  });

  it('shows the samples’ holds, the visitor’s suggestion among them, and its words answered today', () => {
    const { needs } = project(SAMPLES, END);
    expect(needs.holds.map((need) => [need.workItem, need.cause])).toEqual([
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
    expect(merge?.answers.map((a) => a.answer)).toEqual(['answered', 'replanned', 'rejected']);
    const review = needs.holds.find((need) => need.cause === 'review');
    expect(review?.answers.map((a) => a.label)).toEqual([
      'Approve',
      'Answer in words',
      'Back to the planner',
      'Reject',
    ]);
    // A sample's pull request never existed: the card's way names it, and links nowhere, as the sheet does.
    const nowhere = 'A sample’s pull request: it never existed, so it links nowhere.';
    expect(merge?.way).toEqual({ verb: 'Merge', pullRequest: 1312, href: undefined, why: nowhere });
    expect(needs.holds.find((need) => need.cause === 'deploy')?.way).toEqual({
      verb: 'Deploy',
      pullRequest: 1331,
      href: undefined,
      why: nowhere,
    });
    // A spend cap's settings are a link beside its evidence, not a way: the card's way is GitHub's only.
    const spend = needs.holds.find((need) => need.cause === 'spend');
    expect(spend?.link).toEqual({ href: '?view=settings', label: 'Raise the cap in the settings' });
    expect(spend?.way).toBeUndefined();
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
