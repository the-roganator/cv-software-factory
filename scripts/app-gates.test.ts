import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync('.github/workflows/app-gates.yml', 'utf-8');
/** The base the jobs compare with, from their `base` step. */
const BASE = `\${{ steps.base.outputs.sha }}`;
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

  it('compare with the base a pull request would merge into now, or in the merge queue the group’s (#960)', () => {
    // Not the event's `pull_request.base.sha`, which GitHub leaves where the base was when the pull request opened.
    expect(workflow).not.toMatch(/pull_request\.base\.sha|BASE_SHA \}\}/);
    const withBase = Object.entries(jobs).filter(([, job]) => / {10}path: base\n/.test(job));
    expect(withBase.map(([id]) => id)).toEqual(['journeys', 'test-integrity', 'tests-first', 'image-scan']);
    for (const [, job] of withBase) {
      const change = job.indexOf('\n          path: change\n          fetch-depth: 2\n');
      const factory = job.indexOf('\n          path: factory\n');
      const find = job.indexOf(
        `\n      - name: Find the base
        id: base
        env:
          PR_HEAD_SHA: \${{ github.event.pull_request.head.sha }}
          MERGE_GROUP_BASE_SHA: \${{ github.event.merge_group.base_sha }}
        run: |
          base=$(factory/apps/factory/src/gates/base.sh change)
`,
      );
      const base = job.indexOf(`\n          ref: ${BASE}\n          path: base\n`);
      expect([change, factory, find, base].every((at) => at > 0)).toBe(true);
      expect(change < factory && factory < find && find < base).toBe(true);
      // The script is in the job's sparse checkout of this repository.
      expect(job.slice(factory, find)).toMatch(
        /^ {10}sparse-checkout: (?:\|\n(?: {12}.*\n)*? {12})?apps\/factory\/src\/gates\/(?:base\.sh)?$/m,
      );
    }
    expect(jobs.journeys).toContain(`build-args: GIT_COMMIT=${BASE}`);
    // Dependency review takes its base and head from the event, and compares from where the change left the base.
    expect(jobs['dependency-review']).not.toMatch(/base-ref|head-ref/);
    // Nothing reads the pull request's event alone, which a merge group does not carry: test integrity is given both.
    // Only its notice of what it judged, which the review gate reads on the pull request's run, takes the base's name
    // from the pull request's event alone: in the merge queue it writes none.
    // Each job's base step is given both, and must be: base.sh reads the one its event carries.
    const both = ['github.event.pull_request', 'github.event.merge_group'];
    expect(workflow.match(/github\.event\.\w+/g)).toEqual([
      ...both,
      ...both,
      'github.event.pull_request',
      'github.event.merge_group',
      'github.event.pull_request',
      ...both,
      ...both,
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
