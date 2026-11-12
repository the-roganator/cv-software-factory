/**
 * What each of the crawler's classes tells an agent: a crawl judged, folded into findings and into the signal the
 * runner sends, as the planner reads it (`seen`). Agents read a signal by its typed fields only, never its summary,
 * so each class's evidence must name what failed. A class the crawler gains needs a case here.
 */
import type { SymptomClass } from '@software-factory/events';
import { validateSignal } from '@software-factory/events/schemas';
import { describe, expect, it } from 'vitest';
import type { Crawl, Resource } from '../src/crawler/crawl.ts';
import { CLASSES, collapse } from '../src/crawler/index.ts';
import { type ErrorPage, judge, RECORDED } from '../src/crawler/judge.ts';
import { seen } from '../src/line/agents/evidence.ts';
import type { Exchange } from '../src/senses/http.ts';
import { signalOf } from '../src/senses/runner.ts';

const VERSION = '200855c';

/** What a page that passes every check sends. */
const GOOD: Record<string, string> = {
  'content-type': 'text/html; charset=utf-8',
  'content-security-policy': "default-src 'self'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
};

interface Answered {
  status?: number | null;
  headers?: Record<string, string>;
  body?: string;
  ms?: number;
  failure?: Exchange['failure'];
  redirects?: Array<{ status: number; location: string }>;
}

/** An answer as `exchange` gives one, its evidence recording the headers the crawler records. */
function answer(
  path: string,
  { status = 200, headers = GOOD, body = '', ms = 10, failure, redirects = [] }: Answered = {},
) {
  const recorded = [...new Set(['content-type', 'cache-control', 'location', ...RECORDED])];
  return {
    status,
    body,
    type: headers['content-type']?.split(';')[0] ?? null,
    evidence: {
      kind: 'http' as const,
      method: 'GET' as const,
      url: path,
      status,
      headers: Object.fromEntries(recorded.map((name) => [name, headers[name] ?? null])),
      timings: { firstByteMs: Math.min(ms, 5), totalMs: ms },
      redirects,
    },
    headers,
    landed: path,
    ...(failure && { failure }),
  } satisfies Exchange;
}

const PAGES = ['/', '/about', '/contact'];

/** A crawl of three pages that pass every check, with what a case adds or changes. */
function crawlOf({
  headers = GOOD,
  resources = [],
  pages = {},
}: {
  headers?: Record<string, string>;
  resources?: Resource[];
  pages?: Record<string, Partial<Crawl['pages'][number]>>;
} = {}): Crawl {
  return {
    resources: [
      ...PAGES.map((path) => ({ path, kind: 'link' as const, from: '/', answer: answer(path, { headers }) })),
      ...resources,
    ],
    pages: PAGES.map((path) => ({ path, console: [], accessibility: [], ...pages[path] })),
    unbrowsed: [],
    capped: false,
  };
}

const NOT_FOUND = (body = 'Not found', headers: Record<string, string> = { 'content-type': 'text/html' }) => [
  {
    what: 'a page that is not there',
    route: '/:missing',
    answer: answer('/no-such-page', { status: 404, body, headers }),
  },
];

interface Case {
  crawl: Crawl;
  errors?: ErrorPage[];
  secure?: boolean;
  /** Lines `seen` must tell the agent, each naming what failed. */
  tells: string[];
  /** What it must not tell as failed. */
  not?: RegExp;
}

const axe = (symptom: 'missing-alt' | 'low-contrast' | 'unlabelled-field', rule: string) =>
  crawlOf({
    pages: {
      '/about': {
        accessibility: [
          { rule, impact: 'serious', help: `axe's ${rule} help`, symptom, elements: [{ selector: '#it' }] },
        ],
      },
    },
  });

const CASES: Record<(typeof CLASSES)[number], Case> = {
  'broken-link': {
    crawl: crawlOf({
      resources: [{ path: '/gone', kind: 'link', from: '/about', answer: answer('/gone', { status: 404 }) }],
    }),
    tells: ['GET /gone answered 404'],
  },
  'broken-image': {
    crawl: crawlOf({
      resources: [{ path: '/img/cat.png', kind: 'image', from: '/', answer: answer('/img/cat.png') }],
    }),
    tells: ['GET /img/cat.png answered 200', 'content-type: text/html; charset=utf-8'],
  },
  'redirect-loop': {
    crawl: crawlOf({
      resources: [
        {
          path: '/loop',
          kind: 'link',
          from: '/',
          answer: answer('/loop', {
            status: null,
            failure: 'redirect loop',
            redirects: [
              { status: 302, location: '/loop/' },
              { status: 302, location: '/loop' },
            ],
          }),
        },
      ],
    }),
    tells: ['GET /loop answered nothing', 'redirected 302 to /loop/', 'redirected 302 to /loop'],
  },
  'server-error': {
    crawl: crawlOf({
      resources: [{ path: '/boom', kind: 'link', from: '/', answer: answer('/boom', { status: 500 }) }],
    }),
    tells: ['GET /boom answered 500'],
  },
  'browser-error': {
    crawl: crawlOf({ pages: { '/about': { console: [{ text: 'TypeError: x is undefined', source: '/app.js' }] } } }),
    tells: ["the browser's console on /about, error: TypeError: x is undefined (/app.js)"],
  },
  'missing-alt': { crawl: axe('missing-alt', 'image-alt'), tells: ["axe's image-alt (serious) on /about"] },
  'low-contrast': { crawl: axe('low-contrast', 'color-contrast'), tells: ["axe's color-contrast (serious) on /about"] },
  'unlabelled-field': { crawl: axe('unlabelled-field', 'label'), tells: ["axe's label (serious) on /about"] },
  'missing-header': {
    // As on work item #1013: no CSP and no X-Frame-Options, over plain HTTP, where Strict-Transport-Security is not
    // asked for though it is recorded, absent.
    crawl: crawlOf({
      headers: { 'content-type': 'text/html', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' },
    }),
    tells: ['missing: content-security-policy, x-frame-options (or frame-ancestors in the CSP)'],
    not: /missing: .*(strict-transport-security|x-content-type-options|referrer-policy)/,
  },
  'not-cached': {
    crawl: crawlOf({
      resources: [
        {
          path: '/app.js',
          kind: 'asset',
          from: '/',
          answer: answer('/app.js', { headers: { 'content-type': 'text/javascript' } }),
          visitor: answer('/app.js', { headers: { 'content-type': 'text/javascript', 'cache-control': 'no-store' } }),
        },
      ],
    }),
    tells: ['GET /app.js answered 200', 'cache-control: no-store'],
  },
  'slow-response': {
    crawl: crawlOf({ resources: [{ path: '/slow', kind: 'link', from: '/', answer: answer('/slow', { ms: 2_500 }) }] }),
    tells: ['GET /slow answered 200 in 2500 ms'],
  },
  'leaks-detail': {
    crawl: crawlOf(),
    errors: NOT_FOUND('Error: no such page\n    at handle (/app/src/server.js:12:5)', {
      'content-type': 'text/html',
      server: 'nginx',
      'x-powered-by': 'Express',
    }),
    tells: ['GET /no-such-page answered 404', 'gives away: a stack trace, a file path, an X-Powered-By header'],
    // Server names its software but not its version, which is not a giveaway.
    not: /gives away: .*Server/,
  },
};

/** The signals the crawler would send for a case, each as the planner is told it. */
function told({ crawl, errors = NOT_FOUND(), secure = false }: Case) {
  const { issues } = judge({ crawl, errors, secure, version: VERSION, template: (path) => path });
  const { findings } = collapse(
    issues,
    crawl.pages.map((p) => p.path),
  );
  return findings.map((finding) => {
    const signal = signalOf(
      'crawler',
      { check: `${finding.symptom}@${finding.route}`, route: finding.route, finding, artifacts: [] },
      VERSION,
      new Date('2026-11-02T10:00:00Z'),
    );
    return { symptom: finding.symptom, signal, lines: seen(signal).join('\n') };
  });
}

describe("what each of the crawler's classes tells an agent", () => {
  it('has a case for every class', () => {
    expect(Object.keys(CASES).sort()).toEqual([...CLASSES].sort());
  });

  it.each(Object.entries(CASES) as Array<[SymptomClass, Case]>)('names what failed, for %s', (symptom, c) => {
    const signals = told(c);
    // The case's class, and nothing else: the rest of its crawl passes.
    expect(signals.map((s) => s.symptom)).toEqual([symptom]);
    const [{ signal, lines }] = signals as [(typeof signals)[number]];
    expect(validateSignal(signal)).toEqual({ ok: true });
    for (const line of c.tells) expect(lines).toContain(line);
    if (c.not) expect(lines).not.toMatch(c.not);
    // What failed is in the typed fields, not only in the summary, which no agent reads.
    expect(lines).not.toContain(signal.summary);
  });

  it('asks for Strict-Transport-Security over HTTPS, and takes frame-ancestors in the CSP for X-Frame-Options', () => {
    const headers = { ...GOOD, 'content-security-policy': "frame-ancestors 'none'", 'x-frame-options': '' };
    const [found] = told({ crawl: crawlOf({ headers }), secure: true, tells: [] });
    expect(found?.lines).toContain('missing: strict-transport-security');
    expect(found?.lines).not.toMatch(/missing: .*x-frame-options/);
  });

  it('names an x-content-type-options that is sent without nosniff as missing', () => {
    const [found] = told({ crawl: crawlOf({ headers: { ...GOOD, 'x-content-type-options': 'yes' } }), tells: [] });
    expect(found?.lines).toContain('missing: x-content-type-options (as nosniff)');
  });

  it('names the version in Server as a giveaway', () => {
    const errors = NOT_FOUND('Not found', { 'content-type': 'text/html', server: 'nginx/1.25.3' });
    const [found] = told({ crawl: crawlOf(), errors, tells: [] });
    expect(found?.lines).toContain('gives away: its software’s version in Server');
  });
});
