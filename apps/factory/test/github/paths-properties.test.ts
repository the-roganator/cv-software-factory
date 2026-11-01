/**
 * Properties of the paths a patch may change (`github/paths.ts`), over scopes, paths and CODEOWNERS files fast-check
 * makes up. `paths.test.ts`, `proofs/scope-fence.runners.test.ts`, `reads.test.ts` and `patches.test.ts` hold the
 * examples; these hold what must be true whatever a scope says, since a scope is the planner's words, and whatever
 * CODEOWNERS says, since it is whatever the app's repository holds at a commit.
 *
 * Two readings here are written again from their rules, not from the code: what a scope entry means, segment by
 * segment, and which paths GitHub gives a CODEOWNERS entry's owner. Each CODEOWNERS entry is made from a path it must
 * give a person, so the property knows the answer without asking `ownedPaths`.
 *
 * A failure prints the seed and the shrunk counterexample: `fc.assert(..., { seed, path })` replays it.
 */
import { PATH_CHARS } from '@software-factory/events';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { guard } from '../../src/github/actions.ts';
import { PatchRefused } from '../../src/github/patches.ts';
import { CODEOWNERS_PATHS, inScope, ownedPaths, pattern, plainPath, protectedFrom } from '../../src/github/paths.ts';
import { LiveReads } from '../../src/github/reads.ts';
import { fence } from '../../src/runners/scope.ts';
import { client, REPO, SHA } from './fake.ts';

const PATCH = (path: string) => `diff --git a/${path} b/${path}
--- a/${path}
+++ b/${path}
@@ -1 +1 @@
-old
+new
`;

/**
 * A path segment: often a name the rules care about, so entries and paths meet, and otherwise a short made-up one.
 * None holds `#`, a space or a backslash, which a CODEOWNERS path can write only with escapes GitHub does not read.
 */
const segment = fc.oneof(
  {
    weight: 3,
    arbitrary: fc.constantFrom('src', 'test', 'docs', 'deploy', '.github', 'workflows', 'money.ts', 'Dockerfile', 'a'),
  },
  { weight: 2, arbitrary: fc.stringMatching(/^[a-z0-9_.-]{1,6}$/).filter((s) => s !== '.' && s !== '..') },
);
const segments = fc.array(segment, { minLength: 1, maxLength: 5 });
const path = segments.map((s) => s.join('/'));

/** Where the workflows and the deployment live, which no patch may change, written from the rule, not from `NEVER`. */
const rules = fc.tuple(fc.constantFrom('.github/', 'deploy/'), path).map(([folder, rest]) => `${folder}${rest}`);

/** One segment of a scope entry: a name, `*`, `**`, or a name with `*` for part of it (`*.ts`, `m*`, `a*b`). */
const globSegment = fc.oneof(
  { weight: 4, arbitrary: segment },
  { weight: 1, arbitrary: fc.constant('*') },
  { weight: 2, arbitrary: fc.constant('**') },
  { weight: 1, arbitrary: segment.map((s) => `*${s.slice(-3)}`) },
  { weight: 1, arbitrary: segment.map((s) => `${s.slice(0, 1)}*`) },
  { weight: 1, arbitrary: fc.tuple(segment, segment).map(([a, b]) => `${a.slice(0, 1)}*${b.slice(-1)}`) },
);
/** A scope entry as the planner writes one: a file, a folder ending in `/`, or a pattern. */
const entry = fc
  .tuple(fc.array(globSegment, { minLength: 1, maxLength: 4 }), fc.boolean())
  .map(([globs, folder]) => `${globs.join('/')}${folder ? '/' : ''}`);

/** A segment of a scope entry against one of a path, where `*` is any run of characters within it. */
function segmentMatches(glob: string, name: string): boolean {
  const pieces = glob.split('*');
  if (pieces.length === 1) return glob === name;
  const first = pieces[0] ?? '';
  const last = pieces.at(-1) ?? '';
  if (!name.startsWith(first) || name.length < first.length + last.length || !name.endsWith(last)) return false;
  let at = first.length;
  for (const piece of pieces.slice(1, -1)) {
    const found = name.indexOf(piece, at);
    if (found < 0 || found + piece.length > name.length - last.length) return false;
    at = found + piece.length;
  }
  return true;
}

/** Entry segments against path segments, where `**` is any number of whole segments, none included. */
function globMatches(globs: readonly string[], names: readonly string[]): boolean {
  const [glob, ...rest] = globs;
  if (glob === undefined) return names.length === 0;
  if (glob === '**') return globMatches(rest, names) || (names.length > 0 && globMatches(globs, names.slice(1)));
  return names.length > 0 && segmentMatches(glob, names[0] ?? '') && globMatches(rest, names.slice(1));
}

/** What a scope entry means, read again from its rule: a folder, or a last `**`, takes in at least one segment more. */
function means(scopeEntry: string, target: string): boolean {
  const folder = scopeEntry.endsWith('/');
  const globs = (folder ? scopeEntry.slice(0, -1) : scopeEntry).split('/');
  const beneath = folder || globs.at(-1) === '**';
  return globMatches(
    beneath ? [...globs.filter((_, i) => folder || i < globs.length - 1), '**', '*'] : globs,
    target.split('/'),
  );
}

/**
 * The segments of a path a scope entry is likely to match: each `*` filled in, each `**` some segments, a folder's file
 * beneath it.
 */
const namesFor = (scopeEntry: string) => {
  const folder = scopeEntry.endsWith('/');
  const globs = (folder ? scopeEntry.slice(0, -1) : scopeEntry).split('/');
  const filled = globs.map((glob, i) => {
    const pieces = glob.split('*');
    return glob === '**'
      ? fc.array(segment, { minLength: i === globs.length - 1 ? 1 : 0, maxLength: 2 })
      : fc
          .array(fc.stringMatching(/^[a-z.]{0,3}$/), { minLength: pieces.length - 1, maxLength: pieces.length - 1 })
          .map((fills) => [pieces.reduce((made, piece, j) => `${made}${fills[j - 1] ?? ''}${piece}`)]);
  });
  return fc
    .tuple(fc.tuple(...filled), fc.array(segment, { minLength: folder ? 1 : 0, maxLength: folder ? 2 : 0 }))
    .map(([parts, under]) => [...parts.flat(), ...under]);
};

const plainNames = (names: readonly string[]) =>
  names.length > 0 && names.every((name) => name !== '' && name !== '.' && name !== '..');

/** A path a scope entry is likely to match. */
const pathFor = (scopeEntry: string) =>
  namesFor(scopeEntry)
    .filter(plainNames)
    .map((names) => names.join('/'));

/**
 * A path that only just misses one an entry matches: a letter before a segment or before each, a segment more, two
 * run together, or one left out.
 */
const nearPathFor = (scopeEntry: string) =>
  fc
    .tuple(namesFor(scopeEntry), fc.nat(), fc.constantFrom('letter', 'letters', 'one more', 'run together', 'left out'))
    .map(([names, n, how]) => {
      const i = n % Math.max(names.length, 1);
      if (how === 'letter') return names.map((name, j) => (j === i ? `x${name}` : name));
      if (how === 'letters') return names.map((name) => `x${name}`);
      if (how === 'one more') return [...names.slice(0, i), 'x', ...names.slice(i)];
      if (how === 'run together' && i + 1 < names.length)
        return [...names.slice(0, i), `${names[i]}${names[i + 1]}`, ...names.slice(i + 2)];
      return names.filter((_, j) => j !== i);
    })
    .filter(plainNames)
    .map((names) => names.join('/'));

/** Anything a scope might say, however written: entries, the widest patterns, odd entries, and any string at all. */
const anyScope = fc.array(
  fc.oneof(
    { weight: 3, arbitrary: entry },
    {
      weight: 2,
      arbitrary: fc.constantFrom('**', '*', '/', '', '**/', '*/', './', '../', '**/*', '.github/', 'deploy'),
    },
    { weight: 1, arbitrary: fc.string() },
  ),
  { maxLength: 5 },
);

/** Any segment written again with `*` or `?` for some of it, or as `*` or `**`, so it still matches the segment. */
const wild = (name: string) =>
  fc.oneof(
    { weight: 4, arbitrary: fc.constant(name) },
    { weight: 1, arbitrary: fc.constantFrom('*', '**') },
    { weight: 1, arbitrary: fc.nat(name.length).map((i) => `${name.slice(0, i)}*`) },
    { weight: 1, arbitrary: fc.nat(name.length).map((i) => `*${name.slice(i)}`) },
    { weight: 1, arbitrary: fc.nat(name.length - 1).map((i) => `${name.slice(0, i)}?${name.slice(i + 1)}`) },
  );

/**
 * A CODEOWNERS path that gives a person `target`, written one of the ways GitHub reads: from the root (`/src/a.ts`, or
 * `src/a.ts`, since a slash within anchors it), anywhere (`a.ts`, or a path after `**`), naming the file or a folder
 * above it (`/src`, `/src/`), with wildcards for some of it. A folder's entry ends in a name: GitHub gives `docs/*` the
 * files in `docs/` only, not those further down.
 */
const owning = segments.chain((names) =>
  fc.record({ k: fc.integer({ min: 1, max: names.length }), from: fc.nat(names.length - 1) }).chain(({ k, from }) => {
    const item = names.slice(0, k);
    const folder = k < names.length;
    const start = Math.min(from, k - 1);
    const shapes = fc.oneof(
      fc.constant({ lead: '/', written: item }),
      fc.constant({ lead: item.length > 1 ? '' : '/', written: item }),
      fc.constant({ lead: '', written: item.slice(-1) }),
      fc.constant({ lead: '**/', written: item.slice(start) }),
    );
    return fc.record({
      target: fc.constant(names.join('/')),
      written: shapes.chain(({ lead, written }) =>
        fc
          .tuple(
            ...written.map((name, i) => (folder && i === written.length - 1 ? fc.constant(name) : wild(name))),
            fc.boolean(),
          )
          .map((parts) => {
            const slash = parts.pop() as boolean;
            return `${lead}${parts.join('/')}${folder && slash ? '/' : ''}`;
          }),
      ),
    });
  }),
);

/** Lines a CODEOWNERS file holds beside the one that matters: comments, blanks, other entries, and anything. */
const noise = fc.oneof(
  fc.constantFrom('', '# The rules', '   ', '* @everyone', '/docs/ @writers # the docs'),
  entry.map((e) => `${e} @someone`),
  fc.string(),
);

/** A CODEOWNERS file that gives a person `target`, among other lines, its lines ended either way. */
const codeownersOwning = fc
  .record({
    owns: owning,
    before: fc.array(noise, { maxLength: 3 }),
    after: fc.array(noise, { maxLength: 3 }),
    comment: fc.constantFrom('', ' # why'),
    gap: fc.constantFrom(' ', '   ', '\t'),
    eol: fc.constantFrom('\n', '\r\n'),
  })
  .map(({ owns, before, after, comment, gap, eol }) => ({
    target: owns.target,
    written: owns.written,
    text: [...before, `${owns.written}${gap}@mrogan${comment}`, ...after].join(eol),
  }));

/** A CODEOWNERS file of any lines at all, or none. */
const anyCodeowners = fc.option(
  fc
    .array(
      fc.oneof(
        noise,
        owning.map((o) => `${o.written} @mrogan`),
      ),
      { maxLength: 6 },
    )
    .map((lines) => lines.join('\n')),
);

describe('a scope entry', () => {
  it('matches a path exactly when its rule says: `*` within one segment, `**` whole segments, a folder what is beneath it', () => {
    fc.assert(
      fc.property(
        entry.chain((e) =>
          fc.record({
            entry: fc.constant(e),
            target: fc.oneof(
              { weight: 1, arbitrary: path },
              { weight: 2, arbitrary: pathFor(e) },
              { weight: 3, arbitrary: nearPathFor(e) },
              // No plain path holds a line separator, but the rule is no laxer for one that does.
              {
                weight: 1,
                arbitrary: fc
                  .tuple(pathFor(e), fc.nat(), fc.constantFrom('\u2028', '\u2029', '\n', '\r'))
                  .map(
                    ([p, i, separator]) =>
                      `${p.slice(0, i % (p.length + 1))}${separator}${p.slice(i % (p.length + 1))}`,
                  ),
              },
            ),
          }),
        ),
        ({ entry: e, target }) => {
          expect(pattern(e).test(target)).toBe(means(e, target));
        },
      ),
    );
  });
});

describe('a plain path', () => {
  it('is taken when it is relative and every segment is a name', () => {
    fc.assert(
      fc.property(path, (p) => {
        expect(plainPath(p)).toBe(true);
      }),
    );
  });

  it('is refused with a leading or trailing slash, an empty, `.` or `..` segment, a backslash, a control, separator or format character, or more characters than an event records', () => {
    const control = fc.oneof(
      fc
        .oneof(fc.integer({ min: 0, max: 0x1f }), fc.integer({ min: 0x7f, max: 0x9f }))
        .map((code) => String.fromCharCode(code)),
      // Line and paragraph separators, and format characters: a soft hyphen, zero-width ones, bidi overrides, a BOM.
      fc.constantFrom('\u2028', '\u2029', '\u00ad', '\u200b', '\u200d', '\u202e', '\u2066', '\ufeff'),
    );
    const spoilt = fc.oneof(
      path.map((p) => `/${p}`),
      path.map((p) => `${p}/`),
      fc.constant(''),
      fc.tuple(segments, fc.nat(), fc.constantFrom('', '.', '..')).map(([names, i, bad]) => {
        const at = i % (names.length + 1);
        return [...names.slice(0, at), bad, ...names.slice(at)].join('/');
      }),
      fc.tuple(path, fc.nat(), fc.oneof(fc.constant('\\'), control)).map(([p, i, bad]) => {
        const at = i % (p.length + 1);
        return `${p.slice(0, at)}${bad}${p.slice(at)}`;
      }),
      fc
        .tuple(path, fc.integer({ min: 1, max: 4096 }))
        .map(([p, over]) => `${p}/${'a'.repeat(Math.max(1, PATH_CHARS + over - p.length - 1))}`),
    );
    fc.assert(
      fc.property(spoilt, (p) => {
        expect(plainPath(p)).toBe(false);
      }),
    );
  });
});

describe('the paths no patch may change', () => {
  it('take in every path a CODEOWNERS entry gives a person, however the entry is written', () => {
    fc.assert(
      fc.property(codeownersOwning, ({ target, text }) => {
        expect(inScope(target, protectedFrom(text))).toBe(true);
      }),
    );
  });

  it('take in nothing more than a plain entry names: from the root its path and beneath, or anywhere a segment by its name', () => {
    fc.assert(
      fc.property(segments, path, fc.boolean(), fc.nat(4), (names, other, anywhere, near) => {
        const written = anywhere ? (names.at(-1) ?? '') : names.join('/');
        // Paths near the entry's, which it may or may not take in, and now and then any path at all.
        const target =
          [`${written}/${other}`, `${other}/${written}`, `x${written}`, `${written}x`, other][near] ?? other;
        const owned = ownedPaths(`${anywhere ? '' : '/'}${written} @mrogan`);
        const expected = anywhere
          ? target.split('/').includes(written)
          : target === written || target.startsWith(`${written}/`);
        expect(inScope(target, owned)).toBe(expected);
      }),
    );
  });
});

describe('the scope fence', () => {
  it('lets through no workflow, deployment or code-owned path, whatever the scope says', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          rules.map((target) => ({ target, text: null as string | null })),
          rules.chain((target) => anyCodeowners.map((text) => ({ target, text }))),
          codeownersOwning,
        ),
        anyScope,
        ({ target, text }, scope) => {
          const fenced = fence(PATCH(target), scope, ownedPaths(text ?? ''));
          expect(fenced.ok).toBe(false);
          expect(fenced.outside).toEqual([target]);
        },
      ),
    );
  });
});

describe('the line and the GitHub worker', () => {
  it('refuse the same paths, whatever the CODEOWNERS files say and wherever they are', async () => {
    let files: Record<string, string | null> = {};
    const { github } = client([
      {
        method: 'GET',
        path: /\/contents\//,
        answer: ({ path: asked }) => {
          const file = CODEOWNERS_PATHS.find((p) => asked.startsWith(`/repos/${REPO}/contents/${p}?ref=${SHA}`));
          const text = file === undefined ? null : files[file];
          return typeof text === 'string'
            ? { body: { type: 'file', encoding: 'base64', content: Buffer.from(text).toString('base64') } }
            : { status: 404, body: { message: 'Not Found' } };
        },
      },
    ]);
    const reads = new LiveReads(github);
    const refuses = async (patch: string) =>
      guard(patch, async (p) => files[p] ?? null).then(
        () => false,
        (error: unknown) => {
          if (error instanceof PatchRefused && error.kind === 'protected') return true;
          throw error;
        },
      );
    const placed = fc.tuple(
      ...CODEOWNERS_PATHS.map(() =>
        fc.option(
          fc.oneof(
            anyCodeowners,
            codeownersOwning.map((c) => c.text),
          ),
          { nil: null },
        ),
      ),
    );
    const targets = fc.uniqueArray(
      fc.oneof(
        path,
        codeownersOwning.map((c) => c.target),
        rules,
      ),
      { minLength: 1, maxLength: 4 },
    );
    await fc.assert(
      fc.asyncProperty(placed, targets, anyScope, async (texts, paths, scope) => {
        files = Object.fromEntries(CODEOWNERS_PATHS.map((p, i) => [p, texts[i] ?? null]));
        const forbidden = await reads.protectedPaths(REPO, SHA);
        for (const p of paths) {
          expect(await refuses(PATCH(p)), p).toBe(!fence(PATCH(p), ['**'], forbidden).ok);
        }
        const patch = paths.map(PATCH).join('');
        if (fence(patch, scope, forbidden).ok) expect(await refuses(patch)).toBe(false);
      }),
    );
  });
});
