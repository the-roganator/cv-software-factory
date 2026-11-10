import { describe, expect, it } from 'vitest';
import { type Fix, fixText, readFix, type Target } from '../../src/vulnerabilities/fixes.ts';
import { type Finding, messageOf } from '../../src/vulnerabilities/sarif.ts';

/** The grammar a result's message ends with (fixes.ts), which the scan writes and the GitHub worker reads. */
const DAY = Date.parse('2026-11-10T19:19:04Z');

const TARGETS: [string, Target, string][] = [
  ['a version', { kind: 'version', versions: ['1.0.1'] }, 'version 1.0.1'],
  ['a version for each copy', { kind: 'version', versions: ['1.0.1', '2.0.3'] }, 'versions 1.0.1 and 2.0.3'],
  [
    "an image's tag with its index digest",
    { kind: 'image', tag: '24.23.0-trixie-slim', digest: `sha256:${'a'.repeat(64)}` },
    `image 24.23.0-trixie-slim@sha256:${'a'.repeat(64)}`,
  ],
  ['a chart', { kind: 'chart', chart: 'grafana', version: '13.7.0', major: false }, 'chart grafana 13.7.0'],
  ['a major', { kind: 'chart', chart: 'grafana', version: '14.3.1', major: true }, 'chart grafana 14.3.1 (a major)'],
  ['a k3s release', { kind: 'k3s', release: 'v1.37.2+k3s1' }, 'k3s v1.37.2+k3s1'],
  ["a tool's release", { kind: 'tool', tool: 'pnpm', version: '12.17.0' }, 'tool pnpm 12.17.0'],
  [
    'a line no longer built',
    { kind: 'unbuilt', built: Date.parse('2025-10-16T08:00:00Z') },
    'another line (this one last built 2025-10-16T08:00:00Z)',
  ],
];

describe('what fixes a finding, as its message ends', () => {
  it.each(TARGETS)('writes and reads back %s', (_name, target, text) => {
    const fix: Fix = { target, day: DAY };
    const written = fixText(fix);
    expect(written).toBe(`Fixed by ${text}, first seen 2026-11-10T19:19:04Z.`);
    expect(readFix(written)).toEqual(fix);
  });

  it('reads it from the end of a whole message, as code scanning keeps it', () => {
    const finding: Finding = {
      item: 'lockfile pnpm-lock.yaml',
      label: 'pnpm-lock.yaml',
      file: 'pnpm-lock.yaml',
      line: 120,
      type: 'pnpm',
      package: 'example-a',
      installed: '1.0.0, 2.0.0',
      fixed: '1.0.1, 2.0.3',
      advisory: 'CVE-2099-20001',
      severity: 'HIGH',
      fix: { target: { kind: 'version', versions: ['1.0.1', '2.0.3'] }, day: DAY },
    };
    const message = messageOf(finding);
    expect(message).toBe(
      'example-a 1.0.0, 2.0.0 in pnpm-lock.yaml: CVE-2099-20001 (high), fixed in 1.0.1, 2.0.3. Fixed by versions 1.0.1 and 2.0.3, first seen 2026-11-10T19:19:04Z.',
    );
    expect(readFix(message)).toEqual(finding.fix);
    // A message the scan wrote before it named fixes, or for a finding with none, states none.
    expect(readFix(messageOf({ ...finding, fix: undefined }))).toBeUndefined();
  });

  it('keeps the day to the second, so the clock it starts reads the same on every run', () => {
    const fix: Fix = { target: { kind: 'k3s', release: 'v1.37.2+k3s1' }, day: DAY + 999 };
    expect(readFix(fixText(fix))?.day).toBe(DAY);
  });

  it('refuses an ending it does not read, rather than read it as no fix', () => {
    for (const text of [
      'Fixed by version 1.0.1, first seen yesterday.',
      'Fixed by image 2.14.3@sha256:abc, first seen 2026-11-10T19:19:04Z.',
      'Fixed by chart grafana 14.3.1 (a minor), first seen 2026-11-10T19:19:04Z.',
      'Fixed by whatever, first seen 2026-11-10T19:19:04Z.',
    ])
      expect(() =>
        readFix(`example-a 1.0.0 in pnpm-lock.yaml: CVE-2099-20001 (high), fixed in 1.0.1. ${text}`),
      ).toThrow();
  });

  it('writes nothing it could not read back', () => {
    expect(() => fixText({ target: { kind: 'version', versions: ['1.0.1, or so'] }, day: DAY })).toThrow();
    expect(() => fixText({ target: { kind: 'image', tag: '2.14.3', digest: 'sha256:short' }, day: DAY })).toThrow();
    expect(() => fixText({ target: { kind: 'version', versions: [] }, day: DAY })).toThrow();
    expect(() => fixText({ target: { kind: 'k3s', release: 'v1.37.2+k3s1' }, day: Number.NaN })).toThrow();
  });
});
