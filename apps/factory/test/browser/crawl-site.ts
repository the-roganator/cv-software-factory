/**
 * A small site made for the crawler's tests: a home page, an about page and three items, with a stylesheet, a
 * script and an image. It is as any site should be, and each fault switches on one way it can go wrong, on one page
 * or on all of them. As the app does, it answers every request with the mark `private, no-store`, and lets a visitor
 * keep its assets.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { listenLocal } from '@software-factory/testing';

export type Fault =
  | 'dead-link'
  | 'dead-image'
  | 'not-an-image'
  | 'loop'
  | 'moved'
  | 'department-loops'
  | 'department-moves'
  | 'error-500'
  | 'console-home'
  | 'console-all'
  | 'no-alt-about'
  | 'no-alt-all'
  | 'contrast-about'
  | 'contrast-all'
  | 'unlabelled'
  | 'no-headers-home'
  | 'no-headers-all'
  | 'no-cache'
  | 'visitor-unanswered'
  | 'slow-about'
  | 'slow-all'
  | 'page-hangs'
  | 'no-answer'
  | 'leaky-missing'
  | 'leaky-malformed'
  | 'powered-by';

const ITEMS = ['a', 'b', 'c'];

/**
 * How long a slow answer takes, in milliseconds: over the threshold the tests give the crawler, which is shorter than
 * a real site's so that the tests are quick.
 */
export const SLOW_ANSWER = 700;

export interface Site {
  url: string;
  close(): Promise<void>;
}

export async function startSite(...faults: Fault[]): Promise<Site> {
  const has = (fault: Fault) => faults.includes(fault);

  const page = (path: string, title: string, body: string) => {
    const home = path === '/';
    const about = path === '/about';
    const throws = has('console-all') || (home && has('console-home'));
    const slightlyGrey = has('contrast-all') || (about && has('contrast-about'));
    // The products page, which only the department faults link to, has an image with no alt text whatever else is on.
    const unaltered = has('no-alt-all') || (about && has('no-alt-about')) || path === '/products';
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<link rel="stylesheet" href="/static/site.css"><script src="/static/site.js"></script></head>
<body><nav aria-label="Main"><a href="/">Home</a> <a href="/about">About</a> ${ITEMS.map((i) => `<a href="/items/${i}">Item ${i}</a>`).join(' ')}</nav>
<main><h1>${title}</h1>
<p style="color:${slightlyGrey ? '#aaaaaa' : '#222222'};background:#ffffff">Plain words on a plain page.</p>
<img src="/static/${has('dead-image') && home ? 'gone' : has('not-an-image') && home ? 'page' : 'dot'}.svg" ${unaltered ? '' : 'alt="A dot"'} width="20" height="20">
${body}${throws ? '<script>throw new Error("boom")</script>' : ''}</main></body></html>`;
  };

  const securityHeaders = (path: string): Record<string, string> =>
    has('no-headers-all') || (path === '/' && has('no-headers-home'))
      ? {}
      : {
          'content-security-policy':
            "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
          'x-content-type-options': 'nosniff',
          'referrer-policy': 'no-referrer',
          'x-frame-options': 'DENY',
        };

  const send = (res: ServerResponse, status: number, body: string, type = 'text/html; charset=utf-8', extra = {}) => {
    res.writeHead(status, { 'content-type': type, ...extra });
    res.end(body);
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const raw = req.url ?? '/';
    const path = raw.split('?')[0] as string;
    const marked = req.headers['x-unmeasured'] !== undefined;
    if (has('visitor-unanswered') && !marked && path.startsWith('/static/'))
      return send(res, 503, 'Busy', 'text/plain');
    const asset = {
      'cache-control': marked ? 'private, no-store' : has('no-cache') ? 'no-cache' : 'public, max-age=3600',
    };
    if (path === '/version') return send(res, 200, JSON.stringify({ commit: 'c'.repeat(40) }), 'application/json');
    if (has('slow-all') && path !== '/version') await new Promise((resolve) => setTimeout(resolve, SLOW_ANSWER));
    if (path === '/reset') return req.socket.destroy();
    // A page whose script is never sent, so that it never finishes loading.
    if (path === '/static/hang.js') return;
    if (path === '/hangs')
      return send(res, 200, '<!doctype html><title>Hangs</title><script src="/static/hang.js"></script>');
    if (path === '/static/site.css') return send(res, 200, 'body{font-family:sans-serif}', 'text/css', asset);
    if (path === '/static/site.js') return send(res, 200, 'void 0;', 'text/javascript', asset);
    if (path === '/static/dot.svg') {
      return send(
        res,
        200,
        '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><circle cx="10" cy="10" r="9"/></svg>',
        'image/svg+xml',
        asset,
      );
    }
    if (path === '/loop') {
      res.writeHead(302, { location: '/loop' });
      return res.end();
    }
    if (path === '/old-about') {
      res.writeHead(301, { location: '/about' });
      return res.end();
    }
    // A department's page: in a loop, or moved to the products in it.
    if (path === '/departments/home') {
      res.writeHead(302, { location: has('department-moves') ? '/products?department=home' : '/departments/home' });
      return res.end();
    }
    const departments = has('department-loops') || has('department-moves');
    if (path === '/' || path === '/about' || /^\/items\/[a-c]$/.test(path) || (departments && path === '/products')) {
      if (path === '/items/b' && has('error-500')) return send(res, 500, '<h1>Broken</h1>');
      if (path === '/about' && has('slow-about')) await new Promise((resolve) => setTimeout(resolve, SLOW_ANSWER));
      const extras = [
        path === '/' && has('dead-link') ? '<a href="/gone">Lost</a>' : '',
        path === '/' && has('page-hangs') ? '<a href="/hangs">Hangs</a>' : '',
        path === '/' && has('no-answer') ? '<a href="/reset">Reset</a>' : '',
        path === '/' && has('loop') ? '<a href="/loop">Offers</a>' : '',
        path === '/' && has('moved') ? '<a href="/old-about">About us</a>' : '',
        path === '/' && departments ? '<a href="/products">Products</a> <a href="/departments/home">Home</a>' : '',
        path === '/about' && has('unlabelled') ? '<form><input type="text" name="q"></form>' : '',
      ].join(' ');
      const title =
        path === '/'
          ? 'Home'
          : path === '/about'
            ? 'About'
            : path === '/products'
              ? 'Products'
              : `Item ${path.slice(-1)}`;
      return send(res, 200, page(path, title, extras), 'text/html; charset=utf-8', securityHeaders(path));
    }
    if (path === '/static/page') return send(res, 200, '<p>Not an image</p>');
    if (raw.includes('%E0')) {
      const body = has('leaky-malformed')
        ? '<pre>URIError: URI malformed\n    at decodeURIComponent (&lt;anonymous&gt;)\n    at /app/src/server.js:41:9</pre>'
        : '<p>Bad request.</p>';
      return send(res, 400, body);
    }
    const body = has('leaky-missing')
      ? '<pre>Error: no route\n    at handle (/Users/dev/shop/src/router.ts:88:15)\n    at next (/Users/dev/shop/node_modules/express/lib/router.js:12:3)</pre>'
      : '<p>No such page.</p>';
    return send(res, 404, body, 'text/html; charset=utf-8', has('powered-by') ? { 'x-powered-by': 'Express' } : {});
  };

  const server = createServer((req, res) => {
    handle(req, res).catch(() => send(res, 500, 'oops'));
  });
  const { url } = await listenLocal(server);
  return {
    url,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
