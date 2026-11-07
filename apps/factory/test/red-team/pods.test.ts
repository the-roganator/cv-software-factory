import { describe, expect, it } from 'vitest';
import { EGRESS_CONTROL, EGRESS_TARGETS, RED_TEAM_HOST_ALIAS } from '../../../../policy/attacks.ts';
import { egressAttempt, imageAttempt, RED_TEAM_NAMESPACE } from '../../src/red-team/pods.ts';
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

const find = async (hostname: string) => {
  expect(hostname).toBe(RED_TEAM_HOST_ALIAS);
  return '10.43.0.9';
};

function egressKube(body: string) {
  const removed: string[] = [];
  const created: Record<string, unknown>[] = [];
  const paths: string[] = [];
  return {
    removed,
    created,
    paths,
    kube: {
      create: async (path: string, pod: Record<string, unknown>) => {
        paths.push(path);
        created.push(pod);
      },
      get: async () => ({ status: { phase: 'Succeeded' } }),
      text: async () => body,
      remove: async (path: string) => void removed.push(path),
    } as unknown as Pick<Kube, 'create' | 'get' | 'text' | 'remove'>,
  };
}

describe('attack 4 (egress)', () => {
  it('makes the pod in red-team, the attacks’ own namespace, never in runners, and takes it away there', async () => {
    const { kube, created, paths, removed } = egressKube(
      log([{ refused: true }, { refused: true }, { refused: true }], { reached: true }),
    );
    await egressAttempt({ kube, runnerImage: 'runner@sha256:abc', find })(ctx(fakeSql(() => [])));
    expect(RED_TEAM_NAMESPACE).toBe('red-team');
    expect(paths).toEqual(['/api/v1/namespaces/red-team/pods']);
    expect(created[0]?.metadata).toMatchObject({ namespace: 'red-team' });
    expect(removed).toEqual([expect.stringMatching(/^\/api\/v1\/namespaces\/red-team\/pods\/red-team-egress-/)]);
  });

  it('makes the pod with an agent’s DNS: no resolver, and the gateway’s name aliased to the address it looked up', async () => {
    const { kube, created } = egressKube(
      log([{ refused: true }, { refused: true }, { refused: true }], { reached: true }),
    );
    await egressAttempt({ kube, runnerImage: 'runner@sha256:abc', find })(ctx(fakeSql(() => [])));
    const spec = created[0]?.spec as Record<string, unknown>;
    expect(spec.dnsPolicy).toBe('None');
    expect(spec.dnsConfig).toEqual({ nameservers: ['127.0.0.1'] });
    expect(spec.hostAliases).toEqual([{ ip: '10.43.0.9', hostnames: [RED_TEAM_HOST_ALIAS] }]);
    expect(spec.automountServiceAccountToken).toBe(false);
  });

  it('is refused when every outside address is refused and the gateway control is reached', async () => {
    const { kube, removed } = egressKube(
      log([{ refused: true }, { refused: true }, { refused: true }], { reached: true }),
    );
    const events = fakeEvents();
    const result = await egressAttempt({ kube, runnerImage: 'runner@sha256:abc', find })(
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
    const result = await egressAttempt({ kube, runnerImage: 'runner@sha256:abc', find })(ctx(fakeSql(() => [])));
    expect(result.outcome).toBe('not-refused');
  });

  it('is still not refused when an address was reached and a refusal of another could not be appended', async () => {
    const { kube } = egressKube(log([{ refused: true }, { refused: false }, { refused: true }], { reached: true }));
    const failing = {
      append: async () => {
        throw new Error('the store refused the event');
      },
    };
    const result = await egressAttempt({ kube, runnerImage: 'runner@sha256:abc', find })(
      ctx(
        fakeSql(() => []),
        failing as unknown as ReturnType<typeof fakeEvents>,
      ),
    );
    expect(result.outcome).toBe('not-refused');
    expect(result.attempts.filter((a) => !a.refused).map((a) => a.what)).toEqual([EGRESS_TARGETS[1]?.what]);
  });

  it('is unfinished, not a finding, when the pod could not tell of a target, or said nothing of it', async () => {
    const unclear = log([{ refused: true }, { refused: false }, { refused: true }], { reached: true }).replace(
      '"result":"reached"',
      '"result":"unclear"',
    );
    const first = await egressAttempt({ kube: egressKube(unclear).kube, runnerImage: 'runner@sha256:abc', find })(
      ctx(fakeSql(() => [])),
    );
    expect(first.outcome).toBe('unfinished');
    expect(first.refusals).toHaveLength(2);
    const silentOfOne = log([{ refused: true }, { refused: true }, { refused: true }], { reached: true })
      .split('\n')
      .filter((line) => !line.includes(EGRESS_TARGETS[1]?.what ?? ''))
      .join('\n');
    const second = await egressAttempt({ kube: egressKube(silentOfOne).kube, runnerImage: 'runner@sha256:abc', find })(
      ctx(fakeSql(() => [])),
    );
    expect(second.outcome).toBe('unfinished');
    // The target it said nothing of is no attempt: to the line an attempt not refused is one that got through.
    expect(second.attempts.map((a) => a.what)).not.toContain(EGRESS_TARGETS[1]?.what);
    expect(second.attempts.every((a) => a.refused)).toBe(true);
  });

  it('is unfinished when the gateway control was not reached', async () => {
    const { kube } = egressKube(log([{ refused: true }, { refused: true }, { refused: true }], { reached: false }));
    const result = await egressAttempt({ kube, runnerImage: 'runner@sha256:abc', find })(ctx(fakeSql(() => [])));
    expect(result.outcome).toBe('unfinished');
  });
});

describe('attack 5 (image)', () => {
  const UID = '11111111-2222-3333-4444-555555555555';
  it('is refused when admission refuses the pod and the line records it', async () => {
    const removed: string[] = [];
    const kube = {
      create: async () => {
        throw new KubeError(
          403,
          'admission webhook "ivpol.validate.kyverno.svc-fail-finegrained-factory-images" denied the request: Policy factory-images failed',
        );
      },
      remove: async (path: string) => void removed.push(path),
    };
    const asked: unknown[][] = [];
    const sql = fakeSql((query, values) => {
      asked.push(values);
      return query.includes('admission-control') ? [{ seq: '77', uid: UID }] : [];
    });
    const result = await imageAttempt({ kube, unsignedImage: 'ghcr.io/x@sha256:unsigned', find })(ctx(sql));
    expect(result.outcome).toBe('refused');
    // It waits for the line's record of the pod in red-team, where it asked for it.
    expect(asked[0]?.[0]).toBe('red-team');
    expect(result.refusals).toEqual([77]);
    expect(result.subject?.pod).toEqual({
      namespace: 'red-team',
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
    const result = await imageAttempt({ kube, unsignedImage: 'ghcr.io/x@sha256:unsigned', find })(
      ctx(fakeSql(() => [])),
    );
    expect(result.outcome).toBe('not-refused');
    expect(removed.length).toBe(1);
  });

  it('is unfinished, saying why, when the pod could not be made for a reason that is not the image policy’s', async () => {
    const kube = {
      create: async () => {
        throw new KubeError(
          403,
          'pods is forbidden: User "system:serviceaccount:factory:red-team" cannot create resource "pods"',
        );
      },
      remove: async () => {},
    } as unknown as Pick<Kube, 'create' | 'remove'>;
    let looked = 0;
    const sql = fakeSql(() => {
      looked += 1;
      return [];
    });
    const result = await imageAttempt({ kube, unsignedImage: 'ghcr.io/x@sha256:unsigned', find })(ctx(sql));
    expect(result.outcome).toBe('unfinished');
    // No attempt, since nothing was made; why is in the reason.
    expect(result.attempts).toEqual([]);
    expect(result.reason).toContain('cannot create resource "pods"');
    // It did not wait for a record the line would never make.
    expect(looked).toBe(0);
  });

  it('is unfinished when admission refused the pod but the line did not record it in time', async () => {
    const kube = {
      create: async () => {
        throw new KubeError(
          403,
          'admission webhook "ivpol.validate.kyverno.svc-fail-finegrained-factory-images" denied the request: Policy factory-images failed',
        );
      },
      remove: async () => {},
    };
    const result = await imageAttempt({ kube, unsignedImage: 'ghcr.io/x@sha256:unsigned', find })(
      ctx(fakeSql(() => [])),
    );
    expect(result.outcome).toBe('unfinished');
  });
});
