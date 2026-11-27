import { describe, expect, it } from 'vitest';
import { compareTags, compareVersions, isPrerelease, majorOf, numbersOf } from '../../src/vulnerabilities/versions.ts';

/**
 * Versions read by one rule (versions.ts): what the scan, the pin step and the line each order two versions by.
 */
describe('a version', () => {
  it('is ordered by its numbers, with or without a v, however many it has', () => {
    expect(compareVersions('v1.9.0', '2.0.0')).toBe(-1);
    expect(compareVersions('v3.0.0', '2.0.0')).toBe(1);
    expect(compareVersions('1.14.7', '1.14.5')).toBe(1);
    expect(compareVersions('1.14.5', 'v1.14.5')).toBe(0);
    expect(compareVersions('1.2.3.4', '1.2.3.5')).toBe(-1);
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
    expect(compareVersions('1.10.0', '1.9.0')).toBe(1);
  });

  it('is exact past 2^53, where a number would round two versions into one', () => {
    expect(Number('9007199254740993')).toBe(Number('9007199254740992'));
    expect(compareVersions('1.9007199254740993.0', '1.9007199254740992.0')).toBe(1);
    expect(compareVersions('9007199254740992.0.0', '9007199254740993.0.0')).toBe(-1);
    expect(compareVersions('1.0.0-rc.9007199254740993', '1.0.0-rc.9007199254740992')).toBe(1);
    expect(compareVersions('1.007.0', '1.7.0')).toBe(0);
    expect(majorOf('9007199254740993.1.0')).toBe('9007199254740993');
  });

  it('puts a pre-release before its release, its identifiers compared as semver does', () => {
    expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBe(-1);
    expect(compareVersions('2.0.0-rc.9', '2.0.0-rc.10')).toBe(-1);
    expect(compareVersions('1.0.0-beta.2', '1.0.0-beta.10')).toBe(-1);
    expect(compareVersions('2.0.0-rc.1', '2.0.0-beta.2')).toBe(1);
    expect(compareVersions('1.0.0-rc-1', '1.0.0-rc-2')).toBe(-1);
    expect(compareVersions('1.0.0-alpha', '1.0.0-alpha.1')).toBe(-1);
    // A number before any word.
    expect(compareVersions('1.0.0-1', '1.0.0-alpha')).toBe(-1);
    expect(compareVersions('1.0.0-rc.1', '1.0.0-rc.1')).toBe(0);
  });

  it('is not ordered by its build', () => {
    expect(compareVersions('1.0.0+build.2', '1.0.0+build.10')).toBe(0);
    expect(compareVersions('1.0.0-rc.1+b', '1.0.0+a-1')).toBe(-1);
  });

  it('sorts a list the same whatever order it came in', () => {
    const versions = ['2.0.0', '1.0.0-rc.10', 'v1.0.0', '1.0.0-rc.9', '0.9.12', '1.0.0-alpha'];
    const sorted = ['0.9.12', '1.0.0-alpha', '1.0.0-rc.9', '1.0.0-rc.10', 'v1.0.0', '2.0.0'];
    expect([...versions].sort(compareVersions)).toEqual(sorted);
    expect([...versions].reverse().sort(compareVersions)).toEqual(sorted);
  });

  it('has one reading of its major, and of its numbers', () => {
    expect(majorOf('v1.2.3')).toBe('1');
    expect(majorOf('14.3.1')).toBe('14');
    expect(majorOf('02.1.0')).toBe('2');
    expect(majorOf('0.18.4')).toBe('0');
    expect(majorOf('latest')).toBeUndefined();
    expect(numbersOf('v1.02.3-rc.1+build')).toEqual(['1', '2', '3']);
    expect(numbersOf('0.18')).toEqual(['0', '18']);
  });
});

describe('a tag', () => {
  it('is ordered by its numbers, then by what follows them, a run of digits as a number', () => {
    expect(compareTags('24.21.0-alpine3.24', '24.22.1-alpine3.24')).toBe(-1);
    expect(compareTags('v1.65.1-noble', 'v1.64.9-noble')).toBe(1);
    expect(compareTags('v1.9.0', '2.0.0')).toBe(-1);
    expect(compareTags('3.21', '3.9')).toBe(1);
    expect(compareTags('24.22.1-trixie-slim', '24.22.1-trixie-slim')).toBe(0);
  });

  it('is ordered by k3s’s build, which a version’s build never is', () => {
    expect(compareTags('v1.37.2+k3s2', 'v1.37.2+k3s1')).toBe(1);
    expect(compareTags('v1.37.2-k3s10', 'v1.37.2-k3s9')).toBe(1);
    expect(compareTags('v1.37.3+k3s1', 'v1.37.2+k3s2')).toBe(1);
    expect(compareVersions('v1.37.2+k3s2', 'v1.37.2+k3s1')).toBe(0);
  });

  it('has no pre-release: nothing sorts before the bare numbers', () => {
    expect(compareTags('24.22.1', '24.22.1-alpine3.24')).toBe(-1);
    expect(compareVersions('24.22.1', '24.22.1-alpine3.24')).toBe(1);
  });
});

describe('a pre-release', () => {
  it('is a version with a hyphen after its numbers, and never one with a build alone', () => {
    expect(isPrerelease('1.5.0-rc.1')).toBe(true);
    expect(isPrerelease('v2.0.0-beta')).toBe(true);
    expect(isPrerelease('1.5.0')).toBe(false);
    expect(isPrerelease('1.5.0+build-7')).toBe(false);
  });
});
