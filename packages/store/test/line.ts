/**
 * Martin's commands to the line, as a test appends them with one of his roles: the start a store's line needs before
 * it, triage or the gateway take any work (a new store's line has not started), and what he sets the line to take.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type NewEvent, VERSIONS } from '@software-factory/events';
import type { Sql } from 'postgres';
import { DEFAULT_CONTROLS, type Take } from '../../../policy/line.ts';
import { DiskArtifacts, EventWriter } from '../src/index.ts';

/** A moment before every work item a test's line takes: the next few counted from it count every one. */
export const EVER = '2000-01-01T00:00:00.000000Z';

const command = (type: 'line.started' | 'controls.changed', payload: object, ts = new Date()): NewEvent =>
  ({
    id: crypto.randomUUID(),
    ts: ts.toISOString(),
    work_item: null,
    type,
    version: VERSIONS[type],
    actor: 'martin',
    summary: `${type} for the test`,
    payload,
    artifacts: [],
  }) as NewEvent;

const writer = (sql: Sql) =>
  new EventWriter(sql, { kind: 'real', artifacts: new DiskArtifacts(mkdtempSync(join(tmpdir(), 'artifacts-'))) });

/** Starts the line, as Martin's role `sql` (the admin service's or his command line's) appends it, at `ts`, or now. */
export const startLine = (sql: Sql, ts?: Date) =>
  writer(sql).append(command('line.started', { reason: 'The test starts it' }, ts));

/**
 * Sets what the line takes, as Martin's role `sql` appends it, every other control as policy's default: just one work
 * item, the next few from a moment (`EVER` counts every work item the line has taken), or every ticket.
 */
export const setTake = (sql: Sql, take: Take) =>
  writer(sql).append(
    command('controls.changed', {
      ...DEFAULT_CONTROLS,
      take,
      change: { control: 'take', before: DEFAULT_CONTROLS.take, after: take },
    }),
  );
