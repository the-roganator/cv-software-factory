import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { text } from 'node:stream/consumers';
import { DiskArtifacts, issueJobToken, jobForToken } from '@software-factory/store';
import { listenLocal } from '@software-factory/testing';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { RESULT_BYTES as RUNNER_RESULT_BYTES } from '../../runner/src/step.ts';
import { agentJob, prepareJob } from '../src/runners/jobs.ts';
import { StepLogs } from '../src/runners/logs.ts';
import { lineServers } from '../src/runners/serve.ts';
import { RESULT_BYTES, type Runners } from '../src/runners/steps.ts';
import { quiet } from './github/fake.ts';
import { DONE, database, handBack, line, STEP, withRunnersStore } from './runners-harness.ts';

// The tests of the scope fence, the agent pod's token and a stop, which prove guardrails, are in proofs/, Martin's
// (CODEOWNERS).
withRunnersStore();

describe('a runner’s jobs', () => {
  const names = { job: 'coder-1001-1-1', workItem: '1001' };

  it('run restricted, with no service account token, on the work item’s volume, with a deadline', () => {
    const job = prepareJob(names, STEP, { image: 'runner@sha256:abc', deadlineSeconds: 600 });
    const pod = job.spec.template.spec;
    expect(job.metadata).toMatchObject({ name: 'coder-1001-1-1-prepare', namespace: 'runners' });
    expect(job.spec).toMatchObject({ backoffLimit: 0, activeDeadlineSeconds: 660 });
    // The pod's deadline, so a pod out of time stays, with its log, for the line to keep.
    expect(pod).toMatchObject({ activeDeadlineSeconds: 600 });
    expect(pod).toMatchObject({ automountServiceAccountToken: false, securityContext: { runAsNonRoot: true } });
    expect(pod.containers[0]?.securityContext).toEqual({
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      capabilities: { drop: ['ALL'] },
    });
    expect(pod.volumes[0]).toEqual({ name: 'work', persistentVolumeClaim: { claimName: 'work-1001' } });
    expect(job.metadata.labels['factory.mrogan.dev/runner']).toBe('prepare');
  });

  it('give the agent pod the addresses it needs and no DNS, which would be a way out', () => {
    const hosts = [{ ip: '10.43.0.9', hostnames: ['gateway'] }];
    const settings = { image: 'runner', deadlineSeconds: 1200, gatewayUrl: '', handbackUrl: '', token: '', hosts };
    expect(agentJob(names, STEP, settings).spec.template.spec).toMatchObject({
      dnsPolicy: 'None',
      dnsConfig: { nameservers: ['127.0.0.1'] },
      hostAliases: hosts,
    });
    expect(prepareJob(names, STEP, settings).spec.template.spec).not.toHaveProperty('dnsPolicy');
  });
});

describe('running a step', () => {
  it('prepares, runs the agent, takes its handback once, ends its token and cleans up', async () => {
    let token = '';
    const answers: number[] = [];
    let agentDone: Promise<void> = Promise.resolve();
    const { runners, calls, handbackUrl, close } = await line((env) => {
      token = env.ANTHROPIC_API_KEY ?? '';
      agentDone = (async () => {
        answers.push((await handBack(handbackUrl, 'sfj_not-this-one', DONE)).status);
        answers.push((await handBack(handbackUrl, token, { ...DONE, patch: 7 })).status);
        answers.push((await handBack(handbackUrl, token, DONE)).status);
      })();
      return agentDone;
    });
    const outcome = await runners.run({ ...STEP, workItem: '1001', round: 1, deadlineSeconds: 60 });
    await agentDone;
    // Once the step is over, its token has ended.
    answers.push((await handBack(handbackUrl, token, DONE)).status);
    await close();
    expect(outcome).toEqual({ kind: 'handed-back', job: 'coder-1001-1-1', handback: DONE });
    // A stranger's token, a body that is not a handback, the handback, and a second one, by when the token has ended.
    expect(answers).toEqual([401, 400, 202, 401]);
    expect(await jobForToken(database.as.line, token)).toBeUndefined();
    expect(calls.filter((c) => !c.startsWith('GET'))).toEqual([
      'POST /api/v1/namespaces/runners/persistentvolumeclaims PersistentVolumeClaim work-1001',
      'POST /apis/batch/v1/namespaces/runners/jobs Job coder-1001-1-1-prepare',
      'POST /apis/batch/v1/namespaces/runners/jobs Job coder-1001-1-1-agent',
      'DELETE /apis/batch/v1/namespaces/runners/jobs/coder-1001-1-1-prepare',
      'DELETE /apis/batch/v1/namespaces/runners/jobs/coder-1001-1-1-agent',
    ]);
  });

  it('deletes the work volume when the work item is over', async () => {
    const { runners, calls, close } = await line(() => {});
    await runners.finish('1001');
    await close();
    expect(calls).toEqual(['DELETE /api/v1/namespaces/runners/persistentvolumeclaims/work-1001']);
  });

  it('says so when the prepare pod fails, and never starts the agent', async () => {
    const { runners, calls, close } = await line(() => {}, 'failed');
    const outcome = await runners.run({ ...STEP, workItem: '1002', round: 1, deadlineSeconds: 60 });
    await close();
    expect(outcome).toEqual({ kind: 'failed', job: 'coder-1002-1-1', reason: 'The prepare pod failed.' });
    expect(calls.some((c) => c.includes('agent') && c.startsWith('POST'))).toBe(false);
  });

  it('says a step ran out of time when its pod failed at its own deadline', async () => {
    const { runners, close } = await line(() => {}, 'failed', quiet, { outOfTime: true });
    const outcome = await runners.run({ ...STEP, workItem: '1025', round: 1, deadlineSeconds: 60 });
    await close();
    expect(outcome).toEqual({ kind: 'failed', job: 'coder-1025-1-1', reason: 'The prepare pod ran out of time.' });
  });

  it('says so when the agent pod ends without handing anything back', async () => {
    const { runners, close } = await line(() => {});
    const outcome = await runners.run({ ...STEP, workItem: '1003', round: 2, deadlineSeconds: 60 });
    await close();
    expect(outcome).toMatchObject({
      kind: 'failed',
      job: 'coder-1003-2-1',
      reason: 'The agent pod succeeded without handing anything back.',
    });
  });
});

describe('a step’s attempts and results', () => {
  it('hands back an agent’s structured result as it came, and names each attempt’s job apart', async () => {
    const withResult = { ...DONE, result: { verdict: 'spec', scope: ['src/money.ts'] } };
    const { runners, handbackUrl, close } = await line((env) =>
      handBack(handbackUrl, env.ANTHROPIC_API_KEY ?? '', withResult).then(() => {}),
    );
    const first = await runners.run({ ...STEP, workItem: '1005', round: 1, attempt: 1, deadlineSeconds: 60 });
    const again = await runners.run({ ...STEP, workItem: '1005', round: 1, attempt: 2, deadlineSeconds: 60 });
    await close();
    expect(first).toEqual({ kind: 'handed-back', job: 'coder-1005-1-1', handback: withResult });
    expect(again).toMatchObject({ kind: 'handed-back', job: 'coder-1005-1-2' });
  });

  it('logs a handback with its work item and agent, from the job token', async () => {
    const logged: Record<string, unknown>[] = [];
    const log = pino({ level: 'info' }, { write: (line: string) => void logged.push(JSON.parse(line)) });
    const { runners, handbackUrl, close } = await line(
      (env) => handBack(handbackUrl, env.ANTHROPIC_API_KEY ?? '', DONE).then(() => {}),
      undefined,
      log,
    );
    await runners.run({ ...STEP, workItem: '1019', round: 1, deadlineSeconds: 60 });
    await close();
    const { job, workItem, agent, ending, patch } = logged.find((l) => l.msg === 'handed back') ?? {};
    expect({ job, workItem, agent, ending, patch }).toEqual({
      job: 'coder-1019-1-1',
      workItem: '1019',
      agent: 'coder',
      ending: 'finished',
      patch: DONE.patch.length,
    });
  });

  it('refuses a result over its limit', async () => {
    const { handbackUrl, close } = await line(() => {});
    const token = await issueJobToken(database.as.line, { job: 'coder-1006-1-1', workItem: '1006', agent: 'coder' });
    const answer = await handBack(handbackUrl, token, { ...DONE, result: { text: 'x'.repeat(70_000) } });
    await close();
    expect(answer.status).toBe(400);
  });

  it('measures a result in bytes, as the runner does, and to the runner’s own bound', async () => {
    expect(RESULT_BYTES).toBe(RUNNER_RESULT_BYTES);
    const { handbackUrl, close } = await line(() => {});
    const token = await issueJobToken(database.as.line, { job: 'coder-1008-1-1', workItem: '1008', agent: 'coder' });
    // Fewer characters than the bound, but more bytes: each is three in UTF-8.
    const answer = await handBack(handbackUrl, token, { ...DONE, result: { text: '€'.repeat(30_000) } });
    await close();
    expect(answer.status).toBe(400);
  });

  it('stops a step when its signal aborts, and starts none whose signal aborted before it began', async () => {
    let token = '';
    const { runners, calls, close } = await line((env) => {
      token = env.ANTHROPIC_API_KEY ?? '';
      return new Promise<void>(() => {});
    });
    const before = new AbortController();
    before.abort();
    const step = { ...STEP, round: 1, deadlineSeconds: 60 };
    expect(await runners.run({ ...step, workItem: '1009', signal: before.signal })).toEqual({
      kind: 'stopped',
      job: 'coder-1009-1-1',
    });
    expect(calls.filter((call) => call.includes('1009'))).toEqual([]);

    const halt = new AbortController();
    const running = runners.run({ ...step, workItem: '1010', signal: halt.signal });
    while (!token) await new Promise((resolve) => setTimeout(resolve, 5));
    halt.abort();
    const outcome = await running;
    await close();
    expect(outcome).toEqual({ kind: 'stopped', job: 'coder-1010-1-1' });
    expect(calls).toContain('DELETE /apis/batch/v1/namespaces/runners/jobs/coder-1010-1-1-agent');
  });
});

describe('a step’s logs', () => {
  const kept = () => new StepLogs(database.as.line, new DiskArtifacts(mkdtempSync(join(tmpdir(), 'step-logs-'))));
  const PREPARED = '{"msg":"installed the dependencies"}\n';
  const WORKED = '{"msg":"tool call","turn":1,"tool":"Read"}\n';
  const read = async (logs: StepLogs, workItem: string) =>
    Promise.all(
      (await logs.of(workItem)).map(async ({ job, part, ending, reason, hash, size }) => {
        const stream = await logs.open(hash);
        return { job, part, ending, reason, size, text: stream ? await text(stream) : null };
      }),
    );

  it('keeps both pods’ logs with a step that handed back, before its jobs are deleted', async () => {
    const logs = kept();
    const { runners, calls, handbackUrl, close } = await line(
      (env) => handBack(handbackUrl, env.ANTHROPIC_API_KEY ?? '', DONE).then(() => {}),
      undefined,
      quiet,
      { logs, podLogs: { prepare: PREPARED, agent: WORKED } },
    );
    await runners.run({ ...STEP, workItem: '1020', round: 1, deadlineSeconds: 60 });
    await close();
    expect(await read(logs, '1020')).toEqual([
      { job: 'coder-1020-1-1', part: 'prepare', ending: 'handed-back', reason: null, size: 37, text: PREPARED },
      { job: 'coder-1020-1-1', part: 'agent', ending: 'handed-back', reason: null, size: 43, text: WORKED },
    ]);
    const pods = calls.findIndex((c) => c.includes('/pods?labelSelector=factory.mrogan.dev%2Fjob%3Dcoder-1020-1-1'));
    const deleted = calls.findIndex((c) => c.startsWith('DELETE') && c.includes('-prepare'));
    expect(pods).toBeGreaterThan(-1);
    expect(pods).toBeLessThan(deleted);
    expect(calls).toContain('GET /api/v1/namespaces/runners/pods/coder-1020-1-1-agent-x7k2p/log?tailLines=2000');
  });

  it('keeps the prepare pod’s log when it fails, with the reason, and there is no agent pod to keep', async () => {
    const logs = kept();
    const failed = '{"level":"error","msg":"the prepare step failed","error":"Command failed: git fetch"}\n';
    const { runners, close } = await line(() => {}, 'failed', quiet, { logs, podLogs: { prepare: failed } });
    await runners.run({ ...STEP, workItem: '1021', round: 1, deadlineSeconds: 60 });
    await close();
    expect(await read(logs, '1021')).toEqual([
      expect.objectContaining({ part: 'prepare', ending: 'failed', reason: 'The prepare pod failed.', text: failed }),
    ]);
  });

  it('keeps the logs of a step the line stopped, before its jobs go', async () => {
    const logs = kept();
    let token = '';
    const { runners, close } = await line(
      (env) => {
        token = env.ANTHROPIC_API_KEY ?? '';
        return new Promise<void>(() => {});
      },
      undefined,
      quiet,
      { logs, podLogs: { prepare: PREPARED, agent: WORKED } },
    );
    const running = runners.run({ ...STEP, workItem: '1022', round: 1, deadlineSeconds: 60 });
    while (!token) await new Promise((resolve) => setTimeout(resolve, 5));
    await runners.cancel();
    expect(await running).toEqual({ kind: 'stopped', job: 'coder-1022-1-1' });
    await close();
    expect((await read(logs, '1022')).map(({ part, ending, text }) => ({ part, ending, text }))).toEqual([
      { part: 'prepare', ending: 'stopped', text: PREPARED },
      { part: 'agent', ending: 'stopped', text: WORKED },
    ]);
  });

  it('still deletes the jobs when a log cannot be read, and keeps the others', async () => {
    const logs = kept();
    const { runners, calls, close } = await line(() => {}, undefined, quiet, {
      logs,
      podLogs: { prepare: PREPARED, agent: 'refused' },
    });
    const outcome = await runners.run({ ...STEP, workItem: '1023', round: 1, deadlineSeconds: 60 });
    await close();
    expect(outcome).toMatchObject({ kind: 'failed' });
    expect((await read(logs, '1023')).map(({ part }) => part)).toEqual(['prepare']);
    expect(calls).toContain('DELETE /apis/batch/v1/namespaces/runners/jobs/coder-1023-1-1-agent');
  });

  it('goes on as ever when the store cannot keep a log: no table yet, or no volume', async () => {
    // Before migration 0017 has run, as when the factory's image is pinned before the console's, which migrates.
    const noTable = new StepLogs(database.as.line, new DiskArtifacts(mkdtempSync(join(tmpdir(), 'step-logs-'))));
    noTable.keep = () => Promise.reject(new Error('relation "step_logs" does not exist'));
    // ARTIFACTS_DIR set, but no volume mounted there: the read-only root refuses the folder.
    const noVolume = new StepLogs(database.as.line, new DiskArtifacts('/nonexistent/artifacts'));
    for (const [i, logs] of [noTable, noVolume].entries()) {
      const workItem = `${1030 + i}`;
      const warned: Record<string, unknown>[] = [];
      const log = pino({ level: 'warn' }, { write: (line: string) => void warned.push(JSON.parse(line)) });
      const { runners, calls, handbackUrl, close } = await line(
        (env) => handBack(handbackUrl, env.ANTHROPIC_API_KEY ?? '', DONE).then(() => {}),
        undefined,
        log,
        { logs, podLogs: { prepare: PREPARED, agent: WORKED } },
      );
      const outcome = await runners.run({ ...STEP, workItem, round: 1, deadlineSeconds: 60 });
      await close();
      expect(outcome).toEqual({ kind: 'handed-back', job: `coder-${workItem}-1-1`, handback: DONE });
      expect(calls).toContain(`DELETE /apis/batch/v1/namespaces/runners/jobs/coder-${workItem}-1-1-agent`);
      expect(warned.filter((w) => w.msg === 'could not keep a pod’s log')).toHaveLength(2);
    }
  });

  it('serves a work item’s kept logs as text on the step API, and 404 when it kept none', async () => {
    const logs = kept();
    const { runners, handbackUrl, close } = await line(
      (env) => handBack(handbackUrl, env.ANTHROPIC_API_KEY ?? '', DONE).then(() => {}),
      undefined,
      quiet,
      { logs, podLogs: { prepare: PREPARED, agent: '{"msg":"cut mid-line"' } },
    );
    await runners.run({ ...STEP, workItem: '1026', round: 1, deadlineSeconds: 60 });
    await close();
    const github = {} as Parameters<typeof lineServers>[0]['github'];
    const serve = async (withLogs: boolean, path: string) => {
      const { api } = lineServers({ runners, github, log: quiet, ...(withLogs ? { logs } : {}) });
      const { url } = await listenLocal(api);
      try {
        const answer = await fetch(`${url}${path}`);
        return { status: answer.status, type: answer.headers.get('content-type'), text: await answer.text() };
      } finally {
        await new Promise((resolve) => api.close(resolve));
      }
    };
    const served = await serve(true, '/v1/work-items/1026/logs');
    expect(served).toMatchObject({ status: 200, type: 'text/plain; charset=utf-8' });
    const lines = served.text.split('\n');
    expect(lines[0]).toMatch(/^== coder-1026-1-1 prepare \(coder-1026-1-1-prepare-x7k2p\), handed-back, \d{4}-/);
    expect(lines[1]).toBe('{"msg":"installed the dependencies"}');
    expect(lines[2]).toMatch(/^== coder-1026-1-1 agent /);
    expect(lines.slice(3)).toEqual(['{"msg":"cut mid-line"', '']);
    expect(await serve(true, '/v1/work-items/9999/logs')).toMatchObject({
      status: 404,
      type: 'application/json',
      text: JSON.stringify({ error: "No runner's log is kept for 9999." }),
    });
    expect((await serve(false, '/v1/work-items/1026/logs')).status).toBe(404);
  });

  it('ends the connection when a kept log fails partway through serving it', async () => {
    const found = [{ job: 'coder-1026-1-1', part: 'agent', pod: 'coder-1026-1-1-agent-x7k2p' }];
    const logs = {
      of: async () => found,
      print: async (_found: unknown, write: (chunk: string) => void) => {
        write('== coder-1026-1-1 agent\n');
        // As a stream read from the store would: the heading goes out before the failure.
        await new Promise((resolve) => setTimeout(resolve, 20));
        throw new Error('the artifact store lost the rest');
      },
    } as unknown as StepLogs;
    const github = {} as Parameters<typeof lineServers>[0]['github'];
    const { api } = lineServers({
      runners: { handback: () => () => {} } as unknown as Runners,
      github,
      log: quiet,
      logs,
    });
    const { url } = await listenLocal(api);
    try {
      const answer = await fetch(`${url}/v1/work-items/1026/logs`);
      expect(answer.status).toBe(200);
      await expect(answer.text()).rejects.toThrow();
    } finally {
      await new Promise((resolve) => api.close(resolve));
    }
  });

  it('stops a step’s agent even when its log never comes', async () => {
    let token = '';
    const { runners, calls, close } = await line(
      (env) => {
        token = env.ANTHROPIC_API_KEY ?? '';
        return new Promise<void>(() => {});
      },
      undefined,
      quiet,
      { logs: kept(), podLogs: { agent: WORKED }, hang: true },
    );
    const running = runners.run({ ...STEP, workItem: '1024', round: 1, deadlineSeconds: 60 });
    while (!token) await new Promise((resolve) => setTimeout(resolve, 5));
    await runners.cancel();
    // Its token ended before its logs were waited for, and its jobs went after.
    expect(await jobForToken(database.as.line, token)).toBeUndefined();
    expect(calls).toContain('DELETE /apis/batch/v1/namespaces/runners/jobs/coder-1024-1-1-agent');
    expect(await running).toEqual({ kind: 'stopped', job: 'coder-1024-1-1' });
    await close();
  });
});

describe('the handback', () => {
  it('turns away a job nobody waits for, and a body over its limit', async () => {
    const { handbackUrl, close } = await line(() => {});
    const token = await issueJobToken(database.as.line, { job: 'coder-1004-1-1', workItem: '1004', agent: 'coder' });
    expect((await handBack(handbackUrl, token, DONE)).status).toBe(409);
    const huge = await fetch(handbackUrl, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: 'x'.repeat(3 * 1024 * 1024),
    });
    expect(huge.status).toBe(413);
    await close();
  });
});
