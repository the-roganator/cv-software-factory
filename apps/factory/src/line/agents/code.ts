/**
 * Where Markdown has code, by CommonMark's rules for fences, inline code and HTML blocks, read with no parser: fenced
 * code, where a tag, a link or a mention is only text, and inline code of any number of backticks. An HTML block is not
 * Markdown: GitHub keeps its lines as they are, so a backtick there is a backtick and no code, and only HTML's own
 * `<code>` and `<pre>` are. Indented code is not known here, since four spaces may as well be a list's deeper content.
 * Shared by `folds.ts`, by `mentions` in `agent.ts` and by `.claude/skills/visual-pr/bin/check.ts`, so that the three
 * agree on what is code.
 */

/**
 * A fence that opens or closes fenced code: three or more backticks or tildes, indented by three spaces at most. A
 * backtick fence's info string has no backtick: "```npm test``` runs it" is inline code.
 */
const FENCE = /^ {0,3}(`{3,}(?=[^`]*$)|~{3,})/;

/** A quote's markers, which a fence or a fold inside a quote stands behind. */
export const QUOTED = /^ {0,3}(?:> ?)+/;
const MARKER = /^ {0,3}> ?/;

/** Fenced code: the fence that opened it, and how many quotes deep it stands. */
export interface Fence {
  marker: string;
  depth: number;
}

/** The fenced code a line opens, if it opens any. */
export function opens(line: string): Fence | undefined {
  const quoted = QUOTED.exec(line)?.[0] ?? '';
  const marker = FENCE.exec(line.slice(quoted.length))?.[1];
  return marker ? { marker, depth: quoted.split('>').length - 1 } : undefined;
}

/**
 * What a line is to the fenced code before it: `code`, a fence that closes it (`close`: the same character, at least
 * as long, with nothing after it), or past its end (`end`) when the quote it stands in has ended, as fenced code ends
 * with its quote. A quote's markers in code that is not quoted as deep are only code.
 */
export function within(fence: Fence, line: string): 'code' | 'close' | 'end' {
  let rest = line;
  for (let i = 0; i < fence.depth; i++) {
    const marker = MARKER.exec(rest)?.[0];
    if (marker === undefined) return 'end';
    rest = rest.slice(marker.length);
  }
  const marker = FENCE.exec(rest)?.[1] ?? '';
  const closes = marker[0] === fence.marker[0] && marker.length >= fence.marker.length;
  return closes && !rest.trim().slice(marker.length) ? 'close' : 'code';
}

/**
 * Inline code: a run of backticks closed by a run of exactly as many, within a paragraph (a line with nothing but a
 * quote's markers ends one too). An opening run with no such close is only text, as is a backtick escaped by a
 * backslash.
 */
export const INLINE = /(?<=^|[^`\\]|\\`)(`+)(?!`)(?:(?!\n[ \t>]*\n)[\s\S])*?(?<!`)\1(?!`)/g;

const blank = (text: string) => text.replace(/[^\n]/g, ' ');

const SPACE = /[\t\n\f\r ]/;
const NAME_ENDS = /[\t\n\f\r />]/;

/** Where a tag's `>` is, past its name at `from`, as a browser reads its attributes: -1 where the text ends first. */
function tagEnd(text: string, from: number): number {
  let i = from;
  const skip = (stop: RegExp) => {
    while (i < text.length && !stop.test(text[i] ?? '')) i++;
  };
  while (i < text.length) {
    const c = text[i] ?? '';
    if (c === '>') return i;
    if (SPACE.test(c) || c === '/') {
      i++;
      continue;
    }
    // An attribute's name, whose first character may be `=`, then its value, if an `=` follows.
    i++;
    skip(/[\t\n\f\r />=]/);
    skip(/[^\t\n\f\r ]/);
    if (text[i] !== '=') continue;
    i++;
    skip(/[^\t\n\f\r ]/);
    const quote = text[i];
    if (quote === '"' || quote === "'") {
      i = text.indexOf(quote, i + 1);
      if (i < 0) return -1;
      i++;
    } else skip(/[\t\n\f\r >]/);
  }
  return -1;
}

/** What a browser reads at a `<`: markup to its end, a tag with its name, or a `<` that is only text (`undefined`). */
function markupAt(text: string, at: number): { end: number; tag?: string; closing?: boolean } | 'unended' | undefined {
  const next = text[at + 1] ?? '';
  const upTo = (close: string, from: number) => {
    const found = text.indexOf(close, from);
    return found < 0 ? 'unended' : { end: found + close.length };
  };
  if (text.startsWith('<!--', at)) {
    if (text.startsWith('<!-->', at)) return { end: at + 5 };
    if (text.startsWith('<!--->', at)) return { end: at + 6 };
    const close = /--!?>/g;
    close.lastIndex = at + 4;
    const found = close.exec(text);
    return found ? { end: found.index + found[0].length } : 'unended';
  }
  if (next === '!' || next === '?') return upTo('>', at + 2);
  const closing = next === '/';
  const start = closing ? at + 2 : at + 1;
  if (!/[A-Za-z]/.test(text[start] ?? '')) {
    if (!closing) return undefined;
    if (start >= text.length) return undefined;
    return text[start] === '>' ? { end: start + 1 } : upTo('>', start);
  }
  let i = start;
  while (i < text.length && !NAME_ENDS.test(text[i] ?? '')) i++;
  const end = tagEnd(text, i);
  return end < 0 ? 'unended' : { end: end + 1, tag: text.slice(start, i).toLowerCase(), closing };
}

/** Elements whose text a browser reads as text to their end tag, never as tags. */
const RAW_TEXT = new Set(['iframe', 'noembed', 'noframes', 'noscript', 'script', 'style', 'textarea', 'title', 'xmp']);

/**
 * HTML's own code in an HTML block's text blanked, which GitHub notifies nobody from: a `<code>` or `<pre>` tag and
 * its end tag, as a browser reads tags (not in a comment, an attribute or another element's raw text), with only text
 * between them. Markup that leaves the rest of the document inside it (a comment, a tag or raw text with no end) blanks
 * nothing from there on, in this block or any after it (`state.unended`): GitHub reads the blocks as one document.
 */
function blankHtmlCode(raw: string, state: { unended: boolean }): string {
  if (state.unended) return raw;
  // A quote's markers are not HTML: a `>` of theirs ends no tag.
  const text = raw
    .split('\n')
    .map((line) => line.replace(QUOTED, (markers) => ' '.repeat(markers.length)))
    .join('\n');
  let out = '';
  let copied = 0;
  let open: { tag: string; from: number } | undefined;
  for (let at = text.indexOf('<'); at >= 0; ) {
    const markup = markupAt(text, at);
    if (markup === 'unended') {
      state.unended = true;
      break;
    }
    if (!markup) {
      at = text.indexOf('<', at + 1);
      continue;
    }
    let end = markup.end;
    if (open && markup.closing && markup.tag === open.tag) {
      out += raw.slice(copied, open.from) + blank(raw.slice(open.from, end));
      copied = end;
      open = undefined;
    } else {
      open = undefined;
      if (markup.tag && !markup.closing) {
        if (markup.tag === 'code' || markup.tag === 'pre') open = { tag: markup.tag, from: at };
        if (markup.tag === 'plaintext') {
          state.unended = true;
          break;
        }
        if (RAW_TEXT.has(markup.tag)) {
          const close = new RegExp(String.raw`</${markup.tag}[\t\n\f\r />]`, 'gi');
          close.lastIndex = end;
          const found = close.exec(text);
          if (!found) {
            state.unended = true;
            break;
          }
          end = found.index;
        }
      }
    }
    at = text.indexOf('<', end);
  }
  return out + raw.slice(copied);
}

/** The HTML blocks that end at a line holding their end (CommonMark's kinds 1 to 5), by what starts them. */
const ENDS_AT: [RegExp, RegExp][] = [
  [/^<(?:pre|script|style|textarea)(?:[\s>]|$)/i, /<\/(?:pre|script|style|textarea)>/i],
  [/^<!--/, /-->/],
  [/^<\?/, /\?>/],
  [/^<!\[CDATA\[/, /\]\]>/],
  [/^<![A-Za-z]/, />/],
];

/** The tags that start an HTML block a blank line ends, opening or closing (CommonMark's kind 6). */
const BLOCK_TAG = new RegExp(
  String.raw`^</?(?:${[
    'address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt',
    'fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link',
    'main menu menuitem nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead',
    'title tr track ul',
  ]
    .join(' ')
    .split(' ')
    .join('|')})(?:[\s>]|/>|$)`,
  'i',
);

/** A whole tag alone on a line, of any other name (CommonMark's kind 7): it starts a block, but no paragraph's line. */
const ATTRIBUTE = String.raw`\s+[A-Za-z_:][\w.:-]*(?:\s*=\s*(?:[^\s"'=<>\x60]+|'[^']*'|"[^"]*"))?`;
const LONE_TAG = new RegExp(
  String.raw`^(?:<(?!(?:pre|script|style|textarea)[\s/>])[A-Za-z][A-Za-z0-9-]*(?:${ATTRIBUTE})*\s*/?>|</[A-Za-z][A-Za-z0-9-]*\s*>)\s*$`,
  'i',
);

/** What stands before a block on its line: a quote's markers, a list's, and any indent, which a list's content takes. */
const CONTAINERS = /^(?: {0,3}>)*(?:[ \t]*(?:[-+*]|\d{1,9}[.)])(?=[ \t]))*[ \t]*/;
const depthOf = (line: string) => (QUOTED.exec(line)?.[0] ?? '').split('>').length - 1;

/**
 * An HTML block: how many quotes deep it stands, the end it waits for, or a blank line, and whether the line that
 * started it ended it too.
 */
interface HtmlBlock {
  depth: number;
  end?: RegExp;
  ended?: boolean;
}

/**
 * The HTML block a line starts, if it starts one; `paragraph` when the line before it is a paragraph's, which only a
 * tag of a block's or one of kinds 1 to 5 interrupts. A list's or a quote's markers may stand before it, and any
 * indent: a block read where GitHub reads code makes the line warier, never laxer, of what is live.
 */
function startsHtml(line: string, paragraph: boolean): HtmlBlock | undefined {
  const rest = line.slice(CONTAINERS.exec(line)?.[0].length ?? 0);
  const depth = depthOf(line);
  for (const [start, end] of ENDS_AT) {
    const opened = start.exec(rest)?.[0];
    if (opened !== undefined) return { depth, end, ended: end.test(rest.slice(opened.length)) };
  }
  if (BLOCK_TAG.test(rest) || (!paragraph && LONE_TAG.test(rest))) return { depth };
  return undefined;
}

/** Whether a line ends an HTML block, as its last line (`last`) or as the first past it (`past`), or neither. */
function endsHtml(block: HtmlBlock, line: string): 'last' | 'past' | undefined {
  if (depthOf(line) < block.depth) return 'past';
  const rest = line.replace(QUOTED, '');
  if (block.end) return block.end.test(rest) ? 'last' : undefined;
  return rest.trim() ? undefined : 'past';
}

/** Markdown read for code: with its code blanked (`outsideCode`), and whether each line is in an HTML block. */
export function readCode(markdown: string): { outside: string; html: boolean[] } {
  const out: string[] = [];
  const html: boolean[] = [];
  let prose: string[] = [];
  let raw: string[] = [];
  let fence: Fence | undefined;
  let block: HtmlBlock | undefined;
  let paragraph = false;
  const document = { unended: false };
  const flush = () => {
    if (prose.length) out.push(prose.join('\n').replace(INLINE, blank));
    if (raw.length) out.push(blankHtmlCode(raw.join('\n'), document));
    prose = [];
    raw = [];
  };
  for (const line of markdown.split('\n')) {
    if (fence) {
      const at = within(fence, line);
      if (at !== 'end') {
        if (at === 'close') fence = undefined;
        out.push(blank(line));
        html.push(false);
        continue;
      }
      fence = undefined;
    }
    if (block) {
      const ends = endsHtml(block, line);
      if (ends !== 'past') {
        raw.push(line);
        html.push(true);
        if (ends === 'last') {
          block = undefined;
          flush();
        }
        continue;
      }
      block = undefined;
      flush();
    }
    fence = opens(line);
    block = fence ? undefined : startsHtml(line, paragraph);
    if (fence) {
      flush();
      out.push(blank(line));
      html.push(false);
      paragraph = false;
    } else if (block) {
      flush();
      raw.push(line);
      html.push(true);
      paragraph = false;
      // A block of kinds 1 to 5 may end on the line that starts it.
      if (block.ended) {
        block = undefined;
        flush();
      }
    } else {
      prose.push(line);
      html.push(false);
      const rest = line.replace(QUOTED, '');
      paragraph = rest.trim() !== '' && !/^ {0,3}#{1,6}(?:\s|$)/.test(rest);
    }
  }
  flush();
  return { outside: out.join('\n'), html };
}

/**
 * Markdown with its code blanked: each character of fenced or inline code, fences included, and of HTML's `<code>` and
 * `<pre>` in an HTML block, tags included, becomes a space, and each line stays where it was, so what reads lines or
 * what stood beside the code still finds them. Code left unclosed by its fence runs to the end, or to the end of its
 * quote, as in CommonMark; a backtick in an HTML block is only text.
 */
export function outsideCode(markdown: string): string {
  return readCode(markdown).outside;
}
