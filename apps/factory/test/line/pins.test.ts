import { nextWorkItem } from '@software-factory/store';
import { describe, expect, it } from 'vitest';
import type { Moves } from '../../src/github/scanning.ts';

import { commitTitle } from '../../src/line/agents/agent.ts';
import { MOVED_UNCHANGED, MOVED_UNTESTED } from '../../src/line/agents/coder.ts';
import {
  CODED,
  database,
  event,
  events,
  failures,
  handback,
  justOne,
  line,
  PATCH,
  payloads,
  SPEC,
  stage,
  types,
  withLineStore,
} from './harness.ts';

withLineStore();

const MOVE = { name: 'vitest', ecosystem: 'npm' as const, from: '5.0.5', to: '5.1.0' };
const PINS =
  'diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml\n--- a/pnpm-lock.yaml\n+++ b/pnpm-lock.yaml\n@@ -1 +1 @@\n-  vitest@5.0.5:\n+  vitest@5.1.0:\n';
const LOCKFILE = PINS.replaceAll('vitest', 'pino');

/** A dependency's work item and its ticket, as triage opens them for a move. */
async function moveTicket(): Promise<string> {
  const workItem = await nextWorkItem(database.as.triage);
  await events.append([
    event(
      workItem,
      'work-item.opened',
      {
        kind: 'dependency-update',
        title: 'Move vitest',
        sample: false,
        category: 'dependency',
        dependency: { ...MOVE, security: false },
      },
      'triage',
    ),
    event(
      workItem,
      'ticket.opened',
      {
        title: 'Move vitest, in npm',
        category: 'dependency',
        severity: 'cosmetic',
        fingerprint: { name: 'vitest', ecosystem: 'npm' },
        traces: [],
      },
      'triage',
    ),
  ]);
  return workItem;
}

/** A spec for the move that asks for a test, its criterion quoting the ticket's title, as a planner's must. */
const planner = () =>
  handback({
    verdict: 'spec',
    spec: { ...SPEC, criteria: [{ ...SPEC.criteria[0], quote: 'Move vitest, in npm', shownBy: 'test' }] },
  });

/**
 * Work item #1036's move, as the line took it on 14 November: @grpc/grpc-js from 1.14.4 to 1.14.5, whose spec's three
 * criteria the scans and the required checks show, and none a test.
 */
const GRPC = { name: '@grpc/grpc-js', ecosystem: 'npm' as const, from: '1.14.4', to: '1.14.5' };
/** #1036's pins as the pin step wrote them: `~1.14.4` admits the floor, so pnpm took the newest in range, 1.14.7. */
const grpcPins = (version: string) =>
  [
    'diff --git a/package.json b/package.json\n--- a/package.json\n+++ b/package.json\n@@ -1 +1 @@\n',
    `-    "@grpc/grpc-js": "~1.14.4",\n+    "@grpc/grpc-js": "~${version}",\n`,
    'diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml\n--- a/pnpm-lock.yaml\n+++ b/pnpm-lock.yaml\n@@ -1,3 +1,3 @@\n',
    `       '@grpc/grpc-js':\n-        specifier: ~1.14.4\n-        version: 1.14.4\n+        specifier: ~${version}\n+        version: ${version}\n`,
  ].join('');
const GRPC_PINS = grpcPins('1.14.7');

async function grpcTicket(): Promise<string> {
  const workItem = await nextWorkItem(database.as.triage);
  await events.append([
    event(
      workItem,
      'work-item.opened',
      {
        kind: 'dependency-update',
        title: 'Move @grpc/grpc-js',
        sample: false,
        category: 'security',
        dependency: { ...GRPC, security: true },
      },
      'triage',
    ),
    event(
      workItem,
      'ticket.opened',
      {
        title: 'Move @grpc/grpc-js, in npm',
        category: 'security',
        severity: 'broken',
        fingerprint: { name: '@grpc/grpc-js', ecosystem: 'npm' },
        traces: [],
      },
      'triage',
    ),
  ]);
  return workItem;
}

/** The planner's spec for it, each criterion shown by the gates, quoting the ticket's title as these tests' must. */
const gatesOnly = () =>
  handback({
    verdict: 'spec',
    spec: {
      outcome: '@grpc/grpc-js resolves to 1.14.5, so the scans no longer report its findings.',
      criteria: [
        ['the change’s lockfile and images', 'the scan gates scan them', 'neither finding is found'],
        ['the change', 'every required check runs on it', 'each check passes with @grpc/grpc-js moved'],
      ].map(([given, when, expect]) => ({
        given,
        when,
        expect,
        from: 'the ticket',
        quote: 'Move @grpc/grpc-js, in npm',
        shownBy: 'gates',
      })),
      scope: ['test/support/flagd.ts', 'test/'],
      risks: ['dependency-change'],
      rollout: 'The line writes the pins; the scans no longer listing the findings shows it worked.',
    },
  });

describe('a dependency’s move on the line', () => {
  it('has the pin step write the move before the coder, and sends its pins and lockfile beside the coder’s patch', async () => {
    await moveTicket();
    const { pass, steps, github } = line({
      planner,
      coder: () => ({ kind: 'handed-back', handback: handback(CODED, PATCH), pins: PINS, lockfile: LOCKFILE }),
    });
    await pass(); // the planner, which the move is not given to
    await pass(); // the coder
    expect(steps.requests[0]).not.toHaveProperty('move');
    expect(steps.requests[1]).toMatchObject({
      agent: 'coder',
      move: { ecosystem: 'npm', name: 'vitest', from: '5.0.5', to: '5.1.0' },
    });
    expect(github.acts.find((a) => a.action === 'applyPatch')?.args).toMatchObject({
      patch: PATCH,
      pins: PINS,
      lockfile: LOCKFILE,
    });
  });

  it('gives the pin step the newest scan’s time and the answers its pins job sealed, and the commit says nothing of them (S2-M1)', async () => {
    await moveTicket();
    const nonroot = { image: 'gcr.io/distroless/static', tag: 'nonroot', digest: `sha256:${'5'.repeat(64)}` };
    const node = { image: 'node', tag: '24.22.2-alpine3.24', digest: `sha256:${'3'.repeat(64)}` };
    const group = (asked: (typeof node)[]) => ({
      files: ['Dockerfile'],
      major: false,
      moves: [1],
      refused: [],
      changed: [],
      steps: [],
      asked,
    });
    const { pass, steps, github } = line({
      planner,
      coder: () => ({ kind: 'handed-back', handback: handback(CODED, PATCH), pins: PINS }),
    });
    // The run the gate reads too: its time, and each tag once, the first group's answer where two asked it.
    github.moves = {
      repository: 'the-roganator/cv-worlds-worst-website',
      run: { id: 42, event: 'schedule', conclusion: 'success', headSha: 'c'.repeat(40), updatedAt: '', url: '' },
      file: { judged: '2026-11-20T05:00:00Z' } as Moves['file'],
      moves: [],
      made: {
        version: 1,
        repository: 'the-roganator/cv-worlds-worst-website',
        run: '42',
        commit: 'c'.repeat(40),
        groups: [group([nonroot]), group([{ ...nonroot, digest: `sha256:${'6'.repeat(64)}` }, node])],
      },
    };
    await pass();
    await pass();
    expect(steps.requests[1]).toMatchObject({
      move: MOVE,
      made: { at: '2026-11-20T05:00:00Z', asked: [nonroot, node] },
    });
    const { message } = (github.acts.find((a) => a.action === 'applyPatch')?.args ?? { message: '' }) as {
      message: string;
    };
    expect(message).not.toMatch(/Pins-/);
  });

  it('makes the move as of now where the scan’s moves cannot be read (S2-M1)', async () => {
    await moveTicket();
    const { pass, steps } = line({
      planner,
      coder: () => ({ kind: 'handed-back', handback: handback(CODED, PATCH), pins: PINS }),
    });
    await pass();
    await pass();
    expect(steps.requests[1]).toMatchObject({ move: MOVE });
    expect(steps.requests[1]).not.toHaveProperty('made');
  });

  it('holds the work item for Martin when the pins need his file, telling him which and why, and pushes nothing', async () => {
    const workItem = await moveTicket();
    const reason =
      'vitest stays at 5.0.5: @invented/runner@1.0.0 admit no 5.1.0, so it needs an override in pnpm-workspace.yaml';
    const { pass, github } = line({
      planner,
      coder: () => ({ kind: 'held', path: 'pnpm-workspace.yaml', reason }),
    });
    // The app's CODEOWNERS gives Martin pnpm-workspace.yaml, so no scope may name it.
    github.protectedPaths = [...github.protectedPaths, 'pnpm-workspace.yaml'];
    await pass();
    await pass();
    expect(await payloads(workItem, 'hold.started')).toEqual([
      expect.objectContaining({
        stage: 'build',
        cause: 'scope',
        reason,
        needs: [{ path: 'pnpm-workspace.yaml', reason, barred: true }],
      }),
    ]);
    expect(github.acts.some((a) => a.action === 'applyPatch')).toBe(false);
  });

  it('names no move to a step of any other work item', async () => {
    const { ticket } = await import('./harness.ts');
    await ticket();
    const { pass, steps } = line({ planner, coder: () => handback(CODED, PATCH) });
    await pass();
    await pass();
    expect(steps.requests.some((r) => 'move' in r)).toBe(false);
  });

  it('refuses a coder’s own title for no change on a move whose criterion asks for a test, and an unchanged one', async () => {
    const { failures, justOne } = await import('./harness.ts');
    const titled = await moveTicket();
    const { pass, github } = line({
      planner,
      coder: () => ({ kind: 'handed-back', handback: handback(CODED), pins: PINS }),
    });
    await justOne(titled);
    await pass();
    await pass();
    expect(github.acts.some((a) => a.action === 'applyPatch')).toBe(false);
    expect((await failures(titled))?.failure).toBe(MOVED_UNTESTED);

    const workItem = await moveTicket();
    const { pass: again } = line({
      planner,
      coder: () => ({
        kind: 'handed-back',
        handback: handback({ unchanged: 'The move needs nothing more.' }),
        pins: PINS,
      }),
    });
    // This one alone, past the others' work in hand.
    await justOne(workItem);
    await again();
    await again();
    expect((await failures(workItem))?.failure).toBe(MOVED_UNCHANGED);
  });

  it('makes the commit of a move whose criteria the gates show from its pins alone, with no coder and no model call', async () => {
    const workItem = await grpcTicket();
    // The coder's fake would hand back a change: none is asked for, since no agent runs.
    const { pass, steps, github } = line({
      planner: gatesOnly,
      coder: () => ({ kind: 'handed-back', handback: handback(CODED, PATCH), pins: GRPC_PINS }),
    });
    await pass(); // the issue, and the planner
    await pass(); // Build: the pin step alone
    expect(steps.requests[1]).toMatchObject({ agent: 'coder', move: GRPC, pinsOnly: true });
    const applied = github.acts.filter((a) => a.action === 'applyPatch');
    expect(applied).toHaveLength(1);
    expect(applied[0]?.args).toMatchObject({ patch: '', pins: GRPC_PINS });
    const { message } = (applied[0]?.args ?? { message: '' }) as { message: string };
    const [title, , note] = message.split('\n');
    expect(title).toBe('fix(deps): move @grpc/grpc-js to 1.14.7');
    expect(commitTitle.safeParse(title).success).toBe(true);
    expect(note).toContain(
      'from 1.14.4 to 1.14.7, the newest release its range admits at or above 1.14.5, in package.json, pnpm-lock.yaml.',
    );
    expect(note).not.toMatch(/CVE|GHSA/);
    expect(await payloads(workItem, 'pull-request.pushed')).toEqual([
      expect.objectContaining({ title: 'fix(deps): move @grpc/grpc-js to 1.14.7', testsFirst: false }),
    ]);
    const [pushed] = await database.as.line<{ actor: string }[]>`
      select actor from events where work_item = ${workItem} and type = 'pull-request.pushed'`;
    expect(pushed?.actor).toBe('factory');
    // No model was called for Build: the planner's call is the only one recorded.
    expect((await types(workItem)).filter((t) => t === 'model.called')).toHaveLength(1);
    expect(await payloads(workItem, 'hold.started')).toEqual([]);
  });

  it('closes a move main already has as done, not failed, with no coder, and its issue as completed', async () => {
    // The second of two moves that overlap, once the first merged: Node's move brought the runtime image's.
    for (const [opened, spec] of [
      [grpcTicket, gatesOnly],
      [moveTicket, planner],
    ] as const) {
      const workItem = await opened();
      const { pass, github } = line({ planner: spec, coder: () => ({ kind: 'pinned', pins: '' }) });
      await justOne(workItem);
      await pass(); // the issue, and the planner
      await pass(); // Build: the pin step writes nothing
      expect(github.acts.some((a) => a.action === 'applyPatch')).toBe(false);
      expect((await failures(workItem))?.failures ?? 0).toBe(0);
      expect(await payloads(workItem, 'hold.started')).toEqual([]);
      const [closed] = await payloads(workItem, 'work-item.closed');
      expect(closed).toEqual({
        outcome: 'no-change',
        reason: expect.stringMatching(/^Main already has its move, at /),
      });
      const closing = github.acts.filter((a) => a.action === 'closeIssue');
      expect(closing).toEqual([
        {
          action: 'closeIssue',
          args: expect.objectContaining({
            reason: 'completed',
            comment: expect.stringMatching(/^Main already has this move, at [0-9a-f]{7}: .+ Another change made it\./),
          }),
        },
      ]);
      await pass();
      expect(await stage(workItem)).toBe('ended');
      github.acts.length = 0;
    }
  });

  it('runs the coder on a move whose gates fail, told what failed', async () => {
    const workItem = await grpcTicket();
    const { pass, steps, github } = line({
      planner: gatesOnly,
      coder: () => ({ kind: 'handed-back', handback: handback(CODED, PATCH), pins: GRPC_PINS }),
    });
    await pass(); // the issue, and the planner
    await pass(); // Build: the pin step alone
    github.pass(12, 'failure');
    await pass(); // the gates fail, and the work comes back to Build
    expect((await payloads(workItem, 'work.returned'))[0]).toMatchObject({ from: 'gates', to: 'build', round: 2 });
    await pass(); // the coder, on the pull request's head, which has the move
    const last = steps.requests.at(-1);
    expect(last).toMatchObject({ agent: 'coder', round: 2 });
    expect(last).not.toHaveProperty('pinsOnly');
    expect(last).not.toHaveProperty('move');
    expect(last?.prompt).toMatch(/came back from gates/);
  });

  it('takes {"moved": true} from a coder on a version 5 spec’s move, titling and noting it the line’s way', async () => {
    const workItem = await moveTicket();
    // A spec written before criteria said what shows them, as one in the store may be: no criterion asks for a test.
    await events.append([
      event(
        workItem,
        'spec.written',
        {
          ...SPEC,
          criteria: [{ given: 'the move', when: 'the gates run', expect: 'each passes', from: 'the ticket' }],
        },
        'planner',
      ),
    ]);
    const { pass, github, steps } = line({
      planner,
      coder: () => ({ kind: 'handed-back', handback: handback({ moved: true }), pins: PINS }),
    });
    await pass();
    await pass();
    expect(steps.requests.find((r) => r.agent === 'coder')).not.toHaveProperty('pinsOnly');
    const applied = github.acts.find((a) => a.action === 'applyPatch')?.args as { patch: string; message: string };
    expect(applied).toMatchObject({ patch: '', pins: PINS });
    expect(applied.message).toMatch(/^fix\(deps\): move vitest to 5\.1\.0\n\nThe pin step moved vitest/);
    expect(applied.message).toContain('The coder found nothing more the criteria need of it');
  });

  it('refuses {"moved": true} from a coder whose spec asks for a test', async () => {
    const workItem = await moveTicket();
    const { pass, github } = line({
      planner,
      coder: () => ({ kind: 'handed-back', handback: handback({ moved: true }), pins: PINS }),
    });
    await pass();
    await pass();
    expect(github.acts.some((a) => a.action === 'applyPatch')).toBe(false);
    const { failures } = await import('./harness.ts');
    expect((await failures(workItem))?.failure).toMatch(/does not fit its schema/);
  });

  it('fails the step, saying why, when the pins resolve the package below the move’s floor, and titles no guess', async () => {
    const workItem = await grpcTicket();
    const { pass, github } = line({
      planner: gatesOnly,
      coder: () => ({ kind: 'handed-back', handback: handback(CODED, PATCH), pins: grpcPins('1.14.4') }),
    });
    await pass();
    await pass();
    expect(github.acts.some((a) => a.action === 'applyPatch')).toBe(false);
    const { failures } = await import('./harness.ts');
    expect((await failures(workItem))?.failure).toBe(
      'The pin step’s patch resolves @grpc/grpc-js to 1.14.4, below the move’s 1.14.5',
    );
  });
});
