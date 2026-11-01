/**
 * The line on a store of its own, as line.test.ts and the proofs in proofs/ run it: a ticket as triage opens one,
 * agents that hand back as the tests say, and fakes of GitHub and the runners.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type NewEvent, type PayloadOf, VERSIONS } from '@software-factory/events';
import { DiskArtifacts, EventWriter, nextWorkItem } from '@software-factory/store';
import { afterEach, beforeEach } from 'vitest';
import { type Database, freshDatabase } from '../../../../packages/store/test/database.ts';
import type { Handback } from '../../../runner/src/step.ts';
import { Line, type LineOptions } from '../../src/line/worker.ts';
import { quiet } from '../github/fake.ts';
import { type Agent, FakeGitHub, FakeSteps } from './fakes.ts';

export let database: Database;
export let events: EventWriter;
/** Martin's commands, from the admin service's role: only his roles may append them. */
export let martin: EventWriter;

/** A store of its own for each of a file's tests, gone after it. */
export function withLineStore() {
  beforeEach(async () => {
    database = await freshDatabase('line');
    events = new EventWriter(database.as.line, {
      kind: 'real',
      artifacts: new DiskArtifacts(mkdtempSync(join(tmpdir(), 'artifacts-'))),
    });
    martin = new EventWriter(database.admin, {
      kind: 'real',
      artifacts: new DiskArtifacts(mkdtempSync(join(tmpdir(), 'artifacts-'))),
    });
  });
  afterEach(() => database?.end());
}

export const event = <K extends NewEvent['type']>(
  workItem: string | null,
  type: K,
  payload: PayloadOf<K>,
  actor: NewEvent['actor'] = 'factory',
): NewEvent =>
  ({
    id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    work_item: workItem,
    type,
    version: VERSIONS[type],
    actor,
    summary: `${type} for the test`,
    payload,
    artifacts: [],
  }) as NewEvent;

/** A ticket as triage opens one, with its severity. */
export async function ticket(
  severity: PayloadOf<'ticket.opened'>['severity'] = 'broken',
  route = '/search',
): Promise<string> {
  const workItem = await nextWorkItem(database.as.triage);
  await events.append([
    event(workItem, 'work-item.opened', { kind: 'defect-fix', title: 'Server errors', sample: false }, 'triage'),
    event(
      workItem,
      'ticket.opened',
      {
        title: `Server errors on ${route}`,
        category: 'errors',
        severity,
        fingerprint: { route, class: 'server-error' },
        traces: [],
      },
      'triage',
    ),
  ]);
  return workItem;
}

export const handback = (result: unknown, patch = ''): Handback => ({
  ending: 'finished',
  patch,
  note: 'Escaped the query before it reaches the database.',
  turns: 6,
  session: 'session-1',
  result,
});

export const PATCH = `diff --git a/src/search.ts b/src/search.ts
--- a/src/search.ts
+++ b/src/search.ts
@@ -1 +1 @@
-old
+new
diff --git a/test/search.test.ts b/test/search.test.ts
new file mode 100644
--- /dev/null
+++ b/test/search.test.ts
@@ -0,0 +1,2 @@
+it('finds a quote', () => {});
+expect(1).toBe(1);
`;

export const SPEC = {
  outcome: 'Search answers a query with a quote in it.',
  criteria: [
    {
      given: 'a query with a quote',
      when: 'it is searched',
      expect: 'the page lists matches',
      from: 'the ticket',
      quote: 'Server errors',
    },
  ],
  scope: ['src/search.ts', 'test/'],
  risks: [],
  rollout: 'Ships as it is.',
};

export const CODED = {
  title: 'fix(search): escape the query',
  note: 'Search passed the query to the database as it was. A test searches for a quote; the query is escaped now.',
};

export const AGENTS: Record<string, Agent> = {
  planner: () => handback({ verdict: 'spec', spec: SPEC }),
  coder: () => handback(CODED, PATCH),
  reviewer: () => handback({ verdict: 'approved', note: 'It does what the spec says.', findings: [] }),
  describer: () =>
    handback({
      title: 'fix(search): escape the query',
      body: 'Search escaped nothing, so a quote broke the query.',
      summary: { title: 'Search with a quote', description: 'Fixed.', story: 'The factory fixed search.' },
    }),
};

/** The time as the line sees it, which a test can move on. */
export const clock = { now: Date.parse('2026-10-06T09:00:00Z') };

export function line(
  agents: Partial<Record<string, Agent>> = AGENTS,
  store: Pick<EventWriter, 'append'> = events,
  options: Partial<LineOptions> = {},
) {
  const steps = new FakeSteps(database.as.gateway, agents);
  const github = new FakeGitHub();
  const it = new Line({
    sql: database.as.line,
    events: store,
    steps,
    github,
    log: quiet,
    gatesEveryMs: 0,
    me: 'test',
    now: () => new Date(clock.now),
    ...options,
  });
  /** A pass of the line, and whatever steps it started, to their end. */
  const pass = async () => {
    await it.tick();
    await it.idle();
  };
  return { line: it, steps, github, pass };
}

export async function types(workItem: string): Promise<string[]> {
  const rows = await database.as.line<{ type: string }[]>`
    select type from events where work_item = ${workItem} order by seq`;
  return rows.map((r) => r.type);
}

export async function payloads<K extends NewEvent['type']>(workItem: string, type: K): Promise<PayloadOf<K>[]> {
  const rows = await database.as.line<{ payload: PayloadOf<K> }[]>`
    select payload from events where work_item = ${workItem} and type = ${type} order by seq`;
  return rows.map((r) => r.payload);
}

export async function summaries(workItem: string, type: NewEvent['type']): Promise<string[]> {
  const rows = await database.as.line<{ summary: string }[]>`
    select summary from events where work_item = ${workItem} and type = ${type} order by seq`;
  return rows.map((r) => r.summary);
}

export const stage = async (workItem: string) =>
  (await database.as.line<{ stage: string }[]>`select stage from line where work_item = ${workItem}`)[0]?.stage;

export async function failures(workItem: string) {
  const [row] = await database.as.line<{ failures: number; failure: string | null }[]>`
    select failures, failure from line where work_item = ${workItem}`;
  return row;
}
