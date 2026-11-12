/**
 * Applies the numbered SQL migrations in `migrations/` that a database has not had yet, together in one
 * transaction, so a failure leaves the schema as it was, then sets the roles' passwords. In the cluster an Argo CD
 * hook Job runs it before the console starts; on the host:
 *
 *     DATABASE_URL=postgres://factory:…@localhost:5432/factory pnpm migrate
 *
 * Each of the variables in `PASSWORDS`, when set, becomes the password of its role: CONSOLE_PASSWORD the console's
 * reader's, SCOREBOARD_PASSWORD the scoreboard's writer's, METRICS_PASSWORD the Postgres exporter's reader's,
 * TRIAGE_PASSWORD, LINE_PASSWORD and the like each worker's own, ADMIN_PASSWORD the admin service's,
 * PROOFS_PASSWORD the proofs' (`make guardrails`), REDTEAM_PASSWORD the red-team harness's, and PATCHING_PASSWORD
 * the dependency sense's. Martin's command
 * line's and the enrolment's are set by the make targets that use them (`operator.ts`), so no pod holds them. It
 * connects as the database's owner, the only role that may change its schema.
 *
 * On a new cluster the Job starts moments after Postgres, and its first connection can be refused or cut while
 * Postgres, its Service or the network policy are still coming up. So it waits for the store first (`waitForStore`),
 * about a minute, before the first statement, and only then migrates: a refusal costs seconds, not the Job's backoff.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Sql } from 'postgres';
import { connect } from './client.ts';

const MIGRATIONS = fileURLToPath(new URL('../migrations/', import.meta.url));

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/** The migrations in order. A file is `<version>_<name>.sql`, and versions must not repeat. */
export function migrations(dir = MIGRATIONS): Migration[] {
  const found = readdirSync(dir)
    .filter((file) => file.endsWith('.sql'))
    .map((file) => {
      const match = /^(\d+)_([a-z0-9-_]+)\.sql$/.exec(file);
      if (!match) throw new Error(`${file} is not named <version>_<name>.sql`);
      return { version: Number(match[1]), name: match[2] ?? '', sql: readFileSync(`${dir}${file}`, 'utf-8') };
    })
    .sort((a, b) => a.version - b.version);
  found.forEach((m, i) => {
    if (i > 0 && m.version === found[i - 1]?.version) throw new Error(`Two migrations are version ${m.version}`);
  });
  return found;
}

/** The workers that connect to the store, each as a role of its own (0022_worker-roles.sql). */
export const WORKERS = ['triage', 'line', 'gateway', 'probes', 'crawler', 'intake', 'logs'] as const;
export type Worker = (typeof WORKERS)[number];

/** Each role that logs in, by the name its password goes by here, and the variable that gives it in the cluster. */
export const PASSWORDS = {
  console: { role: 'console_reader', variable: 'CONSOLE_PASSWORD' },
  scoreboard: { role: 'scoreboard_writer', variable: 'SCOREBOARD_PASSWORD' },
  metrics: { role: 'metrics_reader', variable: 'METRICS_PASSWORD' },
  // Each worker's own (0022_worker-roles.sql).
  triage: { role: 'factory_triage', variable: 'TRIAGE_PASSWORD' },
  line: { role: 'factory_line', variable: 'LINE_PASSWORD' },
  gateway: { role: 'factory_gateway', variable: 'GATEWAY_PASSWORD' },
  probes: { role: 'factory_probes', variable: 'PROBES_PASSWORD' },
  crawler: { role: 'factory_crawler', variable: 'CRAWLER_PASSWORD' },
  intake: { role: 'factory_intake', variable: 'INTAKE_PASSWORD' },
  logs: { role: 'factory_logs', variable: 'LOGS_PASSWORD' },
  // The admin service's (0023_martins-commands.sql).
  admin: { role: 'factory_admin', variable: 'ADMIN_PASSWORD' },
  // The proofs', which `make guardrails` connects as from the Mac (0043_guardrail-proofs.sql).
  proofs: { role: 'factory_proofs', variable: 'PROOFS_PASSWORD' },
  // The red-team harness's (0045_red-team-attacks.sql), which is no member of the workers' role.
  redteam: { role: 'factory_redteam', variable: 'REDTEAM_PASSWORD' },
  // The dependency sense's (0050_patching.sql), which is no member of the workers' role either.
  patching: { role: 'factory_patching', variable: 'PATCHING_PASSWORD' },
} as const;

export type Passwords = { [name in keyof typeof PASSWORDS]?: string | undefined };

/**
 * The errors of a store still coming up, worth trying again: refused, cut or timed out before it answered, its name not
 * yet resolving, or Postgres saying it is starting (57P03), ended the connection as it restarted (57P01), or had no
 * connection free (53300). A wrong password (28P01) is not one: the Job connects as
 * the owner, whose password Postgres takes at initdb, before it listens on TCP, so it never comes right by waiting.
 */
const COMING_UP = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'CONNECT_TIMEOUT',
  'CONNECTION_CLOSED',
  'CONNECTION_ENDED',
  'CONNECTION_DESTROYED',
  '57P01',
  '57P03',
  '53300',
]);

const codeOf = (error: unknown) => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'unknown';
};

export interface WaitOptions {
  /** How long to keep trying, from the first attempt. */
  withinMs?: number;
  /** How long between attempts. */
  everyMs?: number;
  /** Told each code once, the first time it comes, and how long the wait had taken. */
  say?: (line: string) => void;
}

/**
 * Waits until the store answers a query, trying about once a second for about a minute while its errors are those of
 * a store still coming up (`COMING_UP`), and saying each such error's code once. Returns how many attempts failed. Any
 * other error, or the last when the time is up, is thrown, as an error of the first attempt would have been.
 */
export async function waitForStore(
  sql: Sql,
  { withinMs = 60_000, everyMs = 1_000, say = console.log }: WaitOptions = {},
): Promise<number> {
  const start = performance.now();
  const said = new Set<string>();
  for (let failed = 0; ; failed++) {
    try {
      await sql`select 1`;
      if (failed) say(`The store answered after ${failed} failed ${failed === 1 ? 'attempt' : 'attempts'}.`);
      return failed;
    } catch (error) {
      const code = codeOf(error);
      const waited = performance.now() - start;
      if (!COMING_UP.has(code) || waited + everyMs > withinMs) {
        if (COMING_UP.has(code))
          say(`The store did not answer within ${Math.round(withinMs / 1000)} s: the last attempt was ${code}.`);
        throw error;
      }
      if (!said.has(code)) {
        said.add(code);
        say(`Waiting for the store: ${code} at ${(waited / 1000).toFixed(1)} s (${(error as Error).message}).`);
      }
      await new Promise((resolve) => setTimeout(resolve, everyMs));
    }
  }
}

/** Applies what is pending and returns the names of the migrations it applied. */
export async function migrate(sql: Sql, passwords: Passwords = {}): Promise<string[]> {
  const applied: string[] = [];
  // Two Jobs at once would race; the second waits for the first, then finds nothing to do.
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext('migrations'))`;
    await tx`
      create table if not exists schema_migrations (
        version integer primary key,
        name text not null,
        applied_at timestamptz not null default now()
      )`;
    const done = new Set(
      (await tx<{ version: number }[]>`select version from schema_migrations`).map((r) => r.version),
    );
    for (const migration of migrations()) {
      if (done.has(migration.version)) continue;
      await tx.unsafe(migration.sql);
      await tx`insert into schema_migrations (version, name) values (${migration.version}, ${migration.name})`;
      applied.push(`${migration.version}_${migration.name}`);
    }
  });
  for (const [name, { role }] of Object.entries(PASSWORDS)) {
    const password = passwords[name as keyof Passwords];
    // A role's password cannot be a query parameter; the literal is escaped instead.
    if (password) await sql.unsafe(`alter role ${role} password '${password.replaceAll("'", "''")}'`);
  }
  return applied;
}

if (import.meta.main) {
  const url = process.env.DATABASE_URL;
  // Five seconds for each attempt rather than postgres.js's thirty, so a connection dropped unanswered (by a network
  // policy not yet in place) costs a few of the wait's attempts, not half of it.
  const sql = connect(url, { connect_timeout: 5 });
  try {
    const passwords = Object.fromEntries(
      Object.entries(PASSWORDS).map(([name, { variable }]) => [name, process.env[variable]]),
    ) as Passwords;
    // Only reaching the store is tried again: an error in a migration fails the Job at once.
    await waitForStore(sql);
    const applied = await migrate(sql, passwords);
    console.log(applied.length ? `Applied ${applied.join(', ')}.` : 'Nothing to apply: the schema is current.');
  } catch (error) {
    // The whole error, then one line last, which the platform check's watch quotes of a failed attempt.
    console.error(error);
    console.error(`The migration failed: ${codeOf(error)}: ${(error as Error)?.message ?? String(error)}`);
    process.exitCode = 1;
  } finally {
    await sql.end();
  }
}
