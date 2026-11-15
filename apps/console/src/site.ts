/**
 * The built page and its files, read once at startup from Vite's output (`dist/`, made by `vite build`). A file
 * the manifest lists but the build lacks stops the server before it listens.
 *
 * The page is told the profile whose policy bounds Martin's settings, and whether the gateway sends every agent to the
 * local model, from the same FACTORY_PROFILE and ALL_LOCAL the gateway reads: a visitor needs the bounds as much as he
 * does, and they are no secret. It is told the two repositories the factory looks after (policy/repositories.ts), for
 * which rows are the app's and where its links go.
 *
 * Text files are compressed once, here, with Brotli and gzip, so each request only picks the encoding.
 */
import { existsSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';
import { MODELS } from '../../../policy/models.ts';
import { REAL, type Repositories, repositoriesFrom } from '../../../policy/repositories.ts';
import { PROFILES, type Profile } from '../../../policy/spend.ts';

export const DIST = fileURLToPath(new URL('../dist/', import.meta.url));

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.svg']);

export interface File {
  type: string;
  body: Buffer;
  br?: Buffer;
  gzip?: Buffer;
}

export interface Site {
  /** The page, at `/`. Never cached, so a deploy shows at once. */
  page: File;
  /** Every other built file, by its path. Each name carries a hash of its contents, so it is cached for a year. */
  files: Map<string, File>;
}

interface ManifestChunk {
  file: string;
  css?: string[];
  assets?: string[];
}

/** What the server tells the page of the factory it serves. */
export interface PageSettings {
  profile: Profile;
  allLocal: boolean;
  /** The app's origin, which the flags' "Preview it on the app" opens: none, and the console draws no such link. */
  app?: string;
  /** The factory's and the app's repositories, from FACTORY_REPOSITORY and APP_REPOSITORY. */
  repositories: Repositories;
}

/**
 * The page's settings from the environment, as the gateway reads them: an unknown profile, or `ALL_LOCAL` on a profile
 * with no local model, stops the server.
 */
export function pageSettings(env: NodeJS.ProcessEnv): PageSettings {
  const profile = (env.FACTORY_PROFILE || 'local').trim() as Profile;
  if (!PROFILES.includes(profile)) {
    throw new Error(`FACTORY_PROFILE is ${JSON.stringify(profile)}; it must be one of ${PROFILES.join(', ')}.`);
  }
  const allLocal = env.ALL_LOCAL === 'true';
  // As the gateway refuses it: no page says every agent is on a local model the profile does not have.
  if (allLocal && !MODELS[profile].local) {
    throw new Error(`ALL_LOCAL sends every agent to the local model, and the ${profile} profile has none.`);
  }
  return { profile, allLocal, ...appOf(env.APP_URL), repositories: repositoriesFrom(env) };
}

/** APP_URL as the page may link to it: an http or https address with no credentials, by its origin alone. */
function appOf(given: string | undefined): { app?: string } {
  if (!given) return {};
  let url: URL;
  try {
    url = new URL(given);
  } catch {
    throw new Error(`APP_URL is ${JSON.stringify(given)}; it must be the app's http or https address, or unset.`);
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
    throw new Error(`APP_URL is ${JSON.stringify(given)}; it must be the app's http or https address, or unset.`);
  }
  return { app: url.origin };
}

/** The built page with the profile, ALL_LOCAL, the app's address and the two repositories written into its meta tags. */
export function withSettings(html: string, { profile, allLocal, app, repositories }: PageSettings): string {
  return html
    .replace('<meta name="sf-profile" content="local">', `<meta name="sf-profile" content="${profile}">`)
    .replace('<meta name="sf-all-local" content="false">', `<meta name="sf-all-local" content="${allLocal}">`)
    .replace('<meta name="sf-app" content="">', `<meta name="sf-app" content="${app ?? ''}">`)
    .replace(
      '<meta name="sf-factory-repository" content="">',
      `<meta name="sf-factory-repository" content="${repositories.factory}">`,
    )
    .replace(
      '<meta name="sf-app-repository" content="">',
      `<meta name="sf-app-repository" content="${repositories.app}">`,
    );
}

export function loadSite(
  dist = DIST,
  settings: PageSettings = { profile: 'local', allLocal: false, repositories: REAL },
): Site {
  if (!existsSync(join(dist, '.vite/manifest.json')) && process.env.NODE_ENV !== 'production') {
    // In development Vite serves the page; this server only answers for events and artifacts.
    const page = {
      type: 'text/plain; charset=utf-8',
      body: Buffer.from('In development, Vite serves the page on :5173.\n'),
    };
    return { page, files: new Map() };
  }
  const manifest = JSON.parse(readFileSync(join(dist, '.vite/manifest.json'), 'utf-8')) as Record<
    string,
    ManifestChunk
  >;
  const paths = new Set(
    Object.values(manifest).flatMap((chunk) => [chunk.file, ...(chunk.css ?? []), ...(chunk.assets ?? [])]),
  );
  const files = new Map([...paths].map((path) => [`/${path}`, read(join(dist, path))]));
  return { page: read(join(dist, 'index.html'), (html) => withSettings(html, settings)), files };
}

function read(file: string, rewrite?: (text: string) => string): File {
  const extension = extname(file);
  const type = TYPES[extension];
  if (!type) throw new Error(`The build made ${file}, a kind of file the console does not serve`);
  const body = rewrite ? Buffer.from(rewrite(readFileSync(file, 'utf-8'))) : readFileSync(file);
  if (!COMPRESSIBLE.has(extension)) return { type, body };
  return {
    type,
    body,
    br: brotliCompressSync(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }),
    gzip: gzipSync(body, { level: 9 }),
  };
}
