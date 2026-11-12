import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

type Workflow = {
  name: string;
  'run-name'?: string;
  on: Record<string, { types?: string[]; workflows?: string[] } | null>;
};

const read = (file: string) => parse(readFileSync(`.github/workflows/${file}`, 'utf-8')) as Workflow;

/** An Actions expression, as a workflow writes one. */
const expression = (inside: string) => `\${{ ${inside} }}`;

describe('run names', () => {
  it("name a run on the merge queue's commit by the queue's branch, and leave a pull request's its title", () => {
    // The branch is gh-readonly-queue/main/pr-<number>-<base>, which names the pull request; GitHub's own name there is
    // the workflow's alone. An empty name leaves GitHub's, the pull request's title.
    const named = expression(
      "github.event_name == 'merge_group' && format('queue · {0}', github.event.merge_group.head_ref) || ''",
    );
    for (const file of ['check.yml', 'platform.yml', 'pr-title.yml']) {
      const workflow = read(file);
      expect(workflow['run-name'], file).toBe(named);
      expect(Object.keys(workflow.on), file).toContain('merge_group');
    }
  });

  it('name a review by the run that asked for it, whose title names the pull request or the queue’s branch', () => {
    expect(read('review.yml')['run-name']).toBe(
      expression(
        "format('review · {0} · after {1}', github.event.workflow_run.display_title, github.event.workflow_run.name)",
      ),
    );
  });
});

describe("the review on the merge queue's commit", () => {
  it('is asked for by check.yml, which runs on every entry, and not by review requested', () => {
    const check = read('check.yml');
    const gate = read('review.yml');
    // Every entry: no filter on check.yml's merge_group but the one type the queue sends.
    expect(check.on.merge_group).toEqual({ types: ['checks_requested'] });
    expect(gate.on.workflow_run?.workflows).toContain(check.name);
    expect(gate.on.workflow_run?.types).toEqual(['completed']);
    expect(Object.keys(read('review-requested.yml').on)).not.toContain('merge_group');
  });
});
