/**
 * A fresh database for a test file, on the Postgres the setup provides (postgres.ts), a copy of the run's migrated
 * template, with a connection as each role: the owner (as the migration Job connects), the console's reader, the
 * scoreboard's writer, the Postgres exporter's reader, Martin's roles (his command line's and the admin service's), the
 * enrolment's, the proofs', and each worker's own (`as`).
 */
import { inject } from 'vitest';
import { createDatabase } from './postgres.ts';

export type { Database } from './postgres.ts';

/** A fresh database on the Postgres the test project's setup provides. */
export const freshDatabase = (name: string) => createDatabase(inject('databaseUrl'), name, inject('databaseTemplate'));
