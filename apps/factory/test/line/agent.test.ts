import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  advisoriesNamed,
  boundsOn,
  closesAnIssue,
  commitTitle,
  defineAgent,
  type EffectsContext,
  holdDraft,
  mentions,
  mentionsIn,
  problemOf,
  publicWords,
  routineUpdate,
  type StepContext,
  StepFailed,
  scopedNamesInCode,
  stepFrom,
  titleFor,
  undisclosedAdvisories,
  unmentioning,
  unmentioningAll,
  updateTitle,
} from '../../src/line/agents/agent.ts';
import { pullRequestBody } from '../../src/line/agents/coder.ts';
import type { Asked, Signal } from '../../src/line/agents/evidence.ts';
import { AGENTS } from '../../src/line/agents/index.ts';
import { moveSection } from '../../src/line/moves.ts';
import { reviewInGitHub } from '../../src/line/review.ts';

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

describe('a routine update’s title', () => {
  const ticket = { title: 'Move pino, in npm', category: 'dependency', severity: 'cosmetic', traces: [] };
  const asked = { kind: 'ticket', ticket: { ...ticket, fingerprint: { name: 'pino', ecosystem: 'npm' } } } as Asked;
  const sense = (symptom: 'outdated-dependency' | 'vulnerable-dependency') => ({
    sense: 'dependency' as const,
    symptom,
  });
  const probe = { sense: 'probe' as const, symptom: 'server-error' as const };

  it('is `chore(deps): …` and nothing else: no other type, no other scope, and none', () => {
    expect(updateTitle.parse(' chore(deps): move pino to 10.4.2 ')).toBe('chore(deps): move pino to 10.4.2');
    for (const wrong of [
      'fix(deps): move pino to 10.4.2',
      'chore: move pino to 10.4.2',
      'chore(cart): move pino to 10.4.2',
      'chore(deps): move pino, fixes #12',
      `chore(deps): ${'m'.repeat(70)}`,
    ])
      expect(updateTitle.safeParse(wrong).success, wrong).toBe(false);
  });

  it('is asked of a work item whose newest dependency signal names an outdated dependency, and of no other', () => {
    expect(routineUpdate([sense('outdated-dependency')])).toBe(true);
    expect(routineUpdate([sense('vulnerable-dependency')])).toBe(false);
    expect(routineUpdate([])).toBe(false);
    expect(routineUpdate([probe])).toBe(false);
    // The newest of the sense's decides: a finding since makes it a fix, and one cleared since a routine update.
    expect(routineUpdate([sense('outdated-dependency'), sense('vulnerable-dependency')])).toBe(false);
    expect(routineUpdate([sense('vulnerable-dependency'), sense('outdated-dependency'), probe])).toBe(true);

    const chore = 'chore(deps): move pino to 10.4.2';
    const fix = 'fix(deps): move pino to 10.4.2';
    expect(titleFor(asked, [sense('outdated-dependency')]).safeParse(chore).success).toBe(true);
    expect(titleFor(asked, [sense('outdated-dependency')]).safeParse(fix).success).toBe(false);
    for (const signals of [[], [probe], [sense('vulnerable-dependency')]]) {
      expect(titleFor(asked, signals).safeParse(fix).success).toBe(true);
      expect(titleFor(asked, signals).safeParse(chore).success).toBe(false);
    }
    // An improvement is a feature whatever its signals say.
    const request = { kind: 'request', request: { title: 't', words: 'w' } } as Asked;
    expect(titleFor(request, [sense('outdated-dependency')]).safeParse(chore).success).toBe(false);
  });
});

describe('a result’s problem, as the next attempt is told it', () => {
  it('names the field, the rule, and how long a string that broke a rule of characters was', () => {
    const schema = z.object({ title: commitTitle, unchanged: z.string().max(200) });
    const result = { title: `fix(deps): ${'m'.repeat(83)}`, unchanged: 'u'.repeat(241) };
    const issues = schema.safeParse(result).error?.issues ?? [];
    expect(issues.map((issue) => problemOf(issue, result))).toEqual([
      'title: Too big: expected string to have <=80 characters (it had 94)',
      'title: a Conventional Commit title of 80 characters at most (it had 94)',
      'unchanged: Too big: expected string to have <=200 characters (it had 241)',
    ]);
    // As the rule counts it, whitespace too.
    const padded = { title: 'fix(deps): ok', unchanged: ` ${'u'.repeat(200)} ` };
    const [issue] = z.object({ unchanged: z.string().max(200) }).safeParse(padded).error?.issues ?? [];
    expect(issue && problemOf(issue, padded)).toBe(
      'unchanged: Too big: expected string to have <=200 characters (it had 202)',
    );
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

  it('names each mention as written, without the full stop after it', () => {
    expect(mentionsIn('Thanks @mrogan. Ask (@org/team) first, not `@coded` or martin@example.com.')).toEqual([
      '@mrogan',
      '@org/team',
    ]);
  });

  it('puts a scoped package’s name outside code in code, and leaves a user’s mention and code as they were', () => {
    expect(
      scopedNamesInCode(
        'protobufjs, pulled in through @grpc/proto-loader, moves.\n\n- **@types/node.** and `@grpc/grpc-js`',
      ),
    ).toBe('protobufjs, pulled in through `@grpc/proto-loader`, moves.\n\n- **`@types/node`.** and `@grpc/grpc-js`');
    expect(scopedNamesInCode('```\n@grpc/grpc-js\n```\nThanks @mrogan, see https://npm.im/@grpc/grpc-js.')).toBe(
      '```\n@grpc/grpc-js\n```\nThanks @mrogan, see https://npm.im/@grpc/grpc-js.',
    );
    for (const coded of [
      scopedNamesInCode('Through @grpc/proto-loader and (@bufbuild/protobuf).'),
      scopedNamesInCode('A lone `` ` and @grpc/grpc-js.'),
    ]) {
      expect(mentionsIn(coded), coded).toEqual([]);
    }
    expect(mentionsIn(scopedNamesInCode('Through @grpc/proto-loader, thanks to @mrogan.'))).toEqual(['@mrogan']);
  });

  it('puts a scoped package’s name in an HTML block in HTML’s code, and finds a mention there in backticks', () => {
    const folded = '<details>\n<summary>Moves @grpc/proto-loader</summary>\n\nThrough @grpc/grpc-js.\n</details>';
    expect(scopedNamesInCode(folded)).toBe(
      '<details>\n<summary>Moves <code>@grpc/proto-loader</code></summary>\n\nThrough `@grpc/grpc-js`.\n</details>',
    );
    expect(mentionsIn(scopedNamesInCode(folded))).toEqual([]);
    expect(mentionsIn('<summary>Thanks `@mrogan` and <code>@coded</code></summary>')).toEqual(['@mrogan']);
  });

  it('finds a mention in an HTML block that a `<code>` in a comment or an attribute seems to hide', () => {
    expect(mentionsIn('<div><!-- <code> --> @someone <!-- </code> --></div>')).toEqual(['@someone']);
    expect(mentionsIn('<div><span title="<code>">@someone</span><span title="</code>"></span></div>')).toEqual([
      '@someone',
    ]);
    expect(mentionsIn('<div>@someone</div>')).toEqual(['@someone']);
  });
});

describe('an agent’s words the line publishes on GitHub', () => {
  it('have a scoped package’s name in code, counted in the most they may be, and mention nobody', () => {
    expect(publicWords(300).parse('  Moves @grpc/proto-loader, which `@grpc/grpc-js` needs. ')).toBe(
      'Moves `@grpc/proto-loader`, which `@grpc/grpc-js` needs.',
    );
    const refused = publicWords(300).safeParse('Ask @mrogan about @grpc/proto-loader.');
    expect(refused.error?.issues.map((issue) => issue.message)).toEqual([
      'no @mention outside code: @mrogan would notify someone from the App’s account',
    ]);
    // The code marks the line adds count: the events keep the words as GitHub has them, within the same bound.
    const full = `${'a'.repeat(300 - '@grpc/grpc-js'.length - 1)} @grpc/grpc-js`;
    expect(full).toHaveLength(300);
    expect(publicWords(300).safeParse(full).success).toBe(false);
    expect(publicWords(302).safeParse(full).success).toBe(true);
    expect(publicWords(300).safeParse('   ').success).toBe(false);
  });
});

describe('what the line puts together from an agent’s words', () => {
  const SPEC = {
    outcome: 'A price shows two digits of pence.',
    // Each part passes alone: one opens a code mark, and the mention in the other is in code. On one line the first
    // two marks pair, and the mention is live.
    criteria: [{ given: 'a price in the `cart', when: 'it is written in pounds', expect: '`@mrogan` reads £35.00' }],
    scope: ['src/money.ts'],
    risks: [],
    rollout: 'Ships as it is.',
  };
  const refusal = (send: () => void) => {
    try {
      send();
    } catch (error) {
      return error;
    }
    return undefined;
  };

  it('is read as it is sent: a pull request’s draft or a move’s section whose parts make a mention is refused', () => {
    for (const part of [SPEC.criteria[0]?.given, SPEC.criteria[0]?.expect]) expect(mentionsIn(part ?? '')).toEqual([]);
    const draft = pullRequestBody('7', 12, SPEC, 'fix');
    const section = moveSection(SPEC, [], [], undefined);
    expect(mentionsIn(draft)).toEqual(['@mrogan']);
    expect(mentionsIn(section)).toEqual(['@mrogan']);
    const opened = refusal(() => unmentioningAll('openPullRequest', { head: 'factory/7', body: draft, draft: true }));
    expect(opened).toBeInstanceOf(StepFailed);
    expect((opened as Error).message).toBe(
      'The body of openPullRequest, as the line put it together from the step’s words, would mention @mrogan from the App’s account: write no @name, and close every code mark in the field that opens it',
    );
    expect(
      refusal(() => unmentioningAll('updatePullRequest', { number: 3, body: `Words.\n\n${section}` })),
    ).toBeInstanceOf(StepFailed);
    // What mentions nobody is sent as it is, a title and a commit's message unread: neither is Markdown.
    expect(unmentioning('The move of `@grpc/grpc-js`.', 'The body')).toBe('The move of `@grpc/grpc-js`.');
    unmentioningAll('openPullRequest', { title: 'fix(deps): move @grpc/grpc-js to 1.14.7', body: 'It moves.' });
    unmentioningAll('applyPatch', { message: 'fix(deps): move @grpc/grpc-js\n\nThe pin step moved @grpc/grpc-js.' });
  });

  it('is read wherever a review puts a finding: its body, its comments, the check’s summary and a thread’s reply', () => {
    // Alone, a fence's info string; after the line's own words on its line, live.
    const fenced = { path: 'src/money.ts', line: 3, blocking: true, comment: '``` @mrogan must see this' };
    // A path that closes the code the line writes it in.
    const pathed = { path: 'a` @mrogan `b', line: 3, blocking: true, comment: 'Seven pence shows as 7.' };
    for (const finding of [fenced, pathed]) {
      const review = { verdict: 'changes-requested' as const, note: 'One holds.', findings: [finding] };
      const shown = reviewInGitHub(review, [], { commit: 'c'.repeat(40), workItem: '7', review: 1, last: false });
      expect(mentionsIn(shown.body)).toEqual(['@mrogan']);
      expect(mentionsIn(shown.check.summary)).toEqual(['@mrogan']);
      expect(refusal(() => unmentioningAll('createCheckRun', shown.check))).toBeInstanceOf(StepFailed);
      expect(refusal(() => unmentioningAll('review', { number: 3, body: shown.body, comments: [] }))).toBeInstanceOf(
        StepFailed,
      );
    }
    const comments = [{ path: 'src/money.ts', line: 3, body: '**Blocking**\n\nAsk @mrogan.' }];
    expect(refusal(() => unmentioningAll('review', { number: 3, body: 'Fine.', comments }))).toBeInstanceOf(StepFailed);
    // A thread is found by its first comment, which GitHub has already: only the reply is the line's to send.
    const thread = { ...comments[0], reply: 'Declined by the factory’s coder: it is the library’s way.' };
    unmentioningAll('resolveThreads', { number: 3, threads: [thread] });
    const replied = refusal(() =>
      unmentioningAll('resolveThreads', { number: 3, threads: [{ ...thread, reply: 'Declined: ask @mrogan.' }] }),
    );
    expect((replied as Error).message).toContain('The reply of resolveThreads');
    expect(refusal(() => unmentioningAll('closeIssue', { number: 3, comment: 'Thanks @mrogan.' }))).toBeInstanceOf(
      StepFailed,
    );
  });

  it('fails the step before anything of it is sent, whatever the agent’s result does', async () => {
    const sent: string[] = [];
    const agent = defineAgent<{ asked: Asked; signals: Signal[] }, { note: string }>({
      agent: 'reviewer',
      maxTurns: 1,
      deadlineSeconds: 1,
      input: async () => ({
        asked: { kind: 'request', request: { title: 'Sort by price', words: 'Sort.' } },
        signals: [],
      }),
      prompt: () => 'Review it.',
      schema: () => z.object({ note: z.string() }),
      apply: async ({ note }, _handback, _input, context) => {
        await context.act('comment', { number: 3, body: `- \`src/a.ts:1\`: ${note}` });
        return [];
      },
    });
    const effects = {
      act: async (action: string) => {
        sent.push(action);
      },
    } as unknown as EffectsContext;
    const finish = async (note: string) =>
      (await agent.start({ state: {} } as StepContext)).finish({ result: { note } } as never, effects);
    await expect(finish('``` @mrogan must see this')).rejects.toBeInstanceOf(StepFailed);
    expect(sent).toEqual([]);
    await finish('Fine as it is.');
    expect(sent).toEqual(['comment']);
  });
});

describe('an agent’s words about a move', () => {
  const scan = (advisories: string[]): Signal => ({
    sense: 'dependency',
    check: 'vulnerabilities',
    version: 'c'.repeat(40),
    symptom: 'vulnerable-dependency',
    evidence: [
      {
        kind: 'scan',
        findings: advisories.map((advisory) => ({ advisory, package: 'invented-pkg', severity: { scanner: 'high' } })),
        rest: { critical: 0, high: 3, medium: 0, low: 0, unknown: 0 },
      },
    ],
  });
  const move: Asked = {
    kind: 'ticket',
    ticket: {
      title: 'Move invented-pkg, in npm',
      category: 'security',
      severity: 'broken',
      fingerprint: { name: 'invented-pkg', ecosystem: 'npm' },
      traces: [],
    },
  };

  it('name no advisory the issue does not: each id-shaped word the issue lacks is found, once, in capitals', () => {
    const named = ['GHSA-0000-0000-0001', 'CVE-2099-0001'];
    expect(undisclosedAdvisories('Clears GHSA-0000-0000-0001 and cve-2099-0001.', named)).toEqual([]);
    expect(
      undisclosedAdvisories(
        'Clears CVE-2099-0001, and CVE-2099-0002 (ghsa-0000-0000-0002) too; `CVE-2099-0002` again.',
        named,
      ),
    ).toEqual(['CVE-2099-0002', 'GHSA-0000-0000-0002']);
    // A distribution's or a database's own id, as the scan gives one for an image's package.
    expect(
      undisclosedAdvisories('DSA-5123-1, DLA-3456-2, RHSA-2026:1234, RUSTSEC-2026-0001 and TEMP-0000000-ABCDEF.', []),
    ).toEqual(['DSA-5123-1', 'DLA-3456-2', 'RHSA-2026:1234', 'RUSTSEC-2026-0001', 'TEMP-0000000-ABCDEF']);
    // Words with a hyphen and a number that are no advisory's id.
    expect(
      undisclosedAdvisories('SHA-256, UTF-8, ISO-8601, RFC-9110, node-24.11.1, 2026-11-25 and factory/1234-move.', []),
    ).toEqual([]);
  });

  it('find an id respelt: another dash, spaces or underscores between its parts, code marks inside it, another case', () => {
    for (const respelt of [
      'CVE\u20112026\u20111234',
      'CVE-2026\u20131234',
      'CVE\u22122026\u22121234',
      'CVE 2026 1234',
      'cve_2026_1234',
      'CVE-`2026`-1234',
      'CVE-**2026**-1234',
      'C\u200bVE-2026-1234',
      '\uff23\uff36\uff25-2026-1234',
    ]) {
      expect(undisclosedAdvisories(`It also clears ${respelt}.`, ['CVE-2026-0001']), respelt).toEqual([
        'CVE-2026-1234',
      ]);
    }
    for (const respelt of [
      'GHSA aaaa-bbbb-cccc',
      'ghsa_aaaa_bbbb_cccc',
      'GHSA\u2013aaaa\u2013bbbb\u2013cccc',
      'GHSA 9x2c q4m7 r8vw',
    ]) {
      expect(undisclosedAdvisories(`See ${respelt}.`, [])[0], respelt).toMatch(
        /^GHSA-(AAAA-BBBB-CCCC|9X2C-Q4M7-R8VW)$/,
      );
    }
    expect(undisclosedAdvisories('See rustsec_2026_0001.', [])).toEqual(['RUSTSEC-2026-0001']);
    // One the issue names is named however it is spelt, and a sentence is no id.
    expect(
      undisclosedAdvisories('Clears CVE 2026 1234 and ghsa_aaaa_bbbb_cccc.', ['cve-2026-1234', 'GHSA-aaaa-bbbb-cccc']),
    ).toEqual([]);
    expect(undisclosedAdvisories('The GHSA from that scan, and the CVE of 2026: 1234 lines.', [])).toEqual([]);
  });

  const names = (advisories: string[]) => ({
    name: 'invented-pkg',
    ecosystem: 'npm' as const,
    findings: advisories.map((advisory) => ({
      advisory,
      package: 'invented-pkg',
      severity: { scanner: 'high' as const },
    })),
  });

  it('are held to the advisories the issue was last recorded as naming, whatever a newer scan lists', () => {
    expect(
      advisoriesNamed({ issueNames: names(['CVE-2099-0001']), scanned: names(['CVE-2099-0002', 'CVE-2099-0003']) }),
    ).toEqual(['CVE-2099-0001']);
    // A routine update's issue names none, and neither does a move's that lists no finding.
    expect(
      advisoriesNamed({ issueNames: { name: 'invented-pkg', ecosystem: 'npm' }, scanned: names(['CVE-2099-0002']) }),
    ).toEqual([]);
    // No issue recorded, as in a dry run: what the newest scan lists, which its issue is written from.
    expect(advisoriesNamed({ issueNames: undefined, scanned: names(['CVE-2099-0002', 'CVE-2099-0003']) })).toEqual([
      'CVE-2099-0002',
      'CVE-2099-0003',
    ]);
    expect(advisoriesNamed({ issueNames: undefined, scanned: undefined })).toEqual([]);
  });

  it('fail the step when its result names an advisory the issue does not, in any of its words, and only for a move', async () => {
    const applied: unknown[] = [];
    const agent = defineAgent<{ asked: Asked; signals: Signal[] }, { note: string; findings: { comment: string }[] }>({
      agent: 'reviewer',
      maxTurns: 1,
      deadlineSeconds: 1,
      input: async ({ ticket, signals }) => ({
        asked: { kind: 'ticket', ticket: await ticket() },
        signals: await signals(),
      }),
      prompt: () => 'Review it.',
      schema: () => z.object({ note: z.string(), findings: z.array(z.object({ comment: z.string() })) }),
      apply: async (result) => {
        applied.push(result);
        return [];
      },
    });
    const context = (asked: Asked) =>
      ({
        ticket: async () => (asked.kind === 'ticket' ? asked.ticket : undefined),
        // The newest scan lists a second advisory, which the issue has not been written for.
        signals: async () => [scan(['CVE-2099-0001', 'CVE-2099-0002'])],
        state: { issueNames: names(['CVE-2099-0001']), scanned: names(['CVE-2099-0001', 'CVE-2099-0002']) },
      }) as unknown as StepContext;
    const finish = async (asked: Asked, result: unknown) =>
      (await agent.start(context(asked))).finish({ result } as never, {} as EffectsContext);

    const within = { note: 'Clears CVE-2099-0001.', findings: [{ comment: 'Nothing more.' }] };
    await finish(move, within);
    expect(applied).toEqual([within]);

    const beyond = { note: 'Clears CVE-2099-0001.', findings: [{ comment: 'CVE-2099-0002 is left.' }] };
    const refused = await finish(move, beyond).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(StepFailed);
    expect((refused as Error).message).toBe(
      "The reviewer's result names CVE-2099-0002, which the ticket's issue does not: name no advisory the issue does not list",
    );
    expect(applied).toEqual([within]);

    // A defect's ticket discloses nothing of a move: its agents' words are not held to an issue's advisories.
    const defect: Asked = {
      kind: 'ticket',
      ticket: { ...move.ticket, fingerprint: { class: 'http-5xx', route: '/search' } } as never,
    };
    await finish(defect, beyond);
    expect(applied).toEqual([within, beyond]);
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
