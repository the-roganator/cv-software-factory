/** What the pin move's files share: its checkout's root, and the helpers each condition's code uses. */
import { join } from 'node:path';

/** The gate's own checkout, main's: what it reads its pins of Trivy, its API versions and the platform check from. */
export const ROOT = join(import.meta.dirname, '..');

/** A version as a tag or a chart writes one (`2.17.0`, `v1.37.2-k3s1`, `18.6-alpine3.24`) */
export const VERSION_WORD = /^v?\d+(\.\d+)*([-+][A-Za-z0-9.+-]*)?$/;

export const short = (text: string) => (text.length > 120 ? `${text.slice(0, 117)}…` : text);

export const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/**
 * A version's major, the one reading both conditions hold a major by (ADR 0019, 4 and 6): the digits after an optional
 * `v`, as text, so it is exact at any length, where a number past 2^53 would round to its neighbour. Undefined where
 * the version opens with no digit, or with a zero before another digit (`01.10.0`), which names no one major: each
 * holds, as no major is proved unchanged.
 */
export function majorOf(version: string): string | undefined {
  const digits = /^v?(\d+)/.exec(version)?.[1];
  return digits === undefined || /^0\d/.test(digits) ? undefined : digits;
}

/** Whether two versions are proved on one major: each has one, and it is the same. */
export function sameMajor(a: string, b: string): boolean {
  const major = majorOf(a);
  return major !== undefined && major === majorOf(b);
}

/** A version's variant, what follows its numbers (`-alpine` of `1.4.0-alpine`): its line, which a move keeps. */
export const variantOf = (version: string) => version.replace(/^v?\d+(\.\d+)*/, '');

/**
 * A version as the gate orders one: numbers after an optional `v`, a prerelease after `-`, build metadata after `+`.
 * Anything else (`1.0.0_1`, `nonroot`) has no order the gate can prove, so a move to or from it holds.
 */
const ORDERED = /^v?(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

const sign = (d: bigint) => (d > 0n ? 1 : d < 0n ? -1 : 0);

/** SemVer's order of two prereleases, an identifier at a time: numbers exactly and before words, words by ASCII. */
function prereleaseOrder(a: string, b: string): number {
  const [x, y] = [a.split('.'), b.split('.')];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const [p, q] = [x[i] as string, y[i] as string];
    const [pn, qn] = [/^\d+$/.test(p), /^\d+$/.test(q)];
    if (pn && qn && BigInt(p) !== BigInt(q)) return sign(BigInt(p) - BigInt(q));
    if (pn !== qn) return pn ? -1 : 1;
    if (p !== q) return p < q ? -1 : 1;
  }
  return Math.sign(x.length - y.length);
}

/**
 * The gate's one order of two versions, exact at any length: positive when `a` is after `b`, negative when before, 0
 * when they tie (`1.0` and `1.0.0`, or a build alone apart), and undefined where either is no version it orders. Its
 * numbers are read as `BigInt`, never `Number`, which rounds 2^53 + 1 to 2^53 and so reads a move back as a tie.
 */
export function exactOrder(a: string, b: string): number | undefined {
  const [x, y] = [ORDERED.exec(a), ORDERED.exec(b)];
  if (!x || !y) return undefined;
  const [m, n] = [(x[1] as string).split('.').map(BigInt), (y[1] as string).split('.').map(BigInt)];
  for (let i = 0; i < Math.max(m.length, n.length); i++) {
    const d = (m[i] ?? 0n) - (n[i] ?? 0n);
    if (d !== 0n) return sign(d);
  }
  const [p, q] = [x[2], y[2]];
  if (p === q) return 0;
  if (p === undefined) return 1;
  if (q === undefined) return -1;
  return prereleaseOrder(p, q);
}

/** Why a move from one version to another is not forward in the gate's order, or undefined when it is. */
export function notForward(from: string, to: string): 'a move backwards' | 'no move forward' | undefined {
  const order = exactOrder(to, from);
  return order === 1 ? undefined : order === -1 ? 'a move backwards' : 'no move forward';
}
