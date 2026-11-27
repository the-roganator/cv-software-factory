/**
 * One issue a work item: the GitHub worker, asked to open an issue whose body carries a work item's mark
 * (github/issue-mark.ts), gives back the open issue of the App's that carries it, and opens a second only when there is
 * none. The line asks again when its own record of the first was lost.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiskArtifacts } from '@software-factory/store';
import { describe, expect, it } from 'vitest';
import { APP_LOGIN, DryRunActions, LiveActions } from '../../src/github/actions.ts';
import { GitHubError } from '../../src/github/client.ts';
import { MARK_PAGES, workItemMark, workItemMarkOf } from '../../src/github/issue-mark.ts';
import { APP_USER } from '../../src/github/issues.ts';
import { calls, client, quiet, REPO, type Sent } from './fake.ts';

interface Issue {
  number: number;
  title: string;
  body: string | null;
  user: { login: string; id: number } | null;
  pull_request?: object;
}

const APP = { login: APP_LOGIN, id: APP_USER };
const STRANGER = { login: 'someone-else', id: 4242 };

/**
 * GitHub's open issues, the newest first, a hundred to a page, those of the login asked for (`creator`), and the
 * issues it makes, as the App. With `unfiltered`, a GitHub that answers with everyone's whatever is asked.
 */
function repository(open: Issue[], { unfiltered = false } = {}) {
  const sent: Sent[] = [];
  let next = 100;
  const { github } = client(
    [
      {
        method: 'GET',
        path: /^\/repos\/[^/]+\/[^/]+\/issues\?state=open&creator=[^&]+&per_page=100&sort=created&direction=desc&page=\d+$/,
        answer: ({ path }) => {
          const asked = new URL(path, 'https://api.github.test').searchParams;
          const page = Number(asked.get('page'));
          const theirs = unfiltered ? open : open.filter((each) => each.user?.login === asked.get('creator'));
          return { body: theirs.slice((page - 1) * 100, page * 100) };
        },
      },
      {
        method: 'POST',
        path: `/repos/${REPO}/issues`,
        answer: ({ body }) => {
          const made = { number: next++, ...(body as { title: string; body: string }), user: APP };
          open.unshift(made);
          return { status: 201, body: made };
        },
      },
      {
        method: 'PATCH',
        path: /^\/repos\/[^/]+\/[^/]+\/issues\/\d+$/,
        answer: ({ path, body }) => {
          const issue = open.find((each) => each.number === Number(path.split('/').at(-1)));
          Object.assign(issue ?? {}, body);
          return { body: {} };
        },
      },
    ],
    sent,
  );
  const writes = () =>
    calls(sent)
      .filter((s) => s.method !== 'GET')
      .map((s) => s.method);
  return { actions: new LiveActions(github), open, sent, writes };
}

const body = (workItem: string, words = 'The factory’s ticket.') => `${words}\n\n${workItemMark(workItem)}`;

describe('the mark that finds a work item’s issue again', () => {
  it('is a comment naming the work item, read from a body’s end and from nothing else', () => {
    expect(workItemMark('1288')).toBe('<!-- factory: work-item 1288 -->');
    expect(workItemMarkOf(body('1288'))).toBe(workItemMark('1288'));
    expect(workItemMarkOf('The factory’s ticket #1288.')).toBeUndefined();
    expect(workItemMarkOf(null)).toBeUndefined();
    expect(workItemMarkOf('<!-- factory: work-item 1288 forged -->')).toBeUndefined();
    // As GitHub may keep a body: \r\n for its line endings, and space after its last line.
    expect(workItemMarkOf(`Words.\r\n\r\n${workItemMark('1288')}\r\n`)).toBe(workItemMark('1288'));
    // Anywhere but the last line it is text: a report quoted in the body, a line with more on it, a mark followed.
    expect(workItemMarkOf(`${workItemMark('1287')}\n\nA visitor’s report.`)).toBeUndefined();
    expect(workItemMarkOf(`A report quoting ${workItemMark('1287')}`)).toBeUndefined();
    expect(workItemMarkOf(`Quoted: ${workItemMark('1287')}\n\n${workItemMark('1288')}`)).toBe(workItemMark('1288'));
  });
});

describe('opening an issue for a work item', () => {
  it('opens one, and asked again gives the same issue back and opens no second', async () => {
    const { actions, open, writes } = repository([]);
    const first = await actions.openIssue(REPO, { title: 'Server errors on /search', body: body('1288') });
    const again = await actions.openIssue(REPO, { title: 'Server errors on /search', body: body('1288') });
    expect(again).toBe(first);
    expect(open).toHaveLength(1);
    expect(writes()).toEqual(['POST']);
    // Another work item's is another issue.
    expect(await actions.openIssue(REPO, { title: 'A broken link', body: body('1289') })).not.toBe(first);
    expect(open).toHaveLength(2);
  });

  it('leaves the issue it finds saying what is asked now', async () => {
    const { actions, open, writes } = repository([]);
    const first = await actions.openIssue(REPO, { title: 'Move invented-pkg', body: body('1288', 'To 2.0.1.') });
    expect(await actions.openIssue(REPO, { title: 'Move invented-pkg', body: body('1288', 'To 2.0.2.') })).toBe(first);
    expect(open).toEqual([expect.objectContaining({ number: first, body: body('1288', 'To 2.0.2.') })]);
    expect(writes()).toEqual(['POST', 'PATCH']);
  });

  it('is not captured by anyone else’s issue with the same mark, nor by a pull request', async () => {
    const stranger = { number: 7, title: 'Mine', body: body('1288'), user: STRANGER };
    const pull = { number: 8, title: 'A fix', body: body('1288'), user: APP, pull_request: {} };
    // Each answer is the App's by its id too: a GitHub that answered with everyone's would capture nothing.
    for (const unfiltered of [false, true]) {
      const { actions, open, writes } = repository([stranger, pull], { unfiltered });
      const made = await actions.openIssue(REPO, { title: 'Server errors on /search', body: body('1288') });
      expect([7, 8]).not.toContain(made);
      expect(writes()).toEqual(['POST']);
      // And then the App's own is the one found.
      expect(await actions.openIssue(REPO, { title: 'Server errors on /search', body: body('1288') })).toBe(made);
      expect(open).toHaveLength(3);
    }
  });

  it('is not captured by an issue of the App’s that carries the mark anywhere but its last line', async () => {
    // Another work item's issue, whose text quotes this one's mark: what a visitor wrote, say.
    const quoting = {
      number: 9,
      title: 'Another ticket',
      body: `A report: ${workItemMark('1288')}\n\n${workItemMark('1287')}`,
      user: APP,
    };
    const { actions, open, writes } = repository([quoting]);
    const made = await actions.openIssue(REPO, { title: 'Server errors on /search', body: body('1288') });
    expect(made).not.toBe(9);
    expect(writes()).toEqual(['POST']);
    expect(open.find((each) => each.number === 9)?.title).toBe('Another ticket');
    // Asked with the mark quoted and no mark at the end, nothing is looked for: it is no work item's issue.
    const quoted = `Quoting ${workItemMark('1287')} in passing.`;
    expect(await actions.openIssue(REPO, { title: 'A note', body: quoted })).not.toBe(9);
  });

  const filler = (count: number, user: Issue['user']): Issue[] =>
    Array.from({ length: count }, (_, i) => ({ number: 100_000 - i, title: 'Another', body: null, user }));

  it('finds one past the first page, and reads no further than a page that is not full', async () => {
    const own = { number: 41, title: 'Server errors on /search', body: body('1288'), user: APP };
    const { actions, sent, writes } = repository([...filler(100, APP), own]);
    expect(await actions.openIssue(REPO, { title: 'Server errors on /search', body: body('1288') })).toBe(41);
    expect(writes()).toEqual([]);
    expect(calls(sent)).toHaveLength(2);
  });

  it('asks for the App’s own issues, so no number of anyone else’s hides the one it opened', async () => {
    const own = { number: 41, title: 'Server errors on /search', body: body('1288'), user: APP };
    const { actions, sent, writes } = repository([...filler(MARK_PAGES * 100 + 50, STRANGER), own]);
    expect(await actions.openIssue(REPO, { title: 'Server errors on /search', body: body('1288') })).toBe(41);
    expect(writes()).toEqual([]);
    const [read, ...more] = calls(sent);
    expect(more).toEqual([]);
    expect(new URL(read?.path ?? '', 'https://api.github.test').searchParams.get('creator')).toBe(APP_LOGIN);
  });

  it('opens nothing where every page read is full: that does not say the App has none', async () => {
    const own = { number: 41, title: 'Server errors on /search', body: body('1288'), user: APP };
    const { actions, sent, writes } = repository([...filler(MARK_PAGES * 100, APP), own]);
    const asked = actions.openIssue(REPO, { title: 'Server errors on /search', body: body('1288') });
    await expect(asked).rejects.toBeInstanceOf(GitHubError);
    await expect(asked).rejects.toMatchObject({ kind: 'conflict', status: 409 });
    expect(writes()).toEqual([]);
    expect(calls(sent)).toHaveLength(MARK_PAGES);
    // One fewer, and the last page read is not full: none is established, and one is opened.
    const under = repository(filler(MARK_PAGES * 100 - 1, APP));
    await under.actions.openIssue(REPO, { title: 'Server errors on /search', body: body('1288') });
    expect(under.writes()).toEqual(['POST']);
  });

  it('looks for none when the body carries no mark, as the pin watch’s issues carry none', async () => {
    const { actions, sent } = repository([]);
    await actions.openIssue(REPO, { title: 'A broken link', body: '…' });
    await actions.openIssue(REPO, { title: 'A broken link', body: '…' });
    expect(calls(sent).map((s) => s.method)).toEqual(['POST', 'POST']);
  });

  it('gives a dry run a number of its own each time, as before: GitHub has none of its issues', async () => {
    const dry = new DryRunActions(new DiskArtifacts(await mkdtemp(join(tmpdir(), 'dry-run-'))), quiet);
    const first = await dry.openIssue(REPO, { title: 'A broken link', body: body('1288') });
    expect(await dry.openIssue(REPO, { title: 'A broken link', body: body('1288') })).not.toBe(first);
  });
});
