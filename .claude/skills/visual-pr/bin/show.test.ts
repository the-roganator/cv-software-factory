import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = join(import.meta.dirname, 'show.ts');
const WHITE = 0xffffffff;

type Block = { top: number; bottom: number };

/**
 * A white picture with grey blocks: each fills the rows from its top (included) to its bottom (not), inset from the
 * edges. Its pixels' greys vary along the row and down it, as text does, so white stays the background and each row
 * is found once.
 */
function picture(width: number, height: number, blocks: Block[] = []): PNG {
  const image = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const inBlock = blocks.some((block) => y >= block.top && y < block.bottom) && x >= 12 && x < width - 12;
      const grey = (x + y * 3) % 200;
      image.data.writeUInt32BE(
        inBlock ? ((grey << 24) | (grey << 16) | (grey << 8) | 0xff) >>> 0 : WHITE,
        (y * width + x) * 4,
      );
    }
  }
  return image;
}

const png = (width: number, height: number, blocks: Block[] = []) => PNG.sync.write(picture(width, height, blocks));

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function show(before: Buffer, after: Buffer) {
  const dir = mkdtempSync(join(tmpdir(), 'show-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'before.png'), before);
  writeFileSync(join(dir, 'after.png'), after);
  // Folders that do not exist yet, as scratch/pr/<owner>-<repo>/<branch>/ on a clean checkout.
  const out = join(dir, 'pr', 'owner-repo', 'branch', 'snapshot.svg');
  const run = spawnSync(process.execPath, [SCRIPT, join(dir, 'before.png'), join(dir, 'after.png'), out], {
    encoding: 'utf8',
  });
  return { run, svg: () => readFileSync(out, 'utf8') };
}

/** The rows each side of a two-up outlines, as a block's: each outline's, less its band and the space round it. */
function outlined(svg: string) {
  const [before, after] = svg.split('<g transform').slice(1);
  const rows = (side = '') =>
    [...side.matchAll(/<rect x="-?\d+" y="(\d+)" width="\d+" height="(\d+)"[^>]*stroke-dasharray/g)].map(
      ([, y, h]) => ({ top: Number(y) - 32 + 3, bottom: Number(y) - 32 + 3 + Number(h) - 6 }),
    );
  return { before: rows(before), after: rows(after) };
}

describe('show.ts', () => {
  it('blinks a change in a small place, Before over After, into a folder it makes', () => {
    const before = png(160, 160, [{ top: 20, bottom: 30 }]);
    const after = png(160, 160, [{ top: 20, bottom: 34 }]);
    const { run, svg } = show(before, after);
    expect(run.status).toBe(0);
    expect(run.stdout).toBe('blink: 20% of the picture changed\n');
    const text = svg();
    // As tall as the picture, under a band of 32.
    expect(text).toContain('width="160" height="192" viewBox="0 0 160 192"');
    expect(text).toContain(`data:image/png;base64,${before.toString('base64')}`);
    expect(text).toContain(`data:image/png;base64,${after.toString('base64')}`);
    expect(text.indexOf('>After<')).toBeLessThan(text.indexOf('>Before<'));
    expect(text).toMatch(
      /<g class="before">[\s\S]*<animate attributeName="opacity" values="1;0" keyTimes="0;0.5" calcMode="discrete" dur="1.6s"/,
    );
    expect(text).toContain('prefers-reduced-motion: reduce');
  });

  it('shows a block moved down two-up, outlining what was put above it and not the block', () => {
    const before = png(160, 200, [{ top: 20, bottom: 120 }]);
    const after = PNG.sync.read(png(160, 200, [{ top: 10, bottom: 40 }]));
    PNG.bitblt(PNG.sync.read(before), after, 0, 20, 160, 100, 0, 60);
    const { run, svg } = show(before, PNG.sync.write(after));
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/^two-up, outlined: \d+% of the picture changed\n$/);
    const text = svg();
    // Taller than wide, so side by side, each under its band.
    expect(text).toContain('width="336" height="232"');
    expect(text.indexOf('>Before<')).toBeLessThan(text.indexOf('>After<'));
    expect(text).not.toContain('<animate');
    // No background, so the gap between the two is the page's own, in a dark theme too.
    expect(text).not.toContain('fill="#fff"/>');
    expect(outlined(text)).toEqual({ before: [], after: [{ top: 10, bottom: 40 }] });
  });

  it('outlines what moved away on Before, and where it went on After, when a list is reordered', () => {
    const before = picture(160, 200, [
      { top: 10, bottom: 40 },
      { top: 60, bottom: 160 },
    ]);
    // The two blocks swap places.
    const after = picture(160, 200);
    PNG.bitblt(before, after, 0, 60, 160, 100, 0, 10);
    PNG.bitblt(before, after, 0, 10, 160, 30, 0, 130);
    const { svg } = show(PNG.sync.write(before), PNG.sync.write(after));
    expect(outlined(svg())).toEqual({ before: [{ top: 10, bottom: 40 }], after: [{ top: 130, bottom: 160 }] });
  });

  it('shows two-up with no outlines when they would cover most of the picture', () => {
    const { run, svg } = show(png(400, 100, [{ top: 0, bottom: 100 }]), png(400, 100));
    expect(run.stdout).toBe('two-up, not outlined: 100% of the picture changed\n');
    const text = svg();
    // Wider than tall, so Before above After.
    expect(text).toContain('width="400" height="280"');
    expect(text).not.toContain('stroke-dasharray');
  });

  it('matches rows as wide as both pictures are, when After grew wider and taller', () => {
    const before = picture(160, 200, [{ top: 20, bottom: 120 }]);
    // The block moved down, something was put above it, and the picture gained columns and rows of background.
    const after = picture(168, 230, [{ top: 10, bottom: 40 }]);
    PNG.bitblt(before, after, 0, 20, 160, 100, 0, 60);
    const { run, svg } = show(PNG.sync.write(before), PNG.sync.write(after));
    expect(run.stdout).toMatch(/^two-up, outlined: /);
    // As wide and as tall as the larger, side by side.
    expect(svg()).toContain('width="352" height="262"');
    expect(outlined(svg())).toEqual({ before: [], after: [{ top: 10, bottom: 40 }] });
  });

  it('outlines what was drawn in the columns only the wider picture has', () => {
    const before = picture(160, 200, [{ top: 20, bottom: 120 }]);
    // As above, and something drawn in the new columns beside the moved block: those rows of it no longer match theirs
    // in Before, so both are outlined.
    const after = picture(176, 230, [{ top: 10, bottom: 40 }]);
    PNG.bitblt(before, after, 0, 20, 160, 100, 0, 60);
    for (let y = 100; y < 110; y++) {
      for (let x = 160; x < 168; x++) after.data.writeUInt32BE(0x000000ff, (y * 176 + x) * 4);
    }
    const { svg } = show(PNG.sync.write(before), PNG.sync.write(after));
    expect(outlined(svg())).toEqual({
      before: [{ top: 60, bottom: 70 }],
      after: [
        { top: 10, bottom: 40 },
        { top: 100, bottom: 110 },
      ],
    });
  });

  it('keeps an outline at the edge of a picture within it, clear of its band', () => {
    const before = picture(160, 200, [{ top: 60, bottom: 160 }]);
    const after = picture(160, 200, [{ top: 0, bottom: 30 }]);
    PNG.bitblt(before, after, 0, 60, 160, 100, 0, 90);
    const { svg } = show(PNG.sync.write(before), PNG.sync.write(after));
    const tops = [...svg().matchAll(/<rect x="\d+" y="(\d+)"[^>]*stroke-dasharray/g)].map(([, y]) => Number(y));
    expect(tops).toEqual([33]);
  });

  it('refuses a file that is not a PNG', () => {
    const { run } = show(Buffer.from('not a picture'), png(1, 1));
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('before.png is not a PNG');
  });
});
