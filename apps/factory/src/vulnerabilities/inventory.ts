/**
 * The list of what a repository runs or pins, worked out from a checkout of it: each item the daily scan reads, with the
 * file and line of the pin that brings it, where its alerts are located.
 *
 *     node apps/factory/src/vulnerabilities/inventory.ts <checkout> [--json]   the list, as a table or as JSON
 *     node apps/factory/src/vulnerabilities/inventory.ts --unlisted <checkout>  every pin the list does not read
 *
 * It reads, in this order, and lists an item once, at the first source that brings it:
 *
 * - each `pnpm-lock.yaml` git tracks;
 * - each image of ours the local overlay pins (`deploy/overlays/local/*image/kustomization.yaml`), with the identity
 *   that signed it, `build.yml` on its repository's `main`;
 * - each other image `kustomize build deploy/overlays/local` runs, with CI's copy of it where `scripts/ci-images.sh`
 *   keeps one, for the scan to ask `ci-images.sh resolve` for;
 * - each Helm chart an Application in the rendered overlay installs, at its `targetRevision`, with the values files its
 *   `$values` source names, and Argo CD's own chart, at the Makefile's `ARGOCD_CHART`, with the values it installs with,
 *   for the scan to render with `helm template`;
 * - the k3s node image `deploy/k3d/cluster.yaml` names, the release whose `k3s-images.txt` lists the images k3s runs,
 *   for the scan to fetch, and the load balancer and tools images k3d starts beside it, at the version mise.lock holds;
 * - each stage of each tracked Dockerfile that names an image rather than an earlier stage;
 * - each image the workflows start: those a workflow names by digest, those its Dockerfiles under `.github/images/`
 *   pin (Trivy's), and those the scripts it runs name (ZAP's). The Postgres service and the Playwright container come
 *   through `ci-images.sh` from pins already on the list.
 *
 * `--unlisted` names, and exits 1 for, every reference by digest in a tracked file outside prose and test fixtures,
 * every `image:` in the rendered overlay, every Application with a chart and every `FROM` that the list does not read,
 * so a new kind of pin is caught rather than left unscanned.
 *
 * The checkout is data: nothing in it runs. Node runs this with no dependencies, from a sparse checkout of this
 * repository, and reads YAML through `yq`; `kustomize` renders the overlay (both from this repository's mise.toml).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export type Kind =
  | 'lockfile'
  | 'ours'
  | 'third-party'
  | 'chart'
  | 'k3s'
  | 'k3s-release'
  | 'k3d'
  | 'dockerfile'
  | 'workflow';

export interface Chart {
  /** The chart's repository, as Helm's `--repo` takes it. */
  repo: string;
  chart: string;
  version: string;
  release: string;
  /** The values files, as paths in the checkout, in the order Helm reads them. */
  values: string[];
}

export interface Item {
  kind: Kind;
  /** The item as the scan and its results name it: a lockfile's path, an image's reference, an Application's name. */
  name: string;
  /** The pin that brings it, where its alerts are located. */
  file: string;
  line: number;
  /** An image's reference. */
  image?: string;
  /** For an image of ours, the identity that signed it: `build.yml` on its repository's `main`. */
  signer?: string | undefined;
  /** CI's copy of a third-party image, by digest, as `scripts/ci-images.sh` names it. */
  ci?: string | undefined;
  chart?: Chart;
  /** For the k3s release, the list of the images it runs, an asset of its GitHub release. */
  list?: string;
}

/** A reference the list does not read, and why it is named. */
export interface Unlisted {
  file: string;
  line: number;
  reference: string;
  why: string;
}

/**
 * Files that name an image only for admission control to refuse it, so nothing runs it: an unsigned build of ours, or
 * one signed by another identity, which the guardrail proofs and the red-team's image attack depend on being refused.
 */
const NAMED_TO_BE_REFUSED: Record<string, string> = {
  'deploy/base/admission/factory/red-team-pods.yaml': "the red-team's image attack, which factory-images refuses",
  'policy/attacks.ts': "the red-team's image attack, which factory-images refuses",
  'scripts/admission-refusals.sh': "admission's refusals, recorded by the guardrail proof",
};

/** Scripts the workflows run that start an image they name themselves. */
const CI_SCRIPTS = ['apps/console/zap/scan.ts'];

/** Where CI's copies of Docker's official images and Playwright's are kept (scripts/ci-images.sh). */
const MIRROR = 'ghcr.io/the-roganator/cv-software-factory/mirror/';

/** A reference by digest, as any file writes it, and kustomize's `digest:` beside a name. */
const BY_DIGEST = /([A-Za-z0-9._/:-]*@sha256:[0-9a-f]{64})|^\s*-?\s*digest:\s*['"]?(sha256:[0-9a-f]{64})/g;
const IMAGE_LINE = /^\s*(?:-\s+)?image:\s*['"]?([^\s'"#]+)['"]?\s*(?:#.*)?$/;
const FROM = /^\s*FROM\s+(?:--\S+\s+)*(\S+)(?:\s+AS\s+(\S+))?\s*$/i;

/** An image's reference without its tag when it has a digest, so two pins of one image are one item. */
export function identity(reference: string) {
  const at = reference.indexOf('@');
  if (at < 0) return reference;
  const name = reference.slice(0, at);
  const slash = name.lastIndexOf('/');
  const colon = name.lastIndexOf(':');
  return `${colon > slash ? name.slice(0, colon) : name}${reference.slice(at)}`;
}

/** CI's copy of an image, where ci-images.sh keeps one: Docker's official images, and Playwright's. */
export function ciCopy(reference: string) {
  const at = reference.indexOf('@');
  if (at < 0) return undefined;
  const name = reference.slice(0, at).replace(/:[^/:]+$/, '');
  const digest = reference.slice(at);
  if (/^[a-z0-9._-]+$/.test(name)) return `${MIRROR}docker/library/${name}${digest}`;
  if (name === 'mcr.microsoft.com/playwright') return `${MIRROR}mcr/playwright${digest}`;
  return undefined;
}

/** The identity `build.yml` on main signs an image of ours with, from the GHCR repository the image is in. */
export function signerOf(image: string) {
  const [, owner, repository] = /^ghcr\.io\/([^/]+)\/([^/@:]+)/.exec(image) ?? [];
  if (!owner || !repository) return undefined;
  return `https://github.com/${owner}/${repository}/.github/workflows/build.yml@refs/heads/main`;
}

/** Whether a tracked file is prose or a test's fixture, whose references pin nothing that runs. */
export function isFixture(file: string) {
  return (
    file.endsWith('.md') ||
    /(^|\/)(test|tests|fixtures)\//.test(file) ||
    /\.test\.[a-z]+$/.test(file) ||
    // The console's sample event log, which it shows when no store is connected, and its design's mockups.
    file.startsWith('packages/samples/') ||
    file.startsWith('docs/design/mockups/')
  );
}

const isDockerfile = (file: string) =>
  (/(^|\/)Dockerfile(\.[^/]+)?$/.test(file) && !file.endsWith('.dockerignore')) || /\.Dockerfile$/.test(file);

/** A checkout, read: its tracked files, and the overlay as kustomize renders it. */
class Checkout {
  readonly root: string;
  readonly files: string[];
  private readonly texts = new Map<string, string[]>();

  constructor(root: string) {
    this.root = resolve(root);
    this.files = execFileSync('git', ['-C', this.root, 'ls-files', '-z'], { encoding: 'utf-8' })
      .split('\0')
      .filter((file) => file && existsSync(join(this.root, file)));
  }

  lines(file: string) {
    let lines = this.texts.get(file);
    if (!lines) {
      lines = readFileSync(join(this.root, file), 'utf-8').split('\n');
      this.texts.set(file, lines);
    }
    return lines;
  }

  /** The first line, 1-based, of a file that matches, or 0. */
  lineOf(file: string, test: (line: string) => boolean, from = 0) {
    const index = this.lines(file).findIndex((line, i) => i >= from && test(line));
    return index + 1;
  }

  /** The overlay's manifests, rendered, as text and as objects; none when the checkout has no overlay. */
  rendered(): { text: string; manifests: Manifest[] } {
    const overlay = join(this.root, 'deploy/overlays/local');
    if (!existsSync(join(overlay, 'kustomization.yaml'))) return { text: '', manifests: [] };
    const text = execFileSync('kustomize', ['build', overlay], { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
    return { text, manifests: yaml(text) };
  }
}

interface Source {
  chart?: string;
  repoURL?: string;
  targetRevision?: string;
  ref?: string;
  helm?: { releaseName?: string; valueFiles?: string[] };
}

interface Manifest {
  kind?: string;
  metadata?: { name?: string };
  spec?: { source?: Source; sources?: Source[] };
  images?: { name?: string; newName?: string; newTag?: string; digest?: string }[];
}

/** Every document of a YAML stream, through yq. */
function yaml(text: string): Manifest[] {
  const json = execFileSync('yq', ['eval-all', '--output-format=json', '--indent=0', '[.]', '-'], {
    input: text,
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return (JSON.parse(json) as (Manifest | null)[]).filter((doc): doc is Manifest => doc !== null && doc !== undefined);
}

/** The list, and what it read along the way that `--unlisted` compares with it. */
export function inventory(root: string) {
  const checkout = new Checkout(root);
  const items: Item[] = [];
  const seen = new Set<string>();
  const unplaced: Unlisted[] = [];
  const add = (item: Item) => {
    const key = item.image ? identity(item.image) : `${item.kind} ${item.name}`;
    if (seen.has(key)) return;
    seen.add(key);
    items.push(item);
  };
  // Prose and test fixtures bring in nothing that runs.
  const tracked = checkout.files.filter((file) => !isFixture(file));

  // Lockfiles.
  for (const file of tracked.filter((file) => /(^|\/)pnpm-lock\.yaml$/.test(file)))
    add({ kind: 'lockfile', name: file, file, line: 1 });

  // Images of ours, as the local overlay pins them.
  for (const file of tracked.filter((file) =>
    /^deploy\/overlays\/local\/([a-z0-9-]+-)?image\/kustomization\.yaml$/.test(file),
  )) {
    const [component] = yaml(readFileSync(join(checkout.root, file), 'utf-8'));
    for (const image of component?.images ?? []) {
      if (!image.newName || !image.digest) continue;
      const reference = `${image.newName}@${image.digest}`;
      const line = checkout.lineOf(file, (text) => text.includes(image.digest ?? ''));
      add({ kind: 'ours', name: reference, file, line, image: reference, signer: signerOf(image.newName) });
    }
  }

  // Third-party images and charts, from the rendered overlay.
  const { text, manifests } = checkout.rendered();
  const deployFiles = tracked.filter((file) => file.startsWith('deploy/') && !isFixture(file));
  for (const line of text.split('\n')) {
    const reference = IMAGE_LINE.exec(line)?.[1];
    if (!reference) continue;
    let placed: { file: string; line: number } | undefined;
    for (const file of deployFiles) {
      const at = checkout.lineOf(file, (text) => text.includes(reference));
      if (at) {
        placed = { file, line: at };
        break;
      }
    }
    if (!placed) {
      if (!seen.has(identity(reference)))
        unplaced.push({ file: 'deploy/overlays/local', line: 0, reference, why: 'rendered, but pinned in no file' });
      continue;
    }
    add({ kind: 'third-party', name: reference, ...placed, image: reference, ci: ciCopy(reference) });
  }
  for (const application of manifests.filter((manifest) => manifest.kind === 'Application')) {
    const name = application.metadata?.name ?? '';
    const sources = application.spec?.sources ?? (application.spec?.source ? [application.spec.source] : []);
    for (const source of sources) {
      if (!source.chart) continue;
      const placed = placeApplication(checkout, deployFiles, name, source);
      if (!placed) {
        unplaced.push({
          file: 'deploy/overlays/local',
          line: 0,
          reference: `Application ${name}`,
          why: 'its chart is pinned in no file',
        });
        continue;
      }
      add({
        kind: 'chart',
        name,
        ...placed,
        chart: {
          repo: source.repoURL ?? '',
          chart: source.chart,
          version: source.targetRevision ?? '',
          release: source.helm?.releaseName ?? name,
          values: (source.helm?.valueFiles ?? []).map((file) => file.replace(/^\$values\//, '')),
        },
      });
    }
  }
  const argocd = argoCD(checkout);
  if (argocd) add(argocd);

  // The cluster k3d makes: its k3s node, the images k3s runs, and k3d's own beside it.
  if (tracked.includes('deploy/k3d/cluster.yaml')) {
    const file = 'deploy/k3d/cluster.yaml';
    const line = checkout.lineOf(file, (text) => /^image:/.test(text));
    const node = IMAGE_LINE.exec(checkout.lines(file)[line - 1] ?? '')?.[1];
    if (node) {
      add({ kind: 'k3s', name: node, file, line, image: node });
      const release = node.split(':')[1]?.replace(/-(k3s\d+)$/, '+$1');
      if (release)
        add({
          kind: 'k3s-release',
          name: `k3s ${release}`,
          file,
          line,
          list: `https://github.com/k3s-io/k3s/releases/download/${encodeURIComponent(release)}/k3s-images.txt`,
        });
    }
  }
  if (tracked.includes('mise.lock') && tracked.includes('deploy/k3d/cluster.yaml')) {
    const tool = checkout.lineOf('mise.lock', (text) => text.trim() === '[[tools.k3d]]');
    const line = tool ? checkout.lineOf('mise.lock', (text) => /^version = /.test(text), tool) : 0;
    const version = /^version = "([^"]+)"/.exec(checkout.lines('mise.lock')[line - 1] ?? '')?.[1];
    if (version)
      for (const image of ['k3d-proxy', 'k3d-tools']) {
        const reference = `ghcr.io/k3d-io/${image}:${version}`;
        add({ kind: 'k3d', name: reference, file: 'mise.lock', line, image: reference });
      }
  }

  // Dockerfiles: their stages that name an image. Those under .github/images/ are images the workflows start.
  for (const file of tracked.filter(isDockerfile)) {
    const kind: Kind = file.startsWith('.github/images/') ? 'workflow' : 'dockerfile';
    // A FROM built from an ARG names no image until it is built, so it is not read: --unlisted names it.
    for (const stage of stages(checkout.lines(file)).filter((stage) => !stage.image.includes('$')))
      add({ kind, name: stage.image, file, line: stage.line, image: stage.image, ci: ciCopy(stage.image) });
  }

  // What the workflows start by name: in the workflows themselves, and in the scripts they run.
  const workflows = tracked.filter((file) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(file));
  for (const file of [...workflows, ...CI_SCRIPTS.filter((file) => tracked.includes(file))])
    checkout.lines(file).forEach((text, index) => {
      for (const reference of references(text))
        if (reference.includes('@'))
          add({ kind: 'workflow', name: reference, file, line: index + 1, image: reference, ci: ciCopy(reference) });
    });

  return { items, checkout, text, manifests, unplaced };
}

/** The stages of a Dockerfile that name an image rather than an earlier stage, each with its line. */
export function stages(lines: string[]) {
  const named = new Set<string>();
  const found: { image: string; line: number }[] = [];
  lines.forEach((text, index) => {
    const [, image, as] = FROM.exec(text) ?? [];
    if (!image) return;
    if (!named.has(image.toLowerCase()) && image !== 'scratch') found.push({ image, line: index + 1 });
    if (as) named.add(as.toLowerCase());
  });
  return found;
}

/** The references by digest on a line, each whole. */
function references(text: string) {
  return [...text.matchAll(BY_DIGEST)].map(([, reference, digest]) => reference ?? digest ?? '').filter(Boolean);
}

/** An Application's chart pin, in the file that writes it: its `targetRevision`, nearest its `chart`. */
function placeApplication(checkout: Checkout, files: string[], name: string, source: Source) {
  const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const chart = new RegExp(`^\\s*-?\\s*chart:\\s*['"]?${literal(source.chart ?? '')}['"]?\\s*(?:#.*)?$`);
  const revision = new RegExp(
    `^\\s*-?\\s*targetRevision:\\s*['"]?${literal(source.targetRevision ?? '')}['"]?\\s*(?:#.*)?$`,
  );
  const named = new RegExp(`^  name:\\s*['"]?${literal(name)}['"]?\\s*$`);
  for (const file of files.filter((file) => /\.ya?ml$/.test(file))) {
    const lines = checkout.lines(file);
    let start = 0;
    for (let end = 0; end <= lines.length; end++) {
      if (end < lines.length && lines[end] !== '---') continue;
      const doc = lines.slice(start, end);
      const offset = start;
      start = end + 1;
      if (!doc.some((line) => /^kind:\s*Application\s*$/.test(line)) || !doc.some((line) => named.test(line))) continue;
      const at = doc.findIndex((line) => chart.test(line));
      if (at < 0) continue;
      const revisions = doc.flatMap((line, index) => (revision.test(line) ? [index] : []));
      const nearest = revisions.sort((a, b) => Math.abs(a - at) - Math.abs(b - at))[0];
      if (nearest !== undefined) return { file, line: offset + nearest + 1 };
    }
  }
  return undefined;
}

/** Argo CD's own chart, which `make up` installs with Helm before Argo CD deploys the rest. */
function argoCD(checkout: Checkout): Item | undefined {
  if (!checkout.files.includes('Makefile')) return undefined;
  const lines = checkout.lines('Makefile');
  const line = checkout.lineOf('Makefile', (text) => /^ARGOCD_CHART\s*:?=/.test(text));
  const version = /^ARGOCD_CHART\s*:?=\s*(\S+)/.exec(lines[line - 1] ?? '')?.[1];
  if (!version) return undefined;
  const at = lines.findIndex((text) =>
    /helm upgrade --install \S+ \S+ --repo \S+ --version \$\(ARGOCD_CHART\)/.test(text),
  );
  const [, release = 'argocd', chart = 'argo-cd', repo = ''] =
    /helm upgrade --install (\S+) (\S+) --repo (\S+)/.exec(lines[at] ?? '') ?? [];
  const command: string[] = [];
  for (let i = at; i >= 0 && i < lines.length; i++) {
    command.push(lines[i] ?? '');
    if (!lines[i]?.trimEnd().endsWith('\\')) break;
  }
  const values = [...command.join(' ').matchAll(/(?:--values|-f)\s+(\S+)/g)].map(([, file]) => file ?? '');
  return { kind: 'chart', name: release, file: 'Makefile', line, chart: { repo, chart, version, release, values } };
}

/** Every pin in the checkout that the list does not read. */
export function unlisted(root: string): Unlisted[] {
  const { items, checkout, text, manifests, unplaced } = inventory(root);
  const listed = new Set(items.flatMap((item) => (item.image ? [identity(item.image)] : [])));
  const at = new Set(items.map((item) => `${item.file}:${item.line}`));
  const values = new Set(items.flatMap((item) => item.chart?.values ?? []));
  const found: Unlisted[] = [...unplaced];

  for (const file of checkout.files) {
    if (isFixture(file) || NAMED_TO_BE_REFUSED[file] !== undefined || values.has(file)) continue;
    const lines = checkout.lines(file);
    lines.forEach((line, index) => {
      for (const reference of references(line)) {
        if (at.has(`${file}:${index + 1}`) || listed.has(identity(reference))) continue;
        found.push({ file, line: index + 1, reference, why: 'a reference by digest the list does not read' });
      }
    });
    if (isDockerfile(file))
      for (const stage of stages(lines))
        if (!listed.has(identity(stage.image)))
          found.push({ file, line: stage.line, reference: stage.image, why: 'a FROM the list does not read' });
  }
  for (const line of text.split('\n')) {
    const reference = IMAGE_LINE.exec(line)?.[1];
    if (reference && !listed.has(identity(reference)) && !found.some((entry) => entry.reference === reference))
      found.push({ file: 'deploy/overlays/local', line: 0, reference, why: 'an image: the rendered overlay runs' });
  }
  const charts = new Set(items.flatMap((item) => (item.kind === 'chart' ? [item.name] : [])));
  for (const application of manifests.filter((manifest) => manifest.kind === 'Application')) {
    const name = application.metadata?.name ?? '';
    const sources = application.spec?.sources ?? (application.spec?.source ? [application.spec.source] : []);
    if (sources.some((source) => source.chart) && !charts.has(name))
      found.push({
        file: 'deploy/overlays/local',
        line: 0,
        reference: `Application ${name}`,
        why: 'a chart the list does not read',
      });
  }
  return found.filter(
    (entry, index) =>
      found.findIndex((other) => other.reference === entry.reference && other.file === entry.file) === index,
  );
}

function table(items: Item[]) {
  return items.map((item) => `${item.kind.padEnd(12)} ${item.name}  (${item.file}:${item.line})`).join('\n');
}

export function main(args: string[]): number {
  const json = args.includes('--json');
  const check = args.includes('--unlisted');
  const [root] = args.filter((arg) => !arg.startsWith('--'));
  if (!root) {
    console.error('Usage: inventory.ts <checkout> [--json] | inventory.ts --unlisted <checkout>');
    return 2;
  }
  if (check) {
    const found = unlisted(root);
    if (json) console.log(JSON.stringify(found, null, 2));
    else for (const entry of found) console.log(`${entry.file}:${entry.line}  ${entry.reference}  (${entry.why})`);
    return found.length ? 1 : 0;
  }
  const { items } = inventory(root);
  console.log(json ? JSON.stringify(items, null, 2) : table(items));
  return 0;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
