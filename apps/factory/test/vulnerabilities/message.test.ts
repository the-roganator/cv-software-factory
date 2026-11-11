import { describe, expect, it } from 'vitest';
import { type Finding, messageOf, readMessage } from '../../src/vulnerabilities/sarif.ts';

const finding: Finding = {
  item: 'ghcr.io/example/base',
  label: `ghcr.io/example/base:1.2.0 (sha256:${'2'.repeat(64)})`,
  file: 'Dockerfile',
  line: 3,
  type: 'debian',
  package: 'libexample',
  installed: '3.0.1, 3.0.2',
  fixed: '3.0.3',
  advisory: 'CVE-2099-0001',
  severity: 'HIGH',
};

describe('a result’s message, read back', () => {
  it('is what messageOf wrote, with no fix, a fix, and a fix and its move', () => {
    const fix = { target: { kind: 'version' as const, versions: ['3.0.3'] }, day: Date.parse('2026-11-01T06:00:00Z') };
    const move = { index: 4, run: '42000000001' };
    for (const each of [
      { ...finding, fixed: undefined },
      { ...finding, fix },
      { ...finding, fix, move },
    ]) {
      expect(readMessage(messageOf(each), each.advisory)).toEqual({
        package: each.package,
        installed: each.installed,
        label: each.label,
        advisory: each.advisory,
        severity: each.severity,
        fixed: each.fixed,
        fix: each.fix,
        move: each.move,
      });
    }
  });

  it('is nothing for any other text', () => {
    const fix = { target: { kind: 'version' as const, versions: ['3.0.3'] }, day: Date.parse('2026-11-01T06:00:00Z') };
    const text = messageOf({ ...finding, fix, move: { index: 1, run: '7' } });
    expect(readMessage(text, 'CVE-2099-0002')).toBeUndefined();
    expect(readMessage(`${text} More.`, finding.advisory)).toBeUndefined();
    expect(readMessage(text.replace('(high)', '(severe)'), finding.advisory)).toBeUndefined();
    expect(
      readMessage(text.replace(' Fixed by version 3.0.3,', ' Fixed by something,'), finding.advisory),
    ).toBeUndefined();
    // A move with no fix before it is never written.
    expect(readMessage(`${messageOf(finding)} Move 1 of run 7.`, finding.advisory)).toBeUndefined();
    expect(readMessage('', finding.advisory)).toBeUndefined();
  });
});
