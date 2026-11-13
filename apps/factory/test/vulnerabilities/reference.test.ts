import { describe, expect, it } from 'vitest';
import {
  DIGEST,
  DIGEST_PATTERN,
  hasRegistry,
  parseReference,
  repositoryOf,
  splitReference,
} from '../../src/vulnerabilities/reference.ts';

const digest = `sha256:${'a'.repeat(64)}`;

describe('an image reference', () => {
  it('is split into its name, repository, tag and digest, as written', () => {
    expect(splitReference(`ghcr.io/aquasecurity/trivy:0.69.3@${digest}`)).toEqual({
      name: 'ghcr.io/aquasecurity/trivy:0.69.3',
      repository: 'ghcr.io/aquasecurity/trivy',
      tag: '0.69.3',
      digest,
    });
    expect(splitReference('postgres')).toEqual({ name: 'postgres', repository: 'postgres' });
    expect(splitReference(`postgres@${digest}`)).toEqual({ name: 'postgres', repository: 'postgres', digest });
  });

  it("reads a colon before the last slash as a registry's port, not a tag", () => {
    expect(splitReference('localhost:5000/app')).toEqual({
      name: 'localhost:5000/app',
      repository: 'localhost:5000/app',
    });
    expect(repositoryOf(`localhost:5000/app:1@${digest}`)).toBe('localhost:5000/app');
  });

  it('splits at the first `@`, leaving anything after a second in the digest, which DIGEST refuses', () => {
    const { name, digest: rest } = splitReference(`app:1@${digest}@x`);
    expect([name, rest]).toEqual(['app:1', `${digest}@x`]);
    expect(DIGEST.test(rest ?? '')).toBe(false);
  });

  it('names a registry only by a first part with a dot, a port, or localhost, followed by more', () => {
    expect(['ghcr.io/a', 'localhost:5000/a', 'localhost/a'].map(hasRegistry)).toEqual([true, true, true]);
    expect(['postgres', 'rancher/coredns', 'ghcr.io'].map(hasRegistry)).toEqual([false, false, false]);
  });

  it('is read as Docker reads one, Docker Hub named', () => {
    expect(parseReference('index.docker.io/rancher/k3s:v1')).toEqual({
      repository: 'docker.io/rancher/k3s',
      tag: 'v1',
    });
    expect(parseReference('Postgres')).toEqual({ repository: 'docker.io/library/postgres' });
  });
});

describe('a digest', () => {
  it('is SHA-256 in lowercase hex, 64 digits, alone', () => {
    expect(DIGEST.test(digest)).toBe(true);
    expect([`${digest}0`, digest.toUpperCase(), digest.slice(0, -1), ` ${digest}`].some((d) => DIGEST.test(d))).toBe(
      false,
    );
    expect(new RegExp(`@(${DIGEST_PATTERN})`).exec(`x@${digest}`)?.[1]).toBe(digest);
  });
});
