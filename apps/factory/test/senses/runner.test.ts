import type { Evidence, InboxSignal } from '@software-factory/events';
import { validateSignal } from '@software-factory/events/schemas';
import { pino } from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type RunnerOptions, SenseRunner } from '../../src/senses/runner.ts';
import type { Finding, Observation, Sense } from '../../src/senses/types.ts';

const V1 = 'a'.repeat(40);
const V2 = 'b'.repeat(40);
const MINUTE = 60_000;

const broken: Finding = { symptom: 'wrong-result', message: 'It was wrong.' };

/** A sense that answers each pass with the next of the results it was given, naming the check `one`. */
function scripted(...results: Array<Finding | null | 'trouble'>) {
  const passes: string[] = [];
  const sense: Sense = {
    name: 'probe',
    async pass(version) {
      passes.push(version);
      const next = results.shift() ?? null;
      const observation: Observation = {
        check: 'one',
        route: '/things',
        finding: next === 'trouble' ? null : next,
        artifacts: [],
        ...(next === 'trouble' && { trouble: 'the app did not answer' }),
      };
      return [observation];
    },
  };
  return { sense, passes };
}

/** A runner with a clock and a version that the test moves, and an inbox that is a list. */
function setup(sense: Sense, options: Partial<RunnerOptions> = {}) {
  const state = { now: Date.parse('2026-10-03T12:00:00Z'), version: V1 };
  const sent: InboxSignal[] = [];
  const runner = new SenseRunner({
    sense,
    version: async () => state.version,
    send: async (signal) => void sent.push(signal),
    log: pino({ level: 'silent' }),
    now: () => state.now,
    ...options,
  });
  /** Moves the clock on, then looks. */
  const after = async (ms: number) => {
    state.now += ms;
    return runner.tick();
  };
  return { runner, state, sent, after };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('a check that fails', () => {
  it('opens nothing the first time, and signals the second time in a row', async () => {
    const { sense } = scripted(broken, broken);
    const { runner, sent, after } = setup(sense);
    await runner.tick();
    expect(sent).toEqual([]);
    await after(5 * MINUTE);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      sense: 'probe',
      check: 'one',
      route: '/things',
      version: V1,
      symptom: 'wrong-result',
      summary: 'It was wrong.',
      observedAt: '2026-10-03T12:05:00.000Z',
      artifacts: [],
    });
    expect(validateSignal(sent[0])).toEqual({ ok: true });
  });

  it('signals again each run it goes on failing, for the inbox to count', async () => {
    const { sense } = scripted(broken, broken, broken);
    const { runner, sent, after } = setup(sense);
    await runner.tick();
    await after(5 * MINUTE);
    await after(5 * MINUTE);
    expect(sent).toHaveLength(2);
  });

  it('starts again at one when it fails in another way', async () => {
    const other: Finding = { symptom: 'server-error', message: 'It fell over.' };
    const { sense } = scripted(broken, other, other);
    const { runner, sent, after } = setup(sense);
    await runner.tick();
    await after(5 * MINUTE);
    expect(sent).toEqual([]);
    await after(5 * MINUTE);
    expect(sent.map((s) => s.symptom)).toEqual(['server-error']);
  });

  it('carries the evidence it found, and no more than a signal may', async () => {
    const http: Evidence = {
      kind: 'http',
      method: 'GET',
      url: '/x',
      status: 500,
      headers: {},
      timings: { firstByteMs: 1, totalMs: 2 },
      redirects: [],
    };
    const evidence = Array.from({ length: 10 }, () => http);
    const { sense } = scripted({ ...broken, evidence }, { ...broken, evidence });
    const { runner, sent, after } = setup(sense);
    await runner.tick();
    await after(5 * MINUTE);
    expect(sent[0]?.evidence).toHaveLength(8);
    expect(validateSignal(sent[0])).toEqual({ ok: true });
  });
});

describe('a check that may run only so often', () => {
  /** A sense with one limited check, which counts the runs it was asked to do. */
  function limited() {
    const asked: Array<string[]> = [];
    const sense: Sense = {
      name: 'probe',
      intervals: { one: 60 * MINUTE },
      async pass(_version, skip = new Set()) {
        asked.push(skip.has('one') ? [] : ['one']);
        return skip.has('one') ? [] : [{ check: 'one', route: '/things', finding: null, artifacts: [] }];
      },
    };
    return { sense, asked };
  }

  it('is left out of the runs in between', async () => {
    const { sense, asked } = limited();
    const { runner, after } = setup(sense);
    await runner.tick();
    await after(5 * MINUTE);
    await after(50 * MINUTE);
    await after(5 * MINUTE);
    expect(asked).toEqual([['one'], [], [], ['one']]);
  });

  it('runs at once on a new version', async () => {
    const { sense, asked } = limited();
    const { runner, state, after } = setup(sense);
    await runner.tick();
    state.version = V2;
    await after(15_000);
    expect(asked).toEqual([['one'], ['one']]);
  });
});

describe('a check that passes', () => {
  it('writes nothing, and ends the streak', async () => {
    const { sense } = scripted(broken, null, broken);
    const { runner, sent, after } = setup(sense);
    await runner.tick();
    await after(5 * MINUTE);
    await after(5 * MINUTE);
    expect(sent).toEqual([]);
  });
});

describe('a check that could not tell', () => {
  it('is neither a pass nor a failure: the streak waits', async () => {
    const { sense } = scripted(broken, 'trouble', broken);
    const { runner, sent, after } = setup(sense);
    await runner.tick();
    await after(5 * MINUTE);
    expect(sent).toEqual([]);
    await after(5 * MINUTE);
    expect(sent).toHaveLength(1);
  });

  it('is one warning a run for each route and reason, naming every check it holds', async () => {
    const missing = 'No page was opened at /gone: it answered 404.';
    const observation = (check: string, route: string, trouble: string): Observation => ({
      check,
      route,
      finding: null,
      artifacts: [],
      trouble,
    });
    const sense: Sense = {
      name: 'crawler',
      async pass() {
        return [
          observation('missing-alt@/gone', '/gone', missing),
          observation('broken-link@/gone', '/gone', missing),
          observation('slow@/gone', '/gone', missing),
          observation('broken-link@/', '/', '/gone, from /, gave no answer.'),
        ];
      },
    };
    const lines: Array<Record<string, unknown>> = [];
    const log = pino({ level: 'warn' }, { write: (line: string) => void lines.push(JSON.parse(line)) });
    const { runner } = setup(sense, { log });
    expect(await runner.tick()).toMatchObject({ checks: 4, failed: 0 });
    expect(lines.map(({ msg, route, checks, trouble }) => ({ msg, route, checks, trouble }))).toEqual([
      {
        msg: 'checks could not tell',
        route: '/gone',
        checks: ['missing-alt@/gone', 'broken-link@/gone', 'slow@/gone'],
        trouble: missing,
      },
      {
        msg: 'checks could not tell',
        route: '/',
        checks: ['broken-link@/'],
        trouble: '/gone, from /, gave no answer.',
      },
    ]);
  });
});

describe('when it runs', () => {
  it('runs at once the first time, then every interval, and not between', async () => {
    const { sense, passes } = scripted();
    const { runner, after } = setup(sense, { every: 5 * MINUTE });
    expect((await runner.tick())?.reason).toBe('first run');
    expect(await after(4 * MINUTE)).toBeNull();
    expect((await after(MINUTE))?.reason).toBe('schedule');
    expect(passes).toHaveLength(2);
  });

  it('runs at once when the app’s version changes, whatever the interval', async () => {
    const { sense, passes } = scripted();
    const { runner, state, after } = setup(sense, { every: 5 * MINUTE });
    await runner.tick();
    state.version = V2;
    const run = await after(15_000);
    expect(run).toMatchObject({ reason: 'new version', version: V2 });
    expect(passes).toEqual([V1, V2]);
    expect(await after(15_000)).toBeNull();
  });

  it('puts the new version on the signals it sends', async () => {
    const { sense } = scripted(broken, broken);
    const { runner, state, sent, after } = setup(sense);
    await runner.tick();
    state.version = V2;
    await after(15_000);
    expect(sent.map((s) => s.version)).toEqual([V2]);
  });

  it('does not look while a run is going: never two at once', async () => {
    let release: () => void = () => {};
    const passes: string[] = [];
    const sense: Sense = {
      name: 'probe',
      pass: async (version) => {
        passes.push(version);
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return [];
      },
    };
    const { runner } = setup(sense);
    const first = runner.tick();
    await vi.waitFor(() => expect(passes).toHaveLength(1));
    expect(await runner.tick()).toBeNull();
    expect(await runner.run(V2, 'new version')).toBeNull();
    expect(passes).toHaveLength(1);
    release();
    expect((await first)?.version).toBe(V1);
  });

  it('throws away a run that the app changed under, and runs again', async () => {
    const { sense, passes } = scripted(broken, broken, broken);
    const { runner, state, sent, after } = setup(sense);
    const original = sense.pass.bind(sense);
    sense.pass = async (version) => {
      const observations = await original(version);
      state.version = V2; // the app is replaced while the sense is looking
      return observations;
    };
    expect(await runner.tick()).toBeNull();
    sense.pass = original;
    const again = await after(15_000);
    expect(again).toMatchObject({ reason: 'new version', version: V2 });
    expect(passes).toEqual([V1, V2]);
    // The dropped run counted for nothing: this is the first failure on the new version.
    expect(sent).toEqual([]);
  });

  it('carries on when the app does not report its version, or the inbox is down', async () => {
    const { sense } = scripted(broken, broken, broken);
    const state = { fail: true };
    const sent: InboxSignal[] = [];
    const runner = new SenseRunner({
      sense,
      version: async () => {
        if (state.fail) throw new Error('down');
        return V1;
      },
      send: async () => {
        if (sent.length === 0) {
          sent.push({} as InboxSignal);
          throw new Error('inbox down');
        }
      },
      log: pino({ level: 'silent' }),
      every: 0.001,
    });
    expect(await runner.tick()).toBeNull();
    state.fail = false;
    await runner.tick();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await runner.tick()).toMatchObject({ failed: 1, signalled: 0 });
  });
});

describe('a signal the inbox could not take', () => {
  const refused = Object.assign(new Error('connect ECONNREFUSED 10.43.0.7:5432'), { code: 'ECONNREFUSED' });

  /** A runner whose inbox is a store the test takes away, and the lines it logs, each with its level's name. */
  function withStore(sense: Sense) {
    const store = { away: false, sent: [] as Array<{ check: string; id: string }>, tries: 0 };
    const lines: Array<Record<string, unknown>> = [];
    const log = pino(
      { level: 'info', formatters: { level: (label) => ({ level: label }) } },
      { write: (line: string) => void lines.push(JSON.parse(line)) },
    );
    const state = { now: Date.parse('2026-10-03T12:00:00Z') };
    const runner = new SenseRunner({
      sense,
      version: async () => V1,
      send: async (signal, id) => {
        store.tries++;
        if (store.away) throw refused;
        store.sent.push({ check: signal.check, id });
      },
      log,
      now: () => state.now,
    });
    const after = async (ms: number) => {
      state.now += ms;
      return runner.tick();
    };
    /** The lines about the inbox and the store, as `level: message`. */
    const said = () =>
      lines.filter(({ msg }) => /inbox|store/.test(String(msg))).map(({ level, msg }) => `${level}: ${msg}`);
    return { store, lines, after, said };
  }

  const AWAY =
    'warn: the inbox did not take a signal, as the store is away: it is kept, and sent again when the store is back';

  it('is kept while the store is away for a restart, and handed over at the poll that finds it back', async () => {
    const { sense, passes } = scripted(broken, broken);
    const { store, lines, after, said } = withStore(sense);
    await after(0);
    store.away = true;
    expect(await after(5 * MINUTE)).toMatchObject({ failed: 1, signalled: 0 });
    await after(15_000);
    store.away = false;
    await after(15_000);
    expect(store.sent).toHaveLength(1);
    expect(store.sent[0]?.check).toBe('one');
    expect(said()).toEqual([AWAY, AWAY, 'info: the store is back after 30 s: the inbox took the signals kept for it']);
    expect(lines.find(({ level }) => level === 'warn')).toMatchObject({ sense: 'probe', check: 'one' });
    // Handing over is not a run: the sense looked twice, on its schedule.
    expect(passes).toHaveLength(2);
    await after(15_000);
    expect(store.sent).toHaveLength(1);
  });

  it('is sent again under the id it had, so a store that took it as it went away keeps one', async () => {
    const { sense } = scripted(broken, broken);
    const ids: string[] = [];
    const runner = new SenseRunner({
      sense,
      version: async () => V1,
      send: async (_, id) => {
        ids.push(id);
        if (ids.length === 1) throw refused;
      },
      log: pino({ level: 'silent' }),
      every: 0,
    });
    await runner.tick();
    await runner.tick();
    await runner.tick();
    expect(ids).toHaveLength(2);
    expect(ids[1]).toBe(ids[0]);
  });

  it('is one line a poll while the store is away, however many checks fail, and the newest of each check is kept', async () => {
    const results = [broken, broken, broken];
    const sense: Sense = {
      name: 'crawler',
      async pass() {
        const finding = results.shift() ?? null;
        return ['one', 'two', 'three'].map((check) => ({ check, route: `/${check}`, finding, artifacts: [] }));
      },
    };
    const { store, after, said } = withStore(sense);
    await after(0);
    store.away = true;
    await after(5 * MINUTE);
    expect(said()).toEqual([AWAY]);
    expect(store.tries).toBe(1);
    store.away = false;
    await after(15_000);
    expect(store.sent.map(({ check }) => check)).toEqual(['one', 'two', 'three']);
    expect(new Set(store.sent.map(({ id }) => id)).size).toBe(3);
  });

  it('fails loudly at every poll once the store has been away for a minute, and still hands it over', async () => {
    const { sense } = scripted(broken, broken);
    const { store, after, said } = withStore(sense);
    await after(0);
    store.away = true;
    await after(5 * MINUTE);
    await after(45_000);
    await after(15_000);
    await after(15_000);
    const STILL = 'error: the inbox did not take a signal: the store has been away for over a minute';
    expect(said()).toEqual([AWAY, AWAY, STILL, STILL]);
    store.away = false;
    await after(15_000);
    expect(store.sent).toHaveLength(1);
  });

  it('is dropped, with an error, when the inbox refuses it for any other reason', async () => {
    const { sense } = scripted(broken, broken, broken);
    const lines: Array<Record<string, unknown>> = [];
    const log = pino({ level: 'warn' }, { write: (line: string) => void lines.push(JSON.parse(line)) });
    let tries = 0;
    const { runner, after } = setup(sense, {
      log,
      send: async () => {
        tries++;
        throw new Error('The inbox refuses this signal');
      },
    });
    await runner.tick();
    await after(5 * MINUTE);
    expect(lines.map(({ level, msg, check }) => ({ level, msg, check }))).toEqual([
      { level: 50, msg: 'the inbox did not take a signal', check: 'one' },
    ]);
    // Not kept: the next poll sends nothing, and the next run sends the check's next signal.
    await after(15_000);
    expect(tries).toBe(1);
    await after(5 * MINUTE);
    expect(tries).toBe(2);
  });
});

describe('start', () => {
  it('looks at the version on a timer until stopped', async () => {
    vi.useFakeTimers();
    const { sense, passes } = scripted();
    const state = { now: 0 };
    const runner = new SenseRunner({
      sense,
      version: async () => V1,
      send: async () => {},
      log: pino({ level: 'silent' }),
      now: () => state.now,
      every: 60_000,
    });
    const stop = runner.start(15_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(passes).toHaveLength(1);
    state.now = 60_000;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(passes).toHaveLength(2);
    await stop();
    state.now = 200_000;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(passes).toHaveLength(2);
  });
});

describe('where a finding was', () => {
  it('is remembered when the finding is signalled, for the pictures to box it', async () => {
    const results = [broken, broken];
    const sense: Sense = {
      name: 'crawler',
      async pass() {
        const finding = results.shift() ?? null;
        const look = { path: '/things/one', elements: [{ selector: 'main h1', kind: 'problem' as const }] };
        return [{ check: 'one', route: '/things/:thing', finding, artifacts: [], ...(finding && { look }) }];
      },
    };
    const remembered: unknown[] = [];
    const state = { now: Date.parse('2026-10-03T12:00:00Z') };
    const watched = new SenseRunner({
      sense,
      version: async () => V1,
      send: async () => {},
      remember: async (look, at) => void remembered.push({ ...look, at: at.toISOString() }),
      log: pino({ level: 'silent' }),
      now: () => state.now,
    });
    await watched.tick();
    expect(remembered).toEqual([]);
    state.now += 5 * MINUTE;
    await watched.tick();
    expect(remembered).toEqual([
      {
        sense: 'crawler',
        check: 'one',
        route: '/things/:thing',
        path: '/things/one',
        elements: [{ selector: 'main h1', kind: 'problem' }],
        at: '2026-10-03T12:05:00.000Z',
      },
    ]);
  });
});
