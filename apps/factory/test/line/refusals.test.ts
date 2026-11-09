import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NewEvent } from '@software-factory/events';
import { validate } from '@software-factory/events/schemas';
import { DiskArtifacts, EventWriter } from '@software-factory/store';
import pino from 'pino';
import type { Sql } from 'postgres';
import { afterEach, describe, expect, it } from 'vitest';
import { type Database, freshDatabase } from '../../../../packages/store/test/database.ts';
import {
  AdmissionReader,
  DENIED,
  type Denial,
  denialOf,
  type KubeEvent,
  LineRefusals,
  lastAdmissionRefusal,
  MOST_AT_ONCE,
} from '../../src/line/refusals.ts';
import type { Kube } from '../../src/runners/kube.ts';
import { recordBytes, recordHash, signRecord } from '../../src/signed-refusals.ts';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const other = generateKeyPairSync('ed25519');
const REPO = 'the-roganator/cv-worlds-worst-website';

function harness({ key = true } = {}) {
  const appended: NewEvent[] = [];
  const logged: Record<string, unknown>[] = [];
  const log = pino({ level: 'info' }, { write: (line: string) => void logged.push(JSON.parse(line)) });
  const events = {
    append: async (event: NewEvent | readonly NewEvent[]) => {
      appended.push(...[event].flat());
      return [];
    },
  };
  const refusals = new LineRefusals({ events: events as never, log, key: key ? publicKey : undefined });
  return { appended, logged, refusals };
}

/** A refusal as the GitHub worker answers it, through JSON. */
function answered({
  key = privateKey,
  number = null as number | null,
  at = '2026-10-31T12:00:00.000Z',
  mechanism = 'github-guard' as 'github-guard' | 'review-gate',
} = {}) {
  const facts = {
    repo: REPO,
    number,
    at,
    payload: {
      mechanism,
      action: `applyPatch branch factory/1400-cart in ${REPO}`,
      output: 'The patch changes .github/workflows/ci.yml, which no patch may.',
      guardrails: [1],
    },
  };
  const bytes = recordBytes(facts);
  return JSON.parse(JSON.stringify({ ...facts, record: recordHash(bytes), signature: signRecord(key, bytes) }));
}

describe('the line’s relay of the GitHub worker’s refusals', () => {
  it('appends one that verifies, on the work item it was for, with its record and signature', async () => {
    const { appended, refusals } = harness();
    const answer = answered();
    refusals.relay(answer, { workItem: '1400', agent: 'coder' });
    await refusals.settled();
    expect(appended.map((event) => validate(event))).toEqual([{ ok: true }]);
    expect(appended[0]).toMatchObject({
      type: 'action.refused',
      work_item: '1400',
      ts: '2026-10-31T12:00:00.000Z',
      payload: { ...answer.payload, record: answer.record, signature: answer.signature },
    });
    expect(appended[0]?.payload).not.toHaveProperty('subject');
  });

  it('names what was refused when the request was for no work item', async () => {
    const { appended, refusals } = harness();
    refusals.relay(answered({ number: 12 }), {});
    await refusals.settled();
    expect(appended[0]).toMatchObject({
      work_item: null,
      payload: { subject: { kind: 'issue or pull request', name: `${REPO}#12` } },
    });
    expect(validate(appended[0])).toEqual({ ok: true });
  });

  it('does not append the review check’s refusal, signed for the red-team harness and never the line’s', async () => {
    const { appended, logged, refusals } = harness();
    refusals.relay(answered({ number: 12, mechanism: 'review-gate' }), { workItem: '1400' });
    await refusals.settled();
    expect(appended).toEqual([]);
    expect(logged.map((l) => [l.msg, l.mechanism])).toEqual([
      ['the GitHub worker answered a refusal the line does not relay: not recorded', 'review-gate'],
    ]);
  });

  it('logs, and does not append, one that does not verify, or any with no key to verify it', async () => {
    const { appended, logged, refusals } = harness();
    refusals.relay(answered({ key: other.privateKey }), { workItem: '1400' });
    refusals.relay({ ...answered(), repo: 'the-roganator/cv-software-factory' }, { workItem: '1400' });
    await refusals.settled();
    expect(appended).toEqual([]);
    expect(logged.map((l) => [l.msg, l.why])).toEqual([
      ['the GitHub worker answered a refusal that does not verify: not recorded', 'its signature does not verify'],
      [
        'the GitHub worker answered a refusal that does not verify: not recorded',
        'its record is not the refusal it names',
      ],
    ]);
    const keyless = harness({ key: false });
    keyless.refusals.relay(answered(), { workItem: '1400' });
    await keyless.refusals.settled();
    expect(keyless.appended).toEqual([]);
    expect(keyless.logged).toHaveLength(1);
  });

  it('folds a minute’s repeats into one event, the last one’s record and signature with it', async () => {
    const { appended, refusals } = harness();
    const first = answered({ at: '2026-10-31T12:00:00.000Z' });
    const last = answered({ at: '2026-10-31T12:00:30.000Z' });
    refusals.relay(first, { workItem: '1400' });
    refusals.relay(answered({ at: '2026-10-31T12:00:10.000Z' }), { workItem: '1400' });
    refusals.relay(last, { workItem: '1400' });
    await refusals.flush(new Date('2026-10-31T12:01:00.000Z'));
    expect(appended.map((event) => validate(event))).toEqual([{ ok: true }, { ok: true }]);
    expect(appended[1]).toMatchObject({
      ts: '2026-10-31T12:00:10.000Z',
      payload: { count: 2, lastAt: last.at, record: last.record, signature: last.signature },
    });
  });
});

const T = '2026-10-31T12:00:00Z';
const UID = '0b6e8f3a-9d2c-4c71-8a5e-3f1d2b7c6a90';

/** Kyverno's record of a request it blocked: on the policy, in `default`, the refused object related. */
const blocked = (overrides: Partial<KubeEvent> = {}): KubeEvent => ({
  metadata: { uid: 'e1', namespace: 'default' },
  involvedObject: { kind: 'ImageValidatingPolicy', name: 'factory-images', namespace: '' },
  related: { kind: 'Pod', namespace: 'factory', name: 'unsigned' },
  reason: 'PolicyViolation',
  action: 'Resource Blocked',
  reportingComponent: 'kyverno-admission',
  message:
    'Pod factory/unsigned: [images] fail (blocked); ghcr.io/someone/else@sha256:… is not an image this namespace runs',
  eventTime: T,
  ...overrides,
});

/** A controller's record of a pod it could not make. */
const failedCreate = (overrides: Partial<KubeEvent> = {}): KubeEvent => ({
  metadata: { uid: 'e2', namespace: 'runners' },
  involvedObject: {
    kind: 'Job',
    namespace: 'runners',
    name: 'coder-1400-1-3-agent',
    uid: '6f1c7a52-1b55-4bb6-9e1d-2f0a8f6b1e01',
  },
  reason: 'FailedCreate',
  message:
    'Error creating: admission webhook "ivpol.validate.kyverno.svc-fail-finegrained-factory-images" denied the request: Policy factory-images failed: the image is not signed by build.yml on main',
  source: { component: 'job-controller' },
  count: 1,
  firstTimestamp: T,
  lastTimestamp: T,
  ...overrides,
});

describe('the denials an Event records', () => {
  it('reads Kyverno’s record of a request it blocked: the image policies’ as guardrail 3’s, with the object named', () => {
    expect(denialOf(blocked())).toEqual({
      workItem: null,
      cause: 'image',
      action: 'Admit Pod factory/unsigned, refused by factory-images',
      output: blocked().message,
      subject: { namespace: 'factory', kind: 'Pod', name: 'unsigned' },
    });
    expect(
      denialOf(
        blocked({
          involvedObject: { kind: 'ValidatingPolicy', name: 'website-routes' },
          related: { kind: 'IngressRoute', namespace: 'website', name: 'console' },
        }),
      ),
    ).toMatchObject({ cause: 'production', subject: { namespace: 'website', kind: 'IngressRoute' } });
  });

  it('reads Kyverno’s record of the image attack’s pod in red-team, the attacks’ namespace, as guardrail 3’s', () => {
    const attack = blocked({
      related: { kind: 'Pod', namespace: 'red-team', name: 'red-team-image-1a2b3c4d', uid: UID },
    });
    expect(denialOf(attack)).toEqual({
      workItem: null,
      cause: 'image',
      action: 'Admit Pod red-team/red-team-image-1a2b3c4d, refused by factory-images',
      output: attack.message,
      subject: { namespace: 'red-team', kind: 'Pod', name: 'red-team-image-1a2b3c4d', uid: UID },
    });
  });

  it('reads a controller’s record of a pod admission refused, on the work item whose runner it was', () => {
    expect(denialOf(failedCreate())).toEqual({
      workItem: '1400',
      cause: 'image',
      action: 'Create a pod for Job runners/coder-1400-1-3-agent',
      output: failedCreate().message,
      subject: {
        namespace: 'runners',
        kind: 'Job',
        name: 'coder-1400-1-3-agent',
        uid: '6f1c7a52-1b55-4bb6-9e1d-2f0a8f6b1e01',
      },
    });
    const replicaSet = failedCreate({
      metadata: { uid: 'e3', namespace: 'website' },
      involvedObject: { kind: 'ReplicaSet', namespace: 'website', name: 'website-7d9f' },
    });
    expect(denialOf(replicaSet)).toMatchObject({
      workItem: null,
      subject: { namespace: 'website', kind: 'ReplicaSet' },
    });
  });

  it('reads a controller’s record of a pod Pod Security refused, with the level the namespace enforces', () => {
    // Verbatim from the local cluster (9 Nov): a one-replica Deployment in runners whose pod is privileged, on an image
    // admission admits. Pod Security refuses it before any webhook or policy sees it, so this is its only record.
    const message =
      'Error creating: pods "psa-probe-944-6cd7b66bf7-lzvkl" is forbidden: violates PodSecurity "restricted:latest": privileged (container "probe" must not set securityContext.privileged=true), allowPrivilegeEscalation != false (container "probe" must set securityContext.allowPrivilegeEscalation=false), unrestricted capabilities (container "probe" must set securityContext.capabilities.drop=["ALL"]), runAsNonRoot != true (pod or container "probe" must set securityContext.runAsNonRoot=true), seccompProfile (pod or container "probe" must set securityContext.seccompProfile.type to "RuntimeDefault" or "Localhost")';
    const event: KubeEvent = {
      metadata: {
        uid: 'f0e0447b-9435-47d1-a185-9ee13f515a6e',
        namespace: 'runners',
        creationTimestamp: '2026-11-09T17:43:08Z',
      },
      involvedObject: {
        kind: 'ReplicaSet',
        namespace: 'runners',
        name: 'psa-probe-944-6cd7b66bf7',
        uid: '45327154-a11e-4033-9d19-b5ca416ee147',
      },
      reason: 'FailedCreate',
      message,
      reportingComponent: 'replicaset-controller',
      source: { component: 'replicaset-controller' },
      count: 1,
      firstTimestamp: '2026-11-09T17:43:08Z',
      lastTimestamp: '2026-11-09T17:43:08Z',
    };
    // The webhook and ValidatingAdmissionPolicy wording alone, all the line read before, drops it.
    expect(DENIED.test(message)).toBe(false);
    expect(denialOf(event)).toEqual({
      workItem: null,
      cause: 'production',
      action:
        'Create a pod for ReplicaSet runners/psa-probe-944-6cd7b66bf7, refused by Pod Security at restricted:latest',
      output: message,
      subject: {
        namespace: 'runners',
        kind: 'ReplicaSet',
        name: 'psa-probe-944-6cd7b66bf7',
        uid: '45327154-a11e-4033-9d19-b5ca416ee147',
      },
    });
    // The controller's later tries, which the API server folds into one Event, read the same.
    const combined = { ...event, message: `(combined from similar events): ${message}`, reportingComponent: '' };
    expect(denialOf(combined)?.action).toBe(denialOf(event)?.action);
    // Not in a guarded namespace: not the line's to record.
    expect(denialOf({ ...event, metadata: { uid: 'e5', namespace: 'telemetry' } })).toBeUndefined();
  });

  it('reads nothing else: an audit, another namespace, another reporter, a failure that is not a denial', () => {
    const others = [
      blocked({ action: 'Resource Passed' }),
      blocked({ related: { kind: 'Pod', namespace: 'kyverno', name: 'x' } }),
      blocked({ reportingComponent: 'kyverno-scan' }),
      blocked({ related: null }),
      failedCreate({ metadata: { uid: 'e4', namespace: 'telemetry' } }),
      failedCreate({ message: 'Error creating: pods "x" is forbidden: exceeded quota: runners' }),
      failedCreate({ reason: 'SuccessfulCreate' }),
    ];
    for (const event of others) expect(denialOf(event)).toBeUndefined();
  });
});

describe('the admission reader', () => {
  /**
   * The cluster's Events, by namespace, as the line lists them; and a store whose last admission refusals were at
   * `last`, with these actions.
   */
  function cluster(last: Date | null = null, actions = ['Admit Pod factory/another, refused by factory-images']) {
    const lists = new Map<string, KubeEvent[]>();
    const asked: string[] = [];
    const kube: Pick<Kube, 'get'> = {
      get: async <T>(path: string) => {
        asked.push(path);
        const namespace = /namespaces\/([^/]+)\/events/.exec(path)?.[1] ?? '';
        if (namespace === 'flagd' && lists.has('flagd-fails')) throw new Error('403');
        return { items: lists.get(namespace) ?? [] } as T;
      },
    };
    const sql = (async () => (last ? actions.map((action) => ({ at: last, action })) : [])) as unknown as Sql;
    const denied: Denial[] = [];
    const reader = new AdmissionReader({
      kube,
      sql,
      refusals: { denied: (denial) => void denied.push(denial) },
      log: pino({ level: 'silent' }),
    });
    return { lists, asked, denied, reader };
  }

  it('lists the denials’ Events in each guarded namespace and in Kyverno’s, and nothing else', async () => {
    const { asked, reader } = cluster();
    await reader.look();
    expect(asked).toEqual([
      '/api/v1/namespaces/factory/events?fieldSelector=reason%3DFailedCreate',
      '/api/v1/namespaces/runners/events?fieldSelector=reason%3DFailedCreate',
      '/api/v1/namespaces/red-team/events?fieldSelector=reason%3DFailedCreate',
      '/api/v1/namespaces/website/events?fieldSelector=reason%3DFailedCreate',
      '/api/v1/namespaces/scoreboard/events?fieldSelector=reason%3DFailedCreate',
      '/api/v1/namespaces/flagd/events?fieldSelector=reason%3DFailedCreate',
      '/api/v1/namespaces/default/events?fieldSelector=reason%3DPolicyViolation',
    ]);
  });

  it('records each denial once, and each try a controller adds to its Event', async () => {
    const { lists, denied, reader } = cluster();
    lists.set('default', [blocked()]);
    lists.set('runners', [failedCreate()]);
    await reader.look();
    expect(denied.map((d) => [d.action, d.at.toISOString()])).toEqual([
      ['Create a pod for Job runners/coder-1400-1-3-agent', '2026-10-31T12:00:00.000Z'],
      ['Admit Pod factory/unsigned, refused by factory-images', '2026-10-31T12:00:00.000Z'],
    ]);
    await reader.look();
    expect(denied).toHaveLength(2);
    // The controller tried twice more: two more, at its last try.
    lists.set('runners', [failedCreate({ count: 3, lastTimestamp: '2026-10-31T12:00:20Z' })]);
    await reader.look();
    expect(denied.slice(2).map((d) => [d.workItem, d.at.toISOString()])).toEqual([
      ['1400', '2026-10-31T12:00:20.000Z'],
      ['1400', '2026-10-31T12:00:20.000Z'],
    ]);
  });

  it('starts after the last admission refusal it recorded, so a restart records nothing twice', async () => {
    const { lists, denied, reader } = cluster(new Date('2026-10-31T12:00:10Z'));
    lists.set('default', [
      blocked(),
      blocked({ metadata: { uid: 'later', namespace: 'default' }, eventTime: '2026-10-31T12:00:30Z' }),
    ]);
    // Begun before it, and tried again since: the try since, once.
    lists.set('runners', [failedCreate({ count: 4, lastTimestamp: '2026-10-31T12:00:40Z' })]);
    await reader.look();
    expect(denied.map((d) => d.at.toISOString())).toEqual(['2026-10-31T12:00:40.000Z', '2026-10-31T12:00:30.000Z']);
  });

  it('takes an Event in the second it stopped at as new, unless it recorded that one then', async () => {
    const at = new Date(T);
    const recorded = 'Admit Pod factory/unsigned, refused by factory-images';
    const { lists, denied, reader } = cluster(at, [recorded]);
    lists.set('default', [
      blocked(),
      blocked({
        metadata: { uid: 'same-second', namespace: 'default' },
        related: { kind: 'Pod', namespace: 'factory', name: 'also-unsigned' },
      }),
    ]);
    await reader.look();
    expect(denied.map((d) => [d.action, d.at.toISOString()])).toEqual([
      ['Admit Pod factory/also-unsigned, refused by factory-images', '2026-10-31T12:00:00.000Z'],
    ]);
  });

  it('records a flood of one Event’s tries a bounded number at a look, and the rest at the looks after', async () => {
    const { lists, denied, reader } = cluster();
    lists.set('runners', [failedCreate({ count: MOST_AT_ONCE * 2 + 5 })]);
    await reader.look();
    expect(denied).toHaveLength(MOST_AT_ONCE);
    await reader.look();
    expect(denied).toHaveLength(MOST_AT_ONCE * 2);
    await reader.look();
    expect(denied).toHaveLength(MOST_AT_ONCE * 2 + 5);
    await reader.look();
    expect(denied).toHaveLength(MOST_AT_ONCE * 2 + 5);
  });

  it('records an Event dated ahead of now as now, so it cannot set where a restart starts', async () => {
    const { lists, denied, reader } = cluster();
    lists.set('default', [blocked({ eventTime: '2999-01-01T00:00:00Z' })]);
    const before = Date.now();
    await reader.look();
    expect(denied).toHaveLength(1);
    expect(denied[0]?.at.getTime()).toBeGreaterThanOrEqual(before);
    expect(denied[0]?.at.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('keeps what it saw in a namespace it could not list, so its Events are not taken as new when it can', async () => {
    const { lists, denied, reader } = cluster();
    lists.set('runners', [failedCreate()]);
    await reader.look();
    lists.set('flagd-fails', []);
    await reader.look();
    lists.delete('flagd-fails');
    await reader.look();
    expect(denied).toHaveLength(1);
  });
});

describe('the line’s refusals in the store', () => {
  let database: Database | undefined;
  afterEach(() => database?.end());

  it('are appended as the line’s role, which row security lets append these mechanisms, and read back where it left off', async () => {
    database = await freshDatabase('line_refusals');
    const events = new EventWriter(database.as.line, {
      kind: 'real',
      artifacts: new DiskArtifacts(mkdtempSync(join(tmpdir(), 'artifacts-'))),
    });
    const refusals = new LineRefusals({ events, log: pino({ level: 'silent' }), key: publicKey });
    expect(await lastAdmissionRefusal(database.as.line)).toEqual({ at: new Date(0), actions: new Set() });
    // On no work item: the store takes a refusal on one only once it has been opened.
    refusals.relay(answered({ number: 12 }), {});
    const denial = denialOf(blocked());
    if (!denial) throw new Error('no denial');
    refusals.denied({ ...denial, at: new Date('2026-10-31T12:00:00Z') });
    refusals.denied({ ...denial, at: new Date('2026-10-31T12:00:05Z') });
    refusals.denied({ ...denial, at: new Date('2026-10-31T12:00:07Z') });
    await refusals.stop();
    const stored = await database.as.line<{ mechanism: string; count: number | null; appended_by: string }[]>`
      select payload ->> 'mechanism' as mechanism, (payload ->> 'count')::int as count, appended_by from events
      where type = 'action.refused' order by seq`;
    expect(stored).toEqual([
      { mechanism: 'github-guard', count: null, appended_by: 'factory_line' },
      { mechanism: 'admission-control', count: null, appended_by: 'factory_line' },
      { mechanism: 'admission-control', count: 2, appended_by: 'factory_line' },
    ]);
    // The folded repeats' last, so the reader starting again takes nothing it recorded.
    expect(await lastAdmissionRefusal(database.as.line)).toEqual({
      at: new Date('2026-10-31T12:00:07Z'),
      actions: new Set([denial.action]),
    });
  });
});
