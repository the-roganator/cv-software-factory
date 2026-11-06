/**
 * Which launches the red-team harness takes, against a real store as its own role: a real launch one of Martin's roles
 * appended, and no sample's, and none another role appended. A fake store would pass a query Postgres refuses, as one
 * that passed postgres.js a list to `= any(...)` did, so the harness's own query is run here.
 */
import { VERSIONS } from '@software-factory/events';
import type { JSONValue } from '@software-factory/store';
import type { Sql } from 'postgres';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Database, freshDatabase } from '../../../../packages/store/test/database.ts';
import { ATTACK_TITLE } from '../../../../policy/attacks.ts';
import type { Attempt, AttemptResult } from '../../src/red-team/worker.ts';
import { RedTeam } from '../../src/red-team/worker.ts';
import { fakeEvents, never, silent } from './fakes.ts';

let database: Database;
beforeEach(async () => {
  database = await freshDatabase('red_team_launches');
});
afterEach(() => database?.end());

/** Appends an event straight to the store as `sql`'s role, unchecked but by row security. */
async function append(sql: Sql, type: string, payload: object, workItem: string, sample = false): Promise<void> {
  const version = (VERSIONS[type as keyof typeof VERSIONS] as number | undefined) ?? 1;
  await sql`
    insert into events (id, ts, work_item, type, version, actor, summary, payload, artifacts, public, sample)
    values (${crypto.randomUUID()}, now(), ${workItem}, ${type}, ${version}, 'martin', ${type},
            ${sql.json(payload as JSONValue)}, '[]', ${sql.json({ payload } as JSONValue)}, ${sample})`;
}

async function launch(sql: Sql, workItem: string, sample = false): Promise<void> {
  await append(
    sql,
    'work-item.opened',
    { kind: 'red-team', category: 'red-team', title: ATTACK_TITLE },
    workItem,
    sample,
  );
  await append(sql, 'attack.launched', { attack: 'report' }, workItem, sample);
}

/** The work items the harness made the report attack on, in one pass over the store. */
async function taken(): Promise<string[]> {
  const made: string[] = [];
  const report: Attempt = async (ctx) => {
    made.push(ctx.workItem);
    return { outcome: 'unfinished', refusals: [], attempts: [], reason: 'a test' } satisfies AttemptResult;
  };
  const unused: Attempt = async () => {
    throw new Error('only the report attack is launched here');
  };
  const harness = new RedTeam({
    sql: database.redteam,
    events: fakeEvents(),
    attempts: { report, workflow: unused, test: unused, egress: unused, image: unused },
    log: silent,
  });
  await harness.once(never);
  return made;
}

describe('the launches the red-team harness takes', () => {
  it('takes a real launch the admin service appended for Martin', async () => {
    await launch(database.admin, '6001');
    expect(await taken()).toEqual(['6001']);
  });

  it('takes no sample’s launch: a store of samples holds no attack to make', async () => {
    await launch(database.admin, '6002', true);
    expect(await taken()).toEqual([]);
  });

  it('takes no launch a role not Martin’s appended', async () => {
    await launch(database.owner, '6003');
    expect(await taken()).toEqual([]);
  });
});
