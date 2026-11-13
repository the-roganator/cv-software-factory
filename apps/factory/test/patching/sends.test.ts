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

const found = (n: number, severity: MoveFinding['severity'], fix = 'version 1.2.4'): MoveFinding => ({
  alert: n,
  advisory: `CVE-2026-${1000 + n}`,
  severity,
  package: 'left-pad',
  installed: '1.2.3',
  file: 'pnpm-lock.yaml',
  line: 812,
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
  findings: [found(3, 'CRITICAL', `image 24.11.1-alpine@${digest(7)}`)],
};
const node: ReadMove = {
  ...image,
  index: 3,
  name: 'node',
  pins: [{ file: 'mise.toml', line: 3 }],
  from: '24.11.0',
  to: 'version 24.11.1',
  leaves: zero,
  findings: [found(4, 'HIGH', 'version 24.11.1')],
};

const read = (moves: ReadMove[]): Moves => ({ ...appMoves(), moves });

describe("the sense's sends", () => {
  it('sends each of the app’s moves for the line with a target: a lockfile’s by its package, an image, Node', () => {
    const sends = sendsOf(read([lockfile, image, node]), '2026-11-11T04:59:00Z');
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

  it('sends nothing for another lane, or a move with no target', () => {
    const none = [
      { ...image, lane: 'worker' as const },
      { ...image, to: '' },
      { ...image, to: 'another line (this one last built 2025-01-01T00:00:00Z)' },
      { ...lockfile, withheld: undefined },
      { ...lockfile, withheld: { ...lockfile.withheld, to: '' } as ReadMove['withheld'] },
    ];
    expect(sendsOf(read(none), '2026-11-11T04:59:00Z')).toEqual([]);
  });

  it('gives the same send the same id: one move of one repository from one run of the scan', () => {
    const [first] = sendsOf(read([lockfile]), '2026-11-11T04:59:00Z');
    const [again] = sendsOf(read([lockfile]), '2026-11-11T04:59:00Z');
    expect(again?.id).toBe(first?.id);
    const nextRun = { ...read([lockfile]), run: { ...appMoves().run, id: appMoves().run.id + 1 } };
    expect(sendsOf(nextRun, '2026-11-12T04:59:00Z')[0]?.id).not.toBe(first?.id);
    expect(first?.id).toBe(sendId(APP, appMoves().run.id, { name: 'left-pad', ecosystem: 'npm' }));
  });

  it('keeps at most eight findings, and counts a finding that does not fit the signal’s shape with the rest', () => {
    const many = Array.from({ length: 10 }, (_, i) => found(i + 1, 'HIGH'));
    const odd = { ...found(20, 'CRITICAL'), advisory: 'not an advisory id' };
    const [send] = sendsOf(read([{ ...lockfile, findings: [odd, ...many] }]), '2026-11-11T04:59:00Z');
    const scan = send?.signal.evidence?.[0];
    expect(scan).toMatchObject({ rest: { critical: 1, high: 2 } });
    expect(scan?.kind === 'scan' ? scan.findings.map((f) => f.advisory) : []).not.toContain('not an advisory id');
  });
});
