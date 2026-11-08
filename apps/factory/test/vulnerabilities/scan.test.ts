import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { inSbom, listed, missing, pnpmVersion } from '../../src/vulnerabilities/coverage.ts';
import type { Item } from '../../src/vulnerabilities/inventory.ts';
import { PROOF } from '../../src/vulnerabilities/proof.ts';
import { fingerprint, LIMITS, sarif } from '../../src/vulnerabilities/sarif.ts';
import {
  DB_MAX_AGE_MS,
  databaseAge,
  hasNode,
  imagesIn,
  itemKey,
  lockfileLine,
  readOurs,
  report,
  scan,
  type Tools,
  type TrivyReport,
} from '../../src/vulnerabilities/scan.ts';

/**
 * The daily scan's decisions, on Trivy's own JSON (fixtures/trivy, in the shape Trivy's `--format json
 * --list-all-pkgs` writes): what it reads, what it cannot, and what it would upload.
 */
const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/trivy/${name}.json`, import.meta.url), 'utf-8')) as TrivyReport;
const digest = (c: string) => `sha256:${c.repeat(64)}`;

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
    file: 'deploy/overlays/local/factory-image/kustomization.yaml',
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
      return sboms.map((_, index) => ({ image, index }));
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

/** Everything readable: the lockfile, ours from its two SBOMs and its image, Postgres, and the proof from its image. */
const everything = (): Fake => ({
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
    const outcome = await scan(tools(fake).tools, checkout(), items(), []);
    expect(outcome.unreadable).toEqual([{ name: POSTGRES, why: `could not be pulled: MANIFEST_UNKNOWN: ${POSTGRES}` }]);
    const { lines, passes } = report(outcome, true);
    expect(passes).toBe(false);
    expect(lines.at(-1)).toBe('The run fails, and nothing is uploaded.');
    // The log names the item, never a package or an advisory.
    expect(lines.join('\n')).not.toMatch(/libxml2|CVE-2026-0202|minimatch|GHSA/);
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
    const outcome = await scan(tools(fake).tools, checkout(), items(), [pin]);
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
    const outcome = await scan(tools(everything()).tools, checkout(), items(), []);
    expect(outcome.unreadable).toEqual([]);
    expect(outcome.proof).toEqual({ found: true, source: 'image', unreadable: undefined });
    const { lines, passes } = report(outcome, true);
    expect(passes).toBe(true);
    expect(lines[0]).toBe('Read 3 targets. Findings by severity: critical 1, high 2, medium 1, low 0, unknown 0.');
    // The proof's own finding is not the repository's: nothing of it is in the file.
    const results = sarif(outcome.findings).runs[0]?.results ?? [];
    expect(results.map((result) => result.ruleId).sort()).toEqual([
      'CVE-2026-0101',
      'CVE-2026-0202',
      'CVE-2026-111497',
      'GHSA-g3hv-75wg-m249',
    ]);
    expect(JSON.stringify(results)).not.toContain(PROOF.image);
  });
});

describe('results over the limit', () => {
  it('fail the run, and nothing is uploaded', async () => {
    const outcome = await scan(tools(everything()).tools, checkout(), items(), []);
    const { lines, passes } = report(outcome, true, { ...LIMITS, results: 3 });
    expect(passes).toBe(false);
    expect(lines).toContain("The results are over code scanning's limits: 4 results, over 3.");
    expect(lines.at(-1)).toBe('The run fails, and nothing is uploaded.');
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

  it('falls back to the image itself, whose Node Trivy reads', async () => {
    const { tools: t, asked } = tools(everything());
    expect(hasNode([fixture('sbom-amd64')])).toBe(false);
    const read = await readOurs(t, target(OURS));
    expect(read.source).toBe('image');
    expect(asked.map((args) => args[0])).toEqual(['sbom', 'sbom', 'image']);
    expect(asked[2]).toContain('linux/amd64');
    expect(hasNode(read.reports)).toBe(true);
  });

  it('does not when the SBOM gives Node', async () => {
    const withNode = fixture('sbom-amd64');
    withNode.Results?.push(fixture('image-node').Results?.[0] ?? {});
    const { tools: t, asked } = tools({ sboms: { [OURS]: [withNode] } });
    const read = await readOurs(t, target(OURS));
    expect(read.source).toBe('sbom');
    expect(asked.map((args) => args[0])).toEqual(['sbom']);
  });

  it('is an item it cannot read when the image cannot be pulled either', async () => {
    const { tools: t } = tools({ sboms: { [OURS]: [fixture('sbom-amd64')] } });
    const read = await readOurs(t, target(OURS));
    expect(read.unreadable).toMatch(/^its SBOM gives no Node, and the image could not be pulled/);
  });

  it('fails the run when the proof does not show its advisory', async () => {
    const fake = everything();
    if (fake.images) fake.images[PROOF.image] = fixture('image-postgres');
    const outcome = await scan(tools(fake).tools, checkout(), items(), []);
    expect(outcome.proof.found).toBe(false);
    const { lines, passes } = report(outcome, true);
    expect(passes).toBe(false);
    expect(lines).toContain(
      `The proof image does not show ${PROOF.advisory} in its Node: the scanner has stopped seeing Node.`,
    );
  });
});

describe("two platforms' findings", () => {
  it('are one result, and an image’s copy of a package is never folded into a lockfile’s', async () => {
    const outcome = await scan(tools(everything()).tools, checkout(), items(), []);
    const openssl = outcome.findings.filter((finding) => finding.advisory === 'CVE-2026-0101');
    expect(openssl).toHaveLength(2);
    const results = sarif(outcome.findings).runs[0]?.results ?? [];
    const one = results.filter((result) => result.ruleId === 'CVE-2026-0101');
    expect(one).toHaveLength(1);
    expect(one[0]?.locations[0]?.physicalLocation).toEqual({
      artifactLocation: { uri: 'deploy/overlays/local/factory-image/kustomization.yaml' },
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
    const before = await scan(tools(everything()).tools, checkout(), items(), []);
    // Postgres moves to a new digest, on another line: the same finding is the same alert.
    const moved = `postgres:18.7-alpine3.24@${digest('3')}`;
    const fake = everything();
    if (fake.images) fake.images[moved] = fixture('image-postgres');
    const after = await scan(
      tools(fake).tools,
      checkout(),
      items().map((item) => (item.image === POSTGRES ? { ...item, name: moved, image: moved, line: 30 } : item)),
      [],
    );
    const print = (outcome: typeof before) =>
      sarif(outcome.findings).runs[0]?.results.find((result) => result.ruleId === 'CVE-2026-0202');
    expect(print(after)?.partialFingerprints).toEqual(print(before)?.partialFingerprints);
    expect(print(after)?.locations[0]?.physicalLocation.region.startLine).toBe(30);
    // Past the fix, Trivy finds nothing, and the result is gone, so its alert closes.
    const fixed = everything();
    if (fixed.images)
      fixed.images[POSTGRES] = { ...fixture('image-postgres'), Results: [{ Packages: [{ Name: 'libxml2' }] }] };
    expect(print(await scan(tools(fixed).tools, checkout(), items(), []))).toBeUndefined();
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
