/**
 * Whether a branch's head is already the commit one of the worker's watches would write now, though this worker did not
 * write it (it has started since): what lets a restarted worker keep a pull request's head, its checks and its place in
 * the merge queue, rather than write the same change again on `main`'s head. The pin watch (`pins.ts`) and the deploy
 * watch (`deploys.ts`) each work out the files they would write; this says whether the head is exactly them.
 *
 * A head is the watch's commit only when all of these hold, read from one comparison of `main`'s head with it and from
 * git's trees:
 *
 * - it is one commit on a commit of `main`: GitHub counts one commit ahead, whose one parent is the merge base;
 * - it is the App's, made and signed by GitHub as every commit of the App's is (`createCommitOnBranch`): its author is
 *   the App, its committer `web-flow`, its signature verified;
 * - it changes the files the watch would write and nothing else, each modified, none added, removed or renamed;
 * - each of those files is, at the head, exactly the text the watch would write, in the mode it has at `main`'s head;
 * - each is the same, text and mode, at the commit's parent as at `main`'s head.
 *
 * The last three make the head's change onto `main`, file for file, the commit the watch would write on `main`'s head,
 * which is what the review gate, merging the head onto main's tip, judges. Anything else, or a head that cannot be
 * read so, is not the watch's, and the watch writes its own.
 */
import { z } from 'zod';
import { APP_LOGIN } from './actions.ts';
import { type GitHub, GitHubError } from './client.ts';
import { PatchRefused } from './patches.ts';
import type { PinSource } from './pin-guard.ts';

/** main's head compared with a branch's: the commits the branch has that main has not, and the files they change. */
const COMPARE = z.object({
  ahead_by: z.number().int(),
  merge_base_commit: z.object({ sha: z.string() }),
  commits: z.array(
    z.object({
      sha: z.string(),
      parents: z.array(z.object({ sha: z.string() })),
      author: z.object({ login: z.string() }).nullable(),
      committer: z.object({ login: z.string() }).nullable(),
      commit: z.object({ verification: z.object({ verified: z.boolean() }).optional() }),
    }),
  ),
  files: z.array(z.object({ filename: z.string(), status: z.string() })).optional(),
});
type Compared = z.infer<typeof COMPARE>;

/** Who GitHub names as the committer of a commit it made and signed itself, as `createCommitOnBranch` makes the App's. */
const GITHUB_COMMITTER = 'web-flow';

/** One file a watch would write: its path, and its whole text. */
export interface WholeFile {
  path: string;
  text: string;
}

/**
 * Whether `at` is exactly the commit that writes `writes` on `base` (`main`'s head), as above. A head GitHub does not
 * know, or a tree it cuts short, is not.
 */
export async function isOwnCommit(
  github: Pick<GitHub, 'poll'>,
  source: PinSource,
  repo: string,
  base: string,
  at: string,
  writes: readonly WholeFile[],
): Promise<boolean> {
  if (!writes.length) return false;
  let compared: Compared;
  try {
    ({ body: compared } = await github.poll(repo, `/repos/${repo}/compare/${base}...${at}`, COMPARE));
  } catch (error) {
    if (error instanceof GitHubError && error.kind === 'not-found') return false;
    throw error;
  }
  const [only, ...more] = compared.commits;
  const parent = compared.merge_base_commit.sha;
  if (
    !only ||
    more.length ||
    compared.ahead_by !== 1 ||
    only.sha !== at ||
    only.parents.length !== 1 ||
    only.parents[0]?.sha !== parent ||
    only.author?.login !== APP_LOGIN ||
    only.committer?.login !== GITHUB_COMMITTER ||
    only.commit.verification?.verified !== true
  )
    return false;
  const files = compared.files ?? [];
  const changed = files
    .filter((file) => file.status === 'modified')
    .map((file) => file.filename)
    .sort();
  const paths = writes.map((write) => write.path).sort();
  if (changed.length !== files.length || JSON.stringify(changed) !== JSON.stringify(paths)) return false;
  try {
    for (const write of writes) {
      const [there, before, main] = await Promise.all([
        source.file(repo, at, write.path),
        source.file(repo, parent, write.path),
        source.file(repo, base, write.path),
      ]);
      if (!there || !before || !main) return false;
      if (before.text !== main.text || before.mode !== main.mode || there.mode !== main.mode) return false;
      if (there.text !== write.text) return false;
    }
  } catch (error) {
    if (error instanceof PatchRefused) return false;
    if (error instanceof GitHubError && error.kind === 'not-found') return false;
    throw error;
  }
  return true;
}
