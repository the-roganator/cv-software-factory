/**
 * Node's own vulnerabilities, which Trivy cannot see: it reads no Node runtime from an image, nor from Syft's SBOM, which
 * names Node as `pkg:generic/node`. The scan reads each image's Node version itself and matches it against Node's core
 * vulnerability database, nodejs/security-wg's `vuln/core/index.json`, which gives each entry its CVEs, a `vulnerable`
 * and a `patched` semver range, a reference, and the publisher's `severity`.
 *
 * The database is fetched on each run from that repository's default branch, with retries, and a run that cannot fetch
 * it fails and uploads nothing, as with Trivy's. Node runs this with no dependencies, so the ranges are read here: the
 * forms the database writes (`24.x`, `24.22.x`, `^24.22.1`, `>=6.0.0 <6.2.0`, `4.4.2`), joined by `||`.
 */
import type { Severity } from './sarif.ts';
import { compareVersions, numbersOf } from './versions.ts';

export const NODE_DATABASE = 'https://raw.githubusercontent.com/nodejs/security-wg/main/vuln/core/index.json';

export interface CoreEntry {
  cve?: string[];
  vulnerable?: string;
  patched?: string;
  ref?: string;
  description?: string;
  overview?: string;
  severity?: string;
}

/** An advisory of Node's that a version has: one per CVE, or the entry's own id where it names none. */
interface NodeAdvisory {
  advisory: string;
  severity: Severity;
  title?: string | undefined;
  description?: string | undefined;
  url?: string | undefined;
  patched?: string | undefined;
}

/** A release's three numbers, each as its digits (versions.ts), so none is rounded. */
type Version = [string, string, string];

const parse = (text: string): Version | undefined =>
  /^v?\d+\.\d+\.\d+$/.test(text.trim()) ? (numbersOf(text) as Version) : undefined;

const compare = (a: Version, b: Version) => compareVersions(a.join('.'), b.join('.'));

/** The number after one, whatever its size. */
const next = (digits: string) => String(BigInt(digits) + 1n);

/** One comparator: true when the version meets it; a form not read here throws, so a run never misreads a range. */
function meets(version: Version, comparator: string): boolean {
  if (comparator === '*' || comparator === 'x') return true;
  const op = /^(>=|<=|>|<|\^|~|=)?(.*)$/.exec(comparator);
  const operator = op?.[1] ?? '';
  const rest = op?.[2] ?? '';
  const parts = rest.split('.');
  if (parts.length < 1 || parts.length > 3 || !/^\d+$/.test(parts[0] ?? ''))
    throw new Error(`a range not read: ${comparator}`);
  const wild = parts.length < 3 || parts.some((part) => part === 'x' || part === '*');
  if (wild) {
    // A partial version, as semver reads one: `24` and `24.x` are 24.0.0 up to 25.0.0, not including it.
    const fixed = parts.filter((part) => /^\d+$/.test(part)).flatMap(numbersOf);
    if (parts.slice(0, fixed.length).some((part) => !/^\d+$/.test(part)))
      throw new Error(`a range not read: ${comparator}`);
    const low: Version = [fixed[0] ?? '0', fixed[1] ?? '0', '0'];
    const high: Version = fixed.length === 1 ? [next(low[0]), '0', '0'] : [low[0], next(low[1]), '0'];
    const inside = compare(version, low) >= 0 && compare(version, high) < 0;
    // A caret keeps the major (`^24.22` is 24.22.0 up to 25.0.0); a tilde, the minor where one is given.
    const major: Version = [next(low[0]), '0', '0'];
    switch (operator) {
      case '':
      case '=':
        return inside;
      case '^':
        return compare(version, low) >= 0 && compare(version, low[0] === '0' && fixed.length > 1 ? high : major) < 0;
      case '~':
        return inside;
      case '>=':
        return compare(version, low) >= 0;
      case '>':
        return compare(version, high) >= 0;
      case '<':
        return compare(version, low) < 0;
      case '<=':
        return compare(version, high) < 0;
      default:
        throw new Error(`a range not read: ${comparator}`);
    }
  }
  const bound = parse(rest);
  if (!bound) throw new Error(`a range not read: ${comparator}`);
  const order = compare(version, bound);
  switch (operator) {
    case '>=':
      return order >= 0;
    case '>':
      return order > 0;
    case '<=':
      return order <= 0;
    case '<':
      return order < 0;
    case '^':
      // The leftmost part that is not zero is kept: ^1.2.3 to 2.0.0, ^0.2.3 to 0.3.0, ^0.0.3 to 0.0.4.
      return (
        order >= 0 &&
        version[0] === bound[0] &&
        (bound[0] !== '0' || (version[1] === bound[1] && (bound[1] !== '0' || version[2] === bound[2])))
      );
    case '~':
      return order >= 0 && version[0] === bound[0] && version[1] === bound[1];
    default:
      return order === 0;
  }
}

/** Whether a version is in a range: sets joined by `||`, each of comparators that must all hold. */
export function satisfies(version: string, range: string) {
  const v = parse(version);
  if (!v) throw new Error(`not a version: ${version}`);
  return range.split('||').some((set) => {
    // `>= 6.0.0` is one comparator, written with a space.
    const comparators = set
      .trim()
      .replace(/([<>]=?|=|\^|~)\s+/g, '$1')
      .split(/\s+/)
      .filter(Boolean);
    return comparators.length > 0 && comparators.every((comparator) => meets(v, comparator));
  });
}

const SEVERITY: Record<string, Severity> = { critical: 'CRITICAL', high: 'HIGH', medium: 'MEDIUM', low: 'LOW' };

/** The database's entries, from its JSON, or a throw when it is not the database. */
export function entries(json: string): [string, CoreEntry][] {
  const parsed = JSON.parse(json) as Record<string, CoreEntry>;
  const all = Object.entries(parsed ?? {});
  if (!all.length || !all.every(([, entry]) => typeof entry === 'object' && entry !== null))
    throw new Error("not Node's core vulnerability database");
  return all;
}

/**
 * Throws unless every comparator of every range in the database is one this module reads, so a range it cannot read
 * refuses the database when it is fetched, rather than stopping the scan partway.
 */
export function readable(database: [string, CoreEntry][]) {
  const probe: Version = ['0', '0', '0'];
  for (const [id, entry] of database)
    for (const range of [entry.vulnerable, entry.patched]) {
      if (range === undefined) continue;
      for (const set of range.split('||'))
        for (const comparator of set
          .trim()
          .replace(/([<>]=?|=|\^|~)\s+/g, '$1')
          .split(/\s+/)
          .filter(Boolean)) {
          try {
            meets(probe, comparator);
          } catch (error) {
            throw new Error(`entry ${id}: ${(error as Error).message}`);
          }
        }
    }
}

/** Each of Node's advisories a version has: in an entry's `vulnerable` range and not its `patched` one. */
export function advisoriesFor(version: string, database: [string, CoreEntry][]): NodeAdvisory[] {
  return database.flatMap(([id, entry]) => {
    if (!entry.vulnerable || !satisfies(version, entry.vulnerable)) return [];
    if (entry.patched && satisfies(version, entry.patched)) return [];
    const ids = entry.cve?.length ? entry.cve : [`NSWG-CORE-${id}`];
    return ids.map((advisory) => ({
      advisory,
      severity: SEVERITY[entry.severity ?? ''] ?? 'UNKNOWN',
      title: entry.description,
      description: entry.overview,
      url: entry.ref,
      patched: entry.patched,
    }));
  });
}

interface SpdxPackage {
  name?: string;
  versionInfo?: string;
  externalRefs?: { referenceType?: string; referenceLocator?: string }[];
}

/** The Node version an SPDX SBOM gives: Syft's `pkg:generic/node@<version>`, the binary it found. */
export function nodeInSbom(predicate: unknown): string | undefined {
  const packages = ((predicate ?? {}) as { packages?: SpdxPackage[] }).packages ?? [];
  for (const pkg of packages) {
    for (const ref of pkg.externalRefs ?? []) {
      const version = /^pkg:generic\/node@(\d+\.\d+\.\d+)(?:[?#].*)?$/.exec(ref.referenceLocator ?? '')?.[1];
      if (version) return version;
    }
  }
  return undefined;
}

/**
 * The Node version an operating system's package gives, where an image installs Node that way (Playwright's, from
 * NodeSource's `nodejs`): the release its version begins with.
 */
export function nodeInPackages(
  results: { Class?: string; Packages?: { Name?: string; Version?: string }[] | null }[] | null | undefined,
): string | undefined {
  for (const result of results ?? []) {
    if (result.Class !== 'os-pkgs') continue;
    for (const pkg of result.Packages ?? []) {
      const version = pkg.Name === 'nodejs' ? /^(?:\d+:)?(\d+\.\d+\.\d+)/.exec(pkg.Version ?? '')?.[1] : undefined;
      if (version) return version;
    }
  }
  return undefined;
}

/** The Node version an image's configuration names, as Node's official images set `NODE_VERSION`. */
export function nodeInConfig(config: { config?: { Env?: string[] | null } } | undefined): string | undefined {
  for (const variable of config?.config?.Env ?? []) {
    const version = /^NODE_VERSION=v?(\d+\.\d+\.\d+)$/.exec(variable)?.[1];
    if (version) return version;
  }
  return undefined;
}
