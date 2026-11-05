import { describe, expect, it } from 'vitest';
import { boundsOn, closesAnIssue, commitTitle, holdDraft, mentions, stepFrom } from '../../src/line/agents/agent.ts';
import { AGENTS } from '../../src/line/agents/index.ts';

describe('a fix’s title', () => {
  it('is a Conventional Commit of a fix’s type', () => {
    expect(commitTitle.parse(' fix(cart): count the last item ')).toBe('fix(cart): count the last item');
    for (const wrong of ['Count the last item', 'feat(cart): count the last item', 'fix(Cart): count it', 'fix: ']) {
      expect(commitTitle.safeParse(wrong).success, wrong).toBe(false);
    }
  });

  it('is 80 characters at most, however long its scope', () => {
    const title = (length: number, scope = 'a'.repeat(50)) => {
      const head = `fix(${scope}): `;
      return head + 'b'.repeat(length - head.length);
    };
    expect(commitTitle.safeParse(title(80)).success).toBe(true);
    expect(commitTitle.safeParse(title(81)).success).toBe(false);
    expect(commitTitle.safeParse(title(81, 'cart')).success).toBe(false);
  });
});

describe('a hold’s summary', () => {
  const summary = (hold: Pick<Parameters<typeof holdDraft>[1], 'stage' | 'kind' | 'cause'>) =>
    holdDraft('factory', { ...hold, reason: 'Why' }).summary;

  it('says what each approval waits on', () => {
    expect(summary({ stage: 'plan', kind: 'approval', cause: 'spec' })).toBe('Waiting for Martin to approve the spec');
    expect(summary({ stage: 'review', kind: 'approval', cause: 'merge' })).toBe('Waiting for Martin to merge');
    // After the merge, Martin is not asked to merge it again.
    expect(summary({ stage: 'release', kind: 'approval', cause: 'deploy' })).toBe(
      'Waiting for a deploy pull request to carry the fix',
    );
    expect(summary({ stage: 'verify', kind: 'approval', cause: 'verify' })).toBe(
      'Waiting for Martin to judge whether the fix cleared it',
    );
  });

  it('says a merge the review gate held is held for its risk tags only when the gate named some', () => {
    const held = (tags: { tag: 'dependency-change'; because: string[] }[] | undefined) =>
      holdDraft('factory', {
        stage: 'review',
        kind: 'approval',
        cause: 'merge',
        reason: 'Why',
        merge: { pullRequest: 7, head: 'a'.repeat(40), why: 'held', rule: 'held', approving: false, tags },
      }).summary;
    expect(held([{ tag: 'dependency-change', because: ['pnpm-lock.yaml'] }])).toBe(
      'Held for its risk tags: waiting for Martin',
    );
    // Held for what the gate could not read or trust, such as test integrity's run: no tags to name.
    expect(held([])).toBe('Held by the review gate: waiting for Martin');
    expect(held(undefined)).toBe('Held by the review gate: waiting for Martin');
  });

  it('says where any other hold is held, and a question is a question', () => {
    expect(summary({ stage: 'verify', kind: 'held', cause: 'verify' })).toBe('Held for Martin at verify');
    expect(summary({ stage: 'plan', kind: 'question', cause: 'question' })).toBe('A question for Martin');
  });
});

describe('what a published text may not do from the App’s account', () => {
  it('closes no issue, by any of GitHub’s closing keywords and references', () => {
    for (const closing of [
      'Fixes #1234',
      'This closes #12.',
      'fixed: #3',
      'Resolves the-roganator/cv-worlds-worst-website#7',
      'CLOSED GH-9',
      'resolve https://github.com/the-roganator/cv-worlds-worst-website/issues/4',
      'It came from a ticket.\n\n`fixes #5`',
    ]) {
      expect(closesAnIssue(closing), closing).toBe(true);
    }
    for (const fine of ['Refers to #41.', 'It fixes the price on #-less pages.', 'fix(cart): count the last item']) {
      expect(closesAnIssue(fine), fine).toBe(false);
    }
    expect(commitTitle.safeParse('fix(cart): resolve #12, the last item').success).toBe(false);
  });

  it('mentions nobody outside code', () => {
    for (const mention of ['Thanks @mrogan.', '@octocat, have a look', 'Ask (@org/team) first.']) {
      expect(mentions(mention), mention).toBe(true);
    }
    for (const fine of [
      'Mail martin@example.com.',
      'It imports `@software-factory/events`.',
      '```ts\nimport { z } from "@zod/mini";\n@decorator\n```',
      'An @ on its own.',
    ]) {
      expect(mentions(fine), fine).toBe(false);
    }
  });

  it('reads code as GitHub does before it looks for a mention', () => {
    for (const fine of [
      'It is ``@scope/pkg`` in code.',
      'It is `` `@mrogan` `` in code.',
      '   ```\n@decorator\n   ```',
      '````\n```\n@decorator\n````',
      '~~~\n```\n@decorator\n~~~',
    ]) {
      expect(mentions(fine), fine).toBe(false);
    }
    for (const mention of [
      '```\ncode\n```\nThanks @mrogan.',
      '````\ncode\n````` too\n````\nThanks @mrogan.',
      '    ```\n\nThanks @mrogan.',
      'A lone `` ` and @mrogan.',
      '```\n> ```\n```\nThanks @mrogan.',
      '> ```\n> code\n\nThanks @mrogan.',
      'An escaped \\` and @mrogan, then `code`.',
      '> `a\n>\n> @mrogan`',
    ]) {
      expect(mentions(mention), mention).toBe(true);
    }
  });
});

describe('an agent’s step', () => {
  const given = { repository: 'mrogan/app', commit: 'c'.repeat(40), prompt: 'Do it.' };

  it('names a skill, and the result’s files, only for an agent that has them', () => {
    expect(stepFrom(AGENTS.describer, given)).toMatchObject({
      skill: 'visual-pr',
      resultFiles: { body: 'description.md' },
    });
    for (const agent of ['planner', 'coder', 'reviewer'] as const) {
      expect(Object.keys(stepFrom(AGENTS[agent], given)).sort(), agent).toEqual(
        ['agent', 'commit', 'maxTurns', 'prompt', 'repository', 'result'].sort(),
      );
    }
  });

  it('carries a base, a session and a seed only when it has them', () => {
    expect(stepFrom(AGENTS.reviewer, { ...given, base: 'b'.repeat(40), resume: 's', seed: 'diff' })).toMatchObject({
      repository: 'https://github.com/mrogan/app.git',
      base: 'b'.repeat(40),
      resume: 's',
      seed: 'diff',
    });
    expect(stepFrom(AGENTS.reviewer, { ...given, base: undefined, resume: undefined })).not.toHaveProperty('base');
  });
});

describe('an agent’s bounds', () => {
  it('are its own on Claude, and longer, with more turns, on a local model', () => {
    for (const agent of ['planner', 'coder', 'reviewer', 'describer'] as const) {
      const { maxTurns, deadlineSeconds } = AGENTS[agent];
      expect(boundsOn(AGENTS[agent], 'anthropic'), agent).toEqual({ maxTurns, deadlineSeconds });
      expect(boundsOn(AGENTS[agent], 'bedrock'), agent).toEqual({ maxTurns, deadlineSeconds });
      expect(boundsOn(AGENTS[agent], 'local'), agent).toEqual({
        maxTurns: maxTurns * 2,
        deadlineSeconds: deadlineSeconds * 4,
      });
    }
    // In the first soak a planner that finished took up to 44 minutes on Qwen, and the coder 54.
    for (const agent of ['planner', 'reviewer', 'describer'] as const) {
      expect(boundsOn(AGENTS[agent], 'local').deadlineSeconds, agent).toBeGreaterThan(44 * 60);
    }
    expect(boundsOn(AGENTS.coder, 'local').deadlineSeconds).toBeGreaterThan(54 * 60);
  });
});
