import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync('.github/workflows/app-gates.yml', 'utf-8');
/** Each job's text, by its id. */
const jobs = Object.fromEntries(
  workflow
    .slice(workflow.indexOf('\njobs:\n') + '\njobs:\n'.length)
    .split(/\n(?= {2}[\w-]+:\n)/)
    .map((job) => [job.match(/^ {2}([\w-]+):/)?.[1] ?? '', job]),
);

describe("the app's gates (ADR 0014)", () => {
  it('run a change only on pull_request or merge_group, and refuse anything else first', () => {
    expect(Object.keys(jobs).sort()).toEqual([
      'dependency-review',
      'image-scan',
      'journeys',
      'lockfile-scan',
      'test-integrity',
      'tests-first',
    ]);
    for (const job of Object.values(jobs)) {
      const steps = job.slice(job.indexOf('\n    steps:\n'));
      expect(steps).toMatch(
        /^\n {4}steps:\n(?: {6}#.*\n)+ {6}- name: Refuse a privileged context\n {8}run: \|\n {10}if \[ "\$GITHUB_EVENT_NAME" != pull_request \] && \[ "\$GITHUB_EVENT_NAME" != merge_group \]; then\n/,
      );
    }
  });

  it('compare with the pull request’s base, or in the merge queue the group’s', () => {
    expect(workflow).toMatch(
      /^ {2}BASE_SHA: \$\{\{ github\.event\.pull_request\.base\.sha \|\| github\.event\.merge_group\.base_sha \}\}$/m,
    );
    // Nothing reads the pull request's event alone, which a merge group does not carry: test integrity is given both.
    // Only its notice of what it judged, which the review gate reads on the pull request's run, takes the base's name
    // from the pull request's event alone: in the merge queue it writes none.
    expect(workflow.match(/github\.event\.\w+/g)).toEqual([
      'github.event.pull_request',
      'github.event.merge_group',
      'github.event.pull_request',
      'github.event.merge_group',
      'github.event.pull_request',
    ]);
    expect(jobs['test-integrity']).toMatch(
      /^ {10}PR_NUMBER: \$\{\{ github\.event\.pull_request\.number \}\}\n {10}MERGE_GROUP_HEAD_REF: \$\{\{ github\.event\.merge_group\.head_ref \}\}\n(?: {10}#.*\n)* {10}PR_BASE_REF: \$\{\{ github\.event\.pull_request\.base\.ref \}\}$/m,
    );
  });

  it('hold a read-only token and no secret, which test integrity alone may read pull requests with', () => {
    expect(workflow).toMatch(/^permissions:\n {2}contents: read\n\n/m);
    const granted = Object.entries(jobs).filter(([, job]) => /^ {4}permissions:/m.test(job));
    expect(granted.map(([id]) => id)).toEqual(['test-integrity']);
    expect(jobs['test-integrity']).toMatch(
      /^ {4}permissions:\n {6}contents: read\n {6}pull-requests: read\n {4}steps:/m,
    );
    expect(workflow.match(/github\.token/g)).toHaveLength(1);
    expect(workflow).not.toMatch(/secrets\./);
  });
});
