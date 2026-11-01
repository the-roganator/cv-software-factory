/**
 * Proves `ci:stopped-line` (policy/guardrails.ts, spec 6 guardrail 9), with the line's and the runners' tests beside
 * it: the gateway refuses an agent's calls from the first after it hears the line stopped, or within a few seconds when
 * it hears nothing, and heeds only a stop one of Martin's roles appended. Martin's (CODEOWNERS), as every file here is:
 * a change to what they assert is a change to the proof.
 */
import type { NewEvent } from '@software-factory/events';
import { DiskArtifacts, EventWriter } from '@software-factory/store';
import postgres, { type Sql } from 'postgres';
import { describe, expect, it, vi } from 'vitest';
import { AgentCalls, type AgentCallsOptions } from '../../src/gateway/agents.ts';
import {
  agentRequest,
  call,
  captured,
  cassettesDir,
  database,
  start,
  stop,
  withAgentGateway,
} from '../gateway/agents-harness.ts';

withAgentGateway();

describe('agents through the gateway, while the line is stopped', () => {
  it('refuses every agent call while the line is stopped', async () => {
    const { token } = await start();
    // Stopped by one of Martin's roles: the admin service's.
    await new EventWriter(database.admin, { kind: 'real', artifacts: new DiskArtifacts(cassettesDir) }).append(stop());
    const response = await call(token, agentRequest());
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { message: expect.stringMatching(/line is stopped/) } });
  });

  /** Appends one of Martin's commands, as the admin service's role, and returns once the gateway has heard it. */
  const appendHeard = async (sql: Sql, event: NewEvent) => {
    // The gateway's listener and this one share the client's one listening connection, and hear each append in the
    // order they listened in: the gateway's first.
    const heard = Promise.withResolvers<void>();
    const listening = await sql.listen('events', () => heard.resolve());
    try {
      await new EventWriter(database.admin, { kind: 'real', artifacts: new DiskArtifacts(cassettesDir) }).append(event);
      await heard.promise;
    } finally {
      await listening.unlisten();
    }
  };

  const started = (): NewEvent => ({
    id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    work_item: null,
    type: 'line.started',
    version: 2,
    actor: 'martin',
    summary: 'The line started',
    payload: { reason: 'testing' },
    artifacts: [],
  });

  it('refuses the calls of an agent it already answered as soon as it hears the line stop', async () => {
    // A clock that never moves, so the gateway's view of the line, running, would never go stale of itself.
    const now = new Date();
    const { sql, token } = await start({ clock: () => now });
    const before = await call(token, agentRequest());
    expect(before.status).toBe(200);
    await before.text();
    await appendHeard(sql, stop());
    const response = await call(token, agentRequest());
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { message: expect.stringMatching(/line is stopped/) } });

    // And it answers again as soon as it hears the line start.
    await appendHeard(sql, started());
    const after = await call(token, agentRequest());
    expect(after.status).toBe(200);
    await after.text();
  });

  it('sees the line stop within a few seconds when it hears nothing', async () => {
    let offset = 0;
    const { token } = await start({ clock: () => new Date(Date.now() + offset), listening: false });
    const before = await call(token, agentRequest());
    expect(before.status).toBe(200);
    await before.text();
    await new EventWriter(database.admin, { kind: 'real', artifacts: new DiskArtifacts(cassettesDir) }).append(stop());
    // Unheard, the stop goes unseen while the gateway's view of the line is fresh...
    const unseen = await call(token, agentRequest());
    expect(unseen.status).toBe(200);
    await unseen.text();
    // ...and is seen once it is a few seconds old (LINE_FRESH_MS).
    offset = 5_000;
    const response = await call(token, agentRequest());
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { message: expect.stringMatching(/line is stopped/) } });
  });

  it('reads the line every few seconds, and says why, when it cannot listen for appends', async () => {
    // A store nobody answers at: the gateway starts all the same.
    const unreachable = postgres('postgres://factory_gateway@127.0.0.1:1/factory', {
      connect_timeout: 1,
      onnotice: () => {},
    });
    try {
      const agents = new AgentCalls({ sql: unreachable, log: captured.log } as unknown as AgentCallsOptions);
      await agents.start();
      expect(captured.text()).toMatch(
        /could not listen for appends: a stop of the line is seen within 5s, not at once/,
      );
      await agents.stop();
    } finally {
      await unreachable.end({ timeout: 0 });
    }
  });

  it('tries again to listen until it can, and stops trying when it stops', async () => {
    const unlisten = vi.fn(async () => {});
    const listen = vi.fn().mockRejectedValueOnce(new Error('connection refused')).mockResolvedValue({ unlisten });
    const agents = new AgentCalls({
      sql: { listen },
      log: captured.log,
      relistenMs: 10,
    } as unknown as AgentCallsOptions);
    await agents.start();
    await vi.waitFor(() =>
      expect(captured.text()).toMatch(/listening for appends: a stop of the line is seen at once/),
    );
    expect(listen).toHaveBeenCalledTimes(2);
    await agents.stop();
    expect(unlisten).toHaveBeenCalledOnce();

    // Stopped before it could listen, it tries no more.
    const never = vi.fn().mockRejectedValue(new Error('connection refused'));
    const stopping = new AgentCalls({
      sql: { listen: never },
      log: captured.log,
      relistenMs: 10,
    } as unknown as AgentCallsOptions);
    await stopping.start();
    await stopping.stop();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(never).toHaveBeenCalledOnce();
  });

  it('ignores a stop that says it is Martin’s from any other role, and logs it', async () => {
    const { token, events } = await start();
    // Were row security on the events ever to fail, a worker could append one: the gateway still heeds it not.
    await database.owner`alter table events disable row level security`;
    try {
      await events.append(stop());
    } finally {
      await database.owner`alter table events enable row level security`;
    }
    const response = await call(token, agentRequest());
    expect(response.status).toBe(200);
    await response.text();
    expect(captured.text()).toMatch(/ignored line\.stopped: factory_gateway appended it/);
  });
});
