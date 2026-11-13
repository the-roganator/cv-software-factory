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
