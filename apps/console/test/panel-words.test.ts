import type { PublicEvent } from '@software-factory/events';
import { describe, expect, it } from 'vitest';
import { own } from '../e2e/full.ts';
import { countsLabel, lastAttack, lastProof, runningWords, waitWords } from '../web/src/components/panel-words.ts';
import { patchingOf } from '../web/src/components/patching-view.ts';
import {
  failedOf,
  leftWords,
  lockfileName,
  pillNumber,
  routeWords,
  stateWords,
  wayOf,
  whyWords,
  withheld,
} from '../web/src/components/patching-words.ts';
import type { GuardrailRow, GuardrailsView } from '../web/src/projection/guardrails.ts';
import { project } from '../web/src/projection/index.ts';
import { foldItems } from '../web/src/projection/items.ts';
import { type PatchingView, patchingView } from '../web/src/projection/patching.ts';
import { ATTACKS, ATTACKS_END, END, SAMPLES } from './projection/support.ts';

const ALL = () => true;
const read = (view: PatchingView) => {
  if (view.state !== 'read') throw new Error('no day read');
  return view;
};

describe('how many wait', () => {
  it('groups a count in thousands, and says one waits', () => {
    expect(waitWords(1200, true)).toBe('1,200 wait on you');
    expect(waitWords(1, false)).toBe('1 waits on Martin');
  });
});

describe('what the sense found running', () => {
  const day = read(patchingOf(project(SAMPLES, END, ALL)));

  it('names each kind that waits on Martin, as the sheet’s kicker does', () => {
    expect(runningWords(day)).toEqual(['1 unscanned image running']);
    const every = { ...day, running: { 'unlisted-image': 2, 'unscanned-digest': 1, 'not-running': 1200 } };
    expect(runningWords(every)).toEqual([
      '2 unscanned images running',
      '1 digest no scan read',
      '1,200 pins not running yet',
    ]);
  });
});

describe('a row of counts’ label', () => {
  const none = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 };

  it('is the row’s name, and “Nothing to clear” only when the moves clear nothing at all', () => {
    expect(countsLabel('All open', { ...none, high: 4 })).toEqual({ label: 'All open', nothing: false });
    expect(countsLabel('All open', undefined)).toEqual({ label: 'All open', nothing: false });
    expect(countsLabel('The moves clear', none)).toEqual({ label: 'Nothing to clear', nothing: true });
    expect(countsLabel('The moves clear', { ...none, low: 1 })).toEqual({ label: 'The moves clear', nothing: false });
  });

  it('says the findings of no rating, which no column draws, beside it, and counts them as something', () => {
    expect(countsLabel('The moves clear', { ...none, unknown: 3 })).toEqual({
      label: 'The moves clear · 3 unrated',
      nothing: false,
    });
    expect(countsLabel('All open', { ...none, high: 2, unknown: 1200 }).label).toBe('All open · 1,200 unrated');
  });
});

describe('the Guardrails summary’s last proof and attack', () => {
  const view = project(SAMPLES, END, ALL).guardrails;

  it('is the newest proof whatever it showed, so one that failed is still the last proof', () => {
    const newest = Math.max(...view.rows.flatMap((row) => (row.proof ? [row.proof.at] : [])));
    expect(lastProof(view)?.at).toBe(newest);
    const failed: GuardrailsView = {
      ...view,
      rows: view.rows.map(
        (row): GuardrailRow => (row.proof ? { ...row, state: 'not-held', proof: { ...row.proof, held: false } } : row),
      ),
    };
    expect(lastProof(failed)).toEqual({ at: newest, held: false });
  });

  it('is none before any proof', () => {
    expect(lastProof({ ...view, rows: view.rows.map((row) => ({ ...row, proof: undefined })) })).toBeUndefined();
  });

  it('names the attack launched last, and none where none has been', () => {
    expect(lastAttack(view)).toBeUndefined();
    const attacks = project(ATTACKS, ATTACKS_END, ALL).guardrails;
    expect(lastAttack(attacks)?.last.verdict).toBe('running');
  });
});

describe('Patching’s view, shared by its summary and its sheet', () => {
  it('is worked out once for a drawn view, and is the same object while the day and the work items are', () => {
    const drawn = project(SAMPLES, END, ALL);
    const first = patchingOf(drawn);
    expect(patchingOf(drawn)).toBe(first);
    // Another drawn view, a minute on, with nothing new for Patching: the same view, so nothing renders.
    expect(patchingOf(project(SAMPLES, END + 60_000, ALL))).toBe(first);
  });

  it('is not given up for another caller’s day, so the order views are asked for in does not matter', () => {
    const first = patchingOf(project(SAMPLES, END, ALL));
    patchingOf(project(ATTACKS, ATTACKS_END, ALL));
    expect(patchingOf(project(SAMPLES, END + 120_000, ALL))).toBe(first);
  });

  it('is another for a new day', () => {
    const drawn = project(SAMPLES, END, ALL);
    const first = patchingOf(drawn);
    const day = SAMPLES.findLast((e) => e.type === 'patching.read');
    if (!day) throw new Error('the samples have no patching.read');
    const next = {
      ...day,
      id: 'a-new-day',
      seq: (SAMPLES.at(-1)?.seq ?? 0) + 1,
      ts: new Date(END + 1000).toISOString(),
    };
    const later = patchingOf(project([...SAMPLES, next], END + 60_000, ALL));
    expect(later).not.toBe(first);
    expect(read(later).at).toBe(END + 1000);
  });
});

describe('what Patching’s rows say', () => {
  const MARTIN = { martin: true };
  const VISITOR = { martin: false };
  const FULL = SAMPLES.map((e) => own(e as never) as PublicEvent);
  const mine = read(patchingView(FULL, foldItems(FULL), END));
  const theirs = read(patchingView(SAMPLES, foldItems(SAMPLES), END));
  const row = (view: Extract<PatchingView, { state: 'read' }>, name: string) => {
    const found = [...view.rows, ...view.done].find((r) => r.name === name);
    if (!found) throw new Error(`no row for ${name}`);
    return found;
  };

  it('says who moves each, with its number: Martin’s approval, Dependabot, the worker, an issue, his cluster', () => {
    const pill = (name: string, who = MARTIN) => [routeWords(row(mine, name), who), pillNumber(row(mine, name))];
    expect(pill('example-logs')).toEqual(['Your approval', 1344]);
    expect(pill('example-logs', VISITOR)).toEqual(['Martin’s approval', 1344]);
    expect(pill('example/setup-tool')).toEqual(['Dependabot', 1350]);
    expect(pill('example/sidecar')).toEqual(['The worker', 1348]);
    expect(pill('example/ingress')).toEqual(['An issue', 1361]);
    expect(pill('k3s')).toEqual(['Your cluster', 1345]);
    expect(pill('@example/agent-sdk')).toEqual(['Your bench run', 1352]);
    expect(pill('@example/parser')).toEqual(['The line', '1335']);
  });

  it('heads each row with its group’s word while it waits, and its own while it moves or is done', () => {
    const word = (name: string) => stateWords(row(mine, name), MARTIN)[0];
    expect(word('example-logs')).toBe('Approve');
    expect(word('@example/agent-sdk')).toBe('Run the bench');
    expect(word('example-metrics')).toBe('Held');
    expect(word('example/sidecar')).toBe('Stopped');
    expect(word('k3s')).toBe('By hand');
    expect(word('example/scanner-proxy')).toBe('Checks running');
    expect(word('example-dashboards')).toBe('In the merge queue');
    expect(word('example/cache')).toBe('Waits its day');
    expect(word('example/old-sidecar')).toBe('Merged');
    expect(word('example/runtime')).toBe('No longer listed');
  });

  it('says what failed by its check’s name, its try and its run, a link built from the run’s id, never a log', () => {
    expect(failedOf(row(mine, 'example/sidecar'))).toEqual({
      label: 'What failed',
      lines: [
        {
          name: 'database tests',
          words: 'failed · try 3 of 3',
          href: 'https://github.com/the-roganator/cv-software-factory/actions/runs/19220481337',
        },
      ],
    });
    expect(failedOf(row(mine, 'example/store-cache'))?.label).toBe('Why no target');
  });

  it('gives one way forward to GitHub for a row that waits, and what it does there', () => {
    expect(wayOf(row(mine, 'example-logs'))).toEqual({
      verb: 'Review',
      href: 'https://github.com/the-roganator/cv-software-factory/pull/1344',
      what: '#1344',
      does: 'Approve its head commit there: the worker then adds it to the merge queue.',
    });
    expect(wayOf(row(mine, 'example/devcontainer-base'))?.href).toBe(
      'https://github.com/the-roganator/cv-worlds-worst-website/issues/81',
    );
    expect(wayOf(row(mine, 'example/scanner-proxy'))).toBeUndefined();
  });

  it('says a refusal’s kind in the factory’s words, and what a move left as it is comes to', () => {
    expect(whyWords(row(mine, '@example/hooks'), MARTIN)).toContain('provenance downgrade');
    expect(leftWords(row(mine, 'example-logs'))).toMatch(/^Left as it is, the scan fails from /);
    expect(leftWords(row(mine, 'example/setup-tool'))).toBe(
      'Left as it is, nothing comes due. Dependabot keeps it up to date.',
    );
    expect(leftWords(row(mine, '@example/tokens'))).toMatch(/, for it and the one it holds\.$/);
    expect(whyWords(row(mine, 'example-metrics'), VISITOR)).toMatch(/^Martin asked for changes on #1355/);
  });

  it('says of a visitor’s withheld lockfile row only that it waits on Martin, with no number and nothing of why', () => {
    const withheldRows = theirs.groups.find(({ group }) => group === 'martin')?.rows ?? [];
    expect(withheldRows.length).toBeGreaterThan(0);
    for (const r of withheldRows) {
      expect(withheld(r)).toBe(true);
      expect(lockfileName(r)).toBe('A package in the factory’s lockfile');
      expect(routeWords(r, VISITOR)).toBe('Martin’s approval');
      expect(stateWords(r, VISITOR)[0]).toBe('Waits on Martin');
      expect(wayOf(r)).toBeUndefined();
      expect(whyWords(r, VISITOR)).toBe(
        'Its package is withheld while it has an open finding, and so is what it waits for. Martin sees both, signed in.',
      );
    }
  });
});
