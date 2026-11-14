/**
 * The orders a Critical fix's versions are read in (ADR 0020), each by its own package manager's rules, never by the
 * look of the string: the format comes from what Trivy says of the target it scanned (its result's class and type).
 *
 * - `npm`: semver, for a lockfile's packages, a language's packages in an image that npm installed, and Node.
 * - `dpkg`: Debian's and Ubuntu's packages, as `dpkg --compare-versions` orders them (deb-version(7)).
 * - `apk`: Alpine's packages, as `apk version -t` orders them (apk-tools' version.c).
 *
 * Any other format (rpm, a Go binary's, Python's), or a version that does not parse in its format, has no order the
 * gate reads, so the fix it would prove holds, with a reason that names the format.
 */
import { compareVersions } from '../apps/runner/src/pins.ts';

export type Format = 'npm' | 'dpkg' | 'apk';

/** Trivy's types whose versions are npm's semver: a lockfile's, and packages npm put in an image. */
const NPM_TYPES = new Set(['npm', 'pnpm', 'yarn', 'node-pkg']);
const DPKG_TYPES = new Set(['debian', 'ubuntu']);
const APK_TYPES = new Set(['alpine']);

/**
 * The format of a Trivy result's versions, from its class and type: an OS's packages by its distribution, a language's
 * by its ecosystem. A format the gate does not order is named as Trivy names it, prefixed `unread:`.
 */
export function formatOf(resultClass: string | undefined, type: string | undefined): Format | `unread:${string}` {
  const t = (type ?? '').toLowerCase();
  if (resultClass === 'os-pkgs') {
    if (DPKG_TYPES.has(t)) return 'dpkg';
    if (APK_TYPES.has(t)) return 'apk';
  } else if (resultClass === 'lang-pkgs' && NPM_TYPES.has(t)) return 'npm';
  return `unread:${resultClass ?? 'no class'}/${type ?? 'no type'}`;
}

// dpkg: [epoch:]upstream_version[-debian_revision], deb-version(7).

const DPKG = /^(?:(\d+):)?([0-9][A-Za-z0-9.+~:-]*?)(?:-([A-Za-z0-9.+~]+))?$/;

/** A Debian version in its parts, or nothing when it is not one: an upstream version must begin with a digit. */
export function dpkgParts(version: string): { epoch: number; upstream: string; revision: string } | undefined {
  const m = DPKG.exec(version);
  if (!m) return undefined;
  const [, epoch, upstream = '', revision = ''] = m;
  // A colon in the upstream version only with an epoch; a hyphen in it only with a revision (the regex takes the last).
  if ((upstream.includes(':') && epoch === undefined) || (upstream.includes('-') && !revision)) return undefined;
  return { epoch: Number(epoch ?? 0), upstream, revision };
}

/** A character's weight in dpkg's order: `~` before the end, the end before letters, letters before anything else. */
const weight = (c: string | undefined): number => {
  if (c === undefined || /[0-9]/.test(c)) return 0;
  if (/[A-Za-z]/.test(c)) return c.charCodeAt(0);
  if (c === '~') return -1;
  return c.charCodeAt(0) + 256;
};
const digit = (c: string | undefined) => c !== undefined && c >= '0' && c <= '9';

/** dpkg's verrevcmp: runs of non-digits by weight, then runs of digits by value, in turn. */
function verrevcmp(a: string, b: string): number {
  let [i, j] = [0, 0];
  while (i < a.length || j < b.length) {
    while ((i < a.length && !digit(a[i])) || (j < b.length && !digit(b[j]))) {
      const d = weight(a[i]) - weight(b[j]);
      if (d) return d;
      i++;
      j++;
    }
    while (a[i] === '0') i++;
    while (b[j] === '0') j++;
    let first = 0;
    while (digit(a[i]) && digit(b[j])) {
      first ||= (a.charCodeAt(i) as number) - (b.charCodeAt(j) as number);
      i++;
      j++;
    }
    if (digit(a[i])) return 1;
    if (digit(b[j])) return -1;
    if (first) return first;
  }
  return 0;
}

/** Orders two Debian versions as dpkg does: epoch, then upstream version, then revision; nothing when one is none. */
export function compareDpkg(a: string, b: string): number | undefined {
  const [x, y] = [dpkgParts(a), dpkgParts(b)];
  if (!x || !y) return undefined;
  return Math.sign(x.epoch - y.epoch || verrevcmp(x.upstream, y.upstream) || verrevcmp(x.revision, y.revision));
}

// apk: digits{.digits}[letter]{_suffix[digits]}[-r<n>], apk-tools' version.c.

/** apk's suffixes in order: the pre-releases before the release (negative), the rest after it. */
const SUFFIXES: Readonly<Record<string, number>> = {
  alpha: -4,
  beta: -3,
  pre: -2,
  rc: -1,
  cvs: 1,
  svn: 2,
  git: 3,
  hg: 4,
  p: 5,
};
const APK = /^(\d+(?:\.\d+)*)([a-z])?((?:_(?:alpha|beta|pre|rc|cvs|svn|git|hg|p)\d*)*)(?:-r(\d+))?$/;

/** apk's token kinds, in its order: when two versions differ in kind at a token, the later kind is the lesser. */
const Kind = { Digit: 1, Letter: 2, Suffix: 3, SuffixNumber: 4, Revision: 5, End: 6 } as const;
type Kind = (typeof Kind)[keyof typeof Kind];

/**
 * An Alpine version as apk reads it, token by token, or nothing when it is not one. A component after the first with a
 * leading zero, which apk orders as a fraction, and a commit hash (`~`), are not read.
 */
export function apkTokens(version: string): { kind: Kind; value: number }[] | undefined {
  const m = APK.exec(version);
  if (!m) return undefined;
  const [, numbers = '', letter, suffixes = '', revision] = m;
  const parts = numbers.split('.');
  if (parts.some((p) => p.length > 1 && p.startsWith('0'))) return undefined;
  const tokens: { kind: Kind; value: number }[] = parts.map((p) => ({ kind: Kind.Digit, value: Number(p) }));
  if (letter) tokens.push({ kind: Kind.Letter, value: letter.charCodeAt(0) });
  for (const [, name = '', n] of suffixes.matchAll(/_([a-z]+)(\d*)/g)) {
    tokens.push({ kind: Kind.Suffix, value: SUFFIXES[name] as number });
    if (n) tokens.push({ kind: Kind.SuffixNumber, value: Number(n) });
  }
  if (revision !== undefined) tokens.push({ kind: Kind.Revision, value: Number(revision) });
  tokens.push({ kind: Kind.End, value: 0 });
  return tokens;
}

/** Orders two Alpine versions as apk does; nothing when one is none. */
export function compareApk(a: string, b: string): number | undefined {
  const [x, y] = [apkTokens(a), apkTokens(b)];
  if (!x || !y) return undefined;
  for (let i = 0; ; i++) {
    const [s, t] = [x[i], y[i]];
    if (!s || !t) return 0;
    if (s.kind === t.kind) {
      if (s.kind === Kind.End) return 0;
      if (s.value !== t.value) return Math.sign(s.value - t.value);
      continue;
    }
    // A pre-release suffix is before whatever the other has there; otherwise the later kind of token is the lesser.
    if (s.kind === Kind.Suffix && s.value < 0) return -1;
    if (t.kind === Kind.Suffix && t.value < 0) return 1;
    return s.kind > t.kind ? -1 : 1;
  }
}

/** Orders two versions in a format: nothing when the gate does not read that format, or either is not one. */
export function compareIn(format: string, a: string, b: string): number | undefined {
  if (format === 'dpkg') return compareDpkg(a, b);
  if (format === 'apk') return compareApk(a, b);
  if (format === 'npm') {
    const semver = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
    if (!semver.test(a) || !semver.test(b)) return undefined;
    return Math.sign(compareVersions(a.replace(/\+.*$/, ''), b.replace(/\+.*$/, '')));
  }
  return undefined;
}
