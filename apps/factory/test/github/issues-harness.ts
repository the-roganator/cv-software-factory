/**
 * GitHub's issues as the GitHub worker's guard finds them, for issues.test.ts and proofs/public-hostile.issues.test.ts:
 * who opened each, and the writes and the records the guard leaves.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { APP_USER, MARTIN } from '../../src/github/issues.ts';
import { calls, client, type Route } from './fake.ts';

export const SOMEONE = 4242;
export const AT = () => new Date('2026-10-29T12:00:00Z');

/** GitHub's issues, by number: who opened each, and whether it is a pull request. */
export const ISSUES: Record<number, { by: number | null; pullRequest?: boolean }> = {
  16: { by: APP_USER },
  17: { by: APP_USER, pullRequest: true },
  120: { by: MARTIN },
  121: { by: MARTIN, pullRequest: true },
  130: { by: SOMEONE },
  131: { by: SOMEONE, pullRequest: true },
  140: { by: null },
};

/** GitHub as the issue actions find it: each issue as `ISSUES` has it, open, with no comments, taking every write. */
export function github(extra: Route[] = []) {
  const comments = new Map<number, { body: string }[]>();
  return {
    comments,
    ...client([
      ...extra,
      {
        method: 'GET',
        path: /^\/repos\/[^/]+\/[^/]+\/issues\/\d+$/,
        answer: ({ path }) => {
          const issue = ISSUES[Number(path.split('/').at(-1))];
          if (!issue) return { status: 404, body: { message: 'Not Found' } };
          return {
            body: {
              state: 'open',
              user: issue.by === null ? null : { id: issue.by },
              ...(issue.pullRequest ? { pull_request: {} } : {}),
            },
          };
        },
      },
      { method: 'GET', path: /\/issues\/\d+\/events/, answer: () => ({ body: [] }) },
      {
        method: 'GET',
        path: /\/issues\/\d+\/comments/,
        answer: ({ path }) => ({ body: comments.get(Number(path.split('/').at(-2))) ?? [] }),
      },
      {
        method: 'POST',
        path: /\/issues\/\d+\/comments$/,
        answer: ({ path, body }) => {
          const number = Number(path.split('/').at(-2));
          comments.set(number, [...(comments.get(number) ?? []), body as { body: string }]);
          return { status: 201, body: {} };
        },
      },
      { method: 'POST', path: /\/issues\/\d+\/labels$/, answer: () => ({ body: [] }) },
      { method: 'PATCH', path: /\/issues\/\d+$/, answer: () => ({ body: {} }) },
      { method: 'PATCH', path: /\/pulls\/\d+$/, answer: () => ({ body: {} }) },
    ]),
  };
}

export const writes = (sent: { method: string }[]) => calls(sent as never).filter((s) => s.method !== 'GET');

export async function records(dir: string) {
  return Promise.all((await readdir(dir)).map(async (f) => JSON.parse(await readFile(join(dir, f), 'utf-8'))));
}
