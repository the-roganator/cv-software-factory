/**
 * An image's registry, read as data by an anonymous reader: what a tag's digest is now, and which release of Node an
 * image at a digest runs; and which images run Node or are one release with a library, and how long mise waits for a
 * release. The daily scan reads it
 * (deadlines.ts), and the line's pin step (apps/runner/src/pins.ts, whose image copies this file alone), so the two
 * read one answer the same way. Node runs this with no dependencies, from a sparse checkout of this repository.
 */
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';

/** How the step reaches a registry: `fetch`, or a test's. */
export type Get = (url: string, init?: RequestInit) => Promise<Response>;

/** The step will not write this move, and says why: the work item fails its step, as any other failure. */
export class PinsRefused extends Error {
  override name = 'PinsRefused';
}

const DIGEST = /^sha256:[0-9a-f]{64}$/;

/**
 * An image that runs Node, whose `FROM` moves with mise's pin of Node: Node's own (`node`) and distroless's
 * (`nodejs24-debian13`), by the last part of its name; never one that only begins so, such as `node-exporter`.
 */
export const runsNode = (image: string) => /^node(js\d*(-[\w.-]*)?)?$/.test(image.split('/').at(-1) ?? '');

/**
 * The library an image is one release with, by the image's name: the packages of a lockfile that must be at the
 * release its tag names (`v1.65.1-noble` is 1.65.1). Playwright's browsers refuse a library of another release, and the
 * library refuses theirs (scripts/image-pins.test.ts).
 */
export const LIBRARIES: Readonly<Record<string, readonly string[]>> = {
  'mcr.microsoft.com/playwright': ['playwright', 'playwright-core', '@playwright/test'],
};

/** The library an image's move brings with it, if it brings one. */
export const libraryOf = (image: string): readonly string[] | undefined =>
  Object.hasOwn(LIBRARIES, image) ? LIBRARIES[image] : undefined;

/**
 * Whether an image's move brings another pin with it, which the pin step moves in the same change (apps/runner/src/
 * pins.ts's `moveImage`): the Node it runs, or its library. The one test of a move the pin step makes whole rather than
 * a pin's line alone.
 */
export const bringsPins = (image: string): boolean => runsNode(image) || libraryOf(image) !== undefined;

/** `mise.toml`'s `minimum_release_age`, in milliseconds: none when it sets none. */
export function releaseAge(miseToml: string): number {
  const m = /^minimum_release_age\s*=\s*"(\d+)([dhm])"\s*$/m.exec(miseToml);
  if (!m) return 0;
  return Number(m[1]) * { d: 86_400_000, h: 3_600_000, m: 60_000 }[m[2] as 'd' | 'h' | 'm'];
}

/**
 * When a GitHub release's downloads became what they are, as its releases API gives it: the later of its
 * `published_at` and each asset's `updated_at`, since a maintainer can upload an asset again to a release published
 * long before. Nothing for a release not published.
 */
export function releasedAt(release: { published_at?: unknown; assets?: unknown }): string | undefined {
  if (typeof release.published_at !== 'string' || Number.isNaN(Date.parse(release.published_at))) return undefined;
  let at = release.published_at;
  for (const asset of Array.isArray(release.assets) ? (release.assets as { updated_at?: unknown }[]) : []) {
    const updated = asset?.updated_at;
    if (typeof updated === 'string' && Date.parse(updated) > Date.parse(at)) at = updated;
  }
  return at;
}

const json = async (get: Get, url: string): Promise<unknown> => {
  const response = await get(url);
  if (!response.ok) throw new PinsRefused(`${url}: ${response.status}`);
  return JSON.parse(await response.text());
};

const MANIFESTS = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

/** An image's registry and repository there: Docker Hub's, by its own names, when the first part names no host. */
export function registryOf(image: string): { host: string; repository: string } {
  const [first = '', ...rest] = image.split('/');
  const hub = (path: string) => ({
    host: 'registry-1.docker.io',
    repository: path.includes('/') ? path : `library/${path}`,
  });
  // Docker Hub by the names it goes by, whose API is at registry-1.docker.io alone.
  if (['docker.io', 'index.docker.io', 'registry-1.docker.io'].includes(first) && rest.length)
    return hub(rest.join('/'));
  if (rest.length && (first.includes('.') || first.includes(':') || first === 'localhost'))
    return { host: first, repository: rest.join('/') };
  return hub(image);
}

/**
 * The digest a tag of an image has in its registry now, as the registry's API gives it, asking for a token where the
 * registry asks for one, as an anonymous reader. A digest that is not a SHA-256's is refused.
 */
export async function digestOf(image: string, tag: string, get: Get): Promise<string> {
  const response = await fromRegistry(image, `manifests/${tag}`, get, 'HEAD');
  if (!response.ok) throw new PinsRefused(`${image}:${tag} is not in its registry (${response.status}).`);
  const digest = response.headers.get('docker-content-digest') ?? '';
  if (!DIGEST.test(digest)) throw new PinsRefused(`${image}:${tag}'s registry gives no SHA-256 digest.`);
  return digest;
}

/**
 * One of an image's paths in its registry's API (`manifests/<tag>`, `blobs/<digest>`), asking for a token where the
 * registry asks for one, as an anonymous reader. A manifest is asked for in each form an image's may take.
 */
async function fromRegistry(image: string, path: string, get: Get, method = 'GET'): Promise<Response> {
  const { host, repository } = registryOf(image);
  const url = `https://${host}/v2/${repository}/${path}`;
  const headers: Record<string, string> = { accept: MANIFESTS };
  let response = await get(url, { method, headers });
  if (response.status === 401) {
    const challenge = response.headers.get('www-authenticate') ?? '';
    const fields = Object.fromEntries([...challenge.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
    if (!/^Bearer /i.test(challenge) || !fields.realm?.startsWith('https://'))
      throw new PinsRefused(`${host} asks for a sign-in the pin step does not make.`);
    const query = new URLSearchParams({
      ...(fields.service ? { service: fields.service } : {}),
      scope: `repository:${repository}:pull`,
    });
    const answer = (await json(get, `${fields.realm}?${query}`)) as { token?: string; access_token?: string };
    headers.authorization = `Bearer ${answer.token ?? answer.access_token ?? ''}`;
    response = await get(url, { method, headers });
  }
  return response;
}

/**
 * The bytes at one of an image's paths by digest (`manifests/<digest>`, `blobs/<digest>`), read only when the registry
 * gives them, and only when they are the bytes the digest names: an answer of any other bytes is refused, whoever gave
 * it.
 */
async function byDigest(image: string, path: string, get: Get): Promise<Buffer> {
  const digest = path.split('/').at(-1) ?? '';
  if (!DIGEST.test(digest)) throw new PinsRefused(`${image}'s ${path} names no SHA-256 digest.`);
  const response = await fromRegistry(image, path, get);
  if (!response.ok) throw new PinsRefused(`${image}'s ${path} is not in its registry (${response.status}).`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (`sha256:${createHash('sha256').update(bytes).digest('hex')}` !== digest)
    throw new PinsRefused(`${image}'s registry answers ${path} with bytes that are not its digest's.`);
  return bytes;
}

/** The JSON at one of an image's paths by digest, checked against it (`byDigest`). */
async function registryJson(image: string, path: string, get: Get): Promise<unknown> {
  return JSON.parse((await byDigest(image, path, get)).toString('utf-8'));
}

interface Manifest {
  manifests?: { digest?: string; platform?: { os?: string; architecture?: string } }[];
  config?: { digest?: string };
  layers?: { digest?: string; mediaType?: string }[];
}

/** Where Node's own builds say where they came from, in the binary: `process.release`'s URLs name the release. */
const RELEASE_URL = /https:\/\/nodejs\.org\/download\/release\/v(\d+\.\d+\.\d+)\//;

/**
 * The Node release an image runs, at a digest, read from the registry as data and never run: its configuration's
 * `NODE_VERSION`, as Node's own images set it, or else the release its `bin/node` names, as each of Node's builds
 * does in `process.release` (distroless's images set nothing in their configuration). Linux on amd64's image, which
 * runs the release every platform's does. Each layer is read, the last first, until one holds `bin/node`. Everything
 * is read by its digest, and each manifest, configuration and layer is held to it, so what decides the release is the
 * image at that digest and no other answer of its registry's.
 */
export async function nodeInImage(image: string, digest: string, get: Get): Promise<string> {
  let manifest = (await registryJson(image, `manifests/${digest}`, get)) as Manifest;
  if (manifest.manifests) {
    const linux = manifest.manifests.find((m) => m.platform?.os === 'linux' && m.platform.architecture === 'amd64');
    if (!linux?.digest || !DIGEST.test(linux.digest))
      throw new PinsRefused(`${image}@${digest} has no image for linux on amd64.`);
    manifest = (await registryJson(image, `manifests/${linux.digest}`, get)) as Manifest;
  }
  const config = manifest.config?.digest;
  if (!config || !DIGEST.test(config)) throw new PinsRefused(`${image}@${digest} names no configuration.`);
  const env = ((await registryJson(image, `blobs/${config}`, get)) as { config?: { Env?: string[] | null } }).config
    ?.Env;
  const named = env?.map((each) => /^NODE_VERSION=v?(\d+\.\d+\.\d+)$/.exec(each)?.[1]).find(Boolean);
  if (named) return named;
  for (const layer of [...(manifest.layers ?? [])].reverse()) {
    if (!layer.digest || !DIGEST.test(layer.digest)) continue;
    // A layer is a tar, gzipped or not; one compressed otherwise is passed over.
    const gzipped = /gzip$/.test(layer.mediaType ?? '');
    if (!gzipped && !/tar$/.test(layer.mediaType ?? '')) continue;
    // Read whole, so its bytes are held to its digest before any of them is believed.
    const bytes = await byDigest(image, `blobs/${layer.digest}`, get);
    const found = await nodeInTar(Readable.from([bytes]), gzipped);
    if (found) return found;
  }
  throw new PinsRefused(`${image}@${digest} names no Node release the pin step can read.`);
}

/**
 * The release a tar's `bin/node` names, read as the tar streams, or nothing when it has none. Each entry's header is
 * read for its name (a GNU long name, a pax `path`, or a ustar prefix and name) and size; `bin/node`'s bytes are read
 * for the release's URL, and the rest passed over.
 */
export async function nodeInTar(stream: Readable, gzipped: boolean): Promise<string | undefined> {
  const source = gzipped ? stream.pipe(createGunzip()) : stream;
  if (source !== stream) stream.on('error', (error) => source.destroy(error));
  let pending: Buffer = Buffer.alloc(0);
  /** What is left of the entry in hand, then its padding to the next 512 bytes. */
  let left = 0;
  let padding = 0;
  let reading = false;
  let tail = '';
  let longName: string | undefined;
  let longNext = false;
  let paxNext = false;
  let pax = '';
  try {
    for await (const chunk of source as AsyncIterable<Buffer>) {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      while (pending.length) {
        if (left > 0) {
          const take = Math.min(left, pending.length);
          const part = pending.subarray(0, take);
          if (reading) {
            const text = tail + part.toString('latin1');
            const m = RELEASE_URL.exec(text);
            if (m) return m[1];
            tail = text.slice(-120);
          } else if (longNext || paxNext) pax += part.toString('utf8');
          pending = pending.subarray(take);
          left -= take;
          if (left === 0) {
            if (longNext) longName = pax.replace(/\0.*$/s, '');
            if (paxNext) longName = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(pax)?.[1] ?? longName;
            if (longNext || paxNext) pax = '';
            longNext = false;
            paxNext = false;
            reading = false;
          }
          continue;
        }
        if (padding > 0) {
          const take = Math.min(padding, pending.length);
          pending = pending.subarray(take);
          padding -= take;
          continue;
        }
        if (pending.length < 512) break;
        const header = pending.subarray(0, 512);
        pending = pending.subarray(512);
        if (header.every((byte) => byte === 0)) return undefined;
        const field = (start: number, length: number) =>
          header
            .subarray(start, start + length)
            .toString('utf8')
            .replace(/\0.*$/s, '');
        const size = Number.parseInt(field(124, 12).trim() || '0', 8);
        const type = field(156, 1) || '0';
        const prefix = header.subarray(257, 262).toString('latin1') === 'ustar' ? field(345, 155) : '';
        const name = longName ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
        longName = undefined;
        left = Number.isFinite(size) ? size : 0;
        padding = (512 - (left % 512)) % 512;
        longNext = type === 'L';
        paxNext = type === 'x';
        reading = (type === '0' || type === '7') && /(^|\/)bin\/node$/.test(name.replace(/^\.\//, ''));
        tail = '';
        if (left === 0 && reading) reading = false;
      }
    }
    return undefined;
  } finally {
    stream.destroy();
    source.destroy();
  }
}
