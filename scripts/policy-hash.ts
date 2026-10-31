/**
 * The policies and Roles a refusal record was taken against, as one hash, so that a record outlives no change to them:
 * a policy loosened without its script run again fails `make check`, and a proof taken against the cluster names what
 * it proved.
 *
 *     node scripts/policy-hash.ts <record>   checks that the cluster runs what deploy/ renders of the record's objects,
 *                                            and prints {"policyHash", "policies", "revision"}, which the record's
 *                                            script keeps beside its answers; fails, saying why, if it does not
 *
 * `policyHash()` is sha256 over a canonical form of the objects: each as deploy/ renders it for the profile the
 * cluster runs (`kustomize build deploy/overlays/local`), its kind, name and namespace and every field but its
 * metadata and status, keys sorted, objects in order of kind, namespace and name; a ClusterRole keeps its labels too,
 * as an `aggregate-to-*` label grants its rules to every holder of the role it names. What the API server and Argo CD
 * add (defaults, uid, resourceVersion, managedFields, Argo CD's tracking annotation, status) is not deploy/'s, and
 * does not count. The tests compute it from the rendered manifests and hold each record to it
 * (refusal-records.test.ts).
 *
 * The script's check is what makes the hash the cluster's as well as deploy/'s. Each object must be there, with every
 * field deploy/ gives it as deploy/ gives it; no one but Argo CD may have written any of its fields (its
 * managedFields), but the status and, a ClusterRole's labels apart, the metadata; Argo CD's root Application must
 * report it Synced; and deploy/ at the revision root is synced to must render it as this checkout does. The first
 * catches a field changed by hand on the cluster; the second a field added by hand, which the first cannot see and
 * Argo CD does not count as a difference; the last a checkout whose policies differ from those the cluster was synced
 * to, whose hash would name policies the answers were not given by. A record that names every NetworkPolicy (egress)
 * also stops on one the cluster holds that deploy/ does not render, which could close a fence deploy/ leaves open;
 * only Argo CD's own, from `make up`'s chart, are let be. A change elsewhere in deploy/, such as a comment, is no
 * difference.
 * `KUBE_CONTEXT` names the cluster (`k3d-software-factory` by default).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseAllDocuments, stringify } from 'yaml';

/** The profile the cluster runs, whose rendering a record's hash is of. */
export const PROFILE = 'local';

/** An object a record names: by kind, namespace and name; with no name, every one of that kind the profile renders. */
export interface Named {
  kind: string;
  namespace?: string;
  name?: string;
}

/** A manifest as rendered or read from the cluster. */
export interface Resource {
  apiVersion?: string;
  kind?: string;
  metadata?: { name?: string; namespace?: string; [key: string]: unknown };
  [field: string]: unknown;
}

const policy = (kind: string, name: string): Named => ({ kind, name });
/** A ValidatingAdmissionPolicy and the binding that puts it in force, which Kustomize names alike. */
const admission = (name: string): Named[] => [
  policy('ValidatingAdmissionPolicy', name),
  policy('ValidatingAdmissionPolicyBinding', name),
];
/** A Role and its RoleBinding, named alike. */
const role = (namespace: string, name: string): Named[] => [
  { kind: 'Role', namespace, name },
  { kind: 'RoleBinding', namespace, name },
];

/**
 * What each record's answers depend on. A record that asks as a service account names every Role bound to it in the
 * namespace it asks in, since RBAC grants what any of them does (the test checks none is missing); one that asks as
 * the local kubeconfig's user, or impersonates Argo CD or `system:masters`, which RBAC lets do anything, names its
 * policies alone.
 */
export const RECORDS = {
  'admission-refusals': ['factory', 'website', 'scoreboard', 'flagd'].map((copy) =>
    policy('ImageValidatingPolicy', `${copy}-images`),
  ),
  // Each judges the IngressRoutes the other's script sends, so both records name both.
  'route-refusals': [policy('ValidatingPolicy', 'website-routes'), policy('ValidatingPolicy', 'website-mark')],
  'mark-refusals': [policy('ValidatingPolicy', 'website-routes'), policy('ValidatingPolicy', 'website-mark')],
  'rollout-refusals': [
    ...admission('website-rollout-controls'),
    ...role('website', 'admin-controls-release'),
    ...role('website', 'admin-finds-app-pods'),
  ],
  'flags-refusals': admission('flagd-flags'),
  'flag-stages-refusals': [
    ...admission('flagd-flag-stages'),
    // The admin service's, and the line's and flagd's, who are asked to stage a flag too.
    ...role('flagd', 'admin-stages-flags'),
    ...role('flagd', 'line-reads-flags'),
    ...role('flagd', 'line-reads-admission'),
    ...role('flagd', 'flagd-reads-flags'),
  ],
  'share-key-refusals': admission('website-share-key'),
  // scripts/egress.sh: every fence, and every Role of ours, which its questions of who may read the scoreboard's
  // Secrets are answered from (with the charts' own, which deploy/ does not render).
  egress: ['NetworkPolicy', 'Role', 'RoleBinding', 'ClusterRole', 'ClusterRoleBinding'].map((kind) => ({ kind })),
} satisfies Record<string, Named[]>;

export type RecordName = keyof typeof RECORDS;

/** How an object is named in a record: `Role website/admin-controls-release`, `ValidatingPolicy website-routes`. */
export const nameOf = (o: Resource) =>
  `${o.kind} ${o.metadata?.namespace ? `${o.metadata.namespace}/` : ''}${o.metadata?.name}`;

/** The objects a record names, from these manifests, in the canonical order; throws if one named is not there. */
export function named(record: RecordName, manifests: Resource[]): Resource[] {
  const found = new Map<string, Resource>();
  for (const want of RECORDS[record] as Named[]) {
    const matches = manifests.filter(
      (m) =>
        m.kind === want.kind &&
        (want.namespace === undefined || m.metadata?.namespace === want.namespace) &&
        (want.name === undefined || m.metadata?.name === want.name),
    );
    if (want.name !== undefined && matches.length !== 1) {
      throw new Error(
        `${want.kind} ${want.namespace ? `${want.namespace}/` : ''}${want.name}: ${matches.length} found`,
      );
    }
    for (const m of matches) found.set(nameOf(m), m);
  }
  return [...found.values()].sort(byOrder);
}
const order = (o: Resource) => `${o.kind}\u0000${o.metadata?.namespace ?? ''}\u0000${o.metadata?.name}`;
const byOrder = (a: Resource, b: Resource) => (order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : 0);

/** Nulls dropped (the API server keeps none), and every object's keys sorted, recursively. */
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== null && v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, sorted(v)]),
    );
  }
  return value;
}

/**
 * An object as the hash reads it: its kind, name and namespace, and every field but its metadata and status; and a
 * ClusterRole's labels, which aggregate its rules into another's.
 */
export function canonical(o: Resource): Resource {
  const { metadata, status: _status, ...fields } = o;
  const { name, namespace, labels } = metadata ?? {};
  const kept = { name, ...(namespace ? { namespace } : {}), ...(o.kind === 'ClusterRole' && labels ? { labels } : {}) };
  return sorted({ ...fields, metadata: kept }) as Resource;
}

/** Argo CD's writers: its application controller, by the name each version of it gives. */
const ARGO_CD = new Set(['argocd-controller', 'argocd-application-controller']);

/** A managedFields entry, as the API server keeps one. */
interface Managed {
  manager?: string;
  subresource?: string;
  fieldsV1?: Record<string, unknown>;
}

/**
 * The fields under a managedFields entry's `fieldsV1` that `want` does not give, each as its path: `f:<name>` a field,
 * `k:{...}` the item of a list with those keys, `v:<value>` the item of a set, `.` the item itself.
 */
export function beyond(fields: unknown, want: unknown, at = ''): string[] {
  if (!fields || typeof fields !== 'object') return [];
  return Object.entries(fields).flatMap(([key, inner]) => {
    if (key === '.') return [];
    const path = `${at}/${key}`;
    let next: unknown;
    if (key.startsWith('f:')) {
      next =
        want && typeof want === 'object' && !Array.isArray(want)
          ? (want as Record<string, unknown>)[key.slice(2)]
          : undefined;
    } else if (key.startsWith('k:') && Array.isArray(want)) {
      const keys = JSON.parse(key.slice(2)) as Record<string, unknown>;
      next = want.find(
        (item) =>
          item &&
          typeof item === 'object' &&
          Object.entries(keys).every(([k, v]) => (item as Record<string, unknown>)[k] === v),
      );
    } else if (key.startsWith('v:') && Array.isArray(want)) {
      const value = JSON.parse(key.slice(2)) as unknown;
      next = want.find((item) => JSON.stringify(item) === JSON.stringify(value));
    }
    if (next === undefined) return [path];
    return beyond(inner, next, path);
  });
}

/**
 * What a writer other than Argo CD holds of the live object that deploy/ does not give it: a field added by hand,
 * which comparing the fields deploy/ gives cannot see, and Argo CD does not count as a difference. A field deploy/
 * gives is held to deploy/'s value by `differences()`, whoever wrote it last, as on a cluster once applied by hand. The
 * status, a subresource, is its controller's; the metadata is not read, but a ClusterRole's labels.
 */
export function writers(live: Resource, want: Resource): string[] {
  const { metadata, ...form } = canonical(want);
  return ((live.metadata?.managedFields ?? []) as Managed[])
    .filter((m) => !m.subresource && !ARGO_CD.has(m.manager ?? ''))
    .flatMap((m) => {
      const { 'f:metadata': meta, ...fields } = m.fieldsV1 ?? {};
      const added = beyond(fields, form);
      if (live.kind === 'ClusterRole' && meta && typeof meta === 'object' && 'f:labels' in meta) {
        added.push(...beyond({ 'f:labels': (meta as Record<string, unknown>)['f:labels'] }, metadata, '/f:metadata'));
      }
      return added.length
        ? [`${added.join(', ')}, written by ${m.manager ?? 'an unnamed manager'}, not deploy/'s`]
        : [];
    });
}

/** sha256 over the canonical form of these objects, in the canonical order, as 64 lower-case hex digits. */
export function policyHash(objects: Resource[]): string {
  const forms = [...objects].sort(byOrder).map(canonical);
  return createHash('sha256').update(JSON.stringify(forms)).digest('hex');
}

/** What a record keeps of the objects it was taken against. */
export interface Taken {
  policyHash: string;
  policies: string[];
}

/** The hash and names a record keeps, from these manifests. */
export function taken(record: RecordName, manifests: Resource[]): Taken {
  const objects = named(record, manifests);
  return { policyHash: policyHash(objects), policies: objects.map(nameOf) };
}

/**
 * Where the live object differs from what deploy/ gives it: each field deploy/ sets, at its path, that the cluster
 * does not hold as set. A field the cluster adds is not deploy/'s, and not a difference; an empty object or list deploy/
 * sets may be left out, as the API server leaves one out.
 */
export function differences(want: unknown, live: unknown, path = ''): string[] {
  if (want === null || want === undefined) return [];
  if (Array.isArray(want)) {
    if (live === undefined && want.length === 0) return [];
    if (!Array.isArray(live) || live.length !== want.length) return [`${path || '/'}: ${JSON.stringify(live)}`];
    return want.flatMap((w, i) => differences(w, live[i], `${path}/${i}`));
  }
  if (typeof want === 'object') {
    if (live === undefined && Object.keys(want).length === 0) return [];
    if (!live || typeof live !== 'object' || Array.isArray(live)) return [`${path || '/'}: ${JSON.stringify(live)}`];
    return Object.entries(want).flatMap(([k, w]) =>
      differences(w, (live as Record<string, unknown>)[k], `${path}/${k}`),
    );
  }
  return want === live ? [] : [`${path}: ${JSON.stringify(live)}, not ${JSON.stringify(want)}`];
}

const ROOT = join(import.meta.dirname, '..');

/** Every manifest the profile renders, as Argo CD's root Application renders it. */
export function render(profile = PROFILE, root = ROOT): Resource[] {
  const out = execFileSync('kustomize', ['build', join(root, 'deploy', 'overlays', profile)], {
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return parseAllDocuments(out)
    .map((doc) => doc.toJS() as Resource | null)
    .filter((m): m is Resource => !!m?.kind);
}

/** What deploy/ renders at a commit of this repository, or why it cannot be rendered. */
function renderAt(commit: string): Resource[] | string {
  if (spawnSync('git', ['-C', ROOT, 'cat-file', '-e', `${commit}^{commit}`]).status !== 0) {
    return `Argo CD's root is synced to ${commit}, which this checkout does not have: git fetch`;
  }
  const dir = mkdtempSync(join(tmpdir(), 'policy-hash-'));
  try {
    execFileSync('sh', ['-c', 'git -C "$1" archive "$2" deploy | tar -x -C "$3"', 'sh', ROOT, commit, dir]);
    return render(PROFILE, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Argo CD's own fences, which `make up` installs with its chart, and deploy/ does not render. */
const argoCdsOwn = (o: Resource) => {
  const labels = (o.metadata?.labels ?? {}) as Record<string, string>;
  return (
    o.metadata?.namespace === 'argocd' &&
    labels['app.kubernetes.io/managed-by'] === 'Helm' &&
    labels['app.kubernetes.io/instance'] === 'argocd'
  );
};

/** Why the cluster does not run these objects as this checkout renders them: nothing, if it does. */
function unlike(context: string, record: RecordName, objects: Resource[]): { problems: string[]; revision?: string } {
  const kubectl = (args: string[], input?: string) =>
    spawnSync('kubectl', ['--context', context, ...args], { input, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
  const problems: string[] = [];

  // Each object as the cluster holds it, read at the version deploy/ writes it in, with who wrote each field.
  const got = kubectl(
    ['get', '-f', '-', '-o', 'json', '--ignore-not-found', '--show-managed-fields'],
    objects.map((o) => stringify(o)).join('---\n'),
  );
  if (got.status !== 0) return { problems: [`the cluster could not give them: ${got.stderr.trim()}`] };
  const read = (got.stdout.trim() ? JSON.parse(got.stdout) : { items: [] }) as Resource & { items?: Resource[] };
  const live = new Map((read.items ?? [read]).map((o) => [nameOf(o), o]));
  for (const o of objects) {
    const held = live.get(nameOf(o));
    if (!held) problems.push(`${nameOf(o)}: not on the cluster`);
    else {
      for (const d of differences(canonical(o), held)) problems.push(`${nameOf(o)}: ${d}`);
      for (const w of writers(held, o)) problems.push(`${nameOf(o)}: ${w}`);
    }
  }

  // A fence the cluster holds that deploy/ does not render, for a record that names them all.
  if ((RECORDS[record] as Named[]).some((n) => n.kind === 'NetworkPolicy' && n.name === undefined)) {
    const all = kubectl(['get', 'networkpolicies', '-A', '-o', 'json']);
    if (all.status !== 0) problems.push(`the cluster could not list its NetworkPolicies: ${all.stderr.trim()}`);
    else {
      const ours = new Set(objects.filter((o) => o.kind === 'NetworkPolicy').map(nameOf));
      for (const o of (JSON.parse(all.stdout) as { items: Resource[] }).items) {
        if (!ours.has(nameOf({ ...o, kind: 'NetworkPolicy' })) && !argoCdsOwn(o)) {
          problems.push(`NetworkPolicy ${o.metadata?.namespace}/${o.metadata?.name}: on the cluster, not in deploy/`);
        }
      }
    }
  }

  // Argo CD's word that nothing was added to them, at a revision whose deploy/ is this checkout's.
  const app = kubectl(['-n', 'argocd', 'get', 'application', 'root', '-o', 'json']);
  if (app.status !== 0) return { problems: [...problems, `Argo CD's root Application: ${app.stderr.trim()}`] };
  const root = JSON.parse(app.stdout) as {
    status?: {
      sync?: { revision?: string };
      resources?: { kind: string; namespace?: string; name: string; status?: string }[];
    };
  };
  for (const o of objects) {
    const resource = root.status?.resources?.find(
      (r) => r.kind === o.kind && r.name === o.metadata?.name && (r.namespace || '') === (o.metadata?.namespace ?? ''),
    );
    if (resource?.status !== 'Synced') problems.push(`${nameOf(o)}: ${resource?.status ?? 'not'} in Argo CD's root`);
  }
  const revision = root.status?.sync?.revision;
  if (!revision) problems.push("Argo CD's root has synced no revision");
  else {
    const synced = renderAt(revision);
    if (typeof synced === 'string') problems.push(synced);
    else {
      let there: Resource[] | string;
      try {
        there = named(record, synced);
      } catch (error) {
        there = (error as Error).message;
      }
      if (typeof there === 'string') problems.push(`${revision}, which Argo CD's root is synced to, renders ${there}`);
      else if (policyHash(there) !== policyHash(objects)) {
        problems.push(`deploy/ here renders them otherwise than ${revision} does, which Argo CD's root is synced to`);
      }
    }
  }
  return { problems, ...(revision && { revision }) };
}

if (import.meta.main) {
  const record = process.argv[2] as RecordName;
  if (!(record in RECORDS)) {
    console.error(`usage: node scripts/policy-hash.ts <${Object.keys(RECORDS).join(' | ')}>`);
    process.exit(2);
  }
  const context = process.env.KUBE_CONTEXT ?? 'k3d-software-factory';
  const manifests = render();
  const { problems, revision } = unlike(context, record, named(record, manifests));
  if (problems.length) {
    console.error(`The cluster does not run what deploy/ renders for ${record}, so its hash would not be theirs:`);
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }
  console.log(JSON.stringify({ ...taken(record, manifests), revision }));
}
