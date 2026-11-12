import { describe, expect, it } from 'vitest';
import { differences, recordOf, retake } from './api-versions.ts';

describe("the record of Argo CD's API versions", () => {
  const cluster = (apiVersions: unknown, status = 'Successful') => ({
    info: { connectionState: { status }, apiVersions },
  });

  it("reads Argo CD's own list, sorted and each once", () => {
    expect(recordOf(cluster(['v1/Pod', 'apps/v1', 'v1', 'v1']))).toEqual({ apiVersions: ['apps/v1', 'v1', 'v1/Pod'] });
  });

  it('takes nothing from a cluster Argo CD has not read, or a list it cannot', () => {
    expect(recordOf(cluster(['v1'], 'Unknown'))).toMatch(/not connected/);
    expect(recordOf(cluster([]))).toMatch(/no API versions/);
    expect(recordOf(cluster(['v1', 'a b']))).toMatch(/cannot read/);
    expect(recordOf(null)).toMatch(/not connected/);
  });

  it('names each API version only one side has, and the command that retakes it', () => {
    expect(differences({ apiVersions: ['v1', 'apps/v1'] }, { apiVersions: ['v1', 'x.io/v1'] })).toEqual([
      '+ x.io/v1',
      '- apps/v1',
    ]);
    expect(differences({ apiVersions: ['v1'] }, { apiVersions: ['v1'] })).toEqual([]);
    expect(retake('42', 'o/r')).toBe(
      'gh run download 42 -R o/r -n refusal-records -D /tmp/records && cp /tmp/records/api-versions.json deploy/k3d/api-versions.json',
    );
  });
});
