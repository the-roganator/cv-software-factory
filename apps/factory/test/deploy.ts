import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, parseAllDocuments } from 'yaml';

/**
 * deploy/ as the tests read it: its files as written, overlays too, not as `kustomize build` would render them, so an
 * overlay's own rules are checked as well as the base's.
 */
export const DEPLOY = fileURLToPath(new URL('../../../deploy/', import.meta.url));

/** Prometheus's server, as a network policy's peer: the one pod every fence around what it scrapes lets in. */
export const PROMETHEUS = {
  namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'telemetry' } },
  podSelector: { matchLabels: { 'app.kubernetes.io/name': 'prometheus', 'app.kubernetes.io/component': 'server' } },
};

/** One of Prometheus's relabelling rules, as a scrape job's `metric_relabel_configs` lists them. */
export interface Relabel {
  source_labels?: string[];
  regex?: string;
  action?: string;
  target_label?: string;
  replacement?: string;
}

/**
 * What Prometheus's metric relabelling makes of a series, or undefined if it drops it, for the actions deploy/ uses:
 * `drop`, `labeldrop` and `replace` (with a fixed replacement). Prometheus anchors a regex at both ends. Any other
 * action throws, so a rule the simulation does not know is never read as keeping a series.
 */
export function relabel(rules: Relabel[], series: Record<string, string>): Record<string, string> | undefined {
  let labels: Record<string, string> = { ...series };
  for (const rule of rules) {
    const regex = new RegExp(`^(?:${rule.regex ?? '(.*)'})$`);
    const value = (rule.source_labels ?? []).map((label) => labels[label] ?? '').join(';');
    const action = rule.action ?? 'replace';
    if (action === 'drop') {
      if (regex.test(value)) return undefined;
    } else if (action === 'labeldrop') {
      labels = Object.fromEntries(Object.entries(labels).filter(([label]) => !regex.test(label)));
    } else if (action === 'replace') {
      if (regex.test(value) && rule.target_label) labels = { ...labels, [rule.target_label]: rule.replacement ?? '$1' };
    } else {
      throw new Error(`The relabelling simulation does not know the ${action} action`);
    }
  }
  return labels;
}

/** What every manifest has; each test names the rest of what it reads. */
export interface Manifest {
  kind?: string;
  metadata?: { name?: string; namespace?: string };
}

/**
 * Every manifest under deploy/, from every YAML file, each with its file and its namespace: its directory's
 * kustomization's, or else its own.
 */
export async function manifests<M extends Manifest = Manifest>(): Promise<
  { file: string; namespace?: string; manifest: M }[]
> {
  const files = (await readdir(DEPLOY, { recursive: true })).filter((f) => f.endsWith('.yaml'));
  const namespaces = new Map<string, string | undefined>();
  for (const file of files.filter((f) => f.endsWith('kustomization.yaml'))) {
    const kustomization = parse(await readFile(join(DEPLOY, file), 'utf-8')) as { namespace?: string };
    namespaces.set(dirname(file), kustomization.namespace);
  }
  const all: { file: string; namespace?: string; manifest: M }[] = [];
  for (const file of files) {
    for (const doc of parseAllDocuments(await readFile(join(DEPLOY, file), 'utf-8'))) {
      const manifest = doc.toJS() as M | null;
      if (!manifest?.kind) continue;
      const namespace = namespaces.get(dirname(file)) ?? manifest.metadata?.namespace;
      all.push({ file, manifest, ...(namespace ? { namespace } : {}) });
    }
  }
  return all;
}

/**
 * Every manifest each profile's overlay renders, as `make check` renders them with `kustomize build` and Argo CD
 * deploys them: what the cluster is given, overlays' patches applied, rather than the files as written.
 */
export function rendered<M extends Manifest = Manifest>(): { overlay: string; manifest: M }[] {
  const overlays = readdirSync(join(DEPLOY, 'overlays'), { withFileTypes: true }).filter((d) => d.isDirectory());
  return overlays.flatMap(({ name: overlay }) =>
    parseAllDocuments(
      execFileSync('kustomize', ['build', join(DEPLOY, 'overlays', overlay)], {
        encoding: 'utf-8',
        maxBuffer: 64 * 1024 * 1024,
      }),
    )
      .map((doc) => doc.toJS() as M | null)
      .filter((manifest): manifest is M => !!manifest?.kind)
      .map((manifest) => ({ overlay, manifest })),
  );
}

/** A Kubernetes label selector, as a NetworkPolicy's pod and namespace selectors have it. */
export interface LabelSelector {
  matchLabels?: Record<string, string>;
  matchExpressions?: { key: string; operator: string; values?: string[] }[];
}

/**
 * Whether a label selector picks out something with these labels, as Kubernetes reads one: every label it names, and
 * every expression. An empty selector, or none, picks out everything. An operator Kubernetes does not have throws, so
 * a selector this cannot read is never taken for one that selects, or one that does not.
 */
export function selects(selector: LabelSelector | undefined, labels: Record<string, string>): boolean {
  const byLabel = Object.entries(selector?.matchLabels ?? {}).every(([key, value]) => labels[key] === value);
  return (
    byLabel &&
    (selector?.matchExpressions ?? []).every(({ key, operator, values = [] }) => {
      if (operator === 'In') return key in labels && values.includes(labels[key] as string);
      if (operator === 'NotIn') return !(key in labels) || !values.includes(labels[key] as string);
      if (operator === 'Exists') return key in labels;
      if (operator === 'DoesNotExist') return !(key in labels);
      throw new Error(`A label selector has no operator ${operator}`);
    })
  );
}
