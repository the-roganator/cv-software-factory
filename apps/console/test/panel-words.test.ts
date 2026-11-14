import { describe, expect, it } from 'vitest';
import { countsLabel, lastAttack, lastProof, runningWords, waitWords } from '../web/src/components/panel-words.ts';
import { patchingOf } from '../web/src/components/patching-view.ts';
import type { GuardrailRow, GuardrailsView } from '../web/src/projection/guardrails.ts';
import { project } from '../web/src/projection/index.ts';
import type { PatchingView } from '../web/src/projection/patching.ts';
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
    expect(countsLabel('All open', { ...none, high: 4 })).toBe('All open');
    expect(countsLabel('All open', undefined)).toBe('All open');
    expect(countsLabel('The moves clear', none)).toBe('Nothing to clear');
    expect(countsLabel('The moves clear', { ...none, low: 1 })).toBe('The moves clear');
  });

  it('says the findings of no rating, which no column draws, beside it', () => {
    expect(countsLabel('The moves clear', { ...none, unknown: 3 })).toBe('The moves clear · 3 unrated');
    expect(countsLabel('All open', { ...none, high: 2, unknown: 1200 })).toBe('All open · 1,200 unrated');
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
