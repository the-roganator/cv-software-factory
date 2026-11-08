import { MAX_FINDINGS } from '@software-factory/events';
import { describe, expect, it } from 'vitest';
import type { EffectsContext } from '../../src/line/agents/agent.ts';
import { type ReviewerInput, reviewer } from '../../src/line/agents/reviewer.ts';
import { FIXTURE_WORK_ITEM, FIXTURES } from '../../src/line/bench/fixtures.ts';
import {
  acceptedThreads,
  answerThreads,
  REVIEW_CHECK,
  reviewInGitHub,
  shownLines,
  threadAnswers,
} from '../../src/line/review.ts';

const input: ReviewerInput =
  FIXTURES.reviewer['cards-claimed']?.input ??
  (() => {
    throw new Error('The reviewer has no cards-claimed fixture.');
  })();

const unmet = {
  path: 'src/money.ts',
  line: 3,
  blocking: true,
  criterion: 5,
  comment: 'The cards build their price themselves and never call pounds: criterion 5 is not met.',
};
const taste = { path: 'test/money.test.ts', line: 8, blocking: false, rule: 3, comment: 'Show it through a page.' };

describe('the reviewer', () => {
  it('is told the pull request, the spec, where the base is, and to read the rules as they are there', () => {
    const prompt = reviewer.prompt(input);
    expect(prompt).toContain(
      `Review pull request #102, the factory’s fix for ticket #${FIXTURE_WORK_ITEM}: “fix(money): pad pence to two digits in prices”.`,
    );
    expect(prompt).toContain('`git diff base` is the change');
    expect(prompt).toContain('Hold those claims to the diff, not the other way round.');
    expect(prompt).toContain(
      '5. Given a product that costs a whole number of pounds, when a visitor opens the product list, then its card shows the price with two zeros of pence, such as £2.00.',
    );
    expect(prompt).toContain('`git show base:docs/REVIEWERS.md`');
    expect(prompt).toContain('ask for nothing outside the ticket');
    // The gates have run the tests: the reviewer reads.
    expect(prompt).toContain('do not run them again, and do not start the app or send it requests');
    expect(prompt).not.toContain('in its round');
  });

  it('is told, in a later round, what the review before it blocked on', () => {
    const prompt = reviewer.prompt({ ...input, round: 2, blocked: [unmet] });
    expect(prompt).toContain('in its round 2');
    expect(prompt).toContain(`1. src/money.ts:3 (criterion 5): ${unmet.comment}`);
    expect(prompt).toContain(
      '{"verdict","note","findings":[{"path","line","blocking","rule","criterion","ticket","holds","comment"}],"answered"}',
    );
    expect(prompt).toContain('- `answered`: the numbers of the findings the review before blocked on');
    // A first review has nothing to answer, and is not asked to.
    expect(reviewer.prompt(input)).not.toContain('`answered`');
  });

  it('is told what the review before it suggested, numbered after what it blocked on, and what the coder declined', () => {
    const declined = { ...taste, line: 9, comment: 'Name the test for what it shows.' };
    const prompt = reviewer.prompt({
      ...input,
      round: 2,
      blocked: [unmet],
      suggested: [taste],
      declined: [{ finding: declined, reason: 'Its name says what it shows.' }],
    });
    expect(prompt).toContain('It also suggested these, which do not block. Check each: has the change taken it?');
    expect(prompt).toContain(`2. test/money.test.ts:8 (rule 3): ${taste.comment}`);
    expect(prompt).toContain(
      `- test/money.test.ts:9 (rule 3): ${declined.comment} The coder said: Its name says what it shows.`,
    );
    expect(prompt).toContain('a finding it puts right or a suggestion it has taken');
    // After an approval, there was nothing to block on.
    const after = reviewer.prompt({ ...input, round: 2, blocked: [], suggested: [taste] });
    expect(after).toContain('The review before this one approved, and suggested these');
    expect(after).toContain(`1. test/money.test.ts:8 (rule 3): ${taste.comment}`);
    expect(after).not.toContain('blocked on');
    expect(after).toContain(',"answered"}');
    // Declined alone, nothing is left to answer.
    expect(
      reviewer.prompt({ ...input, round: 2, blocked: [], declined: [{ finding: taste, reason: 'No.' }] }),
    ).not.toContain('"answered"');
  });

  it('says by number which findings of the review before it are answered, and only those there were', () => {
    const fits = (result: unknown, blocked = [unmet, { ...unmet, line: 4 }]) =>
      reviewer.schema({ ...input, round: 2, blocked }).safeParse(result).success;
    const approved = { verdict: 'approved', note: 'Both put right.', findings: [] };
    expect(fits({ ...approved, answered: [1, 2] })).toBe(true);
    expect(fits({ ...approved, answered: [] })).toBe(true);
    expect(fits(approved)).toBe(true);
    expect(fits({ verdict: 'changes-requested', note: 'One holds.', findings: [unmet], answered: [2] })).toBe(true);
    expect(fits({ ...approved, answered: [3] })).toBe(false);
    expect(fits({ ...approved, answered: [1, 1] })).toBe(false);
    expect(fits({ ...approved, answered: [0] })).toBe(false);
    expect(fits({ ...approved, answered: [1] }, [])).toBe(false);
    // A finding held again names the one it holds, which is then not answered.
    const holding = { verdict: 'changes-requested', note: 'One holds.', findings: [{ ...unmet, holds: 1 }] };
    expect(fits(holding)).toBe(true);
    expect(fits({ ...holding, answered: [1] })).toBe(false);
    expect(fits({ ...holding, findings: [{ ...unmet, holds: 3 }] })).toBe(false);
    expect(reviewer.schema(input).safeParse({ ...holding, verdict: 'changes-requested' }).success).toBe(false);
    // A suggestion taken is answered too, numbered after what blocked.
    const suggested = reviewer.schema({ ...input, round: 2, blocked: [unmet], suggested: [taste] });
    expect(suggested.safeParse({ ...approved, answered: [1, 2] }).success).toBe(true);
    expect(suggested.safeParse({ ...approved, answered: [3] }).success).toBe(false);
  });

  it('hands back a verdict that agrees with its findings, each short, cited and anchored', () => {
    const schema = reviewer.schema(input);
    const fits = (result: unknown) => schema.safeParse(result).success;
    expect(fits({ verdict: 'escalated', note: 'The cards are outside the scope.', findings: [unmet, taste] })).toBe(
      true,
    );
    expect(fits({ verdict: 'changes-requested', note: 'The cards still drop a digit.', findings: [unmet] })).toBe(true);
    expect(fits({ verdict: 'approved', note: 'Fine, with a suggestion.', findings: [taste] })).toBe(true);
    for (const wrong of [
      { verdict: 'approved', note: 'Fine.', findings: [unmet] },
      { verdict: 'changes-requested', note: 'Hmm.', findings: [taste] },
      { verdict: 'changes-requested', note: 'Hmm.', findings: [{ ...unmet, comment: 'x'.repeat(301) }] },
      { verdict: 'changes-requested', note: 'Hmm.', findings: [{ ...unmet, criterion: 6 }] },
      { verdict: 'approved', note: '', findings: [] },
      { verdict: 'approved', note: 'Fine.', findings: [{ ...taste, body: 'old' }] },
      { verdict: 'approved', note: 'Fine.', findings: Array.from({ length: MAX_FINDINGS + 1 }, () => taste) },
    ]) {
      expect(fits(wrong), JSON.stringify(wrong).slice(0, 80)).toBe(false);
    }
  });

  it('is told the ticket and what the senses saw, and holds the spec to them as well as the change to the spec', () => {
    const widened = FIXTURES.reviewer['spec-widens']?.input;
    if (!widened) throw new Error('The reviewer has no spec-widens fixture.');
    const prompt = reviewer.prompt(widened);
    expect(prompt).toContain('The ticket: A wrong result on /products/:slug.');
    expect(prompt).toContain('It is a wrong-result on /products/:slug. Category functional, severity broken.');
    expect(prompt).toContain('1. A probe\'s check "a price is in pounds and two digits of pence" on /products/:slug');
    expect(prompt).toContain(
      '5. Given a price of 1234567 pence, when pounds is called with it, then it returns £12,345.67, with a comma between thousands. (From the ticket, which says “A wrong result on /products/:slug”.)',
    );
    expect(prompt).toContain('2. Hold the spec to the ticket.');
    expect(prompt).toContain('is a blocking finding that cites that criterion with `"ticket":true`');
    expect(prompt).toContain('The line checked only that each quote is there, not that it asks for its criterion');
  });

  it('holds a report’s spec to what the ticket points at, or Martin’s own words, whatever its title fits', () => {
    if (input.asked.kind !== 'ticket') throw new Error('The cards-claimed fixture is not a ticket.');
    const ticket = input.asked.ticket;
    const rule = 'A visitor’s report opened this ticket, and what was reported is';
    const beyond =
      'A criterion about anything else is beyond the ticket, a blocking finding with `"ticket":true`, however well the ticket’s title, its kind of problem or its page fit it';
    const pointed = reviewer.prompt({
      ...input,
      aboutReport: true,
      asked: { kind: 'ticket', ticket: { ...ticket, points: { page: '/products', passage: 'From £2 each' } } },
    });
    expect(pointed).toContain(
      `${rule} what the ticket points at, the passage “From £2 each”, or what Martin’s answer describes in his own words.`,
    );
    expect(pointed).toContain(beyond);
    // It is part of holding the spec to the ticket, before the diff is read.
    expect(pointed.indexOf(beyond)).toBeGreaterThan(pointed.indexOf('2. Hold the spec to the ticket.'));
    expect(pointed.indexOf(beyond)).toBeLessThan(pointed.indexOf('3. Read the whole diff.'));
    const pageOnly = reviewer.prompt({
      ...input,
      aboutReport: true,
      asked: { kind: 'ticket', ticket: { ...ticket, points: { page: '/products' } } },
    });
    expect(pageOnly).toContain(
      `${rule} what Martin’s answer describes in his own words, since the ticket points at nothing narrower than its page.`,
    );
    expect(reviewer.prompt(input)).not.toContain(rule);
  });

  it('knows a report’s ticket from the work item’s first sense', async () => {
    const inputOf = (firstSense: string) =>
      reviewer.input({
        workItem: FIXTURE_WORK_ITEM,
        round: 1,
        state: {
          answers: [],
          firstSense,
          spec: input.spec,
          pullRequest: { number: 102, title: input.title },
          reviews: [],
        },
        ticket: async () => (input.asked.kind === 'ticket' ? input.asked.ticket : undefined),
        signals: async () => [],
      } as unknown as Parameters<typeof reviewer.input>[0]);
    expect((await inputOf('report')).aboutReport).toBe(true);
    expect((await inputOf('probe')).aboutReport).toBeUndefined();
  });

  it('sends a criterion beyond the ticket to Martin, and a change beyond a sound spec back to the coder', () => {
    const fits = (result: unknown) => reviewer.schema(input).safeParse(result).success;
    const beyond = { ...unmet, criterion: 5, ticket: true as const, comment: 'No evidence asks for the cards.' };
    expect(fits({ verdict: 'escalated', note: 'The spec goes beyond its ticket.', findings: [beyond] })).toBe(true);
    expect(fits({ verdict: 'changes-requested', note: 'Beyond the ticket.', findings: [beyond] })).toBe(false);
    // A model may say no in so many words.
    expect(fits({ verdict: 'approved', note: 'Fine.', findings: [{ ...taste, ticket: false }] })).toBe(true);
    expect(fits({ verdict: 'escalated', note: 'Beyond the ticket.', findings: [{ ...beyond, blocking: false }] })).toBe(
      false,
    );
    // Only a criterion goes beyond the ticket: a change beyond the spec cites the spec, and goes back to the coder.
    const { criterion: _criterion, ...uncited } = beyond;
    expect(fits({ verdict: 'escalated', note: 'Beyond the ticket.', findings: [uncited] })).toBe(false);
    const extra = { ...unmet, comment: 'It also rounds every price up, which criterion 5 does not ask.' };
    expect(fits({ verdict: 'changes-requested', note: 'Take the rounding out.', findings: [extra] })).toBe(true);
    const prompt = reviewer.prompt(input);
    expect(prompt).toContain('A change that does more than the spec’s criteria ask, when the spec itself is sound');
    expect(prompt).toContain(
      '`ticket`: true only when the criterion the finding cites is one the ticket does not ask for',
    );
  });
});

const DIFF = [
  {
    path: 'src/money.ts',
    patch: [
      '@@ -1,4 +1,4 @@',
      ' /** Prices are whole pence. */',
      ' export function pounds(pence: number): string {',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the patch is the app's code, as text.
      '-  return `£${pence / 100}`;',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the patch is the app's code, as text.
      '+  return `£${(pence / 100).toFixed(2)}`;',
      ' }',
    ].join('\n'),
    added: 1,
    removed: 1,
  },
  {
    path: 'test/money.test.ts',
    patch: "@@ -5,2 +5,3 @@\n   it.each([\n+    [600, '£6.00'],\n     [1250, '£12.50'],",
    added: 1,
    removed: 0,
  },
  { path: 'public/logo.png', patch: null, added: 0, removed: 0 },
];

describe('the reviewer of an improvement', () => {
  const coded =
    FIXTURES.coder['delivery-dates']?.input ??
    (() => {
      throw new Error('The coder has no delivery-dates fixture.');
    })();
  const improvement: ReviewerInput = {
    workItem: coded.workItem,
    asked: coded.asked,
    signals: [],
    answers: [],
    spec: coded.spec,
    pullRequest: 103,
    title: 'feat(products): show when each product would arrive',
    round: 1,
  };
  const prompt = reviewer.prompt(improvement);

  it('holds the spec to Martin’s request, and each criterion to a test on its side of the flag', () => {
    expect(prompt).toContain(
      `Review pull request #103, the factory’s change for improvement #${FIXTURE_WORK_ITEM}: “feat(products): show when each product would arrive”.`,
    );
    expect(prompt).toContain('The request: Delivery dates on each product.');
    expect(prompt).toContain('Flag: delivery-dates. Pages it shows on: /products/doorstop.');
    expect(prompt).toMatch(
      /^4\. Given a product with stock, .*\(with the flag off\) \(From the request, which says “Delivery dates on each product”\.\)$/m,
    );
    expect(prompt).toContain('2. Hold the spec to the request. An improvement does what Martin asked');
    expect(prompt).toContain('The other way round too: something his answer asks for that no criterion carries');
    expect(prompt).toContain(
      '`ticket`: true only when the criterion the finding cites is one Martin did not ask for, or the one the change was meeting where it went against what his answer asks and the spec lacks; left out otherwise.',
    );
    expect(prompt).toContain('or that no test shows on its side of the flag, is a blocking finding');
    expect(prompt).not.toMatch(/the ticket|defect/);
  });

  it('blocks on behaviour the flag does not hide, the flag read another way, and anything kept on a device', () => {
    expect(prompt).toContain(
      "3. Hold the change to its flag, `delivery-dates`. Each of these is a blocking finding: anything a visitor or a caller could see change with the flag off, since the change ships off; the flag read any way but `await request.flag('delivery-dates')`, or another flag read; any name but `delivery-dates` added to or taken from the app’s list of flag names, src/flag-names.ts, and `delivery-dates` missing from it; anything kept on a visitor’s device, such as a cookie or anything in the browser’s storage; and a change to the flag context, src/flags/.",
    );
  });
});

describe('a review in GitHub', () => {
  it('knows the lines a diff shows in each file’s new version', () => {
    const shown = shownLines(DIFF);
    expect([...(shown.get('src/money.ts') ?? [])]).toEqual([1, 2, 3, 4]);
    expect([...(shown.get('test/money.test.ts') ?? [])]).toEqual([5, 6, 7]);
    expect(shown.get('public/logo.png')?.size).toBe(0);
  });

  it('anchors what the diff shows, lists the rest in its body, and reports a check run that is only a signal', () => {
    const review = {
      verdict: 'changes-requested' as const,
      note: 'The cards still drop a digit.',
      findings: [unmet, taste],
    };
    const at = { commit: 'c'.repeat(40), workItem: '1001', review: 1, last: false };
    const shown = reviewInGitHub(review, DIFF, at);
    expect(shown.comments).toEqual([
      { path: 'src/money.ts', line: 3, body: `**Blocking** · criterion 5\n\n${unmet.comment}` },
    ]);
    expect(shown.body).toContain('The cards still drop a digit.');
    expect(shown.body).toContain('- `test/money.test.ts:8`: **Suggestion** · rule 3: Show it through a page.');
    expect(shown.body).toContain('review 1. A signal, never a gate: the blocking findings go back to the coder, with');
    expect(shown.check).toEqual({
      name: REVIEW_CHECK,
      headSha: 'c'.repeat(40),
      status: 'completed',
      conclusion: 'failure',
      title: 'Changes requested: 1 blocking finding',
      summary: expect.stringContaining(`- \`src/money.ts:3\`: **Blocking** · criterion 5: ${unmet.comment}`),
      externalId: '1001',
    });
    const approved = reviewInGitHub({ verdict: 'approved', note: 'Fine.', findings: [] }, DIFF, { ...at, review: 2 });
    expect(approved.check).toMatchObject({ conclusion: 'success', title: 'Approved', summary: 'Fine.' });
    expect(approved.body).not.toContain('Not on a line');
    expect(approved.body).toContain('review 2. A signal, never a gate: the change goes on to its description');
  });

  it('says where a review goes when the coder gets no more rounds: an escalation, or the last review', () => {
    const at = { commit: 'c'.repeat(40), workItem: '1001', review: 2, last: true };
    const blocking = { verdict: 'changes-requested' as const, note: 'Still wrong.', findings: [unmet] };
    expect(reviewInGitHub(blocking, DIFF, at).body).toContain('the last review the line allows, so Martin decides');
    const escalated = { ...blocking, verdict: 'escalated' as const };
    expect(reviewInGitHub(escalated, DIFF, { ...at, review: 1, last: false }).body).toContain(
      'it is escalated, and Martin decides',
    );
    expect(reviewInGitHub(escalated, DIFF, at).body).not.toContain('go back to the coder');
  });

  it('says when a finding cites the ticket', () => {
    const beyond = { ...unmet, ticket: true as const, comment: 'No evidence asks for the cards.' };
    const at = { commit: 'c'.repeat(40), workItem: '1001', review: 1, last: false };
    const shown = reviewInGitHub({ verdict: 'escalated', note: 'Beyond the ticket.', findings: [beyond] }, DIFF, at);
    expect(shown.comments[0]?.body).toBe(`**Blocking** · the ticket · criterion 5\n\n${beyond.comment}`);
  });

  it('resolves an answered finding’s thread unless the review gives it again, word for word, on the same line', () => {
    const moved = { ...unmet, line: unmet.line + 1 };
    const answers = [
      { finding: unmet, reply: 'Answered.' },
      { finding: taste, reply: 'Taken.' },
    ];
    expect(threadAnswers(answers, [unmet])).toEqual([
      { path: taste.path, line: taste.line, body: `**Suggestion** · rule 3\n\n${taste.comment}`, reply: 'Taken.' },
    ]);
    expect(threadAnswers(answers.slice(0, 1), [moved])).toEqual([
      {
        path: unmet.path,
        line: unmet.line,
        body: `**Blocking** · criterion 5\n\n${unmet.comment}`,
        reply: 'Answered.',
      },
    ]);
  });

  it('answers each thread once, fifty to a call, each call once for the handback', async () => {
    const names: string[] = [];
    const sent: number[] = [];
    const context = {
      once: (name: string, write: (again: boolean) => Promise<unknown>) => {
        names.push(name);
        return write(false);
      },
      act: async (_: string, args: { threads: unknown[] }) => {
        sent.push(args.threads.length);
      },
    } as unknown as EffectsContext;
    const threads = Array.from({ length: 60 }, (_, line) => ({ path: 'a.ts', line, body: 'b', reply: 'r' }));
    await answerThreads(context, 'answered', 12, [...threads, threads[0] as (typeof threads)[number]]);
    expect(sent).toEqual([50, 10]);
    expect(names).toEqual(['answered', 'answered 2']);
  });

  it('says where suggestions go: back to the coder with what blocks, or alone after an approval, once', () => {
    const at = { commit: 'c'.repeat(40), workItem: '1001', review: 1, last: false };
    const blocking = { verdict: 'changes-requested' as const, note: 'One short.', findings: [unmet, taste] };
    expect(reviewInGitHub(blocking, DIFF, at).body).toContain(
      'the blocking findings go back to the coder, with the suggestions to take or decline',
    );
    const approved = { verdict: 'approved' as const, note: 'Fine.', findings: [taste] };
    expect(reviewInGitHub(approved, DIFF, { ...at, suggestionsBack: true }).body).toContain(
      'its suggestions go back to the coder to take or decline, and then the change goes on',
    );
    expect(reviewInGitHub(approved, DIFF, at).body).toContain('Martin’s merge, and its suggestions stay for him');
  });
});

describe('Martin’s acceptance of a held review', () => {
  it('answers an earlier finding that blocked as accepted, though the review held it again as a suggestion', () => {
    const blocked = { path: 'src/a.ts', line: 1, blocking: true, comment: 'Escape it.' };
    const softened = { path: 'src/a.ts', line: 1, blocking: false, comment: 'Escaping it would be better.', holds: 1 };
    const reviews = [
      { pullRequest: 12, verdict: 'changes-requested' as const, note: 'Blocks.', findings: [blocked] },
      { pullRequest: 12, verdict: 'escalated' as const, note: 'Martin decides.', findings: [softened] },
    ];
    const threads = acceptedThreads(
      reviews,
      { blocking: [], suggestions: [softened] },
      new Date('2026-10-28T14:02:31Z'),
      undefined,
    );
    expect(threads.map((t) => [t.body.split('\n')[0], t.reply.split(',')[0]])).toEqual([
      ['**Suggestion**', 'Martin approved the change in the console at 2026-10-28 14:02 UTC'],
      ['**Blocking**', 'Martin accepted this in the console at 2026-10-28 14:02 UTC'],
    ]);
  });
});

describe('the reviewer, given Martin’s answers', () => {
  const renamed =
    FIXTURES.reviewer['test-renamed']?.input ??
    (() => {
      throw new Error('The reviewer has no test-renamed fixture.');
    })();
  const prompt = reviewer.prompt(renamed);

  it('holds the change to the spec alone, and the spec to his words', () => {
    expect(prompt).toContain(
      [
        'Martin was asked, as the planner planned, and answered. His answers are part of what the ticket asks:',
        '- Review asked for changes: The test the spec contradicts is rewritten under a new name, and asserts only that the price begins with £6, which the base gives too. He said: Leave the test’s name as it is and rewrite only what it asserts: £6.00 for 600 pence.',
        'The change is held to the spec alone, since the coder reads the spec and never his answers: they are for holding the spec to what he asked.',
      ].join('\n'),
    );
    expect(prompt).toContain(
      '2. Hold the spec to the ticket. A fix does what the ticket, what the senses saw and Martin’s answers ask, and no more, in every autonomy mode.',
    );
    expect(prompt).toContain(
      'The other way round too: something his answer asks for that no criterion carries, such as a test or a file to keep as it is, is the spec’s fault, never the change’s, however the change went against his words. It is a blocking finding with `"ticket":true` that cites the criterion the change was meeting where it went against his words, and says in its comment what his answer asks that the spec lacks. Never send the coder round for words the spec never carried.',
    );
    expect(prompt).toContain(
      '`ticket`: true only when the criterion the finding cites is one the ticket does not ask for, or the one the change was meeting where it went against what Martin’s answer asks and the spec lacks; left out otherwise.',
    );
    // With no answer of his, nothing says what his answers are for.
    expect(reviewer.prompt(input)).not.toContain('held to the spec alone');
  });

  it('escalates the lack as the spec’s fault, citing the criterion the change was meeting', () => {
    const fits = (result: unknown) => reviewer.schema(renamed).safeParse(result).success;
    const lack = {
      path: 'test/money.test.ts',
      line: 13,
      blocking: true,
      criterion: 1,
      ticket: true as const,
      comment:
        'Martin asked to leave the test’s name as it is, and no criterion carries that: the change renamed it to meet criterion 1. The spec lacks his ask.',
    };
    expect(fits({ verdict: 'escalated', note: 'The spec lacks what Martin asked.', findings: [lack] })).toBe(true);
    expect(fits({ verdict: 'changes-requested', note: 'The spec lacks what Martin asked.', findings: [lack] })).toBe(
      false,
    );
    const { criterion: _criterion, ...uncited } = lack;
    expect(fits({ verdict: 'escalated', note: 'The spec lacks what Martin asked.', findings: [uncited] })).toBe(false);
  });
});

describe('the reviewer of a spec that contradicts a test', () => {
  const contradicts = [{ file: 'test/money.test.ts', test: 'pounds > drops the pence of a whole pound' }];

  it('is told the tests, quoted as data, and holds each to the ticket as a criterion', () => {
    const prompt = reviewer.prompt({ ...input, spec: { ...input.spec, contradicts } });
    expect(prompt).toContain('- at test/money.test.ts: “pounds > drops the pence of a whole pound”');
    expect(prompt).toContain(
      'Hold each to the ticket as you hold a criterion: is the contradiction one the ticket asks for?',
    );
    expect(prompt).toContain('blocking finding with `"ticket":true` that cites the criterion said to contradict it');
    expect(reviewer.prompt(input)).not.toContain('the criteria contradict');
  });
});
