import { describe, expect, it } from 'vitest';
import { outsideCode } from '../../src/line/agents/code.ts';

const lines = (...l: string[]) => l.join('\n');
const spaces = (text: string) => text.replace(/[^\n]/g, ' ');

describe('Markdown outside code', () => {
  it('blanks inline code of any number of backticks, and keeps what stood beside it in place', () => {
    expect(outsideCode('a `b` c')).toBe('a     c');
    expect(outsideCode('a ``b ` c`` d')).toBe(`a ${spaces('``b ` c``')} d`);
    expect(outsideCode('a `b\nc` d')).toBe('a   \n   d');
  });

  it('leaves a run of backticks with no run as long to close it, and a span across a blank line, as text', () => {
    expect(outsideCode('a ``b` c')).toBe('a ``b` c');
    expect(outsideCode('a `b\n\nc` d')).toBe('a `b\n\nc` d');
  });

  it('blanks fenced code, fences included, closed by the same character at least as long with nothing after', () => {
    const fenced = lines('````', '```', '~~~', '```` not yet', '`````', 'after');
    expect(outsideCode(fenced)).toBe(lines(...spaces(fenced).split('\n').slice(0, 5), 'after'));
    const tilde = lines('~~~', '```', '~~~', 'after');
    expect(outsideCode(tilde)).toBe(lines('   ', '   ', '   ', 'after'));
  });

  it('knows a fence indented by three spaces at most, or inside a quote', () => {
    expect(outsideCode(lines('   ```', 'code', '   ```', 'after'))).toBe(lines('      ', '    ', '      ', 'after'));
    expect(outsideCode(lines('    ```', 'text'))).toBe(lines('    ```', 'text'));
    expect(outsideCode(lines('> ```', '> code', '> ```', 'after'))).toBe(lines('     ', '      ', '     ', 'after'));
  });

  it('runs a fence left open to the end, as CommonMark does', () => {
    expect(outsideCode(lines('before', '```', 'code', '`x` and more'))).toBe(
      lines('before', '   ', '    ', '            '),
    );
  });

  it('reads a backtick fence with a backtick after it as inline code', () => {
    expect(outsideCode('```npm test``` runs it')).toBe(`${spaces('```npm test```')} runs it`);
  });

  it('ends a quote’s fenced code with the quote, and reads quote markers in code that is not quoted as code', () => {
    expect(outsideCode(lines('> ```', '> code', '', 'after'))).toBe(lines('     ', '      ', '', 'after'));
    expect(outsideCode(lines('```', '> ```', 'code', '```', 'after'))).toBe(
      lines('   ', '     ', '    ', '   ', 'after'),
    );
  });

  it('leaves a backtick escaped by a backslash, and a span across a quoted blank line, as text', () => {
    expect(outsideCode('a \\` b `c`')).toBe('a \\` b    ');
    expect(outsideCode(lines('> `a', '>', '> b`'))).toBe(lines('> `a', '>', '> b`'));
  });

  it('reads an HTML block as GitHub does: its backticks as text, HTML’s own code as code, to the block’s end', () => {
    expect(outsideCode('<summary>Moves `@grpc/x`</summary>')).toBe('<summary>Moves `@grpc/x`</summary>');
    expect(outsideCode(lines('<details>', '<summary>`a`</summary>', '', '`b`'))).toBe(
      lines('<details>', '<summary>`a`</summary>', '', '   '),
    );
    expect(outsideCode('<p>Moves <code>@grpc/x</code> on</p>')).toBe(
      `<p>Moves ${spaces('<code>@grpc/x</code>')} on</p>`,
    );
    expect(outsideCode(lines('> <div>', '> `a`', 'after `b`'))).toBe(lines('> <div>', '> `a`', 'after    '));
    expect(outsideCode(lines('- <summary>`a`</summary>'))).toBe('- <summary>`a`</summary>');
    expect(outsideCode(lines('<!-- `a`', '`b` -->', '`c`'))).toBe(lines('<!-- `a`', '`b` -->', '   '));
    expect(outsideCode(lines('<pre>`a`</pre>', '`b`'))).toBe(lines(spaces('<pre>`a`</pre>'), '   '));
  });

  it('reads HTML’s code only from tags a browser reads as tags, with only text between them', () => {
    for (const live of [
      '<div><!-- <code> --> @a <!-- </code> --></div>',
      '<div><span title="<code>">@a</span><span title="</code>"></span></div>',
      '<div><!-- <code --> @a </code></div>',
      '<div><span title=<code>@a</code></div>',
      '<div><span <code>@a</code></div>',
      '<div><! <code>@a</code></div>',
      '<div><textarea><code></textarea>@a<textarea></code></textarea></div>',
      '<div><code><b>@a</b></code></div>',
      lines('> <div><span', '> <code>@a</code></div>'),
      lines('<div title="', '', '<div>" <code>@a</code></div>'),
    ])
      expect(outsideCode(live), live).toBe(live);
    expect(outsideCode('<div><span title="x">a</span> <code>@a</code></div>')).toBe(
      `<div><span title="x">a</span> ${spaces('<code>@a</code>')}</div>`,
    );
    expect(outsideCode('<div><!-- x --><pre class="a">@a</pre></div>')).toBe(
      `<div><!-- x -->${spaces('<pre class="a">@a</pre>')}</div>`,
    );
  });

  it('ends a comment’s HTML block only at a line with `-->`, so a backtick after `--!>` hides no mention', () => {
    // A browser ends a comment at `--!>` too, and GitHub then shows and mentions what follows it, backticks and all; but
    // the HTML block, whose every line is read as live, goes on to the line with `-->`, as in CommonMark. Ending the
    // block at `--!>` would read the lines between as Markdown, where `@a` is inline code and goes unseen.
    expect(outsideCode(lines('<!-- a note --!>', '`@a`', '-->', '`@b`'))).toBe(
      lines('<!-- a note --!>', '`@a`', '-->', '    '),
    );
    expect(outsideCode(lines('<!--', 'a note --!>', '`@a`', '-->'))).toBe(lines('<!--', 'a note --!>', '`@a`', '-->'));
    expect(outsideCode(lines('> <!-- a note --!>', '> `@a`', '> -->'))).toBe(
      lines('> <!-- a note --!>', '> `@a`', '> -->'),
    );
  });

  it('starts no HTML block in a paragraph at a tag no block has, nor in code', () => {
    expect(outsideCode(lines('text', '<span>', '`a`'))).toBe(lines('text', '<span>', '   '));
    expect(outsideCode(lines('<span>', '`a`'))).toBe(lines('<span>', '`a`'));
    expect(outsideCode(lines('text', '<div>', '`a`'))).toBe(lines('text', '<div>', '`a`'));
    expect(outsideCode('a `<div>` b `c`')).toBe('a         b    ');
    expect(outsideCode(lines('```', '<div>', '```', '`a`'))).toBe(lines('   ', '     ', '   ', '   '));
  });
});
