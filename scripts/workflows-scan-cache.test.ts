import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

type Step = { id?: string; name?: string; if?: string; uses?: string; run?: string; with?: Record<string, string> };
type Workflow = { jobs: Record<string, { steps?: Step[] }> };

const workflow = parse(readFileSync('.github/workflows/vulnerabilities.yml', 'utf-8')) as Workflow;
const steps = (job: string) => workflow.jobs[job]?.steps ?? [];

/** An Actions expression, as a workflow writes one. */
const expression = (inside: string) => `\${{ ${inside} }}`;

const DEFAULT_BRANCH = "github.ref == format('refs/heads/{0}', github.event.repository.default_branch)";
const PIN = "hashFiles('factory/deploy/images/trivy/Dockerfile')";

/**
 * What the scan keeps between runs (vulnerabilities.yml): what it derived, keyed by what it was derived from, written by
 * the default branch's runs alone, so nothing a pull request writes is read by a run that uploads.
 */
describe('the scan’s caches', () => {
  it('are saved by the default branch’s runs of the scan alone, and only restored by the proving run', () => {
    const caches = Object.entries(workflow.jobs).flatMap(([job, { steps = [] }]) =>
      steps.filter((step) => step.uses?.startsWith('actions/cache')).map((step) => ({ job, step })),
    );
    // actions/cache itself saves in its post step, whatever the event: only restore and save, each said.
    expect(
      caches.every(({ step }) => /^actions\/cache\/(restore|save)@[0-9a-f]{40}$/.test(step.uses?.split(' ')[0] ?? '')),
    ).toBe(true);
    const saves = caches.filter(({ step }) => step.uses?.startsWith('actions/cache/save@'));
    expect(saves.map(({ job }) => job)).toEqual(['scan', 'scan']);
    for (const { step } of saves) expect(step.if).toContain(DEFAULT_BRANCH);
    expect(caches.filter(({ job }) => job === 'prove').map(({ step }) => step.id)).toEqual(['layers', 'lookups']);
    expect(caches.some(({ job }) => job === 'coverage')).toBe(false);
  });

  it('keep Trivy’s analysis of each layer, keyed by Trivy’s pin, and never the advisory databases', () => {
    for (const job of ['scan', 'prove']) {
      const layers = steps(job).find((step) => step.id === 'layers');
      // The databases are Trivy's db/ and java-db/ beside it, which scan.ts deletes and pulls afresh each run.
      expect(layers?.with?.path, job).toBe(expression('runner.temp') + '/trivy/fanal');
      expect(layers?.with?.key, job).toBe(
        `vulnerabilities-layers-${expression(PIN)}-${expression('steps.day.outputs.day')}`,
      );
      expect(layers?.with?.['restore-keys'], job).toBe(
        `vulnerabilities-layers-${expression(PIN)}-${expression('steps.day.outputs.month')}-`,
      );
      const scan = steps(job).find((step) => step.run?.includes('vulnerabilities/scan.ts'));
      expect(scan?.run, job).toContain('--cache "$RUNNER_TEMP/trivy"');
    }
    const save = steps('scan').find(
      (step) => step.uses?.startsWith('actions/cache/save@') && step.with?.path?.endsWith('/trivy/fanal'),
    );
    expect(save?.with?.key).toBe(expression('steps.layers.outputs.cache-primary-key'));
  });

  it('keep the day’s lookups for runs on a push or a pull request, and leave the daily scan to ask afresh', () => {
    for (const job of ['scan', 'prove']) {
      const lookups = steps(job).find((step) => step.id === 'lookups');
      expect(lookups?.if, job).toBe(expression("github.event_name == 'push' || github.event_name == 'pull_request'"));
      expect(lookups?.with?.key, job).toBe(`vulnerabilities-lookups-${expression('steps.day.outputs.day')}`);
      const deadlines = steps(job).find((step) =>
        step.run?.includes('vulnerabilities/deadlines.ts "$RUNNER_TEMP/scan"'),
      );
      expect(deadlines?.run, job).toContain('--memo "$RUNNER_TEMP/lookups/deadlines.json"');
    }
  });

  it('save after the steps that fill them, and before the upload', () => {
    const all = steps('scan');
    const at = (match: (step: Step) => boolean) => all.findIndex(match);
    const scan = at((step) => step.name === 'Scan');
    const deadlines = at((step) => step.name === 'Deadlines and moves');
    const upload = at((step) => !!step.uses?.includes('upload-sarif'));
    const saves = all.flatMap((step, i) => (step.uses?.startsWith('actions/cache/save@') ? [i] : []));
    for (const i of saves) {
      expect(i).toBeGreaterThan(deadlines);
      expect(i).toBeLessThan(upload);
    }
    expect(at((step) => step.id === 'layers')).toBeLessThan(scan);
    expect(at((step) => step.id === 'lookups')).toBeLessThan(scan);
  });
});
