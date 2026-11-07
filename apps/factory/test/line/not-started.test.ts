/**
 * The line on a new store: not started until Martin first starts it, so it takes nothing, starts no step and calls no
 * model, and says so once; then, with no take set, it takes every ticket, and says that he set none.
 */
import { lineState, lineStopped } from '@software-factory/store';
import { describe, expect, it } from 'vitest';
import { startLine } from '../../../../packages/store/test/line.ts';
import { quiet } from '../github/fake.ts';
import { AGENTS, database, events, justOne, line, stage, ticket, withLineStore } from './harness.ts';

withLineStore({ started: false });

/** A logger that keeps what the line says, at info and warn, with its details. */
function said() {
  const lines: { message: string; details: object }[] = [];
  // As pino takes them: the details and the message, or the message alone.
  const keep = (details: object | string, message?: string) =>
    void lines.push(
      typeof details === 'string' ? { message: details, details: {} } : { message: message ?? '', details },
    );
  return { lines, log: { ...quiet, info: keep, warn: keep } as never };
}

describe('the line on a new store', () => {
  it('has not started, and counts as stopped to every worker', async () => {
    expect(await lineState(database.as.line)).toBe('not-started');
    expect(await lineStopped(database.as.line)).toBe(true);
    await startLine(database.admin);
    expect(await lineState(database.as.line)).toBe('running');
    expect(await lineStopped(database.as.line)).toBe(false);
  });

  it('takes nothing until Martin first starts it, says so once, and then takes every ticket, as he set none', async () => {
    const workItem = await ticket();
    const { lines, log } = said();
    const { pass, steps } = line(AGENTS, events, { log });
    await pass();
    await pass();
    expect(await stage(workItem)).toBeUndefined();
    expect(steps.requests).toEqual([]);
    expect(lines.map((l) => l.message)).toEqual([
      'the line takes every ticket: Martin has set no take',
      'the line has not started: it waits for Martin to start it, and takes nothing until then',
    ]);
    expect(lines[0]?.details).toEqual({ take: { kind: 'every' }, newWork: true, set: false });

    await startLine(database.admin);
    await pass();
    expect(steps.requests.map((r) => [r.workItem, r.agent])).toEqual([[workItem, 'planner']]);
    expect(lines.map((l) => l.message)).toContain('the line started: carrying on from the last events');
  });

  it('says what Martin set it to take, once he sets it', async () => {
    const workItem = await ticket();
    await startLine(database.admin);
    await justOne(workItem);
    const { lines, log } = said();
    await line(AGENTS, events, { log }).pass();
    expect(lines[0]).toEqual({
      message: 'the line takes what Martin set it to take',
      details: { take: { kind: 'just-one', workItem }, newWork: true, set: true },
    });
  });
});
