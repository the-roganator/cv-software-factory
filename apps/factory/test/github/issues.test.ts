import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiskArtifacts } from '@software-factory/store';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { DryRunActions, LiveActions } from '../../src/github/actions.ts';
import { APP_USER, IssueGuard, MARTIN, OUTSIDE_REPLY, openedBy, outsideIssuesWatch } from '../../src/github/issues.ts';
import { RefusalRecorder } from '../../src/github/refusals.ts';
import { quiet, REPO, type Route } from './fake.ts';
import { AT, github, ISSUES, records, SOMEONE, writes } from './issues-harness.ts';

// The issue guard's tests, which prove a guardrail, are in proofs/public-hostile.issues.test.ts, Martin's (CODEOWNERS).

describe('the watch of new issues', () => {
  /** The newest open issues, as GitHub lists them, answered conditionally. */
  function listed(open: { number: number; by: number | null; pullRequest?: boolean }[]) {
    let etag = 1;
    const list = {
      set(next: typeof open) {
        open = next;
        etag += 1;
      },
      route: {
        method: 'GET',
        path: `/repos/${REPO}/issues?state=open&sort=created&direction=desc&per_page=100`,
        answer: ({ headers }) =>
          headers['if-none-match'] === `"${etag}"`
            ? { status: 304 }
            : {
                headers: { etag: `"${etag}"` },
                body: open.map((i) => ({
                  number: i.number,
                  user: i.by === null ? null : { id: i.by },
                  ...(i.pullRequest ? { pull_request: {} } : {}),
                })),
              },
      } satisfies Route,
    };
    return list;
  }

  it("replies once to each issue opened outside, and to nothing of Martin's or the App's", async () => {
    const list = listed([
      { number: 120, by: MARTIN },
      { number: 16, by: APP_USER },
      { number: 131, by: SOMEONE, pullRequest: true },
    ]);
    const { github: gh, sent, comments } = github([list.route]);
    const logged: Record<string, unknown>[] = [];
    const log = pino({ level: 'info' }, { write: (line: string) => void logged.push(JSON.parse(line)) });
    const watch = outsideIssuesWatch(gh, REPO, new LiveActions(gh), log);
    await watch(); // today's issues: none is due a reply
    expect(writes(sent)).toEqual([]);
    expect(logged.find((l) => l.msg === 'read the open issues')).toMatchObject({ repo: REPO, open: 2, outside: 0 });

    list.set([{ number: 130, by: SOMEONE }, ...[120, 16].map((n) => ({ number: n, by: ISSUES[n]?.by ?? null }))]);
    await watch();
    await watch(); // 304: nothing more
    expect(comments.get(130)).toEqual([{ body: OUTSIDE_REPLY }]);
    expect(writes(sent)).toHaveLength(1);
    expect(logged.filter((l) => l.msg === 'replied to an issue opened outside the factory')).toEqual([
      expect.objectContaining({ repo: REPO, issue: 130, dryRun: false }),
    ]);

    // Started again: it reads the outside issue's comments once more, and says nothing twice.
    await outsideIssuesWatch(gh, REPO, new LiveActions(gh), quiet)();
    expect(comments.get(130)).toEqual([{ body: OUTSIDE_REPLY }]);
  });

  it('tries a reply that failed again at the next poll, though the list has not changed', async () => {
    const list = listed([
      { number: 130, by: SOMEONE },
      { number: 140, by: null },
    ]);
    let fail = 1;
    const { github: gh, comments } = github([
      list.route,
      {
        method: 'POST',
        path: `/repos/${REPO}/issues/130/comments`,
        answer: ({ body }) => {
          if (fail-- > 0) return { status: 502, body: { message: 'Bad Gateway' } };
          comments.set(130, [body as { body: string }]);
          return { status: 201, body: {} };
        },
      },
    ]);
    const watch = outsideIssuesWatch(gh, REPO, new LiveActions(gh), quiet);
    await expect(watch()).rejects.toThrow();
    // The one after it was not held back.
    expect(comments.get(140)).toEqual([{ body: OUTSIDE_REPLY }]);
    await watch();
    expect(comments.get(130)).toEqual([{ body: OUTSIDE_REPLY }]);
  });

  it('gives up on a reply GitHub refuses, such as on a locked issue, rather than asking every minute', async () => {
    const list = listed([{ number: 130, by: SOMEONE }]);
    let posts = 0;
    const { github: gh } = github([
      list.route,
      {
        method: 'POST',
        path: `/repos/${REPO}/issues/130/comments`,
        answer: () => {
          posts += 1;
          return { status: 403, body: { message: 'Unable to create comment because issue is locked.' } };
        },
      },
    ]);
    const watch = outsideIssuesWatch(gh, REPO, new LiveActions(gh), quiet);
    await watch();
    await watch();
    expect(posts).toBe(1);
  });

  it('records the reply in a dry run, and sends nothing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dry-run-'));
    const list = listed([{ number: 130, by: SOMEONE }]);
    const { github: gh, sent } = github([list.route]);
    const artifacts = new DiskArtifacts(dir);
    const guard = new IssueGuard({
      openedBy: openedBy(gh),
      recorder: new RefusalRecorder({ artifacts, log: quiet, now: AT }),
    });
    const watch = outsideIssuesWatch(gh, REPO, new DryRunActions(artifacts, quiet, AT, undefined, guard), quiet);
    await watch();
    await watch();
    expect(writes(sent)).toEqual([]);
    expect(await records(dir)).toEqual([
      { action: 'comment', repo: REPO, at: '2026-10-29T12:00:00.000Z', args: { number: 130, body: OUTSIDE_REPLY } },
    ]);
  });
});

describe('the outside reply', () => {
  it('is short, fixed, and names no one', () => {
    expect(OUTSIDE_REPLY.length).toBeLessThan(400);
    expect(OUTSIDE_REPLY).toBe(
      'Thank you for opening this.\n\nThis repository is looked after by an automated software factory. It acts only on what it finds itself and on what its operators ask of it directly, so it will not act on this issue. A human will read this issue.',
    );
    expect(OUTSIDE_REPLY).not.toMatch(/@|\$\{|https?:/);
  });
});
