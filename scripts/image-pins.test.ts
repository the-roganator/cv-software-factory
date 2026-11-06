import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Docker's official images are pinned by digest, and Dependabot moves the pins it can read. Node is pinned in four
 * Dockerfiles, which Dependabot moves together; a pin left behind runs a different image from the others. Postgres
 * has one pin, its StatefulSet's, which everything else that runs it reads, so that Dependabot's update of it is the
 * whole update. Pins of one image share a name, a major version and a tag suffix (node 24's alpine3.24 and
 * trixie-slim are two images, and so are Postgres 18 and 19 side by side during an upgrade). Prose is left out.
 * Each is named on Docker Hub, with no registry, as a Dockerfile's FROM or a manifest's image: scripts/ci-images.sh
 * finds them the same way, with Playwright's (below), to copy them into CI's GHCR.
 */
const PIN = /(?:^FROM|image:) +(([a-z0-9._-]+)(?::([A-Za-z0-9._-]+))?@(sha256:[0-9a-f]{64}))/gm;
const POSTGRES = 'deploy/base/postgres/statefulset.yaml';

/** Each image's pins, each as [file, tag@digest], from every file but prose: one file can pin an image twice. */
function pins(read = (file: string) => readFileSync(file, 'utf-8')) {
  const files = execFileSync('git', ['grep', '-lE', PIN.source.replaceAll('(?:', '('), '--', ':!*.md'], {
    encoding: 'utf-8',
  });
  const found = new Map<string, [string, string][]>();
  for (const file of files.split('\n').filter(Boolean)) {
    for (const [, , name = '', tag, digest] of read(file).matchAll(PIN)) {
      const image = tag
        ? `${name}:${tag.split(/[.-]/)[0]}${tag.includes('-') ? tag.slice(tag.indexOf('-')) : ''}`
        : name;
      found.set(image, [...(found.get(image) ?? []), [file, `${tag ?? ''}@${digest}`]]);
    }
  }
  return found;
}

/** The first pin in a file, as written. */
const pinned = (source: string) => [...source.matchAll(PIN)][0]?.[1] ?? '';

const disagreeing = (found: ReturnType<typeof pins>) =>
  [...found].filter(([, where]) => new Set(where.map(([, pin]) => pin)).size > 1);

describe("the pins of Docker's official images", () => {
  const found = pins();

  it('are found', () => {
    expect([...found.keys()]).toEqual(expect.arrayContaining(['postgres:18-alpine3.24', 'node:24-alpine3.24']));
  });

  it('agree, image by image', () => {
    expect(disagreeing(found)).toEqual([]);
  });

  it('disagree when one file pins an image twice, differently', () => {
    const DOCKERFILE = 'apps/console/Dockerfile';
    const twice = (file: string) => {
      const source = readFileSync(file, 'utf-8');
      return file === DOCKERFILE
        ? `${source}\nFROM ${pinned(source).replace(/[0-9a-f]{64}$/, '2'.repeat(64))}\n`
        : source;
    };
    expect(disagreeing(pins(twice)).map(([image]) => image)).toEqual(['node:24-alpine3.24']);
  });

  it('pin Postgres once, in its StatefulSet', () => {
    const postgres = [...found].filter(([image]) => image.startsWith('postgres'));
    expect(postgres.flatMap(([, where]) => where.map(([file]) => file))).toEqual([POSTGRES]);
  });

  it("follow a Dependabot update of Postgres's one pin everywhere it runs", () => {
    const pin = pinned(readFileSync(POSTGRES, 'utf-8'));
    const moved = `postgres:18.7-alpine3.24@sha256:${'1'.repeat(64)}`;
    const bump = (file: string) => readFileSync(file, 'utf-8').replace(pin, moved);

    expect(disagreeing(pins((file) => (file === POSTGRES ? bump(file) : readFileSync(file, 'utf-8'))))).toEqual([]);

    // Admission's allow-list for the factory's namespaces, rendered from a copy of deploy/ with the pin moved.
    const copy = mkdtempSync(join(tmpdir(), 'image-pins-'));
    cpSync('deploy', join(copy, 'deploy'), { recursive: true });
    writeFileSync(join(copy, POSTGRES), bump(POSTGRES));
    const rendered = execFileSync('kustomize', ['build', join(copy, 'deploy/overlays/local')], {
      encoding: 'utf-8',
      maxBuffer: 64 * 1024 * 1024,
    });
    expect(rendered).toContain(`'${moved}'`);
    expect(rendered).not.toContain(pin);
  });
});

/**
 * Playwright's library and its browsers are one release: the library refuses browsers from another. The library is in
 * the lockfile; the browsers are in its image, pinned once, under the probes and the crawler (Dockerfile.browser), and
 * read from there where the browser tests run (check.yml, the Makefile). Dependabot moves them in one group, but
 * proposes each when it is ready, in a pull request of its own when the other is not (.github/dependabot.yml), and
 * this fails each half.
 */
const PLAYWRIGHT = /mcr\.microsoft\.com\/playwright:v(\d+\.\d+\.\d+)-noble@(sha256:[0-9a-f]{64})/g;

/** Every Playwright release in use, each as [where, version@digest]; the lockfile's entries have no digest. */
function playwright(read = (file: string) => readFileSync(file, 'utf-8')) {
  const files = execFileSync('git', ['grep', '-lE', 'mcr\\.microsoft\\.com/playwright', '--', ':!*.md'], {
    encoding: 'utf-8',
  });
  const images = files
    .split('\n')
    .filter(Boolean)
    .flatMap((file) =>
      [...read(file).matchAll(PLAYWRIGHT)].map(([, version, digest]): [string, string] => [
        file,
        `${version}@${digest}`,
      ]),
    );
  const libraries = [
    ...read('pnpm-lock.yaml').matchAll(/^ {2}'?((?:@playwright\/test|playwright|playwright-core)@\d+\.\d+\.\d+)'?:$/gm),
  ].map(([, entry = '']): [string, string] => [`pnpm-lock.yaml ${entry}`, entry.slice(entry.lastIndexOf('@') + 1)]);
  return { images, libraries };
}

const releases = ({ images, libraries }: ReturnType<typeof playwright>) =>
  new Set([...images.map(([, pin]) => pin.split('@')[0]), ...libraries.map(([, version]) => version)]);

describe("Playwright's pins", () => {
  const found = playwright();

  it('pin the image once, in Dockerfile.browser, and the library in the lockfile', () => {
    expect(found.images.map(([file]) => file)).toEqual(['apps/factory/Dockerfile.browser']);
    expect(found.libraries.map(([entry]) => entry.split(' ')[1]?.replace(/@[\d.]+$/, ''))).toEqual(
      expect.arrayContaining(['@playwright/test', 'playwright', 'playwright-core']),
    );
  });

  it('name one release, and one image of it', () => {
    expect(new Set(found.images.map(([, pin]) => pin)).size).toBe(1);
    expect([...releases(found)]).toHaveLength(1);
  });

  it('disagree when the image moves to a release the library has not', () => {
    const DOCKERFILE = 'apps/factory/Dockerfile.browser';
    const moved = (file: string) => {
      const source = readFileSync(file, 'utf-8');
      return file === DOCKERFILE
        ? source.replace(PLAYWRIGHT, `mcr.microsoft.com/playwright:v9.9.9-noble@sha256:${'3'.repeat(64)}`)
        : source;
    };
    expect(releases(playwright(moved)).size).toBe(2);
  });
});

/**
 * Node is one release on a laptop, in CI and in the dev container, which take it from mise.toml, and in the images,
 * which pin it. Dependabot moves the images' pins and not mise.toml, which moves by hand, so a Node update fails here
 * until mise.toml moves with it.
 *
 * The distroless runtime under the console and the factory carries a Node of its own that its tag does not name, so
 * nothing here can check it, and Dependabot moves it by digest in a pull request of its own. When Node moves, see what
 * its pin runs (`docker run --rm --entrypoint /nodejs/bin/node <pin> --version`) and take the digest that runs the new
 * release into the same change.
 *
 * Playwright's image, which the factory's browser image is built on, carries a Node of its own too, and that moves a
 * major when Playwright's does. So Dockerfile.browser takes that Node out and puts in the Node image's, which is
 * pinned like any other, and checked here with them.
 */
const MISE_NODE = /^node = "(\d+\.\d+\.\d+)"$/m;

/** mise.toml's Node, and each image's, as [file, version]. */
function node(read = (file: string) => readFileSync(file, 'utf-8')) {
  const images = [...pins(read)]
    .filter(([image]) => image.startsWith('node:'))
    .flatMap(([, where]) => where.map(([file, pin]): [string, string] => [file, pin.split(/[-@]/)[0] ?? '']));
  return { mise: MISE_NODE.exec(read('mise.toml'))?.[1], images };
}

const behind = ({ mise, images }: ReturnType<typeof node>) => images.filter(([, version]) => version !== mise);

describe("Node's release", () => {
  const found = node();

  it('is read from mise.toml and the images', () => {
    expect(found.mise).toMatch(/^\d+\.\d+\.\d+$/);
    expect(found.images.map(([file]) => file)).toEqual(
      expect.arrayContaining([
        'apps/console/Dockerfile',
        'apps/factory/Dockerfile',
        'apps/factory/Dockerfile.browser',
        'apps/runner/Dockerfile',
      ]),
    );
  });

  it("is mise.toml's in every image", () => {
    expect(behind(found)).toEqual([]);
  });

  it('disagrees when the images move to a release mise.toml has not', () => {
    const moved = (file: string) => readFileSync(file, 'utf-8').replace(/(FROM node:)\d+\.\d+\.\d+/g, '$124.99.0');
    expect(behind(node(moved)).map(([file]) => file)).toEqual(
      expect.arrayContaining([
        'apps/console/Dockerfile',
        'apps/factory/Dockerfile',
        'apps/factory/Dockerfile.browser',
        'apps/runner/Dockerfile',
      ]),
    );
  });

  it("is the Node image's in the browser image, in place of Playwright's own", () => {
    const browser = readFileSync('apps/factory/Dockerfile.browser', 'utf-8');
    const stage = browser.split(/^FROM browsers AS playwright$/m)[1]?.split(/^FROM /m)[0] ?? '';
    expect(stage).toMatch(/^RUN dpkg --purge nodejs /m);
    expect(stage).toContain('COPY --from=node /usr/local/bin/node /usr/local/bin/node');
    // pnpm comes through corepack, which `corepack enable` needs on the path.
    expect(stage).toContain(
      'COPY --from=node /usr/local/lib/node_modules/corepack /usr/local/lib/node_modules/corepack',
    );
    expect(stage).toContain('RUN ln -s ../lib/node_modules/corepack/dist/corepack.js /usr/local/bin/corepack');
    expect(stage).toContain('[ "$(which -a node)" = /usr/local/bin/node ]');
    // The probes' image and `make e2e` are built on that stage.
    expect(browser.match(/^FROM \S+/gm)?.slice(2)).toEqual(['FROM browsers', 'FROM playwright', 'FROM playwright']);
  });
});
