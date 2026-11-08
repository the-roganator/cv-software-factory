/**
 * What a visitor's report points at on its page: a passage of the page's text, or one of its elements, chosen by Jev
 * from the page as the factory read it itself, never from the visitor's words. A report's ticket carries them as its
 * `points`, so every agent, the issue and the console say what was reported alike, in the words below.
 *
 * Which a report can point at follows from what it describes: a content report, and a symptom a visitor sees in the
 * page's words, a passage; a symptom of one link, image, field or button, an element of those kinds; and a symptom of
 * the whole page (an error, slowness, a header, the logs) nothing at all.
 */
import { PAGE_PATH } from './line.ts';
import { cutAt } from './text.ts';
import type { SymptomClass } from './vocabulary.ts';

export const ELEMENT_KINDS = ['link', 'image', 'field', 'button'] as const;
export type ElementKind = (typeof ELEMENT_KINDS)[number];

/**
 * An element of a page, as the factory read it: the app's own markup, never what anyone typed. A link's or an image's
 * address is its path on the app alone, with no query or fragment, or null when it is off the app. A field is named
 * by its label, its `name` and its type, never its value.
 */
export type PageElement =
  | { kind: 'link'; text: string | null; to: string | null }
  | { kind: 'image'; alt: string | null; src: string | null }
  | { kind: 'field'; label: string | null; name: string | null; type: string }
  | { kind: 'button'; text: string | null };

/** What a report's ticket points at: the page the visitor sent it from, and a passage or an element of it. */
export interface Points {
  page: string;
  passage?: string | undefined;
  element?: PageElement | undefined;
}

/** How long each of an element's words may be, and its address. */
export const ELEMENT_TEXT = 80;
export const ELEMENT_PATH = 120;

/**
 * What a report with this symptom may point at: a passage of the page's text, elements of these kinds, or nothing,
 * for a symptom of the whole page. A content report points at a passage whatever its symptom.
 */
export const POINTED_BY: Record<SymptomClass, 'passage' | readonly ElementKind[] | null> = {
  'wrong-result': 'passage',
  // Faint text is text: a link's or a button's words in the page's main text are among its passages too.
  'low-contrast': 'passage',
  'broken-link': ['link'],
  'broken-image': ['image'],
  'missing-alt': ['image'],
  'unlabelled-field': ['field'],
  'rejects-valid-input': ['field', 'button'],
  'redirect-loop': null,
  'server-error': null,
  'browser-error': null,
  'slow-response': null,
  'not-cached': null,
  'missing-header': null,
  'leaks-detail': null,
  'missing-log': null,
  'wrong-metric': null,
};

const quoted = (words: string | null) => (words ? `“${words}”` : null);

/** An element in words, the same for Jev's options, the agents, the issue and the console: `the link “Returns”, to /returns`. */
export function elementWords(element: PageElement): string {
  switch (element.kind) {
    case 'link':
      return `the link ${quoted(element.text) ?? 'with no words'}, ${element.to ? `to ${element.to}` : 'off the app'}`;
    case 'image':
      return `the image ${element.src ?? 'from off the app'}, ${element.alt === null ? 'with no description' : element.alt ? `described as “${element.alt}”` : 'with an empty description'}`;
    case 'field':
      return `the ${element.type} field ${element.label ? `labelled “${element.label}”` : 'with no label'}${element.name ? `, named ${element.name}` : ''}`;
    case 'button':
      return `the button ${quoted(element.text) ?? 'with no words'}`;
  }
}

/** What a report's ticket points at, in words: `the passage “…” on /about`, or `the link “Returns”, to /returns, on /`. */
export function pointWords(points: Points): string {
  if (points.passage) return `the passage “${points.passage}” on ${points.page}`;
  if (points.element) return `${elementWords(points.element)}, on ${points.page}`;
  return `nothing on ${points.page}: triage could not point at a passage or an element of it`;
}

/** Whether a ticket's points name something on the page, not just the page. */
export const pointsAtSomething = (points: Points | undefined) => Boolean(points?.passage || points?.element);

/**
 * Whether two tickets' points are the same thing reported: the same passage, or the same element, of the same page;
 * or neither points at anything narrower than a page. A ticket a sense opened points at nothing. A report joins an open ticket only on the same points, so a
 * ticket never stands for something reported that it does not point at.
 */
export function samePoints(a: Points | undefined, b: Points | undefined): boolean {
  if (!pointsAtSomething(a) && !pointsAtSomething(b)) return true;
  if (!a || !b || a.page !== b.page) return false;
  if (a.passage || b.passage) return a.passage === b.passage;
  return a.element !== undefined && b.element !== undefined && sameElement(a.element, b.element);
}

/** The same element, field by field: an element read back from the store may hold its keys in another order. */
function sameElement(a: PageElement, b: PageElement): boolean {
  switch (a.kind) {
    case 'link':
      return b.kind === 'link' && a.text === b.text && a.to === b.to;
    case 'image':
      return b.kind === 'image' && a.alt === b.alt && a.src === b.src;
    case 'field':
      return b.kind === 'field' && a.label === b.label && a.name === b.name && a.type === b.type;
    case 'button':
      return b.kind === 'button' && a.text === b.text;
  }
}

/** A path an element names on the app: its path alone, cut at its query, or null when it is not one of the app's. */
export function appPath(path: string): string | null {
  const bare = path.split(/[?#]/)[0] ?? '';
  return bare.length <= ELEMENT_PATH && PAGE_PATH.test(bare) ? bare : null;
}

/** The most elements of each kind a page is read with, in the page's order. */
export const MAX_ELEMENTS = 40;

const words = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const folded = value.replace(/\s+/g, ' ').trim();
  return folded ? cutAt(folded, ELEMENT_TEXT).trim() : null;
};
const path = (value: unknown) => (typeof value === 'string' ? appPath(value) : null);
/** A field's `name` and type as an element keeps them: the schemas hold an event to the same. */
export const FIELD_NAME = /^[\w.:[\]-]{1,60}$/;
export const FIELD_TYPE = /^[a-z-]{1,20}$/;

function elementOf(raw: unknown): PageElement | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  switch (r.kind) {
    case 'link':
      return { kind: 'link', text: words(r.text), to: path(r.to) };
    case 'image':
      // An empty description is not none: it marks an image as decoration.
      return { kind: 'image', alt: typeof r.alt === 'string' ? (words(r.alt) ?? '') : null, src: path(r.src) };
    case 'field':
      return {
        kind: 'field',
        label: words(r.label),
        name: typeof r.name === 'string' && FIELD_NAME.test(r.name) ? r.name : null,
        type: typeof r.type === 'string' && FIELD_TYPE.test(r.type) ? r.type : 'text',
      };
    case 'button':
      return { kind: 'button', text: words(r.text) };
    default:
      return null;
  }
}

/**
 * Elements as a question may offer them and an event may keep them, from anything: each in its shape, its words
 * folded and cut, an address the app's path alone or null, no two alike, and at most `MAX_ELEMENTS` of each kind.
 */
export function elementsOf(raw: readonly unknown[]): PageElement[] {
  const seen = new Set<string>();
  const counts = new Map<ElementKind, number>();
  const elements: PageElement[] = [];
  for (const r of raw) {
    const element = elementOf(r);
    if (!element) continue;
    const key = elementWords(element);
    const n = counts.get(element.kind) ?? 0;
    if (seen.has(key) || n >= MAX_ELEMENTS) continue;
    seen.add(key);
    counts.set(element.kind, n + 1);
    elements.push(element);
  }
  return elements;
}
