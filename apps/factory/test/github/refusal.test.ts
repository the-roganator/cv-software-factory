import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { LiveActions } from '../../src/github/actions.ts';
import { REPOSITORIES } from '../../src/github/config.ts';
import { CONTROL, REFUSAL_BRANCH, type Refusal, tryWorkflowWrite, WORKFLOW } from '../../src/github/refusal.ts';
import { calls, client, OTHER_SHA, REPO, type Route, SHA } from './fake.ts';

/** GitHub as it answers the App: it takes ordinary commits, and refuses a workflow unless `workflows` is granted. */
function github(workflows: 'refused' | 'granted' | 'down', control: 'accepted' | 'refused' = 'accepted') {
  const routes: Route[] = [
    {
      method: 'GET',
      path: `/repos/${REPO}/git/ref/heads/${REFUSAL_BRANCH}`,
      answer: () => ({ status: 404, body: {} }),
    },
    { method: 'POST', path: `/repos/${REPO}/git/refs`, answer: () => ({ status: 201, body: {} }) },
    { method: 'GET', path: `/repos/${REPO}/git/ref/heads/main`, answer: () => ({ body: { object: { sha: SHA } } }) },
    { method: 'PATCH', path: `/repos/${REPO}/git/refs/heads/${REFUSAL_BRANCH}`, answer: () => ({ body: {} }) },
    { method: 'DELETE', path: `/repos/${REPO}/git/refs/heads/${REFUSAL_BRANCH}`, answer: () => ({ status: 204 }) },
    {
      method: 'POST',
      path: '/graphql',
      answer: ({ body }) => {
        if (workflows === 'down' && JSON.stringify(body).includes('workflows')) return { status: 502 };
        const paths = (
          body as { variables: { input: { fileChanges: { additions: { path: string }[] } } } }
        ).variables.input.fileChanges.additions.map((a) => a.path);
        const refused = paths.includes(WORKFLOW) ? workflows === 'refused' : control === 'refused';
        return refused
          ? { body: { errors: [{ type: 'FORBIDDEN', message: 'Resource not accessible by integration' }] } }
          : { body: { data: { createCommitOnBranch: { commit: { oid: OTHER_SHA } } } } };
      },
    },
  ];
  return client(routes);
}

const at = () => new Date('2026-10-04T12:00:00Z');

describe("the App's workflow refusal", () => {
  it('records the refusal after a control commit GitHub took, and deletes its branch', async () => {
    const { github: gh, sent } = github('refused');
    const refusal = await tryWorkflowWrite(gh, new LiveActions(gh), REPO, at);
    expect(refusal).toMatchObject({
      repo: REPO,
      control: { path: CONTROL, commit: OTHER_SHA },
      outcome: 'refused',
      kind: 'refused',
      message: 'Resource not accessible by integration',
    });
    expect(calls(sent).at(-1)).toMatchObject({
      method: 'DELETE',
      path: `/repos/${REPO}/git/refs/heads/${REFUSAL_BRANCH}`,
    });
  });

  it('says so when GitHub accepts the workflow, and still deletes its branch', async () => {
    const { github: gh, sent } = github('granted');
    expect(await tryWorkflowWrite(gh, new LiveActions(gh), REPO, at)).toMatchObject({ outcome: 'accepted' });
    expect(calls(sent).at(-1)?.method).toBe('DELETE');
  });

  it('records nothing when the App cannot commit at all: a refusal then would prove nothing', async () => {
    const { github: gh, sent } = github('refused', 'refused');
    await expect(tryWorkflowWrite(gh, new LiveActions(gh), REPO, at)).rejects.toMatchObject({ kind: 'refused' });
    expect(calls(sent).at(-1)?.method).toBe('DELETE');
  });

  it('records nothing when GitHub fails rather than refuses: a server error proves nothing about the fence', async () => {
    const { github: gh, sent } = github('down');
    await expect(tryWorkflowWrite(gh, new LiveActions(gh), REPO, at)).rejects.toMatchObject({ kind: 'server' });
    expect(calls(sent).at(-1)?.method).toBe('DELETE');
  });

  it("kept GitHub's refusal in both public repositories (factory github workflow-refusal)", async () => {
    const kept = JSON.parse(await readFile(new URL('workflow-refusals.json', import.meta.url), 'utf-8')) as Refusal[];
    expect(kept.map((r) => r.repo).sort()).toEqual([...REPOSITORIES].sort());
    for (const refusal of kept) {
      expect(refusal.outcome).toBe('refused');
      expect(refusal.control.commit).toMatch(/^[0-9a-f]{40}$/);
      expect(refusal.message).toBe('Resource not accessible by integration');
    }
  });
});
