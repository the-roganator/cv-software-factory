import { describe, expect, it } from 'vitest';
import { countBySeverity, countsNote, countsOfCheck, parseCounts, scanOfCheck } from '../../src/gates/counts.ts';

const before = { critical: 1, high: 2, medium: 5, low: 11, unknown: 0 };
const after = { critical: 0, high: 0, medium: 3, low: 9, unknown: 1 };

describe('a scan’s counts, as its notice gives them', () => {
  it('reads back exactly what it wrote, for each scan', () => {
    for (const scan of ['lockfile scan', 'image scan'] as const) {
      const note = countsNote(scan, { before, after });
      expect(parseCounts(note)).toEqual({ scan, counts: { before, after } });
    }
    expect(countsNote('image scan', { before, after })).toBe(
      'Image scan counted, before: critical 1, high 2, medium 5, low 11, unknown 0; after: critical 0, high 0, medium 3, low 9, unknown 1',
    );
  });

  it('is no counts, never zero, when it does not fit the grammar exactly', () => {
    const note = countsNote('lockfile scan', { before, after });
    for (const bad of [
      '',
      'Lockfile scan counted',
      note.replace('high 2', 'high two'),
      note.replace('high 2', 'high -2'),
      note.replace('high 2', 'high 02'),
      note.replace('high 2', 'high 2.0'),
      note.replace('high 2', 'high 1234567'),
      note.replace(', unknown 1', ''),
      note.replace('critical 1, high 2', 'high 2, critical 1'),
      `${note} `,
      ` ${note}`,
      `${note}\nlodash CVE-2021-23337`,
      note.replace('Lockfile scan', 'Lockfile Scan'),
      note.replace('Lockfile scan', 'Dependency review'),
    ])
      expect(parseCounts(bad), bad).toBeUndefined();
  });

  it('counts each of Trivy’s ratings, and any other as unrated', () => {
    expect(countBySeverity(['CRITICAL', 'HIGH', 'HIGH', 'MEDIUM', 'LOW', 'UNKNOWN', 'NEGLIGIBLE', ''])).toEqual({
      critical: 1,
      high: 2,
      medium: 1,
      low: 1,
      unknown: 3,
    });
  });

  it('knows a scan by its job’s name, called from the app or not, and nothing else', () => {
    expect(scanOfCheck('lockfile scan')).toBe('lockfile scan');
    expect(scanOfCheck('gates / image scan')).toBe('image scan');
    for (const name of ['vulnerabilities / scan', 'image scans', 'gates / image scan (base)', 'Image scan'])
      expect(scanOfCheck(name), name).toBeUndefined();
  });

  it('takes a run’s counts from its own scan’s notice alone, and none when they disagree or one does not parse', () => {
    const lockfile = countsNote('lockfile scan', { before, after });
    const image = countsNote('image scan', { before, after });
    const other = 'Node 20 is deprecated';
    expect(countsOfCheck('gates / lockfile scan', [other, lockfile])).toEqual({ before, after });
    expect(countsOfCheck('gates / lockfile scan', [lockfile, lockfile])).toEqual({ before, after });
    // Another scan's notice on this run is not this scan's counts.
    expect(countsOfCheck('gates / lockfile scan', [image])).toBeUndefined();
    expect(countsOfCheck('gates / image scan', [lockfile, image])).toEqual({ before, after });
    expect(countsOfCheck('gates / tests', [lockfile])).toBeUndefined();
    expect(countsOfCheck('gates / lockfile scan', [other])).toBeUndefined();
    expect(countsOfCheck('gates / lockfile scan', [])).toBeUndefined();
    const fewer = countsNote('lockfile scan', { before, after: { ...after, low: 8 } });
    expect(countsOfCheck('gates / lockfile scan', [lockfile, fewer])).toBeUndefined();
    expect(countsOfCheck('gates / lockfile scan', [lockfile, lockfile.replace('low 9', 'low nine')])).toBeUndefined();
  });
});
