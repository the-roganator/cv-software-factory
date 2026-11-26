import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { newKey, open, readKey, type State, seal } from '../../../../apps/factory/src/vulnerabilities/state.ts';

/**
 * The step staged/factory/28-content-seen-days-ago.patch adds to the copies' scan, run here as the patch writes it: its
 * script is read out of the patch, and given a state this repository's own code sealed.
 */
const PATCH = join(import.meta.dirname, '../staged/factory/28-content-seen-days-ago.patch');
const script = () => {
  const lines = readFileSync(PATCH, 'utf8').split('\n');
  const from = lines.findIndex((line) => line.endsWith("<<'JS'"));
  const to = lines.findIndex((line, index) => index > from && line.trim() === '+          JS'.trim());
  if (from < 0 || to < 0) throw new Error('the patch holds no script');
  return lines
    .slice(from + 1, to)
    .map((line) => line.replace(/^\+ {0,10}/, ''))
    .join('\n');
};

const REPOSITORY = 'the-roganator/cv-software-factory-scratch';
const RUN = '4242';
const DAY = 86_400_000;
const day = (ago: number) => new Date(Date.now() - ago).toISOString().replace(/\.\d+Z$/, 'Z');
const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** The script run on a state, as the step runs it: from a folder whose `factory/` is this repository. */
function aged(state: State, days: string, key = newKey()): State {
  const dir = mkdtempSync(join(tmpdir(), 'aged-'));
  dirs.push(dir);
  symlinkSync(resolve(import.meta.dirname, '../../../..'), join(dir, 'factory'));
  const file = join(dir, 'state.sealed');
  writeFileSync(file, seal(state, readKey(key)));
  execFileSync(process.execPath, ['--input-type=module', '-', file], {
    cwd: dir,
    input: script(),
    env: { ...process.env, SCAN_STATE_KEY: key, DAYS: days, GITHUB_REPOSITORY: REPOSITORY, GITHUB_RUN_ID: RUN },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return open(readFileSync(file), readKey(key), REPOSITORY, RUN);
}

const finding = (waits: unknown, seen: string) =>
  ({
    advisory: 'CVE-2026-0001',
    package: 'musl',
    installed: '1.2.5',
    file: 'deploy/base/postgres/statefulset.yaml',
    line: 21,
    repository: 'postgres',
    type: 'alpine',
    severity: 'HIGH',
    seen,
    waits,
  }) as unknown as State['findings'][number];
const TARGET = `image 18.7-alpine3.24@sha256:${'ab'.repeat(32)}`;

describe("the copies' scan, putting its state's sightings back", () => {
  it('writes a fix’s content first seen today as seen that many days ago, and seals the state for the same run', () => {
    const [seen, due, found] = [day(60_000), day(60_000 - DAY), day(9 * DAY)];
    const state: State = {
      version: 1,
      repository: REPOSITORY,
      run: RUN,
      findings: [finding([{ target: TARGET, from: '18.6-alpine3.24', seen, day: due }], found)],
    };
    const [after] = aged(state, '2').findings as unknown as { seen: string; waits: { seen: string; day: string }[] }[];
    expect(Date.parse(seen) - Date.parse(after?.waits[0]?.seen ?? '')).toBe(2 * DAY);
    expect(Date.parse(due) - Date.parse(after?.waits[0]?.day ?? '')).toBe(2 * DAY);
    // The finding's own day, which its deadline counts from, stays.
    expect(after?.seen).toBe(found);
  });

  it('leaves the day a fix is installable where that was before the scan first saw it', () => {
    const [seen, own] = [day(60_000), day(5 * DAY)];
    const state: State = {
      version: 1,
      repository: REPOSITORY,
      run: RUN,
      findings: [finding([{ target: TARGET, from: '18.6-alpine3.24', seen, day: own }], own)],
    };
    const [after] = aged(state, '2').findings as unknown as { waits: { seen: string; day: string }[] }[];
    expect(Date.parse(seen) - Date.parse(after?.waits[0]?.seen ?? '')).toBe(2 * DAY);
    expect(after?.waits[0]?.day).toBe(own);
  });

  it('leaves a sighting already that old, so a state read and written again goes no further back', () => {
    const seen = day(3 * DAY);
    const state: State = {
      version: 1,
      repository: REPOSITORY,
      run: RUN,
      findings: [
        finding([{ target: TARGET, from: '18.6-alpine3.24', seen, day: seen }], seen),
        finding(undefined, seen),
      ],
    };
    const [after] = aged(state, '2').findings as unknown as { waits: { seen: string }[] }[];
    expect(after?.waits[0]?.seen).toBe(seen);
  });

  it('refuses a number of days that is not one', () => {
    const state: State = { version: 1, repository: REPOSITORY, run: RUN, findings: [] };
    expect(() => aged(state, 'many')).toThrow(/whole number of days/);
  });
});
