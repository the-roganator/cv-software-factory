/**
 * What the dependency sense sends triage: one signal for each of the app's moves in the lane `line` with a target,
 * under an id that makes the same send the same, and only the fixed fields of what the alerts say.
 */
import { validateSignal } from '@software-factory/events/schemas';
import { describe, expect, it } from 'vitest';
import type { MoveFinding, Moves, ReadMove } from '../../src/github/scanning.ts';
import { sendId, sendsOf } from '../../src/patching/sends.ts';
import { APP, appMoves, digest } from './fixtures.ts';

const zero = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, UNKNOWN: 0 };

/** A finding its alert gives: the move's target (`fix`), and the advisory's own fixed versions, null for none. */
const found = (
  n: number,
  severity: MoveFinding['severity'],
  fix = 'version 1.2.4',
  fixed: string | null = '1.2.4',
): MoveFinding => ({
  alert: n,
  advisory: `CVE-2026-${1000 + n}`,
  severity,
  package: 'left-pad',
  installed: '1.2.3',
  file: 'pnpm-lock.yaml',
  line: 812,
  ...(fixed && { fixed }),
  fix,
  firstSeen: '2026-11-10T04:59:00Z',
});

const base: Omit<ReadMove, 'index' | 'name' | 'pins' | 'from' | 'to' | 'lockfile' | 'findings'> = {
  repository: APP,
  major: false,
  clears: { ...zero, HIGH: 1 },
  leaves: zero,
  newToday: 0,
  lane: 'line',
};

const lockfile: ReadMove = {
  ...base,
  index: 1,
  name: 'a package in `pnpm-lock.yaml`',
  pins: [{ file: 'pnpm-lock.yaml', line: 0 }],
  from: '',
  to: '',
  lockfile: true,
  withheld: { package: 'left-pad', from: '1.2.3', to: 'version 1.2.4', pins: [{ file: 'pnpm-lock.yaml', line: 812 }] },
  findings: [found(1, 'MEDIUM'), found(2, 'HIGH')],
};
const image: ReadMove = {
  ...base,
  index: 2,
  name: 'node',
  pins: [{ file: 'Dockerfile', line: 1 }],
  from: '24.11.0-alpine',
  to: `image 24.11.1-alpine@${digest(7)}`,
  lockfile: false,
  leaves: { ...zero, LOW: 2 },
  findings: [found(3, 'CRITICAL', `image 24.11.1-alpine@${digest(7)}`, '3.5.1')],
};
const node: ReadMove = {
  ...image,
  index: 3,
  name: 'node',
  pins: [{ file: 'mise.toml', line: 3 }],
  from: '24.11.0',
  to: 'version 24.11.1',
  leaves: zero,
  findings: [found(4, 'HIGH', 'version 24.11.1', '24.11.1')],
};

const read = (moves: ReadMove[]): Moves => ({ ...appMoves(), moves });

describe("the sense's sends", () => {
  it('sends each of the app’s moves for the line with a target: a lockfile’s by its package, an image, Node', () => {
    const { sends, skipped } = sendsOf(read([lockfile, image, node]), '2026-11-11T04:59:00Z');
    expect(skipped).toEqual([]);
    expect(sends.map((s) => s.signal.move)).toEqual([
      {
        repository: APP,
        name: 'left-pad',
        ecosystem: 'npm',
        from: '1.2.3',
        to: '1.2.4',
        pins: [{ file: 'pnpm-lock.yaml', line: 812 }],
      },
      {
        repository: APP,
        name: 'node',
        ecosystem: 'docker',
        from: '24.11.0-alpine',
        to: `24.11.1-alpine@${digest(7)}`,
        pins: [{ file: 'Dockerfile', line: 1 }],
      },
      {
        repository: APP,
        name: 'node',
        ecosystem: 'node',
        from: '24.11.0',
        to: '24.11.1',
        pins: [{ file: 'mise.toml', line: 3 }],
      },
    ]);
    for (const { signal } of sends) expect(validateSignal(signal)).toEqual({ ok: true });
    expect(sends[0]?.signal).toMatchObject({
      sense: 'dependency',
      symptom: 'vulnerable-dependency',
      version: appMoves().run.headSha,
      observedAt: '2026-11-11T04:59:00Z',
      evidence: [
        {
          kind: 'scan',
          // Worst first, with only the fields the grammar reads.
          findings: [
            { advisory: 'CVE-2026-1002', package: 'left-pad', severity: { scanner: 'high' }, fixed: '1.2.4' },
            { advisory: 'CVE-2026-1001', package: 'left-pad', severity: { scanner: 'medium' }, fixed: '1.2.4' },
          ],
          rest: { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 },
        },
      ],
    });
    // What the move leaves on its pins is counted with the rest.
    expect(sends[1]?.signal.evidence?.[0]).toMatchObject({ rest: { low: 2 } });
  });

  it('gives a finding’s fixed versions as its advisory gives them, never the move’s target in their place', () => {
    // An image moves to its tag; its packages' advisories are fixed in their own versions, or not yet.
    const findings = [found(3, 'CRITICAL', image.to, '3.5.1, 3.6.0'), found(5, 'HIGH', image.to, null)];
    const [send] = sendsOf(read([{ ...image, findings }]), '2026-11-11T04:59:00Z').sends;
    expect(send?.signal.move?.to).toBe(`24.11.1-alpine@${digest(7)}`);
    expect(send?.signal.evidence?.[0]).toMatchObject({
      findings: [
        { advisory: 'CVE-2026-1003', package: 'left-pad', severity: { scanner: 'critical' }, fixed: '3.5.1, 3.6.0' },
        { advisory: 'CVE-2026-1005', package: 'left-pad', severity: { scanner: 'high' } },
      ],
    });
    const scan = send?.signal.evidence?.[0];
    expect(scan?.kind === 'scan' ? scan.findings[1] : undefined).not.toHaveProperty('fixed');
    // The tag is the move's, and in no finding.
    expect(JSON.stringify(scan)).not.toContain('24.11.1-alpine');
    expect(validateSignal(send?.signal)).toEqual({ ok: true });
  });

  it('sends a finding whose fixed versions do not fit without them, and keeps it among the worst', () => {
    // A range, which no signal's versions hold, on the move's only critical finding.
    const findings = [found(3, 'CRITICAL', image.to, '>= 3.5.1'), found(5, 'LOW', image.to, '1.0.1')];
    const { sends, skipped } = sendsOf(read([{ ...image, findings }]), '2026-11-11T04:59:00Z');
    expect(skipped).toEqual(['move 2: 1 findings whose fixed versions do not fit a signal, sent without them']);
    const scan = sends[0]?.signal.evidence?.[0];
    expect(scan?.kind === 'scan' ? scan.findings : []).toEqual([
      { advisory: 'CVE-2026-1003', package: 'left-pad', severity: { scanner: 'critical' } },
      { advisory: 'CVE-2026-1005', package: 'left-pad', severity: { scanner: 'low' }, fixed: '1.0.1' },
    ]);
    expect(validateSignal(sends[0]?.signal)).toEqual({ ok: true });
  });

  it('gives a finding’s fixed versions each once, lowest first, however its alert ordered them', () => {
    const AT = '2026-11-11T04:59:00Z';
    const one = sendsOf(read([{ ...image, findings: [found(3, 'HIGH', image.to, '3.10.0, 3.9.1, 3.9.1')] }]), AT);
    const two = sendsOf(read([{ ...image, findings: [found(3, 'HIGH', image.to, '3.9.1, 3.10.0')] }]), AT);
    const fixedIn = (sends: typeof one.sends) => {
      const scan = sends[0]?.signal.evidence?.[0];
      return scan?.kind === 'scan' ? scan.findings[0]?.fixed : undefined;
    };
    expect(fixedIn(one.sends)).toBe('3.9.1, 3.10.0');
    expect(fixedIn(two.sends)).toBe('3.9.1, 3.10.0');
  });

  it('sends nothing for another lane, or a move with no target', () => {
    const none = [
      { ...image, lane: 'worker' as const },
      { ...image, to: '' },
      { ...image, to: 'another line (this one last built 2025-01-01T00:00:00Z)' },
      { ...lockfile, withheld: undefined },
      { ...lockfile, withheld: { ...lockfile.withheld, to: '' } as ReadMove['withheld'] },
    ];
    const { sends, skipped } = sendsOf(read(none), '2026-11-11T04:59:00Z');
    expect(sends).toEqual([]);
    // Each one said, but the other lane's, which is not the line's to send.
    expect(skipped).toHaveLength(4);
  });

  it('gives the same send the same id: one move of one repository from one run of the scan', () => {
    const [first] = sendsOf(read([lockfile]), '2026-11-11T04:59:00Z').sends;
    const [again] = sendsOf(read([lockfile]), '2026-11-11T04:59:00Z').sends;
    expect(again?.id).toBe(first?.id);
    const nextRun = { ...read([lockfile]), run: { ...appMoves().run, id: appMoves().run.id + 1 } };
    expect(sendsOf(nextRun, '2026-11-12T04:59:00Z').sends[0]?.id).not.toBe(first?.id);
    expect(first?.id).toBe(sendId(APP, appMoves().run.id, { name: 'left-pad', ecosystem: 'npm' }));
  });

  it('keeps at most eight findings, and counts a finding that does not fit the signal’s shape with the rest', () => {
    const many = Array.from({ length: 10 }, (_, i) => found(i + 1, 'HIGH'));
    const odd = { ...found(20, 'CRITICAL'), advisory: 'not an advisory id' };
    const { sends, skipped } = sendsOf(read([{ ...lockfile, findings: [odd, ...many] }]), '2026-11-11T04:59:00Z');
    const [send] = sends;
    expect(skipped).toEqual(['move 1: 1 findings that do not fit a signal, counted with the rest']);
    const scan = send?.signal.evidence?.[0];
    expect(scan).toMatchObject({ rest: { critical: 1, high: 2 } });
    expect(scan?.kind === 'scan' ? scan.findings.map((f) => f.advisory) : []).not.toContain('not an advisory id');
  });

  it('sends one signal for a name the scan moves from two versions, as triage keeps one ticket for it', () => {
    const second: ReadMove = {
      ...lockfile,
      index: 2,
      withheld: {
        package: 'left-pad',
        from: '2.0.0',
        to: 'version 2.0.1',
        pins: [{ file: 'pnpm-lock.yaml', line: 900 }],
      },
      findings: [found(9, 'CRITICAL', 'version 2.0.1', '2.0.1')],
    };
    const { sends, skipped } = sendsOf(read([lockfile, second]), '2026-11-11T04:59:00Z');
    expect(skipped).toEqual([]);
    expect(sends).toHaveLength(1);
    expect(sends[0]?.signal.move).toMatchObject({
      name: 'left-pad',
      from: '1.2.3,2.0.0',
      to: '1.2.4,2.0.1',
      pins: [
        { file: 'pnpm-lock.yaml', line: 812 },
        { file: 'pnpm-lock.yaml', line: 900 },
      ],
    });
    const scan = sends[0]?.signal.evidence?.[0];
    expect(scan?.kind === 'scan' ? scan.findings[0]?.severity.scanner : undefined).toBe('critical');
    expect(validateSignal(sends[0]?.signal)).toEqual({ ok: true });
  });

  it('says what it could not send: a pin with no line, and a move that fits no signal', () => {
    const lineless = { ...image, pins: [...image.pins, { file: 'Dockerfile', line: 0 }] };
    const spaced = { ...image, index: 4, name: 'an image', to: `image 1@${digest(8)}` };
    const { sends, skipped } = sendsOf(read([lineless, spaced]), '2026-11-11T04:59:00Z');
    expect(sends.map((s) => s.signal.move?.pins)).toEqual([[{ file: 'Dockerfile', line: 1 }]]);
    expect(skipped[0]).toBe('move 2: 1 pins with no line, not sent');
    expect(skipped[1]).toMatch(/^move 4: does not fit a signal \(move.name: /);
  });
});
