/**
 * Guardrail 9's proofs as the proofs' role reads the store (guardrails/line.ts): the last real rollback, the last
 * canary a stop aborted, and the stop-the-line drill; and a proof recorded as that role (commands/guardrails.ts).
 */
import { VERSIONS } from '@software-factory/events';
import { DiskArtifacts, EventWriter } from '@software-factory/store';
import type { Sql } from 'postgres';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Database, freshDatabase } from '../../../../packages/store/test/database.ts';
import { RED_TEAM_LABEL } from '../../../../policy/attacks.ts';
import { proved } from '../../src/guardrails/command.ts';
import {
  abortedByStop,
  age,
  type Drill,
  type ListedPod,
  rollback,
  runnerPodsOf,
  stopTheLine,
} from '../../src/guardrails/line.ts';

/** A runner's agent pod as kubectl lists it, in a phase. */
const running = (name: string, phase = 'Running'): ListedPod => ({
  metadata: { name, labels: { 'factory.mrogan.dev/runner': 'agent' } },
  status: { phase },
});

let database: Database;
beforeEach(async () => {
  database = await freshDatabase('guardrail_proofs');
});
afterEach(() => database?.end());

/** Appends an event straight to the store as `sql`'s role, unchecked, its public view the whole of it. */
async function append(sql: Sql, type: string, payload: object): Promise<void> {
  const version = (VERSIONS as Record<string, number>)[type] ?? 1;
  await sql`
    insert into events (id, ts, work_item, type, version, actor, summary, payload, artifacts, public, sample)
    values (${crypto.randomUUID()}, now(), null, ${type}, ${version}, 'martin', ${type},
            ${sql.json(payload as never)}, '[]', ${sql.json({ summary: type, payload, artifacts: [] } as never)}, false)`;
}

/** When the store stamped the newest event of a type the line's role appended that `where` picks, as the proofs read it. */
async function stampOfLast(type: string, where: string): Promise<Date> {
  const [row] = await database.owner<{ appended_at: Date }[]>`
    select appended_at from events
    where type = ${type} and appended_by = 'factory_line' and ${database.owner.unsafe(where)}
    order by seq desc limit 1`;
  if (!row) throw new Error(`No ${type} was appended.`);
  return row.appended_at;
}

const rolledBack = (dryRun: boolean, reason: string) => ({
  release: 'r-1',
  version: '1.2.0',
  restored: '1.1.0',
  weight: 20,
  reason,
  failed: [{ name: 'errors', phase: 'Failed', value: 0.2, limit: 0.05 }],
  dryRun,
  by: 'analysis',
});
const aborted = (by: string) => ({
  release: 'r-2',
  version: '1.3.0',
  restored: '1.2.0',
  abortedAt: '2026-10-30T10:00:00Z',
  by,
});

describe('how long ago', () => {
  const now = new Date('2026-11-03T12:00:00Z');
  const before = (minutes: number) => new Date(now.getTime() - minutes * 60_000);

  it('counts minutes below two hours, hours below two days, and days after', () => {
    expect(age(before(119), now)).toBe('119 minutes ago');
    expect(age(before(120), now)).toBe('2 hours ago');
    expect(age(before(47 * 60 + 59), now)).toBe('47 hours ago');
    expect(age(before(48 * 60), now)).toBe('2 days ago');
  });

  it('takes whole minutes, so a millisecond short of two hours is still minutes', () => {
    expect(age(new Date(before(120).getTime() + 1), now)).toBe('119 minutes ago');
  });

  it('reads a time ahead of now as no time ago', () => {
    expect(age(before(-5), now)).toBe('0 minutes ago');
  });
});

describe('the rollback proof', () => {
  it('reads the last real rollback the line recorded, its verdict verbatim, and how long ago', async () => {
    expect((await rollback(database.proofs, new Date())).held).toBe(false);
    await append(database.as.line, 'release.rolled-back', rolledBack(false, 'errors 20% over 5%'));
    await append(database.as.line, 'release.rolled-back', rolledBack(true, 'a dry run'));
    // Three hours after the store stamped it, by the store's clock: the Mac's may be ahead of or behind the clock of
    // the VM Postgres runs in, and a millisecond behind would read 179 minutes, "2 hours ago".
    const real = await stampOfLast('release.rolled-back', `payload->>'dryRun' = 'false'`);
    const taken = await rollback(database.proofs, new Date(real.getTime() + 3 * 3_600_000));
    expect(taken.held).toBe(true);
    expect(taken.output).toMatch(
      /version 1\.2\.0 rolled back to 1\.1\.0 at 20% of the traffic, by analysis, 3 hours ago/,
    );
    expect(taken.output).toMatch(/The analysis: errors 20% over 5%/);
    expect(taken.output).not.toMatch(/a dry run/);
  });

  it('trusts the line’s role alone, which alone may append one', async () => {
    await database.owner`
      insert into events (id, ts, work_item, type, version, actor, summary, payload, artifacts, public, sample)
      values (${crypto.randomUUID()}, now(), null, 'release.rolled-back', ${VERSIONS['release.rolled-back']}, 'martin',
              'x', ${database.owner.json(rolledBack(false, 'forged') as never)}, '[]', '{}', false)`;
    expect((await rollback(database.proofs, new Date())).held).toBe(false);
  });
});

describe('the last canary a stop aborted', () => {
  it('is the line’s record of an abort by Stop the line, and none is a proof that does not hold', async () => {
    await append(database.as.line, 'release.aborted', aborted('martin'));
    expect((await abortedByStop(database.proofs, new Date())).held).toBe(false);
    await append(database.as.line, 'release.aborted', aborted('stop'));
    // Two days after the store stamped it, by the store's clock, as in the rollback proof.
    const stamped = await stampOfLast('release.aborted', `payload->>'by' = 'stop'`);
    const taken = await abortedByStop(database.proofs, new Date(stamped.getTime() + 48 * 3_600_000));
    expect(taken).toMatchObject({ held: true });
    expect(taken.output).toMatch(/aborted by Stop the line at 2026-10-30T10:00:00Z, back to 1\.2\.0, 2 days ago\./);
  });
});

describe('the runner pods the drill waits on', () => {
  it('are the line’s, with their part, and never a pod the red-team harness made, which Stop the line does not end', () => {
    expect(
      runnerPodsOf([
        { metadata: { name: 'coder-1-1-1-agent', labels: { 'factory.mrogan.dev/runner': 'agent' } } },
        { metadata: { name: 'coder-1-1-1-prepare', labels: { 'factory.mrogan.dev/runner': 'prepare' } } },
        { metadata: { name: 'unlabelled' } },
        {
          metadata: {
            name: 'red-team-egress-1a2b3c4d',
            labels: { 'factory.mrogan.dev/runner': 'agent', [RED_TEAM_LABEL]: 'egress' },
          },
        },
      ]),
    ).toEqual({
      pods: [
        { name: 'coder-1-1-1-agent', part: 'agent' },
        { name: 'coder-1-1-1-prepare', part: 'prepare' },
        { name: 'unlabelled' },
      ],
      finished: 0,
    });
  });

  it('are those pending or running, and count apart the finished ones a Job keeps for its hour', () => {
    const pod = (name: string, phase?: string, labels: Record<string, string> = {}) => ({
      metadata: { name, labels: { 'factory.mrogan.dev/runner': 'agent', ...labels } },
      ...(phase && { status: { phase } }),
    });
    expect(
      runnerPodsOf([
        pod('done-agent', 'Succeeded'),
        pod('crashed-agent', 'Failed'),
        pod('starting-agent', 'Pending'),
        pod('working-agent', 'Running'),
        pod('new-agent'),
        pod('lost-agent', 'Unknown'),
        // A finished red-team pod is the harness's, and not counted among the line's finished ones either.
        pod('red-team-egress-1a2b3c4d', 'Succeeded', { [RED_TEAM_LABEL]: 'egress' }),
      ]),
    ).toEqual({
      pods: [
        { name: 'starting-agent', part: 'agent' },
        { name: 'working-agent', part: 'agent' },
        { name: 'new-agent', part: 'agent' },
        { name: 'lost-agent', part: 'agent' },
      ],
      finished: 2,
    });
  });
});

describe('the stop-the-line drill', () => {
  // A running line, as Martin left it: only that is drilled.
  beforeEach(() => append(database.operator, 'line.started', {}));

  /** A drill against the test's store: `make` appends Martin's stop and start; the rest is as each test says. */
  function drill(o: { yes?: boolean; pods?: ListedPod[][]; take?: boolean }) {
    let clock = Date.now();
    const pods = [...(o.pods ?? [[running('w-agent')], []])];
    const made: string[] = [];
    const said: string[] = [];
    const d: Drill = {
      sql: database.proofs,
      // Listed as kubectl lists them, and read as command.ts reads them.
      runnerPods: async () => runnerPodsOf(pods.length > 1 ? (pods.shift() ?? []) : (pods[0] ?? [])),
      ask: async () => o.yes ?? true,
      make: async (target, reason) => {
        made.push(target);
        if (target === 'stop-the-line') {
          await append(database.operator, 'line.stopped', { reason });
          if (o.take) await database.owner`insert into line (work_item, stage, issue) values ('1001', 'plan', 41)`;
        } else await append(database.operator, 'line.started', {});
        return true;
      },
      now: () => new Date(clock),
      sleep: async (ms) => {
        clock += ms;
      },
      say: (line) => said.push(line),
    };
    return { d, made, said };
  }

  it('stops the line, sees it stopped, its pods gone and nothing taken, and starts it again', async () => {
    await append(database.as.line, 'release.aborted', aborted('stop'));
    const { d, made, said } = drill({});
    const taken = await stopTheLine(d);
    expect(made).toEqual(['stop-the-line', 'start-the-line']);
    expect(said[0]).toMatch(/1 agent pod\(s\) and 0 other pod\(s\) of the line’s are running in runners now\./);
    expect(taken).toMatchObject({ held: true });
    const output = 'output' in taken ? taken.output : '';
    expect(output).toMatch(/✓ The line stopped at .+, recorded by factory_operator\./);
    expect(output).toMatch(
      /✓ None of the line’s pods is left in runners \(1 were running at the prompt or the stop\)\./,
    );
    expect(output).toMatch(/✓ No work item was taken/);
    expect(output).toMatch(/✓ The line started again\./);
    expect(output).toMatch(/✓ Release r-2: the canary of version 1\.3\.0 aborted by Stop the line/);
  });

  it('starts the line again before it ends when interrupted during the drill, and listens only while it runs', async () => {
    const before = process.listenerCount('SIGINT');
    const { d, made, said } = drill({});
    let exited: () => void = () => undefined;
    const exit = new Promise<void>((resolve) => {
      exited = resolve;
    });
    const spy = vi.spyOn(process, 'exit').mockImplementation(((code: number) => {
      expect(code).toBe(130);
      exited();
    }) as never);
    try {
      const make = d.make;
      d.make = async (target, reason) => {
        const ok = await make(target, reason);
        if (target === 'stop-the-line') process.emit('SIGINT', 'SIGINT');
        return ok;
      };
      await stopTheLine(d);
      await exit;
      // Started once, by the interrupt, before the process ends; the drill's own end did not start it twice.
      expect(made).toEqual(['stop-the-line', 'start-the-line']);
      expect(said).toContainEqual(
        expect.stringMatching(/Interrupted \(SIGINT\) during the drill: starting the line again/),
      );
      expect(said).toContain('The line started again.');
    } finally {
      spy.mockRestore();
    }
    expect(process.listenerCount('SIGINT')).toBe(before);
  });

  it('counts its own stop alone, not one Martin made meanwhile for another reason', async () => {
    const { d } = drill({});
    d.make = async (target) => {
      if (target === 'stop-the-line') await append(database.operator, 'line.stopped', { reason: 'by hand' });
      return true;
    };
    const taken = await stopTheLine(d);
    expect('output' in taken && taken.output).toMatch(
      /✗ no line\.stopped by Martin’s roles was recorded for this drill/,
    );
  });

  it('takes nothing, asks nothing and records nothing on a line that is not running, which it would start after', async () => {
    const fresh = await freshDatabase('guardrail_proofs_not_started');
    try {
      const { d, made, said } = drill({});
      expect(await stopTheLine({ ...d, sql: fresh.proofs })).toEqual({
        declined: expect.stringMatching(/^The line has not started: /),
      });
      await append(database.operator, 'line.stopped', { reason: 'Lunch' });
      expect(await stopTheLine(d)).toEqual({ declined: expect.stringMatching(/^The line is stopped: /) });
      expect([made, said]).toEqual([[], []]);
    } finally {
      await fresh.end();
    }
  });

  it('takes nothing, and records nothing, unless Martin says yes', async () => {
    const { d, made } = drill({ yes: false });
    expect(await stopTheLine(d)).toEqual({ declined: expect.stringMatching(/did not say yes/) });
    expect(made).toEqual([]);
  });

  it('does not hold when a pod is left, a work item was taken, or no stop aborted a canary', async () => {
    const { d, made } = drill({ pods: [[running('w-agent')]], take: true });
    const taken = await stopTheLine(d);
    expect(made).toEqual(['stop-the-line', 'start-the-line']);
    expect(taken).toMatchObject({ held: false });
    const output = 'output' in taken ? taken.output : '';
    expect(output).toMatch(/✗ the line’s pods still in runners: w-agent/);
    expect(output).toMatch(/✗ work items taken while the line was stopped: 1001/);
    expect(output).toMatch(/✗ No canary in flight has been aborted by Stop the line/);
  });

  it('waits only on the pods still running, and records the finished ones it passed over', async () => {
    await append(database.as.line, 'release.aborted', aborted('stop'));
    const done = [running('done-agent', 'Succeeded'), running('crashed-agent', 'Failed')];
    // The finished pods stay listed throughout, as their Jobs keep them; the running one goes after the stop.
    const { d, said } = drill({ pods: [[...done, running('w-agent')], [...done, running('w-agent')], done] });
    const taken = await stopTheLine(d);
    expect(said[0]).toMatch(/1 agent pod\(s\) and 0 other pod\(s\) of the line’s are running in runners now\./);
    expect(taken).toMatchObject({ held: true });
    const output = 'output' in taken ? taken.output : '';
    expect(output).toMatch(
      /✓ None of the line’s pods is left in runners \(1 were running at the prompt or the stop\)\./,
    );
    expect(output).toMatch(/2 finished pod\(s\) of the line’s in runners passed over/);
    expect(output).not.toMatch(/still in runners|started in runners/);
  });

  it('lists the runners again once stopped, so a pod started after the prompt is seen and waited for', async () => {
    await append(database.as.line, 'release.aborted', aborted('stop'));
    const { d } = drill({ pods: [[], [running('late-agent')]] });
    const taken = await stopTheLine(d);
    const output = 'output' in taken ? taken.output : '';
    expect(output).toMatch(/✗ the line’s pods still in runners: late-agent/);
  });

  it('does not hold when a pod starts in runners while the line is stopped, after the others went', async () => {
    await append(database.as.line, 'release.aborted', aborted('stop'));
    const { d } = drill({});
    const listed = d.runnerPods;
    let calls = 0;
    // At the prompt, at the stop (gone), then a step begun meanwhile.
    d.runnerPods = async () => (++calls >= 3 ? runnerPodsOf([running('new-agent')]) : listed());
    const taken = await stopTheLine(d);
    expect(taken).toMatchObject({ held: false });
    expect('output' in taken && taken.output).toMatch(
      /✗ the line’s pods started in runners while the line was stopped: new-agent/,
    );
  });

  it('holds with no agent running, and does not look for the gateway’s refusal, which CI proves', async () => {
    await append(database.as.line, 'release.aborted', aborted('stop'));
    const { d, said } = drill({ pods: [[]] });
    const taken = await stopTheLine(d);
    expect(said[0]).toMatch(/0 agent pod\(s\) and 0 other pod\(s\) of the line’s are running in runners now\.$/);
    expect(taken).toMatchObject({ held: true });
    expect('output' in taken && taken.output).toMatch(
      /✓ None of the line’s pods is in runners: none was running at the prompt or the stop/,
    );
    expect('output' in taken && taken.output).not.toMatch(/gateway/);
  });

  it('does not count a stop by a role that may not make one, even were row security to fail', async () => {
    const { d } = drill({});
    d.make = async (target, reason) => {
      // The drill's own reason, by a role that is not Martin's.
      if (target === 'stop-the-line') await append(database.as.line, 'line.stopped', { reason });
      return true;
    };
    // With row security off, the drill's own filter by role is all that keeps it from counting the line's stop.
    await database.owner`alter table events disable row level security`;
    let taken: Awaited<ReturnType<typeof stopTheLine>>;
    try {
      taken = await stopTheLine(d);
    } finally {
      await database.owner`alter table events enable row level security`;
    }
    expect('output' in taken && taken.output).toMatch(
      /✗ no line\.stopped by Martin’s roles was recorded for this drill/,
    );
  });
});

describe('a proof recorded', () => {
  it('is a guardrail.proved the proofs’ role appends, of the guardrails that list it, from the commit', async () => {
    const writer = new EventWriter(database.proofs, { kind: 'real', artifacts: new DiskArtifacts('/nonexistent') });
    const commit = 'a'.repeat(40);
    const [stored] = await writer.append(
      proved('egress', { held: false, output: 'FAIL  x', policyHash: 'b'.repeat(64) }, commit),
    );
    expect(stored).toMatchObject({
      type: 'guardrail.proved',
      summary: 'Guardrail 5: egress did not hold',
      payload: {
        guardrails: [5],
        proof: 'egress',
        mechanism: 'egress-policy',
        held: false,
        commit,
        policyHash: 'b'.repeat(64),
      },
    });
    const run = {
      url: 'https://github.com/the-roganator/cv-software-factory/actions/runs/1',
      at: '2026-10-31T10:00:00.000Z',
    };
    const [ci] = await writer.append(
      proved('ci:scope-fence', { held: true, output: 'passed', commit: 'c'.repeat(40), run }, commit),
    );
    expect(ci?.payload).toMatchObject({ guardrails: [11], mechanism: 'ci-tests', commit: 'c'.repeat(40), run });
  });
});
