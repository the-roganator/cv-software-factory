import { describe, expect, it } from 'vitest';
import { compare, type Figures, KEPT, report, storeQuery } from './cluster-figures.ts';

/** A cluster's figures, as `take` gives them; each test moves one thing. */
function figures(): Figures {
  return {
    lastSeq: 777,
    events: { upto: 777, count: 777, digest: 'e'.repeat(32) },
    kept: Object.fromEntries(Object.keys(KEPT).map((table) => [table, { count: 2, digest: table.padEnd(32, '0') }])),
    counts: { events: 777, inbox: 14698, passkeys: 2 },
    flags: 'f'.repeat(64),
    secrets: 's'.repeat(64),
    volumes: ['pvc-1 factory/data-postgres-0', 'pvc-2 factory/artifacts'],
    line: 'stopped',
  };
}

describe('the figures a moved cluster must match (make upgrade-cluster)', () => {
  it('find nothing moved when everything is as it was', () => {
    expect(compare(figures(), figures())).toEqual([]);
  });

  it('allow events after the move, and every other table to move, as long as what was there is', () => {
    const after = figures();
    after.lastSeq = 790;
    after.counts = { events: 790, inbox: 14700, passkeys: 2 };
    expect(compare(figures(), after)).toEqual([]);
  });

  it('find a lost event, a changed one, and a store that went back', () => {
    const lost = figures();
    lost.events = { ...lost.events, count: 776 };
    expect(compare(figures(), lost)).toEqual([expect.stringMatching(/^the events to seq 777 differ: 776/)]);

    const changed = figures();
    changed.events = { ...changed.events, digest: '0'.repeat(32) };
    expect(compare(figures(), changed)).toHaveLength(1);

    const behind = figures();
    behind.lastSeq = 700;
    behind.events = { upto: 777, count: 700, digest: 'b'.repeat(32) };
    expect(compare(figures(), behind)).toEqual([
      'the last seq is 700, was 777',
      expect.stringMatching(/^the events to seq 777 differ/),
    ]);
  });

  it('hold the events counted after to the seq they were counted to before', () => {
    const after = figures();
    after.events = { ...after.events, upto: 790 };
    expect(compare(figures(), after)).toEqual(['the events were counted to seq 790 after, not 777']);
  });

  it.each(Object.keys(KEPT))('find %s changed, though its count is the same', (table) => {
    const after = figures();
    after.kept[table] = { count: 2, digest: '1'.repeat(32) };
    expect(compare(figures(), after)).toEqual([`${table} differs: 2 rows, were 2 (or the same count, changed)`]);
  });

  it('find a passkey gone, and a table missing', () => {
    const after = figures();
    after.kept.passkeys = { count: 1, digest: '1'.repeat(32) };
    delete after.kept.sessions;
    expect(compare(figures(), after)).toEqual([
      'passkeys differs: 1 rows, were 2 (or the same count, changed)',
      'sessions differs: none rows, were 2 (or the same count, changed)',
    ]);
  });

  it('find the flags, the Secrets or a volume moved', () => {
    const after = figures();
    after.flags = null;
    after.secrets = 't'.repeat(64);
    after.volumes = ['pvc-3 factory/data-postgres-0', 'pvc-2 factory/artifacts'];
    expect(compare(figures(), after)).toEqual([
      'the feature flags differ',
      'the Secrets in factory differ',
      'the volumes differ: pvc-3 factory/data-postgres-0, pvc-2 factory/artifacts, were pvc-1 factory/data-postgres-0, pvc-2 factory/artifacts',
    ]);
  });

  it('show the figures side by side, the tables not judged said so', () => {
    const shown = report(figures(), figures());
    expect(shown).toContain('last seq');
    expect(shown).toMatch(/inbox \(not judged\) +14698 +14698/);
    expect(shown).not.toMatch(/events \(not judged\)/);
    // Counts and names only: no digest is shown.
    expect(shown).not.toContain('e'.repeat(32));
  });

  it('count events only to a seq', () => {
    expect(storeQuery(12)).toContain('where seq <= 12)');
    expect(storeQuery()).toContain('where seq <= (select coalesce(max(seq), 0) from events))');
    expect(() => storeQuery(-1)).toThrow('-1 is not a seq');
    expect(() => storeQuery(1.5)).toThrow();
  });
});
