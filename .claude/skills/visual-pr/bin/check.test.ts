import { describe, expect, it } from 'vitest';
import { limit, oversize, problems, shown } from './check.ts';

// GitHub's renderings of these bodies, as `gh api markdown` returned them, cut to what the checks read.
const FOLDED =
  '<details>\n<summary>\n<h2 dir="auto">Tests</h2>\n</summary>\n<ul dir="auto">\n<li>passes</li>\n</ul>\n</details>';

describe('check.ts', () => {
  it('passes a folded section whose summary is one heading', () => {
    expect(problems('', FOLDED, false)).toEqual([]);
  });

  it('names a summary left as Markdown, and the Markdown left as text', () => {
    const html = '<details open="">\n<summary>\n## Tests\n</summary>\n- `make check` passes\n</details>';
    expect(problems('', html, false)).toEqual([
      'a summary is not one heading (blank lines around a "## title"?): ## Tests',
      'Markdown left as text: ## Tests',
      'Markdown left as text: - `make check` passes',
    ]);
  });

  it('names the line a missing blank line leaves as text, by the describer’s rule, before anything is rendered', () => {
    const body = '<details>\n<summary>\n## Tests\n</summary>\n\n- passes\n\n</details>';
    expect(problems(body, '', false)).toEqual([
      'a folded section shows “## Tests” as text: leave a blank line before it',
    ]);
  });

  it('names a section with no summary', () => {
    expect(problems('', '<details>\n<p dir="auto">body</p>\n</details>', false)).toEqual([
      'a <details> has no <summary>, or one has two',
    ]);
  });

  it('passes an attached video, which GitHub folds in a <details> of its own, whose title is the file’s name', () => {
    const video = [
      '<details open="" class="details-reset border rounded-2">',
      '  <summary class="tmp-px-3 py-2">',
      '    <svg aria-hidden="true" class="octicon octicon-device-camera-video"><path d="M16 3.75"></path></svg>',
      '    <span class="m-1">**flight**.webm</span>',
      '    <span class="dropdown-caret"></span>',
      '  </summary>',
      '  <video src="https://private-user-images.githubusercontent.com/1/flight.webm" controls="controls"></video>',
      '</details>',
    ].join('\n');
    expect(problems('', `${FOLDED}\n${video}`, false)).toEqual([]);
    expect(problems('', `<details>\n${video}\n</details>`, false)).toEqual([
      'a <details> has no <summary>, or one has two',
    ]);
  });

  it('still holds a summary of the describer’s with an attribute to the rules', () => {
    expect(problems('', '<details>\n<summary title="x">Tests</summary>\n</details>', false)).toEqual([
      'a <details> has no <summary>, or one has two',
    ]);
  });

  it('names a local path left in a published body, in each form, and not one shown as code', () => {
    const body = [
      '[![blink](/Users/martin/scratch/pr/a/b.svg)](https://github.com/x)',
      '[snapshot](scratch/pr/foo.svg)',
      '[ref]: ./scratch/pr/c.svg',
      '<img src="scratch/pr/d.svg">',
      '`[![alt](<svg>)](https://github.com/x)`',
      '```markdown\n[x](scratch/in-code.svg)\n```',
      '[docs](https://docs.github.com) [up](#tests) <a href="mailto:a@b.c">mail</a>',
    ].join('\n\n');
    expect(problems(body, '', true)).toEqual([
      'a local path is left: /Users/martin/scratch/pr/a/b.svg',
      'a local path is left: scratch/pr/foo.svg',
      'a local path is left: ./scratch/pr/c.svg',
      'a local path is left: scratch/pr/d.svg',
    ]);
  });

  it('reads code as GitHub does before it looks for a local path', () => {
    const body = [
      '``[x](scratch/a.svg) ` [y](scratch/b.svg)``',
      '   ```\n[x](scratch/c.svg)\n   ```',
      '````\n```\n[x](scratch/d.svg)\n````',
      '~~~\n```\n[x](scratch/e.svg)\n~~~',
      '[after](scratch/f.svg)',
      '```\n[x](scratch/g.svg)\n``` not closed\n[x](scratch/h.svg)',
    ].join('\n\n');
    expect(problems(body, '', true)).toEqual(['a local path is left: scratch/f.svg']);
    expect(problems('    ```\n[x](scratch/i.svg)\n\n[ref]: scratch/j.svg', '', true)).toEqual([
      'a local path is left: scratch/i.svg',
      'a local path is left: scratch/j.svg',
    ]);
  });

  it('leaves local paths alone before the body is published', () => {
    expect(problems('[snapshot](scratch/pr/foo.svg)', '', false)).toEqual([]);
  });

  it('counts what shows unfolded: a closed section by its summary alone, an open one whole', () => {
    const fold = (open: string, title: string, inner: string) =>
      `<details${open}>\n<summary>\n\n## ${title}\n\n</summary>\n\n${inner}\n\n</details>`;
    expect(shown('Why it exists.')).toBe(14);
    expect(shown(`Why it exists.\n\n${fold('', 'Proof', 'x'.repeat(5000))}`)).toBe('Why it exists. ## Proof'.length);
    expect(shown(fold(' open', 'Migration', 'run it first'))).toBe('## Migration run it first'.length);
    // A closed section inside an open one shows its summary; one inside a closed one, nothing.
    expect(shown(fold(' open', 'A', fold('', 'B', 'hidden')))).toBe('## A ## B'.length);
    expect(shown(fold('', 'A', fold(' open', 'B', 'hidden')))).toBe('## A'.length);
  });

  it('counts a link by its words, and neither a picture, a comment nor a tag in code', () => {
    expect(shown('[the map](https://github.com/x/y/pull/1) <!-- note -->')).toBe('the map'.length);
    expect(shown('[![alt](https://x/a.svg)](https://x/compare) after')).toBe('after'.length);
    expect(shown('`<details>` stays shown')).toBe('`` stays shown'.length);
  });

  it('leaves out an open section whose summary names a threat model, and an attribute that only holds the word open', () => {
    const fold = (tag: string, title: string, inner: string) =>
      `<details${tag}>\n<summary>\n\n## ${title}\n\n</summary>\n\n${inner}\n\n</details>`;
    expect(shown(`Why.\n\n${fold(' open', 'Threat model', 'x'.repeat(5000))}`)).toBe('Why.'.length);
    expect(shown(fold(' open', 'What not to miss', 'abc'))).toBe('## What not to miss abc'.length);
    expect(shown(fold(' class="open-questions"', 'Questions', 'hidden'))).toBe('## Questions'.length);
    expect(shown(fold(" data-x='a open b'", 'Q', 'hidden'))).toBe('## Q'.length);
    expect(shown(fold(' class="x" open', 'Q', 'shown'))).toBe('## Q shown'.length);
  });

  it('leaves out the attribution the caller adds, folded or not', () => {
    const link = 'https://claude.ai/code/session_01ABC';
    expect(shown(`Why.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n\n${link}\n`)).toBe(4);
    const folded = `<details>\n<summary>\n\n###### 🤖 Generated with [Claude Code](https://claude.com/claude-code)\n\n</summary>\n\n${link}\n\n</details>\n`;
    expect(shown(`Why.\n\n<details>\n<summary>\n\n## Proof\n\n</summary>\n\nran\n\n</details>\n\n${folded}`)).toBe(
      'Why. ## Proof'.length,
    );
  });

  it('allows four characters a changed line, never under 800 nor over 3,000', () => {
    expect([0, 199, 200, 201, 500, 750, 751, 5000].map(limit)).toEqual([800, 800, 800, 804, 2000, 3000, 3000, 3000]);
    expect(oversize('x'.repeat(800), 10)).toEqual([]);
    expect(oversize('x'.repeat(801), 10)).toEqual([
      'it shows 801 characters unfolded, and a change of 10 changed lines gets 800 at most: fold the proofs, tests and rollout, or cut',
    ]);
    expect(oversize('x'.repeat(2000), 500)).toEqual([]);
    expect(oversize('x'.repeat(2001), 500)).toHaveLength(1);
    expect(oversize('x'.repeat(3001), 1500)).toHaveLength(1);
  });
});
