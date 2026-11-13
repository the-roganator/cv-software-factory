/**
 * The journeys gate: the probes and the crawler, run against a pull request's base and its change, and compared.
 * The app is broken on purpose, so a check that fails on both says nothing about the change; the gate fails only on
 * a check that passes on the base and fails on the change, and fails on the change again when run a second time (a
 * check that fails once can be the network). A check that passes on the base and cannot finish on the change (it
 * times out, or what it needs has gone) is as bad as one that fails: it fails the gate the same way, when it happens
 * twice. A check the base could not tell about is reported, not failed on.
 *
 * The base and the change are observed at once, and only what failed on the change is observed again.
 */
import { cutAt, cutTo, DEFECT_SYMPTOMS, type DefectSymptom, type Evidence } from '@software-factory/events';
import { z } from 'zod';
import { cell } from './report.ts';

/** One check's result in one pass. */
export interface Seen {
  sense: string;
  check: string;
  route: string;
  failed: boolean;
  /** What a failed check called what it saw. */
  symptom?: DefectSymptom;
  /** Why the check could not tell, when it could not. */
  trouble?: string;
  message?: string;
  /** What a failed check kept as proof. */
  evidence?: Evidence[];
  /**
   * A `/device` check's reading, as `<kind> <name>`: what the pages kept on the device beyond what is allowed, and the
   * app's preview cookie, kept to its contract after the pass asked for a preview. Absent when there is neither.
   */
  kept?: string[];
  allowed?: string[];
}

export interface Comparison {
  /** Pass on the base, and fail or cannot finish on the change, twice: these fail the gate. */
  regressions: Seen[];
  /** Fail on the base, pass on the change. */
  fixed: Seen[];
  /** Fail on both: the app as it was. */
  unchanged: Seen[];
  /** Failed, or could not finish, on the change once, then passed. */
  flaky: Seen[];
  /** Fail on the change, where the base could not tell. */
  unsure: Seen[];
  /**
   * How many checks ran on each, and how many passed: on the change, one that failed once and then passed when run
   * again does; one the second run left out does not.
   */
  counts: { base: Count; change: Count };
}

/** How many checks ran, and how many of those passed. */
export interface Count {
  passed: number;
  ran: number;
}

export const keyOf = (s: Pick<Seen, 'sense' | 'check' | 'route'>) => `${s.sense} ${s.check} ${s.route}`;

/**
 * Observes one app and says what each check saw. Given `only`, the checks wanted again, it may leave out the rest; it
 * may also run more than those, as a sense that cannot run one check alone does.
 */
export type Observe = (app: string, only?: readonly Seen[]) => Promise<Seen[]>;

export async function compareJourneys(observe: Observe, base: string, change: string): Promise<Comparison> {
  const index = (seen: Seen[]) => new Map(seen.map((s) => [keyOf(s), s]));
  const [seenOnBase, first] = await Promise.all([observe(base), observe(change)]);
  const before = index(seenOnBase);
  const failing = first.filter((s) => s.failed);
  // Passed cleanly on the base: no finding, and no trouble.
  const passed = (s: Seen) => {
    const was = before.get(keyOf(s));
    return was !== undefined ? !was.failed && !was.trouble : true;
  };
  const bad = (s: Seen | undefined) => s !== undefined && (s.failed || s.trouble !== undefined);
  const candidates = first.filter((s) => bad(s) && passed(s));
  const again = candidates.length ? index(await observe(change, candidates)) : new Map<string, Seen>();
  const after = index(first);
  const regressions = candidates.filter((s) => bad(again.get(keyOf(s)))).map((s) => again.get(keyOf(s)) ?? s);
  const flaky = candidates.filter((s) => !bad(again.get(keyOf(s))));
  return {
    regressions,
    flaky,
    unsure: failing.filter((s) => !before.get(keyOf(s))?.failed && before.get(keyOf(s))?.trouble),
    unchanged: failing.filter((s) => before.get(keyOf(s))?.failed),
    fixed: [...before.values()].filter((s) => s.failed && after.has(keyOf(s)) && !after.get(keyOf(s))?.failed),
    counts: {
      base: { passed: seenOnBase.filter((s) => !bad(s)).length, ran: seenOnBase.length },
      // A check left out of the second run is not a regression, but nothing saw it pass either.
      change: {
        passed: first.filter((s) => !bad(s)).length + flaky.filter((s) => again.has(keyOf(s))).length,
        ran: first.length,
      },
    },
  };
}

/**
 * What to run again to see `only` again: the probes, by id, that made them (a probe's checks are its id and what the
 * watch saw on its pages, such as `<id>/console`), and whether to crawl, since a crawl cannot look at one route alone.
 */
export function toRunAgain(only: readonly Pick<Seen, 'sense' | 'check'>[]): { probes: Set<string>; crawl: boolean } {
  return {
    probes: new Set(only.filter((s) => s.sense === 'probe').map((s) => s.check.split('/')[0] as string)),
    crawl: only.some((s) => s.sense === 'crawler'),
  };
}

const row = (s: Seen) =>
  `| ${cell(s.sense)} | ${cell(s.check)} | \`${cell(s.route)}\` | ${cell(s.message ?? s.trouble ?? '')} |`;
const table = (seen: Seen[]) =>
  `| Sense | Check | Route | What it saw |\n|---|---|---|---|\n${seen.map(row).join('\n')}`;

export function summary(c: Comparison): string {
  const parts = [
    '## Journeys',
    c.regressions.length
      ? `${c.regressions.length} check${c.regressions.length === 1 ? '' : 's'} that pass on the base fail on this change, twice.\n\n${table(c.regressions)}`
      : `Nothing that passes on the base fails on this change (${c.counts.change.ran} checks).`,
  ];
  if (c.fixed.length) parts.push(`### Fixed\n\nFail on the base and pass on this change.\n\n${table(c.fixed)}`);
  if (c.flaky.length)
    parts.push(`### Failed once\n\nFailed on the change, then passed when run again.\n\n${table(c.flaky)}`);
  if (c.unsure.length)
    parts.push(`### Could not compare\n\nThe base could not tell about these.\n\n${table(c.unsure)}`);
  if (c.unchanged.length)
    parts.push(`<details><summary>${c.unchanged.length} fail on both</summary>\n\n${table(c.unchanged)}\n\n</details>`);
  return parts.join('\n\n');
}

/**
 * The comparison's regressions and counts as one line of JSON, for whoever ran the gate to read back: the canary's
 * analysis runs it as a Job, and the line reads what it wrote from its container's termination message, which
 * Kubernetes keeps to 4 KiB. So it says how many checks passed of how many ran on each side, and only what a signal
 * needs of each check that regressed, its words cut short, as many as fit, and how many more there were.
 */
export function comparisonMessage(c: Comparison, maxBytes = MESSAGE_BYTES): string {
  const all = c.regressions.slice(0, MOST_REGRESSIONS).map((s) => ({
    sense: s.sense,
    check: cutAt(s.check, 80),
    route: s.route,
    ...(s.symptom ? { symptom: s.symptom } : {}),
    ...((s.message ?? s.trouble) ? { message: cutTo((s.message ?? s.trouble ?? '').trim(), 300) } : {}),
  }));
  for (let n = all.length; n >= 0; n--) {
    const more = c.regressions.length - n;
    const text = JSON.stringify({ regressions: all.slice(0, n), ...(more ? { more } : {}), counts: c.counts });
    if (Buffer.byteLength(text) <= maxBytes) return text;
  }
  return JSON.stringify({ regressions: [], more: c.regressions.length, counts: c.counts });
}

/** Kubernetes keeps 4096 bytes of a container's termination message. */
const MESSAGE_BYTES = 4096;
/** The most regressions a message names: as many as a signal's evidence keeps. */
const MOST_REGRESSIONS = 8;

const regression = z.object({
  sense: z.enum(['probe', 'crawler']),
  check: z.string().trim().min(1).max(80),
  route: z.union([
    z
      .string()
      .regex(/^\/[^\s]*$/)
      .max(200),
    z.literal('*'),
  ]),
  symptom: z.enum(DEFECT_SYMPTOMS).optional(),
  message: z.string().trim().min(1).max(300).optional(),
});
export type Regression = z.infer<typeof regression>;

const count = z
  .object({ passed: z.number().int().min(0), ran: z.number().int().min(0) })
  .refine((c) => c.passed <= c.ran);

const message = z.object({
  regressions: z.array(regression).max(MOST_REGRESSIONS),
  more: z.number().int().min(0).optional(),
  /** Missing from what an older gate wrote, and dropped when it is not counts, leaving the regressions to be read. */
  counts: z.object({ base: count, change: count }).optional().catch(undefined),
});
type ComparisonMessage = z.infer<typeof message>;

/**
 * What a comparison message says, or undefined for one that is missing, is not JSON, or does not say what
 * `comparisonMessage` writes: the gate crashed before writing it, or something else wrote there.
 */
export function comparisonIn(text: string | undefined): ComparisonMessage | undefined {
  if (!text?.trim()) return undefined;
  try {
    const parsed = message.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** The regressions a comparison message names, or undefined for one that is not one (`comparisonIn`). */
export function regressionsIn(text: string | undefined): Regression[] | undefined {
  return comparisonIn(text)?.regressions;
}
