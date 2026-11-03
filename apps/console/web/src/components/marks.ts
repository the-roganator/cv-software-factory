/**
 * Where a mark sits on a screenshot shown whole, at full size: as shares of the page, so the mark stays on what it
 * marks at whatever width the page is drawn. The frame on a card or in a sheet shows a window and places marks by
 * the shot's width (`Shot`); the whole page has no window, so each side is a share of its own side.
 */

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** What a mark says: its number in a list beside the picture, its label, or both, as a picture's words name it. */
export const markLabel = (mark: { n?: number | undefined; label?: string | undefined }) =>
  [mark.n, mark.label].filter((part) => part !== undefined && part !== '').join(' ');

/** A mark's box on the whole page, in percent of its width and height, and whether its label goes above it. */
export function placedWhole(mark: Box, page: { width: number; height: number }) {
  const share = (px: number, of: number) => `${of ? (px / of) * 100 : 0}%`;
  return {
    left: share(mark.x, page.width),
    top: share(mark.y, page.height),
    width: share(mark.width, page.width),
    height: share(mark.height, page.height),
    // A label goes under its mark, unless the mark is so near the page's foot that the label would fall off it.
    up: mark.y + mark.height > page.height - LABEL_ROOM,
  };
}

/**
 * The page's own pixels a label needs under its mark, its height and the gap above it: on a phone, where the page is
 * drawn smallest beside its labels.
 */
const LABEL_ROOM = 72;
