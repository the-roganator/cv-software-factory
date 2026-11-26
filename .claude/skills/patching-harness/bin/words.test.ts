import { describe, expect, it } from 'vitest';
import { levelWait } from '../../../../apps/factory/src/github/deploy-queue.ts';
import { issueOf, REVERTED, strayed } from '../../../../apps/factory/src/github/pins.ts';
import { movesFile } from '../../../../apps/factory/src/vulnerabilities/moves.ts';
import { day, FakeRepo, FILES, factoryMoves } from '../../../../apps/factory/test/github/pins-harness.ts';
import { FACTORY_APP, type Facts, MARTIN, type PullRequest, route } from '../../../../scripts/review-routing.ts';
import { APP, ASKED_FOR_CHANGES, FACTORY, NOT_THE_MOVE, RULESET_REFUSAL } from './catalogue.ts';
import {
  OF_A_MOVE,
  queueWords,
  REVERTED_SAYS,
  rulesetsRefusal,
  STOPPED_WAIT,
  SUPERVISED_WAIT,
  shownAs,
  WAITING_KEY,
  waitsFault,
} from './decide.ts';

/**
 * The words the harness reads a verdict from, held to the code that writes them: each is made here by the worker's,
 * the gate's or the scan's own function, so a change of wording there fails here and not in a pass.
 */
const HEAD = 'a'.repeat(40);
const pull = (repo: string): PullRequest => ({
  number: 7,
  state: 'open',
  user: { id: FACTORY_APP },
  head: { sha: HEAD, ref: 'factory/pin/x', repo: { full_name: repo } },
  base: { ref: 'main', repo: { full_name: repo } },
});
/** A pull request of the App's, with nothing against it but what a test gives. */
const facts = (repo: string, over: Partial<Facts> = {}): Facts => ({
  repo,
  pr: pull(repo),
  reviews: [],
  autonomy: '',
  tags: [],
  testIntegrity: { read: true },
  labelsRemoved: [],
  ...over,
});
/** The copies' names are the real ones' with `-scratch`: the gate tells the app's repository by the real name. */
const real = (copy: string) => copy.replace(/-scratch$/, '');

describe('the worker’s words, as the harness reads them', () => {
  it('reads a move undone on main in the issue the watch writes for it (27)', () => {
    const repo = new FakeRepo(FILES);
    const [move] = factoryMoves();
    if (!move) throw new Error('the fixture has no move');
    const moves = day(repo.main, [move]);
    expect(issueOf(move, moves, REVERTED).body).toMatch(REVERTED_SAYS);
    // Its issue for any other reason, or none, does not say so.
    expect(issueOf(move, moves).body).not.toMatch(REVERTED_SAYS);
    expect(issueOf(move, moves, 'a pull request the App did not open stands on its branch').body).not.toMatch(
      REVERTED_SAYS,
    );
  });

  it('reads the line’s stop and the level’s wait in what the queue logs (26, batch D)', () => {
    const stopped = levelWait({ autonomy: 'guarded', autoMerge: true, stopped: true }, 'move');
    const supervised = levelWait({ autonomy: 'supervised', autoMerge: true, stopped: false }, 'move');
    expect(stopped).toMatchObject({ waits: STOPPED_WAIT.waits, why: expect.stringMatching(STOPPED_WAIT.why) });
    expect(stopped?.why).toMatch(OF_A_MOVE);
    expect(supervised).toMatchObject({ waits: SUPERVISED_WAIT.waits, why: expect.stringMatching(SUPERVISED_WAIT.why) });
    // A stop comes before the level, and a major's wait is no move's.
    expect(levelWait({ autonomy: 'supervised', autoMerge: true, stopped: true }, 'move')?.waits).toBe('stopped');
    expect(levelWait({ autonomy: 'guarded', autoMerge: true, stopped: true }, 'major')?.why).not.toMatch(OF_A_MOVE);
    // As the worker's log carries them, a line a head.
    const line = (number: number, word: typeof stopped) =>
      JSON.stringify({ number, head: HEAD, ...word, msg: 'the pin pull request waits to be queued' });
    const pulls = [{ number: 7, head: HEAD, queued: false, pending: 0 }];
    expect(waitsFault(pulls, queueWords(line(7, stopped)), 'stopped')).toBeUndefined();
    expect(waitsFault(pulls, queueWords(line(7, supervised)), 'supervised')).toBeUndefined();
    expect(waitsFault(pulls, queueWords(line(7, supervised)), 'stopped')).toMatch(/not that the line is stopped/);
  });
});

describe('the gate’s words, as the harness reads them', () => {
  it('reads Martin’s request for changes in the hold’s title (25)', () => {
    const asked = [{ user: { id: MARTIN }, state: 'CHANGES_REQUESTED', commit_id: HEAD }];
    const decision = route(facts(real(FACTORY), { reviews: asked, move: { rule: 'move', title: 'A move' } }));
    expect(decision).toMatchObject({ pass: false, rule: 'held' });
    expect(decision.title).toMatch(ASKED_FOR_CHANGES);
    expect(route(facts(real(FACTORY))).title).not.toMatch(ASKED_FOR_CHANGES);
  });

  it('reads a change that is not the scan’s move in the hold’s title, in either repository (N9, X1)', () => {
    const reason = 'deploy/base/kyverno/values.yaml:12 is "x" where the scan’s moves make "y"';
    const pin = { reason: 'it changes no digest' };
    // In the factory's repository, where only a pin or a move passes: "…, nor a move: …".
    const here = route(facts(real(FACTORY), { pin, move: { reason } }));
    expect(here.title).toContain(`nor a move: ${reason}`);
    expect(here.title).toMatch(NOT_THE_MOVE);
    // In the app's, held for its tags: "…; not a move: …", which X1's own pattern reads on from.
    const there = route(facts(real(APP), { tags: [{ tag: 'code-owned', because: ['Dockerfile'] }], move: { reason } }));
    expect(there.title).toContain(`not a move: ${reason}`);
    expect(there.title).toMatch(NOT_THE_MOVE);
    // A line that is another pin's now, as the gate's own edit and the watch's say it.
    expect(strayed({ file: 'deploy/x.yaml', line: 3 }, 'kyverno', 'v1.16.0')).toMatch(NOT_THE_MOVE);
    // A hold for anything else is not read as one.
    expect(route(facts(real(FACTORY), { pin })).title).not.toMatch(NOT_THE_MOVE);
  });
});

describe('the scan’s document, as the harness reads it', () => {
  it('names no waiting move: one that waits is absent, which is how 28 and 2 read it', () => {
    const file = movesFile([], { repository: real(FACTORY), now: Date.parse('2026-11-26T06:00:00Z') });
    expect(Object.keys(file)).not.toContain(WAITING_KEY);
    expect(shownAs({ ...file }, 'postgres')).toBe('absent');
  });
});

describe('GitHub’s words for the rulesets’ two refusals, as the harness reads them (N10)', () => {
  const branch = 'forged/n10';
  const commit = 'Repository rule violations found\n\nCannot update this protected ref.\n\n';
  const tag =
    'POST /repos/x/y-scratch/git/refs: 422 {"message":"Repository rule violations found\\n\\nCannot create ref due to creations being restricted.","status":"422"}';
  const line = (o: { commit: string | undefined; tag: string | undefined }) => rulesetsRefusal({ branch, ...o });

  it('passes only when each was refused in its own words, and quotes both', () => {
    const both = line({ commit, tag });
    expect(both).toEqual({ refused: expect.stringMatching(RULESET_REFUSAL) });
    expect('refused' in both && both.refused).toContain('Cannot update this protected ref.');
    expect('refused' in both && both.refused).toContain('Cannot create ref due to creations being restricted');
  });

  it('is no pass on one ruleset’s refusal beside any other error', () => {
    // The commit refused by the ruleset, and the tag by a token GitHub would not take.
    const unauthorised = line({ commit, tag: 'POST /repos/x/y-scratch/git/refs: 401 {"message":"Bad credentials"}' });
    expect(unauthorised).toEqual({ refused: expect.stringContaining("no ruleset's refusal of the tag") });
    expect('refused' in unauthorised && unauthorised.refused).not.toMatch(RULESET_REFUSAL);
    // A tag left there by an earlier run is a 422 too, and no ruleset's.
    const there = line({ commit, tag: 'POST /repos/x/y-scratch/git/refs: 422 {"message":"Reference already exists"}' });
    expect('refused' in there && there.refused).not.toMatch(RULESET_REFUSAL);
    // The tag refused, and the commit for a head that moved under it.
    const moved = line({ commit: 'Expected branch to point to "aaa" but it did not. Pull and try again.', tag });
    expect(moved).toEqual({ refused: expect.stringContaining("no ruleset's refusal of the commit") });
    expect('refused' in moved && moved.refused).not.toMatch(RULESET_REFUSAL);
  });

  it('says which landed where either went through, with what was said of the other', () => {
    expect(line({ commit: undefined, tag })).toEqual({
      landed: expect.stringMatching(/^the App's commit to forged\/n10 went through; the tag was refused: /),
    });
    expect(line({ commit, tag: undefined })).toEqual({
      landed: expect.stringMatching(/^the tag `main` went through; the commit was refused: /),
    });
    expect(line({ commit: undefined, tag: undefined })).toEqual({
      landed: "the App's commit to forged/n10 and the tag `main` went through",
    });
  });
});
