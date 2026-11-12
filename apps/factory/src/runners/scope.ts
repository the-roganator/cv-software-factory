/**
 * The scope fence: a runner's patch may change only the files its spec's scope names. The line checks every patch
 * before the GitHub worker sees it, so a patch outside its scope never reaches GitHub. It is deterministic, and the
 * agent's own words have no part in it.
 *
 * A scope entry is a file (`src/money.ts`), a folder ending in `/` (`test/`), or a pattern with `*` (one path
 * segment) or `**` (any number). Whatever the scope says, a patch may never change the workflows, the deployment, a
 * path the repository's CODEOWNERS gives a person, a lockfile, or pnpm's settings: the pin step writes the lockfile
 * after a patch that changes a manifest (`apps/runner/src/pins.ts`), and an agent never does.
 *
 * Its output is what a reader of a refusal needs to judge it: the scope, then each file the patch changes, allowed or
 * refused, with the lines it adds and removes.
 */
import { filesIn } from '../github/patches.ts';
import { inScope, LOCKFILES, NEVER, ownedPaths, PNPM_SETTINGS } from '../github/paths.ts';

export { NEVER, ownedPaths };

export interface Fenced {
  ok: boolean;
  /** Every path the patch changes. */
  paths: string[];
  /** Those outside the scope, or always out of bounds. */
  outside: string[];
  /** Its verdict on each file, with the lines the patch adds and removes there: what its output prints. */
  files: { path: string; added: number; removed: number; allowed: boolean }[];
  /** What the fence prints: the scope, then each file it allowed or refused, with its lines, at most `OUTPUT_CHARS`. */
  output: string;
}

/** The most the output holds, as `action.refused` takes it. */
const OUTPUT_CHARS = 4000;

/**
 * The fence's verdict on a patch. `owned` are the paths the repository's CODEOWNERS gives a person at the patch's
 * commit, beside the workflows and the deployment, which are refused whatever it says.
 */
export function fence(patch: string, scope: readonly string[], owned: readonly string[] = []): Fenced {
  const forbidden = [...NEVER, ...owned, ...LOCKFILES, ...PNPM_SETTINGS];
  const files = filesIn(patch).map(({ path, patch: file }) => {
    const lines = file.hunks.flatMap((hunk) => hunk.lines);
    return {
      path,
      added: lines.filter((l) => l.startsWith('+')).length,
      removed: lines.filter((l) => l.startsWith('-')).length,
      allowed: inScope(path, scope) && !inScope(path, forbidden),
    };
  });
  const paths = [...new Set(files.map((f) => f.path))];
  const outside = [...new Set(files.filter((f) => !f.allowed).map((f) => f.path))];
  const lines = [
    `scope: ${scope.join(', ')}`,
    ...files.map((f) => `${f.allowed ? 'allowed' : 'refused'} ${f.path} +${f.added} −${f.removed}`),
  ];
  return { ok: outside.length === 0, paths, outside, files, output: whole(lines, OUTPUT_CHARS) };
}

/** As many whole lines as fit in `max` characters, and how many more there were. */
function whole(lines: string[], max: number): string {
  const kept: string[] = [];
  let length = 0;
  for (const [i, line] of lines.entries()) {
    const last = i === lines.length - 1;
    const more = `… and ${lines.length - i} more`;
    // Every line but the last leaves room for saying how many more there were.
    if (length + line.length + (last ? 0 : 1 + more.length) > max) return [...kept, more].join('\n');
    kept.push(line);
    length += line.length + 1;
  }
  return kept.join('\n');
}
