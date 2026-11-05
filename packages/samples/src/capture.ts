/**
 * The samples' screenshots: real captures of the app, each with one sample's invented change applied to a
 * scratch copy of it, which is thrown away afterwards and goes nowhere.
 *
 *     pnpm --filter @software-factory/samples capture [--app <checkout of cv-worlds-worst-website>]
 *
 * Writes each screenshot into the samples' event log (log/artifacts, named by hash) and what the samples need to
 * know about it into captures.json: where the probe looked, and how much of each page differs from the app as
 * published. Run it again when a variant or the app changes; the export reads captures.json and never the app.
 */
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { BROWSER_LAUNCH, type Check, capture, pixelDifference } from '@software-factory/factory/capture';
import { DiskArtifacts } from '@software-factory/store';
import { type Browser, chromium, type Page } from 'playwright';
import { ARTIFACTS, CAPTURES, type Captures } from './captures.ts';

/** The app as it was published, which every sample's change is made to. */
const APP = {
  repository: 'https://github.com/the-roganator/cv-worlds-worst-website.git',
  commit: '7d3353a10f3847284a24ab09cc5db9781f338ecc',
};

const PORT = 18_190;
const VIEWPORT = { width: 1280, height: 800 };

/** One change to a file: the text it must contain, and what replaces it. */
type Edit = [file: string, find: string, replace: string];

/** The app's own template literals, written as plain strings, since they are edits to its source. */
const $ = (expression: string) => `\${${expression}}`;

const LAST_ONE = 'product.stock === 1 && html`<p class="last-one">The last one</p>`';

interface Shot {
  name: string;
  path: string;
  route: string;
  /** Scrolls to this element first, when what matters is below the fold. */
  scroll?: string;
  checks?: Check[];
}

interface Variant {
  name: string;
  /** What the sample says changed, made for real in the scratch copy. */
  edits: Edit[];
  shots: Shot[];
}

const PAGES: Shot[] = [
  { name: 'home', path: '/', route: '/' },
  { name: 'products', path: '/products', route: '/products' },
  { name: 'search', path: '/search?q=ladder', route: '/search' },
  { name: 'contact', path: '/contact', route: '/contact' },
];

const VARIANTS: Variant[] = [
  {
    name: 'published',
    edits: [],
    shots: [
      ...PAGES,
      {
        name: 'home-fixed',
        path: '/',
        route: '/',
        scroll: 'h2:text("This week")',
        checks: [{ selector: '.card:nth-child(3) .price', kind: 'fix', label: 'Back above zero' }],
      },
      { name: 'home-sundries', path: '/', route: '/', scroll: 'h2:text("This week")' },
      {
        name: 'search-fixed',
        path: '/search?q=ladder',
        route: '/search',
        checks: [{ selector: '.card h3', kind: 'fix', label: 'The ladder, as it should be' }],
      },
    ],
  },
  {
    // #1271: an improvement Martin asked for.
    name: 'last-one',
    edits: [
      [
        'src/pages/cards.ts',
        `<p class="price">${$('pounds(product.pricePence)')}</p>`,
        `<p class="price">${$('pounds(product.pricePence)')}</p>\n    ${$(LAST_ONE)}`,
      ],
      [
        'public/site.css',
        '.quiet {',
        '.last-one {\n  display: inline-block;\n  margin: 0 0 6px;\n  padding: 1px 9px;\n  border-radius: 999px;\n  background: #e7eedd;\n  font-size: 13px;\n  font-weight: 600;\n}\n.quiet {',
      ],
    ],
    shots: [
      ...PAGES,
      {
        name: 'products-marked',
        path: '/products',
        route: '/products',
        checks: [{ selector: '.card:nth-child(4) .last-one', kind: 'fix', label: 'New: the last one, marked' }],
      },
    ],
  },
  {
    // #1296: injected from the menu.
    name: 'negative',
    edits: [['src/pages/cards.ts', $('pounds(product.pricePence)'), $('pounds(-product.pricePence)')]],
    shots: [
      {
        name: 'home-sundries',
        path: '/',
        route: '/',
        scroll: 'h2:text("This week")',
        checks: [{ selector: '.card:nth-child(1) .price', kind: 'problem', label: 'Prices below zero' }],
      },
    ],
  },
  {
    // #1302: injected from the menu, and still on the line.
    name: 'short-words',
    edits: [
      [
        'src/pages/search.ts',
        '            query &&\n            (products.length > 0',
        '            query.length > 4\n              ? html`<p class="notice">Please use a shorter word. We search for words of four letters or fewer.</p>`\n              : query &&\n            (products.length > 0',
      ],
    ],
    shots: [
      {
        name: 'search',
        path: '/search?q=ladder',
        route: '/search',
        checks: [{ selector: '.notice', kind: 'problem', label: 'Turned away: six letters' }],
      },
    ],
  },
];

/** Pages compared with the same page as published, as verification compares each page with the version before. */
const COMPARE = PAGES.map((page) => page.name);

const { values } = parseArgs({ options: { app: { type: 'string' } } });
const work = mkdtempSync(join(tmpdir(), 'samples-app-'));
const run = (command: string, args: string[]) =>
  execFileSync(command, args, { cwd: work, stdio: ['ignore', 'ignore', 'inherit'] });

if (values.app) {
  cpSync(values.app, work, { recursive: true, filter: (path) => !/(^|\/)(node_modules|\.git)$/.test(path) });
} else {
  run('git', ['clone', '--quiet', '--filter=blob:none', APP.repository, '.']);
  run('git', ['checkout', '--quiet', APP.commit]);
}
run('pnpm', ['install', '--frozen-lockfile', '--ignore-scripts', '--silent']);
run('node', ['scripts/seed.ts']);

const store = new DiskArtifacts(ARTIFACTS);
const browser = await chromium.launch(BROWSER_LAUNCH);
const captures: Captures = { app: APP.commit, shots: {}, changed: {} };

try {
  for (const variant of VARIANTS) {
    const originals = variant.edits.map(([file]) => [file, readFileSync(join(work, file), 'utf-8')] as const);
    for (const [file, find, replace] of variant.edits) {
      const text = readFileSync(join(work, file), 'utf-8');
      if (!text.includes(find)) throw new Error(`${variant.name}: ${file} no longer contains ${find}`);
      writeFileSync(join(work, file), text.replaceAll(find, replace));
    }
    // A page of its own for each variant: the app closes gracefully, finishing what its open connections ask, so a
    // connection the browser kept open to one variant's copy would carry the next variant's requests to it.
    const page = await newPage(browser);
    const server = await start();
    try {
      for (const shot of variant.shots) {
        await page.goto(`http://localhost:${PORT}${shot.path}`, { waitUntil: 'networkidle' });
        if (shot.scroll) await page.locator(shot.scroll).evaluate((element) => element.scrollIntoView());
        const { hash, size, width, height, boxes } = await capture(page, store, {
          route: shot.route,
          version: 'v0.0.0',
          checks: shot.checks ?? [],
        });
        captures.shots[`${variant.name}/${shot.name}`] = { hash, size, width, height, route: shot.route, boxes };
        console.log(`${variant.name}/${shot.name}`.padEnd(28), hash.slice(0, 12), `${Math.round(size / 1024)} KB`);
      }
    } finally {
      await page.close();
      await stop(server);
      for (const [file, text] of originals) writeFileSync(join(work, file), text);
    }
  }
  const page = await newPage(browser);
  for (const variant of VARIANTS) {
    for (const name of COMPARE) {
      const shot = captures.shots[`${variant.name}/${name}`];
      const published = captures.shots[`published/${name}`];
      if (!shot || !published) continue;
      captures.changed[`${variant.name}/${name}`] = await difference(page, shot.hash, published.hash);
    }
  }
} finally {
  await browser.close();
  rmSync(work, { recursive: true, force: true });
}
writeFileSync(CAPTURES, `${JSON.stringify(captures, null, 2)}\n`);
console.log(`Wrote ${Object.keys(captures.shots).length} screenshots and ${CAPTURES}.`);

/** At 1x: sharp enough for a card on a dense screen, a quarter of the bytes for a phone, and a quarter of the memory
 * for a strip of thumbnails, which at 2x left the renderer out of room to draw them all. */
function newPage(browser: Browser): Promise<Page> {
  return browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
}

async function difference(page: Page, a: string, b: string): Promise<number> {
  if (a === b) return 0;
  const read = (hash: string) => readFileSync(join(ARTIFACTS, hash));
  return Math.round((await pixelDifference(page, read(a), read(b))) * 10_000) / 10_000;
}

/** Starts the scratch copy and waits until it answers: it alone, as the one before has exited and freed the port. */
async function start(): Promise<ChildProcess> {
  const server = spawn(process.execPath, ['src/server.ts'], {
    cwd: work,
    env: { ...process.env, PORT: String(PORT), LOG_LEVEL: 'silent', OTEL_SDK_DISABLED: 'true' },
    stdio: 'ignore',
  });
  for (let tries = 0; tries < 100 && server.exitCode === null; tries++) {
    if (
      await fetch(`http://localhost:${PORT}/health`).then(
        (r) => r.ok,
        () => false,
      )
    )
      return server;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await stop(server);
  throw new Error('The scratch copy of the app did not start');
}

/** Stops a scratch copy and waits until it has exited, so that nothing it held answers for the next. */
async function stop(server: ChildProcess): Promise<void> {
  if (server.exitCode !== null || server.signalCode !== null) return;
  const exited = new Promise((resolve) => server.once('exit', resolve));
  server.kill();
  await exited;
}
