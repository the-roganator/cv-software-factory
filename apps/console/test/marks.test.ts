/**
 * A mark on a screenshot shown whole: in shares of the page, so it stays on what it marks at any width, with its
 * label above it only where there is no room for it below.
 */
import { describe, expect, it } from 'vitest';
import { placedWhole } from '../web/src/components/marks.ts';

const page = { width: 1280, height: 1600 };

describe('a mark on the whole page', () => {
  it('is placed in shares of the page’s width and height', () => {
    expect(placedWhole({ x: 320, y: 400, width: 640, height: 80 }, page)).toEqual({
      left: '25%',
      top: '25%',
      width: '50%',
      height: '5%',
      up: false,
    });
  });

  it('puts its label above it at the page’s foot, where the label would fall off below', () => {
    expect(placedWhole({ x: 0, y: 1500, width: 100, height: 60 }, page).up).toBe(true);
    expect(placedWhole({ x: 0, y: 1400, width: 100, height: 60 }, page).up).toBe(false);
  });

  it('draws nothing out of a page with no size', () => {
    expect(placedWhole({ x: 10, y: 10, width: 10, height: 10 }, { width: 0, height: 0 })).toMatchObject({
      left: '0%',
      top: '0%',
    });
  });
});
