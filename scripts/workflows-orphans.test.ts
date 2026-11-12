import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/*
 * A run on the merge queue's commit stops once the queue lets its entry go (scripts/queue-branch-gone.sh): each job that
 * runs past a couple of minutes starts the watch first thing after its checkout, from the queue's event, with no token.
 */

type Step = { name?: string; uses?: string; if?: string; run?: string; env?: Record<string, string>; with?: unknown };
type Job = { 'runs-on': string; container?: unknown; permissions?: Record<string, string>; steps: Step[] };
type Workflow = { jobs: Record<string, Job> };

const read = (file: string) => parse(readFileSync(`.github/workflows/${file}`, 'utf-8')) as Workflow;
const expression = (inside: string) => `\${{ ${inside} }}`;

const WATCH = 'Stop if the merge queue lets this entry go';
const ENV = {
  QUEUE_BRANCH: expression('github.event.merge_group.head_ref'),
  QUEUE_SHA: expression('github.event.merge_group.head_sha'),
  BASE_REF: expression('github.event.merge_group.base_ref'),
};

/** The jobs that run past about two minutes, by workflow. */
const LONG = { 'check.yml': ['console-browser', 'senses-browser', 'image', 'check'], 'platform.yml': ['platform'] };

describe('runs the merge queue let go', () => {
  for (const [file, jobs] of Object.entries(LONG)) {
    for (const name of jobs) {
      it(`${file}'s ${name} watches the queue's branch from its start`, () => {
        const steps = read(file).jobs[name]?.steps ?? [];
        const at = steps.findIndex((step) => step.name === WATCH);
        expect(at, 'the watch').toBeGreaterThan(0);
        const watch = steps[at] as Step;
        expect(watch.run).toBe('scripts/queue-branch-gone.sh watch');
        // The queue's event alone, and nothing that could carry a token to git.
        expect(watch.env).toEqual(ENV);
        // Right after the checkout that holds the script, and before anything that takes time.
        expect(steps[at - 1]?.uses).toMatch(/^actions\/checkout@/);
        expect(steps.slice(0, at - 1).filter((step) => !step.name?.startsWith('Refuse'))).toEqual([]);
        expect(steps[at - 1]?.with).toMatchObject({ 'persist-credentials': false });
      });
    }
  }

  it("check's own job watches only where it waits: a release or a deploy in the queue, on the entry ahead", () => {
    const steps = read('check.yml').jobs.check?.steps ?? [];
    const only = expression(
      `github.event_name == 'merge_group' && needs.kind.result == 'success' && contains(fromJSON('["release", "deploy"]'), needs.kind.outputs.kind)`,
    );
    expect(steps.slice(0, 2).map((step) => step.if)).toEqual([only, only]);
    expect(steps[0]?.with).toMatchObject({ 'sparse-checkout': 'scripts/queue-branch-gone.sh' });
    // A checkout needs the contents' read, which the job's own `actions: read` would otherwise leave out.
    expect(read('check.yml').jobs.check?.permissions).toEqual({ actions: 'read', contents: 'read' });
  });

  it("platform's cluster blames nothing on the cluster when the watch stopped it", () => {
    const make = read('platform.yml').jobs.platform?.steps.find((step) => step.name === 'Make the cluster')?.run ?? '';
    const stopped = make.indexOf('[ ! -e "$RUNNER_TEMP/queue-gone" ] || exit 1');
    expect(stopped).toBeGreaterThan(0);
    expect(stopped).toBeLessThan(make.indexOf('::error::The cluster did not come up'));
  });

  it("platform's leftover report says only that the entry was let go", () => {
    const steps = read('platform.yml').jobs.platform?.steps ?? [];
    const shows = steps.find((step) => step.name === 'What the cluster shows');
    expect(shows?.run).toMatch(/^.*\n\s*if \[ -e "\$RUNNER_TEMP\/queue-gone" \]; then .*; exit 0; fi\n/);
  });

  it('checks no scanner pin under .github/images/, where nothing reads one', () => {
    expect(readFileSync('.github/workflows/check.yml', 'utf-8')).not.toContain('.github/images');
  });
});
