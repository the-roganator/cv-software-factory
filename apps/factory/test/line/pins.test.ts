import { nextWorkItem } from '@software-factory/store';
import { describe, expect, it } from 'vitest';
import { MOVED_UNCHANGED } from '../../src/line/agents/coder.ts';
import { CODED, database, event, events, handback, line, PATCH, payloads, SPEC, withLineStore } from './harness.ts';

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

/** A spec for the move, its criterion quoting the ticket's title, as a planner's must. */
const planner = () =>
  handback({ verdict: 'spec', spec: { ...SPEC, criteria: [{ ...SPEC.criteria[0], quote: 'Move vitest, in npm' }] } });

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

  it('pushes the pins alone when the coder needs to change nothing more, and sends back an unchanged one', async () => {
    await moveTicket();
    const { pass, github } = line({
      planner,
      coder: () => ({ kind: 'handed-back', handback: handback(CODED), pins: PINS }),
    });
    await pass();
    await pass();
    expect(github.acts.find((a) => a.action === 'applyPatch')?.args).toMatchObject({ patch: '', pins: PINS });

    const workItem = await moveTicket();
    const { pass: again } = line({
      planner,
      coder: () => ({
        kind: 'handed-back',
        handback: handback({ unchanged: 'The move needs nothing more.' }),
        pins: PINS,
      }),
    });
    const { failures, justOne } = await import('./harness.ts');
    // This one alone, past the others' work in hand.
    await justOne(workItem);
    await again();
    await again();
    expect((await failures(workItem))?.failure).toBe(MOVED_UNCHANGED);
  });
});
