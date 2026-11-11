/**
 * The images the cluster runs, compared with the scan's list: a pure function of the two, so the same pods and the same
 * lists always give the same rows. Each row says the list or the cluster is wrong:
 *
 * - `unscanned-digest`: a container runs a reference the list has, at a digest the scan never read. A tag rebuilt
 *   upstream since the scan, or since the pod pulled it, is one.
 * - `unlisted-image`: a container runs an image the list does not have: no item of either repository names its
 *   repository, or one does at another reference while every reference the list has of it is running.
 * - `not-running`: a pin `main` holds that the cluster does not run yet, while it runs another reference of the same
 *   image instead: Argo CD after a merge, a k3s move not yet applied. A pin of an image no pod runs at all is no row,
 *   since an image may run only now and then (a runner's, a Job's).
 *
 * A reference is compared by its repository, normalised as Docker does (`postgres` is `docker.io/library/postgres`), and
 * then by its digest when the pod names one, or else by its tag. A pod's digest may be its index's or a platform's
 * manifest's, so the list gives every digest the scan saw of each image.
 */
import type { Kind } from '../vulnerabilities/inventory.ts';
import type { Pin } from '../vulnerabilities/moves.ts';
import type { RunningContainer } from './running.ts';

/** An image the scan read, as `moves.json` lists it (`scanned`). */
export interface ScannedImage {
  kind: Kind;
  /** The list's item, as it names it. */
  item: string;
  /** The reference the scan read, as pinned or rendered. */
  image: string;
  /** Every digest the scan saw for it: the index's, and each platform manifest's. */
  digests: string[];
  pin: Pin;
}

/** The list of one repository: its images, by the repository that pins them. */
export interface Listed {
  repository: string;
  scanned: ScannedImage[];
}

/** The kinds of item a pod of the cluster runs: the overlay's images, a chart's, and k3s's own. */
const RUN_IN_THE_CLUSTER: ReadonlySet<Kind> = new Set<Kind>(['ours', 'third-party', 'chart', 'k3s-release']);

export type Row =
  | ({ row: 'unscanned-digest'; image: string; digest: string; repository: string; item: string; pin: Pin } & Where)
  | ({ row: 'unlisted-image'; image: string; digest: string } & Where)
  | {
      row: 'not-running';
      repository: string;
      item: string;
      image: string;
      pin: Pin;
      running: (Where & { image: string })[];
    };

interface Where {
  namespace: string;
  pod: string;
  container: string;
}

/** A reference's parts, as Docker reads one. */
export interface Reference {
  repository: string;
  tag?: string | undefined;
  digest?: string | undefined;
}

/** `postgres:17@sha256:…` as `{ repository: 'docker.io/library/postgres', tag: '17', digest: 'sha256:…' }`. */
export function parseReference(reference: string): Reference {
  const [named = '', digest] = reference.split('@');
  const slash = named.lastIndexOf('/');
  const colon = named.lastIndexOf(':');
  const tag = colon > slash ? named.slice(colon + 1) : undefined;
  let repository = colon > slash ? named.slice(0, colon) : named;
  const [first = '', ...rest] = repository.split('/');
  const registry = rest.length > 0 && (first.includes('.') || first.includes(':') || first === 'localhost');
  if (!registry) repository = `docker.io/${rest.length ? repository : `library/${repository}`}`;
  else if (first === 'index.docker.io') repository = `docker.io/${rest.join('/')}`;
  return { repository: repository.toLowerCase(), tag, digest };
}

/** Whether a container runs the reference an image of the list names. */
function runs(container: RunningContainer, ran: Reference, image: ScannedImage, listed: Reference) {
  if (ran.repository !== listed.repository) return false;
  if (ran.digest) return ran.digest === listed.digest || image.digests.includes(ran.digest);
  if (listed.digest) return image.digests.includes(container.digest);
  return (ran.tag ?? 'latest') === (listed.tag ?? 'latest');
}

const where = ({ namespace, pod, container }: RunningContainer): Where => ({ namespace, pod, container });

const key = (row: Row) =>
  row.row === 'not-running'
    ? `2 ${row.repository} ${row.pin.file} ${String(row.pin.line).padStart(6, '0')} ${row.image}`
    : `${row.row === 'unscanned-digest' ? 0 : 1} ${row.namespace} ${row.pod} ${row.container}`;

/** Every row the cluster's containers and the lists make, in a fixed order. */
export function compare(containers: RunningContainer[], lists: Listed[]): Row[] {
  const images = lists.flatMap(({ repository, scanned }) =>
    scanned.map((image) => ({ repository, image, ref: parseReference(image.image) })),
  );
  const ranBy = new Map<(typeof images)[number], RunningContainer[]>();
  const unmatched: RunningContainer[] = [];
  const rows: Row[] = [];

  for (const container of containers) {
    const ran = parseReference(container.image);
    const matches = images.filter(({ image, ref }) => runs(container, ran, image, ref));
    if (!matches.length) {
      unmatched.push(container);
      continue;
    }
    for (const match of matches) ranBy.set(match, [...(ranBy.get(match) ?? []), container]);
    const seen = matches.some(({ image }) => image.digests.includes(container.digest));
    const first = matches[0];
    if (!seen && first)
      rows.push({
        row: 'unscanned-digest',
        ...where(container),
        image: container.image,
        digest: container.digest,
        repository: first.repository,
        item: first.image.item,
        pin: first.image.pin,
      });
  }

  // A listed image no pod runs, while pods run its repository at a reference the list does not have: the cluster has
  // not moved to the pin yet. Those pods are explained by it; any others are running what the list lacks.
  const explained = new Set<RunningContainer>();
  for (const listed of images) {
    if (!RUN_IN_THE_CLUSTER.has(listed.image.kind) || ranBy.has(listed)) continue;
    const instead = unmatched.filter((c) => parseReference(c.image).repository === listed.ref.repository);
    if (!instead.length) continue;
    for (const c of instead) explained.add(c);
    rows.push({
      row: 'not-running',
      repository: listed.repository,
      item: listed.image.item,
      image: listed.image.image,
      pin: listed.image.pin,
      running: instead.slice(0, 20).map((c) => ({ ...where(c), image: c.image })),
    });
  }
  for (const container of unmatched) {
    if (explained.has(container)) continue;
    // An image of a repository the list names at other references only, or of none: the list does not have it.
    rows.push({ row: 'unlisted-image', ...where(container), image: container.image, digest: container.digest });
  }
  return rows.sort((a, b) => key(a).localeCompare(key(b)));
}
