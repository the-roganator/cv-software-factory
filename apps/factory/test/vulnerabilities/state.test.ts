import { describe, expect, it } from 'vitest';
import {
  latest,
  MAX_SEALED_BYTES,
  newKey,
  open,
  openKept,
  readKey,
  type State,
  type StateApi,
  StateError,
  seal,
} from '../../src/vulnerabilities/state.ts';
import { zipOf } from './zip-of.ts';

/** The state the scan keeps between runs (state.ts, ADR 0021): its seal, its shape, and how the last one is found. */
const REPOSITORY = 'the-roganator/cv-software-factory';
const KEY = readKey(newKey());

const STATE: State = {
  version: 1,
  repository: REPOSITORY,
  run: '19234567890',
  findings: [
    {
      advisory: 'CVE-2099-20001',
      package: 'example-a',
      installed: '1.0.0',
      file: 'pnpm-lock.yaml',
      line: 120,
      repository: 'pnpm-lock.yaml',
      severity: 'HIGH',
      fixed: '1.0.1',
      seen: '2026-10-01T00:00:00Z',
      fix: { target: 'version 1.0.1', day: '2026-11-03T00:00:00Z' },
      move: 1,
    },
    {
      advisory: 'CVE-2099-20002',
      package: 'libexample',
      installed: '1.0-1',
      file: '.devcontainer/Dockerfile',
      line: 2,
      repository: 'node',
      severity: 'LOW',
      seen: '2026-11-10T04:30:00Z',
    },
  ],
};

const sealedWith = (change: (state: Record<string, unknown>) => void) => {
  const state = structuredClone(STATE) as unknown as Record<string, unknown>;
  change(state);
  return seal(state as unknown as State, KEY);
};
const finding = (state: Record<string, unknown>) => (state.findings as Record<string, unknown>[])[0] ?? {};

describe('the seal', () => {
  it('opens to the state it sealed, for its repository and run', () => {
    expect(open(seal(STATE, KEY), KEY, REPOSITORY, STATE.run)).toEqual(STATE);
  });

  it('shows nothing of a finding, and seals the same state differently each time', () => {
    const sealed = seal(STATE, KEY);
    for (const word of ['example-a', 'CVE-2099-20001', 'pnpm-lock.yaml'])
      expect(sealed.includes(Buffer.from(word))).toBe(false);
    expect(seal(STATE, KEY).equals(sealed)).toBe(false);
  });

  it('opens with no other key, for no other run and no other repository', () => {
    const sealed = seal(STATE, KEY);
    expect(() => open(sealed, readKey(newKey()), REPOSITORY, STATE.run)).toThrow(StateError);
    expect(() => open(sealed, KEY, REPOSITORY, '19234567891')).toThrow(StateError);
    expect(() => open(sealed, KEY, 'the-roganator/cv-worlds-worst-website', STATE.run)).toThrow(StateError);
  });

  it('refuses a file changed by a byte, cut short, too large, or that is no state', () => {
    const sealed = seal(STATE, KEY);
    const changed = Buffer.from(sealed);
    changed[changed.length - 1] = (changed[changed.length - 1] ?? 0) ^ 1;
    expect(() => open(changed, KEY, REPOSITORY, STATE.run)).toThrow(StateError);
    expect(() => open(sealed.subarray(0, 20), KEY, REPOSITORY, STATE.run)).toThrow('not a sealed state');
    expect(() => open(Buffer.from(JSON.stringify(STATE)), KEY, REPOSITORY, STATE.run)).toThrow('not a sealed state');
    expect(() => open(Buffer.alloc(MAX_SEALED_BYTES + 1), KEY, REPOSITORY, STATE.run)).toThrow('too large');
  });

  it('never repeats a key it cannot read', () => {
    expect(() => readKey('not-a-key')).toThrow('SCAN_STATE_KEY is not 32 bytes in base64');
    expect(() => readKey('')).toThrow(StateError);
  });
});

describe('a state’s shape', () => {
  it.each<[string, (state: Record<string, unknown>) => void, string]>([
    ['another version', (s) => Object.assign(s, { version: 2 }), 'is version 2, not 1'],
    ['no findings', (s) => Object.assign(s, { findings: 'none' }), 'lists no findings'],
    ['a finding with no package', (s) => Object.assign(finding(s), { package: '' }), 'gives finding 1 no package'],
    [
      'a control character in a path',
      (s) => Object.assign(finding(s), { file: 'pnpm-lock.yaml\n' }),
      'gives finding 1 no file',
    ],
    [
      'a severity that is none',
      (s) => Object.assign(finding(s), { severity: 'SEVERE' }),
      'gives finding 1 no severity',
    ],
    ['a day that is no day', (s) => Object.assign(finding(s), { seen: 'yesterday' }), 'no day it was first seen'],
    [
      'a fix the grammar does not read',
      (s) => Object.assign(finding(s), { fix: { target: 'version 1.0.1; rm -rf', day: '2026-11-03T00:00:00Z' } }),
      'a fix the grammar does not read',
    ],
    ['a move with no fix', (s) => Object.assign(finding(s), { fix: undefined }), 'a move that is not one'],
    ['a move that is no place', (s) => Object.assign(finding(s), { move: 0 }), 'a move that is not one'],
  ])('refuses %s, naming the finding by its place alone', (_name, change, message) => {
    expect(() => open(sealedWith(change), KEY, REPOSITORY, STATE.run)).toThrow(message);
  });
});

describe('the last state kept', () => {
  const RUNS = `/repos/${REPOSITORY}/actions/workflows/vulnerabilities.yml/runs?branch=main&exclude_pull_requests=true&per_page=20&page=1`;
  const run = (id: number, over: Record<string, unknown> = {}) => ({
    id,
    event: 'schedule',
    head_branch: 'main',
    head_repository: { full_name: REPOSITORY },
    ...over,
  });
  const archive = zipOf({ 'state.sealed': seal(STATE, KEY) });

  /** GitHub as the runs and their artifacts are: each run's artifacts by its id, and what was asked. */
  function github(runs: unknown[], artifacts: Record<number, unknown[]>, downloads: Record<number, Buffer> = {}) {
    const asked: string[] = [];
    const api: StateApi = {
      async json(path) {
        asked.push(path);
        if (path === RUNS) return { workflow_runs: runs };
        const id = Number(/\/actions\/runs\/(\d+)\/artifacts\?name=state&per_page=10$/.exec(path)?.[1]);
        if (id) return { artifacts: artifacts[id] ?? [] };
        throw new Error(`GET ${path}: 404`);
      },
      async bytes(path) {
        asked.push(path);
        return downloads[Number(/\/actions\/artifacts\/(\d+)\/zip$/.exec(path)?.[1])];
      },
    };
    return { api, asked };
  }

  it('is the newest run’s before this one, on the default branch, by schedule, push or hand', async () => {
    const { api, asked } = github(
      [run(50), run(40, { event: 'pull_request' }), run(30, { event: 'push' }), run(20)],
      { 30: [{ id: 7, name: 'state', expired: false, size_in_bytes: archive.length }] },
      { 7: archive },
    );
    const kept = await latest(api, REPOSITORY, 'main', '50');
    expect(kept?.run).toBe('30');
    expect(asked).toEqual([
      RUNS,
      `/repos/${REPOSITORY}/actions/runs/30/artifacts?name=state&per_page=10`,
      `/repos/${REPOSITORY}/actions/artifacts/7/zip`,
    ]);
  });

  it('passes over a fork’s run, another branch’s, a run that kept none, and a state that has expired', async () => {
    const { api } = github(
      [
        run(90, { head_repository: { full_name: 'someone/cv-software-factory' } }),
        run(80, { head_branch: 'feat/other' }),
        run(70),
        run(60),
        run(50),
      ],
      {
        70: [{ id: 3, name: 'moves' }],
        60: [{ id: 4, name: 'state', expired: true }],
        50: [{ id: 5, name: 'state', expired: false }],
      },
      { 5: archive },
    );
    expect((await latest(api, REPOSITORY, 'main'))?.run).toBe('50');
  });

  it('is none when no run kept one, or the one kept is gone', async () => {
    expect(await latest(github([run(50)], {}).api, REPOSITORY, 'main')).toBeUndefined();
    const gone = github([run(50)], { 50: [{ id: 5, name: 'state', expired: false }] });
    expect(await latest(gone.api, REPOSITORY, 'main')).toBeUndefined();
  });

  it('opens the one file of the archive for the run it was on, and refuses any other archive', () => {
    expect(openKept({ run: STATE.run, archive }, KEY, REPOSITORY)).toEqual(STATE);
    expect(() => openKept({ run: '30', archive }, KEY, REPOSITORY)).toThrow(StateError);
    expect(() => openKept({ run: STATE.run, archive: zipOf({ 'moves.json': '{}' }) }, KEY, REPOSITORY)).toThrow(
      'holds no state.sealed',
    );
    expect(() => openKept({ run: STATE.run, archive: Buffer.from('not a zip') }, KEY, REPOSITORY)).toThrow(
      'not a readable archive',
    );
  });
});
