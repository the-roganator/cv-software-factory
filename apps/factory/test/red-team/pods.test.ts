import { describe, expect, it } from 'vitest';
import { EGRESS_CONTROL, EGRESS_TARGETS } from '../../../../policy/attacks.ts';
import { egressAttempt, imageAttempt, RUNNERS } from '../../src/red-team/pods.ts';
import type { AttemptContext } from '../../src/red-team/worker.ts';
import { type Kube, KubeError } from '../../src/runners/kube.ts';
import { fakeEvents, fakeSql, never, silent } from './fakes.ts';

function ctx(sql: AttemptContext['sql'], events = fakeEvents()): AttemptContext {
  return { sql, events, workItem: '1293', launchedAt: new Date(), limitMs: 200, log: silent, signal: never };
}

/** The probe's log: each target's line, then the control's. */
function log(targets: { refused: boolean }[], control: { reached: boolean }): string {
  const lines = EGRESS_TARGETS.map((t, i) => ({
    what: t.what,
    result: targets[i]?.refused ? 'blocked' : 'reached',
    refused: targets[i]?.refused ?? false,
  }));
  lines.push({ what: EGRESS_CONTROL.what, result: control.reached ? 'reached' : 'blocked', refused: false } as never);
  // The control line has `reached`, not `refused`.
  const text = [
    ...lines.slice(0, -1).map((l) => JSON.stringify(l)),
    JSON.stringify({
      what: EGRESS_CONTROL.what,
      result: control.reached ? 'reached' : 'blocked',
      reached: control.reached,
    }),
  ];
  return text.join('\n');
}

function egressKube(body: string) {
  const removed: string[] = [];
  return {
    removed,
    kube: {
      create: async () => {},
      get: async () => ({ status: { phase: 'Succeeded' } }),
      text: async () => body,
      remove: async (path: string) => void removed.push(path),
    } as unknown as Pick<Kube, 'create' | 'get' | 'text' | 'remove'>,
  };
}

describe('attack 4 (egress)', () => {
  it('is refused when every outside address is refused and the gateway control is reached', async () => {
    const { kube, removed } = egressKube(
      log([{ refused: true }, { refused: true }, { refused: true }], { reached: true }),
    );
    const events = fakeEvents();
    const result = await egressAttempt({ kube, runnerImage: 'runner@sha256:abc' })(
      ctx(
        fakeSql(() => []),
        events,
      ),
    );
    expect(result.outcome).toBe('refused');
    expect(result.refusals).toHaveLength(EGRESS_TARGETS.length);
    expect(result.control?.reached).toBe(true);
    expect(events.appended.every((e) => e.type === 'action.refused')).toBe(true);
    expect(removed.length).toBe(1); // the pod is taken away
  });

  it('is not refused when an outside address was reached', async () => {
    const { kube } = egressKube(log([{ refused: true }, { refused: false }, { refused: true }], { reached: true }));
    const result = await egressAttempt({ kube, runnerImage: 'runner@sha256:abc' })(ctx(fakeSql(() => [])));
    expect(result.outcome).toBe('not-refused');
  });

  it('is unfinished when the gateway control was not reached', async () => {
    const { kube } = egressKube(log([{ refused: true }, { refused: true }, { refused: true }], { reached: false }));
    const result = await egressAttempt({ kube, runnerImage: 'runner@sha256:abc' })(ctx(fakeSql(() => [])));
    expect(result.outcome).toBe('unfinished');
  });
});

describe('attack 5 (image)', () => {
  const UID = '11111111-2222-3333-4444-555555555555';
  it('is refused when admission refuses the pod and the line records it', async () => {
    const removed: string[] = [];
    const kube = {
      create: async () => {
        throw new KubeError(403, 'admission webhook denied the request');
      },
      remove: async (path: string) => void removed.push(path),
    };
    const sql = fakeSql((query) => (query.includes('admission-control') ? [{ seq: '77', uid: UID }] : []));
    const result = await imageAttempt({ kube, unsignedImage: 'ghcr.io/x@sha256:unsigned' })(ctx(sql));
    expect(result.outcome).toBe('refused');
    expect(result.refusals).toEqual([77]);
    expect(result.subject?.pod).toEqual({
      namespace: RUNNERS,
      name: expect.stringMatching(/^red-team-image-/),
      uid: UID,
    });
  });

  it('is not refused when the unsigned image is admitted (factory-images in audit), and takes the pod away', async () => {
    const removed: string[] = [];
    const kube = {
      create: async () => {},
      remove: async (path: string) => void removed.push(path),
    };
    const result = await imageAttempt({ kube, unsignedImage: 'ghcr.io/x@sha256:unsigned' })(ctx(fakeSql(() => [])));
    expect(result.outcome).toBe('not-refused');
    expect(removed.length).toBe(1);
  });

  it('is unfinished when admission refused the pod but the line did not record it in time', async () => {
    const kube = {
      create: async () => {
        throw new KubeError(403, 'denied');
      },
      remove: async () => {},
    };
    const result = await imageAttempt({ kube, unsignedImage: 'ghcr.io/x@sha256:unsigned' })(ctx(fakeSql(() => [])));
    expect(result.outcome).toBe('unfinished');
  });
});
