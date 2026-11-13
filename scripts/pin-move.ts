/**
 * A pin move (spec 4.3, ADR 0019): whether a pull request of the factory's App in this repository moves one pin of the
 * vulnerability scan's list forward, and nothing else, proved from the pull request itself, so the review gate passes
 * it as `pin-move` (scripts/review-routing.ts). Every condition is a positive proof, in this order, and the first that
 * cannot be proved holds the pull request for Martin, with the reason:
 *
 * 1. **Pins only.** Every file it changes was there before, with its mode, and changes line for line, each line only
 *    in a version or a digest; nothing under `.github/` and neither of mise's files. The change is what the merge makes,
 *    the head merged onto main's tip, against that tip. The list worked out on both (inventory.ts) has the same items at the same places, and differs in one move's pins alone: one image,
 *    one chart or one value of a chart, from one pin to one other. Every line it changes is one of those pins, and
 *    `--unlisted` finds nothing at the head.
 * 2. **Not what judges.** Trivy's, Syft's and Kyverno's own pins are Martin's: what judges a move cannot vouch for its
 *    own replacement, and Kyverno is what says, on the platform check's cluster, that admission enforces.
 * 3. **Signed where its publisher signs.** An image of ours passes only as an exact pin, signed by build.yml on main. A
 *    third-party image is held to its digest alone, as admission admits it (ADR 0010): the next condition's.
 * 4. **Forward on its line.** The gate resolves the target itself, as the scan does (deadlines.ts's `newestOf`): the
 *    same tag at its index digest now, or the newest tag on its line at its index digest now, never a major and never
 *    back; a chart's later version on the same major, in its repository's index.
 * 5. **No record goes stale.** Each refusal record's hash (scripts/policy-hash.ts), computed at the base and at the
 *    head, is the same.
 * 6. **Nothing else that runs changes.** For a chart, a value or an image the cluster runs, the manifests rendered at
 *    the base and at the head, a chart rendered as Argo CD renders it on the cluster `main` describes, compared object by
 *    object, have the same objects (kind, namespace, name: none added, none gone), and differ only in each moved image's
 *    `from` for its `to`, the chart's own version labels moving as the chart's, the `data` of a ConfigMap that was there
 *    at the base, and a pod template's `checksum/` annotations. And the text: every line outside those ConfigMaps'
 *    `data` and those annotations, where the gate's parser places them, is the base's line, in order, with the moved
 *    images' references and the version labels that moved as the chart's written alike. The configuration a chart's
 *    ConfigMaps carry is the publisher's, as its image is; its objects, permissions, pod specs and network policies stay
 *    Martin's.
 * 7. **The scans show it.** The pinned Trivy, on a fresh database, on the image as it was and as it would be, on
 *    linux/amd64 and linux/arm64 each apart: a finding (its advisory and package, never its path) with a fix is gone,
 *    and nothing is new at High or above. An index without a platform, or a scan that read nothing, proves nothing.
 * 8. **Something ran it.** GitHub Actions' latest run at the head of the job that runs what the pin runs succeeded,
 *    not skipped, in this repository's own workflow that has that job, on the pull request: `ZAP scan` for ZAP's image,
 *    `image builds` for a Dockerfile's stage, each shard of `tests` for Postgres, whose pin CI's own database is. What a
 *    cluster runs (a chart, a value, a third-party image in deploy/, Postgres too) passes only once `platform` made a
 *    cluster from the change and everything on it ran; a `platform` skipped made none. Argo CD's chart, which `make up`
 *    installs, is held, and k3s waits for Martin, whose cluster moves with it. Last, so such a hold says every other
 *    condition held.
 *
 * It trusts nothing the pull request says of itself (its title, label, description or branch): the move is worked out
 * from its two commits, and the code that works it out (the list, the policy hash, the Trivy pin) is the gate's own,
 * main's, never the head's. The head is data: its lines are read before anything renders it, and only a change of
 * versions and digests on the base's own lines gets as far as kustomize or Helm. A fact that could not be read (a
 * registry that did not answer, a scan that read nothing, a check skipped rather than succeeded) is no proof: it holds.
 */

import { chartForward, chartImageForward, imageForward, imagePairs } from './pin-move-forward.ts';
import { type Move, oneMove, onlyItsPins, valueTag } from './pin-move-one.ts';
import { PLATFORM_CHECK, ranIt, started, whatRunsIt } from './pin-move-ran.ts';
import type { PinMoveIO, Scan } from './pin-move-readers.ts';
import { manifestsDiffer, versionLabelNamed } from './pin-move-rendering.ts';
import { short } from './pin-move-shared.ts';
import { lineChanges, listMoves, type Moved, placeKey, tagAndDigest } from './pin-move-sides.ts';

// Each job's code is in a file of its own; this one proves the move in the conditions' order, and names them all.
export { chartForward, chartImageForward, imageForward, imagePairs } from './pin-move-forward.ts';
export { type Move, oneMove, onlyItsPins } from './pin-move-one.ts';
export {
  ACTIONS,
  CHECK_WORKFLOW,
  type For,
  IMAGE_CHECK,
  PLATFORM_CHECK,
  PLATFORM_WORKFLOW,
  POSTGRES_FILE,
  patchedByTheCheck,
  type Run,
  ranIt,
  started,
  TEST_SHARDS,
  WORKFLOW_OF,
  type WorkflowRun,
  type Workload,
  whatRunsIt,
  workflowsOf,
  ZAP_CHECK,
  ZAP_FILE,
} from './pin-move-ran.ts';
export {
  hashesOf,
  type PinMoveIO,
  type RealOptions,
  realPinMoveIO,
  removeWork,
  type Scan,
  type Side,
} from './pin-move-readers.ts';
export {
  type ChartVersions,
  comparable,
  comparedLines,
  type ImagePair,
  linesDiffer,
  manifestsDiffer,
  objectsOf,
  placeholders,
  readRendering,
  strangeCharacter,
  versionLabelNamed,
  writtenAlike,
} from './pin-move-rendering.ts';
export {
  type LineChange,
  lineChanges,
  listMoves,
  type Moved,
  onlyPinsChange,
  type Place,
  type Rewritten,
  tagAndDigest,
  type What,
} from './pin-move-sides.ts';

export type PinMoveResult = { move: Move; ran: string[]; fixed: number } | { reason: string };

/** The platforms an image is scanned on: what CI runs (amd64) and what the local cluster runs (arm64). */
export const PLATFORMS = ['linux/amd64', 'linux/arm64'];

/** What judges a move, whose own pins are Martin's to move: none of them can vouch for its replacement. */
const JUDGES: { name: string; test: (moved: Moved) => boolean }[] = [
  // Kyverno is admission itself: on the platform check's cluster it is what says every image policy enforces and
  // `make admission-ready` passes, so it cannot vouch for its own replacement either.
  {
    name: 'Kyverno',
    test: (m) => m.item === 'kyverno' || /(^|\/)kyverno\//.test(m.from),
  },
  {
    name: 'Trivy',
    test: (m) => m.place.file.startsWith('deploy/images/trivy/') || /(^|\/)aquasec(urity)?\/trivy([:@]|$)/.test(m.from),
  },
  {
    name: 'Syft',
    test: (m) => m.place.file.startsWith('deploy/images/syft/') || /(^|\/)anchore\/syft([:@]|$)/.test(m.from),
  },
];

/** The records whose hash differs between the two sides, or a reason when the two do not name the same records. */
export function staleRecords(base: Record<string, string>, head: Record<string, string>): string | undefined {
  const names = Object.keys(base).sort();
  if (!names.length) return 'the gate read no refusal record to hold the change to';
  if (names.join('\n') !== Object.keys(head).sort().join('\n'))
    return 'the head names other refusal records than the base';
  const stale = names.filter((name) => base[name] !== head[name]);
  if (stale.length)
    return `it stales ${stale.map((name) => `deploy/test/${name}.json`).join(', ')}: the policies' hash moves, and a record is taken again on a cluster`;
  return undefined;
}

const HIGH = new Set(['HIGH', 'CRITICAL']);

/** Whether the scans show the move: a finding with a fix gone, and nothing new at High or above, in every image. */
export function scansShow(
  pairs: readonly { from: string; to: string; was: Scan; now: Scan }[],
): { fixed: number } | { reason: string } {
  // Each finding fixed counted once, whichever platforms it was fixed on.
  const gone = new Set<string>();
  for (const { from, to, was, now } of pairs) {
    if (!was.read) return { reason: `the scan of ${short(from)} read nothing` };
    if (!now.read) return { reason: `the scan of ${short(to)} read nothing` };
    // A finding is its advisory and its package, never its path: one still there at another path is not gone.
    const key = (f: Scan['findings'][number]) => `${f.id}\0${f.pkg.split(' ')[0]}`;
    // New is strict: the same advisory in the same package at a path it was not at before is new.
    const where = (f: Scan['findings'][number]) => `${key(f)}\0${f.path ?? ''}`;
    const beforeAt = new Set(was.findings.map(where));
    const after = new Set(now.findings.map(key));
    for (const f of was.findings) if (f.fixed && !after.has(key(f))) gone.add(key(f));
    const brought = now.findings.find((f) => HIGH.has(f.severity.toUpperCase()) && !beforeAt.has(where(f)));
    if (brought) return { reason: `a target that brings a new ${brought.severity.toUpperCase()}: ${short(to)}` };
  }
  if (gone.size === 0) return { reason: 'the scans show no finding with a fix gone: the move fixes nothing' };
  return { fixed: gone.size };
}

/** The pin move a change makes, proved, or the first condition that could not be proved. */
export async function pinMove(reader: PinMoveIO, head: string): Promise<PinMoveResult> {
  // Each chart rendered once on each side: the images it runs and the manifests it makes are read from the same.
  const renders = new Map<string, Promise<string>>();
  const io: PinMoveIO = {
    ...reader,
    render: (side, chart) => {
      const key = JSON.stringify([side, chart]);
      let once = renders.get(key);
      if (!once) {
        once = reader.render(side, chart);
        renders.set(key, once);
      }
      return once;
    },
  };
  // 1. Pins only: the text first, so nothing renders a head that changes more than versions and digests.
  const { raw, files } = await io.diff();
  const changes = lineChanges(raw, files);
  if ('reason' in changes) return changes;
  // Each changed line one of the base's pins before the head is rendered at all: only a pin's line reaches kustomize.
  const base = await io.list('base');
  const pins = new Set(base.flatMap((item) => [placeKey(item), ...(item.pins ?? []).map(placeKey)]));
  const stranger = changes.lines.find((line) => !pins.has(placeKey(line)));
  if (stranger) return { reason: `${placeKey(stranger)} is a line that is not a pin: ${short(stranger.after.trim())}` };
  const now = await io.list('head');
  const listed = listMoves(base, now);
  if ('reason' in listed) return listed;
  const one = oneMove(listed.moved);
  if ('reason' in one) return one;
  const { move } = one;
  const stray = onlyItsPins(changes.lines, move);
  if (stray) return { reason: stray };
  for (const m of move.pins) {
    const line = changes.lines.find((l) => placeKey(l) === placeKey(m.place));
    if (m.what === 'value' && !valueTag(line?.after ?? ''))
      return { reason: `${placeKey(m.place)} writes no tag beside its digest to resolve` };
  }
  const unread = await io.unlisted();
  if (unread.length)
    return {
      reason: `the list does not read ${unread.length} pin${unread.length === 1 ? '' : 's'} at the head: ${short(`${unread[0]?.file}:${unread[0]?.line} ${unread[0]?.reference}`)}`,
    };
  // 2. Not what judges.
  const judge = JUDGES.find((j) => move.pins.some(j.test));
  if (judge)
    return { reason: `${judge.name}'s own pin: what judges cannot vouch for its replacement, so it is Martin's` };
  // 3. Signed where its publisher signs: an image of ours passes as an exact pin, or not at all.
  if (move.what === 'image' && /^ghcr\.io\/the-roganator\//.test(move.from))
    return {
      reason: `${move.name} is an image of ours, which passes only as an exact pin, signed by build.yml on main`,
    };
  // 4. Forward on its line.
  if (move.what === 'chart') {
    const backward = await chartForward(move, io);
    if (backward) return { reason: backward };
  }
  const pairs = await imagePairs(move, io);
  if (typeof pairs === 'string') return { reason: pairs };
  for (const { from, to } of pairs) {
    const backward = move.what === 'chart' ? await chartImageForward(from, to, io) : await imageForward(from, to, io);
    if (backward) return { reason: backward };
  }
  // 5. No record goes stale.
  const [hashBase, hashHead] = await Promise.all([io.hashes('base'), io.hashes('head')]);
  const stale = staleRecords(hashBase, hashHead);
  if (stale) return { reason: stale };
  // 6. Nothing else that runs changes: a chart's or a value's chart rendered, or the overlay for an image in deploy/.
  const chart = move.pins[0]?.chart;
  if (chart || move.pins.some((m) => m.place.file.startsWith('deploy/'))) {
    const [was, after] = chart
      ? await Promise.all([io.render('base', chart.base), io.render('head', chart.head)])
      : await Promise.all([io.overlay('base'), io.overlay('head')]);
    const versions = chart && { chart: chart.base.chart, from: chart.base.version, to: chart.head.version };
    const differ = manifestsDiffer(was, after, pairs, versions);
    if (differ) return { reason: differ };
    // What main's own manifests select by: a chart's version labels moving would move its pods out from under them.
    if (versions && versions.from !== versions.to) {
      const named = versionLabelNamed(await io.overlay('base'));
      if (named) return { reason: `${named} in deploy/, and the chart's version labels change` };
    }
  }
  // 7. The scans show it.
  // Each platform we run apart, so a High new on one is never hidden by the other's findings.
  const scanned = await Promise.all(
    pairs.flatMap(({ from, to }) =>
      PLATFORMS.map(async (platform) => ({
        from: `${from} (${platform})`,
        to: `${to} (${platform})`,
        was: await io.scan(from, platform),
        now: await io.scan(to, platform),
      })),
    ),
  );
  const shown = scansShow(scanned);
  if ('reason' in shown) return shown;
  // 8. Something ran it, last: a pin a cluster runs waiting on `platform` is held so with every other condition
  // proved, and its hold then says that the check is all it waits for.
  const runs = whatRunsIt(move);
  if ('reason' in runs) return runs;
  if (runs.checks.includes(PLATFORM_CHECK)) {
    const rendered = chart ? await io.render('head', chart.head) : await io.overlay('head');
    const patched = await io.patched();
    if (typeof patched === 'string') return { reason: patched };
    const unstarted = started(
      rendered,
      pairs.map(({ to }) => to),
      patched,
    );
    if (unstarted) return { reason: unstarted };
  }
  const notRun = ranIt(await io.runs(), head, runs.checks);
  if (notRun) return { reason: notRun };
  return { move, ran: runs.checks, fixed: shown.fixed };
}

/** A pin move's verdict, in one line. */
export function moveTitle(result: { move: Move; ran: string[]; fixed: number }) {
  const { move, ran, fixed } = result;
  const to =
    move.what === 'image'
      ? (tagAndDigest(move.to).tag ?? move.to.slice(0, 19))
      : move.what === 'value'
        ? move.to.slice(0, 19)
        : move.to;
  const by = [...new Set(ran.map((r) => (r.startsWith('tests (') ? 'tests' : r)))].join(' and ');
  return `A pin move of ${move.name} to ${to}, forward on its line: ${fixed} finding${fixed === 1 ? '' : 's'} with a fix gone, none new at High, ${by} ran it`;
}
