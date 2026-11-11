import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { excusedNote, judgedNote } from '../apps/factory/src/gates/test-integrity.ts';
import {
  type Found,
  found,
  GIVEN_LIMIT,
  NEVER_LIGHTS_OUT,
  PENDING_LIMIT,
  readVerdict,
  type Verdict,
  verdictBlock,
  verdictPasses,
} from '../policy/review-verdict.ts';
import {
  APP_REPO,
  type CheckRun,
  codeOwners,
  digestMoves,
  EXCUSED,
  exactPin,
  excusedTests,
  FACTORY_APP,
  type Facts,
  type FileChange,
  imageOf,
  JUDGED,
  levelPasses,
  literally,
  MARTIN,
  martinsRule,
  notJudged,
  type PinChecks,
  type PullRequest,
  riskLabelsRemoved,
  route,
  SECURITY_HEADER_NAMES,
  signerOf,
  stands,
  TEST_INTEGRITY_CHECK,
  tagsOf,
  testIntegrityRun,
  words,
} from './review-routing.ts';

const HEAD = 'a'.repeat(40);
const EARLIER = 'b'.repeat(40);
const QUEUE = 'c'.repeat(40);
const FACTORY_REPO = 'the-roganator/cv-software-factory';

const pr = (author: number | null, repo = APP_REPO, over: Partial<PullRequest> = {}): PullRequest => ({
  number: 7,
  state: 'open',
  user: author === null ? null : { id: author },
  head: { sha: HEAD, ref: 'factory/1-fix', repo: { full_name: repo } },
  base: { ref: 'main', repo: { full_name: repo } },
  ...over,
});
const approved = (commit = HEAD) => ({ user: { id: MARTIN }, state: 'APPROVED', commit_id: commit });
const tag = (name: Found['tag'], ...because: string[]): Found => found(name, because.length ? because : ['x']);

/** The facts of a pull request of the App's in the app's repository with nothing against it. */
const facts = (over: Partial<Facts> = {}): Facts => ({
  repo: APP_REPO,
  pr: pr(FACTORY_APP),
  reviews: [],
  autonomy: '',
  tags: [],
  testIntegrity: { read: true },
  labelsRemoved: [],
  ...over,
});

describe('approval routing: the rule, the first that holds', () => {
  it("passes Martin's own pull request, and his approval of the head, whatever its tags", () => {
    const tags = [tag('dependency-change'), tag('code-owned'), tag('release')];
    expect(route(facts({ pr: pr(MARTIN), tags }))).toMatchObject({ pass: true, rule: 'martin-opened', tags });
    expect(route(facts({ reviews: [approved()], tags }))).toMatchObject({ pass: true, rule: 'martin-approved-head' });
    // In this repository too, and with test integrity unread or a label removed: his say is his.
    expect(
      route(
        facts({
          repo: FACTORY_REPO,
          pr: pr(FACTORY_APP, FACTORY_REPO),
          reviews: [approved()],
          testIntegrity: { read: false, reason: 'pending' },
          labelsRemoved: ['test-loosening'],
        }),
      ),
    ).toMatchObject({ pass: true, rule: 'martin-approved-head' });
  });

  it('holds a push after Martin approved: his approval is of the head, not the pull request', () => {
    const said = route(facts({ reviews: [approved(EARLIER)], tags: [tag('dependency-change')] }));
    expect(said).toMatchObject({ pass: false, rule: 'held' });
    expect(said.title).toContain('Martin approved bbbbbbb, and it has moved since');
  });

  it("passes the App's untagged pull request in the app's repository as low-risk", () => {
    expect(route(facts())).toMatchObject({ pass: true, rule: 'low-risk' });
    expect(route(facts({ autonomy: 'lights-out' }))).toMatchObject({ pass: true, rule: 'low-risk' });
  });

  it("holds anyone else's untagged pull request: low-risk is the App's alone, from a branch here", () => {
    expect(route(facts({ pr: pr(42) }))).toMatchObject({ pass: false, rule: 'held' });
    expect(route(facts({ pr: pr(null) }))).toMatchObject({ pass: false, rule: 'held' });
    const fork = pr(FACTORY_APP, APP_REPO, { head: { sha: HEAD, ref: 'x', repo: { full_name: 'someone/r' } } });
    expect(route(facts({ pr: fork }))).toMatchObject({ pass: false, rule: 'held' });
  });

  it('fails closed on test integrity: a pending, missing or foreign run holds an untagged pull request', () => {
    for (const reason of ['test integrity is still running at aaaaaaa', 'test integrity has not run at aaaaaaa']) {
      const said = route(facts({ testIntegrity: { read: false, reason } }));
      expect(said).toMatchObject({ pass: false, rule: 'held' });
      expect(said.title).toContain(reason);
      // Lights-out needs the reading too: a loosened test is a tag it cannot see without it.
      expect(route(facts({ autonomy: 'lights-out', testIntegrity: { read: false, reason } })).rule).toBe('held');
    }
  });

  it('says a hold only waits when test integrity may yet be read and nothing it read holds the pull request', () => {
    const waiting = { read: false, reason: 'test integrity is still running at aaaaaaa', pending: true } as const;
    const said = route(facts({ testIntegrity: waiting }));
    expect(said).toMatchObject({ pass: false, rule: 'held', pending: 'test integrity is still running at aaaaaaa' });
    expect(said.title).toContain('Waits for test integrity before it judges: test integrity is still running');
    // At Lights-out, tags it would pass wait for the reading too: it could add a loosened test's.
    expect(
      route(facts({ autonomy: 'lights-out', tags: [tag('dependency-change')], testIntegrity: waiting })),
    ).toMatchObject({ rule: 'held', pending: waiting.reason });
    // Tags the level does not pass hold it whatever test integrity says: they decide first, it is no wait, and its
    // words name them.
    for (const [autonomy, tags, names] of [
      ['', [tag('dependency-change')], 'dependency-change'],
      ['guarded', [tag('test-loosening')], 'test-loosening'],
      ['lights-out', [tag('dependency-change'), tag('release')], 'dependency-change, release'],
      ['lights-out', [tag('improvement')], 'improvement'],
      ['lights-out', [tag('code-owned')], 'code-owned'],
    ] as const) {
      for (const [testIntegrity, more] of [
        [waiting, `; test integrity has not read it yet (${waiting.reason})`],
        [{ read: false, reason: 'failed' } as const, '; no reading of test integrity (failed)'],
        [{ read: true } as const, ''],
      ] as const) {
        const tagged = route(facts({ autonomy, tags: [...tags], testIntegrity }));
        expect(tagged.rule).toBe('held');
        expect(tagged.pending).toBeUndefined();
        // Test integrity's reading is named when there is none, so Martin does not approve on the tags alone.
        expect(tagged.title.startsWith(`Held for its risk tags (${names})${more}: `)).toBe(true);
      }
    }
    // A removed risk label, or anything in this repository but a pin, decides before test integrity is looked at.
    expect(route(facts({ labelsRemoved: ['out-of-scope'], testIntegrity: waiting })).pending).toBeUndefined();
    const here = facts({ repo: FACTORY_REPO, pr: pr(FACTORY_APP, FACTORY_REPO), testIntegrity: waiting });
    expect(route(here).pending).toBeUndefined();
    // A reading that will not come (a failed or cancelled run, a stacked base) is no wait.
    for (const reason of [
      "test integrity's run at aaaaaaa is failure, not a success",
      'GitHub gave 0 of its 1 annotations',
      "it is into factory/1-fix, so test integrity's run is not the workflow on main's",
    ]) {
      const held = route(facts({ testIntegrity: { read: false, reason } }));
      expect(held.title).toContain(`No reading of test integrity: ${reason}`);
      expect(held.pending).toBeUndefined();
    }
    // Martin's say passes it, wait or not.
    expect(route(facts({ reviews: [approved()], testIntegrity: waiting }))).toMatchObject({
      pass: true,
      rule: 'martin-approved-head',
    });
    expect(route(facts({ reviews: [approved()], testIntegrity: waiting })).pending).toBeUndefined();
    // Whole: the summary's block cuts it, in one place.
    const long = route(facts({ testIntegrity: { ...waiting, reason: 'x'.repeat(PENDING_LIMIT + 50) } }));
    expect(long.pending).toHaveLength(PENDING_LIMIT + 50);
  });

  it('passes the tags a level allows by one test, for the lights-out rule and the wait alike', () => {
    for (const autonomy of ['', 'guarded', 'lights-out']) expect(levelPasses([], autonomy)).toBe(true);
    for (const autonomy of ['', 'guarded', 'Lights-out'])
      expect(levelPasses([tag('dependency-change')], autonomy)).toBe(false);
    expect(levelPasses([tag('dependency-change'), tag('security-headers')], 'lights-out')).toBe(true);
    for (const never of NEVER_LIGHTS_OUT)
      expect(levelPasses([tag('test-loosening'), tag(never)], 'lights-out')).toBe(false);
  });

  it('holds a tagged pull request of the App’s while AUTONOMY is unset, or anything but lights-out', () => {
    for (const autonomy of ['', 'guarded', 'Lights-out', 'lights-out ']) {
      for (const tags of [[tag('test-loosening')], [tag('dependency-change')], [tag('security-headers')]]) {
        const said = route(facts({ autonomy, tags }));
        expect(said).toMatchObject({ pass: false, rule: 'held', tags });
        expect(said.title).toContain(`Held for its risk tags (${tags[0]?.tag})`);
      }
    }
  });

  it('passes a pin move here, tried after the exact pin, and holds one it could not prove with both reasons', () => {
    const here = facts({ repo: FACTORY_REPO, pr: pr(FACTORY_APP, FACTORY_REPO), tags: [tag('code-owned')] });
    const pin = { reason: 'apps/console/zap/scan.ts is not a pin file under deploy/' };
    const title = 'A pin move of ghcr.io/zaproxy/zaproxy to 2.17.0, forward on its line';
    expect(route({ ...here, pin, pinMove: { title } })).toMatchObject({ pass: true, rule: 'pin-move', title });
    const held = route({ ...here, pin, pinMove: { reason: 'a move backwards, from 2.17.0 to 2.16.0' } });
    expect(held).toMatchObject({ pass: false, rule: 'held' });
    expect(held.title).toBe(
      'Not an exact pin (apps/console/zap/scan.ts is not a pin file under deploy/), nor a pin move: a move backwards, from 2.17.0 to 2.16.0, and here only a pin passes without Martin: waits for Martin to approve aaaaaaa',
    );
    // An exact pin decides first; one whose check could not be made waits, and no pin move passes it.
    expect(route({ ...here, pin: { unchecked: 'ghcr.io did not answer' }, pinMove: { title } })).toMatchObject({
      pass: false,
      pending: 'the gate could not check its exact pin: ghcr.io did not answer',
    });
    // Martin's say comes first, and someone else's pull request is never a pin move.
    expect(route({ ...here, reviews: [approved()], pinMove: { reason: 'x' } })).toMatchObject({
      rule: 'martin-approved-head',
    });
    expect(route({ ...here, pr: pr(42, FACTORY_REPO), pinMove: { title } })).toMatchObject({
      pass: false,
      rule: 'held',
    });
    // A removed risk label, and a read that failed, hold it whatever the move.
    expect(route({ ...here, labelsRemoved: ['code-owned'], pinMove: { title } })).toMatchObject({ pass: false });
    expect(route({ ...here, unread: 'GET /files: 502', pinMove: { title } })).toMatchObject({ pass: false });
  });

  it('never passes a pin move in the app’s repository, whose line moves its own pins', () => {
    const there = facts({ tags: [tag('dependency-change')], pinMove: { title: 'A pin move of x' } });
    expect(route(there)).toMatchObject({ pass: false, rule: 'held' });
  });

  it('passes it at Lights-out, in the app’s repository, but never a release, an improvement or a code-owned path', () => {
    const lightsOut = (tags: Found[]) => route(facts({ autonomy: 'lights-out', tags }));
    expect(lightsOut([tag('test-loosening'), tag('dependency-change'), tag('security-headers')])).toMatchObject({
      pass: true,
      rule: 'lights-out',
    });
    for (const never of ['release', 'improvement', 'code-owned'] as const) {
      expect(lightsOut([tag('dependency-change'), tag(never)])).toMatchObject({ pass: false, rule: 'held' });
      expect(lightsOut([tag(never)])).toMatchObject({ pass: false, rule: 'held' });
    }
  });

  it('holds any App pull request in this repository but an exact pin, whatever AUTONOMY says', () => {
    for (const autonomy of ['', 'lights-out']) {
      const here = facts({ repo: FACTORY_REPO, pr: pr(FACTORY_APP, FACTORY_REPO), autonomy });
      expect(route(here)).toMatchObject({ pass: false, rule: 'held' });
      expect(route({ ...here, tags: [tag('dependency-change')] })).toMatchObject({ pass: false, rule: 'held' });
      const notAPin = route({ ...here, pin: { reason: 'apps/x.ts is not a pin file under deploy/' } });
      expect(notAPin.title).toContain('Not an exact pin: apps/x.ts is not a pin file under deploy/');
      const pin = {
        pins: [
          {
            file: 'deploy/k.yaml',
            image: 'ghcr.io/the-roganator/cv-software-factory/factory',
            from: 'sha256:1',
            to: 'sha256:2',
          },
        ],
      };
      expect(route({ ...here, pin, tags: [tag('code-owned')] })).toMatchObject({ pass: true, rule: 'exact-pin' });
    }
    // Any repository but the app's is held so, not only this one.
    expect(route(facts({ repo: 'someone/r', pr: pr(FACTORY_APP, 'someone/r') })).rule).toBe('held');
  });

  it('passes an exact pin in the app’s repository too, code-owned as deploy/ is, with no test integrity', () => {
    const pin = {
      pins: [
        {
          file: 'deploy/k.yaml',
          image: 'ghcr.io/the-roganator/cv-worlds-worst-website',
          from: 'sha256:1',
          to: 'sha256:2',
        },
      ],
    };
    expect(
      route(facts({ pin, tags: [tag('code-owned')], testIntegrity: { read: false, reason: 'skipped' } })),
    ).toMatchObject({
      pass: true,
      rule: 'exact-pin',
      title: 'An exact pin of cv-worlds-worst-website, each signed on main',
    });
  });

  it('holds a pull request whose risk label anyone but Martin removed, even a pin', () => {
    const pin = {
      pins: [
        {
          file: 'deploy/k.yaml',
          image: 'ghcr.io/the-roganator/cv-worlds-worst-website',
          from: 'sha256:1',
          to: 'sha256:2',
        },
      ],
    };
    for (const autonomy of ['', 'lights-out']) {
      const said = route(facts({ autonomy, labelsRemoved: ['test-loosening'] }));
      expect(said).toMatchObject({ pass: false, rule: 'held' });
      expect(said.title).toContain('Someone other than Martin removed its test-loosening label');
      expect(route(facts({ autonomy, pin, labelsRemoved: ['out-of-scope'] })).rule).toBe('held');
    }
  });

  it('waits, never judging, when it could not check an exact pin: in either repository, never by its tags', () => {
    const unchecked = { unchecked: 'cosign could not verify ghcr.io/x@1111111 (Error: 503)' };
    for (const here of [
      facts({ pin: unchecked }),
      facts({ pin: unchecked, autonomy: 'lights-out', tags: [tag('dependency-change')] }),
      facts({ pin: unchecked, tags: [tag('code-owned')], testIntegrity: { read: false, reason: 'skipped' } }),
      facts({ repo: FACTORY_REPO, pr: pr(FACTORY_APP, FACTORY_REPO), pin: unchecked }),
    ]) {
      const said = route(here);
      // Untagged with test integrity read, it would otherwise be low-risk: an unchecked pin never passes.
      expect(said).toMatchObject({ pass: false, rule: 'held', unchecked: unchecked.unchecked });
      expect(said.title).toBe(
        'Not judged yet: the gate could not check its exact pin: cosign could not verify ghcr.io/x@1111111 (Error: 503): waits for Martin to approve aaaaaaa',
      );
      // The line waits for the gate to judge it again, and holds nothing as a refusal.
      expect(said.pending).toBe(
        'the gate could not check its exact pin: cosign could not verify ghcr.io/x@1111111 (Error: 503)',
      );
      expect(said.tags).toEqual(here.tags);
    }
    // What it did read still holds it first, and is no wait.
    const removed = route(facts({ pin: unchecked, labelsRemoved: ['test-loosening'] }));
    expect(removed).toMatchObject({ rule: 'held' });
    expect(removed.pending).toBeUndefined();
    expect(route(facts({ pin: unchecked, reviews: [approved()] })).rule).toBe('martin-approved-head');
  });

  it('says why a change of digests alone is not an exact pin, in the app’s repository too', () => {
    const reason = 'ghcr.io/the-roganator/cv-worlds-worst-website@1111111: cosign does not verify it';
    const said = route(facts({ pin: { reason, digests: true } }));
    // Untagged, it would otherwise pass as low-risk: an image whose signature does not verify never does.
    expect(said).toMatchObject({ pass: false, rule: 'held' });
    expect(said.title).toBe(
      `Not an exact pin: ${reason}, and a change of digests alone passes only as one: waits for Martin to approve aaaaaaa`,
    );
    expect(said.pending).toBeUndefined();
    // An ordinary change is no pin at all, and is judged by its tags as before.
    const change = { reason: 'src/a.ts is not a pin file under deploy/' };
    expect(route(facts({ pin: change }))).toMatchObject({ pass: true, rule: 'low-risk' });
    expect(route(facts({ pin: change, tags: [tag('code-owned')] })).title).toContain('Held for its risk tags');
  });

  it('holds what it could not read, unless Martin has had his say', () => {
    expect(route(facts({ unread: 'GET /files: 502' }))).toMatchObject({ pass: false, rule: 'held' });
    expect(route(facts({ unread: 'GET /files: 502', pr: pr(MARTIN) })).rule).toBe('martin-opened');
  });

  it('never takes a read that failed for a wait: nothing runs the gate again for it, and it may never succeed', () => {
    for (const author of [FACTORY_APP, 42]) {
      const said = route(
        facts({ unread: 'GET /files: 404', pr: pr(author), testIntegrity: { read: false, reason: 'not read' } }),
      );
      expect(said).toMatchObject({ pass: false, rule: 'held' });
      expect(said.pending).toBeUndefined();
      expect(said.title).toContain('The gate could not read the pull request whole (GET /files: 404)');
    }
  });
});

describe('risk labels removed', () => {
  const unlabeled = (name: string, actor: number | null) => ({
    event: 'unlabeled',
    actor: actor === null ? null : { id: actor },
    label: { name },
  });

  it('counts a risk label removed by anyone but Martin, once', () => {
    expect(
      riskLabelsRemoved([
        unlabeled('test-loosening', FACTORY_APP),
        unlabeled('test-loosening', 42),
        unlabeled('out-of-scope', null),
        unlabeled('dependency-change', MARTIN),
        unlabeled('documentation', FACTORY_APP),
        { event: 'labeled', actor: { id: FACTORY_APP }, label: { name: 'release' } },
      ]),
    ).toEqual(['test-loosening', 'out-of-scope']);
  });
});

describe('test integrity’s reading', () => {
  const run = (over: Partial<CheckRun> = {}): CheckRun => ({
    id: 1,
    name: TEST_INTEGRITY_CHECK,
    head_sha: HEAD,
    status: 'completed',
    conclusion: 'success',
    app: { slug: 'github-actions' },
    started_at: '2026-11-04T10:00:00Z',
    ...over,
  });
  const files: FileChange[] = [{ filename: 'src/x.ts', status: 'modified', patch: '+a' }];

  it('reads the completed, successful run GitHub Actions posted for the head', () => {
    expect(testIntegrityRun([run()], HEAD, files, 'main')).toEqual({ run: run() });
    // The latest of several, a re-run's.
    const again = run({ id: 2, started_at: '2026-11-04T11:00:00Z', conclusion: 'failure' });
    expect(testIntegrityRun([run(), again], HEAD, files, 'main')).toMatchObject({
      reason: expect.stringContaining('failure'),
    });
  });

  it('waits while the latest run of GitHub Actions for the head is unfinished, a queued re-run with no start included', () => {
    const rerun = run({ id: 2, status: 'queued', conclusion: null, started_at: null });
    for (const done of [run(), run({ conclusion: 'failure' })])
      expect(testIntegrityRun([done, rerun], HEAD, files, 'main')).toEqual({
        reason: 'test integrity is still running at aaaaaaa',
        pending: true,
      });
    // Only the latest attempt counts: an older one left queued or unclosed is no wait once a newer one has completed.
    for (const status of ['queued', 'in_progress']) {
      const stale = run({ status, conclusion: null, started_at: '2026-11-04T12:00:00Z' });
      expect(testIntegrityRun([stale, run({ id: 2 })], HEAD, files, 'main')).toEqual({ run: run({ id: 2 }) });
      expect(testIntegrityRun([run({ id: 2, conclusion: 'failure' }), stale], HEAD, files, 'main')).toEqual({
        reason: "test integrity's run at aaaaaaa is failure, not a success",
      });
    }
    // Once the latest has completed, it is the reading, by its id whatever the starts say.
    const later = run({ id: 3, started_at: '2026-11-04T12:00:00Z', conclusion: 'failure' });
    expect(testIntegrityRun([later, run()], HEAD, files, 'main')).toMatchObject({
      reason: expect.stringContaining('failure'),
    });
    const sameStart = run({ id: 4, conclusion: 'cancelled' });
    expect(testIntegrityRun([run(), sameStart], HEAD, files, 'main')).toMatchObject({
      reason: expect.stringContaining('cancelled'),
    });
  });

  it('is no reading when the run is pending, skipped, cancelled, failed, missing or foreign', () => {
    // Queued, in progress or not yet run, it may yet be read: a wait.
    for (const status of ['queued', 'in_progress']) {
      expect(testIntegrityRun([run({ status, conclusion: null })], HEAD, files, 'main')).toEqual({
        reason: 'test integrity is still running at aaaaaaa',
        pending: true,
      });
    }
    for (const conclusion of ['skipped', 'cancelled', 'failure', 'neutral']) {
      expect(testIntegrityRun([run({ conclusion })], HEAD, files, 'main')).toEqual({
        reason: `test integrity's run at aaaaaaa is ${conclusion}, not a success`,
      });
    }
    expect(testIntegrityRun([], HEAD, files, 'main')).toEqual({
      reason: 'test integrity has not run at aaaaaaa',
      pending: true,
    });
    // Posted by another app, the factory's included, which can post check runs of any name: never read, and no reason
    // to stop waiting for GitHub Actions' own.
    const foreign = run({ app: { slug: 'mrogan-software-factory' } });
    expect(testIntegrityRun([foreign], HEAD, files, 'main')).toEqual({
      reason:
        'test integrity has not run at aaaaaaa: only mrogan-software-factory posted a run of that name, not GitHub Actions',
      pending: true,
    });
    expect(testIntegrityRun([{ ...foreign, conclusion: 'failure' }], HEAD, files, 'main')).toMatchObject({
      pending: true,
    });
    // Nor does one still running hold up GitHub Actions' completed run.
    const unfinished = {
      ...foreign,
      id: 9,
      status: 'in_progress',
      conclusion: null,
      started_at: '2026-11-04T12:00:00Z',
    };
    expect(testIntegrityRun([run(), unfinished], HEAD, files, 'main')).toEqual({ run: run() });
    // Another check's name.
    expect(testIntegrityRun([run({ name: 'test integrity' })], HEAD, files, 'main')).toMatchObject({
      reason: expect.any(String),
    });
  });

  it('never reads a run for another commit: in the merge queue, not the queue’s commit’s for the pull request’s head', () => {
    expect(testIntegrityRun([run({ head_sha: QUEUE })], HEAD, files, 'main')).toEqual({
      reason: 'test integrity has not run at aaaaaaa',
      pending: true,
    });
    expect(testIntegrityRun([run({ head_sha: EARLIER })], HEAD, files, 'main')).toMatchObject({
      reason: expect.any(String),
    });
  });

  it('is no reading for a pull request that changes the workflows, whose run is its own copy’s', () => {
    expect(
      testIntegrityRun(
        [run()],
        HEAD,
        [...files, { filename: '.github/workflows/gates.yml', status: 'modified' }],
        'main',
      ),
    ).toEqual({
      reason: "it changes .github/workflows/gates.yml, so test integrity's run is not the workflow on main's",
    });
  });

  it('is no reading for a pull request into another branch, whose run is that branch’s workflow', () => {
    expect(testIntegrityRun([run()], HEAD, files, 'factory/1-fix')).toEqual({
      reason: "it is into factory/1-fix, so test integrity's run is not the workflow on main's",
    });
  });

  it('reads a run only when test integrity’s notice says it judged the pull request, into its base', () => {
    expect(JUDGED.exec(judgedNote(7, 'main'))?.slice(1)).toEqual(['7', 'main']);
    const judged = (number: number, base = 'main') => ({
      path: '.github',
      annotation_level: 'notice',
      message: judgedNote(number, base),
    });
    const excused = { path: 'test/a.test.ts', annotation_level: 'warning', message: 'x' };
    expect(notJudged([judged(7), excused], 7, 'main', HEAD)).toBeUndefined();
    // Another pull request's run at the same head, from another branch, open or closed: its own may yet run again.
    expect(notJudged([judged(8), excused], 7, 'main', HEAD)).toEqual({
      reason: "test integrity's run at aaaaaaa judged #8, not #7",
      pending: true,
    });
    expect(notJudged([judged(7), judged(8)], 7, 'main', HEAD)).toMatchObject({ pending: true });
    // Judged into another base, before a retarget: the run compared with that base's tests.
    expect(notJudged([judged(7, 'dev')], 7, 'main', HEAD)).toEqual({
      reason: "test integrity's run at aaaaaaa judged #7 into dev, not main",
    });
    // Saying nothing of what it judged, as before test integrity wrote the notice, or only in a warning a test name
    // could put the words in: a hold.
    for (const annotations of [[], [excused], [{ ...judged(7), annotation_level: 'warning' }]])
      expect(notJudged(annotations, 7, 'main', HEAD)).toEqual({
        reason: "test integrity's run at aaaaaaa does not say which pull request it judged",
      });
  });

  it('names each test it excused, from the annotation test integrity writes, and counts one it cannot read', () => {
    const note = excusedNote({ test: 'files > keeps nothing', change: 'rewritten' });
    expect(EXCUSED.test(note)).toBe(true);
    expect(
      excusedTests([
        { path: 'test/app.test.ts', annotation_level: 'warning', message: note },
        {
          path: 'test/b.test.ts',
          annotation_level: 'warning',
          message: excusedNote({ test: 'a "quoted" one', change: 'deleted' }),
        },
        { path: 'test/c.test.ts', annotation_level: 'warning', message: 'some other words' },
        // GitHub's own, on the job, and the failures that fail the run anyway.
        { path: '.github', annotation_level: 'warning', message: 'Node.js 20 is deprecated' },
        { path: 'test/d.test.ts', annotation_level: 'failure', message: 'test/d.test.ts was deleted' },
      ]),
    ).toEqual([
      'test/app.test.ts: files > keeps nothing (rewritten)',
      'test/b.test.ts: a "quoted" one (deleted)',
      'test/c.test.ts: a warning the gate cannot read',
    ]);
  });
});

describe('risk tags from the diff', () => {
  const owners = codeOwners(readFileSync('.github/CODEOWNERS', 'utf-8'));
  const appOwners = codeOwners('/.github/ @mrogan\n/deploy/ @mrogan\n/src/flags/ @mrogan\n');
  const tags = (files: FileChange[], over: Partial<Parameters<typeof tagsOf>[0]> = {}) =>
    tagsOf({ files, complete: true, headRef: 'factory/1-fix', owners: appOwners, excused: [], ...over });
  const changed = (filename: string, patch = '+const a = 1;', over: Partial<FileChange> = {}): FileChange => ({
    filename,
    status: 'modified',
    patch,
    ...over,
  });

  it('tags a lockfile or a package manifest, anywhere, a rename’s old name too', () => {
    expect(tags([changed('pnpm-lock.yaml'), changed('apps/x/package.json'), changed('pnpm-workspace.yaml')])).toEqual([
      found('dependency-change', ['pnpm-lock.yaml', 'apps/x/package.json', 'pnpm-workspace.yaml']),
    ]);
    expect(tags([changed('old.json', '', { status: 'renamed', previous_filename: 'package.json' })])[0]?.tag).toBe(
      'dependency-change',
    );
  });

  it('tags a change to where packages come from or what runs as they install: .npmrc and .pnpmfile.cjs, anywhere', () => {
    expect(tags([changed('.npmrc', '+registry=https://example.test/'), changed('apps/x/.pnpmfile.cjs')])).toEqual([
      found('dependency-change', ['.npmrc', 'apps/x/.pnpmfile.cjs']),
    ]);
    // Removed, or with no patch to read, it is tagged by its name all the same.
    expect(tags([changed('.npmrc', '', { status: 'removed', patch: undefined })]).map((t) => t.tag)).toEqual([
      'dependency-change',
    ]);
  });

  it('tags the header settings', () => {
    expect(tags([changed('src/headers.ts', '+x')])).toEqual([found('security-headers', ['src/headers.ts'])]);
  });

  it('tags a line of the app’s code added or removed anywhere that names a security header, in any case', () => {
    expect(
      tags([
        changed(
          'src/app.ts',
          "@@ -1 +1,2 @@\n ok\n+  res.setHeader('Content-Security-Policy', \"default-src 'self'\");",
        ),
      ]),
    ).toEqual([
      found('security-headers', ["src/app.ts: res.setHeader('Content-Security-Policy', \"default-src 'self'\");"]),
    ]);
    for (const line of [
      "-  'x-frame-options': 'DENY',",
      "+  headers['strict-transport-security'] = v;",
      '+import { SECURITY_HEADERS } from "./x.ts";',
      "+  'Cross-Origin-Opener-Policy': 'same-origin',",
    ]) {
      expect(tags([changed('src/pages/home.ts', line)]).map((t) => t.tag)).toEqual(['security-headers']);
    }
    // Not in the app's tests, nor a line both sides share, nor outside src/.
    expect(tags([changed('test/app.test.ts', "+  expect(h['content-security-policy']).toBe('x');")])).toEqual([]);
    expect(tags([changed('src/app.test.ts', "+  expect(h['Content-Security-Policy']).toBe('x');")])).toEqual([]);
    expect(tags([changed('src/app.ts', " res.setHeader('Content-Security-Policy', v);\n+  return 1;")])).toEqual([]);
    expect(tags([changed('docs/headers.md', '+Content-Security-Policy')])).toEqual([]);
    // A file of the app's code GitHub gives no patch of is held as one.
    expect(tags([changed('src/app.html', '', { patch: undefined })]).map((t) => t.tag)).toEqual(['security-headers']);
    // A rename out of the app's code carries the lines it removed there.
    const out = { status: 'renamed', previous_filename: 'src/app.ts' };
    expect(tags([changed('lib/app.ts', "-  res.setHeader('X-Frame-Options', 'DENY');", out)])).toEqual([
      found('security-headers', ["lib/app.ts: res.setHeader('X-Frame-Options', 'DENY');"]),
    ]);
  });

  it('matches each security header by its name, literally', () => {
    for (const name of SECURITY_HEADER_NAMES) {
      expect(tags([changed('src/a.ts', `+  h['${name}'] = v;`)]).map((t) => t.tag)).toEqual(['security-headers']);
    }
    // A name's characters mean nothing to the pattern: a dot is a dot, not any character.
    expect(new RegExp(literally('a.b\\c-d[e]')).test('a.b\\c-d[e]')).toBe(true);
    expect(new RegExp(literally('a.b')).test('axb')).toBe(false);
    expect(new RegExp(literally('a\\d')).test('a1')).toBe(false);
  });

  it('tags the tests test integrity excused', () => {
    expect(tags([changed('test/a.test.ts')], { excused: ['test/a.test.ts: t (deleted)'] })).toEqual([
      found('test-loosening', ['test/a.test.ts: t (deleted)']),
    ]);
  });

  it('tags a path CODEOWNERS on main gives Martin', () => {
    expect(tags([changed('deploy/overlays/local/image/kustomization.yaml'), changed('src/a.ts')])).toEqual([
      found('code-owned', ['deploy/overlays/local/image/kustomization.yaml (/deploy/)']),
    ]);
  });

  it('tags a release: its branch, or its files alone', () => {
    expect(tags([changed('CHANGELOG.md')], { headRef: 'release-please--branches--main' }).map((t) => t.tag)).toEqual([
      'release',
    ]);
    expect(tags([changed('CHANGELOG.md'), changed('.release-please-manifest.json')]).map((t) => t.tag)).toEqual([
      'release',
    ]);
    // A fix that also writes the changelog is no release.
    expect(tags([changed('CHANGELOG.md'), changed('src/a.ts')])).toEqual([]);
  });

  it('tags an improvement: the flag list changed, or an added line of the app’s code that names or asks a flag', () => {
    expect(tags([changed('src/flag-names.ts', "+  'new-thing',")])).toEqual([
      found('improvement', ['src/flag-names.ts']),
    ]);
    for (const line of [
      "+  if (request.flag('checkout-v2')) {",
      '+  const { flag } = request;',
      "+  const on = flags.on('basket');",
      '+  render(page, flag);',
    ]) {
      expect(tags([changed('src/pages/home.ts', `@@ -1,2 +1,3 @@\n context\n${line}`)]).map((t) => t.tag)).toEqual([
        'improvement',
      ]);
    }
    // A removed ask counts too: taking it away gives what it guarded to everyone.
    expect(tags([changed('src/pages/home.ts', "-  if (request.flag('x')) {\n+  return 1;")])).toEqual([
      found('improvement', ["src/pages/home.ts: if (request.flag('x')) {"]),
    ]);
    // A test's line, and a line that asks no flag, are none.
    expect(tags([changed('test/home.test.ts', "+  request.flag('x');")])).toEqual([]);
    expect(tags([changed('src/pages/home.test.ts', "+  request.flag('x');")])).toEqual([]);
    expect(tags([changed('src/pages/home.ts', '+  const flagged = 1;')])).toEqual([]);
    // A file of the app's code with no patch to read is held as one.
    expect(tags([changed('src/pages/big.ts', '', { patch: undefined })]).map((t) => t.tag)).toEqual([
      'security-headers',
      'improvement',
    ]);
    // Removed too: a file too large for a patch could take a flag's ask away unread.
    expect(tags([changed('src/pages/big.ts', '', { status: 'removed', patch: undefined })]).map((t) => t.tag)).toEqual([
      'security-headers',
      'improvement',
    ]);
    // A rename out of the app's code carries the asks it removed there.
    expect(
      tags([
        changed('lib/home.ts', "-  if (request.flag('x')) {", { status: 'renamed', previous_filename: 'src/home.ts' }),
      ]),
    ).toEqual([found('improvement', ["lib/home.ts: if (request.flag('x')) {"])]);
    // A file renamed unchanged has no patch and no line, so it carries only what its names give.
    const renamed = { status: 'renamed', previous_filename: 'src/pages/old.ts', patch: undefined, changes: 0 };
    expect(tags([changed('src/pages/new.ts', '', renamed)])).toEqual([]);
    expect(tags([changed('src/pages/new.ts', '', { ...renamed, changes: 3 })]).map((t) => t.tag)).toEqual([
      'security-headers',
      'improvement',
    ]);
  });

  it('tags as code-owned a diff GitHub could not list whole', () => {
    expect(tags([changed('src/a.ts')], { complete: false })).toEqual([
      found('code-owned', ['more files than GitHub lists: the rest are unread']),
    ]);
  });

  it('names at most a few things for a tag, and counts the rest', () => {
    const many = Array.from({ length: GIVEN_LIMIT + 3 }, (_, i) => changed(`p${i}/package.json`));
    expect(tags(many)[0]).toMatchObject({ tag: 'dependency-change', more: 3 });
  });

  it('reads CODEOWNERS as GitHub does: anchored, by directory, the last match deciding', () => {
    expect(martinsRule(owners, 'apps/factory/src/gates/test-integrity.ts')?.pattern).toBe('/apps/factory/src/gates/');
    expect(martinsRule(owners, '.github/workflows/review.yml')?.pattern).toBe('/.github/');
    expect(martinsRule(owners, 'policy/review-verdict.ts')).toBeDefined();
    expect(martinsRule(owners, 'scripts/review-routing.ts')).toBeDefined();
    expect(martinsRule(owners, 'apps/console/web/src/app.ts')).toBeUndefined();
    const rules = codeOwners(
      '*.md @mrogan\ndocs/** @someone\n/a/b @mrogan # a comment\n/c/ @mrogan\n/c/free.ts\nx?.ts @mrogan',
    );
    expect(martinsRule(rules, 'deep/README.md')).toBeDefined();
    expect(martinsRule(rules, 'docs/x/README.md')).toBeUndefined(); // the later docs/** gives it to someone else
    expect(martinsRule(rules, 'a/b')).toBeDefined();
    expect(martinsRule(rules, 'a/b/c.ts')).toBeDefined();
    expect(martinsRule(rules, 'z/a/b')).toBeUndefined();
    expect(martinsRule(rules, 'c/d/e.ts')).toBeDefined();
    expect(martinsRule(rules, 'c/free.ts')).toBeUndefined(); // no owner: nobody's
    expect(martinsRule(rules, 'c')).toBeUndefined(); // a file named c is not the directory
    expect(martinsRule(rules, 'src/xy.ts')).toBeDefined();
  });
});

describe('an exact pin', () => {
  const digestOf = (c: string) => `sha256:${c.repeat(64)}`;
  const kustomization = `apiVersion: kustomize.config.k8s.io/v1alpha1
kind: Component
images:
- digest: ${digestOf('2')}
  name: console
  newName: ghcr.io/the-roganator/cv-software-factory/console
- digest: ${digestOf('4')}
  name: factory
  newName: ghcr.io/the-roganator/cv-software-factory/factory
`;
  const file = (patch: string, over: Partial<FileChange> = {}): FileChange => ({
    filename: 'deploy/overlays/local/image/kustomization.yaml',
    status: 'modified',
    patch,
    ...over,
  });
  const moved = `@@ -1,6 +1,6 @@\n kind: Component\n images:\n-- digest: ${digestOf('1')}\n+- digest: ${digestOf('2')}\n   name: console\n@@ -7,3 +7,3 @@\n-- digest: ${digestOf('3')}\n+- digest: ${digestOf('4')}\n   name: factory`;
  const commits: Record<string, string> = {
    [digestOf('1')]: EARLIER,
    [digestOf('2')]: HEAD,
    [digestOf('3')]: EARLIER,
    [digestOf('4')]: HEAD,
  };
  const checks = (over: Partial<PinChecks> = {}): PinChecks => ({
    signedAt: async (_repo, _image, digest) => commits[digest] ?? { reason: 'unsigned' },
    ahead: async (_repo, from, to) => from === EARLIER && to === HEAD,
    content: async () => kustomization,
    ...over,
  });

  it('moves only digest values, each in its place', () => {
    expect(digestMoves(file(moved))).toEqual([
      { from: digestOf('1'), to: digestOf('2') },
      { from: digestOf('3'), to: digestOf('4') },
    ]);
  });

  it('is no pin when one changed line is not a digest, or a pin is added, removed or moved', () => {
    const extra = `${moved}\n+  newTag: latest`;
    expect(digestMoves(file(extra))).toEqual({
      reason: 'deploy/overlays/local/image/kustomization.yaml changes a line that is not a digest: +  newTag: latest',
    });
    expect(digestMoves(file(`@@ -1 +1 @@\n-  newName: a\n+  newName: b`))).toMatchObject({
      reason: expect.stringContaining('not a digest'),
    });
    expect(
      digestMoves(
        file(`@@ -1 +1,2 @@\n- digest: ${digestOf('1')}\n+- digest: ${digestOf('2')}\n+- digest: ${digestOf('5')}`),
      ),
    ).toMatchObject({
      reason: expect.stringContaining('adds or removes a pin'),
    });
    expect(digestMoves(file(`@@ -1 +1 @@\n-- digest: ${digestOf('1')}\n+  digest: ${digestOf('2')}`))).toMatchObject({
      reason: expect.stringContaining('to another line'),
    });
    expect(digestMoves(file(moved, { filename: 'apps/x.yaml' }))).toMatchObject({
      reason: expect.stringContaining('not a pin file'),
    });
    expect(digestMoves(file(moved, { status: 'added' }))).toMatchObject({ reason: expect.stringContaining('added') });
    expect(digestMoves(file('', { patch: undefined }))).toMatchObject({ reason: expect.stringContaining('no patch') });
  });

  it('names each pin’s image from the file at the head, and the repository that signs it', () => {
    expect(imageOf(kustomization, digestOf('4'))).toBe('ghcr.io/the-roganator/cv-software-factory/factory');
    expect(imageOf(kustomization, digestOf('9'))).toBeUndefined();
    // A digest two entries share names neither, so a pin is never checked against the other's image.
    expect(imageOf(kustomization.replace(digestOf('2'), digestOf('4')), digestOf('4'))).toBeUndefined();
    expect(signerOf('ghcr.io/the-roganator/cv-software-factory/factory')).toBe(FACTORY_REPO);
    expect(signerOf('ghcr.io/the-roganator/cv-worlds-worst-website')).toBe(APP_REPO);
    expect(signerOf('ghcr.io/aquasecurity/trivy')).toBeUndefined();
    expect(signerOf('ghcr.io/the-roganator/cv-software-factory-private/x')).toBeUndefined();
  });

  it('passes images build.yml signed on main, each from a commit that descends from the one it replaces', async () => {
    expect(await exactPin([file(moved)], checks(), true)).toEqual({
      pins: [
        {
          file: 'deploy/overlays/local/image/kustomization.yaml',
          image: 'ghcr.io/the-roganator/cv-software-factory/console',
          from: digestOf('1'),
          to: digestOf('2'),
        },
        {
          file: 'deploy/overlays/local/image/kustomization.yaml',
          image: 'ghcr.io/the-roganator/cv-software-factory/factory',
          from: digestOf('3'),
          to: digestOf('4'),
        },
      ],
    });
  });

  it('marks a reason for a change of digests alone, and throws a check it could not make', async () => {
    const unsigned = checks({ signedAt: async () => ({ reason: 'unsigned' }) });
    expect(await exactPin([file(moved)], unsigned, true)).toMatchObject({ digests: true });
    expect(await exactPin([file(moved)], checks({ ahead: async () => false }), true)).toMatchObject({ digests: true });
    // Not a pin at all: no mark, so the app's repository judges it by its tags.
    expect(await exactPin([file(`${moved}\n+# a comment`)], checks(), true)).not.toHaveProperty('digests');
    expect(await exactPin([file(moved)], checks(), false)).not.toHaveProperty('digests');
    // A pin's file read, or its image unnamed, is never the reason for a change that is no pin at all.
    let read = 0;
    const counting = checks({
      content: async () => {
        read++;
        return 'images: []';
      },
    });
    const mixed = [file(moved), { filename: 'src/a.ts', status: 'modified', patch: '+const a = 1;' }];
    expect(await exactPin(mixed, counting, true)).toEqual({ reason: 'src/a.ts is not a pin file under deploy/' });
    expect(read).toBe(0);
    // A check that could not be made is no reason: the gate tries again, and says it could not check.
    const down = checks({
      signedAt: async () => {
        throw new Error('ghcr.io answered 503');
      },
    });
    await expect(exactPin([file(moved)], down, true)).rejects.toThrow('ghcr.io answered 503');
  });

  it('is no pin with an unsigned image, a pin that goes backwards, or one line that is not a digest', async () => {
    const unsigned = await exactPin(
      [file(moved)],
      checks({ signedAt: async () => ({ reason: 'cosign does not verify it' }) }),
      true,
    );
    expect(unsigned).toMatchObject({ reason: expect.stringContaining('cosign does not verify it') });
    const back = await exactPin([file(moved)], checks({ ahead: async () => false }), true);
    expect(back).toMatchObject({ reason: expect.stringContaining('does not descend from') });
    expect(await exactPin([file(`${moved}\n+# a comment`)], checks(), true)).toMatchObject({
      reason: expect.stringContaining('not a digest'),
    });
    expect(await exactPin([], checks(), true)).toEqual({ reason: 'it changes no file' });
    // Past what GitHub lists, the files it leaves out could be anything.
    expect(await exactPin([file(moved)], checks(), false)).toEqual({
      reason: 'GitHub lists only some of its files, and the rest are unread',
    });
    const other = kustomization.replace('ghcr.io/the-roganator/cv-software-factory/factory', 'ghcr.io/someone/factory');
    expect(await exactPin([file(moved)], checks({ content: async () => other }), true)).toMatchObject({
      reason: expect.stringContaining("not an image the factory's or the app's build.yml signs"),
    });
  });
});

describe('an earlier pass that stands', () => {
  const PIN_ENTRY = { number: 7, head: HEAD, rule: 'exact-pin' as const, tags: [] };
  const earlier = (judged: Verdict['judged'], commit = QUEUE): Verdict => ({ version: 1, commit, judged });
  const unchecked = route(facts({ pin: { unchecked: 'cosign could not verify it' } }));
  const now = (said = unchecked, number = 7, head = HEAD) => ({ number, head, said });

  it('stands when this run could only fail it for a pin the earlier one checked at the same head', () => {
    expect(stands(earlier([PIN_ENTRY]), QUEUE, [now()])).toBe(true);
    // A stack: one below that passes now, the one above unchecked now and an exact pin then.
    const below = route(facts({ pr: pr(MARTIN) }));
    const both = earlier([{ number: 6, head: EARLIER, rule: 'martin-opened', tags: [] }, PIN_ENTRY]);
    expect(stands(both, QUEUE, [now(below, 6, EARLIER), now()])).toBe(true);
  });

  it('does not stand for anything else', () => {
    // Another commit, another head, another pull request, or one more or fewer.
    expect(stands(earlier([PIN_ENTRY], HEAD), QUEUE, [now()])).toBe(false);
    expect(stands(earlier([{ ...PIN_ENTRY, head: EARLIER }]), QUEUE, [now()])).toBe(false);
    expect(stands(earlier([{ ...PIN_ENTRY, number: 8 }]), QUEUE, [now()])).toBe(false);
    expect(stands(earlier([PIN_ENTRY, { ...PIN_ENTRY, number: 8 }]), QUEUE, [now()])).toBe(false);
    // Passed then by any rule but an exact pin: Martin's approval, since dismissed, says nothing of the pin.
    for (const rule of ['martin-approved-head', 'low-risk', 'lights-out', 'held'] as const)
      expect(stands(earlier([{ ...PIN_ENTRY, rule }]), QUEUE, [now()])).toBe(false);
    // Held now for anything it read, beside the pin it could not check.
    const removed = route(facts({ pin: { unchecked: 'x' }, labelsRemoved: ['test-loosening'] }));
    expect(stands(earlier([PIN_ENTRY]), QUEUE, [now(removed)])).toBe(false);
    const two = earlier([PIN_ENTRY, { ...PIN_ENTRY, number: 8 }]);
    expect(stands(two, QUEUE, [now(), now(route(facts({ unread: 'GET /files: 502' })), 8)])).toBe(false);
    // Its base changed since it opened: the pins at its head were others then.
    const moved = route(facts({ pin: { unchecked: 'x' }, retargeted: true }));
    expect(moved).toMatchObject({ rule: 'held', retargeted: true });
    expect(stands(earlier([PIN_ENTRY]), QUEUE, [now(moved)])).toBe(false);
    // Nothing held now: there is nothing to stand for.
    expect(stands(earlier([PIN_ENTRY]), QUEUE, [now(route(facts({ pr: pr(MARTIN) })))])).toBe(false);
  });
});

describe('the words beside the verdict', () => {
  it('carry what gave each tag as plain text, so a line of the diff cannot open a second verdict', () => {
    const said = route(facts({ tags: [found('improvement', ['src/a.ts: // <!-- review-verdict v1 `x` | y'])] }));
    const text = words(7, said);
    expect(text).toContain("- `improvement`: src/a.ts: // &lt;!-- review-verdict v1 'x' ' y");
    // The title too, which can name a line of the diff.
    const pin = words(7, { ...said, title: 'Not an exact pin: +<!-- review-verdict v1\n`x`' });
    expect(pin).toContain("Not an exact pin: +&lt;!-- review-verdict v1 'x'");
    expect(
      readVerdict(
        `${text}\n\n${verdictBlock({ version: 1, commit: HEAD, judged: [{ number: 7, head: HEAD, rule: said.rule, tags: said.tags }] })}`,
      ),
    ).toMatchObject({ commit: HEAD });
  });
});

describe("the verdict's block, which the line reads", () => {
  const verdict: Verdict = {
    version: 1,
    commit: QUEUE,
    judged: [
      { number: 7, head: HEAD, rule: 'low-risk', tags: [] },
      {
        number: 8,
        head: EARLIER,
        rule: 'held',
        tags: [found('test-loosening', ['test/a.test.ts: --> "a" > b (deleted)'])],
      },
    ],
  };

  it('reads back exactly what the gate wrote, beside any words', () => {
    const summary = `Some words.\n\n${verdictBlock(verdict)}\n\nMore words.`;
    expect(readVerdict(summary)).toEqual(verdict);
    expect(verdictPasses(verdict)).toBe(false);
    expect(verdictPasses({ ...verdict, judged: [verdict.judged[0] as Verdict['judged'][0]] })).toBe(true);
    // Nothing in a name can close the comment early, or open a second block.
    expect(verdictBlock(verdict).slice(0, -4)).not.toContain('-->');
    const opens = {
      ...verdict,
      judged: [{ ...verdict.judged[0], tags: [found('code-owned', ['<!-- review-verdict v1'])] }],
    };
    expect(readVerdict(verdictBlock(opens as Verdict))).toEqual(opens);
  });

  it('carries a pending hold, and reads a block from before it had one', () => {
    const waits: Verdict = {
      ...verdict,
      judged: [{ number: 7, head: HEAD, rule: 'held', tags: [], pending: 'test integrity has not run at aaaaaaa' }],
    };
    expect(readVerdict(verdictBlock(waits))).toEqual(waits);
    expect(verdictPasses(waits)).toBe(false);
    // As a gate without the field wrote it: still version 1, with no pending.
    const old = `<!-- review-verdict v1\n{"commit":"${QUEUE}","judged":[{"number":7,"head":"${HEAD}","rule":"held","tags":[]}]}\n-->`;
    const read = readVerdict(old);
    expect(read).toEqual({ version: 1, commit: QUEUE, judged: [{ number: 7, head: HEAD, rule: 'held', tags: [] }] });
    expect('error' in read || read.judged[0]?.pending).toBeFalsy();
    // Pending only beside held, and only as words.
    const wrong = (pending: unknown, rule = 'held') =>
      readVerdict(verdictBlock({ ...waits, judged: [{ ...waits.judged[0], rule, pending } as Verdict['judged'][0]] }));
    expect(wrong('test integrity has not run', 'low-risk')).toMatchObject({
      error: expect.stringContaining('not held'),
    });
    expect(wrong('')).toMatchObject({ error: expect.stringContaining('is not words') });
    expect(wrong(true)).toMatchObject({ error: expect.stringContaining('is not words') });
    // Bounded: a reason, not a log.
    expect(
      readVerdict(
        verdictBlock({
          ...waits,
          judged: [{ ...waits.judged[0], pending: 'x'.repeat(PENDING_LIMIT) } as Verdict['judged'][0]],
        }),
      ),
    ).not.toHaveProperty('error');
    expect(wrong('x'.repeat(PENDING_LIMIT + 1))).toMatchObject({
      error: expect.stringContaining('over 300 characters'),
    });
    // Counted in code points, as the gate cuts it: a character outside the BMP is one, not two UTF-16 units.
    expect(wrong('🛑'.repeat(PENDING_LIMIT))).not.toHaveProperty('error');
    expect(wrong('🛑'.repeat(PENDING_LIMIT + 1))).toMatchObject({ error: expect.stringContaining('over 300') });
  });

  it('is no verdict when missing, doubled, cut short or wrong in any part', () => {
    const block = verdictBlock(verdict);
    expect(readVerdict(null)).toEqual({ error: 'the summary carries no verdict' });
    expect(readVerdict(`${block}\n${block}`)).toEqual({ error: 'the summary carries more than one verdict' });
    expect(readVerdict(block.slice(0, -4))).toEqual({ error: "the summary's verdict does not end" });
    const wrong = (change: (judged: Record<string, unknown>) => void) => {
      const copy = JSON.parse(JSON.stringify(verdict));
      change(copy.judged[0]);
      return readVerdict(verdictBlock(copy));
    };
    expect(wrong((j) => (j.rule = 'approved'))).toMatchObject({ error: expect.stringContaining('is not a rule') });
    expect(wrong((j) => (j.head = 'abc'))).toMatchObject({ error: expect.stringContaining('is not a commit') });
    expect(wrong((j) => (j.tags = [{ tag: 'risky', because: [] }]))).toMatchObject({
      error: expect.stringContaining('is not a tag'),
    });
    expect(wrong((j) => (j.number = 0))).toMatchObject({ error: 'a verdict names no pull request' });
    expect(readVerdict('<!-- review-verdict v1\n{"commit":"x","judged":[]}\n-->')).toMatchObject({
      error: expect.any(String),
    });
    expect(readVerdict('<!-- review-verdict v1\nnot json\n-->')).toEqual({
      error: "the summary's verdict is not JSON",
    });
  });
});
