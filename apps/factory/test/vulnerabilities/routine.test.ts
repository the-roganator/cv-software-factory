import { describe, expect, it } from 'vitest';
import type { Routine } from '../../../../policy/vulnerabilities.ts';
import * as policy from '../../../../policy/vulnerabilities.ts';
import { REPOSITORIES } from '../../src/github/config.ts';
import {
  assess,
  type PackageVersions,
  packageVersions,
  type Sources,
  stateOf,
  verdict,
} from '../../src/vulnerabilities/deadlines.ts';
import { APP, isRoutine, moves, movesFile, pinsOf, table } from '../../src/vulnerabilities/moves.ts';
import { directs, leftAlone, recorded, routine, summary } from '../../src/vulnerabilities/routine.ts';
import type { Finding } from '../../src/vulnerabilities/sarif.ts';
import type { Handoff, ReadTarget } from '../../src/vulnerabilities/scan.ts';
import { newKey, open, readKey, type StateRoutine, seal } from '../../src/vulnerabilities/state.ts';

/**
 * The pins that are merely behind (routine.ts), on an invented list and the registries' recorded answers, read through
 * the scan's own judgement (`assess`), so each pin is named as a finding on it would be.
 */
const DAY = 86_400_000;
const NOW = Date.parse('2026-11-10T04:30:00Z');
const REPOSITORY = 'the-roganator/cv-software-factory';
const ago = (days: number, now = NOW) => new Date(now - days * DAY).toISOString();
const digest = (letter: string) => `sha256:${letter.repeat(64)}`;
const POLICY: Routine = { days: 3, majorDays: 7, leave: [] };

interface World {
  targets: ReadTarget[];
  findings?: Finding[];
  files?: Record<string, string>;
  tags?: Record<string, string[]>;
  /** Each tag's index digest, by `<repository>:<tag>`; and when the image at `<repository>@<digest>` was made. */
  digests?: Record<string, string>;
  created?: Record<string, string | undefined>;
  /** Each package's releases, by its name. */
  packages?: Record<string, PackageVersions>;
  charts?: Record<string, { version: string; created: string }[]>;
  renders?: Record<string, string>;
  k3s?: Record<string, { published: string; images: string[] }>;
  /** The Node release the image at `<repository>@<digest>` runs, and Node's releases. */
  runs?: Record<string, string>;
  releases?: { version: string; date: string }[];
  /** Lookups that fail, by what is asked (`tags example/image`). */
  down?: string[];
  policy?: Routine | undefined;
  last?: StateRoutine[];
  repository?: string;
  minimumReleaseAge?: number;
}

function sourcesOf(world: World) {
  const asked: string[] = [];
  const ask = (what: string) => {
    asked.push(what);
    if (world.down?.includes(what)) throw new Error(`${what}: 503 for example-secret`);
  };
  const sources: Sources = {
    published: async () => undefined,
    async versions(name) {
      ask(`versions ${name}`);
      return world.packages?.[name];
    },
    releases: async () => world.releases ?? [],
    async tags(repository) {
      ask(`tags ${repository}`);
      return world.tags?.[repository] ?? [];
    },
    async image(reference) {
      throw new Error(`${reference} was scanned for a routine move`);
    },
    async served(reference) {
      ask(`served ${reference}`);
      return world.digests?.[reference] ?? digest('d');
    },
    async digest(reference) {
      ask(`digest ${reference}`);
      return world.digests?.[reference] ?? digest('d');
    },
    manifests: async () => ({ digest: digest('f'), platforms: [] }),
    async created(reference) {
      ask(`created ${reference}`);
      return world.created?.[reference];
    },
    async chartVersions(_repo, chart) {
      ask(`chart ${chart}`);
      return world.charts?.[chart] ?? [];
    },
    async render(chart) {
      ask(`render ${chart.chart}@${chart.version}`);
      const text = world.renders?.[`${chart.chart}@${chart.version}`];
      if (text === undefined) throw new Error(`${chart.chart} ${chart.version}: does not render`);
      return text;
    },
    toolReleases: async () => [],
    tool: async () => undefined,
    async k3s(release) {
      ask(`k3s ${release}`);
      return world.k3s?.[release];
    },
    async node(image, at) {
      ask(`node ${image}@${at}`);
      return world.runs?.[`${image}@${at}`];
    },
    file: (path) => world.files?.[path],
    alerts: async () => [],
  };
  return { sources, asked };
}

/** One run of the scan over the world: what it judged, the pins it found behind, and the day's moves. */
async function listed(world: World, now = NOW) {
  const repository = world.repository ?? REPOSITORY;
  const handoff: Handoff = {
    repository,
    started: new Date(now - 600_000).toISOString(),
    cache: '/nowhere',
    minimumReleaseAge: world.minimumReleaseAge,
    findings: world.findings ?? [],
    excepted: [],
    targets: world.targets,
  };
  const { sources, asked } = sourcesOf(world);
  const lines: string[] = [];
  const judged = await assess(handoff, sources, now, (line) => lines.push(line));
  const context = { repository, app: repository === APP, now };
  const before = asked.length;
  const listing = await routine({
    repository,
    targets: world.targets,
    sources,
    lookups: judged.lookups,
    policy: 'policy' in world ? world.policy : POLICY,
    last: world.last,
    taken: pinsOf(moves(judged.judged, context)),
    minimumReleaseAge: world.minimumReleaseAge ?? 24 * 60,
    now,
    log: (line) => lines.push(line),
  });
  const list = moves(judged.judged, context, listing.behind);
  return {
    judged,
    listing,
    list,
    routine: list.filter(isRoutine),
    records: recorded(listing.records, list),
    asked: asked.slice(before),
    lines,
    context,
  };
}

/** A third-party image under deploy/, pinned by tag and digest. */
const image = (reference: string, over: Partial<ReadTarget> = {}): ReadTarget => ({
  key: `deploy/x.yaml ${reference.split(/[:@]/)[0]}`,
  kind: 'third-party',
  file: 'deploy/x.yaml',
  label: reference,
  image: reference,
  name: reference,
  line: 12,
  ...over,
});
const PINNED = image(`example/image:2.17.0@${digest('a')}`);
/** A registry with a newer tag on the line, made the days ago given. */
const newer = (days: number): Partial<World> => ({
  tags: { 'example/image': ['2.16.9', '2.17.0', '2.18.1', '3.0.0', '2.19.0-rc1'] },
  digests: { 'example/image:2.18.1': digest('b') },
  created: { [`example/image@${digest('b')}`]: ago(days) },
});

describe('an image’s pin that is behind', () => {
  it('moves to the newest tag on its line, with the digest the registry serves, and scans nothing', async () => {
    const { routine: found, asked } = await listed({ targets: [PINNED], ...newer(5) });
    expect(found).toEqual([
      expect.objectContaining({
        name: 'example/image',
        pins: [{ file: 'deploy/x.yaml', line: 12 }],
        from: '2.17.0',
        to: { kind: 'image', tag: '2.18.1', digest: digest('b') },
        major: false,
        lane: 'worker',
        lockfile: false,
        results: [],
      }),
    ]);
    expect(asked).toEqual([
      'tags example/image',
      'served example/image:2.18.1',
      `created example/image@${digest('b')}`,
    ]);
  });

  it('is not behind at the line’s newest tag and the digest it has now, or with nothing newer listed', async () => {
    const current = {
      tags: { 'example/image': ['2.16.0', '2.17.0'] },
      digests: { 'example/image:2.17.0': digest('a') },
    };
    expect((await listed({ targets: [PINNED], ...current })).listing.counts).toMatchObject({ current: 1, listed: 0 });
    // A registry that no longer lists the pin's tag moves nothing back.
    const gone = { tags: { 'example/image': ['2.16.0'] } };
    expect((await listed({ targets: [PINNED], ...gone })).routine).toEqual([]);
    // A tag alone, with no digest to compare, is behind only for a newer tag.
    const bare = image('example/image:2.17.0');
    expect((await listed({ targets: [bare], ...current, digests: {} })).routine).toEqual([]);
  });

  it('is behind at the same tag once the registry serves another digest: a version’s, and a tag that is none', async () => {
    const rebuilt = {
      tags: { 'example/image': ['2.17.0'] },
      digests: { 'example/image:2.17.0': digest('c'), 'example/base:stable': digest('c') },
    };
    const first = await listed({ targets: [PINNED], ...rebuilt });
    expect(first.routine).toEqual([]);
    expect(first.records).toEqual([
      expect.objectContaining({ to: `image 2.17.0@${digest('c')}`, seen: '2026-11-10T04:30:00Z' }),
    ]);
    const later = await listed({ targets: [PINNED], ...rebuilt, last: first.records }, NOW + 3 * DAY);
    expect(later.routine[0]?.to).toEqual({ kind: 'image', tag: '2.17.0', digest: digest('c') });
    // The digest alone is asked, with the request no registry counts as a pull: no manifest, and no configuration.
    expect(later.asked).toEqual(['tags example/image', 'served example/image:2.17.0']);
    const named = image(`example/base:stable@${digest('a')}`);
    const seen = await listed({ targets: [named], ...rebuilt });
    const { routine: found, asked } = await listed({ targets: [named], ...rebuilt, last: seen.records }, NOW + 3 * DAY);
    expect(found[0]).toMatchObject({ from: 'stable', to: { kind: 'image', tag: 'stable', digest: digest('c') } });
    // A tag that is not a version has no line to list.
    expect(asked).toEqual(['served example/base:stable']);
  });

  it('lists a tag rebuilt every day on the third day, at the digest it serves that day', async () => {
    const rolling = image(`gcr.io/distroless/static:nonroot@${digest('a')}`);
    const serving = (letter: string, last?: StateRoutine[]): World => ({
      targets: [rolling],
      digests: { 'gcr.io/distroless/static:nonroot': digest(letter) },
      ...(last ? { last } : {}),
    });
    const day0 = await listed(serving('b'));
    const day1 = await listed(serving('c', day0.records), NOW + DAY);
    const day2 = await listed(serving('d', day1.records), NOW + 2 * DAY);
    expect([day0, day1, day2].map((day) => day.routine.length)).toEqual([0, 0, 0]);
    // One record a day, of that day's digest, with the day the pin was first seen behind its tag.
    expect(day2.records).toEqual([
      {
        name: 'gcr.io/distroless/static',
        from: 'nonroot',
        to: `image nonroot@${digest('d')}`,
        pins: [{ file: 'deploy/x.yaml', line: 12 }],
        seen: '2026-11-10T04:30:00Z',
      },
    ]);
    const day3 = await listed(serving('e', day2.records), NOW + 3 * DAY);
    expect(day3.routine[0]).toMatchObject({ to: { kind: 'image', tag: 'nonroot', digest: digest('e') } });
    expect(day3.records).toEqual([{ move: 1, ...day2.records[0], to: `image nonroot@${digest('e')}` }]);
    // Still listed the next day, at that day's digest, while the pin has not moved.
    const day4 = await listed(serving('f', day3.records), NOW + 4 * DAY);
    expect(day4.routine[0]?.to).toMatchObject({ digest: digest('f') });
  });

  it('starts a rebuilt tag’s wait again only once the pin has moved', async () => {
    const at = (pin: string, serves: string, last: StateRoutine[] = []): World => ({
      targets: [image(`gcr.io/distroless/static:nonroot@${digest(pin)}`)],
      digests: { 'gcr.io/distroless/static:nonroot': digest(serves) },
      last,
    });
    const old: StateRoutine[] = [
      {
        move: 1,
        name: 'gcr.io/distroless/static',
        from: 'nonroot',
        to: `image nonroot@${digest('e')}`,
        pins: [{ file: 'deploy/x.yaml', line: 12 }],
        seen: ago(3),
      },
    ];
    // The pin moved to what was listed, and the tag serves that: nothing behind, and no record kept.
    const moved = await listed(at('e', 'e', old));
    expect(moved.listing.counts.current).toBe(1);
    expect(moved.records).toEqual([]);
    // Built again the day it moved: the record of the move made gives the new digest no day, and the wait is whole.
    const again = await listed(at('e', 'f', old));
    expect(again.routine).toEqual([]);
    expect(again.records[0]).toMatchObject({ to: `image nonroot@${digest('f')}`, seen: '2026-11-10T04:30:00Z' });
    expect((await listed(at('e', '1', again.records), NOW + 3 * DAY)).routine).toHaveLength(1);
    // A newer tag is a release of its own, and takes no day from the tag it replaces.
    const tagged = await listed({
      targets: [PINNED],
      ...newer(1),
      last: [{ ...old[0], name: 'example/image', from: '2.17.0', to: `image 2.17.0@${digest('c')}` } as StateRoutine],
    });
    expect(tagged.routine).toEqual([]);
  });

  it('never crosses a major: a line keeps its first number, so Node’s and Postgres’s majors are no routine move', async () => {
    const node = image(`node:24.22.3-alpine3.24@${digest('a')}`, { kind: 'dockerfile', file: 'Dockerfile', line: 1 });
    const postgres = image(`postgres:18.7-alpine3.24@${digest('a')}`, { key: 'deploy/x.yaml postgres', line: 30 });
    const { routine: found, listing } = await listed({
      targets: [node, postgres],
      tags: {
        node: ['24.22.3-alpine3.24', '25.1.0-alpine3.24', '26.0.0-alpine3.24', '24.22.3-alpine3.25'],
        postgres: ['18.7-alpine3.24', '19.0-alpine3.24', '19.1-alpine3.24'],
      },
      digests: { 'node:24.22.3-alpine3.24': digest('a'), 'postgres:18.7-alpine3.24': digest('a') },
    });
    expect(found).toEqual([]);
    expect(listing.counts).toMatchObject({ pins: 2, current: 2 });
  });

  it('leaves an image the policy leaves, by its repository’s name, and asks nothing for it', async () => {
    const leave: Routine['leave'] = [
      { repository: 'all', image: 'example/image', reason: 'Its release moves a definition beside it, by hand.' },
    ];
    const {
      routine: found,
      asked,
      listing,
    } = await listed({
      targets: [PINNED],
      ...newer(9),
      policy: { ...POLICY, leave },
    });
    expect(found).toEqual([]);
    expect(asked).toEqual([]);
    expect(listing.counts.left).toBe(1);
    // A package of the same name is another thing.
    expect(leftAlone({ ...POLICY, leave }, REPOSITORY, { package: 'example/image' }, false)).toBeUndefined();
  });

  it('waits until the image is three days old', async () => {
    const young = await listed({ targets: [PINNED], ...newer(3 - 1 / 1440) });
    expect(young.routine).toEqual([]);
    expect(young.listing.counts).toMatchObject({ waiting: 1, listed: 0 });
    expect((await listed({ targets: [PINNED], ...newer(3) })).routine).toHaveLength(1);
  });

  it('dates an image that gives no day from the day the scan first saw that target, which the state keeps', async () => {
    const undated = { ...newer(0), created: { [`example/image@${digest('b')}`]: '1970-01-01T00:00:00Z' } };
    const first = await listed({ targets: [PINNED], ...undated });
    expect(first.routine).toEqual([]);
    expect(first.records).toEqual([
      {
        name: 'example/image',
        from: '2.17.0',
        to: `image 2.18.1@${digest('b')}`,
        pins: [{ file: 'deploy/x.yaml', line: 12 }],
        seen: '2026-11-10T04:30:00Z',
      },
    ]);
    // The next days' runs read the record back: listed on the third day, never before, and the day never moves.
    const second = await listed({ targets: [PINNED], ...undated, last: first.records }, NOW + 2 * DAY);
    expect(second.routine).toEqual([]);
    expect(second.records[0]?.seen).toBe('2026-11-10T04:30:00Z');
    const third = await listed({ targets: [PINNED], ...undated, last: second.records }, NOW + 3 * DAY);
    expect(third.routine).toHaveLength(1);
    expect(third.records).toEqual([{ move: 1, ...first.records[0] }]);
    // With the state lost, the wait starts again; and another digest of the tag is another target, first seen now.
    expect((await listed({ targets: [PINNED], ...undated }, NOW + 3 * DAY)).routine).toEqual([]);
    const rebuilt = { ...undated, digests: { 'example/image:2.18.1': digest('c') }, created: {} };
    const again = await listed({ targets: [PINNED], ...rebuilt, last: second.records }, NOW + 3 * DAY);
    expect(again.routine).toEqual([]);
    expect(again.records[0]).toMatchObject({ to: `image 2.18.1@${digest('c')}`, seen: '2026-11-13T04:30:00Z' });
  });

  it('never takes a release’s own day to be later than the day the scan first saw it', async () => {
    const last: StateRoutine[] = [
      { name: 'example/image', from: '2.17.0', to: `image 2.18.1@${digest('b')}`, pins: [], seen: ago(4) },
    ];
    expect((await listed({ targets: [PINNED], ...newer(1), last })).routine).toHaveLength(1);
  });

  it('waits, for an image that runs another Node, until mise may install that Node, as its fix does', async () => {
    const node = image(`node:24.22.1-trixie-slim@${digest('a')}`, { kind: 'dockerfile', file: 'Dockerfile', line: 1 });
    const world = (released: string): World => ({
      targets: [node],
      files: { 'mise.toml': 'minimum_release_age = "3d"\n[tools]\nnode = "24.22.1"\n' },
      tags: { node: ['24.22.1-trixie-slim', '24.23.0-trixie-slim', '24.23.0-alpine', '25.0.0-trixie-slim'] },
      digests: { 'node:24.23.0-trixie-slim': digest('b') },
      created: { [`node@${digest('b')}`]: ago(5) },
      runs: { [`node@${digest('b')}`]: '24.23.0' },
      releases: [{ version: 'v24.23.0', date: released }],
    });
    expect((await listed(world('2026-11-08'))).routine).toEqual([]);
    const { routine: found } = await listed(world('2026-11-05'));
    expect(found[0]).toMatchObject({ name: 'node', from: '24.22.1-trixie-slim', lane: 'worker' });
    expect(found[0]?.to).toMatchObject({ tag: '24.23.0-trixie-slim' });
  });

  it('names the runtime stage of an image of ours by its Dockerfile, and never the image of ours itself', async () => {
    const ours: ReadTarget = {
      key: 'deploy/overlays/local/image/kustomization.yaml ghcr.io/the-roganator/cv-software-factory/console',
      kind: 'ours',
      file: 'deploy/overlays/local/image/kustomization.yaml',
      label: `ghcr.io/the-roganator/cv-software-factory/console@${digest('9')}`,
      image: `ghcr.io/the-roganator/cv-software-factory/console@${digest('9')}`,
      line: 9,
    };
    const runtime = `gcr.io/distroless/static:1.2.0@${digest('a')}`;
    const world: World = {
      targets: [ours, image(`ghcr.io/the-roganator/cv-software-factory/runner:1.0.0@${digest('9')}`)],
      files: { 'apps/console/Dockerfile': `FROM build:1 AS build\nFROM ${runtime}\n` },
      tags: { 'gcr.io/distroless/static': ['1.2.0', '1.3.0'] },
      digests: { 'gcr.io/distroless/static:1.3.0': digest('b') },
      created: { [`gcr.io/distroless/static@${digest('b')}`]: ago(9) },
    };
    const { routine: found, asked } = await listed(world);
    expect(found).toEqual([
      expect.objectContaining({
        name: 'gcr.io/distroless/static',
        pins: [{ file: 'apps/console/Dockerfile', line: 2 }],
        from: '1.2.0',
      }),
    ]);
    expect(asked.filter((each) => each.includes('the-roganator'))).toEqual([]);
  });

  it('has the name, the pin and the `from` a finding on the same pin has, and no move where a finding’s has it', async () => {
    const finding: Finding = {
      item: PINNED.key,
      listed: PINNED.name,
      label: PINNED.label,
      file: PINNED.file,
      line: 12,
      type: 'debian',
      package: 'libexample',
      installed: '1.0-1',
      advisory: 'CVE-2099-20002',
      severity: 'HIGH',
    };
    // A finding with no fix: no move of its own, and the pin's routine move is named as its place.
    const open = await listed({ targets: [PINNED], findings: [finding], ...newer(5) });
    const [where] = open.judged.judged;
    expect(open.routine[0]).toMatchObject({ name: where?.name, from: where?.from, pins: [where?.pin] });
    expect(open.routine[0]?.leaves.HIGH).toBe(1);
    // With a fix, the finding's move has the pin: nothing is asked for a routine one.
    const fixed = { ...finding, fixed: '1.0-2' };
    const { sources } = sourcesOf({ targets: [PINNED] });
    const scanned: Sources = {
      ...sources,
      tags: async () => ['2.17.0', '2.18.1'],
      image: async () => ({ Metadata: { ImageConfig: { created: ago(9) } }, Results: [] }),
    };
    const handoff: Handoff = {
      repository: REPOSITORY,
      started: ago(0),
      cache: '/nowhere',
      findings: [fixed],
      excepted: [],
      targets: [PINNED],
    };
    const judged = await assess(handoff, scanned, NOW);
    const context = { repository: REPOSITORY, app: false, now: NOW };
    const taken = pinsOf(moves(judged.judged, context));
    const asked: string[] = [];
    const listing = await routine({
      repository: REPOSITORY,
      targets: [PINNED],
      sources: { ...scanned, created: async (reference) => void asked.push(reference) },
      lookups: judged.lookups,
      policy: POLICY,
      taken,
      minimumReleaseAge: 1440,
      now: NOW,
    });
    expect(taken.size).toBe(1);
    expect(listing.behind).toEqual([]);
    expect(asked).toEqual([]);
    expect(moves(judged.judged, context, listing.behind)).toHaveLength(1);
  });

  it('is one move of every pin of one image, an issue’s for a workflow’s pin, and the line’s in the app', async () => {
    const workflow = image(`example/image:2.17.0@${digest('a')}`, {
      kind: 'workflow',
      file: '.github/workflows/check.yml',
      line: 30,
    });
    const both = await listed({ targets: [PINNED, workflow], ...newer(5) });
    expect(both.routine).toHaveLength(1);
    expect(both.routine[0]).toMatchObject({
      pins: [
        { file: '.github/workflows/check.yml', line: 30 },
        { file: 'deploy/x.yaml', line: 12 },
      ],
      lane: 'issue',
    });
    expect((await listed({ targets: [workflow], ...newer(5) })).routine[0]?.lane).toBe('issue');
    expect((await listed({ targets: [PINNED], ...newer(5), repository: APP })).routine[0]?.lane).toBe('line');
  });

  it('lists nothing mise pins: k3d’s images move with the toolchain', async () => {
    const k3d = image('ghcr.io/k3d-io/k3d-proxy:5.8.3', { kind: 'k3d', file: 'mise.lock', line: 40 });
    const { routine: found, asked } = await listed({
      targets: [k3d],
      tags: { 'ghcr.io/k3d-io/k3d-proxy': ['5.8.3', '5.9.0'] },
    });
    expect(found).toEqual([]);
    expect(asked).toEqual([]);
  });
});

const CHART = { repo: 'https://charts.example', chart: 'grafana', version: '13.2.7', release: 'grafana', values: [] };
const chartTarget = (over: Partial<ReadTarget> = {}): ReadTarget => ({
  key: 'chart grafana docker.io/grafana/grafana',
  kind: 'chart',
  file: 'deploy/base/telemetry/grafana.yaml',
  label: 'docker.io/grafana/grafana:12.0.0',
  image: 'docker.io/grafana/grafana:12.0.0',
  name: 'grafana',
  line: 14,
  chart: CHART,
  ...over,
});
const RENDERED = 'image: docker.io/grafana/grafana:12.1.0\n';

describe('a chart that is behind', () => {
  it('moves to the newest version on its major that has waited and renders with our values', async () => {
    const world: World = {
      targets: [
        chartTarget(),
        chartTarget({ key: 'chart grafana busybox', image: 'busybox:1.37', label: 'busybox:1.37' }),
      ],
      charts: {
        grafana: [
          { version: '13.2.7', created: ago(60) },
          { version: '13.6.0', created: ago(20) },
          { version: '13.7.0', created: ago(6) },
          { version: '13.8.0', created: ago(4) },
          { version: '13.9.0', created: ago(2) },
          { version: '13.9.1-beta.1', created: ago(9) },
          { version: '14.0.0', created: ago(30) },
        ],
      },
      // 13.8.0 does not render with our values: passed over, and said.
      renders: { 'grafana@13.7.0': RENDERED, 'grafana@13.6.0': RENDERED },
    };
    const { routine: found, asked, lines, records } = await listed(world);
    expect(found).toEqual([
      expect.objectContaining({
        name: 'grafana',
        pins: [{ file: 'deploy/base/telemetry/grafana.yaml', line: 14 }],
        from: '13.2.7',
        to: { kind: 'chart', chart: 'grafana', version: '13.7.0', major: false },
        major: false,
        lane: 'worker',
      }),
    ]);
    expect(asked).toEqual(['chart grafana', 'render grafana@13.8.0', 'render grafana@13.7.0']);
    expect(lines.filter((line) => line.includes('does not render'))).toHaveLength(1);
    // The release still waiting is kept with the day it was first seen, and has no move yet.
    expect(records.map((record) => [record.to, record.move])).toEqual([
      ['chart grafana 13.7.0', 1],
      ['chart grafana 13.8.0', undefined],
      ['chart grafana 13.9.0', undefined],
    ]);
  });

  it('takes the next major only when its own has nothing newer, once that is a week old', async () => {
    const world = (days: number): World => ({
      targets: [chartTarget()],
      charts: {
        grafana: [
          { version: '14.0.0', created: ago(40) },
          { version: '14.3.1', created: ago(days) },
          { version: '15.0.0', created: ago(30) },
        ],
      },
      renders: { 'grafana@14.3.1': RENDERED, 'grafana@14.0.0': RENDERED, 'grafana@15.0.0': RENDERED },
    });
    expect((await listed(world(7))).routine[0]).toMatchObject({
      to: { kind: 'chart', chart: 'grafana', version: '14.3.1', major: true },
      major: true,
      lane: 'worker',
    });
    // Inside its week the newest waits, and the newest of that major that has waited is taken.
    expect((await listed(world(6))).routine[0]?.to).toMatchObject({ version: '14.0.0', major: true });
    // A newer release on the pinned major, however young, keeps the major out.
    const held = world(7);
    held.charts?.grafana?.push({ version: '13.3.0', created: ago(1) });
    const waiting = await listed(held);
    expect(waiting.routine).toEqual([]);
    expect(waiting.listing.counts.waiting).toBe(1);
  });

  it('names the Makefile’s chart as its Applications’ are named, in the worker’s lane', async () => {
    const argocd = chartTarget({
      key: 'chart argocd quay.io/argoproj/argocd',
      file: 'Makefile',
      line: 7,
      name: 'argocd',
      image: 'quay.io/argoproj/argocd:v3.6.1',
      label: 'quay.io/argoproj/argocd:v3.6.1',
      chart: {
        repo: 'https://argoproj.github.io/argo-helm',
        chart: 'argo-cd',
        version: '10.9.5',
        release: 'argocd',
        values: [],
      },
    });
    const { routine: found } = await listed({
      targets: [argocd],
      charts: { 'argo-cd': [{ version: '10.9.6', created: ago(4) }] },
      renders: { 'argo-cd@10.9.6': 'image: quay.io/argoproj/argocd:v3.6.2\n' },
    });
    expect(found[0]).toMatchObject({
      name: 'argo-cd',
      pins: [{ file: 'Makefile', line: 7 }],
      from: '10.9.5',
      to: { kind: 'chart', chart: 'argo-cd', version: '10.9.6', major: false },
      lane: 'worker',
    });
  });

  it('moves an image one of its values files pins on the image’s own line, at that pin', async () => {
    const valued = chartTarget({
      image: `example/image:2.17.0@${digest('a')}`,
      label: `example/image:2.17.0@${digest('a')}`,
      pin: { file: 'deploy/base/telemetry/values.yaml', line: 5 },
    });
    const { routine: found } = await listed({ targets: [valued], ...newer(5) });
    expect(found).toEqual([
      expect.objectContaining({
        name: 'grafana: example/image',
        pins: [{ file: 'deploy/base/telemetry/values.yaml', line: 5 }],
        from: '2.17.0',
        to: { kind: 'image', tag: '2.18.1', digest: digest('b') },
      }),
    ]);
  });
});

describe('k3s behind', () => {
  const node: ReadTarget = image('rancher/k3s:v1.37.1-k3s1', { kind: 'k3s', file: 'deploy/k3d/cluster.yaml', line: 6 });
  const brought: ReadTarget = image('rancher/mirrored-pause:3.6', {
    kind: 'k3s-release',
    file: 'deploy/k3d/cluster.yaml',
    line: 6,
    list: 'https://github.com/k3s-io/k3s/releases/download/v1.37.1%2Bk3s1/k3s-images.txt',
  });
  const tags = {
    'rancher/k3s': ['v1.36.9-k3s1', 'v1.37.1-k3s1', 'v1.37.2-k3s1', 'v1.37.3-k3s1', 'v1.37.4-rc1-k3s1', 'v1.38.0-k3s1'],
  };

  it('moves to the newest published release on its line that has waited, in the cluster’s lane', async () => {
    const world: World = {
      targets: [node, brought],
      tags,
      k3s: {
        'v1.37.2+k3s1': { published: ago(10), images: [] },
        'v1.37.3+k3s1': { published: ago(2), images: [] },
      },
    };
    const { routine: found, asked } = await listed(world);
    expect(found).toEqual([
      expect.objectContaining({
        name: 'k3s',
        pins: [{ file: 'deploy/k3d/cluster.yaml', line: 6 }],
        from: 'v1.37.1+k3s1',
        to: { kind: 'k3s', release: 'v1.37.2+k3s1' },
        lane: 'cluster',
      }),
    ]);
    // What its release brings comes with it: no image of the list is looked up.
    expect(asked).toEqual(['tags rancher/k3s', 'k3s v1.37.3+k3s1', 'k3s v1.37.2+k3s1']);
  });

  it('is not behind at its line’s newest, and waits for a tag with no published release', async () => {
    expect(
      (await listed({ targets: [node], tags: { 'rancher/k3s': ['v1.37.1-k3s1', 'v1.38.0-k3s1'] } })).routine,
    ).toEqual([]);
    const unpublished = await listed({ targets: [node], tags });
    expect(unpublished.routine).toEqual([]);
    expect(unpublished.listing.counts.waiting).toBe(1);
  });
});

/** A lockfile as pnpm writes one: pnpm's own document first, then the workspace's. */
const lockfile = (importers: string, packages: string[]) =>
  [
    "lockfileVersion: '9.0'",
    '',
    'importers:',
    '',
    '  .:',
    '    configDependencies: {}',
    '    packageManagerDependencies:',
    '      pnpm:',
    '        specifier: 12.16.1',
    '        version: 12.16.1',
    '',
    'packages:',
    '',
    '  pnpm@12.16.1:',
    '    resolution: {integrity: sha512-x}',
    '',
    '---',
    "lockfileVersion: '9.0'",
    '',
    'importers:',
    '',
    importers,
    'packages:',
    '',
    ...packages.flatMap((each) => [`  ${each}:`, '    resolution: {integrity: sha512-x}', '']),
    'snapshots:',
    '',
    ...packages.flatMap((each) => [`  ${each}: {}`, '']),
  ].join('\n');
const dependency = (name: string, specifier: string, version: string) =>
  [`      ${name}:`, `        specifier: ${specifier}`, `        version: ${version}`].join('\n');
const LOCKFILE: ReadTarget = {
  key: 'lockfile pnpm-lock.yaml',
  kind: 'lockfile',
  file: 'pnpm-lock.yaml',
  label: 'pnpm-lock.yaml',
};
const releases = (versions: Record<string, number>, latest?: string): PackageVersions => ({
  ...(latest ? { latest } : {}),
  versions: Object.entries(versions).map(([version, days]) => ({ version, published: ago(days) })),
});
/** A workspace with one direct dependency, `example-a`, and what it brings. */
const direct = (specifier: string, version: string, packages: World['packages']): World => ({
  targets: [LOCKFILE],
  files: {
    'pnpm-lock.yaml': lockfile(
      ['  .:', '    dependencies:', dependency('example-a', specifier, `${version}(example-peer@1.0.0)`), ''].join(
        '\n',
      ),
      [`example-a@${version}`, 'example-indirect@1.0.0'],
    ),
  },
  packages: { 'example-indirect': releases({ '1.0.0': 90, '1.9.0': 30 }), ...packages },
});

describe('a lockfile’s package that is behind', () => {
  it('is a direct dependency alone, moved to the newest release its range admits that has waited', async () => {
    const world = direct('^1.2.0', '1.2.0', {
      'example-a': releases({ '1.2.0': 90, '1.3.0': 20, '1.4.0': 4, '1.5.0': 2, '2.0.0': 40, '1.6.0-beta.1': 30 }),
    });
    const { routine: found, asked } = await listed(world);
    expect(found).toEqual([
      expect.objectContaining({
        name: 'example-a',
        pins: [{ file: 'pnpm-lock.yaml', line: 30 }],
        from: '1.2.0',
        to: { kind: 'version', versions: ['1.4.0'] },
        major: false,
        lane: 'worker',
        lockfile: true,
      }),
    ]);
    // Neither pnpm itself, which mise pins, nor a package no importer names is asked for.
    expect(asked).toEqual(['versions example-a']);
  });

  it('waits three days, and pnpm’s own wait where that is longer', async () => {
    const world = (days: number, minimumReleaseAge?: number): World => ({
      ...direct('^1.2.0', '1.2.0', { 'example-a': releases({ '1.2.0': 90, '1.3.0': days }) }),
      ...(minimumReleaseAge === undefined ? {} : { minimumReleaseAge }),
    });
    expect((await listed(world(2.99))).routine).toEqual([]);
    expect((await listed(world(3))).routine).toHaveLength(1);
    expect((await listed(world(4, 5 * 1440))).routine).toEqual([]);
    expect((await listed(world(5, 5 * 1440))).routine).toHaveLength(1);
  });

  it('takes a release outside its range only when the range admits nothing newer: a major, after a week', async () => {
    const world = (days: number) =>
      direct('^1.2.0', '1.2.0', { 'example-a': releases({ '1.2.0': 90, '2.0.0': 30, '2.1.0': days }) });
    expect((await listed(world(7))).routine[0]).toMatchObject({
      to: { kind: 'version', versions: ['2.1.0'] },
      major: true,
    });
    expect((await listed(world(6.9))).routine[0]).toMatchObject({
      to: { kind: 'version', versions: ['2.0.0'] },
      major: true,
    });
    // Below 1.0 a new minor is outside a caret range, and so is anything past a tilde's minor or an exact version.
    const zero = direct('^0.5.3', '0.5.3', { 'example-a': releases({ '0.5.3': 90, '0.6.0': 6 }) });
    expect((await listed(zero)).routine).toEqual([]);
    zero.packages = { 'example-a': releases({ '0.5.3': 90, '0.6.0': 8 }) };
    expect((await listed(zero)).routine[0]).toMatchObject({
      to: { kind: 'version', versions: ['0.6.0'] },
      major: true,
    });
    const tilde = direct('~1.2.0', '1.2.0', { 'example-a': releases({ '1.2.0': 90, '1.3.0': 8 }) });
    expect((await listed(tilde)).routine[0]?.major).toBe(true);
    const exact = direct('1.2.0', '1.2.0', { 'example-a': releases({ '1.2.0': 90, '1.2.1': 8 }) });
    expect((await listed(exact)).routine[0]?.major).toBe(true);
  });

  it('never moves to a prerelease, or past the release the registry calls latest', async () => {
    const world = direct('^1.2.0', '1.2.0', {
      'example-a': releases({ '1.2.0': 90, '1.3.0': 30, '1.4.0': 30, '1.5.0-rc.1': 30 }, '1.3.0'),
    });
    expect((await listed(world)).routine[0]?.to).toEqual({ kind: 'version', versions: ['1.3.0'] });
    const current = direct('^1.2.0', '1.2.0', { 'example-a': releases({ '1.2.0': 90, '1.1.0': 100 }) });
    expect((await listed(current)).listing.counts).toMatchObject({ current: 1, listed: 0 });
  });

  it('leaves alone a package at two versions, a range the pin step does not move, and a fixture’s lockfile', async () => {
    const importers = [
      '  .:',
      '    dependencies:',
      dependency('example-two', '^1.0.0', '1.0.0'),
      dependency("'@example/workspace'", 'workspace:*', 'link:packages/x'),
      dependency('example-alias', 'npm:example-other@^1.0.0', 'example-other@1.0.0'),
      dependency('example-git', 'github:example/git', 'https://codeload.github.com/example/git/tar.gz/abc'),
      dependency('example-wide', "'>=1.0.0'", '1.0.0'),
      dependency('example-pre', '^1.0.0-rc.1', '1.0.0-rc.1'),
      '',
      '  apps/x:',
      '    devDependencies:',
      dependency('example-split', '^1.0.0', '1.0.0'),
      '',
      '  apps/y:',
      '    optionalDependencies:',
      dependency('example-split', '^1.0.0', '1.1.0'),
      '',
    ].join('\n');
    const text = lockfile(importers, [
      'example-two@1.0.0',
      'example-two@2.0.0',
      'example-split@1.0.0',
      'example-split@1.1.0',
      'example-wide@1.0.0',
    ]);
    const fixture: ReadTarget = { ...LOCKFILE, key: 'lockfile f', file: 'apps/x/test/fixtures/pnpm-lock.yaml' };
    const branch: ReadTarget = { ...LOCKFILE, key: 'lockfile b', file: 'pnpm-lock.next.yaml' };
    const {
      routine: found,
      asked,
      listing,
    } = await listed({
      targets: [LOCKFILE, fixture, branch],
      files: {
        'pnpm-lock.yaml': text,
        'apps/x/test/fixtures/pnpm-lock.yaml': direct('^1.2.0', '1.2.0', {}).files?.['pnpm-lock.yaml'] ?? '',
        'pnpm-lock.next.yaml': direct('^1.2.0', '1.2.0', {}).files?.['pnpm-lock.yaml'] ?? '',
      },
    });
    expect(found).toEqual([]);
    expect(asked).toEqual([]);
    expect(listing.counts).toMatchObject({ pins: 7, left: 7 });
  });

  it('is one move of a package two lockfiles resolve at one version, to what every range admits', async () => {
    const one = direct('^1.2.0', '1.2.0', {}).files?.['pnpm-lock.yaml'] ?? '';
    const other = direct('~1.2.0', '1.2.0', {}).files?.['pnpm-lock.yaml'] ?? '';
    const { routine: found } = await listed({
      targets: [LOCKFILE, { ...LOCKFILE, key: 'lockfile site', file: 'site/pnpm-lock.yaml' }],
      files: { 'pnpm-lock.yaml': one, 'site/pnpm-lock.yaml': other },
      packages: { 'example-a': releases({ '1.2.0': 90, '1.2.4': 9, '1.3.0': 9 }) },
    });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      pins: [
        { file: 'pnpm-lock.yaml', line: 30 },
        { file: 'site/pnpm-lock.yaml', line: 30 },
      ],
      to: { kind: 'version', versions: ['1.2.4'] },
    });
  });

  it('leaves what the policy leaves: every move of a package, or its majors alone, in a repository or in all', async () => {
    const leave: Routine['leave'] = [
      { repository: 'all', package: 'example-a', major: true, reason: 'It follows something else.' },
    ];
    const within = direct('^1.2.0', '1.2.0', { 'example-a': releases({ '1.2.0': 90, '1.3.0': 9, '2.0.0': 30 }) });
    expect((await listed({ ...within, policy: { ...POLICY, leave } })).routine).toHaveLength(1);
    const major = direct('^1.2.0', '1.2.0', { 'example-a': releases({ '1.2.0': 90, '2.0.0': 30 }) });
    const held = await listed({ ...major, policy: { ...POLICY, leave } });
    expect(held.routine).toEqual([]);
    expect(held.listing.counts.left).toBe(1);
    const whole = {
      ...POLICY,
      leave: [{ repository: REPOSITORY, package: 'example-a', reason: 'It moves with its image.' }],
    };
    const never = await listed({ ...within, policy: whole });
    expect(never.routine).toEqual([]);
    expect(never.asked).toEqual([]);
    // Another repository's entry leaves nothing here.
    expect((await listed({ ...within, policy: whole, repository: APP })).routine).toHaveLength(1);
    expect(leftAlone(whole, REPOSITORY, { package: 'example-b' }, true)).toBeUndefined();
    expect(leftAlone(whole, REPOSITORY, { image: 'example-a' }, true)).toBeUndefined();
  });

  it('names nothing of it in moves.json, the table or the log, and keeps what is withheld in the state', async () => {
    const world = direct('^1.2.0', '1.2.0', { 'example-a': releases({ '1.2.0': 90, '1.4.0': 4 }) });
    world.files = {
      'pnpm-lock.yaml': (world.files?.['pnpm-lock.yaml'] ?? '').replaceAll('example-a', 'example-secret'),
    };
    world.packages = { 'example-secret': releases({ '1.2.0': 90, '1.4.0': 4, '1.5.0': 1 }) };
    const { list, records, lines, listing, context } = await listed(world);
    const file = movesFile(list, context, '19234567890');
    const said = [JSON.stringify(file), ...table(file), ...lines, summary(listing, POLICY, { made: 1, kept: 0 })].join(
      '\n',
    );
    for (const word of ['example-secret', '1.2.0', '1.4.0', '1.5.0', '"line":30']) expect(said).not.toContain(word);
    expect(file.moves).toEqual([
      expect.objectContaining({
        name: 'a package in `pnpm-lock.yaml`',
        from: '',
        to: '',
        lockfile: true,
        lane: 'worker',
      }),
    ]);
    expect(file.totals).toMatchObject({ fixed: 0, moves: 1, routine: 1 });
    expect(records).toEqual([
      {
        move: 1,
        name: 'example-secret',
        from: '1.2.0',
        to: 'version 1.4.0',
        pins: [{ file: 'pnpm-lock.yaml', line: 30 }],
        seen: '2026-11-10T04:30:00Z',
      },
      {
        name: 'example-secret',
        from: '1.2.0',
        to: 'version 1.5.0',
        pins: [{ file: 'pnpm-lock.yaml', line: 30 }],
        seen: '2026-11-10T04:30:00Z',
      },
    ]);
    // Sealed with the findings, and read back by the next run and the worker.
    const key = readKey(newKey());
    expect('routine' in stateOf(REPOSITORY, '19234567890', [], [])).toBe(false);
    const state = stateOf(REPOSITORY, '19234567890', [], [], records);
    expect(open(seal(state, key), key, REPOSITORY, '19234567890').routine).toEqual(records);
  });

  it('reads an importer’s direct dependencies, each with its range and its version without its peers', () => {
    const text = direct('^1.2.0', '1.2.0', {}).files?.['pnpm-lock.yaml'] ?? '';
    expect(directs(text)).toEqual([{ name: 'example-a', specifier: '^1.2.0', version: '1.2.0' }]);
    const scoped = lockfile(
      ['  apps/x:', '    devDependencies:', dependency("'@example/a'", "'>=1 <3'", '2.0.0'), ''].join('\n'),
      [],
    );
    expect(directs(scoped)).toEqual([{ name: '@example/a', specifier: '>=1 <3', version: '2.0.0' }]);
  });

  it('reads a package’s releases from npm’s document: no prerelease, none deprecated or unpublished', () => {
    expect(
      packageVersions({
        'dist-tags': { latest: '1.1.0' },
        versions: { '1.0.0': {}, '1.1.0': {}, '1.2.0-rc.1': {}, '0.9.0': { deprecated: 'use 1.x' } },
        time: {
          created: '2026-01-01T00:00:00Z',
          '1.0.0': '2026-01-01T00:00:00Z',
          '1.1.0': '2026-02-01T00:00:00Z',
          '1.2.0-rc.1': '2026-03-01T00:00:00Z',
          '0.9.0': '2025-12-01T00:00:00Z',
          '1.0.1': '2026-01-02T00:00:00Z',
        },
      }),
    ).toEqual({
      latest: '1.1.0',
      versions: [
        { version: '1.0.0', published: '2026-01-01T00:00:00Z' },
        { version: '1.1.0', published: '2026-02-01T00:00:00Z' },
      ],
    });
  });
});

describe('the listing never fails the run', () => {
  const world = (): World => ({
    ...direct('^1.2.0', '1.2.0', { 'example-a': releases({ '1.2.0': 90, '1.4.0': 4 }) }),
    targets: [
      LOCKFILE,
      PINNED,
      image(`example/other:1.0.0@${digest('a')}`, { key: 'deploy/x.yaml example/other', line: 20 }),
    ],
    tags: { 'example/image': ['2.17.0', '2.18.1'], 'example/other': ['1.0.0', '1.1.0'] },
    digests: { 'example/image:2.18.1': digest('b'), 'example/other:1.1.0': digest('c') },
    created: { [`example/image@${digest('b')}`]: ago(5), [`example/other@${digest('c')}`]: ago(5) },
  });

  it('costs a pin whose lookup fails its move alone, with one warning for its source and no package named', async () => {
    const whole = await listed(world());
    expect(whole.routine.map((move) => move.name)).toEqual(['example-a', 'example/image', 'example/other']);
    const down = await listed({ ...world(), down: ['tags example/other', 'versions example-a'] });
    expect(down.routine.map((move) => move.name)).toEqual(['example/image']);
    expect(down.listing.counts).toMatchObject({ listed: 1, unread: 2 });
    expect(down.lines.filter((line) => line.startsWith('::warning::'))).toEqual([
      "::warning::npm's registry could not be read for 1 pin: no routine move is listed for it today.",
      '::warning::the registry of example/other could not be read for 1 pin (The tags of example/other could not be read): no routine move is listed for it today.',
    ]);
    // What the run judged is what it judges with nothing listed.
    expect(verdict(down.judged.rows, false, down.list)).toEqual(verdict(whole.judged.rows));
    expect(verdict(whole.judged.rows, false, whole.list).lines).toEqual(verdict(whole.judged.rows).lines);
  });

  it('keeps a waiting release’s first day through a day its registry could not be read', async () => {
    const undated: World = {
      targets: [PINNED],
      ...newer(0),
      created: { [`example/image@${digest('b')}`]: '1970-01-01T00:00:00Z' },
    };
    const first = await listed(undated);
    const faulty = await listed({ ...undated, last: first.records, down: ['tags example/image'] }, NOW + DAY);
    expect(faulty.routine).toEqual([]);
    expect(faulty.records).toEqual(first.records);
    const third = await listed({ ...undated, last: faulty.records }, NOW + 3 * DAY);
    expect(third.routine).toHaveLength(1);
  });

  it('lists nothing while the policy sets no wait, or the sources cannot date a release', async () => {
    const none = await listed({ ...world(), policy: undefined });
    expect(none.routine).toEqual([]);
    expect(none.asked).toEqual([]);
    expect(summary(none.listing, undefined, { made: 0, kept: 0 })).toContain('sets no wait');
    const { sources } = sourcesOf(world());
    const judged = await assess(
      {
        repository: REPOSITORY,
        started: ago(0),
        cache: '/nowhere',
        findings: [],
        excepted: [],
        targets: world().targets,
      },
      sources,
      NOW,
    );
    const listing = await routine({
      repository: REPOSITORY,
      targets: world().targets,
      sources: { file: sources.file },
      lookups: judged.lookups,
      policy: POLICY,
      minimumReleaseAge: 1440,
      now: NOW,
    });
    expect(listing.behind).toEqual([]);
  });

  it('says what it read in counts alone', async () => {
    const { listing } = await listed(world());
    expect(summary(listing, POLICY, { made: 7, kept: 3 })).toBe(
      "Routine moves: 3 pins read, 3 behind and listed, 0 waiting for a release to be 3 days old (7 for a major), 0 left alone, 0 not read. Lookups: 7 made, 3 of them answered from the day's.",
    );
  });
});

describe('the policy’s wait, and what it leaves alone', () => {
  it('waits a whole number of days, a major no less, and gives each thing left a repository and a reason', () => {
    const { days, majorDays, leave } = policy.ROUTINE;
    expect(Number.isInteger(days) && days >= 1).toBe(true);
    expect(Number.isInteger(majorDays) && majorDays >= days).toBe(true);
    for (const entry of leave) {
      expect(['all', ...REPOSITORIES]).toContain(entry.repository);
      // A package, or an image's repository with neither tag nor digest: one or the other.
      expect([typeof entry.package, typeof entry.image].sort()).toEqual(['string', 'undefined']);
      if (entry.package !== undefined) expect(entry.package).toMatch(/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/);
      else expect(entry.image).toMatch(/^[a-z0-9.-]+(\/[a-z0-9._-]+)+$/);
      expect(entry.reason.trim().length).toBeGreaterThan(20);
      expect(
        Object.keys(entry).filter((key) => !['repository', 'package', 'image', 'major', 'reason'].includes(key)),
      ).toEqual([]);
      if ('major' in entry) expect(entry.major === true && entry.package !== undefined).toBe(true);
    }
    const keys = leave.map((entry) => `${entry.repository} ${entry.package ?? ''} ${entry.image ?? ''}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('is three days and seven, and leaves Node’s types at a major and what Playwright’s image brings', () => {
    expect(policy.ROUTINE).toMatchObject({ days: 3, majorDays: 7 });
    for (const repository of REPOSITORIES) {
      expect(leftAlone(policy.ROUTINE, repository, { package: '@types/node' }, true)).toBeDefined();
      expect(leftAlone(policy.ROUTINE, repository, { package: '@types/node' }, false)).toBeUndefined();
      for (const library of ['playwright', 'playwright-core', '@playwright/test', '@anthropic-ai/claude-agent-sdk'])
        expect(leftAlone(policy.ROUTINE, repository, { package: library }, false)).toBeDefined();
      // flagd, whose FeatureFlag definition moves with it by hand.
      expect(leftAlone(policy.ROUTINE, repository, { image: 'ghcr.io/open-feature/flagd' }, false)).toBeDefined();
    }
  });
});
