import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/*
 * platform.yml in the merge queue makes no cluster when one made from the same inputs passed at the pull request's head
 * (scripts/check-kind.sh, whose tests try each case). Here, what the workflow gives it: the reads it needs and nothing
 * more, the switch that turns it off, and a cluster on anything but the two words that skip one.
 */

type Step = { name?: string; id?: string; run?: string; env?: Record<string, string>; with?: Record<string, unknown> };
type Job = { if?: string; permissions?: Record<string, string>; steps?: Step[]; outputs?: Record<string, string> };
const workflow = parse(readFileSync('.github/workflows/platform.yml', 'utf-8')) as { jobs: Record<string, Job> };
const { which, platform } = workflow.jobs;
const expression = (inside: string) => `\${{ ${inside} }}`;

/** Whether the platform job's condition runs it, for the deciding job's result and output, read as Actions would. */
function runs(result: string, said: string) {
  const condition = (platform?.if ?? '').replace(/^\$\{\{ | \}\}$/g, '');
  const js = condition
    .replace(/!cancelled\(\)/, 'true')
    .replace(/needs\.which\.result/g, JSON.stringify(result))
    .replace(/needs\.which\.outputs\.platform/g, JSON.stringify(said))
    .replace(/'([^']*)'/g, (_, s: string) => JSON.stringify(s));
  // The condition holds only these words, ==, !=, &&, || and brackets: nothing else is evaluated.
  expect(js).toMatch(/^[\s"A-Za-z()!=&|]+$/);
  return new Function(`return ${js};`)() as boolean;
}

describe('the queue’s cluster, made once already', () => {
  it('skips the cluster on `none` or `matched` from a deciding job that succeeded, and makes it otherwise', () => {
    expect(runs('success', 'none')).toBe(false);
    expect(runs('success', 'matched')).toBe(false);
    expect(runs('success', 'cluster')).toBe(true);
    expect(runs('success', '')).toBe(true);
    expect(runs('success', 'Matched')).toBe(true);
    for (const result of ['failure', 'cancelled', 'skipped']) {
      expect(runs(result, 'matched'), result).toBe(true);
      expect(runs(result, 'none'), result).toBe(true);
    }
  });

  it('gives the deciding job reads alone, the switch from a repository variable, and no secret', () => {
    expect(which?.permissions).toEqual({ actions: 'read', checks: 'read', contents: 'read', 'pull-requests': 'read' });
    const decide = (which?.steps ?? []).find((step) => step.id === 'which');
    expect(decide?.run).toContain('platform=$(scripts/check-kind.sh platform)');
    expect(decide?.env?.PLATFORM_SKIP).toBe(expression('vars.PLATFORM_SKIP'));
    expect(decide?.env?.GH_TOKEN).toBe(expression('github.token'));
    expect(JSON.stringify(which)).not.toContain('secrets.');
    // It checks out without keeping a credential: the head is fetched anonymously, as anyone can.
    const checkout = (which?.steps ?? []).find((step) => step.name === undefined && step.with);
    expect(checkout?.with?.['persist-credentials']).toBe(false);
  });

  it('names the step the pass must have run, as check-kind.sh reads it', () => {
    const script = readFileSync('scripts/check-kind.sh', 'utf-8');
    const step = /^CLUSTER_STEP='([^']+)'$/m.exec(script)?.[1];
    expect(step).toBeTruthy();
    expect((platform?.steps ?? []).map((each) => each.name)).toContain(step);
    expect(/^PLATFORM_WORKFLOW=(.+)$/m.exec(script)?.[1]).toBe('.github/workflows/platform.yml');
    // The job the check run is: its name, which check-kind.sh reads the check runs and jobs by.
    expect((workflow.jobs.platform as { name?: string }).name).toBe('platform');
  });
});
