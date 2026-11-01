/**
 * Proves `ci:scope-fence` (policy/guardrails.ts, spec 6 guardrail 11), with the fence's and the line's tests beside it:
 * the coder's patch is fenced to its scope and to the protected paths it was given. Martin's (CODEOWNERS), as every
 * file here is: a change to what they assert is a change to the proof.
 */
import { describe, expect, it } from 'vitest';
import { type CoderInput, fenceFor } from '../../src/line/agents/coder.ts';
import { FIXTURES } from '../../src/line/bench/fixtures.ts';

const input: CoderInput =
  FIXTURES.coder['wrong-price']?.input ??
  (() => {
    throw new Error('The coder has no wrong-price fixture.');
  })();

describe('the coder', () => {
  it('fences its patch to the scope and to the protected paths it was given', () => {
    const patch = (path: string) =>
      `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`;
    expect(fenceFor(patch('src/money.ts'), input).ok).toBe(true);
    const owned = fenceFor(patch('src/money.ts'), { ...input, protectedPaths: ['src/money.ts'] });
    expect(owned).toMatchObject({ ok: false, outside: ['src/money.ts'] });
  });
});
