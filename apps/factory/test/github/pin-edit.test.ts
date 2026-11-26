import { describe, expect, it } from 'vitest';
import { editAt } from '../../src/github/pins.ts';
import type { Target } from '../../src/vulnerabilities/fixes.ts';

const digest = (c: string) => `sha256:${c.repeat(64)}`;
const [OLD, NEW, OTHER] = [digest('a'), digest('b'), digest('c')];
const PIN = { file: 'deploy/a.yaml', line: 3 };
const image: Target = { kind: 'image', tag: 'v1.2.4', digest: NEW };
const MOVED = /^deploy\/a\.yaml:3 is not .* now: main moved since the scan$/;
const reasonOf = (made: ReturnType<typeof editAt>) => ('reason' in made ? made.reason : '');

describe('the edit a move makes at a pin’s line', () => {
  it('replaces the tag and its digest, or the tag alone, in the line’s own shape', () => {
    const line = `  image: ghcr.io/x/alpha:v1.2.3@${OLD}`;
    expect(editAt(PIN, line, 'v1.2.3', image)).toEqual({ ...PIN, from: `v1.2.3@${OLD}`, to: `v1.2.4@${NEW}` });
    expect(editAt(PIN, 'FROM ghcr.io/x/alpha:v1.2.3 AS a', 'v1.2.3', image, 'ghcr.io/x/alpha')).toEqual({
      ...PIN,
      from: 'v1.2.3',
      to: 'v1.2.4',
    });
  });

  it('writes an image’s move only where the line names the move’s repository before the tag', () => {
    const line = `  image: ghcr.io/x/beta:v1.2.3@${OLD}`;
    expect(reasonOf(editAt(PIN, line, 'v1.2.3', image, 'ghcr.io/x/alpha'))).toBe(
      "deploy/a.yaml:3 is not ghcr.io/x/alpha's pin at v1.2.3 now: main moved since the scan",
    );
    // A repository that only ends as the move's does is another.
    expect(reasonOf(editAt(PIN, line, 'v1.2.3', image, 'beta'))).toMatch(MOVED);
    expect(reasonOf(editAt(PIN, line, 'v1.2.3', image, 'x/beta'))).toMatch(MOVED);
    expect(editAt(PIN, line, 'v1.2.3', image, 'ghcr.io/x/beta')).toMatchObject({ to: `v1.2.4@${NEW}` });
    // A registry's port is the repository's.
    expect(editAt(PIN, 'image: "localhost:5000/x:v1.2.3"', 'v1.2.3', image, 'localhost:5000/x')).toMatchObject({
      to: 'v1.2.4',
    });
  });

  it('writes it only where the line pins the digest the scan read, when `from` carries one', () => {
    const line = `  image: ghcr.io/x/alpha:v1.2.3@${OLD}`;
    expect(editAt(PIN, line, `v1.2.3@${OLD}`, image, 'ghcr.io/x/alpha')).toMatchObject({ from: `v1.2.3@${OLD}` });
    expect(reasonOf(editAt(PIN, line, `v1.2.3@${OTHER}`, image, 'ghcr.io/x/alpha'))).toMatch(MOVED);
    expect(reasonOf(editAt(PIN, line, `v1.2.3@${OTHER}`, image))).toMatch(MOVED);
    // The scan read a digest, and the line now writes none.
    expect(reasonOf(editAt(PIN, '  image: ghcr.io/x/alpha:v1.2.3', `v1.2.3@${OLD}`, image))).toMatch(MOVED);
  });

  it('knows a tag that stands alone, a chart’s value, by its digest or not at all', () => {
    const line = `    tag: v1.2.3@${OLD}`;
    const name = 'kyverno: ghcr.io/x/alpha';
    expect(editAt(PIN, line, `v1.2.3@${OLD}`, image, name)).toMatchObject({ to: `v1.2.4@${NEW}` });
    expect(reasonOf(editAt(PIN, line, `v1.2.3@${OTHER}`, image, name))).toMatch(MOVED);
    expect(reasonOf(editAt(PIN, line, 'v1.2.3', image, name))).toMatch(MOVED);
    // A chart's image whose line does name it is held to its repository, without the chart's name.
    expect(editAt(PIN, '  image: ghcr.io/x/alpha:v1.2.3', 'v1.2.3', image, name)).toMatchObject({ to: 'v1.2.4' });
  });

  it('says a line that does not write the pin once as a word of its own', () => {
    expect(reasonOf(editAt(PIN, 'image: a:v1.2.3 b:v1.2.3', 'v1.2.3', image, 'a'))).toBe(
      'deploy/a.yaml:3 does not write v1.2.3 once as a word of its own',
    );
  });
});
