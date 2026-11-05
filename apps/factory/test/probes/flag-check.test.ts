/**
 * A feature flag checked with the probes (Verify by variant): the baseline taken only for a version it was not taken
 * of, the journeys compared with it by the journeys gate's twice rule, the `/device` check among them, the preview
 * asked for at Preview, the pictures off and on in light and dark, and a run that may not have seen its stage judging
 * nothing. And the server that answers for it, asked and polled as a verification is.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Screenshot, VERSIONS } from '@software-factory/events';
import { validate } from '@software-factory/events/schemas';
import { DiskArtifacts } from '@software-factory/store';
import { listenLocal } from '@software-factory/testing';
import { describe, expect, it } from 'vitest';
import type { Seen } from '../../src/gates/journeys.ts';
import { type CheckAsked, checkedDraft, requestOf } from '../../src/line/flag-checks.ts';
import { ProbesClient } from '../../src/line/verify.ts';
import type { FlagPicture } from '../../src/pictures/index.ts';
import {
  type FlagCheckAnswer,
  type FlagCheckDeps,
  type FlagCheckRequest,
  flagCheck,
  flagCheckKey,
} from '../../src/probes/flag-check.ts';
import { Jobs, verifyServer } from '../../src/probes/verify.ts';
import { png } from '../pictures/images.ts';

const V1 = '1'.repeat(40);
const V2 = '2'.repeat(40);
const log = { info: () => {}, warn: () => {} };

/** What one run of the probes sees: each check passing unless the test says otherwise. */
type Run = { failing?: string[]; troubled?: string[]; kept?: string[]; allowed?: string[]; version?: string };

/** The app and the probes, seeing each run what the test lists, and the version and revision it says. */
function app(runs: Run[] = [], { revisions = ['r7'], version = V1 } = {}) {
  const store = new DiskArtifacts(mkdtempSync(join(tmpdir(), 'flag-check-')));
  const pictures: FlagPicture[] = [];
  const asked: { only: readonly Pick<Seen, 'sense' | 'check'>[] | undefined; preview: string | undefined }[] = [];
  const shots: string[] = [];
  const schemes: string[] = [];
  const seenRevisions: string[] = [];
  /**
   * The page with the flag on is blue at the top where with it off it is white. In dark, it is grey with the flag off,
   * and with it on is half blue, half white: every pixel differs.
   */
  let flagOn = false;
  const seeOf = (run: Run): Seen[] =>
    ['home', 'home/console', 'home/device', 'search', 'search/device'].map((check) => ({
      sense: 'probe',
      check,
      route: '/',
      failed: run.failing?.includes(check) ?? false,
      ...(run.failing?.includes(check) && { message: `${check} failed` }),
      ...(run.troubled?.includes(check) && { trouble: 'took too long' }),
      ...(check.endsWith('/device') && run.kept?.length && { kept: run.kept }),
      ...(check.endsWith('/device') && run.allowed?.length && { allowed: run.allowed }),
    }));
  const deps: FlagCheckDeps = {
    version: async () => version,
    revision: async () => {
      const revision = revisions.length > 1 ? (revisions.shift() as string) : revisions[0];
      if (revision !== undefined) seenRevisions.push(revision);
      return revision;
    },
    observe: async (only, preview) => {
      asked.push({ only, preview });
      const run = runs.shift() ?? {};
      const seen = seeOf(run).filter((s) => !only || only.some((o) => o.check === s.check));
      return { version, seen, after: run.version ?? version };
    },
    shoot: async (path, { route, version, scheme }) => {
      shots.push(path);
      schemes.push(scheme);
      const bytes =
        scheme === 'dark'
          ? flagOn
            ? png(40, 30, { x: 0, y: 0, width: 40, height: 15, rgb: [0, 0, 255] })
            : png(40, 30, { x: 0, y: 0, width: 40, height: 30, rgb: [30, 30, 30] })
          : flagOn
            ? png(40, 30, { x: 0, y: 0, width: 40, height: 3, rgb: [0, 0, 255] })
            : png(40, 30);
      const hash = await store.put(bytes);
      const screenshot: Screenshot = {
        kind: 'screenshot',
        hash,
        type: 'image/png',
        size: bytes.byteLength,
        route,
        version,
        width: 40,
        height: 30,
        boxes: [],
      };
      return { png: bytes, screenshot };
    },
    index: {
      flagPicture: async (key) =>
        pictures.find(
          (p) =>
            p.flag === key.flag &&
            p.stage === key.stage &&
            p.revision === key.revision &&
            p.version === key.version &&
            p.path === key.path &&
            p.scheme === key.scheme,
        ),
      flagOff: async (flag, hash, scheme) =>
        pictures.find((p) => p.flag === flag && p.stage === 'off' && p.shot.hash === hash && p.scheme === scheme),
      recordFlagPicture: async (picture) => void pictures.push(picture),
    },
    store,
    log,
  };
  return {
    deps,
    pictures,
    asked,
    shots,
    schemes,
    seenRevisions,
    turnOn: () => {
      flagOn = true;
    },
  };
}

const off = (more: Partial<FlagCheckRequest> = {}): FlagCheckRequest => ({
  flag: 'gift-note',
  stage: 'off',
  revision: 'r7',
  pages: ['/'],
  ...more,
});

/** A draft as the store would take it: a whole event, at the current version, with its artifacts. */
const valid = (draft: ReturnType<typeof checkedDraft>) => {
  const event = { id: crypto.randomUUID(), ts: new Date().toISOString(), work_item: '7', ...draft };
  expect(validate({ ...event, version: VERSIONS[draft.type], artifacts: draft.artifacts ?? [] })).toEqual({ ok: true });
  return draft;
};

const checked = (answer: FlagCheckAnswer) => {
  if (answer.kind !== 'checked') throw new Error(`Not checked: ${JSON.stringify(answer)}`);
  return answer;
};

describe('a flag’s baseline, at Off', () => {
  it('runs the journeys with the device check, and pictures each page with the flag off, light and dark', async () => {
    const run = { failing: ['search'], troubled: ['home/console'] };
    const { deps, pictures, asked, schemes } = app([run, run]);
    const answer = checked(await flagCheck(deps, off()));
    expect(answer).toMatchObject({ version: V1, revision: 'r7', journeys: { passed: 3, ran: 5 } });
    expect(answer.notClean).toEqual([
      { sense: 'probe', check: 'home/console', route: '/', failed: false, message: 'took too long' },
      { sense: 'probe', check: 'search', route: '/', failed: true, message: 'search failed' },
    ]);
    expect(answer.regressions).toBeUndefined();
    expect(asked.map((a) => a.only?.map((o) => o.check))).toEqual([undefined, ['home/console', 'search']]);
    expect(answer.pages).toEqual([
      { path: '/', scheme: 'light', route: '/', off: pictures[0]?.shot },
      { path: '/', scheme: 'dark', route: '/', off: pictures[1]?.shot },
    ]);
    expect(schemes).toEqual(['light', 'dark']);
    expect(pictures).toMatchObject([
      { flag: 'gift-note', stage: 'off', revision: 'r7', version: V1, scheme: 'light', changed: null },
      { flag: 'gift-note', stage: 'off', revision: 'r7', version: V1, scheme: 'dark', changed: null },
    ]);
  });

  it('runs a check that did not pass cleanly again, and counts one that passes then as passed', async () => {
    const { deps, asked } = app([{ failing: ['search', 'home'] }, { failing: ['search'] }]);
    const answer = checked(await flagCheck(deps, off()));
    expect(asked[1]?.only?.map((o) => o.check).sort()).toEqual(['home', 'search']);
    expect(answer.notClean.map((c) => c.check)).toEqual(['search']);
    expect(answer.journeys).toEqual({ passed: 4, ran: 5 });
  });

  it('runs nothing for a version it was taken of already', async () => {
    const { deps, asked, shots } = app();
    expect(await flagCheck(deps, off({ have: V1 }))).toEqual({ kind: 'have', version: V1 });
    expect(asked).toEqual([]);
    expect(shots).toEqual([]);
    expect(await flagCheck(deps, off({ have: V2 }))).toMatchObject({ kind: 'checked', version: V1 });
    // The same version under another flag set is not the baseline taken.
    const stale = app([], { revisions: ['r6'] });
    expect(await flagCheck(stale.deps, off({ have: V1 }))).toMatchObject({ kind: 'not-held' });
  });

  it('judges nothing when the app holds another flag set, before the run or after, or moved meanwhile', async () => {
    const before = app([], { revisions: ['r6'] });
    expect(await flagCheck(before.deps, off())).toEqual({
      kind: 'not-held',
      version: V1,
      message: 'The app holds the flag set r6, not r7',
    });
    expect(before.asked).toEqual([]);
    const after = app([], { revisions: ['r7', 'r8'] });
    expect(await flagCheck(after.deps, off())).toMatchObject({
      kind: 'not-held',
      message: 'After the run: The app holds the flag set r8, not r7',
    });
    const moved = app([{ version: V2 }]);
    expect(await flagCheck(moved.deps, off())).toMatchObject({ kind: 'not-held', message: `The app moved to ${V2}` });
  });
});

describe('a flag at Checks and Preview', () => {
  /** A baseline taken, then the flag turned on. */
  async function baselined(runs: Run[], baseRun: Run = { failing: ['search'] }) {
    const it = app([baseRun, baseRun, ...runs]);
    const base = checked(await flagCheck(it.deps, off()));
    it.turnOn();
    const request = (stage: 'checks' | 'preview'): FlagCheckRequest => ({
      flag: 'gift-note',
      stage,
      revision: 'r7',
      pages: ['/'],
      base: {
        version: base.version,
        notClean: base.notClean,
        pictures: base.pages.flatMap((p) => (p.off ? [{ path: p.path, scheme: p.scheme, hash: p.off.hash }] : [])),
      },
    });
    return { ...it, base, request };
  }

  it('finds a check that passed with the flag off and fails twice with it on, the device check among them', async () => {
    const { deps, request, asked } = await baselined([
      { failing: ['search', 'home', 'home/device'], kept: ['localStorage cart on http://app'] },
      { failing: ['home/device'], kept: ['localStorage cart on http://app'] },
    ]);
    const answer = checked(await flagCheck(deps, request('checks')));
    // `search` failed with the flag off too, and says nothing of it; `home` failed once, and passed again.
    expect(answer.regressions).toEqual([
      { sense: 'probe', check: 'home/device', route: '/', failed: true, message: 'home/device failed' },
    ]);
    expect(answer.device.kept).toEqual(['localStorage cart on http://app']);
    expect(
      asked
        .at(-1)
        ?.only?.map((o) => o.check)
        .sort(),
    ).toEqual(['home', 'home/device']);
  });

  it('pictures each page with the flag on against the baseline’s picture of it in the same scheme', async () => {
    const { deps, request, base, pictures } = await baselined([{}]);
    const answer = checked(await flagCheck(deps, request('checks')));
    expect(answer.regressions).toEqual([]);
    const [light, dark] = answer.pages;
    expect(light).toMatchObject({ scheme: 'light', off: base.pages[0]?.off, changed: 0.1 });
    expect(dark).toMatchObject({ scheme: 'dark', off: base.pages[1]?.off, changed: 1 });
    expect(light?.on?.hash).not.toBe(light?.off?.hash);
    expect(light?.diff).toMatchObject({ width: 40, height: 30, boxes: [] });
    expect(dark?.diff?.hash).not.toBe(light?.diff?.hash);
    expect(pictures.map((p) => [p.stage, p.scheme])).toEqual([
      ['off', 'light'],
      ['off', 'dark'],
      ['checks', 'light'],
      ['checks', 'dark'],
    ]);
    // Asked again for the same flag set and version, each page is the same picture.
    const again = checked(await flagCheck(deps, request('checks')));
    expect(again.pages).toEqual(answer.pages);
    expect(pictures).toHaveLength(4);
  });

  it('never compares a page with the baseline’s picture of it in the other scheme', async () => {
    const { deps, request } = await baselined([{}]);
    const asked = request('checks');
    if (!asked.base) throw new Error('No baseline');
    // The request names the light picture as the dark one: the index vouches for neither as the dark page.
    const [light] = asked.base.pictures;
    const crossed = {
      ...asked,
      base: { ...asked.base, pictures: [{ path: '/', scheme: 'dark' as const, hash: light?.hash ?? '' }] },
    };
    const answer = checked(await flagCheck(deps, crossed));
    expect(answer.pages.map((p) => [p.scheme, p.off !== undefined])).toEqual([
      ['light', false],
      ['dark', false],
    ]);
  });

  it('compares with no picture the baseline did not take, and pictures nothing at Preview', async () => {
    const { deps, request, shots } = await baselined([{}, {}]);
    const { base } = request('checks');
    if (!base) throw new Error('No baseline');
    const unknown = {
      ...request('checks'),
      base: { ...base, pictures: [{ path: '/', scheme: 'light' as const, hash: 'e'.repeat(64) }] },
    };
    const answer = checked(await flagCheck(deps, unknown));
    expect(answer.pages).toEqual([
      expect.objectContaining({ path: '/', scheme: 'light', on: expect.any(Object) }),
      expect.objectContaining({ path: '/', scheme: 'dark', on: expect.any(Object) }),
    ]);
    expect(answer.pages[1]?.off).toBeUndefined();
    expect(answer.pages[0]?.off).toBeUndefined();
    expect(answer.pages[0]?.changed).toBeUndefined();
    const before = shots.length;
    expect(checked(await flagCheck(deps, request('preview'))).pages).toEqual([]);
    expect(shots).toHaveLength(before);
  });

  it('at Preview, asks to preview the flag first, and says what the device check allowed', async () => {
    const { deps, request, asked } = await baselined([{ allowed: ['cookie preview'] }]);
    const answer = checked(await flagCheck(deps, request('preview')));
    expect(asked.at(-1)).toEqual({ only: undefined, preview: 'gift-note' });
    expect(answer.device).toEqual({ allowed: ['cookie preview'], kept: [] });
  });

  it('with no baseline, compares nothing', async () => {
    const it = app([{ failing: ['home'] }, { failing: ['home'] }]);
    const answer = checked(await flagCheck(it.deps, { ...off(), stage: 'checks', base: null }));
    expect(answer.regressions).toBeUndefined();
    expect(answer.notClean).toMatchObject([{ check: 'home' }]);
  });
});

describe('the server that answers for a flag’s check', () => {
  async function serve(run: (request: FlagCheckRequest) => Promise<FlagCheckAnswer>) {
    const jobs = new Jobs(run, flagCheckKey);
    const server = verifyServer({
      verify: () => ({ state: 'running' }),
      flagCheck: (request) => jobs.ask(request),
      log,
    });
    const { url: base } = await listenLocal(server);
    return { base, close: () => new Promise((resolve) => server.close(resolve)) };
  }

  /** Once every promise callback already set off has run: a run that has settled has been recorded by then. */
  const settled = () => new Promise((resolve) => setImmediate(resolve));

  it('answers that it runs, joins the run when asked again, then gives its answer once', async () => {
    let runs = 0;
    const answer: FlagCheckAnswer = { kind: 'have', version: V1 };
    // The test, not a timer, says when the run ends, so both requests before it find it running however slow they are.
    const gate = Promise.withResolvers<void>();
    const { base, close } = await serve(async () => {
      runs++;
      await gate.promise;
      return answer;
    });
    try {
      const client = new ProbesClient(base);
      expect(await client.flagCheck(off())).toBeNull();
      expect(await client.flagCheck(off())).toBeNull();
      gate.resolve();
      await settled();
      expect(await client.flagCheck(off())).toEqual(answer);
      expect(runs).toBe(1);
      // Another request is another run.
      expect(await client.flagCheck(off({ have: V2 }))).toBeNull();
    } finally {
      gate.resolve();
      await close();
    }
  });

  it('gives the line, through its own client, the answers of a real run, which make events the store takes', async () => {
    // The probes' own run, at Off and then at Checks, served and read as in the cluster: nothing between them faked.
    const probes = app([{}, {}, {}]);
    const { base, close } = await serve((request) => flagCheck(probes.deps, request));
    try {
      const client = new ProbesClient(base);
      // Asked as the line's pass asks, again until the run has answered.
      const ask = async (request: FlagCheckRequest) => {
        for (let pass = 0; pass < 100; pass++) {
          const answer = await client.flagCheck(request);
          if (answer) return checked(answer);
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        throw new Error('The run never answered');
      };
      const offAsked: CheckAsked = {
        flag: 'gift-note',
        workItem: '7',
        stage: 'off',
        revision: 'r7',
        move: null,
        base: null,
        pages: ['/'],
      };
      const baseline = checkedDraft(offAsked, await ask(requestOf(offAsked)));
      expect(valid(baseline).payload).toMatchObject({ pages: [{ scheme: 'light' }, { scheme: 'dark' }] });
      probes.turnOn();
      const checksAsked: CheckAsked = {
        ...offAsked,
        stage: 'checks',
        move: '8',
        moveRevision: 'r7',
        base: { seq: '6', ts: new Date().toISOString(), workItem: '7', check: baseline.payload as never },
      };
      const draft = checkedDraft(checksAsked, await ask(requestOf(checksAsked)));
      expect(valid(draft).payload).toMatchObject({
        outcome: 'passed',
        pages: [
          { scheme: 'light', changed: 0.1 },
          { scheme: 'dark', changed: 1 },
        ],
      });
    } finally {
      await close();
    }
  });

  it('refuses what is not a flag’s check, and says when it could not run', async () => {
    const { base, close } = await serve(async () => {
      throw new Error('Chromium would not start');
    });
    try {
      const post = (body: string) => fetch(`${base}/v1/flag-check`, { method: 'POST', body });
      for (const body of [
        'not json',
        JSON.stringify({ ...off(), flag: 'Not A Flag' }),
        JSON.stringify({ ...off(), stage: 'share' }),
        JSON.stringify({ ...off(), pages: ['https://elsewhere.example/'] }),
        JSON.stringify({ ...off(), pages: ['//elsewhere.example/'] }),
        JSON.stringify({ ...off(), pages: ['/\\elsewhere.example/'] }),
      ]) {
        expect((await post(body)).status).toBe(400);
      }
      expect((await post('x'.repeat(70_000))).status).toBe(413);
      const client = new ProbesClient(base);
      expect(await client.flagCheck(off())).toBeNull();
      await settled();
      await expect(client.flagCheck(off())).rejects.toThrow("The probes answered a flag's check with 502");
    } finally {
      await close();
    }
  });

  it('is not served without a flag check of its own', async () => {
    const server = verifyServer({ verify: () => ({ state: 'running' }), log });
    const { url } = await listenLocal(server);
    try {
      const response = await fetch(`${url}/v1/flag-check`, {
        method: 'POST',
        body: JSON.stringify(off()),
      });
      expect(response.status).toBe(404);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
