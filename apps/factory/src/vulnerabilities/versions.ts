/**
 * Versions, read by one rule wherever the factory orders two of them: the scan's deadlines and moves, the pin step and
 * the line.
 *
 * A version is an optional `v`, then numbers joined by dots, any count of them (`1.2`, `1.2.3`, `1.2.3.4`), a missing
 * one read as zero; then, as semver has them, a pre-release after a hyphen, which sorts before its release, and a
 * build after a plus, which orders nothing. A number is compared as its digits, by their count and then their text, so
 * one past 2^53 is as exact as any other.
 *
 * An image's tag is not semver: what follows its numbers is a variant (`24.21.0-alpine3.24`, `v1.65.1-noble`) or a
 * build that does order its releases (k3s's `v1.37.2+k3s2` is after `v1.37.2+k3s1`), never a pre-release. So there are
 * two orders, each named for what it reads: `compareVersions` for a package's, a chart's, a tool's and Node's
 * versions, and `compareTags` for an image's tags and k3s's releases.
 *
 * Node runs this with no dependencies, from a sparse checkout of this repository, and in the runner's image.
 */

/** A run of digits with no zeros before it: `007` is `7`, and `0` stays. */
const plain = (digits: string) => digits.replace(/^0+(?=\d)/, '');

/** Two runs of digits as the numbers they write: the longer is the greater, and of one length their text orders them. */
function compareDigits(a: string, b: string) {
  const x = plain(a);
  const y = plain(b);
  if (x.length !== y.length) return x.length < y.length ? -1 : 1;
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Each list's numbers in turn, a missing one read as zero. */
function compareNumbers(a: string[], b: string[]) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = compareDigits(a[i] ?? '0', b[i] ?? '0');
    if (d) return d;
  }
  return 0;
}

/** A version's release and its pre-release: the `v` and the build left off, and the rest split at its first hyphen. */
function parts(version: string) {
  const [core = ''] = version.trim().replace(/^v/, '').split('+');
  const dash = core.indexOf('-');
  return dash < 0 ? { release: core, pre: undefined } : { release: core.slice(0, dash), pre: core.slice(dash + 1) };
}

/**
 * A version's numbers, each as its digits with no zeros before them: `v1.02.3-rc.1` is `1`, `2`, `3`. A part that
 * starts with no digit is zero.
 */
export function numbersOf(version: string): string[] {
  return parts(version)
    .release.split('.')
    .map((part) => plain(/^\d+/.exec(part)?.[0] ?? '0'));
}

/**
 * A version's major, the one reading of it: its first number, as digits (`v2.1.0` is `2`), or undefined for a version
 * that starts with none (`latest`).
 */
export function majorOf(version: string): string | undefined {
  const first = /^\d+/.exec(version.trim().replace(/^v/, ''))?.[0];
  return first === undefined ? undefined : plain(first);
}

/**
 * Two versions as semver orders them, with any count of numbers: by each number in turn; then a pre-release before its
 * release, its identifiers compared one by one, a number's as a number and before any word, and the shorter of two
 * that agree first. A build orders nothing. Negative, zero or positive, as a sort reads it.
 */
export function compareVersions(a: string, b: string): number {
  const x = parts(a);
  const y = parts(b);
  const d = compareNumbers(numbersOf(a), numbersOf(b));
  if (d) return d;
  if (x.pre === y.pre) return 0;
  if (x.pre === undefined) return 1;
  if (y.pre === undefined) return -1;
  const xs = x.pre.split('.');
  const ys = y.pre.split('.');
  for (let i = 0; i < Math.max(xs.length, ys.length); i++) {
    const p = xs[i];
    const q = ys[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const [pn, qn] = [/^\d+$/.test(p), /^\d+$/.test(q)];
    if (pn && qn) {
      const n = compareDigits(p, q);
      if (n) return n;
      continue;
    }
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

/**
 * Two tags of an image, or two of k3s's releases: by the numbers each starts with, after an optional `v`; then by what
 * follows them, its runs of digits as numbers and the text between as text, so `v1.37.2+k3s2` is after
 * `v1.37.2+k3s1` and before `v1.37.2+k3s10`. Nothing sorts before the bare numbers: a tag's ending is a variant or a
 * build, not a pre-release, which is why a tag is not given to `compareVersions`.
 */
export function compareTags(a: string, b: string): number {
  const split = (tag: string) => {
    const text = tag.trim().replace(/^v(?=\d)/, '');
    const head = /^\d+(\.\d+)*/.exec(text)?.[0] ?? '';
    return { numbers: head ? head.split('.') : [], rest: text.slice(head.length).match(/\d+|\D+/g) ?? [] };
  };
  const x = split(a);
  const y = split(b);
  const d = compareNumbers(x.numbers, y.numbers);
  if (d) return d;
  for (let i = 0; i < Math.max(x.rest.length, y.rest.length); i++) {
    const p = x.rest[i];
    const q = y.rest[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const n = /^\d/.test(p) && /^\d/.test(q) ? compareDigits(p, q) : p < q ? -1 : p > q ? 1 : 0;
    if (n) return n;
  }
  return 0;
}
