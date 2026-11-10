import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { INSTALL, inSbom, LIST, listed, missing, pnpmVersion } from '../../src/vulnerabilities/coverage.ts';
import type { Item } from '../../src/vulnerabilities/inventory.ts';
import {
  advisoriesFor,
  entries,
  nodeInConfig,
  nodeInPackages,
  nodeInSbom,
  readable,
  satisfies,
} from '../../src/vulnerabilities/node.ts';
import { PROOF } from '../../src/vulnerabilities/proof.ts';
import {
  CATEGORY,
  type Finding,
  fingerprint,
  groups,
  LIMITS,
  merge,
  overLimits,
  sarif,
} from '../../src/vulnerabilities/sarif.ts';
import {
  DB_MAX_AGE_MS,
  databaseAge,
  imagesIn,
  itemKey,
  lockfileLine,
  nodeFindingsOf,
  readOurs,
  report,
  sbomPaths,
  scan,
  type Tools,
  type TrivyReport,
  withPaths,
} from '../../src/vulnerabilities/scan.ts';

/**
 * The daily scan's decisions, on Trivy's own JSON (fixtures/trivy, in the shape Trivy's `--format json
 * --list-all-pkgs` writes): what it reads, what it cannot, and what it would upload.
 */
const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/trivy/${name}.json`, import.meta.url), 'utf-8')) as TrivyReport;
const digest = (c: string) => `sha256:${c.repeat(64)}`;
/** Four of Node's own core entries (fixtures/node-core.json, from nodejs/security-wg's vuln/core/index.json). */
/** The files the test checkout tracks. */
const TRACKED = new Set(['pnpm-lock.yaml', 'deploy/values/grafana.yaml']);
const DB = entries(readFileSync(new URL('./fixtures/node-core.json', import.meta.url), 'utf-8'));

const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'scan-'));
  made.push(dir);
  return dir;
};

/** A checkout holding a lockfile, as the scan reads one. */
function checkout() {
  const root = temp();
  writeFileSync(
    join(root, 'pnpm-lock.yaml'),
    [
      "lockfileVersion: '9.0'",
      '',
      'packages:',
      '',
      '  minimatch@10.0.3:',
      '    resolution: {integrity: sha512-x}',
      '',
      '  yaml@2.9.1:',
      '    resolution: {integrity: sha512-y}',
      '',
      'snapshots:',
      '',
      '  minimatch@10.0.3: {}',
    ].join('\n'),
  );
  return root;
}

const OURS = `ghcr.io/the-roganator/cv-software-factory/factory-runner@${digest('1')}`;
const SIGNER = 'https://github.com/the-roganator/cv-software-factory/.github/workflows/build.yml@refs/heads/main';
const POSTGRES = `postgres:18.6-alpine3.24@${digest('2')}`;

const items = (): Item[] => [
  { kind: 'lockfile', name: 'pnpm-lock.yaml', file: 'pnpm-lock.yaml', line: 1 },
  {
    kind: 'ours',
    name: OURS,
    file: 'deploy/ours/kustomization.yaml',
    line: 23,
    image: OURS,
    signer: SIGNER,
  },
  { kind: 'third-party', name: POSTGRES, file: 'deploy/base/postgres/statefulset.yaml', line: 21, image: POSTGRES },
];

interface Fake {
  /** Each image's report, by reference; an image not here cannot be pulled. */
  images?: Record<string, TrivyReport>;
  /** The SBOMs each image carries, one per platform, as Trivy reads them; none for an image with no attestation. */
  sboms?: Record<string, TrivyReport[]>;
  lockfile?: TrivyReport;
  /** The Node version Syft's SBOM of each image names, as `pkg:generic/node`; none where it names no Node. */
  node?: Record<string, string>;
}

/** The scan's tools, answering from Trivy's JSON, and what was asked of them. */
function tools(fake: Fake) {
  const asked: string[][] = [];
  const t: Tools = {
    temp,
    async trivy(args, src) {
      asked.push(args);
      if (args[0] === 'fs') return fake.lockfile ?? fixture('lockfile');
      if (args[0] === 'sbom') {
        const { image, index } = JSON.parse(readFileSync(join(src ?? '', 'sbom.spdx.json'), 'utf-8'));
        const report = fake.sboms?.[image]?.[index];
        if (!report) throw new Error('no such SBOM');
        return report;
      }
      const reference = args[args.length - 1] ?? '';
      const report = fake.images?.[reference];
      if (!report) throw Object.assign(new Error('pull failed'), { stderr: `MANIFEST_UNKNOWN: ${reference}` });
      return report;
    },
    async attestations(image) {
      const sboms = fake.sboms?.[image];
      if (!sboms) throw new Error('no matching attestations');
      const node = fake.node?.[image];
      // Syft's SPDX, as far as the scan reads it: its Node binary, a generic package Trivy does not read.
      const packages = node
        ? [{ name: 'node', versionInfo: node, externalRefs: [{ referenceLocator: `pkg:generic/node@${node}` }] }]
        : [];
      return sboms.map((_, index) => ({ image, index, packages }));
    },
    async render() {
      return '';
    },
    async fetch() {
      return '';
    },
    retry: (what) => what(),
  };
  return { tools: t, asked };
}

/**
 * Everything readable: the lockfile; ours from its two SBOMs, which give Node 24.22.2; Postgres; and the proof, whose
 * SBOMs give no Node, from its image, which names Node 24.22.0.
 */
const everything = (): Fake => ({
  node: { [OURS]: '24.22.2' },
  sboms: {
    [OURS]: [fixture('sbom-amd64'), fixture('sbom-arm64')],
    [PROOF.image]: [fixture('sbom-amd64'), fixture('sbom-arm64')],
  },
  images: {
    [OURS]: fixture('image-node'),
    [POSTGRES]: fixture('image-postgres'),
    [PROOF.image]: fixture('image-node'),
  },
});

describe('an item it cannot read', () => {
  it('fails the run, is named, and nothing is uploaded', async () => {
    const fake = everything();
    delete fake.images?.[POSTGRES];
    const outcome = await scan(tools(fake).tools, checkout(), items(), [], DB, TRACKED);
    expect(outcome.unreadable).toEqual([{ name: POSTGRES, why: `could not be pulled: MANIFEST_UNKNOWN: ${POSTGRES}` }]);
    const { lines, passes } = report(outcome, true);
    expect(passes).toBe(false);
    expect(lines.at(-1)).toBe('The run fails, and nothing is uploaded.');
    // The log names the item, never a package or an advisory.
    expect(lines.join('\n')).not.toMatch(/libxml2|CVE-2026-0202|minimatch|GHSA/);
  });

  it('is an image Trivy gave no analysis of, or a chart with a values file the checkout does not track', async () => {
    const fake = everything();
    // An image with no packages at all is read; a report naming no image Trivy analysed is not.
    const pause = `registry.k8s.io/pause:3.10@${digest('6')}`;
    if (fake.images) {
      fake.images[POSTGRES] = { SchemaVersion: 2, ArtifactName: POSTGRES };
      fake.images[pause] = { SchemaVersion: 2, ArtifactName: pause, Metadata: { ImageID: `sha256:${'7'.repeat(64)}` } };
    }
    const empty: Item = { kind: 'third-party', name: pause, file: 'deploy/pause.yaml', line: 3, image: pause };
    const chart: Item = {
      kind: 'chart',
      name: 'grafana',
      file: 'deploy/grafana.yaml',
      line: 14,
      chart: { repo: 'https://example.test', chart: 'grafana', version: '1.0.0', release: 'grafana', values: [] },
    };
    const outside = (values: string[]): Item => ({
      ...chart,
      chart: { ...(chart.chart as NonNullable<Item['chart']>), values },
    });
    const { tools: t } = tools(fake);
    let rendered = 0;
    t.render = async () => {
      rendered++;
      return 'image: busybox\n';
    };
    const outcome = await scan(
      t,
      checkout(),
      [...items(), empty, outside(['../../.docker/config.json']), outside(['deploy/values/untracked.yaml'])],
      [],
      DB,
      TRACKED,
    );
    expect(outcome.unreadable.map((entry) => [entry.name, entry.why])).toEqual([
      [POSTGRES, 'could not be pulled: Trivy gave no image it analysed'],
      ['grafana', 'a values file it names is not a file the checkout tracks: ../../.docker/config.json'],
      ['grafana', 'a values file it names is not a file the checkout tracks: deploy/values/untracked.yaml'],
    ]);
    // Neither chart was rendered: a values file outside the checkout never reaches Helm.
    expect(rendered).toBe(0);
    // A tracked one renders, and its bare image is scanned, not passed over.
    const read = await scan(t, checkout(), [outside(['deploy/values/grafana.yaml'])], [], DB, TRACKED);
    expect(rendered).toBe(1);
    expect(read.unreadable).toEqual([
      { name: 'grafana: busybox', why: 'could not be pulled: MANIFEST_UNKNOWN: busybox' },
    ]);
  });

  it('is a lockfile Trivy reads no packages from, an image with no SBOM attested, or a pin the list does not read', async () => {
    const fake = { ...everything(), lockfile: fixture('lockfile-empty') };
    delete fake.sboms?.[OURS];
    const pin = {
      file: 'Dockerfile',
      line: 3,
      reference: `alpine@${digest('9')}`,
      why: 'a FROM the list does not read',
    };
    const outcome = await scan(tools(fake).tools, checkout(), items(), [pin], DB, TRACKED);
    expect(outcome.unreadable.map((entry) => entry.name)).toEqual([
      `alpine@${digest('9')} (Dockerfile:3)`,
      'pnpm-lock.yaml',
      OURS,
    ]);
    expect(outcome.unreadable[1]?.why).toBe('Trivy read no packages from it');
    expect(outcome.unreadable[2]?.why).toMatch(/^no SBOM attestation verified/);
    expect(report(outcome, true).passes).toBe(false);
  });

  it('passes when every item was read and the proof shows its advisory', async () => {
    const outcome = await scan(tools(everything()).tools, checkout(), items(), [], DB, TRACKED);
    expect(outcome.unreadable).toEqual([]);
    expect(outcome.proof).toEqual({ found: true, source: 'image', unreadable: undefined, node: '24.22.0' });
    const { lines, passes } = report(outcome, true);
    expect(passes).toBe(true);
    expect(lines[0]).toBe('Read 3 targets. Findings by severity: critical 1, high 1, medium 1, low 0, unknown 0.');
    expect(lines).toContain(`The proof image shows ${PROOF.advisory} in its Node 24.22.0, read from its image.`);
    expect(lines).toContain('The results are in 1 of 20 runs, each a category of its own:');
    expect(lines.filter((line) => line.startsWith('  vulnerabilities/'))).toEqual([
      '  vulnerabilities/01: 3 results, 3 items: lockfile pnpm-lock.yaml; deploy/ours/kustomization.yaml ghcr.io/the-roganator/cv-software-factory/factory-runner; deploy/base/postgres/statefulset.yaml postgres',
    ]);
    // The proof's own finding is not the repository's: nothing of it is in the file.
    const results = sarif(outcome.findings).runs[0]?.results ?? [];
    expect(results.map((result) => result.ruleId).sort()).toEqual([
      'CVE-2026-0101',
      'CVE-2026-0202',
      'GHSA-g3hv-75wg-m249',
    ]);
    expect(JSON.stringify(results)).not.toContain(PROOF.image);
  });
});

describe('results over the limit', () => {
  it('fail the run when the groups need more runs than a file holds, and nothing is uploaded', async () => {
    const outcome = await scan(tools(everything()).tools, checkout(), items(), [], DB, TRACKED);
    // Three items of one result each: two to a run, so two runs, over a limit of one.
    const { lines, passes } = report(outcome, true, { ...LIMITS, results: 2, runs: 1 });
    expect(passes).toBe(false);
    expect(lines).toContain("The results are over code scanning's limits: 2 runs, over 1.");
    expect(lines.at(-1)).toBe('The run fails, and nothing is uploaded.');
  });

  it('cut an item over 5,000 into full runs of its own, in order of package and advisory, every result kept', () => {
    const many = Array.from({ length: 2 * LIMITS.results + 1 }, (_, n) =>
      finding(
        'big',
        `CVE-2026-${String(n % 100).padStart(3, '0')}`,
        `pkg-${String(Math.floor(n / 100)).padStart(3, '0')}`,
      ),
    );
    const file = sarif([finding('small', 'CVE-2026-1'), ...many, finding('after', 'CVE-2026-1')]);
    expect(overLimits(file)).toEqual([]);
    expect(file.runs.slice(0, 5).map((run) => [run.results.length, run.properties.items])).toEqual([
      [1, ['small']],
      [5_000, ['big (cut 1 of 3)']],
      [5_000, ['big (cut 2 of 3)']],
      // The last cut's run is filled with the whole items after it.
      [2, ['big (cut 3 of 3)', 'after']],
      [0, []],
    ]);
    // The first cut has the first packages, the last the last.
    expect(file.runs[1]?.results[0]?.message.text).toMatch(/^pkg-000 /);
    expect(file.runs[3]?.results[0]?.message.text).toMatch(/^pkg-100 /);
    expect(
      new Set(file.runs.flatMap((run) => run.results.map((r) => r.partialFingerprints['vulnerabilities/v1']))).size,
    ).toBe(many.length + 2);
  });

  it('pass at 5,000 in a run, every result in the file', () => {
    const all = [
      ...Array.from({ length: 3_000 }, (_, n) => finding('a', `CVE-2026-${n}`)),
      ...Array.from({ length: 2_000 }, (_, n) => finding('b', `CVE-2026-${n}`)),
      ...Array.from({ length: 4_999 }, (_, n) => finding('c', `CVE-2026-${n}`)),
    ];
    const file = sarif(all);
    expect(overLimits(file)).toEqual([]);
    expect(file.runs.map((run) => run.results.length).slice(0, 3)).toEqual([5_000, 4_999, 0]);
    expect(file.runs.flatMap((run) => run.results)).toHaveLength(all.length);
  });
});

/** A finding of an invented item, for the grouping alone. */
function finding(item: string, advisory: string, pkg = 'pkg'): Finding {
  return {
    item,
    label: item,
    file: 'Dockerfile',
    line: 1,
    type: 'debian',
    package: pkg,
    installed: '1',
    advisory,
    severity: 'HIGH',
  };
}

describe('the runs', () => {
  it('fail the file when two share a category', () => {
    const file = sarif([finding('a', 'CVE-2026-1')]);
    const [first, second] = file.runs;
    if (first && second) second.automationDetails = { ...first.automationDetails };
    expect(overLimits(file)).toEqual([`more than one run in ${CATEGORY}/01`]);
  });

  it('are 20, in the categories vulnerabilities/01 to /20, the unused ones empty, in every file', () => {
    for (const file of [sarif([]), sarif([finding('a', 'CVE-2026-1')])]) {
      expect(file.runs.map((run) => run.automationDetails.id)).toEqual(
        Array.from({ length: 20 }, (_, n) => `${CATEGORY}/${String(n + 1).padStart(2, '0')}/`),
      );
      expect(file.runs.slice(1).every((run) => !run.results.length && !run.tool.driver.rules.length)).toBe(true);
    }
  });

  it('carry each rule its results name, with indices into its own run', () => {
    const all = [
      ...Array.from({ length: 4_000 }, (_, n) => finding('a', `CVE-2026-${n}`)),
      ...Array.from({ length: 2_000 }, (_, n) => finding('b', `CVE-2026-${n + 3_000}`)),
    ];
    for (const run of sarif(all).runs) {
      expect(run.tool.driver.rules).toHaveLength(new Set(run.results.map((result) => result.ruleId)).size);
      for (const result of run.results) expect(run.tool.driver.rules[result.ruleIndex]?.id).toBe(result.ruleId);
    }
  });

  // Random sizes, a seeded generator so a failure repeats: whatever the items, the list's order is kept, no run is over
  // the limit, only an item over it is cut, and no result is lost or doubled.
  it('never exceed the limit, cut only an item over it, and never lose a result', () => {
    let seed = 7;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    for (let round = 0; round < 50; round++) {
      const limit = 1 + Math.floor(random() * 50);
      const all: Finding[] = [];
      const order: string[] = [];
      for (let item = 0; item < 1 + Math.floor(random() * 30); item++) {
        order.push(`item-${item}`);
        // Now and then an item alone over the limit.
        const size = random() < 0.1 ? limit + 1 : Math.floor(random() * limit) + 1;
        for (let n = 0; n < size; n++) all.push(finding(`item-${item}`, `CVE-2026-${n}`));
      }
      const grouped = groups(merge(all), limit);
      const parts = grouped.flat();
      // Every result once, the items in the list's order.
      expect(parts.flatMap((part) => part.findings)).toHaveLength(all.length);
      expect([...new Set(parts.map((part) => part.findings[0]?.item))]).toEqual(order);
      for (const group of grouped) {
        expect(group.flatMap((part) => part.findings).length).toBeLessThanOrEqual(limit);
        for (const part of group) expect(new Set(part.findings.map((f) => f.item)).size).toBe(1);
        // A run holds one cut at most, first, and a cut but an item's last is alone and full.
        const cuts = group.filter((part) => part.cut);
        expect(cuts.length).toBeLessThanOrEqual(1);
        if (cuts.length) expect(group[0]?.cut).toBeDefined();
        const cut = group[0]?.cut;
        if (cut && cut.at < cut.of) expect([group.length, group[0]?.findings.length]).toEqual([1, limit]);
      }
      for (const part of parts)
        expect(Boolean(part.cut)).toBe(all.filter((f) => f.item === part.findings[0]?.item).length > limit);
      // A run of whole items is filled no further than it could be: the next whole item would not have fitted.
      for (let at = 1; at < grouped.length; at++) {
        const before = grouped[at - 1] ?? [];
        const next = grouped[at]?.[0];
        if (next?.cut) continue;
        expect(before.flatMap((part) => part.findings).length + (next?.findings.length ?? 0)).toBeGreaterThan(limit);
      }
      const over = overLimits(
        sarif(all, undefined, { ...LIMITS, results: limit, runs: Math.max(20, grouped.length) }),
        {
          ...LIMITS,
          results: limit,
          runs: 20,
        },
      );
      expect(over.some((problem) => problem.includes('results, over'))).toBe(false);
      expect(over.some((problem) => problem.includes('runs, over'))).toBe(grouped.length > 20);
    }
  });

  it('move an item to another run as the items before it change, its fingerprints the same, the run it left still in the file', () => {
    const day = (b: number) => [
      ...Array.from({ length: 3_000 }, (_, n) => finding('a', `CVE-2026-${n}`)),
      ...Array.from({ length: b }, (_, n) => finding('b', `CVE-2026-${n}`)),
      ...Array.from({ length: 1_500 }, (_, n) => finding('c', `CVE-2026-${n}`)),
    ];
    const of = (all: Finding[], item: string) => {
      const run = sarif(all).runs.find((r) => r.properties.items.includes(item));
      return {
        category: run?.automationDetails.id,
        prints: run?.results
          .filter((result) => result.message.text.includes(` in ${item}:`))
          .map((result) => result.partialFingerprints['vulnerabilities/v1'])
          .sort(),
      };
    };
    const before = of(day(1_000), 'c');
    const after = of(day(500), 'c');
    expect([before.category, after.category]).toEqual([`${CATEGORY}/02/`, `${CATEGORY}/01/`]);
    expect(after.prints).toHaveLength(1_500);
    expect(after.prints).toEqual(before.prints);
    // The category c left is uploaded still, with b alone: nothing of c stays open there.
    expect(sarif(day(500)).runs.map((run) => run.automationDetails.id)).toContain(`${CATEGORY}/02/`);
  });
});

describe('an SBOM with no Node', () => {
  const target = (image: string) => ({
    item: { kind: 'ours' as const, name: image, file: 'k.yaml', line: 4, image, signer: SIGNER },
    key: itemKey({ kind: 'ours', name: image, file: 'k.yaml', line: 4, image }),
    label: image,
    image,
    signer: SIGNER,
  });

  it("takes Node's version from Syft's SBOM, and does not pull the image", async () => {
    const { tools: t, asked } = tools(everything());
    const read = await readOurs(t, target(OURS));
    expect(read).toMatchObject({ source: 'sbom', node: '24.22.2' });
    expect(asked.map((args) => args[0])).toEqual(['sbom', 'sbom']);
  });

  it('falls back to the image itself, and its NODE_VERSION, when no SBOM gives Node', async () => {
    const { tools: t, asked } = tools({ ...everything(), node: {} });
    const read = await readOurs(t, target(OURS));
    expect(read).toMatchObject({ source: 'image', node: '24.22.0' });
    expect(asked.map((args) => args[0])).toEqual(['sbom', 'sbom', 'image']);
    expect(asked[2]).toContain('linux/amd64');
  });

  it('is an item it cannot read when the image cannot be pulled, or gives no Node either', async () => {
    const pulled = tools({ sboms: { [OURS]: [fixture('sbom-amd64')] } });
    expect((await readOurs(pulled.tools, target(OURS))).unreadable).toMatch(
      /^its SBOM gives no Node, and the image could not be pulled/,
    );
    const none = tools({ sboms: { [OURS]: [fixture('sbom-amd64')] }, images: { [OURS]: fixture('image-postgres') } });
    expect((await readOurs(none.tools, target(OURS))).unreadable).toBe(
      'its Node version is in neither its SBOM nor its image',
    );
  });

  it('fails the run when the proof does not show its advisory', async () => {
    // The proof's SBOM names a Node with the fix: the scan cannot be seeing what it should.
    const outcome = await scan(
      tools({ ...everything(), node: { [PROOF.image]: '24.22.1' } }).tools,
      checkout(),
      items(),
      [],
      DB,
      TRACKED,
    );
    expect(outcome.proof).toMatchObject({ found: false, source: 'sbom', node: '24.22.1' });
    const { lines, passes } = report(outcome, true);
    expect(passes).toBe(false);
    expect(lines).toContain(
      `The proof image does not show ${PROOF.advisory} in its Node 24.22.1: the scan has stopped seeing Node.`,
    );
  });
});

describe("Node's own advisories", () => {
  it('reads the ranges the database writes', () => {
    expect(satisfies('24.22.0', '22.x || 24.x || 26.x')).toBe(true);
    expect(satisfies('25.0.0', '22.x || 24.x || 26.x')).toBe(false);
    expect(satisfies('24.22.0', '^22.23.4 || ^24.22.1 || ^26.12.1')).toBe(false);
    expect(satisfies('24.22.1', '^22.23.4 || ^24.22.1 || ^26.12.1')).toBe(true);
    expect(satisfies('24.30.0', '^24.22.1')).toBe(true);
    expect(satisfies('6.1.9', '>=6.0.0 <6.2.0')).toBe(true);
    expect(satisfies('6.2.0', '>= 6.0.0 < 6.2.0')).toBe(false);
    expect(satisfies('4.4.2', '^5.10.0 || 4.4.2')).toBe(true);
    expect(satisfies('10.9.0', '<=10')).toBe(true);
    expect(satisfies('11.0.0', '<=10')).toBe(false);
    expect(satisfies('8.2.3', '8.2.x')).toBe(true);
    expect(() => satisfies('8.2.3', '8.2.3-beta')).toThrow(/a range not read/);
    // A caret keeps the major, partial or not.
    expect(satisfies('24.23.0', '^24.22')).toBe(true);
    expect(satisfies('25.0.0', '^24.22')).toBe(false);
    expect(satisfies('24.21.9', '^24.22.x')).toBe(false);
    expect(satisfies('0.0.3', '^0.0.3')).toBe(true);
    expect(satisfies('0.0.4', '^0.0.3')).toBe(false);
    expect(satisfies('0.2.9', '^0.2.3')).toBe(true);
    expect(satisfies('0.3.0', '^0.2.3')).toBe(false);
    // The whole database is read when it is fetched, so a range it cannot read refuses it then.
    expect(() => readable(DB)).not.toThrow();
    expect(() => readable([['9', { vulnerable: '24.x', patched: '>=24.22.1-rc.1' }]])).toThrow(
      /^entry 9: a range not read/,
    );
  });

  it("gives each CVE of an entry the version is in and not patched in, at the publisher's severity", () => {
    expect(advisoriesFor('24.22.0', DB).map((a) => [a.advisory, a.severity])).toEqual([['CVE-2026-111497', 'HIGH']]);
    expect(advisoriesFor('24.22.1', DB)).toEqual([]);
    // An entry with no CVE is named by its own id; one past its last release line is still a finding.
    expect(advisoriesFor('5.9.0', DB).map((a) => a.advisory)).toEqual([
      'CVE-2017-1000381',
      'CVE-2016-1669',
      'NSWG-CORE-26',
    ]);
  });

  it("finds Node's version in Syft's SBOM and in an image's configuration", () => {
    expect(
      nodeInSbom({ packages: [{ name: 'node', externalRefs: [{ referenceLocator: 'pkg:generic/node@24.22.0' }] }] }),
    ).toBe('24.22.0');
    expect(
      nodeInSbom({ packages: [{ name: 'undici', externalRefs: [{ referenceLocator: 'pkg:npm/undici@7.16.0' }] }] }),
    ).toBeUndefined();
    expect(nodeInConfig(fixture('image-node').Metadata?.ImageConfig)).toBe('24.22.0');
    expect(nodeInConfig(fixture('image-postgres').Metadata?.ImageConfig)).toBeUndefined();
    // NodeSource's package, as Playwright's image installs Node; an npm package of that name is not Node.
    expect(
      nodeInPackages([
        { Class: 'lang-pkgs', Packages: [{ Name: 'nodejs', Version: '1.0.0' }] },
        { Class: 'os-pkgs', Packages: [{ Name: 'nodejs', Version: '24.22.0-1nodesource1' }] },
      ]),
    ).toBe('24.22.0');
  });

  it("is a result per image and CVE, at the image's pin, and an image of another's with NODE_VERSION has them too", async () => {
    const node = `node:24.22.0-alpine3.24@${digest('5')}`;
    const fake = everything();
    if (fake.images) fake.images[node] = fixture('image-node');
    const all = [...items(), { kind: 'dockerfile' as const, name: node, file: 'Dockerfile', line: 3, image: node }];
    const outcome = await scan(tools(fake).tools, checkout(), all, [], DB, TRACKED);
    const results = sarif(outcome.findings).runs[0]?.results.filter((r) => r.ruleId === PROOF.advisory) ?? [];
    expect(results).toHaveLength(1);
    expect(results[0]?.locations[0]?.physicalLocation).toEqual({
      artifactLocation: { uri: 'Dockerfile' },
      region: { startLine: 3 },
    });
    expect(results[0]?.message.text).toBe(
      `node 24.22.0 in ${node}: ${PROOF.advisory} (high), fixed in ^22.23.4 || ^24.22.1 || ^26.12.1.`,
    );
    const finding = nodeFindingsOf(
      {
        target: { item: all[3] as Item, key: itemKey(all[3] as Item), label: node, image: node },
        reports: [],
        node: '24.22.0',
      },
      DB,
    )[0];
    expect(finding && fingerprint(finding)).toBe(results[0]?.partialFingerprints['vulnerabilities/v1']);
  });
});

describe("two platforms' findings", () => {
  it('are one result, and an image’s copy of a package is never folded into a lockfile’s', async () => {
    const outcome = await scan(tools(everything()).tools, checkout(), items(), [], DB, TRACKED);
    const openssl = outcome.findings.filter((finding) => finding.advisory === 'CVE-2026-0101');
    expect(openssl).toHaveLength(2);
    const results = sarif(outcome.findings).runs[0]?.results ?? [];
    const one = results.filter((result) => result.ruleId === 'CVE-2026-0101');
    expect(one).toHaveLength(1);
    expect(one[0]?.locations[0]?.physicalLocation).toEqual({
      artifactLocation: { uri: 'deploy/ours/kustomization.yaml' },
      region: { startLine: 23 },
    });
    expect(one[0]?.message.text).toBe(`libssl3t64 3.5.1-1 in ${OURS}: CVE-2026-0101 (high), fixed in 3.5.1-2.`);
    // The lockfile's finding is at its package's entry.
    const lockfile = results.find((result) => result.ruleId === 'GHSA-g3hv-75wg-m249');
    expect(lockfile?.locations[0]?.physicalLocation.region.startLine).toBe(5);
    expect(lockfile?.level).toBe('warning');
  });
});

describe('a moved pin', () => {
  it('keeps its fingerprint while the finding stays, and closes it once past the fix', async () => {
    const before = await scan(tools(everything()).tools, checkout(), items(), [], DB, TRACKED);
    // Postgres moves to a new digest, on another line: the same finding is the same alert.
    const moved = `postgres:18.7-alpine3.24@${digest('3')}`;
    const fake = everything();
    if (fake.images) fake.images[moved] = fixture('image-postgres');
    const after = await scan(
      tools(fake).tools,
      checkout(),
      items().map((item) => (item.image === POSTGRES ? { ...item, name: moved, image: moved, line: 30 } : item)),
      [],
      DB,
      TRACKED,
    );
    const print = (outcome: typeof before) =>
      sarif(outcome.findings).runs[0]?.results.find((result) => result.ruleId === 'CVE-2026-0202');
    expect(print(after)?.partialFingerprints).toEqual(print(before)?.partialFingerprints);
    // Code scanning's own line hash is set from the same identity, or upload-sarif would hash the moved line itself.
    expect(print(after)?.partialFingerprints.primaryLocationLineHash).toBe(
      `${print(after)?.partialFingerprints['vulnerabilities/v1']}:1`,
    );
    expect(print(after)?.locations[0]?.physicalLocation.region.startLine).toBe(30);
    // Past the fix, Trivy finds nothing, and the result is gone, so its alert closes.
    const fixed = everything();
    if (fixed.images)
      fixed.images[POSTGRES] = { ...fixture('image-postgres'), Results: [{ Packages: [{ Name: 'libxml2' }] }] };
    expect(print(await scan(tools(fixed).tools, checkout(), items(), [], DB, TRACKED))).toBeUndefined();
  });

  it('is the item, the package and the advisory, never the version, the line or the digest', () => {
    const base = {
      item: 'deploy/base/postgres/statefulset.yaml postgres',
      type: 'alpine',
      package: 'libxml2',
      advisory: 'CVE-1',
    };
    expect(fingerprint(base)).toBe(fingerprint({ ...base }));
    expect(fingerprint(base)).not.toBe(fingerprint({ ...base, item: 'Dockerfile postgres' }));
    expect(fingerprint(base)).not.toBe(fingerprint({ ...base, package: 'libxml2-utils' }));
    const item: Item = { kind: 'third-party', name: POSTGRES, file: 'a.yaml', line: 2, image: POSTGRES };
    expect(itemKey(item)).toBe(itemKey({ ...item, line: 9, image: `postgres:19@${digest('4')}` }));
    expect(itemKey({ ...item, kind: 'chart', name: 'grafana' }, 'docker.io/grafana/grafana:12.1.0')).toBe(
      'chart grafana docker.io/grafana/grafana',
    );
  });
});

describe('the advisory database', () => {
  const now = Date.parse('2026-11-08T12:00:00Z');
  it('is refused once it was built more than a day ago, or when its age cannot be told', () => {
    expect(databaseAge('{"UpdatedAt":"2026-11-08T06:00:00Z"}', now)).toBe(6 * 3_600_000);
    expect(databaseAge('{"UpdatedAt":"2026-11-07T06:00:00Z"}', now)).toBeGreaterThan(DB_MAX_AGE_MS);
    expect(databaseAge('{}', now)).toBe('its metadata gives no build time');
    expect(databaseAge('not json', now)).toBe('its metadata does not parse');
  });
});

describe('reading', () => {
  it("finds a chart's images and a package's line in the lockfile", () => {
    expect(
      imagesIn(
        [
          '      containers:',
          '        - image: "docker.io/grafana/grafana:12.1.0"',
          '          image: quay.io/x/y@sha256:ab',
          '  image: {{ .x }}',
        ].join('\n'),
      ),
    ).toEqual(['docker.io/grafana/grafana:12.1.0', 'quay.io/x/y@sha256:ab']);
    const lines = readFileSync(join(checkout(), 'pnpm-lock.yaml'), 'utf-8').split('\n');
    expect(lockfileLine(lines, 'yaml', '2.9.1')).toBe(8);
    expect(lockfileLine(lines, 'absent', '1.0.0')).toBe(1);
  });
});

describe('coverage', () => {
  it("runs pnpm with no pnpmfile of the checkout's, on install and on list", () => {
    expect(INSTALL).toContain('--ignore-pnpmfile');
    expect(INSTALL).toContain('--ignore-scripts');
    expect(LIST).toContain('--ignore-pnpmfile');
  });

  it('reads the pnpm the checkout pins, from its mise.lock, or an exact version in its mise.toml', () => {
    expect(
      pnpmVersion('[[tools.node]]\nversion = "24.22.2"\n\n[[tools.pnpm]]\nversion = "12.16.1"\n', 'pnpm = "12"'),
    ).toBe('12.16.1');
    expect(pnpmVersion(undefined, 'pnpm = "12.1.0"')).toBe('12.1.0');
    expect(pnpmVersion(undefined, 'pnpm = "12"')).toBeUndefined();
  });

  it("fails on a package pnpm lists that Trivy's SBOM does not name, and not on one Trivy names beyond them", () => {
    const fromPnpm = listed([
      {
        name: 'software-factory',
        devDependencies: {
          vitest: { from: 'vitest', version: '5.1.0', dependencies: { tinypool: { version: '2.0.0' } } },
          // pnpm lists a tree in full at its first place alone, here under a workspace link, and `deduped` after.
          '@software-factory/testing': {
            version: 'link:packages/testing',
            dependencies: { 'json-logic-engine': { version: '5.0.7' } },
          },
          'json-logic-engine': { version: '5.0.7', deduped: true } as never,
          'string-width-cjs': { from: 'string-width', version: '4.2.3' },
        },
      },
    ]);
    expect([...fromPnpm].sort()).toEqual([
      'json-logic-engine@5.0.7',
      'string-width@4.2.3',
      'tinypool@2.0.0',
      'vitest@5.1.0',
    ]);
    const fromTrivy = inSbom({
      components: [
        { purl: 'pkg:npm/vitest@5.1.0' },
        { purl: 'pkg:npm/string-width@4.2.3' },
        { purl: 'pkg:npm/json-logic-engine@5.0.7' },
        { purl: 'pkg:npm/%40esbuild/linux-arm64@0.25.0' },
      ],
    });
    expect(fromTrivy.has('@esbuild/linux-arm64@0.25.0')).toBe(true);
    expect(missing(fromPnpm, fromTrivy)).toEqual(['tinypool@2.0.0']);
  });
});

describe('the paths an SBOM gives', () => {
  it('gives each vulnerable package the one place Syft found it, which Trivy drops reading an SBOM', () => {
    const predicate = {
      packages: [
        {
          name: 'example-bundled',
          versionInfo: '6.28.0',
          sourceInfo:
            'acquired package info from installed node module manifest file: /opt/pnpm/dist/node_modules/example-bundled/index.js',
        },
        {
          name: 'example-twice',
          versionInfo: '1.0.0',
          sourceInfo: 'acquired package info from installed node module manifest file: /a/index.js',
        },
        {
          name: 'example-twice',
          versionInfo: '1.0.0',
          sourceInfo: 'acquired package info from installed node module manifest file: /b/index.js',
        },
      ],
    };
    const report = withPaths(
      {
        Results: [
          {
            Type: 'node-pkg',
            Vulnerabilities: [
              { PkgName: 'example-bundled', InstalledVersion: '6.28.0', VulnerabilityID: 'CVE-2099-1' },
              { PkgName: 'example-twice', InstalledVersion: '1.0.0', VulnerabilityID: 'CVE-2099-2' },
            ],
          },
        ],
      },
      sbomPaths(predicate),
    );
    const [bundled, twice] = report.Results?.[0]?.Vulnerabilities ?? [];
    expect(bundled?.PkgPath).toBe('opt/pnpm/dist/node_modules/example-bundled/index.js');
    // Found in two places: neither is its alone.
    expect(twice?.PkgPath).toBeUndefined();
  });
});
