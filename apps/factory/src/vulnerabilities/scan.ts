/**
 * The daily scan of one repository: every item on its list (inventory.ts) read with Trivy, by its digest, against an
 * advisory database built within the day, and the findings written as one SARIF file for code scanning (sarif.ts), the
 * items grouped into runs of at most 5,000 results, each run a category of its own.
 *
 *     node apps/factory/src/vulnerabilities/scan.ts <checkout> --trivy-pin <Dockerfile> --out <dir>
 *       [--repository <owner/name>] [--upload]
 *
 * - A lockfile is scanned on its own, from a directory holding only it, development dependencies included.
 * - An image of ours, from the SPDX SBOM of each platform `build.yml` attested, verified against its signer, and from
 *   the image itself when its SBOM gives no Node.
 * - Every other image by pulling it, from CI's copy where there is one, with retries; a chart's, from what `helm
 *   template` renders of it with the values it is installed with; k3s's, from the list its release publishes.
 * - Node itself, which Trivy does not see: each image's Node version, from Syft's SBOM or the image's `NODE_VERSION`,
 *   matched against Node's own core vulnerability database (node.ts), fetched each run and refused, as Trivy's is,
 *   when it cannot be read. An image of ours whose Node version cannot be read is an item the scan cannot read.
 *
 * An item that cannot be read (a lockfile Trivy reads no packages from, an SBOM with no attestation, an image that
 * cannot be pulled, a chart that does not render, a pin the list does not read) is named in the log and fails the run,
 * and so does a database more than a day old: nothing is written for upload, so no alert closes because its item went
 * unread. The SARIF is written only with `--upload`, when every item was read and the file is within code scanning's
 * limits: no run over 5,000 results, so code scanning drops none, and no more than 20 runs. Every run also scans
 * PROOF, an image of ours that ran Node 24.22.0, as it scans ours, and fails unless CVE-2026-111497 is found in its
 * Node, so a scan that has stopped seeing Node cannot pass; nothing is uploaded for it. The log gives counts by
 * severity, each run's category, results and items, and the items not read, never a package or an advisory.
 *
 * Exceptions come from `policy/vulnerabilities.ts` on this repository's `main` alone (exceptions.ts: the workflow puts
 * `main`'s in place of the checkout's), for the scanned repository (`--repository`, or GITHUB_REPOSITORY): an excepted finding is still uploaded, and with `--upload`
 * the comment each excepted result's alert is dismissed with is written beside the SARIF (`exceptions.json`), for
 * alerts.ts to set once code scanning has the upload. The log names each entry that excepts nothing, and warns when the
 * checkout's `osv-scanner.toml` is not the one the policy gives it; neither fails the run.
 *
 * Every run that passes writes `deadlines.json` beside it (`Handoff`): the results as uploaded, without their prose,
 * the targets read, the excepted results' keys and the repository's `minimumReleaseAge`, for deadlines.ts to give each
 * open finding its deadline once code scanning has the upload.
 *
 * The checkout is data: nothing in it runs. Trivy runs in its pinned image, which reads the registries' credentials
 * from DOCKER_CONFIG (GHCR's, the job's token); cosign, helm, kustomize and yq come from this repository's mise.lock.
 */
import { execFile } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import * as POLICY from '../../../../policy/vulnerabilities.ts';
import { judge } from './exceptions.ts';
import { type Chart, type Item, inventory, unlisted } from './inventory.ts';
import {
  advisoriesFor,
  type CoreEntry,
  entries,
  NODE_DATABASE,
  nodeInConfig,
  nodeInPackages,
  nodeInSbom,
  readable,
} from './node.ts';
import { PROOF } from './proof.ts';
import {
  categoryOf,
  type Finding,
  LIMITS,
  merge,
  overLimits,
  type Run,
  SEVERITIES,
  type Severity,
  sarif,
} from './sarif.ts';
import { trivyPin } from './trivy-pin.ts';

export { trivyPin };

const run = promisify(execFile);

/** Where Trivy's databases are pulled from: GHCR, as the plan has it, not Trivy's default mirror. */
const DB_REPOSITORY = 'ghcr.io/aquasecurity/trivy-db:2';
const JAVA_DB_REPOSITORY = 'ghcr.io/aquasecurity/trivy-java-db:1';
/** The oldest the advisory database may be when the scan starts. */
export const DB_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** The platform an image of ours is scanned on when its SBOM gives no Node: its Node is the same release on both. */
const FALLBACK_PLATFORM = 'linux/amd64';
const OIDC_ISSUER = 'https://token.actions.githubusercontent.com';

// Trivy's own JSON (SchemaVersion 2), as far as the scan reads it. Every field is optional, as in image-scan.ts.
export interface TrivyVulnerability {
  VulnerabilityID?: string;
  PkgName?: string;
  /** Where in an image the package was found, for a language's package. */
  PkgPath?: string;
  InstalledVersion?: string;
  FixedVersion?: string;
  Severity?: string;
  /** Each source's rating, 1 (low) to 4 (critical), by the source's id. */
  VendorSeverity?: Record<string, number>;
  /** The advisory's own source: `ghsa` for an npm package, the distribution for an operating system's. */
  DataSource?: { ID?: string };
  Title?: string;
  Description?: string;
  PrimaryURL?: string;
  CVSS?: Record<string, { V2Score?: number; V3Score?: number; V40Score?: number }>;
}
export interface TrivyResult {
  Target?: string;
  Class?: string;
  Type?: string;
  Packages?: { Name?: string; Version?: string }[] | null;
  Vulnerabilities?: TrivyVulnerability[] | null;
}
export interface TrivyReport {
  SchemaVersion?: number;
  ArtifactName?: string;
  Metadata?: {
    ImageID?: string;
    RepoDigests?: string[] | null;
    /** `created` is when the image was built, as its configuration says. */
    ImageConfig?: { created?: string; config?: { Env?: string[] | null } };
  };
  Results?: TrivyResult[] | null;
}

/** What the scan runs, apart from its decisions, so the tests give it Trivy's JSON instead. */
export interface Tools {
  /** Trivy in its pinned image, with `/src` holding `src` read-only where given; its JSON report, or a throw. */
  trivy(args: string[], src?: string): Promise<TrivyReport>;
  /** The SPDX SBOM predicates an image carries, each verified against its signer; none, or a throw, when unverified. */
  attestations(image: string, signer: string): Promise<unknown[]>;
  /** A chart, rendered as `helm template` renders it, with its values files from the checkout. */
  render(chart: Chart, root: string, kubeVersion?: string): Promise<string>;
  fetch(url: string): Promise<string>;
  /** Tries again, as a pull or a download needs. */
  retry<T>(what: () => Promise<T>): Promise<T>;
  /** A fresh directory to hand Trivy. */
  temp(): string;
}

/** A part of an item that Trivy reads on its own: a lockfile, or one image. */
interface Target {
  item: Item;
  key: string;
  label: string;
  /** Set for an image. */
  image?: string;
  /**
   * For a chart's image that one of its values files pins, that pin: the line a move of it writes. Its alerts stay at the
   * chart's pin, where they always were, so no clock restarts.
   */
  pin?: { file: string; line: number } | undefined;
  ci?: string | undefined;
  signer?: string | undefined;
}

/** What reading one target gave: its reports, or why it could not be read. */
export interface Read {
  target: Target;
  reports: TrivyReport[];
  /** For an image of ours: whether its findings came from its SBOMs alone, or from the image too. */
  source?: 'sbom' | 'image';
  /** The Node version the image runs, where it gives one: Syft's in its SBOM, or `NODE_VERSION` in its configuration. */
  node?: string | undefined;
  unreadable?: string;
}

/** An image's repository: its name without the tag or the digest, what stays the same when its pin moves. */
export function repositoryOf(reference: string) {
  const name = reference.split('@')[0] ?? '';
  const slash = name.lastIndexOf('/');
  const colon = name.lastIndexOf(':');
  return colon > slash ? name.slice(0, colon) : name;
}

/**
 * An item's key for its alerts, from what does not change when its pin moves: a lockfile's path; an image's file and
 * repository; a chart's Application and the image's repository; k3s's image's repository.
 */
export function itemKey(item: Item, image?: string) {
  if (item.kind === 'lockfile') return `lockfile ${item.file}`;
  const repository = repositoryOf(image ?? item.image ?? item.name);
  if (item.kind === 'chart') return `chart ${item.name} ${repository}`;
  if (item.kind === 'k3s-release') return `k3s ${repository}`;
  return `${item.file} ${repository}`;
}

/** How many packages Trivy read, across the reports. */
export function packagesRead(reports: TrivyReport[]) {
  return reports.reduce(
    (sum, report) => sum + (report.Results ?? []).reduce((n, result) => n + (result.Packages ?? []).length, 0),
    0,
  );
}

/** The images in a rendered manifest, each once, in the order they first appear. */
export function imagesIn(rendered: string) {
  const found = new Set<string>();
  for (const line of rendered.split('\n')) {
    // Any reference, a bare `busybox` too: an image not scanned would pass unread.
    const image = /^\s*(?:-\s+)?image:\s*['"]?([a-z0-9][\w./:@-]*)['"]?\s*(?:#.*)?$/i.exec(line)?.[1];
    if (image) found.add(image);
  }
  return [...found];
}

/** The line of a package's entry in a pnpm lockfile, or the lockfile's first line. */
export function lockfileLine(lines: string[], name: string, version: string) {
  const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const entry = new RegExp(`^  '?${literal(name)}@${literal(version)}['(:]`);
  const packages = lines.indexOf('packages:');
  const at = lines.findIndex((line, index) => index > packages && entry.test(line));
  return at >= 0 ? at + 1 : 1;
}

const severityOf = (value: string | undefined): Severity =>
  SEVERITIES.includes(value as Severity) ? (value as Severity) : 'UNKNOWN';

/** Trivy's `VendorSeverity` numbers, as its own `Severity` names them. */
const VENDOR: Record<number, Severity> = { 1: 'LOW', 2: 'MEDIUM', 3: 'HIGH', 4: 'CRITICAL' };

/** The publisher's rating: the one the advisory's own source gives, where it gives one. */
export const publisherOf = (v: TrivyVulnerability): Severity | undefined =>
  v.DataSource?.ID ? VENDOR[v.VendorSeverity?.[v.DataSource.ID] ?? 0] : undefined;

const scoreOf = (v: TrivyVulnerability) => {
  const scores = Object.values(v.CVSS ?? {}).flatMap((s) => [s.V40Score, s.V3Score].filter((n) => n !== undefined));
  return scores.length ? Math.max(...(scores as number[])) : undefined;
};

/** The findings a read gave, each at the line that pins its item. */
export function findingsOf(read: Read, lockfile?: string[]): Finding[] {
  const digest = read.reports.flatMap((report) => report.Metadata?.RepoDigests ?? [])[0];
  const label =
    read.target.image && !read.target.image.includes('@') && digest
      ? `${read.target.image} (${digest.slice(digest.indexOf('@') + 1)})`
      : read.target.label;
  return read.reports.flatMap((report) =>
    (report.Results ?? []).flatMap((result) =>
      (result.Vulnerabilities ?? []).flatMap((v): Finding[] => {
        if (!v.VulnerabilityID || !v.PkgName) return [];
        const installed = v.InstalledVersion ?? '';
        const line =
          read.target.item.kind === 'lockfile' && lockfile
            ? lockfileLine(lockfile, v.PkgName, installed)
            : read.target.item.line;
        return [
          {
            item: read.target.key,
            listed: read.target.item.name,
            label,
            file: read.target.item.file,
            line,
            type: result.Type ?? result.Class ?? 'unknown',
            package: v.PkgName,
            installed,
            fixed: v.FixedVersion || undefined,
            advisory: v.VulnerabilityID,
            severity: severityOf(v.Severity),
            publisher: publisherOf(v),
            title: v.Title,
            description: v.Description,
            url: v.PrimaryURL,
            score: scoreOf(v),
            ...(v.PkgPath ? { path: v.PkgPath } : {}),
          },
        ];
      }),
    ),
  );
}

/** The findings of Node's own advisories in an image whose Node version the read gave, at the image's pin. */
export function nodeFindingsOf(read: Read, database: [string, CoreEntry][]): Finding[] {
  if (!read.node) return [];
  return advisoriesFor(read.node, database).map((advisory) => ({
    item: read.target.key,
    listed: read.target.item.name,
    label: read.target.label,
    file: read.target.item.file,
    line: read.target.item.line,
    type: 'node',
    package: 'node',
    installed: read.node ?? '',
    fixed: advisory.patched,
    advisory: advisory.advisory,
    severity: advisory.severity,
    publisher: advisory.severity,
    title: advisory.title,
    description: advisory.description,
    url: advisory.url,
  }));
}

const IMAGE_ARGS = ['--scanners', 'vuln', '--list-all-pkgs', '--image-src', 'remote'];

/** A lockfile, alone in a directory, with development dependencies. */
export async function readLockfile(tools: Tools, root: string, target: Target): Promise<Read> {
  const dir = tools.temp();
  cpSync(join(root, target.item.file), join(dir, 'pnpm-lock.yaml'));
  try {
    const report = await tools.trivy(
      ['fs', '--scanners', 'vuln', '--include-dev-deps', '--list-all-pkgs', '/src'],
      dir,
    );
    if (packagesRead([report]) === 0) return { target, reports: [], unreadable: 'Trivy read no packages from it' };
    return { target, reports: [report] };
  } catch (error) {
    return { target, reports: [], unreadable: `Trivy could not scan it: ${firstLine(error)}` };
  }
}

/**
 * Where Syft found each package in an image, by name and version, from its SPDX SBOM's `sourceInfo` (`… manifest file:
 * /opt/pnpm/dist/node_modules/<name>/…`): Trivy keeps no path when it reads an SBOM.
 */
export function sbomPaths(predicate: unknown) {
  const paths = new Map<string, Set<string>>();
  const packages = (predicate as { packages?: unknown } | undefined)?.packages;
  for (const each of Array.isArray(packages) ? packages : []) {
    const { name, versionInfo, sourceInfo } = each as { name?: unknown; versionInfo?: unknown; sourceInfo?: unknown };
    const path = typeof sourceInfo === 'string' ? /: (\/\S+)$/.exec(sourceInfo)?.[1] : undefined;
    if (typeof name !== 'string' || typeof versionInfo !== 'string' || !path) continue;
    const key = `${name}@${versionInfo}`;
    paths.set(key, new Set([...(paths.get(key) ?? []), path.replace(/^\//, '')]));
  }
  return paths;
}

/** A report with each vulnerable package's path, where the SBOM gives it one place and Trivy gave none. */
export function withPaths(report: TrivyReport, paths: Map<string, Set<string>>): TrivyReport {
  for (const result of report.Results ?? [])
    for (const v of result.Vulnerabilities ?? []) {
      const found = paths.get(`${v.PkgName}@${v.InstalledVersion}`);
      const [only] = found?.size === 1 ? [...found] : [];
      if (!v.PkgPath && only) v.PkgPath = only;
    }
  return report;
}

/**
 * An image of ours: each platform's SBOM, verified against its signer, and its Node version from Syft's
 * `pkg:generic/node` there; and the image itself when no SBOM gives Node, for its findings and its `NODE_VERSION`. An
 * image of ours whose Node cannot be read either way is an item the scan cannot read: every one of ours runs Node.
 */
export async function readOurs(tools: Tools, target: Target): Promise<Read> {
  const image = target.image ?? '';
  if (!target.signer) return { target, reports: [], unreadable: 'no signer the scan can verify it against' };
  let predicates: unknown[];
  try {
    // Once: a signature that does not verify is an answer, not a pull to try again.
    predicates = await tools.attestations(image, target.signer ?? '');
  } catch (error) {
    return { target, reports: [], unreadable: `no SBOM attestation verified: ${firstLine(error)}` };
  }
  if (!predicates.length) return { target, reports: [], unreadable: 'no SBOM attestation verified' };
  const reports: TrivyReport[] = [];
  for (const predicate of predicates) {
    const dir = tools.temp();
    writeFileSync(join(dir, 'sbom.spdx.json'), JSON.stringify(predicate));
    try {
      const report = await tools.trivy(['sbom', '--scanners', 'vuln', '--list-all-pkgs', '/src/sbom.spdx.json'], dir);
      reports.push(withPaths(report, sbomPaths(predicate)));
    } catch (error) {
      return { target, reports: [], unreadable: `Trivy could not read its SBOM: ${firstLine(error)}` };
    }
  }
  if (packagesRead(reports) === 0) return { target, reports: [], unreadable: 'Trivy read no packages from its SBOM' };
  const node = predicates.map(nodeInSbom).find(Boolean);
  if (node) return { target, reports, source: 'sbom', node };
  try {
    const own = await tools.retry(() => analysed(tools, ['--platform', FALLBACK_PLATFORM, '--', image]));
    const configured = nodeOf(own);
    if (!configured)
      return { target, reports: [], unreadable: 'its Node version is in neither its SBOM nor its image' };
    return { target, reports: [...reports, own], source: 'image', node: configured };
  } catch (error) {
    return {
      target,
      reports: [],
      unreadable: `its SBOM gives no Node, and the image could not be pulled: ${firstLine(error)}`,
    };
  }
}

/**
 * Trivy's report of an image, which must name the image it analysed: one that does not is no read, and its alerts would
 * close with nothing behind them. An image with no packages at all (k3s's pause, a static busybox) is read.
 */
async function analysed(tools: Tools, args: string[]) {
  const report = await tools.trivy(['image', ...IMAGE_ARGS, ...args]);
  if (!report.Metadata?.ImageID) throw new Error('Trivy gave no image it analysed');
  return report;
}

/** An image's Node version, from its configuration's `NODE_VERSION` or an operating system's `nodejs` package. */
const nodeOf = (report: TrivyReport) => nodeInConfig(report.Metadata?.ImageConfig) ?? nodeInPackages(report.Results);

/** Any other image: CI's copy where there is one, then its own registry, with retries. */
export async function readImage(tools: Tools, target: Target): Promise<Read> {
  const image = target.image ?? '';
  const scan = (reference: string) => analysed(tools, ['--', reference]);
  try {
    if (target.ci) {
      try {
        const report = await scan(target.ci);
        return { target, reports: [report], node: nodeOf(report) };
      } catch {
        // Not copied yet (mirror.yml copies the factory's pins, daily): from its own registry instead.
      }
    }
    const report = await tools.retry(() => scan(image));
    return { target, reports: [report], node: nodeOf(report) };
  } catch (error) {
    return { target, reports: [], unreadable: `could not be pulled: ${firstLine(error)}` };
  }
}

const firstLine = (error: unknown) =>
  String((error as { stderr?: string }).stderr || (error as Error).message || error)
    .trim()
    .split('\n')
    .slice(-1)[0]
    ?.slice(0, 300) ?? '';

/** The targets an item is read as: itself, or each image a chart renders or a k3s release lists. */
async function targetsOf(tools: Tools, root: string, item: Item, tracked: Set<string>, kubeVersion?: string) {
  const image = (reference: string): Target => ({
    item,
    key: itemKey(item, reference),
    label: reference,
    image: reference,
    ci: item.ci,
    signer: item.signer,
  });
  if (item.kind === 'lockfile') return { targets: [{ item, key: itemKey(item), label: item.file }] };
  if (item.kind === 'chart' && item.chart) {
    // A values file is a file the checkout tracks, inside it: a path that left it could hand a chart anything on the
    // runner, the registry's credentials among them, to write into an image's name.
    const outside = item.chart.values.find(
      (file) => !tracked.has(file) || !resolve(root, file).startsWith(`${resolve(root)}/`),
    );
    if (outside)
      return { targets: [], unreadable: `a values file it names is not a file the checkout tracks: ${outside}` };
    let rendered: string;
    try {
      rendered = await tools.retry(() => tools.render(item.chart as Chart, root, kubeVersion));
    } catch (error) {
      return { targets: [], unreadable: `its chart does not render: ${firstLine(error)}` };
    }
    const images = imagesIn(rendered);
    if (!images.length) return { targets: [], unreadable: 'its chart renders no image' };
    // An image one of the chart's values files pins is moved at that pin, its own line.
    return {
      targets: images.map((reference) => {
        const digest = reference.split('@')[1];
        const pin = digest ? item.pins?.find((each) => each.digest === digest) : undefined;
        return { ...image(reference), pin: pin && { file: pin.file, line: pin.line } };
      }),
    };
  }
  if (item.kind === 'k3s-release' && item.list) {
    let list: string;
    try {
      list = await tools.retry(() => tools.fetch(item.list ?? ''));
    } catch (error) {
      return { targets: [], unreadable: `its list of images could not be fetched: ${firstLine(error)}` };
    }
    const images = list
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));
    if (!images.length) return { targets: [], unreadable: 'its list of images is empty' };
    return { targets: images.map(image) };
  }
  return { targets: [image(item.image ?? item.name)] };
}

/** A target the scan read, as deadlines.ts needs it: its item's kind, the file that pins it, and what it read. */
export interface ReadTarget {
  key: string;
  kind: Item['kind'];
  file: string;
  label: string;
  image?: string | undefined;
  /** For an image k3s's release brings, the URL of the release's list of images (inventory.ts's `list`). */
  list?: string | undefined;
  /** For a chart's image, the chart, so a later version can be rendered with the same values. */
  chart?: Chart | undefined;
  /** For a chart's image one of its values files pins, that pin's file and line. */
  pin?: { file: string; line: number } | undefined;
}

export interface Outcome {
  findings: Finding[];
  /** Each target read, the proof's left out. */
  targets: ReadTarget[];
  unreadable: { name: string; why: string }[];
  read: number;
  /** The Kubernetes version the charts are rendered for: the k3s node's. */
  kubeVersion?: string | undefined;
  proof: {
    found: boolean;
    source?: 'sbom' | 'image' | undefined;
    unreadable?: string | undefined;
    /** The Node version read from it. */
    node?: string | undefined;
  };
}

/** Every item on a checkout's list, and the proof, read. */
export async function scan(
  tools: Tools,
  root: string,
  items: Item[],
  pins: { file: string; line: number; reference: string; why: string }[],
  database: [string, CoreEntry][],
  tracked: Set<string>,
): Promise<Outcome> {
  const unreadable: Outcome['unreadable'] = pins.map((pin) => ({
    name: `${pin.reference} (${pin.file}:${pin.line})`,
    why: `a pin the list does not read: ${pin.why}`,
  }));
  const findings: Finding[] = [];
  const targetsRead: ReadTarget[] = [];
  const lockfiles = new Map<string, string[]>();
  // An image several items run is pulled once, and its findings are each item's.
  const pulled = new Map<string, Promise<Read>>();
  const kubeVersion = items.find((item) => item.kind === 'k3s')?.image?.match(/:v?(\d+\.\d+\.\d+)/)?.[1];
  let read = 0;
  for (const item of items) {
    const { targets, unreadable: why } = await targetsOf(tools, root, item, tracked, kubeVersion);
    if (why) {
      unreadable.push({ name: item.name, why });
      continue;
    }
    for (const target of targets) {
      let result: Read;
      if (item.kind === 'lockfile') {
        result = await readLockfile(tools, root, target);
        lockfiles.set(item.file, readFileSync(join(root, item.file), 'utf-8').split('\n'));
      } else {
        const how = item.kind === 'ours' ? 'ours' : 'image';
        const id = `${how} ${target.image}`;
        let once = pulled.get(id);
        if (!once) {
          once = how === 'ours' ? readOurs(tools, target) : readImage(tools, target);
          pulled.set(id, once);
        }
        result = { ...(await once), target };
      }
      if (result.unreadable) {
        unreadable.push({
          name: target.label === item.name ? item.name : `${item.name}: ${target.label}`,
          why: result.unreadable,
        });
        continue;
      }
      read++;
      targetsRead.push({
        key: target.key,
        kind: item.kind,
        file: item.file,
        label: target.label,
        image: target.image,
        list: item.list,
        ...(item.chart ? { chart: item.chart } : {}),
        ...(target.pin ? { pin: target.pin } : {}),
      });
      findings.push(...findingsOf(result, lockfiles.get(item.file)), ...nodeFindingsOf(result, database));
    }
  }
  const proofItem: Item = {
    kind: 'ours',
    name: PROOF.image,
    file: PROOF.file,
    line: 1,
    image: PROOF.image,
    signer: PROOF.signer,
  };
  const proofRead = await readOurs(tools, {
    item: proofItem,
    key: itemKey(proofItem),
    label: PROOF.image,
    image: PROOF.image,
    signer: PROOF.signer,
  });
  const found = nodeFindingsOf(proofRead, database).some((finding) => finding.advisory === PROOF.advisory);
  return {
    findings,
    targets: targetsRead,
    unreadable,
    read,
    kubeVersion,
    proof: { found, source: proofRead.source, unreadable: proofRead.unreadable, node: proofRead.node },
  };
}

/** How old the advisory database is, from the metadata Trivy writes beside it, or a reason it cannot be told. */
export function databaseAge(metadata: string, now = Date.now()): number | string {
  let updated: unknown;
  try {
    updated = (JSON.parse(metadata) as { UpdatedAt?: unknown }).UpdatedAt;
  } catch {
    return 'its metadata does not parse';
  }
  const at = typeof updated === 'string' ? Date.parse(updated) : Number.NaN;
  if (Number.isNaN(at)) return 'its metadata gives no build time';
  return now - at;
}

/** The counts by severity, of each package and advisory in each item once, as the log and the summary give them. */
export function counts(findings: Finding[]) {
  const merged = merge(findings);
  return Object.fromEntries(SEVERITIES.map((s) => [s, merged.filter((f) => f.severity === s).length])) as Record<
    Severity,
    number
  >;
}

/** What the run reports, and whether it passes: never a package or an advisory, only counts and the items not read. */
export function report(outcome: Outcome, upload: boolean, limits = LIMITS, trivyVersion?: string) {
  const lines: string[] = [];
  const total = counts(outcome.findings);
  lines.push(
    `Read ${outcome.read} targets. Findings by severity: ${SEVERITIES.map((s) => `${s.toLowerCase()} ${total[s]}`).join(', ')}.`,
  );
  if (outcome.unreadable.length) {
    lines.push(`Not read (${outcome.unreadable.length}):`);
    for (const entry of outcome.unreadable) lines.push(`  ${entry.name}: ${entry.why}`);
  } else lines.push('Every item was read.');
  const proof = outcome.proof;
  lines.push(
    proof.unreadable
      ? `The proof image could not be read: ${proof.unreadable}.`
      : proof.found
        ? `The proof image shows ${PROOF.advisory} in its Node ${proof.node}, read from its ${proof.source === 'image' ? 'image' : 'SBOM'}.`
        : `The proof image does not show ${PROOF.advisory} in its Node ${proof.node}: the scan has stopped seeing Node.`,
  );
  const file = sarif(outcome.findings, trivyVersion, limits);
  const used = file.runs.filter((run) => run.properties.items.length);
  lines.push(
    `The results are in ${used.length} of ${file.runs.length} runs, each a category of its own${used.length ? ':' : '.'}`,
  );
  for (const run of used) lines.push(`  ${runLine(run)}`);
  const over = overLimits(file, limits);
  if (over.length) lines.push(`The results are over code scanning's limits: ${over.join('; ')}.`);
  const passes = !outcome.unreadable.length && proof.found && !proof.unreadable && !over.length;
  lines.push(
    passes
      ? upload
        ? 'Every item was read: the results are written for upload.'
        : 'Every item was read: a proving run uploads nothing.'
      : 'The run fails, and nothing is uploaded.',
  );
  return { lines, passes, file };
}

/** A run as the log names it: its category, how many results, and its items, by their keys. */
export function runLine(run: Run) {
  const items = run.properties.items;
  return `${categoryOf(run)}: ${run.results.length} results, ${items.length} ${items.length === 1 ? 'item' : 'items'}: ${items.join('; ')}`;
}

/** Trivy in its image: the registries' credentials read-only, and its cache. */
const dockerRun = (cache: string, mounts: string[] = []) => [
  'run',
  '--rm',
  '-e',
  'DOCKER_CONFIG=/docker',
  '-v',
  `${process.env.DOCKER_CONFIG ?? join(process.env.HOME ?? '', '.docker')}:/docker:ro`,
  '-v',
  `${cache}:/cache`,
  ...mounts.flatMap((mount) => ['-v', mount]),
];

/** The tools as the workflow has them: Trivy in its image through Docker, cosign and helm from mise. */
export function realTools(trivyImage: string, cache: string, work: string): Tools {
  let count = 0;
  const temp = () => mkdtempSync(join(work, 'target-'));
  return {
    temp,
    async trivy(args, src) {
      const out = temp();
      const name = `report-${++count}.json`;
      await run(
        'docker',
        [
          ...dockerRun(cache, [`${out}:/out`, ...(src ? [`${src}:/src:ro`] : [])]),
          trivyImage,
          ...args.slice(0, 1),
          '--cache-dir',
          '/cache',
          '--skip-db-update',
          '--skip-java-db-update',
          '--quiet',
          '--timeout',
          '20m',
          '--format',
          'json',
          '--output',
          `/out/${name}`,
          ...args.slice(1),
        ],
        { maxBuffer: 64 * 1024 * 1024 },
      );
      return JSON.parse(readFileSync(join(out, name), 'utf-8')) as TrivyReport;
    },
    async attestations(image, signer) {
      const { stdout } = await run(
        'cosign',
        [
          'verify-attestation',
          '--type',
          'spdxjson',
          '--certificate-identity',
          signer,
          '--certificate-oidc-issuer',
          OIDC_ISSUER,
          image,
        ],
        { maxBuffer: 512 * 1024 * 1024, timeout: 10 * 60 * 1000 },
      );
      return stdout
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => {
          const envelope = JSON.parse(line) as { payload: string };
          return (JSON.parse(Buffer.from(envelope.payload, 'base64').toString('utf-8')) as { predicate: unknown })
            .predicate;
        });
    },
    async render(chart, root, kubeVersion) {
      const home = temp();
      const { stdout } = await run(
        'helm',
        [
          'template',
          chart.release,
          chart.chart,
          '--repo',
          chart.repo,
          '--version',
          chart.version,
          ...(kubeVersion ? ['--kube-version', kubeVersion] : []),
          ...chart.values.flatMap((file) => ['--values', join(root, file)]),
        ],
        {
          maxBuffer: 64 * 1024 * 1024,
          timeout: 5 * 60 * 1000,
          // Helm's own state in a directory of the run's: no plugins, repositories or registry logins but none.
          env: {
            PATH: process.env.PATH ?? '',
            HOME: home,
            HELM_CACHE_HOME: join(home, 'cache'),
            HELM_CONFIG_HOME: join(home, 'config'),
            HELM_DATA_HOME: join(home, 'data'),
          },
        },
      );
      return stdout;
    },
    async fetch(url) {
      const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(60_000) });
      if (!response.ok) throw new Error(`${url}: ${response.status}`);
      return response.text();
    },
    async retry(what) {
      let last: unknown;
      for (const wait of [0, 15_000, 45_000, 90_000]) {
        if (wait) await new Promise((done) => setTimeout(done, wait));
        try {
          return await what();
        } catch (error) {
          last = error;
        }
      }
      throw last;
    },
  };
}

/** The advisory databases, pulled from GHCR with retries, and how old the main one is. */
async function databases(tools: Tools, trivyImage: string, cache: string) {
  const pull = (args: string[]) =>
    tools.retry(() =>
      run('docker', [...dockerRun(cache), trivyImage, 'image', '--cache-dir', '/cache', '--quiet', ...args]),
    );
  await pull(['--download-db-only', '--db-repository', DB_REPOSITORY]);
  await pull(['--download-java-db-only', '--java-db-repository', JAVA_DB_REPOSITORY]);
  return databaseAge(readFileSync(join(cache, 'db/metadata.json'), 'utf-8'));
}

export async function main(args: string[]): Promise<number> {
  const option = (name: string) => {
    const at = args.indexOf(name);
    return at >= 0 ? args[at + 1] : undefined;
  };
  const [root] = args.filter(
    (arg, i) => !arg.startsWith('--') && !args[i - 1]?.match(/^--(trivy-pin|out|repository)$/),
  );
  const pinFile = option('--trivy-pin');
  const out = option('--out');
  const repository = option('--repository') ?? process.env.GITHUB_REPOSITORY;
  const upload = args.includes('--upload');
  if (!root || !pinFile || !out || (upload && !repository)) {
    console.error(
      'Usage: scan.ts <checkout> --trivy-pin <Dockerfile> --out <dir> [--repository <owner/name>] [--upload]',
    );
    console.error('An upload needs the repository: the alerts it dismisses and reopens are its own.');
    return 2;
  }
  const pin = trivyPin(readFileSync(pinFile, 'utf-8'));
  if (!pin?.[1]) {
    console.error(`::error::No Trivy pin in ${pinFile}`);
    return 1;
  }
  const started = new Date().toISOString();
  mkdirSync(out, { recursive: true });
  const cache = mkdtempSync(join(resolve(out), 'cache-'));
  const work = mkdtempSync(join(resolve(out), 'work-'));
  const tools = realTools(pin[1], cache, work);

  let age: number | string;
  try {
    age = await databases(tools, pin[1], cache);
  } catch (error) {
    age = `it could not be pulled: ${firstLine(error)}`;
  }
  if (typeof age === 'string' || age > DB_MAX_AGE_MS) {
    const why = typeof age === 'string' ? age : `it was built ${(age / 3_600_000).toFixed(1)} hours ago`;
    console.error(`::error::The advisory database is refused: ${why}. The run fails, and nothing is uploaded.`);
    return 1;
  }
  console.log(`The advisory database was built ${(age / 3_600_000).toFixed(1)} hours ago.`);
  let database: [string, CoreEntry][];
  try {
    database = entries(await tools.retry(() => tools.fetch(NODE_DATABASE)));
    // Every range read now, so one the scan cannot read refuses the database rather than misreading a version.
    readable(database);
  } catch (error) {
    console.error(
      `::error::Node's vulnerability database is refused: ${firstLine(error)}. The run fails, and nothing is uploaded.`,
    );
    return 1;
  }
  console.log(`Node's vulnerability database has ${database.length} entries.`);

  const checkout = resolve(root);
  const { items, checkout: files } = inventory(checkout);
  const outcome = await scan(tools, checkout, items, unlisted(checkout), database, new Set(files.files));
  const { lines, passes, file } = report(outcome, upload, LIMITS, pin[2]);
  const osv = join(checkout, 'osv-scanner.toml');
  const exceptions = judge(
    POLICY,
    repository ?? '',
    items.map((item) => item.name),
    outcome.findings,
    existsSync(osv) ? readFileSync(osv, 'utf-8') : undefined,
  );
  lines.splice(lines.length - 1, 0, ...exceptions.lines);
  for (const line of lines) console.log(line);
  for (const warning of exceptions.warnings) console.log(`::warning::${warning}`);
  for (const entry of outcome.unreadable) console.log(`::error::Not read: ${entry.name}: ${entry.why}`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary(outcome, lines)}\n`);
  if (!passes) return 1;
  // What deadlines.ts reads, after the upload: every run that passes, a proving run's too.
  writeFileSync(
    join(out, 'deadlines.json'),
    JSON.stringify(handoff(repository ?? '', started, cache, checkout, outcome, exceptions.excepted)),
  );
  if (upload) {
    // The file checked against the limits, as it was checked.
    writeFileSync(join(out, 'vulnerabilities.sarif'), JSON.stringify(file));
    writeFileSync(
      join(out, 'exceptions.json'),
      JSON.stringify({ repository, excepted: Object.fromEntries(exceptions.excepted) }),
    );
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, 'sarif=true\n');
  }
  return 0;
}

/** What the scan hands deadlines.ts: the results, as uploaded, without their prose, and what it needs to judge them. */
export interface Handoff {
  repository: string;
  /** When the scan started: an alert fixed since then was closed by this run's upload. */
  started: string;
  /** Trivy's cache, with the advisory database the scan checked. */
  cache: string;
  /** pnpm's `minimumReleaseAge` in the scanned repository, in minutes, where it sets one. */
  minimumReleaseAge?: number | undefined;
  findings: Finding[];
  /** The alert key (sarif.ts's `alertKey`) of each excepted result. */
  excepted: string[];
  targets: ReadTarget[];
  /** The Kubernetes version the charts were rendered for, for rendering a later chart the same way. */
  kubeVersion?: string | undefined;
}

export function handoff(
  repository: string,
  started: string,
  cache: string,
  checkout: string,
  outcome: Outcome,
  excepted: Map<string, string>,
): Handoff {
  const workspace = join(checkout, 'pnpm-workspace.yaml');
  return {
    repository,
    started,
    cache,
    minimumReleaseAge: existsSync(workspace) ? minimumReleaseAge(readFileSync(workspace, 'utf-8')) : undefined,
    findings: merge(outcome.findings).map(({ title: _t, description: _d, ...finding }) => finding),
    excepted: [...excepted.keys()],
    targets: outcome.targets,
    kubeVersion: outcome.kubeVersion,
  };
}

/** pnpm's `minimumReleaseAge`, in minutes, from a `pnpm-workspace.yaml`, read as data. */
export function minimumReleaseAge(workspace: string) {
  const minutes = /^minimumReleaseAge:\s*['"]?(\d+)['"]?\s*(?:#.*)?$/m.exec(workspace)?.[1];
  return minutes === undefined ? undefined : Number(minutes);
}

function summary(outcome: Outcome, lines: string[]) {
  const total = counts(outcome.findings);
  return [
    '### The daily scan',
    '',
    '| Severity | Findings |',
    '| --- | --- |',
    ...SEVERITIES.map((s) => `| ${s.toLowerCase()} | ${total[s]} |`),
    '',
    ...lines.slice(1).map((line) => (line.startsWith('  ') ? `- ${line.trim()}` : line)),
  ].join('\n');
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
