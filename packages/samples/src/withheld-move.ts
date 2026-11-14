/**
 * The line's move of the app's lockfile, as the day's scan found it: a package with a critical finding, which its
 * public views withhold until the line opens its issue in the app's repository, the one moment of disclosure. From the
 * issue on, the console names the package and its versions; the Patching row, which cannot be joined to the work item,
 * still withholds them. It waits for Martin's merge, as every dependency change does.
 *
 * Not one of the samples: they load into a store as their public views (`make samples`), which the store checks
 * against the events' own schemas, and a withheld view is no valid payload ("a package", no versions, findings with no
 * advisory). The console's tests add its public views to the samples' instead, from `start`.
 */
import type { PublicEvent } from '@software-factory/events';
import { publicView } from '@software-factory/events/public';
import { validate } from '@software-factory/events/schemas';
import { commitFor, Item } from './build.ts';
import { WITHHELD } from './patching-withheld.ts';
import { appenderOf } from './roles.ts';

const APP = 'the-roganator/cv-worlds-worst-website';
const MOVE = { repository: APP, ...WITHHELD, ecosystem: 'npm' as const };

/** The scan's findings on the move, as the dependency sense's signal carries them. The advisories are invented. */
const FINDINGS = [
  {
    advisory: 'GHSA-p4x7-2m9q-c8vh',
    package: WITHHELD.name,
    severity: { scanner: 'critical' as const, publisher: 'high' as const },
    fixed: WITHHELD.to,
    deadline: '2026-10-08T00:20:00.000Z',
  },
  {
    advisory: 'GHSA-w6r3-h5jk-9t2f',
    package: WITHHELD.name,
    severity: { scanner: 'low' as const },
    fixed: '4.2.1',
    deadline: '2026-11-05T04:20:00.000Z',
  },
];

const LOCKFILE = {
  before: { critical: 1, high: 0, medium: 1, low: 3, unknown: 0 },
  after: { critical: 0, high: 0, medium: 1, low: 2, unknown: 0 },
};

const TITLE = 'Move a package in `pnpm-lock.yaml`';

/** The move's work item, opened at `start` (ISO 8601). */
export const withheldMove = (start: string) =>
  new Item('1335', start)
    .at('0:00', 'work-item.opened', 'triage', 'The dependency sense opened a work item', {
      kind: 'dependency-update',
      title: TITLE,
      sample: true,
      category: 'security',
      dependency: { name: MOVE.name, ecosystem: 'npm', from: MOVE.from, to: MOVE.to, security: true },
    })
    .at(
      '0:00',
      'signal.received',
      'dependency',
      'The day’s scan: 2 findings on a move of the app’s, broken by its worst with a fix',
      {
        sense: 'dependency',
        check: 'vulnerabilities',
        version: commitFor(`${APP}/scan/2026-10-06`),
        symptom: 'vulnerable-dependency',
        move: MOVE,
        evidence: [{ kind: 'scan', findings: FINDINGS, rest: { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 } }],
      },
    )
    .at('0:00', 'ticket.opened', 'triage', 'Ticket #1335: security, broken', {
      title: `Move ${MOVE.name} in \`pnpm-lock.yaml\``,
      category: 'security',
      severity: 'broken',
      fingerprint: { name: MOVE.name, ecosystem: 'npm' },
      traces: [],
    })
    .at('0:00', 'work-item.summarised', 'triage', 'Summary written', {
      title: TITLE,
      description: 'The day’s scan found a move of the app’s to make. Triage opened a ticket, security and broken.',
      story:
        'The vulnerability scan groups what it finds into moves: one pin going from what it is to what fixes it. The dependency sense sent this one of the app’s, and triage opened ticket #1335 for it with the scan’s findings as evidence: its worst finding with a fix sets its severity, broken, by the policy’s table, read from the scan’s ratings and never from an advisory’s words. No model judged it.',
    })
    .at('0:40', 'issue.opened', 'factory', `Opened issue #1336 in ${APP}`, {
      repository: APP,
      number: 1336,
      move: {
        name: MOVE.name,
        ecosystem: 'npm',
        from: MOVE.from,
        to: MOVE.to,
        pins: MOVE.pins,
        findings: FINDINGS.map(({ deadline: _deadline, ...finding }) => finding),
      },
    })
    .calls('planner', '0:45', '2:20', { calls: 3, input: 28_000, output: 1_600, cached: 0.3 })
    .at('2:30', 'spec.written', 'planner', 'Spec written: 2 criteria, 2 paths in scope', {
      outcome: `${MOVE.name} moves from ${MOVE.from} to ${MOVE.to}, which fixes both of the scan’s findings, and every gate passes.`,
      criteria: [
        {
          given: 'the change’s lockfile',
          when: 'the scan gates scan it',
          expect: 'neither finding the move fixes is found',
          from: 'signal 1',
          quote: `the scan's GHSA-p4x7-2m9q-c8vh in ${MOVE.name}: critical, high by its publisher; fixed in ${MOVE.to}`,
        },
        {
          given: 'the change',
          when: 'every required check runs on it',
          expect: 'each passes',
          from: 'signal 1',
          quote: `${MOVE.name} (npm) in ${APP}, from ${MOVE.from} to ${MOVE.to}`,
        },
      ],
      scope: ['src/pages/product.ts', 'test/product.test.ts'],
      risks: ['dependency-change'],
      rollout: 'A patch release inside the manifest’s range: the product page reads the same, and it ships as it is.',
    })
    .calls('coder', '2:40', '4:50', { calls: 4, input: 46_000, output: 900, cached: 0.7 })
    .pushed('5:00', 'coder', 'The move pushed to PR #1337', {
      number: 1337,
      title: `fix(deps): move ${MOVE.name} to ${MOVE.to}`,
      branch: 'factory/1335-move',
      attempt: 1,
      testsFirst: false,
      files: [{ path: 'pnpm-lock.yaml', added: 4, removed: 4 }],
    })
    .gates('5:10', {
      pullRequest: 1337,
      more: [['Lockfile scan', 30]],
      details: {
        'Lockfile scan': { summary: 'No critical findings; one critical and one low fewer', findings: LOCKFILE },
      },
    })
    .calls('reviewer', '8:00', '9:40', { calls: 2, input: 26_000, output: 1_300, cached: 0.5 })
    .at('9:50', 'review.submitted', 'reviewer', 'Approved; a dependency change, so it waits for Martin', {
      pullRequest: 1337,
      verdict: 'approved',
      note: 'The lockfile moves the one package, to the version that fixes both findings, and nothing in the app’s code changes.',
      findings: [],
    })
    .calls('describer', '10:00', '11:10', { calls: 2, input: 19_000, output: 1_100, cached: 0.4 })
    .at('11:20', 'work-item.summarised', 'describer', 'Summary written', {
      title: `${MOVE.name} moves past a critical finding`,
      description: `The day’s scan found a critical finding in ${MOVE.name}, which the shop’s product page uses. The move takes it to the patch release that fixes it, and nothing else changes.`,
      story: `The dependency sense sent the day’s scan of the app: ${MOVE.name} had a critical finding, and a low one, both fixed in a patch release. The line opened the ticket’s issue, and the planner’s spec asked that the scans no longer show them and that every gate pass. The line moved the lockfile itself, and the coder found nothing more to change. Every gate passed, the lockfile scan with the critical finding gone, and the reviewer approved.`,
    })
    .at('11:21', 'hold.started', 'factory', 'Waiting for Martin: dependency changes carry a risk tag', {
      stage: 'review',
      kind: 'approval',
      cause: 'merge',
      reason: 'A dependency change carries a risk tag, so it waits for Martin to approve the merge.',
    });

/**
 * The move's events as the console reads them: each checked against its schema as the store would, then its public
 * view, numbered on from `after` (the samples' last seq). The views before `issue.opened` name no package, version or
 * advisory.
 */
export function withheldMoveEvents(start: string, after: number): PublicEvent[] {
  return withheldMove(start).events.map((event, i) => {
    const result = validate(event);
    if (!result.ok) throw new Error(`#1335 ${event.type}: ${result.problems.join('; ')}`);
    return {
      ...event,
      ...publicView(event.type, event),
      seq: after + i + 1,
      appended_by: appenderOf(event),
    } as PublicEvent;
  });
}
