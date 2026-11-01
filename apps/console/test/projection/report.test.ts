/**
 * A visitor's report as Martin reads it (spec 5.3): plain ASCII, at most 140 characters, with links, email addresses
 * and long numbers removed. And the projection given the full events, Martin's, which carry it, as well as the public
 * ones, which do not.
 */
import type { PublicEvent } from '@software-factory/events';
import { describe, expect, it } from 'vitest';
import { REPORT_TEXT } from '../../../../policy/triage.ts';
import { project, projectSheet } from '../../web/src/projection/index.ts';
import { REPORT_CHARS, REPORT_KEPT_DAYS, reportText } from '../../web/src/projection/report.ts';
import { END, SAMPLES } from './support.ts';

describe('how long a report’s text is kept', () => {
  it('is what the policy promises', () => {
    expect(REPORT_KEPT_DAYS).toBe(REPORT_TEXT.promisedDays);
  });
});

describe('a report’s text, for Martin', () => {
  it('keeps plain words and basic punctuation as they are', () => {
    const text = 'The contact form says "sent" (but nothing arrives): is it broken? Tried twice, 3 times now!';
    expect(reportText(text)).toBe(text);
  });

  it('has nothing to show for no text, or text that is all removed', () => {
    expect(reportText(undefined)).toBeUndefined();
    expect(reportText('')).toBeUndefined();
    expect(reportText('https://example.com/a?b=c me@example.com 4111 1111 1111 1111 <<>>')).toBeUndefined();
  });

  it('removes links, with or without a scheme', () => {
    expect(reportText('See https://evil.example/path?q=1 for details')).toBe('See for details');
    expect(reportText('go to www.example.org/x now')).toBe('go to now');
    expect(reportText('try evil.co.uk/login, it works')).toBe('try it works');
    expect(reportText('javascript://alert(1) hi')).toBe('hi');
  });

  it('removes an IP address, with its port and path', () => {
    expect(reportText('go to 1.2.3.4/login now')).toBe('go to now');
    expect(reportText('or 192.168.0.1:8080 then')).toBe('or then');
  });

  it('cleans what is left after a cut, which can leave a shape the whole did not have', () => {
    // `xxx.co1zzzzz` is no domain, but the cut at 137 characters leaves `xxx.co`, which is one, so it is cleaned again.
    const text = `${'b'.repeat(60)} ${'x'.repeat(73)}.co1zzzzz`;
    expect(reportText(text)).toBe(`${'b'.repeat(60)}...`);
  });

  it('removes email addresses', () => {
    expect(reportText('Write to me at someone@example.com please')).toBe('Write to me at please');
    expect(reportText('mail a.b+c@d.e.example!')).toBe('mail');
  });

  it('removes long numbers, however they are spaced, and keeps short ones', () => {
    expect(reportText('Card 4111 1111 1111 1111 was charged')).toBe('Card was charged');
    expect(reportText('Call 07700-900-123 now')).toBe('Call now');
    expect(reportText('Order 12345 is late')).toBe('Order is late');
    expect(reportText('Basket shows 3 items for 12.50 in 2026')).toBe('Basket shows 3 items for 12.50 in 2026');
  });

  it('leaves out markup and anything outside plain ASCII, as characters, never as markup', () => {
    expect(reportText('<script>alert(1)</script> the <b>page</b> & {stuff} [x] `y` #z $w')).toBe(
      'scriptalert(1)/script the bpage/b stuff x y z w',
    );
    expect(reportText('Emoji 🙂 and 中文 and tab\there\nnew line')).toBe('Emoji and and tab here new line');
  });

  it('turns accents, curly quotes, dashes and full-width letters into plain ones', () => {
    expect(reportText('Café – “nice” isn’t it…')).toBe('Cafe - "nice" isn\'t it...');
    expect(reportText('ＦＵＬＬ width')).toBe('FULL width');
  });

  it('removes what removing something else would join into a link', () => {
    expect(reportText('evil.<i>com')).toBeUndefined();
    expect(reportText('visit evil<>.<>com today')).toBe('visit today');
    expect(reportText('ｅｖｉｌ．ｃｏｍ is bad')).toBe('is bad');
  });

  it('is at most 140 characters, cut at a word', () => {
    const long = 'word '.repeat(60);
    const shown = reportText(long) ?? '';
    expect(shown.length).toBeLessThanOrEqual(REPORT_CHARS);
    expect(shown).toMatch(/^(word )+word\.\.\.$/);
    const unbroken = 'a'.repeat(300);
    expect(reportText(unbroken)).toBe(`${'a'.repeat(REPORT_CHARS - 3)}...`);
  });

  it('only ever holds the characters it allows', () => {
    const everything = Array.from({ length: 0x3000 }, (_, i) => String.fromCharCode(i)).join('');
    expect(reportText(everything) ?? '').toMatch(/^[A-Za-z0-9 .,!?'"():;/-]*$/);
  });
});

/** The samples as the full events carry them: #1268's report with the text its visitor wrote. */
const WROTE = 'The form <b>lost</b> my message twice: see https://x.example/a, or mail me@example.com';
const FULL: PublicEvent[] = SAMPLES.map((event) =>
  event.type === 'signal.received' && event.payload.sense === 'report' && event.payload.report
    ? { ...event, payload: { ...event.payload, report: { ...event.payload.report, text: WROTE } } }
    : event,
);

describe('the projection, given the full events', () => {
  it('quotes a visitor’s report on its sheet, made plain', () => {
    expect(projectSheet(project(FULL, END), '1268')?.report?.texts).toEqual([
      'The form blost/b my message twice: see or mail',
    ]);
  });

  it('has no text to quote from the public events', () => {
    expect(projectSheet(project(SAMPLES, END), '1268')?.report).toMatchObject({ by: 'visitor', texts: [] });
  });

  it('draws everything else as it draws the public events', () => {
    expect(project(FULL, END)).toEqual(project(SAMPLES, END));
  });
});
