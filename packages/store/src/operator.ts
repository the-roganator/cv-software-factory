/**
 * Readies one of Martin's own roles in the store for a make target on the host, as the database's owner: it gives the
 * role the password read from stdin, so no pod need hold it, and prints the role to connect as.
 *
 * - `factory_operator` (`as-operator` in the Makefile: `make stop-the-line`, `make start-the-line`, `make take-the-line`,
 *   `make samples`). A
 *   store not yet migrated to 0023 has no such role and guards none of Martin's commands, so it prints the owner's
 *   own, which it connected as: `make stop-the-line` stops the line either way, and the next sync's migrate Job gives
 *   the store his role. On a store migrated to 0023 whose role cannot append, it fails: a command the owner appended
 *   there is one the factory ignores.
 * - `factory_enrol` (`make enrol`). A store not yet migrated to 0025 cannot record what the enrolment revokes, so it
 *   fails: there is no other role to enrol with.
 *
 *     printf %s "$password" | PGHOST=… PGUSER=factory PGPASSWORD=… node packages/store/src/operator.ts [factory_enrol]
 */
import { text } from 'node:stream/consumers';
import type { Sql } from 'postgres';
import { connect } from './client.ts';

/** Martin's roles a make target connects as, and the privilege that says a store is migrated far enough for each. */
const READY = {
  factory_operator: { table: 'events', privilege: 'insert' },
  factory_enrol: { table: 'events', privilege: 'insert' },
} as const;

export type MartinsRole = keyof typeof READY;

/** Gives one of Martin's roles this password, as the owner, if the store is migrated far enough for it. */
export async function readyRole(sql: Sql, role: MartinsRole, password: string): Promise<boolean> {
  if (!password) throw new Error(`No password for ${role}`);
  const { table, privilege } = READY[role];
  // Roles belong to the whole server, so another database may have made it: this one is migrated when the role may
  // do what it is for here.
  const [found] = await sql<{ ready: boolean }[]>`
    select case when exists (select 1 from pg_roles where rolname = ${role})
                then has_table_privilege(${role}, ${table}, ${privilege}) else false end as ready`;
  if (!found?.ready) return false;
  // A role's password cannot be a query parameter; the literal is escaped instead. The role is one of two names.
  await sql.unsafe(`alter role ${role} password '${password.replaceAll("'", "''")}'`);
  return true;
}

/** Gives Martin's role this password, as the owner, and says which role to connect as: his, or the owner's. */
export async function readyOperator(sql: Sql, password: string): Promise<string> {
  if (await readyRole(sql, 'factory_operator', password)) return 'factory_operator';
  const [store] = await sql<{ migrated: boolean; owner: string }[]>`
    select exists (select 1 from schema_migrations where version >= 23) as migrated, current_user as owner`;
  if (!store) throw new Error('The store did not say who it is');
  if (store.migrated) {
    throw new Error(
      "Martin's role cannot append events in this store, which is migrated to give it that: check its grants",
    );
  }
  return store.owner;
}

if (import.meta.main) {
  const role = process.argv[2] ?? 'factory_operator';
  const sql = connect();
  try {
    if (!Object.hasOwn(READY, role)) throw new Error(`${role} is not one of Martin's roles: ${Object.keys(READY)}`);
    const password = (await text(process.stdin)).trim();
    if (role === 'factory_operator') {
      const connectAs = await readyOperator(sql, password);
      if (connectAs !== 'factory_operator') {
        console.error("This store has no role for Martin yet (migration 0023): connecting as the database's owner.");
      }
      console.log(connectAs);
    } else if (await readyRole(sql, role as MartinsRole, password)) {
      console.log(role);
    } else {
      throw new Error('This store cannot enrol a passkey yet (migration 0025): deploy the image that migrates it.');
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    await sql.end();
  }
}
