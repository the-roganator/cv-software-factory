import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { ENVIRONMENT } from '../../../policy/triage.ts';
import { TIMING } from '../src/logs/watcher.ts';
import { DEPLOY, manifests as deployManifests, PROMETHEUS } from './deploy.ts';

/**
 * The readers of telemetry as deploy/ declares them (#348): the factory's workers reach Prometheus, Loki and Tempo only
 * through the read-only proxy in `telemetry`, which passes queries by GET and refuses the rest, and Prometheus's
 * lifecycle endpoints are off. `make egress` shows the same on the cluster: a reader can query and cannot write.
 */
interface Peer {
  namespaceSelector?: { matchLabels?: Record<string, string>; matchExpressions?: unknown[] };
  podSelector?: { matchLabels?: Record<string, string>; matchExpressions?: unknown[] };
  ipBlock?: { cidr: string };
}
interface Rule {
  to?: Peer[];
  ports?: { protocol: string; port: number }[];
}
interface Container {
  name: string;
  env?: { name: string; value?: string }[];
}
interface Manifest {
  kind?: string;
  metadata?: { name?: string; namespace?: string };
  spec?: { egress?: Rule[]; template?: { spec?: { containers?: Container[] } } };
}

const READERS = ['triage', 'intake', 'logs', 'line'];
const ADDRESSES = ['PROMETHEUS_URL', 'LOKI_URL', 'TEMPO_URL'];
const PROXY = { matchLabels: { 'app.kubernetes.io/name': 'query' } };
const COLLECTOR = { matchLabels: { 'app.kubernetes.io/name': 'opentelemetry-collector' } };

const manifests = () => deployManifests<Manifest>();

/** The egress rules of the policies in `factory`, each peer on its own: the policy, the peer, the rule's ports. */
async function factoryEgress() {
  return (await manifests())
    .filter(({ manifest, namespace }) => manifest.kind === 'NetworkPolicy' && namespace === 'factory')
    .flatMap(({ manifest: policy }) =>
      (policy.spec?.egress ?? []).flatMap((rule) =>
        (rule.to ?? [{}]).map((peer) => ({
          policy: policy.metadata?.name,
          peer,
          ports: (rule.ports ?? []).map((p) => p.port),
        })),
      ),
    );
}

/** The rules that reach into `telemetry`: by its name, the pods named by their labels. */
async function intoTelemetry() {
  return (await factoryEgress())
    .filter(({ peer }) => peer.namespaceSelector?.matchLabels?.['kubernetes.io/metadata.name'] === 'telemetry')
    .map(({ policy, peer, ports }) => ({ policy, pods: peer.podSelector, ports }));
}

describe('the factory’s reach into telemetry', () => {
  it('names each namespace it reaches by name, and leaves none open by omission', async () => {
    // A rule with no peer reaches everywhere, and an empty or expression namespace selector reaches every namespace or
    // whichever match: each would take in `telemetry` unnamed. An address block is the line's or the admin service's, to the API server's port,
    // or the local gateway's, to LM Studio on the host; the red-team harness's too, to create the attacks' pods.
    const open = (await factoryEgress()).filter(
      ({ peer }) =>
        Object.keys(peer).length === 0 ||
        (peer.namespaceSelector !== undefined && !peer.namespaceSelector.matchLabels?.['kubernetes.io/metadata.name']),
    );
    expect(open).toEqual([]);
    const blocks = (await factoryEgress()).filter(
      ({ peer }) => peer.ipBlock && !peer.ipBlock.cidr.startsWith('0.0.0.0'),
    );
    expect(new Set(blocks.map(({ policy, ports }) => `${policy} ${ports}`))).toEqual(
      new Set(['line 6443', 'admin 6443', 'red-team 6443', 'gateway-local-models 1234']),
    );
  });

  it('is the collector’s OTLP port and the read-only proxy, and never a backend itself', async () => {
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    const rules = await intoTelemetry();
    expect(rules.filter(({ pods }) => !same(pods, PROXY) && !same(pods, COLLECTOR))).toEqual([]);
    // The collector on its OTLP port alone.
    expect(new Set(rules.filter(({ pods }) => same(pods, COLLECTOR)).map(({ ports }) => ports.join()))).toEqual(
      new Set(['4318']),
    );
  });

  it('reaches the proxy from the readers alone, on the ports of the backends each reads', async () => {
    const proxy = (await intoTelemetry()).filter(({ pods }) => JSON.stringify(pods) === JSON.stringify(PROXY));
    expect(proxy.map(({ policy, ports }) => [policy, ports])).toEqual([
      ['triage', [9090, 3100, 3200]],
      ['intake', [9090, 3100]],
      ['logs', [9090, 3100, 3200]],
      ['line', [9090, 3100, 3200]],
    ]);
  });

  it('gives each reader the proxy’s addresses, and no backend’s', async () => {
    const deployments = (await manifests())
      .filter(({ manifest: m, namespace }) => m.kind === 'Deployment' && namespace === 'factory')
      .map(({ manifest }) => manifest)
      .filter((m) => READERS.includes(m.metadata?.name ?? ''));
    expect(deployments.map((d) => d.metadata?.name).sort()).toEqual([...READERS].sort());
    const port = { PROMETHEUS_URL: 9090, LOKI_URL: 3100, TEMPO_URL: 3200 } as Record<string, number>;
    for (const deployment of deployments) {
      const env = (deployment.spec?.template?.spec?.containers ?? []).flatMap((c) => c.env ?? []);
      const addresses = env.filter((e) => ADDRESSES.includes(e.name));
      expect(addresses.length, deployment.metadata?.name).toBeGreaterThan(0);
      for (const { name, value } of addresses) {
        expect(value, `${deployment.metadata?.name} ${name}`).toBe(`http://query.telemetry:${port[name]}`);
      }
    }
  });
});

describe('the read-only proxy', () => {
  const servers = async () => {
    const conf = await readFile(join(DEPLOY, 'base/telemetry/query/nginx.conf'), 'utf-8');
    // Each server block, by the port it listens on. Blocks nest one level (locations, ifs), so a server ends at the
    // first line that closes a brace at its own indent.
    return [...conf.matchAll(/^ {2}server \{\n([\s\S]*?)^ {2}\}$/gm)].map(([, body = '']) => ({
      port: Number(/listen (\d+);/.exec(body)?.[1]),
      body,
    }));
  };

  it('listens on each backend’s port, and on its own for its health', async () => {
    expect((await servers()).map(({ port }) => port)).toEqual([8080, 9090, 3100, 3200]);
  });

  it('answers any method but GET and HEAD with 405, and any path it does not name with 403', async () => {
    for (const { port, body } of (await servers()).filter(({ port }) => port !== 8080)) {
      expect(body, String(port)).toContain('if ($request_method !~ ^(GET|HEAD)$) {\n      return 405;');
      expect(body, String(port)).toContain('location / {\n      return 403;');
    }
  });

  it('passes each path the factory’s clients ask a backend for, on that backend’s port', async () => {
    const byPort = new Map((await servers()).map(({ port, body }) => [port, body]));
    const clients = { prometheus: 9090, loki: 3100, tempo: 3200 };
    for (const [client, port] of Object.entries(clients)) {
      const source = await readFile(new URL(`../src/clients/${client}.ts`, import.meta.url), 'utf-8');
      // The paths the client names whole; a trace's path, built from its id, has a test of its own above.
      const paths = [...source.matchAll(/getJson\([^)]*?'(\/[^']+)'/g)].map(([, path]) => path);
      expect(paths.length, client).toBeGreaterThan(0);
      for (const path of paths) expect(byPort.get(port), `${client} ${path}`).toContain(`location = ${path} {`);
    }
  });

  it('passes on the path nginx has normalised, or the trace id it captured, never the one the client wrote', async () => {
    const conf = await readFile(join(DEPLOY, 'base/telemetry/query/nginx.conf'), 'utf-8');
    const passes = [...conf.matchAll(/proxy_pass ([^;]+);/g)].map(([, target]) => target);
    expect(passes.length).toBeGreaterThan(0);
    for (const target of passes) {
      expect(target).toMatch(/^http:\/\/((prometheus|loki|tempo)\$uri|tempo\/api\/traces\/\$1)(\$is_args\$args)?$/);
    }
  });
});

describe('Tempo', () => {
  /** A Go duration (`24h`, `1h30m`, `90s`) in milliseconds; NaN for anything else, which no bound passes. */
  const ms = (duration: string) => {
    const units: Record<string, number> = { h: 3_600_000, m: 60_000, s: 1000 };
    const parts = [...duration.matchAll(/(\d+)([hms])/g)];
    if (parts.length === 0 || parts.map(([part]) => part).join('') !== duration) return Number.NaN;
    return parts.reduce((total, [, n, unit]) => total + Number(n) * (units[unit ?? ''] ?? Number.NaN), 0);
  };
  /** A Kubernetes quantity in Mi or Gi, in bytes. */
  const bytes = (quantity: string) => {
    const [, n, unit] = quantity.match(/^(\d+)(Mi|Gi)$/) ?? [];
    return Number(n) * (unit === 'Gi' ? 2 ** 30 : 2 ** 20);
  };

  it('collects before the kernel kills it, and bounds what a search may take', async () => {
    const values = await readFile(join(DEPLOY, 'base/telemetry/values/tempo.yaml'), 'utf-8');
    const { tempo } = parse(values) as {
      tempo: {
        retention: string;
        resources: { limits: { memory: string } };
        extraEnv: { name: string; value: string }[];
        querier: { max_concurrent_queries: number };
        queryFrontend: {
          max_batch_size: number;
          search: { max_duration: string; max_result_limit: number };
          metrics: { max_duration: string };
        };
      };
    };
    const limit = bytes(tempo.resources.limits.memory);
    const goMemLimit = Number(tempo.extraEnv.find((env) => env.name === 'GOMEMLIMIT')?.value);
    expect(goMemLimit / limit).toBeCloseTo(0.9, 2);

    // Fewer jobs at once than Tempo's defaults (20 batches of 7), which held 818Mi when searches ran it out of memory
    // (#380). The querier runs a batch's jobs all at once, so one job a batch makes its limit a limit on jobs.
    expect(tempo.queryFrontend.max_batch_size).toBe(1);
    expect(tempo.querier.max_concurrent_queries).toBeLessThanOrEqual(8);
    expect(tempo.querier.max_concurrent_queries).toBeGreaterThanOrEqual(4);

    // Above the widest the factory reads: the environment check's search, and the agreement check's metrics query.
    const { search, metrics } = tempo.queryFrontend;
    expect(ms(search.max_duration)).toBeGreaterThanOrEqual(ENVIRONMENT.tempoMinutes * 60_000);
    expect(ms(metrics.max_duration)).toBeGreaterThanOrEqual(TIMING.agreementWindowMs);
    // A day at most, below what Tempo keeps, or the bound would not bound anything.
    expect(ms(search.max_duration)).toBeLessThanOrEqual(ms('24h'));
    expect(ms(metrics.max_duration)).toBeLessThanOrEqual(ms('24h'));
    expect(ms(search.max_duration)).toBeLessThan(ms(tempo.retention));
    // The factory asks for one trace, and Grafana for 20 unless told otherwise; Tempo's own limit is 262,144.
    expect(search.max_result_limit).toBeGreaterThanOrEqual(20);
    expect(search.max_result_limit).toBeLessThanOrEqual(1000);
  });
});

describe('the service graph', () => {
  interface TempoValues {
    tempo: {
      metricsGenerator: {
        enabled: boolean;
        processor: { service_graphs: Record<string, unknown> };
        storage: { remote_write: { url: string; write_relabel_configs: unknown[] }[] };
      };
      overrides: { defaults: { metrics_generator: { processors: string[] } } };
    };
  }

  it('is all Tempo’s metrics generator makes, and all it writes, to Prometheus', async () => {
    const { tempo } = parse(await readFile(join(DEPLOY, 'base/telemetry/values/tempo.yaml'), 'utf-8')) as TempoValues;
    expect(tempo.metricsGenerator.enabled).toBe(true);
    // Span metrics off. A node is a service, or the host or database system a call out reached: not Tempo's defaults,
    // `peer.service` and `db.name`, which a span may set to anything; and no span attribute is a label of its own.
    expect(tempo.overrides.defaults.metrics_generator.processors).toEqual(['service-graphs']);
    expect(tempo.metricsGenerator.processor).toEqual({
      service_graphs: { peer_attributes: ['server.address'], database_name_attributes: ['db.system'] },
    });
    expect(tempo.metricsGenerator.storage.remote_write).toEqual([
      {
        url: 'http://prometheus-server.telemetry/api/v1/write',
        write_relabel_configs: [{ source_labels: ['__name__'], regex: 'traces_service_graph_.+', action: 'keep' }],
      },
    ]);
  });

  it('is read by nothing the senses, the alerts or the canary’s analysis read', async () => {
    const sources = async (dir: string) =>
      Promise.all(
        (await readdir(dir, { recursive: true }))
          .filter((file) => file.endsWith('.ts') || file.endsWith('.yaml'))
          .map(async (file) => [file, await readFile(join(dir, file), 'utf-8')] as const),
      );
    const read = [
      ...(await sources(fileURLToPath(new URL('../src/', import.meta.url)))),
      ...(await sources(join(DEPLOY, 'base/analysis'))),
      ['prometheus-rules.yaml', await readFile(join(DEPLOY, 'base/telemetry/values/prometheus-rules.yaml'), 'utf-8')],
    ];
    expect(read.length).toBeGreaterThan(10);
    expect(read.filter(([, text]) => /\btraces_/.test(text)).map(([file]) => file)).toEqual([]);
  });
});

describe('Prometheus', () => {
  it('lets in only what writes to it or reads it by design', async () => {
    const values = parse(await readFile(join(DEPLOY, 'base/telemetry/values/prometheus.yaml'), 'utf-8')) as {
      server: { extraFlags: string[] };
    };
    expect(values.server.extraFlags).toEqual(
      expect.arrayContaining(['web.enable-otlp-receiver', 'web.enable-remote-write-receiver']),
    );
    const fences = (await manifests()).filter(
      ({ manifest, namespace }) => manifest.kind === 'NetworkPolicy' && namespace === 'telemetry',
    );
    // Prometheus's, and Alertmanager's, which alertmanager.test.ts holds.
    expect(fences.map(({ manifest }) => manifest.metadata?.name).sort()).toEqual(['alertmanager', 'prometheus']);
    const [fence] = fences
      .filter(({ manifest }) => manifest.metadata?.name === 'prometheus')
      .map(({ manifest }) => manifest) as {
      spec: { podSelector: unknown; policyTypes: string[]; ingress: { from: Peer[]; ports: unknown[] }[] };
    }[];
    expect(fence?.spec.podSelector).toEqual(PROMETHEUS.podSelector);
    // Ingress alone: what it scrapes is fenced by each target's own policy.
    expect(fence?.spec.policyTypes).toEqual(['Ingress']);
    const telemetry = (name: string) => ({ podSelector: { matchLabels: { 'app.kubernetes.io/name': name } } });
    expect(fence?.spec.ingress).toEqual([
      {
        from: [
          telemetry('opentelemetry-collector'),
          telemetry('tempo'),
          telemetry('grafana'),
          telemetry('query'),
          {
            namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'argo-rollouts' } },
            podSelector: { matchLabels: { 'app.kubernetes.io/component': 'rollouts-controller' } },
          },
        ],
        ports: [{ protocol: 'TCP', port: 9090 }],
      },
    ]);
  });

  it('has its lifecycle endpoints off, and reloads itself', async () => {
    const values = await readFile(join(DEPLOY, 'base/telemetry/values/prometheus.yaml'), 'utf-8');
    const parsed = parse(values) as {
      configmapReload: { prometheus: { enabled: boolean } };
      server: { extraFlags: string[] };
    };
    expect(parsed.server.extraFlags).not.toContain('web.enable-lifecycle');
    expect(parsed.server.extraFlags).toContain('config.auto-reload');
    expect(parsed.configmapReload.prometheus.enabled).toBe(false);
  });

  it('keeps seven days, or less before its blocks outgrow the volume', async () => {
    const values = await readFile(join(DEPLOY, 'base/telemetry/values/prometheus.yaml'), 'utf-8');
    const { server } = parse(values) as {
      server: {
        retention?: string;
        persistentVolume: { size: string };
        tsdb: { retention: { time: string; size: string } };
      };
    };
    // Both binary: Prometheus's 3GB is 3GiB.
    const bytes = (size: string, units: Record<string, number>) => {
      const [, n, unit] = size.match(/^(\d+(?:\.\d+)?)(\w+)$/) ?? [];
      return Number(n) * (units[unit ?? ''] ?? Number.NaN);
    };
    const volume = bytes(server.persistentVolume.size, { Mi: 2 ** 20, Gi: 2 ** 30 });
    const retained = bytes(server.tsdb.retention.size, { MB: 2 ** 20, GB: 2 ** 30 });
    // Size is checked only after compaction, which writes a block before deleting the ones it replaces.
    expect(retained).toBeLessThanOrEqual(volume * 0.75);
    expect(server.tsdb.retention.time).toBe('7d');
    // The chart's flag would be a second, deprecated retention.
    expect(server.retention).toBe('');
  });
});
