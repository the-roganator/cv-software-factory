import { describe, expect, it } from 'vitest';
import { PAGE_PATH, pathOf } from '../src/line.ts';

describe('a page of the app, by its path', () => {
  it('takes a path of segments, with a slash at its end or not', () => {
    for (const path of ['/', '/about', '/products/', '/products/oak-stool', '/a.b/c', '/...']) {
      expect(PAGE_PATH.test(path), path).toBe(true);
    }
  });

  it('refuses a dot segment, in any spelling an address collapses, so a path names the page it says', () => {
    for (const path of [
      '/.',
      '/..',
      '/a/./b',
      '/a/../b',
      '/a/..',
      '/a/.',
      '/%2e/b',
      '/%2E%2e/b',
      '/a/.%2e',
      '/a/%2e.',
    ]) {
      expect(PAGE_PATH.test(path), path).toBe(false);
    }
  });

  it('refuses an empty segment, at its start or within it, and a backslash', () => {
    for (const path of ['//elsewhere.test', '//', '/a//b', '/a/b//', '/a\\b', '/\\elsewhere.test']) {
      expect(PAGE_PATH.test(path), path).toBe(false);
    }
  });

  it('refuses a query, a fragment, a space, and a scheme where the page’s path is asked', () => {
    for (const path of ['/a?x=1', '/a#top', '/a b', 'about', '', '/a:b']) {
      expect(PAGE_PATH.test(path), path).toBe(false);
    }
    // The page reader's own pattern takes a colon, which no event's page does, and refuses the rest alike.
    expect(pathOf().test('/a:b')).toBe(true);
    expect(pathOf().test('/a/../b')).toBe(false);
  });
});
