import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Sources } from '../../src/vulnerabilities/deadlines.ts';
import { dayOf, type MemoCount, memoised, readMemo, writeMemo } from '../../src/vulnerabilities/memo.ts';

const NOON = Date.parse('2026-11-12T12:00:00Z');
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const fileIn = () => {
  const dir = mkdtempSync(join(tmpdir(), 'memo-'));
  dirs.push(dir);
  return join(dir, 'lookups', 'deadlines.json');
};

/** Sources that count each lookup, with the checkout's files given. */
function counting(files: Record<string, string> = {}) {
  const calls: string[] = [];
  const sources = {
    published: async (name: string, version: string) => {
      calls.push(`published ${name} ${version}`);
      return version === '1.0.1' ? '2026-11-01T00:00:00Z' : undefined;
    },
    releases: async () => {
      calls.push('releases');
      return [{ version: 'v24.22.1', date: '2026-11-10' }];
    },
    tags: async (repository: string) => {
      calls.push(`tags ${repository}`);
      return ['1.0', '1.1'];
    },
    render: async (chart: { chart: string }, kubeVersion?: string) => {
      calls.push(`render ${chart.chart} ${kubeVersion}`);
      return `rendered ${files['values.yaml']}`;
    },
    k3s: async (release: string) => {
      calls.push(`k3s ${release}`);
      return undefined;
    },
    alerts: async () => {
      calls.push('alerts');
      return [];
    },
    image: async (reference: string) => {
      calls.push(`image ${reference}`);
      return {};
    },
    file: (path: string) => files[path],
  } as unknown as Sources;
  return { sources, calls };
}

const CHART = {
  repo: 'https://charts.example',
  chart: 'loki',
  version: '1.0.0',
  release: 'loki',
  values: ['values.yaml'],
};

describe('the day’s lookups', () => {
  it('asks each once a day and answers the day’s other runs from the file, an answer of none included', async () => {
    const file = fileIn();
    const first = counting();
    const memo = readMemo(file, dayOf(NOON));
    const asked: MemoCount = { kept: 0, asked: 0 };
    const sources = memoised(first.sources, memo, asked);
    expect(await sources.tags('docker.io/library/postgres')).toEqual(['1.0', '1.1']);
    expect(await sources.published('left-pad', '1.0.1')).toBe('2026-11-01T00:00:00Z');
    expect(await sources.published('left-pad', '9.9.9')).toBeUndefined();
    expect(await sources.k3s('v1.37.2+k3s1')).toBeUndefined();
    expect(asked).toEqual({ kept: 0, asked: 4 });
    writeMemo(file, memo);

    const later = counting();
    const again = memoised(later.sources, readMemo(file, dayOf(NOON + 6 * 3_600_000)), asked);
    expect(await again.tags('docker.io/library/postgres')).toEqual(['1.0', '1.1']);
    expect(await again.published('left-pad', '9.9.9')).toBeUndefined();
    expect(await again.k3s('v1.37.2+k3s1')).toBeUndefined();
    expect(later.calls).toEqual([]);
    expect(asked.kept).toBe(3);
  });

  it('asks afresh the next day, and reads a file of another shape, or that does not parse, as empty', () => {
    const file = fileIn();
    writeMemo(file, { version: 1, day: dayOf(NOON), answers: { releases: { value: [] } } });
    expect(Object.keys(readMemo(file, dayOf(NOON)).answers)).toEqual(['releases']);
    // Midnight, UTC: the next day.
    expect(readMemo(file, dayOf(Date.parse('2026-11-13T00:00:00Z'))).answers).toEqual({});
    writeFileSync(file, JSON.stringify({ version: 2, day: dayOf(NOON), answers: { releases: { value: [] } } }));
    expect(readMemo(file, dayOf(NOON)).answers).toEqual({});
    writeFileSync(file, JSON.stringify({ version: 1, day: dayOf(NOON), answers: [] }));
    expect(readMemo(file, dayOf(NOON)).answers).toEqual({});
    writeFileSync(file, '{');
    expect(readMemo(file, dayOf(NOON)).answers).toEqual({});
    expect(readMemo(join(file, 'none'), dayOf(NOON)).answers).toEqual({});
  });

  it('keeps no failed lookup, so the next call and the next run ask again', async () => {
    let fail = true;
    const memo = readMemo(fileIn(), dayOf(NOON));
    const flaky = {
      ...counting().sources,
      releases: async () => {
        if (fail) throw new Error("Node's release index answered 503");
        return [];
      },
    } as Sources;
    const sources = memoised(flaky, memo);
    await expect(sources.releases()).rejects.toThrow('503');
    expect(memo.answers).toEqual({});
    fail = false;
    expect(await sources.releases()).toEqual([]);
    expect(Object.keys(memo.answers)).toEqual(['releases']);
  });

  it('shares one lookup between calls in a run, as the sources’ callers expect', async () => {
    const { sources, calls } = counting();
    const memoed = memoised(sources, readMemo(fileIn(), dayOf(NOON)));
    await Promise.all([memoed.tags('a'), memoed.tags('a'), memoed.tags('b')]);
    expect(calls).toEqual(['tags a', 'tags b']);
  });

  it('renders a chart again when anything it is rendered from changes: its values files’ contents among them', async () => {
    const memo = readMemo(fileIn(), dayOf(NOON));
    const one = counting({ 'values.yaml': 'a: 1' });
    expect(await memoised(one.sources, memo).render(CHART, '1.37.1')).toBe('rendered a: 1');
    const same = counting({ 'values.yaml': 'a: 1' });
    await memoised(same.sources, memo).render(CHART, '1.37.1');
    expect(same.calls).toEqual([]);
    const changed = counting({ 'values.yaml': 'a: 2' });
    expect(await memoised(changed.sources, memo).render(CHART, '1.37.1')).toBe('rendered a: 2');
    const kube = counting({ 'values.yaml': 'a: 2' });
    await memoised(kube.sources, memo).render(CHART, '1.38.0');
    const version = counting({ 'values.yaml': 'a: 2' });
    await memoised(version.sources, memo).render({ ...CHART, version: '1.0.1' }, '1.38.0');
    const helm = counting({ 'values.yaml': 'a: 2' });
    await memoised(helm.sources, memo, undefined, 'v4.1.0+g1').render({ ...CHART, version: '1.0.1' }, '1.38.0');
    expect([changed.calls, kube.calls, version.calls, helm.calls].map((calls) => calls.length)).toEqual([1, 1, 1, 1]);
  });

  it('never keeps what the advisory database or code scanning answers', async () => {
    const { sources, calls } = counting();
    const memo = readMemo(fileIn(), dayOf(NOON));
    const memoed = memoised(sources, memo);
    await memoed.alerts();
    await memoed.alerts();
    await memoed.image('postgres:18');
    await memoed.image('postgres:18');
    expect(calls).toEqual(['alerts', 'alerts', 'image postgres:18', 'image postgres:18']);
    expect(memo.answers).toEqual({});
  });

  it('writes the file where it is told, making its directory', () => {
    const file = fileIn();
    writeMemo(file, readMemo(file, dayOf(NOON)));
    expect(JSON.parse(readFileSync(file, 'utf-8'))).toEqual({ version: 1, day: '2026-11-12', answers: {} });
  });
});
