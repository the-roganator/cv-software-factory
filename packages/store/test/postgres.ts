/**
 * A real Postgres for the store's tests: TEST_DATABASE_URL if it is set, or else a throwaway container of the same
 * image the cluster runs, removed with its data when the tests finish. CI names its own copy of that image in
 * TEST_POSTGRES_IMAGE. The setup migrates a template once for the run, and each test's database is a copy of it.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import postgres, { type Sql } from 'postgres';
import type { TestProject } from 'vitest/node';
import { migrate, type Passwords, PASSWORDS as ROLES, WORKERS, type Worker } from '../src/migrate.ts';
import { readyOperator } from '../src/operator.ts';

export { WORKERS, type Worker };

/** Each role's password in the tests: its name's. */
export const PASSWORDS = Object.fromEntries(
  Object.keys(ROLES).map((name) => [name, `${name}-test-password`]),
) as Required<Record<keyof Passwords, string>>;

/** Roles the migrate Job gives no password, which the tests give one so they can connect as each. */
const UNSET = { enrol: 'factory_enrol' } as const;
const quiet = { onnotice: () => {}, max: 2 };

export interface Database {
  name: string;
  owner: Sql;
  reader: Sql;
  scoreboard: Sql;
  metrics: Sql;
  /** Martin's roles: his command line's, and the admin service's. */
  operator: Sql;
  admin: Sql;
  /** `factory admin enrol`'s. */
  enrol: Sql;
  /** The proofs', `make guardrails`'s. */
  proofs: Sql;
  /** A connection as each worker's own role. */
  as: Record<Worker, Sql>;
  end(): Promise<void>;
}

// The image the cluster runs: its one pin is its StatefulSet's.
const STATEFULSET = new URL('../../../deploy/base/postgres/statefulset.yaml', import.meta.url);
function image() {
  const pinned = readFileSync(STATEFULSET, 'utf-8').match(/^\s+image: (\S+)$/m)?.[1];
  if (!pinned) throw new Error(`No Postgres image in ${STATEFULSET.pathname}`);
  return process.env.TEST_POSTGRES_IMAGE || pinned;
}

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
    /** The run's migrated template, which each test database is a copy of. */
    databaseTemplate: string;
  }
}

// Each container is labelled with the process that started it, and when that process started, so a later run can
// find one whose process died before it could remove it, even once the process's id has gone to another.
const PID = 'software-factory-test.pid';
const STARTED = 'software-factory-test.started';
const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf-8', stdio: 'pipe' }).trim();
// The image keeps its data in an anonymous volume, which `rm` leaves behind unless asked: gigabytes after a full run.
const remove = (...names: string[]) => void docker('rm', '--force', '--volumes', ...names);

/** Removes the containers, with their data, of runs that were killed before they could. Other runs' are kept. */
function sweep() {
  // Tidying up is a courtesy: if it fails, no tests do.
  try {
    const format = `{{.ID}}\t{{.Label "${PID}"}}\t{{.Label "${STARTED}"}}`;
    const orphans = docker('ps', '--all', '--filter', `label=${PID}`, '--format', format)
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split('\t'))
      .filter(([, pid, at]) => started(Number(pid)) !== at)
      .map(([id]) => id as string);
    if (orphans.length) remove(...orphans);
  } catch {}
}

/** When a process started, as `ps` puts it, or nothing if it isn't running. Any user's process counts. */
function started(pid: number) {
  try {
    return execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf-8',
      stdio: 'pipe',
      env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
    }).trim();
  } catch {
    return '';
  }
}

/** A throwaway Postgres in Docker, ready for connections, and how to remove it. */
export async function startPostgres(): Promise<{ url: string; stop: () => void }> {
  try {
    docker('info', '--format', '{{.ServerVersion}}');
  } catch {
    throw new Error('These tests need Postgres: set TEST_DATABASE_URL, or start Docker so they can run their own.');
  }
  sweep();
  const name = `software-factory-test-${process.pid}-${Date.now()}`;
  docker(
    'run',
    '--detach',
    '--rm',
    '--name',
    name,
    '--label',
    `${PID}=${process.pid}`,
    '--label',
    `${STARTED}=${started(process.pid)}`,
    '--env',
    'POSTGRES_USER=factory',
    '--env',
    'POSTGRES_PASSWORD=test',
    '--publish',
    '127.0.0.1::5432',
    image(),
    // Its data goes with it, so nothing need survive a crash: Postgres writes without waiting for the disk.
    ...['-c', 'fsync=off', '-c', 'synchronous_commit=off', '-c', 'full_page_writes=off'],
  );
  const port = docker('port', name, '5432/tcp').split(':').at(-1);
  // pg_isready answers before the server takes connections from outside; a query proves it does.
  for (let tries = 0; ; tries++) {
    try {
      docker('exec', name, 'psql', '-U', 'factory', '-h', '127.0.0.1', '-c', 'select 1');
      break;
    } catch (error) {
      // A minute: a slow runner's first initdb takes a while.
      if (tries > 240) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  return { url: `postgres://factory:test@127.0.0.1:${port}/postgres`, stop: () => remove(name) };
}

/**
 * Readies the server for a run: migrates the run's template once, then each test copies it (`createDatabase`). Every
 * process of a sharded run starts its own Postgres, or is given its own, and readies it so.
 */
export default async function setup(project: TestProject) {
  const given = process.env.TEST_DATABASE_URL;
  const server = given ? { url: given, stop: () => {} } : await startPostgres();
  try {
    const template = await createTemplate(server.url);
    project.provide('databaseUrl', server.url);
    project.provide('databaseTemplate', template.name);
    return async () => {
      // A container goes with its data; on a server that outlives the run, the template is dropped.
      if (given) await template.drop();
      server.stop();
    };
  } catch (error) {
    server.stop();
    throw error;
  }
}

/**
 * How long making a test database may take before `createDatabase` fails. A copy of the template takes 60 to 90 ms at
 * the median and half a second at worst while the whole run copies at once, and up to a second and a half with two runs
 * side by side on one machine. When each test migrated its own, under one lock for the server, the wait for that lock
 * alone was over two seconds for one database in ten, and up to seven. Two seconds lies between the two, and leaves
 * three of a test's five to the test.
 */
export const CREATE_LIMIT_MS = 2000;

const connectTo = (server: string, database: string) => {
  const url = new URL(server);
  return (username: string, password: string) =>
    postgres({ ...quiet, host: url.hostname, port: Number(url.port), database, username, password });
};
const ownerOf = (server: string, database: string) => {
  const { username, password } = new URL(server);
  return connectTo(server, database)(decodeURIComponent(username), decodeURIComponent(password));
};
/** One connection to the server's own database, for making and dropping others. */
const serverAdmin = (server: string) => postgres(server, { ...quiet, max: 1 });

/** Drops a database, a template too. */
async function dropDatabase(server: string, database: string) {
  const sql = serverAdmin(server);
  try {
    await sql.unsafe(`alter database ${database} with is_template false`);
    await sql.unsafe(`drop database ${database}`);
  } finally {
    await sql.end();
  }
}

/**
 * Makes a database and migrates it, and gives the roles the tests connect as their passwords, which belong to the whole
 * server, as the migrate Job and `make stop-the-line` give them. Two runs, or two of the console's browser tests, may
 * share a server, so they take turns, under a lock in the server's own database: advisory locks belong to a database.
 */
async function migrated(server: string, database: string) {
  const admin = serverAdmin(server);
  try {
    await admin`select pg_advisory_lock(hashtext('test migrations'))`;
    await admin.unsafe(`create database ${database}`);
    const owner = ownerOf(server, database);
    try {
      await migrate(owner, PASSWORDS);
      for (const [name, role] of Object.entries(UNSET))
        await owner.unsafe(`alter role ${role} password '${name}-test'`);
      await readyOperator(owner, 'operator-test');
    } catch (error) {
      // Half migrated, it is no use to anyone: on a server that outlives the run, it goes.
      await owner.end();
      await admin.unsafe(`drop database ${database}`).catch(() => {});
      throw error;
    } finally {
      await owner.end();
    }
  } finally {
    // Ending the session releases its lock.
    await admin.end();
  }
}

/**
 * The run's template, migrated once, that each test's database is a copy of (`createDatabase`), and how to drop it. Its
 * name is the run's process and the time, so two runs on one server never copy each other's.
 */
export async function createTemplate(server: string): Promise<{ name: string; drop(): Promise<void> }> {
  const name = `template_${process.pid}_${Date.now()}`;
  await migrated(server, name);
  const drop = () => dropDatabase(server, name);
  const sql = serverAdmin(server);
  try {
    // A copy fails while anything is connected to its source, so nothing may connect to the template from here on.
    await sql.unsafe(`alter database ${name} with is_template true allow_connections false`);
  } catch (error) {
    await drop().catch(() => {});
    throw error;
  } finally {
    await sql.end();
  }
  return { name, drop };
}

/**
 * A fresh database on a given Postgres, with a connection as each role: a copy of the run's template, or, with none, one
 * migrated for itself, for a caller that makes just one (the console's browser tests).
 *
 * A copy that takes longer than `limitMs` fails, naming the cause, rather than leave a test to time out on a
 * wait that is not its own.
 */
export async function createDatabase(
  server: string,
  name: string,
  template?: string,
  limitMs = CREATE_LIMIT_MS,
): Promise<Database> {
  const database = `${name}_${process.pid}_${Date.now()}`;
  if (template) {
    const admin = serverAdmin(server);
    let took: number;
    try {
      // Connected first, so the limit is the copy's alone.
      await admin`select 1`;
      const started = performance.now();
      await admin.unsafe(`create database ${database} template ${template}`);
      took = performance.now() - started;
    } finally {
      await admin.end();
    }
    if (took > limitMs) {
      await dropDatabase(server, database).catch(() => {});
      throw new Error(
        `Making the test database ${database} took ${Math.round(took)} ms, over the ${limitMs} ms a copy of ` +
          'the template may take: something is making test databases wait again (packages/store/test/postgres.ts)',
      );
    }
  } else {
    await migrated(server, database);
  }
  const as = connectTo(server, database);
  const owner = ownerOf(server, database);
  const reader = as('console_reader', PASSWORDS.console);
  const scoreboard = as('scoreboard_writer', PASSWORDS.scoreboard);
  const metrics = as('metrics_reader', PASSWORDS.metrics);
  const operator = as('factory_operator', 'operator-test');
  const service = as('factory_admin', PASSWORDS.admin);
  const enrol = as(UNSET.enrol, 'enrol-test');
  const proofs = as('factory_proofs', PASSWORDS.proofs);
  const workers = Object.fromEntries(WORKERS.map((w) => [w, as(ROLES[w].role, PASSWORDS[w])])) as Record<Worker, Sql>;
  return {
    name: database,
    owner,
    reader,
    scoreboard,
    metrics,
    operator,
    admin: service,
    enrol,
    proofs,
    as: workers,
    end: async () => {
      const all = [owner, reader, scoreboard, metrics, operator, service, enrol, proofs, ...Object.values(workers)];
      await Promise.all(all.map((c) => c.end()));
    },
  };
}
