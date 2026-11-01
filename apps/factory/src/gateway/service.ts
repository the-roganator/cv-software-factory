/**
 * Starts the gateway: the store, the spend ledger, the cassettes, the provider and the HTTP server, wired from a
 * `GatewayConfig`. `factory gateway` is the entry point, and loads `telemetry.ts` before this module.
 */
import { tmpdir } from 'node:os';
import { connect, DiskArtifacts, EventWriter } from '@software-factory/store';
import { MODEL as TRIAGE_MODEL } from '@software-factory/triage';
import { MODELS } from '../../../../policy/models.ts';
import type { Profile } from '../../../../policy/spend.ts';
import { sendCounts } from '../counts.ts';
import { listenOn } from '../listen.ts';
import { log } from '../log.ts';
import { SettingsReader } from '../settings.ts';
import { AgentCassettes } from './agent-cassettes.ts';
import { AgentCalls, routes, usageOf } from './agents.ts';
import { Cassettes } from './cassettes.ts';
import type { GatewayConfig } from './config.ts';
import { Gateway } from './gateway.ts';
import { zeroCounts } from './metrics.ts';
import { costOf } from './prices.ts';
import { ProviderCaps } from './provider-caps.ts';
import { Anthropic, LocalModels, type MessagesProvider, type ProviderName } from './providers.ts';
import { startPruning } from './pruning.ts';
import { Refusals } from './refusals.ts';
import { createGatewayServer } from './server.ts';
import { Spend } from './spend.ts';
import { PROVIDER as TYPESAFE, TypeSafe } from './typesafe.ts';

/**
 * What the gateway asks a capped provider to learn whether it answers again: one token from the cheapest model the
 * profile offers there, with no thinking, so the token is the answer's. None where the profile offers it no model.
 */
export function probeOf(profile: Profile, name: ProviderName) {
  const model = MODELS[profile].models.find((offered) => offered.provider === name)?.model;
  if (!model) return undefined;
  return {
    model,
    max_tokens: 1,
    thinking: { type: 'disabled' },
    messages: [{ role: 'user', content: 'Reply with one word.' }],
  } as const;
}

export async function startGateway(config: GatewayConfig, env: NodeJS.ProcessEnv = process.env) {
  const sql = connect(env.DATABASE_URL, { max: 4 });
  // The line events the gateway appends have no artifacts, so the store it is given is never read.
  const events = new EventWriter(sql, { kind: 'real', artifacts: new DiskArtifacts(tmpdir()) });
  // Each refusal of a guardrail, its repeats folded.
  const refusals = new Refusals({ events, log });
  // Martin's settings within policy: the caps in force at each check, and each job's model and effort.
  const settings = new SettingsReader(sql, config.profile);
  const spend = new Spend({
    sql,
    events,
    profile: config.profile,
    policy: async (fresh) => (await settings.now(fresh)).caps,
    log,
  });
  const typesafe = config.apiKey
    ? new TypeSafe({ apiKey: config.apiKey, log, ...(config.typesafeUrl ? { baseUrl: config.typesafeUrl } : {}) })
    : undefined;
  const gateway = new Gateway({
    sql,
    spend,
    cassettes: new Cassettes({ record: config.cassettesDir, read: config.cassettesRead }),
    mode: config.mode,
    typesafe,
    log,
    refusals,
  });
  // Agents' providers: Anthropic with the key, and the profile's local model, which needs none.
  const providers: Partial<Record<ProviderName, MessagesProvider>> = {};
  if (config.anthropicKey) {
    providers.anthropic = new Anthropic({
      apiKey: config.anthropicKey,
      ...(config.anthropicUrl ? { base: config.anthropicUrl } : {}),
    });
  }
  const local = MODELS[config.profile].local;
  if (local) providers.local = new LocalModels({ base: config.localModelsUrl });
  // A capped provider is asked one small question, a few minutes apart, until it answers.
  const probe = async (name: ProviderName) => {
    const provider = providers[name];
    const asked = probeOf(config.profile, name);
    if (!provider || !asked) return false;
    const { model } = asked;
    const response = await provider.send('/v1/messages', JSON.stringify(asked), {}, AbortSignal.timeout(30_000));
    const usage = (response.ok ? usageOf(await response.text(), false) : undefined) ?? {
      inputTokens: 0,
      outputTokens: 0,
    };
    if (!response.ok) await response.body?.cancel();
    // Every call is audited and counted, the gateway's own included.
    await sql`
      insert into model_calls (id, agent, provider, model, question_set, input_tokens, output_tokens, cost_usd,
                               duration_ms, outcome)
      values (${crypto.randomUUID()}, 'gateway', ${name}, ${model}, 'probe', ${usage.inputTokens}, ${usage.outputTokens},
              ${response.ok ? costOf(model, usage) : 0}, 0, ${response.ok ? 'answered' : 'failed'})`;
    return response.ok;
  };
  const caps = new ProviderCaps({ sql, events, log, probe });
  const agents = new AgentCalls({
    sql,
    spend,
    caps,
    cassettes: new AgentCassettes({ record: config.cassettesDir, read: config.cassettesRead }),
    mode: config.mode,
    profile: config.profile,
    allLocal: config.allLocal,
    settings,
    providers,
    log,
    refusals,
  });
  // Every count from 0: each agent's calls on the route the profile gives it, and triage's judgements.
  zeroCounts(routes(config.profile, config.allLocal), [{ agent: 'triage', provider: TYPESAFE, model: TRIAGE_MODEL }]);
  await sendCounts();
  await spend.resume();
  spend.start();
  await caps.resume();
  caps.start();
  refusals.start();
  // Each append heard, so a stop of the line is refused from the next call. Not waited for: until it listens, the
  // gateway reads the line every few seconds, and a store slow to answer holds up nothing else.
  void agents.start();
  // Only in `record`, where nothing is replayed from the folder, but Jev's calls with no TypeSafe key.
  const pruner =
    config.mode === 'record' && config.cassettesDir
      ? startPruning({ sql, dir: config.cassettesDir, agentsOnly: gateway.mode !== 'record' }, log)
      : undefined;

  /**
   * Stops the ledger, the caps, the pruner and the listening for appends, and records the refusals still folding, each
   * whether or not another fails to, then lets go of the store.
   */
  const release = async () => {
    const stopped = await Promise.allSettled([
      spend.stop(),
      caps.stop(),
      pruner?.stop(),
      refusals.stop(),
      agents.stop(),
    ]);
    await sql.end();
    const failed = stopped.find((result) => result.status === 'rejected');
    if (failed) throw failed.reason;
  };
  const server = createGatewayServer({ gateway, agents, spend, judgementsToken: config.judgementsToken, log });
  try {
    await listenOn(server, config.port);
  } catch (error) {
    // A port it cannot have: what it started is stopped, and the caller is told why, whatever the stopping says.
    await release().catch((cleanup: unknown) =>
      log.warn({ err: cleanup }, 'could not stop the gateway after it failed to listen'),
    );
    throw error;
  }
  log.info(
    {
      port: config.port,
      mode: gateway.mode,
      profile: config.profile,
      agents: Object.keys(providers),
      allLocal: config.allLocal,
      judgements: Boolean(config.judgementsToken),
    },
    `gateway listening on :${config.port}`,
  );

  /** Finishes the requests in flight, then lets go of the store. */
  const stop = async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeIdleConnections();
    });
    await release();
  };
  return { server, stop };
}
