/**
 * Fails if the first view outgrows its budget (budget.json): the gzipped JavaScript and CSS the page loads before it
 * shows anything, which is the entry chunk, what it imports statically, and the stylesheets they link. A page or dialog
 * loaded later with `lazy()` is not in it, which is the point of loading it later: the speed test times this first view
 * alone. The total the build makes, lazy chunks included, is printed beside it and held only to a loose figure, so that
 * a new lazy page does not need a review. `make check` runs it after the build.
 */
import { readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { DIST } from '../src/site.ts';

type Chunk = { file: string; isEntry?: boolean; imports?: string[]; css?: string[] };
type Sizes = { javascript: number; css: number };

const budget = JSON.parse(readFileSync(new URL('../budget.json', import.meta.url), 'utf-8')) as Record<
  'firstView' | 'total',
  Sizes
>;
const manifest = JSON.parse(readFileSync(join(DIST, '.vite/manifest.json'), 'utf-8')) as Record<string, Chunk>;

/** The files the entry loads before the first view: its own, its static imports', and their stylesheets. */
function firstView(): Set<string> {
  const files = new Set<string>();
  const seen = new Set<string>();
  const visit = (key: string) => {
    if (seen.has(key)) return;
    seen.add(key);
    const chunk = manifest[key];
    if (!chunk) return;
    files.add(chunk.file);
    for (const css of chunk.css ?? []) files.add(css);
    for (const imported of chunk.imports ?? []) visit(imported);
  };
  for (const [key, chunk] of Object.entries(manifest)) if (chunk.isEntry) visit(key);
  return files;
}

function sizes(files: Iterable<string>): Sizes {
  const totals = { javascript: 0, css: 0 };
  for (const file of files) {
    const size = gzipSync(readFileSync(join(DIST, file)), { level: 9 }).length;
    if (extname(file) === '.js') totals.javascript += size;
    if (extname(file) === '.css') totals.css += size;
  }
  return totals;
}

const measured = {
  firstView: sizes(firstView()),
  total: sizes(new Set(Object.values(manifest).flatMap((chunk) => [chunk.file, ...(chunk.css ?? [])]))),
};
const kB = (bytes: number) => `${(bytes / 1000).toFixed(1).padStart(6)} kB`;
let over = false;
for (const part of ['firstView', 'total'] as const) {
  for (const kind of ['javascript', 'css'] as const) {
    const size = measured[part][kind];
    const limit = budget[part][kind];
    const line = `${(part === 'firstView' ? 'first view' : 'in all').padEnd(10)} ${kind.padEnd(10)} ${kB(size)} of ${kB(limit).trim()}, gzipped`;
    if (size > limit) {
      over = true;
      console.error(`${line}: over budget`);
    } else console.log(line);
  }
}
if (over) process.exit(1);
