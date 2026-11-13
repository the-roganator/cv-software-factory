// Renders a pull request's description as GitHub does and says what did not render, and whether it is sized to the
// change: node check.ts <file> <base> | --pr <n>
// A <details> section is easy to break by a blank line: Markdown inside an HTML block stays literal until one ends
// it. The describer's rule for that, read line by line (folds.ts), goes first and names the line; GitHub's renderer
// then catches the rest. With --pr it checks the published body, where no local path may be left either: gh rewrites
// an attached file's path only when the upload works. Exit 0 when nothing is wrong, 1 with a line for each problem.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { outsideCode } from '../../../../apps/factory/src/line/agents/code.ts';
import { unrenderedFolds } from '../../../../apps/factory/src/line/agents/folds.ts';

/**
 * What is wrong with a description, given its Markdown and GitHub's rendering of it, which is empty when the folds
 * already failed; `published` adds local paths.
 */
export function problems(body: string, rendered: string, published: boolean, folds = unrenderedFolds(body)): string[] {
  const found: string[] = [...folds];
  // GitHub renders an attached video as a <details> of its own, whose <summary> has a class and the file's name for its
  // title: not the describer's, so set aside before the rest is read.
  const html = rendered.replace(
    /<details[^>]*>\s*<summary[^>]*>(?:(?!<\/?(?:details|summary)[\s>])[\s\S])*<\/summary>\s*<video[\s>][\s\S]*?<\/video>\s*<\/details>/g,
    '',
  );
  const count = (re: RegExp) => html.match(re)?.length ?? 0;

  if (count(/<details[\s>]/g) !== count(/<\/details>/g)) found.push('a <details> is not closed');
  if (count(/<summary>/g) !== count(/<details[\s>]/g)) found.push('a <details> has no <summary>, or one has two');
  for (const [, inner] of html.matchAll(/<summary>([\s\S]*?)<\/summary>/g)) {
    const title = (inner ?? '').trim();
    if (!/^<h[1-6][^>]*>[\s\S]*<\/h[1-6]>$/.test(title)) {
      found.push(`a summary is not one heading (blank lines around a "## title"?): ${title.slice(0, 80)}`);
    }
  }
  // Markdown left as text: what is outside code and pre, and still looks like Markdown.
  const text = html.replace(/<pre[\s\S]*?<\/pre>/g, '').replace(/<code[\s\S]*?<\/code>/g, '');
  for (const line of text.split('\n')) {
    if (/^\s*(#{1,6} |[-*] |\d+\. |```)|\*\*|\]\(/.test(line)) found.push(`Markdown left as text: ${line.trim()}`);
  }
  if (published) {
    // Where a link or picture points, in each form Markdown and HTML allow: inline, a reference's definition, and src
    // or href; code, which shows such forms without being them, aside. Anything but a web address or an anchor is a
    // path on this Mac, which GitHub would show broken.
    const prose = outsideCode(body);
    const targets = [
      ...prose.matchAll(/\]\(\s*<?([^)\s>]+)/g),
      ...prose.matchAll(/^\s*\[[^\]]+\]:\s*<?([^\s>]+)/gm),
      ...prose.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)/g),
    ].map((m) => m[1] ?? '');
    for (const target of targets) {
      if (!/^(https?:|mailto:|#)/.test(target)) found.push(`a local path is left: ${target}`);
    }
  }
  return found;
}

/**
 * The most a description may show unfolded: four characters a changed line, never under 800 nor over 3,000, so 200
 * changed lines get 800 and 750 or more get 3,000, and a fix that trims the diff moves the limit a little, not a step.
 */
export function limit(changed: number): number {
  return Math.min(3000, Math.max(800, 4 * changed));
}

/** Where the attribution the caller adds after the check begins, folded or not: its <details>, or its own line. */
function attribution(body: string, prose: string): number {
  const line = [...prose.matchAll(/^.*Generated with \[Claude Code\]/gm)].at(-1);
  if (line === undefined) return body.length;
  const before = prose.slice(0, line.index);
  const opened = before.search(/<details[^>]*>(?![\s\S]*<\/?details\b)[\s\S]*$/i);
  return opened >= 0 ? opened : line.index;
}

/** Whether a <details> tag's attributes include `open` itself, not a value that holds the word. */
const isOpen = (attributes: string) =>
  /(?:^|\s)open(?=\s|\/|$)/i.test(attributes.replace(/=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/g, ''));

/** What stands for a character of code while the rest is read: no pattern below matches it. */
const CODE = '\u0001';

/**
 * How many characters a description shows before anything is unfolded: what lies outside each closed `<details>`, and
 * each one's summary; an open one shows whole, except one whose summary names a threat model, which must stay open
 * whatever its length and is not counted. The attribution the caller adds is not counted either. It approximates what
 * shows, by patterns rather than a renderer: comments, tags and where links and pictures point are not counted, a
 * link's words are, and each run of white space counts as one. Code is set aside first, each of its characters but
 * white space held by a placeholder no pattern matches, so it counts as written, delimiters included.
 */
export function shown(body: string): number {
  const all = outsideCode(body);
  const end = attribution(body, all);
  const prose = all.slice(0, end);
  const text = body.slice(0, end);
  let masked = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i] ?? '';
    masked += prose[i] === c || /\s/.test(c) ? c : CODE;
  }
  const tag = /<!--[\s\S]*?-->|<(\/?)(details|summary)\b([^>]*)>/gi;
  const folds: { open: boolean; summary: boolean; from: number; at: number; skip: boolean }[] = [];
  const visible = () => folds.every((f, i) => !f.skip && (f.open || (i === folds.length - 1 && f.summary)));
  let kept = '';
  let at = 0;
  for (const m of prose.matchAll(tag)) {
    if (visible()) kept += masked.slice(at, m.index);
    at = m.index + m[0].length;
    if (!m[2]) continue;
    const closing = m[1] === '/';
    const top = folds.at(-1);
    if (m[2].toLowerCase() === 'details') {
      if (closing) folds.pop();
      else folds.push({ open: isOpen(m[3] ?? ''), summary: false, from: kept.length, at, skip: false });
    } else if (top) {
      top.summary = !closing;
      if (closing && top.open && /threat model/i.test(text.slice(top.at, m.index))) {
        kept = kept.slice(0, top.from);
        top.skip = true;
      }
    }
  }
  if (visible()) kept += masked.slice(at);
  return kept
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<\/?[a-z][^>]*>/gi, '')
    .replace(/\s+/g, ' ')
    .trim().length;
}

/**
 * A line when the description is empty (GitHub gives none for a pull request without one), or shows more than a change
 * of this many changed lines allows; none otherwise.
 */
export function oversize(body: string | null, changed: number): string[] {
  if (!body?.trim()) return ['the description is empty'];
  const size = shown(body);
  const most = limit(changed);
  if (size <= most) return [];
  const n = (x: number) => x.toLocaleString('en-GB');
  return [
    `it shows ${n(size)} characters unfolded, and a change of ${n(changed)} changed lines gets ${n(most)} at most: fold the proofs, tests and rollout, or cut`,
  ];
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const pr = args[0] === '--pr' ? args[1] : undefined;
  const base = pr ? undefined : args[1];
  if (!args[0] || !(pr ?? base)) {
    console.error('usage: node check.ts <file> <base> | --pr <n>');
    process.exit(2);
  }
  const gh = (...a: string[]) => execFileSync('gh', a, { encoding: 'utf8', input: '' });
  // The change's size as GitHub counts it, added and deleted lines with binary files at none: the pull request's own,
  // or the branch's against its base, in the checkout this runs in.
  let body: string;
  let changed = 0;
  if (pr) {
    const view = JSON.parse(gh('pr', 'view', pr, '--json', 'body,additions,deletions'));
    body = view.body ?? '';
    changed = view.additions + view.deletions;
  } else {
    body = readFileSync(args[0], 'utf8');
    const numstat = execFileSync('git', ['diff', '--numstat', `${base}...HEAD`], { encoding: 'utf8' });
    for (const line of numstat.split('\n')) {
      const [added, deleted] = line.split('\t');
      changed += (Number(added) || 0) + (Number(deleted) || 0);
    }
  }
  const repo = gh('repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner').trim();
  // GitHub's own renderer: it reads the text and publishes nothing. Not needed for folds the rule already named, whose
  // Markdown left as text it would name again.
  const folds = unrenderedFolds(body);
  const html = folds.length
    ? ''
    : execFileSync('gh', ['api', 'markdown', '-f', 'mode=gfm', '-f', `context=${repo}`, '-F', 'text=@-'], {
        encoding: 'utf8',
        input: body,
      });
  const found = [...problems(body, html, pr !== undefined, folds), ...oversize(body, changed)];
  for (const p of found) console.log(p);
  process.exit(found.length ? 1 : 0);
}
