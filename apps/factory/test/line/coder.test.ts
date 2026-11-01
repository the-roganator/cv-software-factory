import { describe, expect, it } from 'vitest';
import { protectedWords } from '../../src/github/paths.ts';
import { type CoderInput, coder, coderInputAfterRefusal } from '../../src/line/agents/coder.ts';
import { FIXTURES } from '../../src/line/bench/fixtures.ts';

const input: CoderInput =
  FIXTURES.coder['wrong-price']?.input ??
  (() => {
    throw new Error('The coder has no wrong-price fixture.');
  })();

const unmetFinding = {
  path: 'src/money.ts',
  line: 3,
  blocking: true,
  criterion: 2,
  comment: 'Seven pence shows as 7.',
};

const CODED = {
  title: 'fix(money): show two digits of pence',
  note: 'pounds wrote the pence without padding. A test for 705 pence shows it; it pads them now.',
};

const FENCED = 'scope: src/money.ts, test/money.test.ts\nallowed src/money.ts +1 −1\nrefused src/pages/cards.ts +3 −1';

describe('the coder', () => {
  it('is told the ticket, its evidence and the spec, with the scope as a fence, and to write the test first', () => {
    const prompt = coder.prompt(input);
    expect(prompt).toContain('Fix ticket #999999999: A wrong result on /products/:slug.');
    expect(prompt).toContain('It is a wrong-result on /products/:slug. Category functional, severity broken.');
    expect(prompt).toContain('A probe\'s check "a price is in pounds and two digits of pence" on /products/:slug');
    expect(prompt).toContain('1. Given a price of 600 pence, when pounds is called with it, then it returns £6.00.');
    expect(prompt).toContain(
      'Scope, the only files you may change: src/money.ts, test/money.test.ts, test/pages-product.test.ts.',
    );
    expect(prompt).toContain('Read AGENTS.md first');
    expect(prompt).toMatch(/Write the test first.*see it fail/);
    expect(prompt).toContain('The line refuses a patch that changes any file outside the scope, whole.');
  });

  it('runs what CI requires, formatting and types as well as tests, before every hand-back', () => {
    const suggested =
      FIXTURES.coder['price-suggestions']?.input ??
      (() => {
        throw new Error('The coder has no price-suggestions fixture.');
      })();
    const returned = { from: 'gates' as const, reason: 'The gates failed: lint, types, tests' };
    const inFull = 'Before you hand back, run what CI requires of a change. AGENTS.md names it `make check`';
    const reminder =
      'If you change anything, run the checks again before you hand back: lint and formatting, the type check and the tests.';
    // A step that starts afresh is told the checks in full, and how to run them with no `make`.
    for (const step of [
      input,
      { ...input, round: 2, returned, session: null },
      coderInputAfterRefusal(input, FENCED, null),
      suggested,
    ]) {
      const prompt = coder.prompt(step);
      expect(prompt).toContain(inFull);
      expect(prompt).toContain('There is no `make` here');
      expect(prompt).toContain('put right by the formatter alone, writing that file and no other');
      expect(prompt).toContain('say in your note which you left out');
      expect(prompt).not.toContain(reminder);
    }
    // A first step runs them once its fix is in, and before it writes its result.
    const prompt = coder.prompt(input);
    expect(prompt.indexOf('3. Fix the code')).toBeLessThan(prompt.indexOf(inFull));
    expect(prompt.indexOf(inFull)).toBeLessThan(prompt.indexOf('Then write the result'));
    // One that resumes its session is reminded of them.
    for (const step of [
      { ...input, round: 2, returned, session: 's' },
      coderInputAfterRefusal(input, FENCED, 's'),
      { ...suggested, session: 's' },
    ]) {
      const prompt = coder.prompt(step);
      expect(prompt).toContain(reminder);
      expect(prompt).not.toContain(inFull);
    }
  });

  it('hands back a Conventional Commit title and a note for the commit', () => {
    const note = 'pounds wrote the pence without padding. A test for 705 pence shows it; it pads them now.';
    expect(coder.schema(input).safeParse({ title: 'fix(money): show two digits of pence', note }).success).toBe(true);
    for (const wrong of [
      { title: 'Fixed the price', note },
      { title: 'feat(money): pad pence', note },
      { title: 'fix(money): pad pence', note: '' },
      { title: 'fix(money): pad pence', note: 'x'.repeat(1001) },
      { title: 'fix(money): pad pence' },
    ]) {
      expect(coder.schema(input).safeParse(wrong).success, JSON.stringify(wrong).slice(0, 60)).toBe(false);
    }
  });

  it('may change nothing instead, and say why in a few sentences for Martin, but not both', () => {
    const why = 'The journeys fail on the basket’s total, which this change leaves alone.';
    expect(coder.schema(input).safeParse({ unchanged: why }).success).toBe(true);
    for (const wrong of [
      { unchanged: '' },
      { unchanged: 'x'.repeat(201) },
      { unchanged: why, title: 'fix(money): show two digits of pence', note: why },
    ]) {
      expect(coder.schema(input).safeParse(wrong).success, JSON.stringify(wrong).slice(0, 60)).toBe(false);
    }
    // A first round may find nothing to fix; a returned one may find what sent it back is not its change's doing.
    expect(coder.prompt(input)).toContain('If the code already does what every criterion asks');
    const returned = { from: 'gates' as const, reason: 'The gates failed: journeys' };
    const prompt = coder.prompt({ ...input, round: 2, returned, session: 's' });
    expect(prompt).toContain('Change nothing only if what sent the work back is not your change’s doing');
    expect(prompt).toContain('write {"unchanged"} instead: at most 200 characters');
  });

  it('is sent back by the scope fence with its output, told its checkout is fresh, and resumes its session', () => {
    const back = coderInputAfterRefusal(input, FENCED, 's');
    expect(coder.resume?.(back)).toBe('s');
    const prompt = coder.prompt(back);
    expect(prompt).toContain('The line refused your patch');
    expect(prompt).toContain('    refused src/pages/cards.ts +3 −1');
    expect(prompt).toContain('the checkout is back where you started');
    // Its session holds the rest; the spec is told again, since the planner may have written it afresh.
    expect(prompt).not.toContain('Read AGENTS.md first');
    expect(prompt).toContain('Scope, the only files you may change: src/money.ts');
    // Without one, it is told everything again.
    const fresh = coderInputAfterRefusal(input, FENCED, null);
    expect(coder.resume?.(fresh)).toBeUndefined();
    expect(coder.prompt(fresh)).toContain('Read AGENTS.md first');
  });

  it('names the files outside its scope it needs, each with why, instead of changing them, and never a protected one', () => {
    const needs = [{ path: 'test/flags-preview.test.ts', reason: 'It assumes / asks no flag; every page now does.' }];
    const fits = (result: object) => coder.schema(input).safeParse(result).success;
    expect(fits({ needs })).toBe(true);
    // With a change or with none, the line holds all the same, and pushes nothing.
    expect(fits({ ...CODED, needs })).toBe(true);
    expect(fits({ unchanged: 'The change is in; one test is outside the scope.', needs })).toBe(true);
    expect(fits({ ...CODED, needs: [] })).toBe(true);
    // Its path is read trimmed, as the hold records it.
    expect(coder.schema(input).parse({ needs: [{ path: ' test/a.ts ', reason: 'x' }] })).toEqual({
      needs: [{ path: 'test/a.ts', reason: 'x' }],
    });
    for (const wrong of [
      { needs: [] },
      { needs: [{ path: '../secrets', reason: 'x' }] },
      { needs: [{ path: '/etc/passwd', reason: 'x' }] },
      { needs: [{ path: 'test/a.ts', reason: '' }] },
      { needs: [{ path: 'test/a.ts', reason: 'x'.repeat(201) }] },
      { needs: Array.from({ length: 21 }, (_, i) => ({ path: `test/${i}.ts`, reason: 'x' })) },
      { needs: [{ path: 'test/a.ts' }] },
      // A file, never a folder or a pattern, which the scope and the protected paths could not be told apart from.
      { needs: [{ path: 'deploy/', reason: 'x' }] },
      { needs: [{ path: 'src/**/*.ts', reason: 'x' }] },
    ]) {
      expect(fits(wrong), JSON.stringify(wrong).slice(0, 60)).toBe(false);
    }
    const rule = 'If a criterion cannot be met without changing a file outside the scope';
    const never = `Never name a path no scope may name: ${protectedWords(input.protectedPaths).join(', ')}.`;
    // A first step is told it, and so is a later one, with its session or without.
    const returned = { from: 'gates' as const, reason: 'The gates failed: tests' };
    for (const step of [
      input,
      { ...input, round: 2, returned, session: 's' },
      { ...input, round: 2, returned, session: null },
      coderInputAfterRefusal(input, FENCED, 's'),
    ]) {
      const prompt = coder.prompt(step);
      expect(prompt).toContain(rule);
      expect(prompt.split(rule)).toHaveLength(2);
      expect(prompt).toContain(never);
    }
  });

  it('is sent back by the gates or review to the pull request’s head, told everything again without its session', () => {
    const returned = { from: 'review' as const, reason: 'Review asked for changes: the test calls pounds only' };
    const resumed = { ...input, round: 2, returned, session: 's' };
    expect(coder.resume?.(resumed)).toBe('s');
    expect(coder.prompt(resumed)).toContain('came back from review, for round 2: Review asked for changes');
    expect(coder.prompt(resumed)).toContain(
      'The checkout is the pull request’s head, with the change you pushed before in it.',
    );
    expect(coder.prompt(resumed)).not.toContain('Read AGENTS.md first');
    const finding = {
      path: 'test/money.test.ts',
      line: 6,
      blocking: true,
      rule: 3,
      comment: 'Show it through a page.',
    };
    expect(coder.prompt({ ...resumed, findings: [finding] })).toContain(
      '- test/money.test.ts:6 (rule 3): Show it through a page.',
    );
    const fresh = { ...input, round: 2, returned, session: null };
    expect(coder.resume?.(fresh)).toBeUndefined();
    expect(coder.prompt(fresh)).toContain('came back from review');
    expect(coder.prompt(fresh)).toContain('Read AGENTS.md first');
  });

  it('is given the review’s suggestions, to take or decline with a reason, and declines only those it was given', () => {
    const suggested =
      FIXTURES.coder['price-suggestions']?.input ??
      (() => {
        throw new Error('The coder has no price-suggestions fixture.');
      })();
    const prompt = coder.prompt({ ...suggested, session: 's' });
    expect(prompt).toContain('came back from review, for round 2: The review approved, with 2 suggestions');
    expect(prompt).toContain('Take each, changing the code for it inside the scope, or decline it with a reason:');
    expect(prompt).toContain('2. src/money.ts:2: pounds says little of what it does.');
    expect(prompt).toContain('If you decline every suggestion, change nothing');
    expect(prompt).not.toContain('{"unchanged"}');
    // It is asked for a change's result if it takes any, and for the suggestions declined alone if it takes none.
    expect(prompt).toMatch(/If you take any suggestion, then write the result again, \{"title","note","declined"\}/);
    expect(prompt.indexOf('Every suggestion you leave out is one you took.')).toBeLessThan(
      prompt.indexOf('If you decline every suggestion, change nothing'),
    );
    // Without its session, it is told the work, that the fix is in and approved, and how to decline.
    const fresh = coder.prompt(suggested);
    expect(fresh).toContain('Read AGENTS.md first');
    expect(fresh).toContain('The fix is in the checkout, and the reviewer approved it');
    expect(fresh).toContain('- `declined`: the suggestions you decline');
    expect(fresh).toContain('If you take any suggestion, then write the result, {"title","note","declined"}:');
    expect(fresh.trimEnd()).toMatch(/write only \{"declined"\}, with each of them\.$/);
    expect(fresh).not.toContain('{"unchanged"}');
    expect(fresh).not.toContain('Write the test first');

    const note = 'pounds pads the pence now, tested at 5, 10, 600 and 705 pence.';
    const fits = (result: unknown, given = suggested) => coder.schema(given).safeParse(result).success;
    const title = 'fix(money): show two digits of pence';
    const no = (...numbers: number[]) => numbers.map((suggestion) => ({ suggestion, reason: 'Outside the scope.' }));
    expect(fits({ title, note })).toBe(true);
    expect(fits({ title, note, declined: no(2) })).toBe(true);
    expect(fits({ title, note, declined: no(3) })).toBe(false);
    expect(fits({ title, note, declined: no(2, 2) })).toBe(false);
    // Declining them all, it changes nothing; declining some, it must change something.
    expect(fits({ declined: no(1, 2) })).toBe(true);
    expect(fits({ declined: no(2) })).toBe(false);
    expect(fits({ unchanged: 'It is approved as it is.' })).toBe(false);
    // With something blocking, declining is no way to change nothing.
    const blocking = { ...suggested, findings: [{ ...unmetFinding }] };
    expect(fits({ declined: no(1, 2) }, blocking)).toBe(false);
    expect(fits({ title, note, declined: no(1) }, blocking)).toBe(true);
    // Changing nothing there holds for Martin, and declines every suggestion, so no thread outlives his answer.
    expect(fits({ unchanged: 'The quote is escaped already.' }, blocking)).toBe(false);
    expect(fits({ unchanged: 'The quote is escaped already.', declined: no(1, 2) }, blocking)).toBe(true);
    expect(fits({ unchanged: 'The quote is escaped already.' }, input)).toBe(true);
    expect(coder.prompt({ ...blocking, session: 's' })).toContain('write {"unchanged","declined"}');
    // With no suggestions, there is nothing to decline.
    expect(fits({ title, note, declined: no(1) }, input)).toBe(false);
  });

  it('starts a first step afresh, whatever session it has', () => {
    expect(coder.resume?.({ ...input, session: 's' })).toBeUndefined();
  });

  it('is told why a returned round came back and why the fence refused it, without its session', () => {
    const returned = { from: 'review' as const, reason: 'Review asked for changes: the test calls pounds only' };
    const back = coderInputAfterRefusal({ ...input, round: 2, returned }, FENCED, null);
    expect(coder.resume?.(back)).toBeUndefined();
    const prompt = coder.prompt(back);
    expect(prompt).toContain(
      'came back from review, for round 2: Review asked for changes: the test calls pounds only.',
    );
    expect(prompt).toContain('The checkout is the pull request’s head, with the change you pushed before in it.');
    expect(prompt).toContain('The line refused your patch for this round');
    expect(prompt).toContain('    refused src/pages/cards.ts +3 −1');
    expect(prompt).toContain('the checkout is back where this round started');
    expect(prompt).toContain('Read AGENTS.md first');
  });

  it('is given Martin’s answer to the hold before its step', () => {
    expect(coder.prompt({ ...input, answer: 'Use the money helper' })).toContain(
      'Martin answered: Use the money helper',
    );
    const back = coderInputAfterRefusal({ ...input, answer: 'Use the money helper' }, FENCED, 's');
    expect(coder.prompt(back)).toContain('Martin answered: Use the money helper');
  });

  describe('for an improvement', () => {
    const improvement: CoderInput =
      FIXTURES.coder['delivery-dates']?.input ??
      (() => {
        throw new Error('The coder has no delivery-dates fixture.');
      })();
    const prompt = coder.prompt(improvement);

    it('is told Martin’s words and the spec with its flag, its pages and each criterion’s side', () => {
      expect(prompt.split('\n')[0]).toBe('Make improvement #999999999: Delivery dates on each product.');
      expect(prompt).toContain('Martin asked for it in his own words: “Delivery dates on each product.');
      expect(prompt).toContain('Flag: delivery-dates. Pages it shows on: /products/doorstop.');
      expect(prompt).toMatch(/^4\. Given a product with stock, .*no word of delivery\. \(with the flag off\)$/m);
      expect(prompt).not.toMatch(/ticket|defect/);
    });

    it('builds every new behaviour behind its flag, tests each criterion on its side, and keeps out of src/flags/', () => {
      expect(prompt).toContain("Every new behaviour goes behind the flag: `await request.flag('delivery-dates')`");
      expect(prompt).toContain(
        "`flag: async () => false` for off, and `flag: async (name) => name === 'delivery-dates'` for on",
      );
      expect(prompt).toContain('Never change the flag context, src/flags/');
      expect(prompt).toContain('Keep nothing on a visitor’s device');
      expect(prompt).toContain('Do not define the flag anywhere');
    });

    it('names the files outside its scope it needs, as a fix does', () => {
      expect(prompt).toContain('If a criterion cannot be met without changing a file outside the scope');
    });

    it('is told again, in a later round without its session, how the change goes behind its flag', () => {
      const back = coder.prompt({ ...improvement, round: 2, returned: { from: 'review', reason: 'Blocking.' } });
      expect(back).toContain('Your change for improvement #999999999 came back from review, for round 2: Blocking.');
      expect(back).toContain("`await request.flag('delivery-dates')`");
    });

    it('hands back a feature’s title, and a fix’s is refused', () => {
      const note = 'Adds a delivery date behind delivery-dates; tests run it with the flag on and off.';
      const fits = (title: string) => coder.schema(improvement).safeParse({ title, note }).success;
      expect(fits('feat(products): show when each product would arrive')).toBe(true);
      expect(fits('fix(products): show when each product would arrive')).toBe(false);
      expect(coder.schema(input).safeParse({ title: 'feat(money): pad pence', note }).success).toBe(false);
    });
  });
});
