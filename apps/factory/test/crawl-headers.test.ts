/** What the crawler's second ask for an asset sends: every header the crawl sends but the mark. */
import { describe, expect, it } from 'vitest';
import { unmarked } from '../src/crawler/crawl.ts';
import { UNMEASURED } from '../src/senses/http.ts';

describe('the headers of an ask as a visitor', () => {
  it('leave out the mark, in any casing, and keep every other header', () => {
    expect(unmarked({ ...UNMEASURED, 'x-variant': 'b', constructor: 'kept' })).toEqual({
      'x-variant': 'b',
      constructor: 'kept',
    });
    expect(unmarked({ 'X-Unmeasured': '1', authorization: 'Bearer t' })).toEqual({ authorization: 'Bearer t' });
  });

  it('are none when the mark was all there was', () => {
    expect(unmarked(UNMEASURED)).toBeUndefined();
  });
});
