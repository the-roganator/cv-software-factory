import { type AdvisorySeverity, moveFingerprint } from '@software-factory/events';
import { validate } from '@software-factory/events/schemas';
import { fingerprintOf } from '@software-factory/store';
import { describe, expect, it } from 'vitest';
import { ENVIRONMENT, SYMPTOMS, VULNERABLE, vulnerableSeverity } from '../../../policy/triage.ts';
import { environmentEvents, senseReopened, ticketTitle } from '../src/events.ts';
import { sameFingerprint } from '../src/worker.ts';

describe('a problem held while what its sense reads was not healthy', () => {
  it('fits its events to the store, when everything the log watcher reads was unhealthy at once', () => {
    const saw = 'x'.repeat(160);
    const signal = {
      sense: 'logs' as const,
      check: 'every request leaves a record',
      route: '/products/:slug',
      version: 'v0.9.2',
      symptom: 'missing-log' as const,
      observedAt: '2026-10-13T19:47:57.000Z',
      artifacts: [],
      environment: {
        at: '2026-10-13T19:47:57.000Z',
        dependencies: (['prometheus', 'loki', 'tempo', 'disk'] as const).map((name) => ({ name, healthy: false, saw })),
      },
    };
    const events = environmentEvents(signal, 'signal-1', '1037', new Date(signal.observedAt));
    for (const event of events) expect(validate(event)).toEqual({ ok: true });
    expect(events.find((event) => event.type === 'hold.started')?.payload).toMatchObject({
      cause: 'environment',
      reason: expect.stringMatching(
        /^The log watcher found a new problem while Prometheus, Loki, Tempo and the cluster’s disk were not healthy: /,
      ),
    });
  });
});

describe('a ticket a sense saw again', () => {
  it('reopens with its reason cut between characters, and marked, when the check is long', () => {
    const signal = {
      sense: 'crawler' as const,
      check: '\u{1F600}'.repeat(40),
      route: `/products/${'a'.repeat(70)}`,
      version: 'a'.repeat(40),
      symptom: 'broken-link' as const,
      observedAt: '2026-10-13T19:47:57.000Z',
      artifacts: [],
    };
    const events = senseReopened(signal, 'signal-1', '1037', new Date(signal.observedAt));
    for (const event of events) expect(validate(event)).toEqual({ ok: true });
    const reason = events.find((event) => event.type === 'work-item.reopened')?.payload.reason as string;
    expect(reason.length).toBeLessThanOrEqual(200);
    expect(reason.endsWith('…')).toBe(true);
    expect(reason.isWellFormed()).toBe(true);
  });
});

describe('a dependency’s symptoms, by the policy', () => {
  const finding = (scanner: AdvisorySeverity, publisher?: AdvisorySeverity, fixed: string | undefined = '2.1.1') => ({
    severity: { scanner, ...(publisher && { publisher }) },
    ...(fixed && { fixed }),
  });

  it('rates a vulnerable dependency by its worst finding with a fix, by the worse of its two ratings', () => {
    expect(SYMPTOMS['vulnerable-dependency'].category).toBe('security');
    for (const [rating, severity] of [
      ['critical', 'broken'],
      ['high', 'broken'],
      ['medium', 'degraded'],
      ['low', 'cosmetic'],
      ['unknown', 'cosmetic'],
    ] as const) {
      expect(VULNERABLE[rating]).toBe(severity);
      expect(vulnerableSeverity([finding(rating)])).toBe(severity);
    }
    // The publisher's rating counts as the scanner's does, as a deadline does.
    expect(vulnerableSeverity([finding('medium', 'critical')])).toBe('broken');
    // The worst of the move's findings sets it, a Low riding along with a High.
    expect(vulnerableSeverity([finding('low'), finding('high'), finding('medium')])).toBe('broken');
    // A finding with no fix is not the move's to clear.
    expect(vulnerableSeverity([finding('critical', undefined, ''), finding('medium')])).toBe('degraded');
    expect(vulnerableSeverity([finding('critical', undefined, '')])).toBe('cosmetic');
  });

  it('opens a routine update as a dependency, cosmetic', () => {
    expect(SYMPTOMS['outdated-dependency']).toEqual({ category: 'dependency', severity: 'cosmetic' });
    // The dependency sense reads none of what triage looks at.
    expect(ENVIRONMENT.reads.dependency).toEqual([]);
  });

  it('fingerprints a move by name and ecosystem: its later targets are its ticket’s, another move is not', () => {
    const move = {
      repository: 'the-roganator/cv-worlds-worst-website',
      name: '@invented/glob-walker',
      ecosystem: 'npm' as const,
      from: '3.0.1',
      to: '3.0.2',
      pins: [{ file: 'pnpm-lock.yaml', line: 120 }],
    };
    const found = (to: Partial<typeof move>) =>
      ({ sense: 'dependency', move: { ...move, ...to }, symptom: 'vulnerable-dependency' }) as const;
    const ticket = moveFingerprint(move);
    expect(fingerprintOf(found({ to: '3.1.0' }))).toBe(fingerprintOf(found({})));
    expect(fingerprintOf(found({ from: '3.0.2', to: '3.0.4' }))).toBe('move npm @invented/glob-walker');
    expect(fingerprintOf(found({ name: '@invented/other' }))).not.toBe(fingerprintOf(found({})));
    const later = { ...move, to: '4.0.0' };
    expect(sameFingerprint(ticket, moveFingerprint(later))).toBe(true);
    expect(sameFingerprint(ticket, moveFingerprint({ ...move, ecosystem: 'docker' }))).toBe(false);
    expect(sameFingerprint(ticket, { route: '/', class: 'broken-link' })).toBe(false);
    expect(ticketTitle(ticket)).toBe('Move @invented/glob-walker, in npm');
  });
});
