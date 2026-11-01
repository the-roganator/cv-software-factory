/**
 * Proves `ci:stopped-line` (policy/guardrails.ts, spec 6 guardrail 9), with the gateway's and the runners' tests beside
 * it: the line ends the step in hand when it stops, starts none until it starts again, and heeds only a stop one of
 * Martin's roles appended. Martin's (CODEOWNERS), as every file here is: a change to what they assert is a change to
 * the proof.
 */
import { lineStopped } from '@software-factory/store';
import { describe, expect, it } from 'vitest';
import { quiet } from '../github/fake.ts';
import {
  AGENTS,
  database,
  event,
  events,
  failures,
  line,
  martin,
  stage,
  ticket,
  types,
  withLineStore,
} from '../line/harness.ts';

withLineStore();

describe('the line, stopped', () => {
  it('ignores an answer or a stop that says it is Martin’s from any other role, and logs each once', async () => {
    const workItem = await ticket();
    const warned: string[] = [];
    const log = { ...quiet, warn: (_details: object, message: string) => void warned.push(message) } as never;
    const { pass, steps, github } = line(AGENTS, events, { log });
    await pass(); // the issue, and the planner
    await pass(); // the coder
    github.pass();
    await pass(); // the gates pass, and the reviewer
    await pass(); // the describer
    await pass(); // the hold for Martin
    const before = await types(workItem);
    // Were row security on the events ever to fail, the line's own role could append them: it still heeds neither.
    await database.owner`alter table events disable row level security`;
    try {
      await events.append([
        event(workItem, 'hold.answered', { decision: 'answered', answer: 'Name the test' }, 'martin'),
        event(null, 'line.stopped', { reason: 'Martin stopped the line' }, 'martin'),
      ]);
    } finally {
      await database.owner`alter table events enable row level security`;
    }
    await pass();
    await pass();
    expect((await types(workItem)).slice(before.length)).toEqual(['hold.answered']);
    expect(await stage(workItem)).toBe('held');
    expect(steps.requests.at(-1)).toMatchObject({ agent: 'describer' });
    expect(await lineStopped(database.as.line)).toBe(false);
    expect(warned.filter((message) => message.startsWith('ignored'))).toEqual([
      "ignored hold.answered: factory_line appended it, and it is not one of Martin's roles",
      "ignored line.stopped: factory_line appended it, and it is not one of Martin's roles",
    ]);
  });

  it('stops the step in hand when the line stops, records nothing of it, and runs it afresh when it starts', async () => {
    const workItem = await ticket();
    let stopped = false;
    const {
      line: it,
      steps,
      pass,
    } = line({ ...AGENTS, planner: () => (stopped ? (AGENTS.planner?.({} as never) ?? 'fails') : 'works on') });
    await it.tick();
    while (steps.working === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    await martin.append(event(null, 'line.stopped', { reason: 'Martin stopped the line' }, 'martin'));
    await it.tick();
    await it.idle();
    expect(steps.working).toBe(0);
    expect(await types(workItem)).toEqual(['work-item.opened', 'ticket.opened']);
    await pass(); // stopped: nothing starts
    expect(steps.requests).toHaveLength(1);

    stopped = true;
    await martin.append(event(null, 'line.started', { autonomy: 'supervised' }, 'martin'));
    await pass();
    expect(steps.requests.map((r) => r.attempt)).toEqual([1, 2]);
    expect(await types(workItem)).toContain('spec.written');
  });

  it('starts no step that was still preparing when the line stopped, and counts nothing against it', async () => {
    const workItem = await ticket();
    const { line: it, pass, steps, github } = line();
    await pass(); // the issue, and the planner
    // The coder's step reads main's head as it prepares, and GitHub is slow.
    const slow = Promise.withResolvers<void>();
    github.holdReads = slow.promise;
    await it.tick();
    await martin.append(event(null, 'line.stopped', { reason: 'Martin stopped the line' }, 'martin'));
    await it.tick();
    github.holdReads = undefined;
    slow.resolve();
    await it.idle();
    expect(steps.requests.map((r) => r.agent)).toEqual(['planner']);
    expect(await failures(workItem)).toEqual({ failures: 0, failure: null });
    await martin.append(event(null, 'line.started', { autonomy: 'supervised' }, 'martin'));
    await pass();
    expect(steps.requests.map((r) => r.agent)).toEqual(['planner', 'coder']);
  });
});
