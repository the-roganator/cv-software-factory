/**
 * Words and figures as the console writes them: British English, times where the viewer is, money in dollars
 * because that is what the models are billed in.
 */
import type { Autonomy } from '@software-factory/events';
import type { Change } from '@software-factory/policy/settings';

/** The autonomy levels by name, as the header and Controls say them. */
export const AUTONOMY: Record<Autonomy, string> = {
  supervised: 'Supervised',
  guarded: 'Guarded',
  'lights-out': 'Lights-out',
};

const time = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });
const precise = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const weekday = new Intl.DateTimeFormat('en-GB', { weekday: 'short' });
const day = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });

/** The start of the day t falls in, where the viewer is. */
export function startOfDay(t: number): number {
  const start = new Date(t);
  start.setHours(0, 0, 0, 0);
  return start.getTime();
}

/** 16:20 */
export const clock = (at: number) => time.format(at);

/** 16:20:30, for a canary's steps, which last minutes */
export const clockSeconds = (at: number) => precise.format(at);

/** 2:31, for the time left of a canary's step or until its next look: never below 0:00. */
export function countdown(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** Thu 16:20 */
export const shortWhen = (at: number) => `${weekday.format(at)} ${time.format(at)}`;

/** Thu 1 Oct */
export const dayLabel = (at: number) => day.format(at);

/** Thu 1 Oct, 16:20 */
export const when = (at: number) => `${day.format(at)}, ${time.format(at)}`;

/**
 * 31min, 1h 4min, 1d 19h, 9d, or 1s for something very quick. No space between a figure and its unit, so that in mono
 * a duration reads as one value, and a no-break space between its parts, so that it never wraps in the middle.
 */
export function duration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${Math.max(1, seconds)}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours}h\u00a0${minutes % 60}min` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return hours % 24 && days < 7 ? `${days}d\u00a0${hours % 24}h` : `${days}d`;
}

/**
 * The time since an item opened, as the sheet's scrubber shows it: T+04:20, T+1:02:30 past an hour, and T+5d 12:39:59
 * past a day, its days written as a duration writes them, with a no-break space so that it never wraps.
 */
export function sinceStart(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const [d, h, m, s] = [
    Math.floor(total / 86_400),
    Math.floor((total % 86_400) / 3600),
    Math.floor((total % 3600) / 60),
    total % 60,
  ];
  const two = (n: number) => String(n).padStart(2, '0');
  if (d) return `T+${d}d\u00a0${two(h)}:${two(m)}:${two(s)}`;
  return h ? `T+${h}:${two(m)}:${two(s)}` : `T+${two(m)}:${two(s)}`;
}

/** Whether the app's version is a commit rather than a release such as v0.9.3. */
export const isCommit = (version: string) => /^[0-9a-f]{7,40}$/.test(version);

/** A version as the console writes it: a release as it is, a commit by its first seven characters, as GitHub does. */
export const shortVersion = (version: string) => (isCommit(version) ? version.slice(0, 7) : version);

/** Pinned models by a readable name. A local model the console does not know shows as its id, still labelled local. */
const MODEL_NAME: Record<string, string> = {
  'claude-opus-5-5': 'Claude Opus 5.5',
  'claude-sonnet-5-5': 'Claude Sonnet 5.5',
  'claude-haiku-5-5': 'Claude Haiku 5.5',
  // No longer offered, but named by calls and settings made while it was.
  'claude-haiku-4-5': 'Claude Haiku 4.5',
  'qwen/qwen3.8-27b': 'Qwen3.8 27B',
};

/** Claude Sonnet 5.5, Qwen3.8 27B: a pinned model as the sheet and the settings name it. */
export const modelTitle = (model: string) => MODEL_NAME[model] ?? model;

/** A change to the settings in words, as the settings' bar and the audit log say it: "the coder’s effort, medium → high". */
export function changeWords(change: Change): string {
  const usd = (figure: number | null) => (figure === null ? 'none' : money(figure));
  switch (change.field) {
    case 'model':
      return `the ${change.agent}’s model, ${modelTitle(change.before)} → ${modelTitle(change.after)}`;
    case 'effort':
      return `the ${change.agent}’s effort, ${change.before ?? 'none'} → ${change.after ?? 'none'}`;
    case 'cap':
      return `the ${change.cap === 'work-item' ? 'work item' : change.cap}’s cap, ${usd(change.beforeUsd)} → ${usd(change.afterUsd)}`;
  }
}

/** $0.31, or <$0.01 for less than a cent. */
export const money = (usd: number) => (usd > 0 && usd < 0.01 ? '<$0.01' : `$${usd.toFixed(2)}`);

/** 540k, 12k, 900 */
export const tokens = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(Math.round(n)));

/** 4.6%, 0.0%; to two places for a rate the canary judges, 0.25%. Every percentage the console writes is one of these. */
export const percent = (share: number, places = 1) => `${(share * 100).toFixed(places)}%`;

/** A share of pixels changed: to a tenth of a point, a hundredth below one point, and never a change shown as none. */
export const changedShare = (share: number) => (share < 0.0001 ? 'under 0.01%' : percent(share, share < 0.01 ? 2 : 1));

const whole = new Intl.NumberFormat('en-GB');

/** 1,500: a count, grouped in thousands. */
export const count = (n: number) => whole.format(n);

const significant = new Intl.NumberFormat('en-GB', { maximumSignificantDigits: 3 });

/** 642, 0.015, 1,500: a measurement, to three significant figures. */
export const figure = (value: number) => significant.format(value);

/**
 * A chart's axis for values up to `top`: a round maximum a little above it, and ticks at none, half and all of it.
 * Fractions (an error rate of 0.02, a latency of 0.8 s) get fractional ticks.
 */
export function axis(top: number): { max: number; ticks: [number, number, number] } {
  if (!(top > 0)) return { max: 1, ticks: [0, 0.5, 1] };
  const step = 10 ** Math.floor(Math.log10(top));
  // toPrecision drops floating-point dust: 0.1 × 3 is 0.30000000000000004.
  const max = Number((Math.ceil((top * 1.1) / step) * step).toPrecision(12));
  return { max, ticks: [0, Number((max / 2).toPrecision(12)), max] };
}

/** 1 PR, 2 PRs */
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Sentence case for a stage or other lower-case name. */
export const capital = (word: string) => (word[0]?.toUpperCase() ?? '') + word.slice(1);

/** A sentence's words in the middle of another: its first letter in lower case. */
export const lower = (text: string) => (text[0]?.toLowerCase() ?? '') + text.slice(1);

/** A list in words: "a, b and c". */
export const listed = (words: readonly string[]) =>
  words.length > 1 ? `${words.slice(0, -1).join(', ')} and ${words.at(-1)}` : (words[0] ?? '');

const SMALL = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];

/** "one suggestion", "two rounds", "12 files": small counts in words, as a sentence says them. */
export const inWords = (n: number, one: string, many = `${one}s`) => `${SMALL[n] ?? n} ${n === 1 ? one : many}`;

/** once, twice, three times */
export const times = (n: number) => (n === 1 ? 'once' : n === 2 ? 'twice' : `${SMALL[n] ?? n} times`);

/** The agents, as the console names them. */
export const AGENT_NAME: Record<string, string> = {
  triage: 'Triage',
  planner: 'Planner',
  coder: 'Coder',
  reviewer: 'Reviewer',
  describer: 'Describer',
  'red-team': 'Red-team agent',
};

/** The app's repository, where the factory's pull requests are. */
export const APP_REPO = 'https://github.com/the-roganator/cv-worlds-worst-website';
