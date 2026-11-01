/**
 * The runners as the line drives them, as runners.test.ts and the proofs in proofs/ run them: a step, a fake of the
 * Kubernetes API whose pods do as each test says, and the handback.
 */
import { createServer, type Server } from 'node:http';
import { listenLocal } from '@software-factory/testing';
import type { Logger } from 'pino';
import { afterAll, beforeAll } from 'vitest';
import { type Database, freshDatabase } from '../../../packages/store/test/database.ts';
import type { Handback, Step } from '../../runner/src/step.ts';
import type { Kube } from '../src/runners/kube.ts';
import type { StepLogs } from '../src/runners/logs.ts';
import { Runners } from '../src/runners/steps.ts';
import { quiet } from './github/fake.ts';

export const PATCH = (path: string) => `diff --git a/${path} b/${path}
--- a/${path}
+++ b/${path}
@@ -1 +1 @@
-old
+new
`;

export const STEP: Step = {
  agent: 'coder',
  repository: 'https://github.com/the-roganator/cv-worlds-worst-website.git',
  commit: 'a'.repeat(40),
  prompt: 'Fix it.',
  maxTurns: 10,
};

/** What each pod prints, by its part, or `refused` for a log the API will not give, as for a pod that never started. */
export type PodLogs = Partial<Record<'prepare' | 'agent', string>>;

/**
 * The Kubernetes API, as far as the line uses it: Jobs that end as each test says, each with a pod that prints what
 * the test says, which goes with its Job, and a record of every call.
 */
export function fakeKube(
  agent: (env: Record<string, string>) => void | Promise<void>,
  prepare: 'succeeded' | 'failed' = 'succeeded',
  logs: PodLogs = {},
  /** Whether a failed prepare pod failed at its own deadline. */
  outOfTime = false,
) {
  const calls: string[] = [];
  const jobs = new Map<string, { status: Record<string, unknown> }>();
  const pods = new Map<
    string,
    { job: string; labels: Record<string, string>; log: string | undefined; reason: string | undefined }
  >();
  const kube: Kube = {
    async get<T>(path: string) {
      calls.push(`GET ${path}`);
      const selector = /\/pods\?labelSelector=(.+)$/.exec(path)?.[1];
      if (selector) {
        const [key, value] = decodeURIComponent(selector).split('=');
        const items = [...pods].filter(([, pod]) => pod.labels[key ?? ''] === value);
        return {
          items: items.map(([name, pod]) => ({
            metadata: { name, labels: pod.labels },
            status: { reason: pod.reason },
          })),
        } as T;
      }
      return jobs.get(path.split('/').at(-1) ?? '') as T | undefined;
    },
    async text(path: string) {
      calls.push(`GET ${path}`);
      const name = /\/pods\/([^/]+)\/log\?/.exec(path)?.[1] ?? '';
      const pod = pods.get(name);
      if (!pod) return undefined;
      if (pod.log === 'refused') throw new Error('container "agent" in pod is waiting to start');
      return pod.log ?? '';
    },
    async create(path: string, body: unknown) {
      const manifest = body as {
        kind: string;
        metadata: { name: string };
        spec: {
          template?: {
            metadata: { labels: Record<string, string> };
            spec: { containers: { env: { name: string; value: string }[] }[] };
          };
        };
      };
      calls.push(`POST ${path} ${manifest.kind} ${manifest.metadata.name}`);
      if (manifest.kind !== 'Job') return;
      const name = manifest.metadata.name;
      const labels = manifest.spec.template?.metadata.labels ?? {};
      const part = labels['factory.mrogan.dev/runner'] as 'prepare' | 'agent';
      const reason = outOfTime && part === 'prepare' ? 'DeadlineExceeded' : undefined;
      pods.set(`${name}-x7k2p`, { job: name, labels: { ...labels, 'job-name': name }, log: logs[part], reason });
      if (name.endsWith('-prepare')) {
        jobs.set(name, {
          status: prepare === 'succeeded' ? { succeeded: 1 } : { conditions: [{ type: 'Failed', status: 'True' }] },
        });
        return;
      }
      jobs.set(name, { status: {} });
      const env = Object.fromEntries(
        manifest.spec.template?.spec.containers[0]?.env.map((e) => [e.name, e.value]) ?? [],
      );
      // The pod runs, and ends a moment after.
      setTimeout(async () => {
        await agent(env);
        jobs.set(name, { status: { succeeded: 1 } });
      }, 10);
    },
    async remove(path: string) {
      calls.push(`DELETE ${path}`);
      const name = path.split('/').at(-1) ?? '';
      jobs.delete(name);
      // A Job's pods go with it.
      for (const [pod, { job }] of pods) if (job === name) pods.delete(pod);
    },
  };
  return { kube, calls };
}

export let database: Database;

/** A store for a file's tests, gone after them. */
export function withRunnersStore() {
  beforeAll(async () => {
    database = await freshDatabase('runners');
  });
  afterAll(() => database?.end());
}

export async function line(
  agent: Parameters<typeof fakeKube>[0],
  prepare?: 'succeeded' | 'failed',
  log: Logger = quiet,
  { podLogs, logs, hang, outOfTime }: { podLogs?: PodLogs; logs?: StepLogs; hang?: boolean; outOfTime?: boolean } = {},
) {
  const { kube, calls } = fakeKube(agent, prepare, podLogs, outOfTime);
  // An API that never gives a pod's log.
  if (hang) kube.text = () => new Promise(() => {});
  let handbackUrl = '';
  const runners = new Runners({
    sql: database.as.line,
    kube,
    image: 'runner',
    gatewayUrl: 'http://gateway',
    handbackUrl: 'http://line/v1/handback',
    log,
    ...(logs ? { logs } : {}),
    // A step waits only as long as its logs take to keep, so the wait is short only where they are never given.
    logWaitMs: hang ? 50 : 2_000,
    pollMs: 10,
    graceMs: 10,
    lookup: async () => '10.43.0.9',
  });
  const server: Server = createServer(runners.handback());
  handbackUrl = `${(await listenLocal(server)).url}/v1/handback`;
  return { runners, calls, handbackUrl, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

export const handBack = (url: string, token: string, body: unknown) =>
  fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) });

export const DONE: Handback = {
  ending: 'finished',
  patch: PATCH('src/money.ts'),
  note: 'Fixed the rounding.',
  turns: 7,
  session: 'abc',
};
