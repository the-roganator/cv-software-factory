import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { readTarget } from '../../../../apps/factory/src/vulnerabilities/fixes.ts';
import {
  contentWaits,
  newKey,
  open,
  readKey,
  type State,
  type StateFinding,
  type StateWait,
  seal,
} from '../../../../apps/factory/src/vulnerabilities/state.ts';

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

/** The script run on a state and its run's `moves.json`, as the step runs it: from a folder whose `factory/` is this repository. */
function agedWith(
  state: State,
  moves: object,
  days: string,
  key = newKey(),
): { state: State; moves: { waiting?: { why: string; until?: string; routine?: true }[] } } {
  const dir = mkdtempSync(join(tmpdir(), 'aged-'));
  dirs.push(dir);
  symlinkSync(resolve(import.meta.dirname, '../../../..'), join(dir, 'factory'));
  const file = join(dir, 'state.sealed');
  const movesFile = join(dir, 'moves.json');
  writeFileSync(file, seal(state, readKey(key)));
  writeFileSync(movesFile, JSON.stringify(moves));
  execFileSync(process.execPath, ['--input-type=module', '-', file, movesFile], {
    cwd: dir,
    input: script(),
    env: { ...process.env, SCAN_STATE_KEY: key, DAYS: days, GITHUB_REPOSITORY: REPOSITORY, GITHUB_RUN_ID: RUN },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return {
    state: open(readFileSync(file), readKey(key), REPOSITORY, RUN),
    moves: JSON.parse(readFileSync(movesFile, 'utf8')),
  };
}
const aged = (state: State, days: string, key?: string): State => agedWith(state, { moves: [] }, days, key).state;

/** A finding as the state's own type has it: the fields the step reads (`waits[].seen`, `.day`) are held to state.ts. */
const finding = (waits: StateWait[] | undefined, seen: string): StateFinding => ({
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
});
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
    const [after] = aged(state, '2').findings;
    expect(Date.parse(seen) - Date.parse(after?.waits?.[0]?.seen ?? '')).toBe(2 * DAY);
    expect(Date.parse(due) - Date.parse(after?.waits?.[0]?.day ?? '')).toBe(2 * DAY);
    // The finding's own day, which its deadline counts from, stays.
    expect(after?.seen).toBe(found);
  });

  it('moves a pin of the same run’s moves.json that waits for that content’s day back the same, and no other', () => {
    const [seen, due] = [day(60_000), day(60_000 - DAY)];
    const state: State = {
      version: 1,
      repository: REPOSITORY,
      run: RUN,
      findings: [finding([{ target: TARGET, from: '18.6-alpine3.24', seen, day: due }], day(9 * DAY))],
    };
    const other = day(-3 * DAY);
    const moves = {
      waiting: [
        { why: 'content', until: due },
        { why: 'content', until: due, routine: true },
        { why: 'content', until: other },
        { why: 'no-better' },
      ],
    };
    const after = agedWith(state, moves, '2');
    const [wait] = after.state.findings[0]?.waits ?? [];
    // The worker holds the two to each other: the same day on each side.
    expect(after.moves.waiting?.[0]?.until).toBe(wait?.day);
    expect(Date.parse(due) - Date.parse(after.moves.waiting?.[0]?.until ?? '')).toBe(2 * DAY);
    // A routine update's wait is the state's routine record's, which the step leaves; another day is no sighting's.
    expect(after.moves.waiting?.[1]?.until).toBe(due);
    expect(after.moves.waiting?.[2]?.until).toBe(other);
    expect(after.moves.waiting?.[3]).toEqual({ why: 'no-better' });
  });

  it('leaves the day a fix is installable where that was before the scan first saw it', () => {
    const [seen, own] = [day(60_000), day(5 * DAY)];
    const state: State = {
      version: 1,
      repository: REPOSITORY,
      run: RUN,
      findings: [finding([{ target: TARGET, from: '18.6-alpine3.24', seen, day: own }], own)],
    };
    const [after] = aged(state, '2').findings;
    expect(Date.parse(seen) - Date.parse(after?.waits?.[0]?.seen ?? '')).toBe(2 * DAY);
    expect(after?.waits?.[0]?.day).toBe(own);
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
    const [after] = aged(state, '2').findings;
    expect(after?.waits?.[0]?.seen).toBe(seen);
  });

  it('puts back what the scan’s own code wrote, so the scan after it finds the fix’s content waited', () => {
    const target = readTarget(TARGET);
    if (!target) throw new Error('the target is not one the grammar reads');
    const from = '18.6-alpine3.24';
    const found = (now: number) => ({ at: [now - 5 * DAY], fixes: [target], places: [{ from }] });
    // The first scan after a reset, with no state: the fix's content is first seen now, and waits its day.
    const now = Date.now();
    const first = found(now);
    const [waits] = contentWaits(first, ['postgres'], undefined, 1, now);
    expect(first.at[0]).toBeGreaterThan(now);
    const state: State = { version: 1, repository: REPOSITORY, run: RUN, findings: [finding(waits, day(9 * DAY))] };
    // The scan after it, on the state the step put back: the same target, installable now.
    const last = { state: aged(state, '2'), keyOf: () => 'postgres' };
    const later = Date.now();
    const second = found(later);
    contentWaits(second, ['postgres'], last, 1, later);
    expect(second.fixes[0]).toEqual(target);
    expect(second.at[0]).toBeLessThanOrEqual(later);
  });

  it('refuses a number of days that is not one', () => {
    const state: State = { version: 1, repository: REPOSITORY, run: RUN, findings: [] };
    expect(() => aged(state, 'many')).toThrow(/whole number of days/);
  });
});
