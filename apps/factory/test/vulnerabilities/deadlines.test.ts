import { describe, expect, it } from 'vitest';
import type { Alert } from '../../src/vulnerabilities/alerts.ts';
import {
  assess,
  DAYS,
  dockerfileOf,
  firstFixed,
  k3sLine,
  k3sReleaseOf,
  newestOnLine,
  npmUrl,
  runtimeStage,
  type Sources,
  severityOf,
  skopeoName,
  verdict,
} from '../../src/vulnerabilities/deadlines.ts';
import { alertKey, type Finding, merge, messageOf } from '../../src/vulnerabilities/sarif.ts';
import {
  type Handoff,
  minimumReleaseAge,
  publisherOf,
  type ReadTarget,
  type TrivyReport,
} from '../../src/vulnerabilities/scan.ts';

/**
 * Each finding's deadline (deadlines.ts), on invented findings, alerts in the shape code scanning's API gives them, and
 * the registries' answers: the plan's list of tests (docs/PLAN/M07-ADMIN-AND-GUARDRAILS.md, task 30), in its order.
 */
const DAY = 86_400_000;
const NOW = Date.parse('2026-11-10T04:30:00Z');
const at = (iso: string) => Date.parse(iso);
const REPOSITORY = 'the-roganator/cv-software-factory';

const LOCKFILE: ReadTarget = {
  key: 'lockfile pnpm-lock.yaml',
  kind: 'lockfile',
  file: 'pnpm-lock.yaml',
  label: 'pnpm-lock.yaml',
};
const NODE_IMAGE = `node:24.22.1-trixie-slim@sha256:${'b'.repeat(64)}`;
const IMAGE: ReadTarget = {
  key: '.devcontainer/Dockerfile node',
  kind: 'dockerfile',
  file: '.devcontainer/Dockerfile',
  label: NODE_IMAGE,
  image: NODE_IMAGE,
};

const npm = (over: Partial<Finding> = {}): Finding => ({
  item: LOCKFILE.key,
  listed: 'pnpm-lock.yaml',
  label: 'pnpm-lock.yaml',
  file: 'pnpm-lock.yaml',
  line: 120,
  type: 'pnpm',
  package: 'example-a',
  installed: '1.0.0',
  fixed: '1.0.1',
  advisory: 'CVE-2099-20001',
  severity: 'HIGH',
  ...over,
});
const os = (over: Partial<Finding> = {}): Finding => ({
  item: IMAGE.key,
  listed: NODE_IMAGE,
  label: NODE_IMAGE,
  file: IMAGE.file,
  line: 2,
  type: 'debian',
  package: 'libexample',
  installed: '1.0-1',
  fixed: '1.0-2',
  advisory: 'CVE-2099-20002',
  severity: 'HIGH',
  ...over,
});

let alertNumber = 0;
/** The alert code scanning keeps for a finding, made at the time given. */
const alertOf = (finding: Finding, created: string, over: Partial<Alert> = {}): Alert => ({
  number: ++alertNumber,
  state: 'open',
  created_at: created,
  updated_at: created,
  tool: { name: 'Trivy' },
  rule: { id: finding.advisory },
  most_recent_instance: {
    category: 'vulnerabilities/01',
    message: { text: messageOf(finding) },
    location: { path: finding.file, start_line: finding.line },
  },
  ...over,
});

interface World {
  findings: Finding[];
  targets?: ReadTarget[];
  excepted?: Finding[];
  alerts?: Alert[];
  published?: Record<string, string>;
  releases?: { version: string; date: string }[];
  tags?: Record<string, string[]>;
  images?: Record<string, TrivyReport>;
  files?: Record<string, string>;
  minimumReleaseAge?: number;
  k3s?: Record<string, { published: string; images: string[] }>;
}

/** The sources as the world has them, and what was asked of them. */
function sourcesOf(world: World) {
  const asked: string[] = [];
  const sources: Sources = {
    published: async (name, version) => world.published?.[`${name}@${version}`],
    releases: async () => world.releases ?? [],
    async tags(repository) {
      asked.push(`tags ${repository}`);
      return world.tags?.[repository] ?? [];
    },
    async image(reference) {
      asked.push(`image ${reference}`);
      const report = world.images?.[reference];
      if (!report) throw new Error(`${reference}: no such image`);
      return report;
    },
    async k3s(release) {
      asked.push(`k3s ${release}`);
      // A tag with no release published, as the real source answers it.
      return world.k3s?.[release];
    },
    file: (path) => world.files?.[path],
    alerts: async () => world.alerts ?? [],
  };
  return { sources, asked };
}

async function judge(world: World, now = NOW) {
  const handoff: Handoff = {
    repository: REPOSITORY,
    started: new Date(now - 600_000).toISOString(),
    cache: '/nowhere',
    minimumReleaseAge: world.minimumReleaseAge,
    findings: world.findings,
    excepted: (world.excepted ?? []).map(alertKey),
    targets: world.targets ?? [LOCKFILE, IMAGE],
  };
  const { sources, asked } = sourcesOf(world);
  const { rows } = await assess(handoff, sources, now);
  return { rows, asked, verdict: verdict(rows) };
}

/** A Trivy report of an image made at the time given, with the findings given. */
const imageReport = (created: string, found: { package: string; advisory: string }[] = []): TrivyReport => ({
  Metadata: { ImageID: 'sha256:image', ImageConfig: { created } },
  Results: [
    {
      Class: 'os-pkgs',
      Type: 'debian',
      Vulnerabilities: found.map((f) => ({ PkgName: f.package, VulnerabilityID: f.advisory })),
    },
  ],
});

describe('a finding’s deadline', () => {
  it('gives each severity its days from the clock’s start: critical 2, high 7, medium 30, low 90', async () => {
    const seen = '2026-10-01T00:00:00Z';
    for (const severity of ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const) {
      const finding = npm({ severity });
      const { rows } = await judge({
        findings: [finding],
        published: { 'example-a@1.0.1': '2026-09-01T00:00:00Z' },
        alerts: [alertOf(finding, seen)],
      });
      expect(rows[0]?.due, severity).toBe(at(seen) + DAYS[severity] * DAY);
    }
    expect(DAYS).toMatchObject({ CRITICAL: 2, HIGH: 7, MEDIUM: 30, LOW: 90 });
  });

  it('takes the publisher’s higher rating, and not a lower one', () => {
    expect(severityOf({ severity: 'MEDIUM', publisher: 'CRITICAL' })).toBe('CRITICAL');
    expect(severityOf({ severity: 'HIGH', publisher: 'LOW' })).toBe('HIGH');
    expect(severityOf({ severity: 'UNKNOWN', publisher: 'LOW' })).toBe('LOW');
    expect(severityOf({ severity: 'HIGH' })).toBe('HIGH');
  });

  it('counts a fix published before the first scan from the first scan', async () => {
    const finding = npm({ severity: 'MEDIUM' });
    const { rows } = await judge({
      findings: [finding],
      published: { 'example-a@1.0.1': '2025-01-01T00:00:00Z' },
      alerts: [alertOf(finding, '2026-11-09T04:30:00Z')],
    });
    expect(rows[0]?.due).toBe(at('2026-11-09T04:30:00Z') + 30 * DAY);
    expect(rows[0]?.bucket).toBe('later');
  });

  it('counts a fix published after the first scan from its publish time and pnpm’s day', async () => {
    const finding = npm({ severity: 'HIGH' });
    const { rows } = await judge({
      findings: [finding],
      published: { 'example-a@1.0.1': '2026-11-05T12:00:00Z' },
      alerts: [alertOf(finding, '2026-10-01T00:00:00Z')],
    });
    expect(rows[0]?.due).toBe(at('2026-11-06T12:00:00Z') + 7 * DAY);
    expect(rows[0]?.bucket).toBe('week');
  });

  it('holds a fix still inside pnpm’s day, or the repository’s own wait, not yet installable', async () => {
    const finding = npm({ severity: 'CRITICAL' });
    const published = { 'example-a@1.0.1': '2026-11-09T12:00:00Z' };
    const alerts = [alertOf(finding, '2026-10-01T00:00:00Z')];
    const inside = await judge({ findings: [finding], published, alerts });
    // Installable at 12:00 on the 10th, after the run: no deadline yet.
    expect(inside.rows[0]?.installable).toBe(at('2026-11-10T12:00:00Z'));
    expect(inside.rows[0]?.due).toBeUndefined();
    expect(inside.rows[0]?.bucket).toBe('none');
    const after = await judge({ findings: [finding], published, alerts }, at('2026-11-10T13:00:00Z'));
    expect(after.rows[0]?.due).toBe(at('2026-11-12T12:00:00Z'));
    const longer = await judge({ findings: [finding], published, alerts, minimumReleaseAge: 3 * 24 * 60 });
    expect(longer.rows[0]?.installable).toBe(at('2026-11-12T12:00:00Z'));
  });

  it('keeps each copy’s fixed versions when two copies are one result', () => {
    const [one] = merge([npm({ installed: '1.2.0', fixed: '1.2.5' }), npm({ installed: '2.0.0', fixed: '2.0.3' })]);
    expect(one?.installed).toBe('1.2.0, 2.0.0');
    expect(one?.fixed).toBe('1.2.5, 2.0.3');
  });

  it('runs the clock of a package in two versions from the later of their fixes', async () => {
    const finding = npm({ installed: '1.2.0, 2.0.0', fixed: '1.2.5, 2.0.3' });
    const { rows } = await judge({
      findings: [finding],
      published: { 'example-a@1.2.5': '2026-09-01T00:00:00Z', 'example-a@2.0.3': '2026-11-01T00:00:00Z' },
      alerts: [alertOf(finding, '2026-10-01T00:00:00Z')],
    });
    expect(rows[0]?.installable).toBe(at('2026-11-02T00:00:00Z'));
  });

  it('gives a fix npm does not have, or none at all, no deadline', async () => {
    const { rows } = await judge({
      findings: [npm(), npm({ package: 'example-b', fixed: undefined })],
      alerts: [],
    });
    expect(rows.map((row) => row.bucket)).toEqual(['none', 'none']);
  });

  it('gives Node no fix from another major alone', async () => {
    const finding: Finding = { ...os(), type: 'node', package: 'node', installed: '22.30.0', fixed: '^24.22.1' };
    const { rows } = await judge({
      findings: [finding],
      releases: [{ version: 'v24.22.1', date: '2026-10-20' }],
      alerts: [alertOf(finding, '2026-10-01T00:00:00Z')],
    });
    expect(rows[0]?.installable).toBeUndefined();
  });

  it('dates Node’s fix by its first patched release in Node’s index', async () => {
    const finding: Finding = {
      ...os(),
      type: 'node',
      package: 'node',
      installed: '24.22.0',
      fixed: '^24.22.1 || ^22.30.1',
      severity: 'HIGH',
      publisher: 'HIGH',
    };
    const { rows } = await judge({
      findings: [finding],
      releases: [
        { version: 'v24.22.2', date: '2026-11-03' },
        { version: 'v24.22.1', date: '2026-10-20' },
        { version: 'v22.30.1', date: '2026-10-01' },
        { version: 'v24.22.0', date: '2026-10-01' },
      ],
      alerts: [alertOf(finding, '2026-10-01T00:00:00Z')],
    });
    expect(rows[0]?.installable).toBe(at('2026-10-20T00:00:00Z'));
  });
});

describe('an image’s fix', () => {
  const finding = os();
  const alerts = [alertOf(finding, '2026-10-01T00:00:00Z')];
  const tags = { node: ['24.22.1-trixie-slim', '24.23.0-trixie-slim', '24.23.0-alpine3.24', '25.0.0-trixie-slim'] };

  it('is installable from the newest image on the pin’s line once that image no longer has the finding', async () => {
    const { rows, asked } = await judge({
      findings: [finding],
      alerts,
      tags,
      images: { 'node:24.23.0-trixie-slim': imageReport('2026-11-01T00:00:00Z') },
    });
    expect(asked).toEqual(['tags node', 'image node:24.23.0-trixie-slim']);
    expect(rows[0]?.installable).toBe(at('2026-11-01T00:00:00Z'));
    expect(rows[0]?.due).toBe(at('2026-11-08T00:00:00Z'));
  });

  it('has no deadline when the line has no patched image', async () => {
    const { rows } = await judge({
      findings: [finding],
      alerts,
      tags,
      images: { 'node:24.23.0-trixie-slim': imageReport('2026-11-01T00:00:00Z', [finding]) },
    });
    expect(rows[0]?.installable).toBeUndefined();
    expect(rows[0]?.bucket).toBe('none');
  });

  it('scans no newest for a finding Trivy says has no fix, and each line’s newest once', async () => {
    const { asked } = await judge({
      findings: [os({ fixed: undefined }), os({ advisory: 'CVE-2099-20003' }), os({ advisory: 'CVE-2099-20004' })],
      alerts,
      tags,
      images: { 'node:24.23.0-trixie-slim': imageReport('2026-11-01T00:00:00Z') },
    });
    expect(asked).toEqual(['tags node', 'image node:24.23.0-trixie-slim']);
  });

  describe('of ours', () => {
    const OURS = `ghcr.io/example/factory@sha256:${'c'.repeat(64)}`;
    const RUNTIME = `gcr.io/distroless/nodejs24-debian13:nonroot@sha256:${'d'.repeat(64)}`;
    const ours: ReadTarget = {
      key: 'deploy/x.yaml ghcr.io/example/factory',
      kind: 'ours',
      file: 'deploy/x.yaml',
      label: OURS,
      image: OURS,
    };
    const stage: ReadTarget = {
      key: 'apps/factory/Dockerfile gcr.io/distroless/nodejs24-debian13',
      kind: 'dockerfile',
      file: 'apps/factory/Dockerfile',
      label: RUNTIME,
      image: RUNTIME,
    };
    const files = {
      'apps/factory/Dockerfile': [
        'FROM node:24.22.1-alpine3.24@sha256:aa AS base',
        'FROM base AS deps',
        `FROM ${RUNTIME} AS runtime`,
      ].join('\n'),
    };
    const inOurs = (over: Partial<Finding> = {}) =>
      os({ item: ours.key, file: ours.file, label: OURS, listed: OURS, ...over });
    const inStage = (over: Partial<Finding> = {}) =>
      os({ item: stage.key, file: stage.file, label: RUNTIME, listed: RUNTIME, ...over });
    const world = (findings: Finding[], images: Record<string, TrivyReport>) => ({
      findings,
      targets: [ours, stage],
      alerts: findings.map((f) => alertOf(f, '2026-10-01T00:00:00Z')),
      files,
      images,
    });

    it('looks along its Dockerfile’s runtime stage, and a tag that is no version at its image now', async () => {
      const { rows, asked } = await judge(
        world([inOurs(), inStage()], {
          'gcr.io/distroless/nodejs24-debian13:nonroot': imageReport('2026-11-02T00:00:00Z'),
        }),
      );
      expect(asked).toEqual(['image gcr.io/distroless/nodejs24-debian13:nonroot']);
      expect(rows[0]?.installable).toBe(at('2026-11-02T00:00:00Z'));
    });

    it('gives what its Dockerfile adds no fix from a newer base, and npm packages its lockfile resolves npm’s', async () => {
      const added = inOurs({ package: 'libadded', advisory: 'CVE-2099-20011' });
      const copied = inOurs({ type: 'node-pkg', package: 'example-copied', installed: '3.0.0', fixed: '3.0.1' });
      const own = inOurs({ type: 'node-pkg', package: 'example-a', installed: '1.0.0', fixed: '1.0.1' });
      const bundled = inOurs({ type: 'node-pkg', package: 'cross-example', installed: '7.0.0', fixed: '7.0.5' });
      const { rows, asked } = await judge({
        ...world(
          [
            added,
            own,
            bundled,
            copied,
            inStage({ type: 'node-pkg', package: 'cross-example', installed: '7.0.0', fixed: '7.0.5' }),
          ],
          {
            'gcr.io/distroless/nodejs24-debian13:nonroot': imageReport('2026-11-02T00:00:00Z', [
              { package: 'cross-example', advisory: 'CVE-2099-20002' },
            ]),
          },
        ),
        targets: [ours, stage, LOCKFILE],
        files: {
          ...files,
          'pnpm-lock.yaml': ['lockfileVersion: 9.0', 'packages:', '  example-a@1.0.0:', '    resolution: {}'].join(
            '\n',
          ),
        },
        published: {
          'example-a@1.0.1': '2026-10-15T00:00:00Z',
          'cross-example@7.0.5': '2026-10-15T00:00:00Z',
          'example-copied@3.0.1': '2026-10-15T00:00:00Z',
        },
      });
      expect(rows[0]?.installable).toBeUndefined();
      expect(rows[1]?.installable).toBe(at('2026-10-16T00:00:00Z'));
      // npm's own copy, bundled with the base, waits for a base that no longer has it, not for npm.
      expect(rows[2]?.installable).toBeUndefined();
      // Copied in by the Dockerfile, not resolved by a lockfile of ours: no fix to count from.
      expect(rows[3]?.installable).toBeUndefined();
      expect(asked).toEqual(['image gcr.io/distroless/nodejs24-debian13:nonroot']);
    });

    it('gives no day to count from when the newest says it was made in 1970, as a reproducible build does', async () => {
      const { rows } = await judge(
        world([inOurs(), inStage()], {
          'gcr.io/distroless/nodejs24-debian13:nonroot': imageReport('1970-01-01T00:00:00Z'),
        }),
      );
      expect(rows[0]?.installable).toBeUndefined();
      expect(rows[0]?.bucket).toBe('none');
    });
  });

  describe('that arrives only with a k3s release', () => {
    const PINNED = 'rancher/mirrored-metrics-server:v0.8.9';
    const target: ReadTarget = {
      key: 'k3s rancher/mirrored-metrics-server',
      kind: 'k3s-release',
      file: 'deploy/k3d/cluster.yaml',
      label: PINNED,
      image: PINNED,
      list: 'https://github.com/k3s-io/k3s/releases/download/v1.37.1%2Bk3s1/k3s-images.txt',
    };
    const inK3s = os({
      item: target.key,
      file: target.file,
      label: PINNED,
      listed: 'k3s v1.37.1+k3s1',
      type: 'gobinary',
      package: 'example.org/x',
    });
    const world = (shipped: Finding[]) => ({
      findings: [inK3s],
      targets: [target],
      alerts: [alertOf(inK3s, '2026-10-01T00:00:00Z')],
      tags: {
        'rancher/k3s': ['v1.36.9-k3s1', 'v1.37.1-k3s1', 'v1.37.2-k3s1', 'v1.37.3-rc1-k3s1'],
        // The image's own line has a newer tag, which no k3s release on the pin's line ships.
        'rancher/mirrored-metrics-server': ['v0.8.9', 'v0.9.0', 'v0.9.1'],
      },
      k3s: {
        'v1.37.2+k3s1': {
          published: '2026-11-03T12:00:00Z',
          images: ['docker.io/rancher/klipper-lb:v0.4.17', 'rancher/mirrored-metrics-server:v0.9.0'],
        },
      },
      images: {
        'rancher/mirrored-metrics-server:v0.9.0': imageReport('2026-10-30T00:00:00Z', shipped),
        'rancher/mirrored-metrics-server:v0.9.1': imageReport('2026-11-05T00:00:00Z'),
      },
    });

    it('counts from the newest k3s release on the pin’s line whose image no longer has the finding', async () => {
      const { rows, asked } = await judge(world([]));
      expect(asked).toEqual(['tags rancher/k3s', 'k3s v1.37.2+k3s1', 'image rancher/mirrored-metrics-server:v0.9.0']);
      expect(rows[0]?.installable).toBe(at('2026-11-03T12:00:00Z'));
    });

    it('dates the fix from the first release that ships it fixed, past one not yet published', async () => {
      const fixedCopy = 'docker.io/rancher/mirrored-metrics-server:v0.9.2';
      const base = world([inK3s]);
      const { rows, asked } = await judge({
        ...base,
        tags: {
          ...base.tags,
          'rancher/k3s': [
            'v1.37.1-k3s1',
            'v1.37.2-k3s1',
            'v1.37.2-k3s2',
            'v1.37.3-k3s1',
            'v1.37.4-k3s1',
            'v1.38.0-k3s1',
          ],
        },
        k3s: {
          'v1.37.2+k3s1': { published: '2026-11-03T12:00:00Z', images: ['rancher/mirrored-metrics-server:v0.9.0'] },
          'v1.37.2+k3s2': { published: '2026-11-05T00:00:00Z', images: [fixedCopy] },
          'v1.37.4+k3s1': { published: '2026-11-08T00:00:00Z', images: [fixedCopy] },
        },
        images: {
          'rancher/mirrored-metrics-server:v0.9.0': imageReport('2026-10-30T00:00:00Z', [inK3s]),
          // A reproducible build's 1970: the release's day counts, not the image's.
          [fixedCopy]: imageReport('1970-01-01T00:00:00Z'),
        },
      });
      expect(rows[0]?.installable).toBe(at('2026-11-05T00:00:00Z'));
      expect(asked).toEqual([
        'tags rancher/k3s',
        'k3s v1.37.2+k3s1',
        'image rancher/mirrored-metrics-server:v0.9.0',
        'k3s v1.37.2+k3s2',
        `image ${fixedCopy}`,
      ]);
    });

    it('skips a tag with no release published, and never crosses to another Kubernetes minor', async () => {
      const base = world([]);
      const { rows, asked } = await judge({
        ...base,
        tags: { ...base.tags, 'rancher/k3s': ['v1.37.1-k3s1', 'v1.37.2-k3s1', 'v1.37.3-k3s1', 'v1.38.0-k3s1'] },
        k3s: {},
      });
      expect(rows[0]?.installable).toBeUndefined();
      expect(asked).toEqual(['tags rancher/k3s', 'k3s v1.37.2+k3s1', 'k3s v1.37.3+k3s1']);
    });

    it('takes no fix from a release that lists the pinned image itself', async () => {
      const base = world([]);
      const { rows } = await judge({
        ...base,
        k3s: { 'v1.37.2+k3s1': { published: '2026-11-03T12:00:00Z', images: [`docker.io/${PINNED}`] } },
        images: { [`docker.io/${PINNED}`]: imageReport('2026-10-01T00:00:00Z') },
      });
      expect(rows[0]?.installable).toBeUndefined();
    });

    it('has no deadline while that release still ships it, whatever the image’s own newest tag', async () => {
      const { rows } = await judge(world([inK3s]));
      expect(rows[0]?.installable).toBeUndefined();
      expect(rows[0]?.bucket).toBe('none');
    });
  });

  it('fails the read when the newest image cannot be scanned', async () => {
    await expect(judge({ findings: [finding], alerts, tags, images: {} })).rejects.toThrow(/no such image/);
  });
});

describe('the clock', () => {
  it('excepts an excepted finding from any deadline, and it fails nothing', async () => {
    const finding = npm({ severity: 'CRITICAL' });
    const { rows, verdict: v } = await judge({
      findings: [finding],
      excepted: [finding],
      published: { 'example-a@1.0.1': '2025-01-01T00:00:00Z' },
      alerts: [alertOf(finding, '2026-01-01T00:00:00Z', { state: 'dismissed' })],
    });
    expect(rows[0]?.excepted).toBe(true);
    expect(rows[0]?.due).toBeUndefined();
    expect(v.passes).toBe(true);
    expect(v.lines[0]).toContain('0 open results, 1 excepted');
  });

  it('returns an expired exception’s finding with the deadline it always had', async () => {
    const finding = npm({ severity: 'HIGH' });
    // Excepted from 1 October to 1 November: its alert dismissed, then reopened when the exception lapsed.
    const { rows, verdict: v } = await judge({
      findings: [finding],
      published: { 'example-a@1.0.1': '2025-01-01T00:00:00Z' },
      alerts: [alertOf(finding, '2026-10-01T00:00:00Z', { updated_at: '2026-11-02T04:30:00Z' })],
    });
    expect(rows[0]?.due).toBe(at('2026-10-08T00:00:00Z'));
    expect(rows[0]?.bucket).toBe('overdue');
    expect(v.passes).toBe(false);
  });

  it('keeps a renamed item’s clock, and starts its own for the same package in another item that is no rename', async () => {
    const moved = npm({
      item: 'lockfile apps/new/pnpm-lock.yaml',
      label: 'apps/new/pnpm-lock.yaml',
      file: 'apps/new/pnpm-lock.yaml',
    });
    const old = npm({
      item: 'lockfile apps/old/pnpm-lock.yaml',
      label: 'apps/old/pnpm-lock.yaml',
      file: 'apps/old/pnpm-lock.yaml',
    });
    const other = npm({
      item: 'lockfile apps/other/pnpm-lock.yaml',
      label: 'apps/other/pnpm-lock.yaml',
      file: 'apps/other/pnpm-lock.yaml',
    });
    const target = (file: string): ReadTarget => ({ key: `lockfile ${file}`, kind: 'lockfile', file, label: file });
    const { rows } = await judge({
      findings: [moved, other],
      targets: [target('apps/new/pnpm-lock.yaml'), target('apps/other/pnpm-lock.yaml')],
      published: { 'example-a@1.0.1': '2025-01-01T00:00:00Z' },
      alerts: [
        // The old item's alert, closed by today's upload; the new item's, made by it.
        alertOf(old, '2026-10-01T00:00:00Z', {
          state: 'fixed',
          fixed_at: '2026-11-10T04:25:00Z',
          updated_at: '2026-11-10T04:25:00Z',
        }),
        alertOf(moved, '2026-11-10T04:25:00Z'),
        // The other item was on the list before, with an alert of its own: its new finding is its own.
        alertOf(npm({ ...other, package: 'example-z', advisory: 'CVE-2099-20009' }), '2026-09-01T00:00:00Z'),
        alertOf(other, '2026-11-10T04:25:00Z'),
      ],
    });
    expect(rows[0]?.seen).toBe(at('2026-10-01T00:00:00Z'));
    expect(rows[0]?.firstSeenToday).toBe(false);
    expect(rows[1]?.firstSeenToday).toBe(true);
    expect(rows[1]?.seen).toBe(at('2026-11-10T04:25:00Z'));
  });

  it('takes no clock from a gone image of another repository: that is another item, not a rename', async () => {
    const gone = os({ item: 'Dockerfile old', label: `example/old:1@sha256:${'e'.repeat(64)}`, file: 'Dockerfile' });
    const added = os();
    const { rows } = await judge({
      findings: [added],
      targets: [IMAGE],
      alerts: [
        alertOf(gone, '2026-09-01T00:00:00Z', { state: 'fixed', updated_at: '2026-11-10T04:25:00Z' }),
        alertOf(added, '2026-11-10T04:25:00Z'),
      ],
      tags: { node: ['24.22.1-trixie-slim'] },
      images: { 'node:24.22.1-trixie-slim': imageReport('2026-11-01T00:00:00Z', [added]) },
    });
    expect(rows[0]?.firstSeenToday).toBe(true);
  });

  describe('across a re-pin', () => {
    // Code scanning split each result of the item at 20:04:50 on the 9th: it closed the old alert and opened another.
    const REPIN = '2026-11-09T20:04:50Z';
    const before = os({ label: `node:24.22.1-trixie-slim@sha256:${'a'.repeat(64)}` });
    const after = os();
    const world = (findings: Finding[], alerts: Alert[]) => ({
      findings,
      targets: [IMAGE],
      alerts,
      tags: { node: ['24.22.1-trixie-slim'] },
      images: { 'node:24.22.1-trixie-slim': imageReport('2026-11-01T00:00:00Z') },
    });

    it('keeps the first clock of a finding the new pin still has, and does not count it new', async () => {
      const { rows, verdict: v } = await judge(
        world(
          [after],
          [alertOf(before, '2026-11-01T00:00:00Z', { state: 'fixed', fixed_at: REPIN }), alertOf(after, REPIN)],
        ),
      );
      expect(rows[0]?.seen).toBe(at('2026-11-01T00:00:00Z'));
      expect(rows[0]?.firstSeenToday).toBe(false);
      expect(v.fresh).toBe(0);
    });

    it('carries the clock back across several re-pins, and counts a finding first seen today new once', async () => {
      const middle = os({ label: `node:24.22.1-trixie-slim@sha256:${'c'.repeat(64)}` });
      const added = os({ package: 'libnew', advisory: 'CVE-2099-20030' });
      const { rows, verdict: v } = await judge(
        world(
          [after, added],
          [
            alertOf(before, '2026-10-01T00:00:00Z', { state: 'fixed', fixed_at: '2026-10-20T08:00:00Z' }),
            alertOf(middle, '2026-10-20T08:00:00Z', { state: 'fixed', fixed_at: REPIN }),
            alertOf(after, REPIN),
            alertOf(added, '2026-11-10T04:25:00Z'),
          ],
        ),
      );
      expect(rows[0]?.seen).toBe(at('2026-10-01T00:00:00Z'));
      expect(rows[1]?.firstSeenToday).toBe(true);
      expect(v.fresh).toBe(1);
    });

    it('carries the day across an alert closed a minute after the next was made, as one upload’s categories do', async () => {
      const { rows } = await judge(
        world(
          [after],
          [
            alertOf(before, '2026-11-01T00:00:00Z', { state: 'fixed', fixed_at: '2026-11-09T20:05:51Z' }),
            alertOf(after, REPIN),
          ],
        ),
      );
      expect(rows[0]?.seen).toBe(at('2026-11-01T00:00:00Z'));
    });

    it('carries the day within ten minutes either side of the next one’s making, and no further', async () => {
      const at10 = (fixed: string) =>
        judge(
          world(
            [after],
            [alertOf(before, '2026-11-01T00:00:00Z', { state: 'fixed', fixed_at: fixed }), alertOf(after, REPIN)],
          ),
        );
      // Nine minutes before, and ten after: one upload's categories.
      expect((await at10('2026-11-09T19:55:50Z')).rows[0]?.seen).toBe(at('2026-11-01T00:00:00Z'));
      expect((await at10('2026-11-09T20:14:50Z')).rows[0]?.seen).toBe(at('2026-11-01T00:00:00Z'));
      // Eleven minutes either way: another upload.
      expect((await at10('2026-11-09T19:53:50Z')).rows[0]?.seen).toBe(at(REPIN));
      expect((await at10('2026-11-09T20:15:51Z')).rows[0]?.seen).toBe(at(REPIN));
    });

    it('takes no day from an alert closed an hour from the next one’s making: two uploads, not one', async () => {
      const { rows } = await judge(
        world(
          [after],
          [
            alertOf(before, '2026-11-01T00:00:00Z', { state: 'fixed', fixed_at: '2026-11-09T21:04:50Z' }),
            alertOf(after, REPIN),
          ],
        ),
      );
      expect(rows[0]?.seen).toBe(at(REPIN));
    });

    it('starts a new clock for a finding that was really fixed and came back', async () => {
      const { rows } = await judge(
        world(
          [after],
          [
            alertOf(before, '2026-09-01T00:00:00Z', { state: 'fixed', fixed_at: '2026-09-10T04:30:00Z' }),
            alertOf(after, '2026-11-08T04:30:00Z'),
          ],
        ),
      );
      expect(rows[0]?.seen).toBe(at('2026-11-08T04:30:00Z'));
    });

    it('closes a finding the new pin really fixed: it has no row and fails nothing', async () => {
      const { rows, verdict: v } = await judge(
        world([], [alertOf(before, '2026-11-01T00:00:00Z', { state: 'fixed', fixed_at: REPIN })]),
      );
      expect(rows).toEqual([]);
      expect(v.passes).toBe(true);
    });
  });

  it('matches an alert whose pin has moved since, by its item, package and advisory, never its line or version', async () => {
    const finding = npm({ line: 400, installed: '1.0.0' });
    const before = npm({ line: 120, installed: '0.9.0' });
    const { rows } = await judge({ findings: [finding], alerts: [alertOf(before, '2026-10-01T00:00:00Z')] });
    expect(rows[0]?.seen).toBe(at('2026-10-01T00:00:00Z'));
  });
});

describe('the run', () => {
  const published = { 'example-a@1.0.1': '2025-01-01T00:00:00Z' };

  it('fails on a new high or critical with a fix to install, and counts one with none, failing nothing', async () => {
    const fixable = npm({ severity: 'HIGH' });
    const today = '2026-11-10T04:25:00Z';
    const withFix = await judge({ findings: [fixable], published, alerts: [alertOf(fixable, today)] });
    expect(withFix.verdict.fresh).toBe(1);
    expect(withFix.verdict.passes).toBe(false);
    const none = npm({ severity: 'CRITICAL', package: 'example-b', fixed: undefined });
    const without = await judge({ findings: [none], alerts: [alertOf(none, today)] });
    expect(without.verdict.fresh).toBe(0);
    expect(without.verdict.waiting).toBe(1);
    expect(without.verdict.passes).toBe(true);
    expect(without.verdict.lines[2]).toBe(
      'New high or critical (first seen today): 0 with a fix to install, 1 with none the scan can date, which fail nothing.',
    );
    // A fix still inside pnpm's wait is none yet: nothing to move today.
    const waitingFix = npm({ severity: 'HIGH', package: 'example-c' });
    const inside = await judge({
      findings: [waitingFix],
      published: { 'example-c@1.0.1': '2026-11-10T00:00:00Z' },
      alerts: [alertOf(waitingFix, today)],
    });
    expect(inside.verdict.passes).toBe(true);
    const medium = npm({ severity: 'MEDIUM', fixed: undefined });
    expect((await judge({ findings: [medium], alerts: [] })).verdict.passes).toBe(true);
  });

  it('fails on one due within a day', async () => {
    const finding = npm({ severity: 'CRITICAL' });
    const { verdict: v } = await judge({
      findings: [finding],
      published,
      alerts: [alertOf(finding, '2026-11-08T12:00:00Z')],
    });
    expect(v.byBucket.day).toBe(1);
    expect(v.passes).toBe(false);
  });

  it('fails on one past its deadline', async () => {
    const finding = npm({ severity: 'LOW' });
    const { verdict: v } = await judge({
      findings: [finding],
      published,
      alerts: [alertOf(finding, '2026-08-01T00:00:00Z')],
    });
    expect(v.byBucket.overdue).toBe(1);
    expect(v.passes).toBe(false);
  });

  it('passes on findings due later, and a proving run on any of them, giving counts alone', async () => {
    const later = npm({ severity: 'MEDIUM' });
    const late = npm({ severity: 'LOW', package: 'example-b' });
    const world = {
      findings: [later, late],
      published: { ...published, 'example-b@1.0.1': '2025-01-01T00:00:00Z' },
      alerts: [alertOf(later, '2026-11-01T00:00:00Z'), alertOf(late, '2026-01-01T00:00:00Z')],
    };
    const { rows } = await judge({ ...world, findings: [later] });
    expect(verdict(rows).passes).toBe(true);
    const both = await judge(world);
    const proving = verdict(both.rows, true);
    expect(proving.passes).toBe(true);
    expect(proving.lines.join('\n')).toContain('a proving run fails on none');
    expect(proving.lines.join('\n')).not.toMatch(/example-|CVE-/);
    expect(proving.lines[1]).toBe('By deadline: overdue 1, due within a day 0, within a week 0, later 1, no fix 0.');
  });
});

describe('the parts', () => {
  it('reads the publisher’s rating from the advisory’s own source, and the repository’s wait from its workspace', () => {
    expect(publisherOf({ DataSource: { ID: 'ghsa' }, VendorSeverity: { ghsa: 4, nvd: 2 } })).toBe('CRITICAL');
    expect(publisherOf({ DataSource: { ID: 'debian' }, VendorSeverity: { nvd: 4, debian: 1 } })).toBe('LOW');
    expect(publisherOf({ DataSource: { ID: 'debian' }, VendorSeverity: { nvd: 4 } })).toBeUndefined();
    expect(publisherOf({ VendorSeverity: { nvd: 4 } })).toBeUndefined();
    expect(minimumReleaseAge('packages:\n  - apps/*\nminimumReleaseAge: 4320 # three days\n')).toBe(4320);
    expect(minimumReleaseAge('# pnpm already waits a day (minimumReleaseAge)\npackages: []\n')).toBeUndefined();
  });

  it('takes the first fixed version above what is installed', () => {
    expect(firstFixed('1.2.0', '1.2.5, 2.0.1, 1.3.0')).toBe('1.2.5');
    expect(firstFixed('2.0.0', '1.2.5, 2.0.1')).toBe('2.0.1');
    expect(firstFixed('1.0.0', undefined)).toBeUndefined();
  });

  it('finds the newest tag on a line as ci-images.sh does', () => {
    const tags = [
      '24.21.0-alpine3.24',
      '24.22.2-alpine3.24',
      '24.9.0-alpine3.24',
      '25.0.0-alpine3.24',
      '24.22.3-trixie-slim',
    ];
    expect(newestOnLine('24.21.0-alpine3.24', tags)).toBe('24.22.2-alpine3.24');
    expect(newestOnLine('v1.64.1-noble', ['v1.64.1-noble', 'v1.65.0-noble', 'v2.0.0-noble', 'v1.66.0-jammy'])).toBe(
      'v1.65.0-noble',
    );
    expect(newestOnLine('nonroot', tags)).toBeUndefined();
  });

  it('follows a Dockerfile’s last stage back to the image it names', () => {
    const file = [
      'FROM node:24@sha256:aa AS node',
      'FROM mcr.microsoft.com/playwright:v1 AS browsers',
      'FROM browsers AS playwright',
      'FROM playwright AS runtime',
    ].join('\n');
    expect(runtimeStage(file)).toBe('mcr.microsoft.com/playwright:v1');
  });

  it('finds the Dockerfile of an image of ours by build.yml’s names', () => {
    const files = new Set([
      'apps/factory/Dockerfile',
      'apps/factory/Dockerfile.browser',
      'apps/runner/Dockerfile',
      'Dockerfile',
    ]);
    const exists = (path: string) => files.has(path);
    expect(dockerfileOf('ghcr.io/x/y/factory@sha256:aa', exists)).toBe('apps/factory/Dockerfile');
    expect(dockerfileOf('ghcr.io/x/y/factory-browser@sha256:aa', exists)).toBe('apps/factory/Dockerfile.browser');
    expect(dockerfileOf('ghcr.io/x/y/factory-runner@sha256:aa', exists)).toBe('apps/runner/Dockerfile');
    expect(dockerfileOf('ghcr.io/x/website/website@sha256:aa', exists)).toBe('Dockerfile');
  });

  it('asks npm for a package by its whole name, encoded', () => {
    expect(npmUrl('example-a')).toBe('https://registry.npmjs.org/example-a');
    expect(npmUrl('@types/node')).toBe('https://registry.npmjs.org/@types%2Fnode');
    expect(npmUrl('a/b/../c?d#e')).toBe('https://registry.npmjs.org/a%2Fb%2F..%2Fc%3Fd%23e');
  });

  it('lists the k3s releases after a pin on its Kubernetes minor, any build, oldest first', () => {
    const tags = [
      'v1.36.9-k3s1',
      'v1.37.1-k3s1',
      'v1.37.1-k3s2',
      'v1.37.10-k3s1',
      'v1.37.2-k3s1',
      'v1.37.3-rc1-k3s1',
      'v1.38.0-k3s1',
    ];
    expect(k3sLine('v1.37.1+k3s1', tags)).toEqual(['v1.37.1+k3s2', 'v1.37.2+k3s1', 'v1.37.10+k3s1']);
    expect(k3sLine('not a release', tags)).toEqual([]);
  });

  it('reads a k3s release from its list’s URL', () => {
    expect(k3sReleaseOf('https://github.com/k3s-io/k3s/releases/download/v1.37.1%2Bk3s1/k3s-images.txt')).toBe(
      'v1.37.1+k3s1',
    );
    expect(k3sReleaseOf('https://example.org/v1.37.1%2Bk3s1/k3s-images.txt')).toBeUndefined();
  });

  it('names a repository as skopeo reads it', () => {
    expect(skopeoName('node')).toBe('docker://docker.io/library/node');
    expect(skopeoName('rancher/k3s')).toBe('docker://docker.io/rancher/k3s');
    expect(skopeoName('ghcr.io/open-feature/flagd')).toBe('docker://ghcr.io/open-feature/flagd');
  });
});
