/**
 * How `make guardrails` judges what it took: a refusal record taken again against the one deploy/test/ keeps,
 * egress.sh's record, and the Apps' installations against what github-settings.ts declares (guardrails/records.ts,
 * guardrails/github.ts).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { APPS } from '../../../../scripts/github-settings.ts';
import { judgeInstallations } from '../../src/guardrails/github.ts';
import {
  type EgressRecord,
  judgeEgress,
  judgeRecord,
  otherIdentityProblems,
  type RefusalRecord,
} from '../../src/guardrails/records.ts';

const kept = (name: string) =>
  JSON.parse(readFileSync(new URL(`../../../../deploy/test/${name}.json`, import.meta.url), 'utf-8')) as RefusalRecord;

describe('a refusal record taken again', () => {
  it('holds when it was taken against the same policies, and the cluster answered each case as the record says', () => {
    for (const name of [
      'route-refusals',
      'flag-stages-refusals',
      'admission-refusals',
      'mark-refusals',
      'share-key-refusals',
    ]) {
      const record = kept(name);
      const judged = judgeRecord(record, structuredClone(record));
      expect(judged.held, name).toBe(true);
      expect(
        judged.lines.some((l) => l.startsWith('✗')),
        name,
      ).toBe(false);
    }
  });

  it('does not hold when a case refused in the record is admitted now, or a case is missing or new', () => {
    const record = kept('route-refusals');
    const fresh = structuredClone(record);
    const refused = fresh.cases?.find((c) => c.outcome === 'refused');
    if (!refused) throw new Error('no refused case');
    refused.outcome = 'admitted';
    const judged = judgeRecord(record, fresh);
    expect(judged.held).toBe(false);
    expect(judged.lines).toContain(`✗ ${refused.case}: admitted now, refused in deploy/test/`);

    const fewer = { ...structuredClone(record), cases: (record.cases ?? []).slice(1) };
    expect(judgeRecord(record, fewer).lines).toContain(`✗ ${record.cases?.[0]?.case}: not asked now`);
    const more = { ...structuredClone(record), cases: [...(record.cases ?? []), { case: 'new', outcome: 'refused' }] };
    expect(judgeRecord(record, more).lines).toContain('✗ new: not in deploy/test/');
  });

  it('does not hold when what it read of the live objects differs: a route of the app refused, a key not its Secret', () => {
    const mark = kept('mark-refusals');
    const fresh = structuredClone(mark);
    const live = fresh.live as { case: string; outcome: string }[];
    const route = live[0];
    if (!route) throw new Error('no live case');
    route.outcome = 'refused';
    expect(judgeRecord(mark, fresh).lines).toContain(`✗ ${route.case}: refused now, admitted in deploy/test/`);

    const share = kept('share-key-refusals');
    const mismatched = { ...structuredClone(share), live: { ...share.live, matchesSecret: false } };
    const judged = judgeRecord(share, mismatched);
    expect(judged.held).toBe(false);
    expect(judged.lines.some((l) => /^✗ live: .*"matchesSecret":false/.test(l))).toBe(true);
  });

  it('does not hold when taken against other policies, or against a record with no hash or no refusal', () => {
    const record = kept('route-refusals');
    expect(judgeRecord(record, { ...structuredClone(record), policyHash: 'f'.repeat(64) }).held).toBe(false);
    const { policyHash: _, ...unhashed } = record;
    expect(judgeRecord(unhashed, record).held).toBe(false);
    const admitting = { ...record, cases: (record.cases ?? []).map((c) => ({ ...c, outcome: 'admitted' })) };
    expect(judgeRecord(admitting, admitting).lines).toContain('✗ the record in deploy/test/ refuses nothing');
  });

  it('holds an image signed by another identity to a refusal for its signature, where an image of ours runs', () => {
    const record = kept('admission-refusals');
    expect(otherIdentityProblems(record)).toEqual([]);
    const byRegistry = structuredClone(record);
    for (const c of byRegistry.cases ?? []) {
      if (c.case === 'other-identity') c.message = "images must come from this project's GHCR";
    }
    expect(otherIdentityProblems(byRegistry)).toContain('✗ factory other-identity: not refused for its signature');
    expect(otherIdentityProblems({ cases: [] })).toEqual(['✗ no other-identity case was asked']);
  });
});

describe('egress.sh’s record', () => {
  const check = (result: string, tag?: string) => ({
    group: 'g',
    check: `c-${result}`,
    from: 'factory/triage',
    address: 'http://x',
    wanted: 'blocked',
    got: result === 'ok' ? 'blocked' : 'reached',
    result,
    ...(tag && { tag }),
  });

  it('holds when every check was as wanted, and says what failed first', () => {
    const record: EgressRecord = { held: true, checks: [check('ok'), check('ok', 'read-only-telemetry')] };
    expect(judgeEgress(record)).toEqual({ held: true, lines: ['2 of 2 checks as wanted'] });
    const failed = judgeEgress({ held: false, checks: [check('ok'), check('fail')] });
    expect(failed.held).toBe(false);
    expect(failed.lines[0]).toBe('FAIL  c-fail (from factory/triage, to http://x): reached, wanted blocked');
    expect(judgeEgress({ held: true, checks: [] }).held).toBe(false);
  });

  it('reads the readers of telemetry by their tag, for the proof that nothing writes to production', () => {
    const record: EgressRecord = { held: false, checks: [check('fail'), check('ok', 'read-only-telemetry')] };
    expect(judgeEgress(record, 'read-only-telemetry').held).toBe(true);
    expect(judgeEgress({ checks: [check('ok')] }, 'read-only-telemetry').held).toBe(false);
  });
});

describe('the Apps’ installations', () => {
  const live = Object.values(APPS).map((app, i) => ({
    app_slug: app.slug,
    app_id: i,
    permissions: { ...(app.permissions as Record<string, string>) },
  }));

  it('hold when each is an App declared, with exactly the permissions declared', () => {
    const { held, lines } = judgeInstallations(live);
    expect(held).toBe(true);
    expect(lines[0]).toBe(
      '✓ mrogan-software-factory (0): checks write, contents write, issues write, metadata read, pull_requests write: as declared',
    );
  });

  it('do not hold with a permission more, a level higher or less, an App not declared, or none read', () => {
    const more = structuredClone(live);
    (more[1] as (typeof more)[number]).permissions.contents = 'read';
    expect(judgeInstallations(more).lines[1]).toMatch(/contents read, declared none/);
    const higher = structuredClone(live);
    (higher[1] as (typeof higher)[number]).permissions.pull_requests = 'write';
    expect(judgeInstallations(higher).held).toBe(false);
    const less = structuredClone(live);
    delete (less[0] as (typeof less)[number]).permissions.issues;
    expect(judgeInstallations(less).lines[0]).toMatch(/issues not held/);
    const stranger = [...live, { app_slug: 'stranger', app_id: 9, permissions: { workflows: 'write' } }];
    expect(judgeInstallations(stranger).lines.at(-1)).toBe(
      '✗ stranger (9): workflows write: not an App scripts/github-settings.ts declares; writes workflows',
    );
    expect(judgeInstallations([]).held).toBe(false);
  });
});
