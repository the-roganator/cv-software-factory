/**
 * A small shop made for the tests: a few pages and some JSON, served over HTTP, that a probe can be run against. It
 * behaves as any shop should, and each fault switches on one way it can go wrong, so each check is proved to pass
 * on a shop that is right and to fail, with the symptom it names, on one that is not.
 */
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import { listenLocal } from '@software-factory/testing';

export type Fault =
  | 'catalogue-404'
  | 'catalogue-500'
  | 'catalogue-empty'
  | 'link-404'
  | 'link-loop'
  | 'featured-loop'
  | 'department-wrong'
  | 'catalogue-price'
  | 'catalogue-name'
  | 'catalogue-gap'
  | 'catalogue-repeat'
  | 'filter-leak'
  | 'next-page-500'
  | 'price-run-on'
  | 'product-price'
  | 'product-heading'
  | 'product-404'
  | 'product-500'
  | 'search-misses'
  | 'search-case'
  | 'search-everything'
  | 'search-500'
  | 'search-400'
  | 'contact-refuses'
  | 'contact-422'
  | 'contact-500'
  | 'contact-thanks-with-form'
  | 'console-error'
  | 'broken-image'
  | 'keeps-cookie'
  | 'keeps-storage'
  | 'asks-elsewhere'
  | 'preview-unasked'
  | 'preview-loose';

/** The flags the shop knows, which `?preview=` may name, as the app's flags are those flagd knows. */
const FLAGS = new Set(['dark-mode', 'big-buttons']);

interface Item {
  slug: string;
  name: string;
  department: string;
  pence: number;
}

const ITEMS: Item[] = [
  { slug: 'brass-lamp', name: 'Brass lamp', department: 'home', pence: 1250 },
  { slug: 'tin-whistle', name: 'Tin whistle', department: 'desk', pence: 399 },
  { slug: 'garden-trowel', name: 'Garden trowel', department: 'outdoors', pence: 275 },
  { slug: 'oak-stool', name: 'Oak stool', department: 'home', pence: 4500 },
  { slug: 'pencil-case', name: 'Pencil case', department: 'desk', pence: 180 },
  { slug: 'rain-hat', name: 'Rain hat', department: 'outdoors', pence: 1999 },
  { slug: 'brass-hook', name: 'Brass hook', department: 'home', pence: 95 },
  { slug: 'brass-bell', name: 'Brass bell', department: 'home', pence: 1100 },
];
const PAGE_SIZE = 3;
const DEPARTMENTS = ['home', 'desk', 'outdoors'];
const COMMIT = 'a'.repeat(40);

const money = (pence: number) => `£${(pence / 100).toFixed(2)}`;
const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export interface Shop {
  url: string;
  /** Every message the contact form accepted. */
  messages: Array<Record<string, string>>;
  /** Every request the shop was sent, with its headers. */
  requests: Array<{ url: string; headers: IncomingHttpHeaders }>;
  close(): Promise<void>;
}

/** Starts a shop on a free port, with the given faults switched on. */
export async function startShop(...faults: Fault[]): Promise<Shop> {
  const has = (fault: Fault) => faults.includes(fault);
  const messages: Array<Record<string, string>> = [];
  const requests: Shop['requests'] = [];

  const page = (title: string, body: string, head = '') => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>${head}</head>
<body><header><nav aria-label="Main"><ul>
<li><a href="/">Home</a></li><li><a href="/products">Products</a></li><li><a href="/search">Search</a></li><li><a href="/contact">Contact</a></li>
</ul></nav></header><main><h1>${escapeHtml(title)}</h1>${body}</main></body></html>`;

  /** A price with text against it: no space, a comma, a unit, as a page may write it. */
  const shown = (pence: number) =>
    has('price-run-on') ? `${money(pence)}<small>In stock</small>, ${money(pence)}/each` : money(pence);

  const card = (item: Item, mutate = true) => {
    const name = mutate && has('catalogue-name') && item.slug === 'tin-whistle' ? `${item.name}!` : item.name;
    const pence = mutate && has('catalogue-price') && item.slug === 'oak-stool' ? item.pence + 1 : item.pence;
    return `<li><img src="/assets/${has('broken-image') ? 'missing' : 'item'}.svg" alt="" width="40" height="40"><h3><a href="/products/${item.slug}">${escapeHtml(name)}</a></h3><p>${shown(pence)}</p></li>`;
  };

  const listing = (items: Item[], base: string, requested: number) => {
    const pages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
    let shown = items.slice((requested - 1) * PAGE_SIZE, requested * PAGE_SIZE);
    if (requested === 2 && has('catalogue-gap')) shown = shown.slice(1);
    if (requested === 2 && has('catalogue-repeat') && items[PAGE_SIZE - 1])
      shown = [items[PAGE_SIZE - 1] as Item, ...shown];
    const joiner = base.includes('?') ? '&' : '?';
    const next = requested < pages ? `<a href="${base}${joiner}page=${requested + 1}" rel="next">Next page</a>` : '';
    return `<ul class="cards">${shown.map((item) => card(item)).join('')}</ul><nav aria-label="Pages"><p>Page ${requested} of ${pages}</p>${next}</nav>`;
  };

  const matches = (item: Item, query: string): boolean => {
    if (has('search-everything')) return true;
    const words = item.name.split(/\s+/);
    const wanted = query.trim();
    if (!wanted) return false;
    if (has('search-misses') && /^[a-z]+$/.test(wanted)) return false;
    return has('search-case')
      ? words.includes(wanted)
      : words.some((word) => word.toLowerCase() === wanted.toLowerCase());
  };

  const send = (res: ServerResponse, status: number, body: string, type = 'text/html; charset=utf-8') => {
    res.writeHead(status, { 'content-type': type });
    res.end(body);
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://shop.test');
    const path = url.pathname;
    const requested = Math.max(1, Number(url.searchParams.get('page')) || 1);

    // `?preview=<flag>` on any page adds a flag the shop knows to its preview cookie, as the app's contract says
    // (docs/COMPONENTS/FEATURE-FLAGS.md); `preview-loose` sets it readable by a script, for a year, and
    // `preview-unasked` sets it on the home page for a flag nobody asked for.
    const asked = url.searchParams.get('preview');
    const unasked = has('preview-unasked') && path === '/' && 'big-buttons';
    const flag = (asked !== null && FLAGS.has(asked) && asked) || unasked;
    if (flag) {
      const had = /(?:^|;\s*)preview=([^;]*)/.exec(req.headers.cookie ?? '')?.[1]?.split('.') ?? [];
      const names = [...new Set([...had.filter((name) => FLAGS.has(name)), flag])].join('.');
      res.setHeader(
        'set-cookie',
        has('preview-loose')
          ? `preview=${names}; Path=/; Max-Age=31536000; SameSite=Lax`
          : `preview=${names}; Path=/; Max-Age=86400; HttpOnly; SameSite=Lax`,
      );
    }

    if (path === '/version') return send(res, 200, JSON.stringify({ commit: COMMIT }), 'application/json');
    if (path === '/assets/item.svg') {
      return send(
        res,
        200,
        '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><circle cx="20" cy="20" r="18"/></svg>',
        'image/svg+xml',
      );
    }
    if (path === '/api/products') {
      const all = ITEMS.map((i) => ({
        slug: i.slug,
        name: i.name,
        department: i.department,
        pricePence: i.pence,
        price: money(i.pence),
      }));
      const body = {
        products: all.slice((requested - 1) * PAGE_SIZE, requested * PAGE_SIZE),
        page: requested,
        pages: Math.ceil(all.length / PAGE_SIZE),
        total: all.length,
      };
      return send(res, 200, JSON.stringify(body), 'application/json');
    }
    if (path === '/about') {
      // Sixty sentences, one repeated, and one that runs on past any limit.
      const sentences = Array.from({ length: 60 }, (_, i) => `Sentence number ${i} is here.`);
      return send(
        res,
        200,
        page(
          'About',
          `<p>${sentences.join(' ')} Sentence number 0 is here. ${'Long '.repeat(80)}end.</p>${has('featured-loop') ? '<a href="/featured/brass-hook">Hook</a> <a href="/featured/rain-hat">Hat</a>' : ''}`,
        ),
      );
    }
    // A page that has moved, which nothing links: the page reader asked for it ends at the about page.
    if (path === '/moved') {
      res.writeHead(302, { location: '/about' });
      return res.end();
    }
    // A page that has moved off the shop, to another origin at the same path: localhost is not 127.0.0.1's origin.
    if (path === '/away' && url.searchParams.has('there'))
      return send(res, 200, page('Elsewhere', '<p>Not the shop.</p>'));
    if (path === '/away') {
      res.writeHead(302, { location: `http://localhost:${req.socket.localPort}/away?there=1` });
      return res.end();
    }
    if (path === '/loop') {
      res.writeHead(302, { location: '/loop' });
      return res.end();
    }
    // A featured item that loops, one of several the about page links: only a look past the home page shows they
    // are a collection.
    if (has('featured-loop') && path.startsWith('/featured/')) {
      if (path === '/featured/oak-stool') {
        res.writeHead(302, { location: path });
        return res.end();
      }
      return send(res, 200, page('Featured', '<p>Featured.</p>'));
    }
    if (has('next-page-500') && requested > 1 && (path === '/products' || path.startsWith('/departments/')))
      return send(res, 500, page('Broken', '<p>Something went wrong.</p>'));
    if (path === '/') {
      const extra = `${has('link-404') ? '<li><a href="/missing">Lost property</a></li>' : ''}${has('link-loop') ? '<li><a href="/loop">Offers</a></li>' : ''}${has('featured-loop') ? '<li><a href="/featured/oak-stool">Featured</a></li><li><a href="/about">About</a></li>' : ''}`;
      const departments = DEPARTMENTS.map((d) => `<li><a href="/departments/${d}">${d}</a></li>`).join('');
      const script = has('console-error') ? '<script>throw new Error("boom")</script>' : '';
      const device = `${has('keeps-cookie') ? '<script>document.cookie = "visit=1; path=/"</script>' : ''}${has('asks-elsewhere') ? '<img src="http://elsewhere.invalid/pixel.png" alt="" width="1" height="1">' : ''}`;
      return send(res, 200, page('Welcome', `<ul>${departments}${extra}</ul><p>${script}${device}Good day.</p>`));
    }
    if (path === '/products') {
      if (has('catalogue-404')) return send(res, 404, page('Not found', '<p>No such page.</p>'));
      if (has('catalogue-500')) return send(res, 500, page('Broken', '<p>Something went wrong.</p>'));
      const department = url.searchParams.get('department');
      let items = department ? ITEMS.filter((i) => i.department === department) : ITEMS;
      if (department && has('filter-leak')) items = [...items, ITEMS.find((i) => i.department !== department) as Item];
      const filters = DEPARTMENTS.map((d) => `<li><a href="/products?department=${d}">${d}</a></li>`).join('');
      const base = department ? `/products?department=${department}` : '/products';
      return send(
        res,
        200,
        page(
          'Products',
          `<ul class="filter">${filters}</ul>${has('catalogue-empty') ? '<p>Nothing today.</p>' : listing(items, base, requested)}`,
        ),
      );
    }
    const department = path.match(/^\/departments\/([^/]+)$/)?.[1];
    if (department) {
      let items = ITEMS.filter((i) => i.department === department);
      if (has('department-wrong')) items = items.slice(1);
      return send(res, 200, page(department, listing(items, path, requested)));
    }
    const slug = path.match(/^\/products\/([^/]+)$/)?.[1];
    if (slug) {
      const item = ITEMS.find((i) => i.slug === slug);
      if (!item || (has('product-404') && slug === 'pencil-case'))
        return send(res, 404, page('Not found', '<p>No such product.</p>'));
      if (has('product-500') && slug === 'rain-hat')
        return send(res, 500, page('Broken', '<p>Something went wrong.</p>'));
      const heading = has('product-heading') && slug === 'oak-stool' ? 'Stool' : item.name;
      const pence = has('product-price') && slug === 'brass-hook' ? item.pence + 1 : item.pence;
      return send(
        res,
        200,
        page(
          heading,
          `<img src="/assets/${has('broken-image') ? 'missing' : 'item'}.svg" alt="${escapeHtml(item.name)}" width="40" height="40"><p>${shown(pence)}</p><p>A fine thing.</p>${has('keeps-storage') ? '<script>localStorage.setItem("seen", "1"); sessionStorage.setItem("viewed", "1")</script>' : ''}`,
        ),
      );
    }
    if (path === '/search') {
      const query = url.searchParams.get('q');
      if (query !== null && has('search-500') && query.includes('%'))
        return send(res, 500, page('Broken', '<p>Something went wrong.</p>'));
      if (query !== null && has('search-400') && query.includes("'"))
        return send(res, 400, page('Bad request', '<p>Bad.</p>'));
      const form = `<form role="search" method="get" action="/search"><input type="search" name="q" value="${escapeHtml(query ?? '')}" maxlength="100"><button type="submit">Search</button></form>`;
      const found = query === null ? [] : ITEMS.filter((i) => matches(i, query));
      const results =
        query === null
          ? ''
          : found.length
            ? `<ul class="cards">${found.map((i) => card(i, false)).join('')}</ul>`
            : '<p>No results.</p>';
      return send(res, 200, page('Search', form + results));
    }
    if (path === '/contact') {
      const form = (error = '', values: Record<string, string> = {}) =>
        `<form method="post" action="/contact" novalidate>${error ? `<p role="alert">${error}</p>` : ''}
<label for="name">Name</label><input type="text" id="name" name="name" value="${escapeHtml(values.name ?? '')}">
<label for="email">Email</label><input type="email" id="email" name="email" value="${escapeHtml(values.email ?? '')}">
<label for="message">Message</label><textarea id="message" name="message" maxlength="2000">${escapeHtml(values.message ?? '')}</textarea>
<button type="submit">Send</button></form>`;
      if (req.method !== 'POST') return send(res, 200, page('Contact', form()));
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const values = Object.fromEntries(new URLSearchParams(raw));
      if (has('contact-500')) return send(res, 500, page('Broken', '<p>Something went wrong.</p>'));
      if (has('contact-422') && (values.name ?? '').includes("'")) {
        return send(res, 422, page('Contact', form('Your name is not valid.', values)));
      }
      if (has('contact-refuses')) return send(res, 200, page('Contact', form('Please try again.', values)));
      messages.push(values);
      if (has('contact-thanks-with-form')) {
        return send(
          res,
          200,
          page(
            'Contact',
            `<p role="alert">Thank you, your message is on its way.</p>${form().replace('>Email<', '>Email (required)<').replace('<label for="name"', '<p class="error-hint">All fields are required.</p><label for="name"')}`,
          ),
        );
      }
      return send(res, 200, page('Thank you', '<p>Your message is on its way.</p>'));
    }
    return send(res, 404, page('Not found', '<p>No such page.</p>'));
  };

  const server = createServer((req, res) => {
    requests.push({ url: req.url ?? '', headers: req.headers });
    handle(req, res).catch(() => send(res, 500, 'oops'));
  });
  const { url } = await listenLocal(server);
  return {
    url,
    messages,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
