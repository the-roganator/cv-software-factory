/**
 * The gateway's settings, read from the environment.
 *
 *     GATEWAY_MODE      live, record, replay or replay-record (default replay)
 *     TYPESAFE_API_KEY  the provider's key. Without it the gateway replays, whatever the mode
 *     TYPESAFE_URL      the provider's address, for a stand-in (default https://api.typesafe.ai)
 *     CASSETTES_DIR     where cassettes are recorded; also read
 *     CASSETTES_READ    more folders to read, separated by colons, such as the committed evaluation cassettes
 *     FACTORY_PROFILE   local, do or aws (default local), which chooses the bounds in policy/spend.ts and
 *                       policy/models.ts that Martin's settings are held to, and their defaults
 *     ANTHROPIC_API_KEY Anthropic's key, for agents. Without it, agents' calls to Claude replay only
 *     ANTHROPIC_URL     Anthropic's address, for a stand-in (default https://api.anthropic.com)
 *     LOCAL_MODELS_URL  LM Studio's address, where the profile has a local model (default http://127.0.0.1:1234)
 *     ALL_LOCAL         true: every agent to the profile's local model, whatever the settings say, for unattended runs
 *     JUDGEMENTS_TOKEN  triage's caller token, which every judgement must carry; without it, every judgement is 401
 *     PORT              default 8080
 *     DATABASE_URL, or the PG* variables, for the store
 */
import { MODELS } from '../../../../policy/models.ts';
import { PROFILES, type Profile } from '../../../../policy/spend.ts';
import { MODES, type Mode } from './gateway.ts';

export interface GatewayConfig {
  mode: Mode;
  apiKey: string | undefined;
  typesafeUrl: string | undefined;
  cassettesDir: string | undefined;
  cassettesRead: string[];
  profile: Profile;
  port: number;
  anthropicKey: string | undefined;
  anthropicUrl: string | undefined;
  localModelsUrl: string;
  allLocal: boolean;
  judgementsToken: string | undefined;
}

/** `make judgements-token` makes 64 hex characters; anything much shorter could be guessed. */
const SHORTEST_TOKEN = 32;

const oneOf = <T extends string>(name: string, value: string, allowed: readonly T[]): T => {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`${name} is ${JSON.stringify(value)}; it must be one of ${allowed.join(', ')}.`);
  }
  return value as T;
};

export function configFromEnv(env: NodeJS.ProcessEnv): GatewayConfig {
  const apiKey = env.TYPESAFE_API_KEY || undefined;
  const config: GatewayConfig = {
    mode: oneOf('GATEWAY_MODE', env.GATEWAY_MODE || 'replay', MODES),
    apiKey,
    typesafeUrl: env.TYPESAFE_URL || undefined,
    cassettesDir: env.CASSETTES_DIR || undefined,
    cassettesRead: (env.CASSETTES_READ ?? '').split(':').filter(Boolean),
    profile: oneOf('FACTORY_PROFILE', env.FACTORY_PROFILE || 'local', PROFILES),
    port: Number(env.PORT ?? 8080),
    anthropicKey: env.ANTHROPIC_API_KEY || undefined,
    anthropicUrl: env.ANTHROPIC_URL || undefined,
    localModelsUrl: env.LOCAL_MODELS_URL || 'http://127.0.0.1:1234',
    allLocal: env.ALL_LOCAL === 'true',
    judgementsToken: env.JUDGEMENTS_TOKEN || undefined,
  };
  if (config.judgementsToken && config.judgementsToken.length < SHORTEST_TOKEN) {
    throw new Error(`JUDGEMENTS_TOKEN is under ${SHORTEST_TOKEN} characters: make one with openssl rand -hex 32.`);
  }
  if (config.allLocal && !MODELS[config.profile].local) {
    throw new Error(`ALL_LOCAL sends every agent to the local model, and the ${config.profile} profile has none.`);
  }
  // Recording needs somewhere to record, whenever there is a provider to record from: TypeSafe, Anthropic, or the
  // profile's local model, which needs no key.
  const records = config.mode === 'record' || config.mode === 'replay-record';
  const provider = apiKey || config.anthropicKey || MODELS[config.profile].local;
  if (records && provider && !config.cassettesDir) {
    throw new Error(`GATEWAY_MODE ${config.mode} records cassettes, so set CASSETTES_DIR to the folder for them.`);
  }
  return config;
}
