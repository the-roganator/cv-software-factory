/**
 * A move's events, as triage writes them for the dependency sense's signal: their shapes, and their public views,
 * which withhold every finding's advisory and package, and a lockfile move's package, its versions and its lines,
 * always: the issue the line opens is where they become public.
 */
import { describe, expect, it } from 'vitest';
import { publicView } from '../src/public.ts';
import { PAYLOADS } from '../src/schemas.ts';
import type { EventType } from '../src/versions.ts';
import { ticketSeverity, WITHHELD_PACKAGE } from '../src/vocabulary.ts';

const view = <K extends EventType>(type: K, payload: unknown) => {
  const parsed = PAYLOADS[type].parse(payload);
  const once = publicView(type, { summary: 'An event', payload: parsed, artifacts: [] } as never);
  // A view applied twice changes nothing.
  expect(publicView(type, once as never)).toEqual(once);
  return once.payload as Record<string, unknown>;
};

const scan = {
  kind: 'scan',
  findings: [
    {
      advisory: 'GHSA-aaaa-bbbb-cccc',
      package: 'left-pad',
      severity: { scanner: 'high', publisher: 'critical' },
      fixed: '1.2.4',
      deadline: '2026-11-15T00:00:00.000Z',
    },
  ],
  rest: { critical: 0, high: 0, medium: 1, low: 0, unknown: 0 },
};

const signal = (move: object) => ({
  sense: 'dependency',
  check: 'the vulnerability scan',
  version: 'a'.repeat(40),
  symptom: 'vulnerable-dependency',
  move: {
    repository: 'the-roganator/cv-worlds-worst-website',
    from: '1.2.3',
    to: '1.2.4',
    ...move,
  },
  evidence: [scan],
});

const lockfile = { name: 'left-pad', ecosystem: 'npm', pins: [{ file: 'pnpm-lock.yaml', line: 812 }] };
const image = {
  name: 'node',
  ecosystem: 'docker',
  from: '24.11.0-alpine',
  to: '24.11.1-alpine',
  pins: [{ file: 'Dockerfile', line: 1 }],
};

describe("a move's public views", () => {
  it('withhold a lockfile move’s package, versions and lines, and every advisory, in its signal', () => {
    const shown = view('signal.received', signal(lockfile));
    expect(shown.move).toEqual({
      repository: 'the-roganator/cv-worlds-worst-website',
      name: 'a package in `pnpm-lock.yaml`',
      ecosystem: 'npm',
      from: '',
      to: '',
      pins: [{ file: 'pnpm-lock.yaml', line: 0 }],
    });
    expect(JSON.stringify(shown)).not.toMatch(/left-pad|GHSA|1\.2\.[34]|812/);
    expect(shown.evidence).toEqual([
      {
        ...scan,
        findings: [{ severity: { scanner: 'high', publisher: 'critical' }, deadline: '2026-11-15T00:00:00.000Z' }],
      },
    ]);
  });

  it('keep an image’s name and versions, as the day’s moves do, but never a finding’s advisory or package', () => {
    const shown = view('signal.received', signal(image));
    expect(shown.move).toMatchObject({ name: 'node', from: '24.11.0-alpine', to: '24.11.1-alpine' });
    expect(JSON.stringify(shown)).not.toMatch(/left-pad|GHSA/);
    expect((shown.evidence as { findings: object[] }[])[0]?.findings[0]).toEqual({
      severity: { scanner: 'high', publisher: 'critical' },
      fixed: '1.2.4',
      deadline: '2026-11-15T00:00:00.000Z',
    });
  });

  it('withhold a lockfile move’s package from its ticket’s fingerprint and title, which reads as the day’s row', () => {
    const ticket = {
      title: 'Move left-pad in `pnpm-lock.yaml`',
      category: 'security',
      severity: 'broken',
      fingerprint: { name: 'left-pad', ecosystem: 'npm' },
      traces: [],
    };
    expect(view('ticket.opened', ticket)).toEqual({
      ...ticket,
      title: 'Move a package in `pnpm-lock.yaml`',
      fingerprint: { name: WITHHELD_PACKAGE, ecosystem: 'npm' },
    });
    // A title in any other words names nothing.
    expect(view('ticket.opened', { ...ticket, title: 'left-pad is vulnerable' }).title).toBe('Move a package, in npm');
    const node = { ...ticket, title: 'Move node, in docker', fingerprint: { name: 'node', ecosystem: 'docker' } };
    expect(view('ticket.opened', node)).toEqual(node);
  });

  it('withhold a lockfile move’s package and versions from its work item’s pin, and from its reopening', () => {
    const opened = {
      kind: 'dependency-update',
      title: 'Move a package in `pnpm-lock.yaml`',
      sample: false,
      category: 'security',
      dependency: { name: 'left-pad', ecosystem: 'npm', from: '1.2.3', to: '1.2.4', security: true },
    };
    expect(view('work-item.opened', opened).dependency).toEqual({
      name: WITHHELD_PACKAGE,
      ecosystem: 'npm',
      from: '',
      to: '',
      security: true,
    });
    const reopened = {
      sense: 'dependency',
      check: 'the vulnerability scan',
      move: { name: 'left-pad', ecosystem: 'npm' },
      version: 'a'.repeat(40),
      reason: 'The day’s scan found the move again',
      dryRun: false,
    };
    expect(view('work-item.reopened', reopened).move).toEqual({ name: WITHHELD_PACKAGE, ecosystem: 'npm' });
  });

  it('show a rating whole', () => {
    expect(view('ticket.rated', { severity: 'broken', was: 'degraded' })).toEqual({
      severity: 'broken',
      was: 'degraded',
    });
  });
});

describe("a ticket's rating", () => {
  it('only raises a severity', () => {
    expect(PAYLOADS['ticket.rated'].safeParse({ severity: 'degraded', was: 'broken' }).success).toBe(false);
    expect(PAYLOADS['ticket.rated'].safeParse({ severity: 'broken', was: 'broken' }).success).toBe(false);
    expect(ticketSeverity('degraded', ['broken', 'cosmetic'])).toBe('broken');
    expect(ticketSeverity('degraded', [])).toBe('degraded');
  });
});

describe("a move's reopening", () => {
  const base = { check: 'pages load', version: 'a'.repeat(40), reason: 'Back', dryRun: false };
  it('names a route or a move, never both, and only the dependency sense names a move', () => {
    const parse = (p: object) => PAYLOADS['work-item.reopened'].safeParse({ ...base, ...p }).success;
    expect(parse({ sense: 'probe', route: '/search' })).toBe(true);
    expect(parse({ sense: 'dependency', move: { name: 'node', ecosystem: 'docker' } })).toBe(true);
    expect(parse({ sense: 'dependency', route: '/search' })).toBe(false);
    expect(parse({ sense: 'probe', move: { name: 'node', ecosystem: 'docker' } })).toBe(false);
    expect(parse({ sense: 'dependency', route: '/', move: { name: 'node', ecosystem: 'docker' } })).toBe(false);
    expect(parse({ sense: 'probe' })).toBe(false);
  });
});
