import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * mise.toml names the releases each tool may move within, and mise.lock the one each is at, with its download and
 * checksum for every platform the toolchain runs on. CI installs with `--locked`, which fails when the lock has no entry
 * for a request, but only for the tools and the platform it installs: this holds the rest to the lock too, so a Mac or
 * the dev container never resolves a version of its own.
 */
const read = (file: string) => readFileSync(file, 'utf-8').replace(/\r\n?/g, '\n');

/** Each tool in mise.toml's [tools], with its request. */
function requests(toml = read('mise.toml')): Map<string, string> {
  const tools = toml.slice(toml.indexOf('\n[tools]\n')).split(/\n\[(?!tools\])/)[0] ?? '';
  return new Map([...tools.matchAll(/^([\w-]+) = "([^"]+)"$/gm)].map(([, tool = '', request = '']) => [tool, request]));
}

/** The platforms mise.toml's settings lock. */
function platforms(toml = read('mise.toml')): string[] {
  const list = /^lockfile_platforms = \[([^\]]*)\]$/m.exec(toml)?.[1] ?? '';
  return [...list.matchAll(/"([^"]+)"/g)].map(([, platform = '']) => platform);
}

interface Locked {
  version: string;
  specifiers: string[];
  /** Each platform locked, with whether it has a download and its checksum. */
  platforms: Map<string, { url: boolean; checksum: boolean }>;
}

/** Each tool in mise.lock. */
function locked(lock = read('mise.lock')): Map<string, Locked> {
  const tools = new Map<string, Locked>();
  for (const [, tool = '', body = ''] of lock.matchAll(/^\[\[tools\.([\w-]+)\]\]\n([\s\S]*?)(?=^\[\[|(?![\s\S]))/gm)) {
    const specifiers = /^specifiers = \[([^\]]*)\]$/m.exec(body)?.[1] ?? '';
    tools.set(tool, {
      version: /^version = "([^"]+)"$/m.exec(body)?.[1] ?? '',
      specifiers: [...specifiers.matchAll(/"([^"]+)"/g)].map(([, specifier = '']) => specifier),
      platforms: new Map(
        [...body.matchAll(/^\[tools\.[\w-]+\."platforms\.([\w-]+)"\]\n((?:[a-z_]+ = .*\n?)*)/gm)].map(
          ([, platform = '', fields = '']) => [
            platform,
            { url: /^url = "https:\/\//m.test(fields), checksum: /^checksum = "sha256:[0-9a-f]{64}"$/m.test(fields) },
          ],
        ),
      ),
    });
  }
  return tools;
}

/** Whether a version is in a request's range: the request itself, or a release that begins with it. */
const within = (version: string, request: string) => version === request || version.startsWith(`${request}.`);

/** The tools whose lock entry is missing, or was made for another request, or holds a version outside it. */
const stale = (wanted: Map<string, string>, lock: Map<string, Locked>) =>
  [...wanted]
    .filter(([tool, request]) => {
      const entry = lock.get(tool);
      return !entry || entry.specifiers.join() !== request || !within(entry.version, request);
    })
    .map(([tool]) => tool);

describe('the toolchain', () => {
  const wanted = requests();
  const lock = locked();

  it('is read from mise.toml and mise.lock', () => {
    expect([...wanted.keys()]).toEqual(expect.arrayContaining(['node', 'pnpm', 'kubectl', 'gh']));
    expect(platforms().sort()).toEqual(['linux-arm64', 'linux-x64', 'macos-arm64', 'macos-x64']);
    expect(read('mise.toml')).toMatch(/^lockfile = true$/m);
  });

  it('has each tool locked at one version, in its range, for its request', () => {
    expect([...lock.keys()].sort()).toEqual([...wanted.keys()].sort());
    expect(stale(wanted, lock)).toEqual([]);
  });

  it('has a download and its checksum for each platform', () => {
    for (const [tool, entry] of lock) {
      expect({ tool, platforms: Object.fromEntries(entry.platforms) }).toEqual({
        tool,
        platforms: Object.fromEntries(platforms().map((platform) => [platform, { url: true, checksum: true }])),
      });
    }
  });

  it("locks the pnpm package.json's packageManager names, which is the one pnpm runs", () => {
    const manager = /"packageManager": "pnpm@([^+"]+)/.exec(read('package.json'))?.[1];
    expect(manager).toMatch(/^\d+\.\d+\.\d+$/);
    expect(lock.get('pnpm')?.version).toBe(manager);
  });

  it('keeps Node exact, for the images to agree with (scripts/image-pins.test.ts)', () => {
    expect(wanted.get('node')).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('is stale when a request moves and the lock does not', () => {
    const moved = requests(read('mise.toml').replace(/^helm = "\d+"$/m, 'helm = "99"'));
    expect(stale(moved, lock)).toEqual(['helm']);
    expect(within('4.3.0', '4')).toBe(true);
    expect(within('4.30.0', '4.3')).toBe(false);
  });
});

describe('every use of mise in CI', () => {
  const workflows = readdirSync('.github/workflows')
    .filter((file) => file.endsWith('.yml'))
    .map((file) => [file, read(`.github/workflows/${file}`)] as const);
  // Each step that uses the action, to the next step: its `version` is in that block, wherever it is written.
  const uses = workflows.flatMap(([file, text]) =>
    text
      .split(/\n(?= +- )/)
      .filter((step) => /^ +- uses: jdx\/mise-action@/.test(step))
      .map((step) => ({
        file,
        version: /^ +version: (\S+)$/m.exec(step)?.[1],
        tools: /^ +install_args: (.+)$/m.exec(step)?.[1],
        save: /^ +cache_save: (.+)$/m.exec(step)?.[1],
      })),
  );

  it('installs one release of mise, named', () => {
    expect(uses.length).toBeGreaterThan(0);
    expect(uses.length).toBe(workflows.reduce((n, [, text]) => n + text.split('jdx/mise-action@').length - 1, 0));
    const versions = new Set(uses.map(({ version }) => version));
    expect(versions.size).toBe(1);
    expect([...versions][0]).toMatch(/^\d{4}\.\d+\.\d+$/);
  });

  it("is cached on main for each set of tools any workflow installs, since a run reads only its own and main's", () => {
    const cache = read('.github/workflows/toolchain-cache.yml');
    // Each set as the matrix's include gives it, beside the job it is named for.
    // The tools in the order mise-action keys them by, so `pnpm node` is the same set as `node pnpm`.
    const set = (tools = '') => tools.split(' ').filter(Boolean).sort().join(' ');
    const warmed = [...cache.matchAll(/^ +- job: \w+\n +tools: (.+)$/gm)].map(([, tools]) => set(tools));
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, as the workflow writes it.
    const matrix = '${{ matrix.tools }}';
    // app-gates.yml runs in the app's repository alone (it refuses anything but its pull requests and merge queue),
    // whose caches are its own: this repository's main cannot serve it.
    const here = uses.filter(({ file }) => file !== 'toolchain-cache.yml' && file !== 'app-gates.yml');
    expect(here.every(({ tools }) => tools)).toBe(true);
    const installed = new Set(here.map(({ tools }) => set(tools)));
    expect(installed.has('node')).toBe(true);
    expect(warmed.sort()).toEqual([...installed].sort());
    expect(uses.filter(({ file }) => file === 'toolchain-cache.yml').map(({ tools }) => tools)).toEqual([matrix]);
  });

  it('saves its cache on main alone, where every other run can read it', () => {
    // A copy saved on a pull request's branch or the merge queue's could be read by that branch alone.
    for (const { file, save } of uses) {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, as the workflow writes it.
      expect({ file, save }).toEqual({ file, save: "${{ github.ref == 'refs/heads/main' }}" });
    }
  });

  it('checks out mise.lock beside mise.toml, so a sparse checkout installs from the lock too', () => {
    for (const [file, text] of workflows) {
      for (const [, indent] of text.matchAll(/^( +)mise\.toml$/gm)) {
        expect({ file, lock: text.includes(`\n${indent}mise.toml\n${indent}mise.lock\n`) }).toEqual({
          file,
          lock: true,
        });
      }
    }
  });
});
