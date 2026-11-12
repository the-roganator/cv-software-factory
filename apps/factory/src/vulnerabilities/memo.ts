/**
 * The day's lookups, kept between runs: what deadlines.ts asked a registry or a publisher's releases (npm's publish
 * times, Node's release index, an image's tags, digest and manifests, a chart repository's versions and a chart's
 * rendering, a tool's releases, a k3s release), each answer asked once a day (UTC) and reused by every run that day.
 * A release published after the day's first lookup is seen the next day, as the daily scan sees it.
 *
 * Only answers are kept: a lookup that failed is asked again by the next run. Nothing that depends on the advisory
 * database (Trivy's reports of a newer image or a tool's release) or on code scanning (the alerts) is kept: the first
 * changes every few hours, the second is the scan's own state. A file from another day, of another shape, or that does
 * not parse is read as empty, and the run asks everything again.
 *
 *     deadlines.ts … --memo <file>
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { aquaRepository, type Sources } from './deadlines.ts';

const VERSION = 1;

/** The day a lookup is good for: its UTC date. */
export const dayOf = (now: number) => new Date(now).toISOString().slice(0, 10);

export interface Memo {
  version: number;
  day: string;
  /** Each answer, by its lookup and arguments (`tags docker.io/library/postgres`): an answer of none as `none`. */
  answers: Record<string, { value: unknown } | { none: true }>;
}

/** The kept answers, if the file holds today's; otherwise none. */
export function readMemo(file: string, now: number): Memo {
  const empty: Memo = { version: VERSION, day: dayOf(now), answers: {} };
  if (!existsSync(file)) return empty;
  try {
    const kept = JSON.parse(readFileSync(file, 'utf-8')) as Partial<Memo>;
    if (kept.version !== VERSION || kept.day !== empty.day) return empty;
    if (!kept.answers || typeof kept.answers !== 'object' || Array.isArray(kept.answers)) return empty;
    return { ...empty, answers: kept.answers };
  } catch {
    return empty;
  }
}

export function writeMemo(file: string, memo: Memo) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(memo));
}

/** How many of the run's lookups were answered from the day's, and how many asked. */
export interface MemoCount {
  kept: number;
  asked: number;
}

/**
 * The sources, each lookup answered from the memo when it holds the day's answer, and otherwise asked and the answer
 * kept. Two calls with the same arguments in one run share one lookup, as the sources' own callers expect.
 */
export function memoised(sources: Sources, memo: Memo, count: MemoCount = { kept: 0, asked: 0 }): Sources {
  const inFlight = new Map<string, Promise<unknown>>();
  const once = <T>(key: string, ask: () => Promise<T>): Promise<T> => {
    const held = memo.answers[key];
    if (held && typeof held === 'object' && ('value' in held || held.none === true)) {
      count.kept++;
      return Promise.resolve(('value' in held ? held.value : undefined) as T);
    }
    let pending = inFlight.get(key) as Promise<T> | undefined;
    if (!pending) {
      count.asked++;
      pending = ask().then((value) => {
        memo.answers[key] = value === undefined ? { none: true } : { value };
        return value;
      });
      // A failed lookup is not kept, and the next call asks again.
      pending.catch(() => inFlight.delete(key));
      inFlight.set(key, pending);
    }
    return pending;
  };
  return {
    ...sources,
    published: (name, version) => once(`published ${name} ${version}`, () => sources.published(name, version)),
    releases: () => once('releases', () => sources.releases()),
    tags: (repository) => once(`tags ${repository}`, () => sources.tags(repository)),
    digest: (reference) => once(`digest ${reference}`, () => sources.digest(reference)),
    manifests: (reference) => once(`manifests ${reference}`, () => sources.manifests(reference)),
    chartVersions: (repo, chart) => once(`chartVersions ${repo} ${chart}`, () => sources.chartVersions(repo, chart)),
    // A chart's rendering, keyed by everything it is rendered from: the chart, its version and repository, the
    // Kubernetes version, and the contents of each values file in the checkout.
    render: (chart, kubeVersion) =>
      once(`render ${renderKey(sources, chart, kubeVersion)}`, () => sources.render(chart, kubeVersion)),
    // A tool's releases, keyed by the repository mise.lock names for it, so a tool that moves publisher is asked again.
    toolReleases: (tool) =>
      once(`toolReleases ${tool} ${aquaRepository(sources.file('mise.lock') ?? '', tool) ?? ''}`, () =>
        sources.toolReleases(tool),
      ),
    k3s: (release) => once(`k3s ${release}`, () => sources.k3s(release)),
  };
}

function renderKey(sources: Sources, chart: Parameters<Sources['render']>[0], kubeVersion: string | undefined) {
  const values = chart.values.map((file) => [file, sources.file(file) ?? null]);
  return createHash('sha256')
    .update(JSON.stringify([chart.repo, chart.chart, chart.version, chart.release, kubeVersion ?? null, values]))
    .digest('hex');
}
