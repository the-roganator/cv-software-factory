/**
 * Proves `ci:scope-fence` (policy/guardrails.ts, spec 6 guardrail 11), with the fence's and the coder's tests beside
 * it: the line refuses a patch outside the spec's scope, or one that changes a path the app's CODEOWNERS gives Martin,
 * and none of it reaches GitHub. Martin's (CODEOWNERS), as every file here is: a change to what they assert is a change
 * to the proof.
 */
import { describe, expect, it } from 'vitest';
import { MAIN } from '../line/fakes.ts';
import {
  AGENTS,
  CODED,
  event,
  handback,
  line,
  martin,
  PATCH,
  payloads,
  stage,
  ticket,
  withLineStore,
} from '../line/harness.ts';

withLineStore();

describe('the line’s scope fence', () => {
  it('refuses a patch outside the spec’s scope back to the coder once, then holds, and none reaches GitHub', async () => {
    const workItem = await ticket();
    const outside = PATCH.replaceAll('src/search.ts', 'src/server.ts');
    const { pass, steps, github } = line({ ...AGENTS, coder: () => handback(CODED, outside) });
    await pass(); // the planner
    await pass(); // the coder strays, and the fence refuses its patch
    expect((await payloads(workItem, 'action.refused'))[0]).toEqual({
      mechanism: 'scope-fence',
      guardrails: [11],
      action: 'Push the coder’s round 1 to a new pull request',
      output: ['scope: src/search.ts, test/', 'refused src/server.ts +1 −1', 'allowed test/search.test.ts +2 −0'].join(
        '\n',
      ),
      files: [
        { path: 'src/server.ts', added: 1, removed: 1, allowed: false },
        { path: 'test/search.test.ts', added: 2, removed: 0, allowed: true },
      ],
    });
    expect(await stage(workItem)).toBe('build');
    await pass(); // back to the coder, which resumes its session from a fresh checkout and strays again
    const back = steps.requests.at(-1);
    expect(back).toMatchObject({ agent: 'coder', round: 1, attempt: 3, resume: 'session-1', commit: MAIN });
    expect(back?.prompt).toContain('The line refused your patch');
    expect(back?.prompt).toContain('    refused src/server.ts +1 −1');
    await pass(); // the second refusal holds the work item
    expect(await stage(workItem)).toBe('held');
    expect((await payloads(workItem, 'hold.started'))[0]).toEqual({
      stage: 'build',
      kind: 'held',
      cause: 'scope',
      reason: 'The scope fence refused the coder’s patch twice: it changed files outside the spec’s scope',
    });
    expect(github.acts.map((a) => a.action)).toEqual(['openIssue']);
    expect(steps.requests.map((r) => r.agent)).toEqual(['planner', 'coder', 'coder']);
    // His answer sends it back to the planner, which is told what the fence printed and what he said.
    await martin.append(
      event(workItem, 'hold.answered', { decision: 'answered', answer: 'The server is fine to change' }, 'martin'),
    );
    await pass();
    const replan = steps.requests.at(-1);
    expect(replan?.agent).toBe('planner');
    expect(replan?.prompt).toContain(
      'The scope fence printed: scope: src/search.ts, test/; refused src/server.ts +1 −1',
    );
    expect(replan?.prompt).toContain('He said: The server is fine to change');
  });

  it('refuses a patch that changes a path the app’s CODEOWNERS gives Martin at the commit, though the scope takes it in', async () => {
    const workItem = await ticket();
    const { pass, github } = line({ ...AGENTS, coder: () => handback(CODED, PATCH) });
    await pass(); // the planner, before the test file was Martin's
    github.protectedPaths = [...github.protectedPaths, 'test/search.test.ts'];
    await pass();
    expect((await payloads(workItem, 'action.refused'))[0]?.output).toBe(
      ['scope: src/search.ts, test/', 'allowed src/search.ts +1 −1', 'refused test/search.test.ts +2 −0'].join('\n'),
    );
    expect(github.acts.map((a) => a.action)).toEqual(['openIssue']);
  });
});
