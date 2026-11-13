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
