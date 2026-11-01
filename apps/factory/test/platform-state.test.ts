import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { DEPLOY, manifests as deployManifests, PROMETHEUS, type Relabel, relabel } from './deploy.ts';

/**
 * The cluster's state and Postgres's statistics as deploy/ declares them (#385): kube-state-metrics, from the
 * Prometheus chart, and the Postgres exporter beside Postgres in `factory`, each asking Prometheus to scrape it on its
 * metrics port, and the exporter fenced to Postgres and Prometheus alone.
 */
interface Peer {
  namespaceSelector?: { matchLabels?: Record<string, string> };
  podSelector?: {
    matchLabels?: Record<string, string>;
    matchExpressions?: { key: string; operator: string; values: string[] }[];
  };
}
interface Env {
  name: string;
  value?: string;
  valueFrom?: { secretKeyRef?: { name: string; key: string; optional?: boolean } };
}
interface Container {
  name: string;
  image: string;
  args?: string[];
  ports?: { name: string; containerPort: number }[];
  env?: Env[];
}
interface Manifest {
  kind?: string;
  metadata?: { name?: string; namespace?: string };
  spec?: {
    template?: { metadata?: { annotations?: Record<string, string> }; spec: { containers: Container[] } };
    podSelector?: { matchLabels?: Record<string, string> };
    policyTypes?: string[];
    ingress?: { from?: Peer[]; ports?: { protocol: string; port: number }[] }[];
    egress?: { to?: Peer[]; ports?: { protocol: string; port: number }[] }[];
  };
}

// Read once: every test looks up a manifest or two among all of deploy/.
let all: ReturnType<typeof deployManifests<Manifest>> | undefined;
const manifests = () => (all ??= deployManifests<Manifest>());
const find = async (kind: string, name: string, namespace = 'factory') =>
  (await manifests()).find(
    (m) => m.manifest.kind === kind && m.manifest.metadata?.name === name && m.namespace === namespace,
  );

const SCRAPE = (port: number) => ({ 'prometheus.io/scrape': 'true', 'prometheus.io/port': String(port) });

describe('kube-state-metrics', () => {
  const values = async () =>
    (parse(await readFile(join(DEPLOY, 'base/telemetry/values/prometheus.yaml'), 'utf-8')) as Record<string, unknown>)[
      'kube-state-metrics'
    ] as { enabled: boolean; prometheusScrape: boolean; podAnnotations: Record<string, string>; collectors: string[] };

  it('runs, and asks to be scraped on its pod, as the platform’s components do, not on its Service', async () => {
    const ksm = await values();
    expect(ksm.enabled).toBe(true);
    expect(ksm.prometheusScrape).toBe(false);
    expect(ksm.podAnnotations).toEqual(SCRAPE(8080));
  });

  it('collects only the kinds a pod’s restarts and readiness need, so its role reads no Secret or ConfigMap', async () => {
    // The chart grants list and watch on each collector's kind, and on nothing else.
    expect((await values()).collectors).toEqual([
      'daemonsets',
      'deployments',
      'jobs',
      'nodes',
      'persistentvolumeclaims',
      'pods',
      'statefulsets',
    ]);
  });
});

describe('the Postgres exporter', () => {
  const deployment = async () => {
    const found = await find('Deployment', 'postgres-exporter');
    expect(found?.file).toBe('base/postgres-exporter/deployment.yaml');
    return found?.manifest.spec?.template;
  };
  const migrate = async () => (await find('Job', 'migrate'))?.manifest.spec?.template?.spec.containers[0];

  it('is scraped where it serves its metrics', async () => {
    const template = await deployment();
    expect(template?.metadata?.annotations).toEqual(SCRAPE(9187));
    expect(template?.spec.containers[0]?.ports).toEqual([{ name: 'metrics', containerPort: 9187 }]);
  });

  it('runs a third-party image by digest, with the collectors its role cannot serve off', async () => {
    const [container] = (await deployment())?.spec.containers ?? [];
    expect(container?.image).toMatch(/^quay\.io\/prometheuscommunity\/postgres-exporter:v[\d.]+@sha256:[0-9a-f]{64}$/);
    expect(container?.args).toEqual(['--no-collector.wal', '--no-collector.stat_activity']);
  });

  it('logs in as its own role, with the password the migrations give it from the same Secret', async () => {
    const env = (await deployment())?.spec.containers[0]?.env ?? [];
    expect(env.find((e) => e.name === 'DATA_SOURCE_USER')?.value).toBe('metrics_reader');
    const secret = { name: 'postgres-metrics', key: 'password', optional: true };
    expect(env.find((e) => e.name === 'DATA_SOURCE_PASS')?.valueFrom?.secretKeyRef).toEqual(secret);
    expect((await migrate())?.env?.find((e) => e.name === 'METRICS_PASSWORD')?.valueFrom?.secretKeyRef).toEqual(secret);
    // `make up` makes the Secret, as it does the store's other passwords.
    expect(await readFile(join(DEPLOY, '../Makefile'), 'utf-8')).toMatch(
      /\$\(call password,factory,postgres-metrics\)/,
    );
  });

  it('is let in by Prometheus’s server alone, on 9187, and reaches Postgres alone', async () => {
    const policy = (await find('NetworkPolicy', 'postgres-exporter'))?.manifest.spec;
    expect(policy?.podSelector).toEqual({ matchLabels: { 'app.kubernetes.io/name': 'postgres-exporter' } });
    expect(policy?.policyTypes).toEqual(['Ingress', 'Egress']);
    expect(policy?.ingress).toEqual([{ from: [PROMETHEUS], ports: [{ protocol: 'TCP', port: 9187 }] }]);
    expect(policy?.egress).toEqual([
      {
        to: [{ podSelector: { matchLabels: { 'app.kubernetes.io/name': 'postgres' } } }],
        ports: [{ protocol: 'TCP', port: 5432 }],
      },
    ]);
  });

  it('has its settings dropped as they are scraped, but for max_connections', async () => {
    const { scrapeConfigs } = parse(await readFile(join(DEPLOY, 'base/telemetry/values/prometheus.yaml'), 'utf-8')) as {
      scrapeConfigs: Record<string, { metric_relabel_configs?: Relabel[] }>;
    };
    const rules = scrapeConfigs['kubernetes-pods']?.metric_relabel_configs ?? [];
    const exporter = { job: 'kubernetes-pods', namespace: 'factory' };
    expect(relabel(rules, { __name__: 'pg_settings_max_connections', ...exporter })).toEqual({
      __name__: 'pg_settings_max_connections',
      ...exporter,
    });
    expect(relabel(rules, { __name__: 'pg_settings_shared_buffers_bytes', ...exporter })).toBeUndefined();
    expect(relabel(rules, { __name__: 'pg_settings_max_wal_size_bytes', ...exporter })).toBeUndefined();
    expect(relabel(rules, { __name__: 'pg_stat_database_numbackends', ...exporter })).toEqual({
      __name__: 'pg_stat_database_numbackends',
      ...exporter,
    });
  });

  it('is let into Postgres', async () => {
    const policy = (await find('NetworkPolicy', 'postgres'))?.manifest.spec;
    const names = (policy?.ingress ?? [])
      .flatMap((rule) => rule.from ?? [])
      .filter((peer) => !peer.namespaceSelector)
      .flatMap((peer) => peer.podSelector?.matchExpressions ?? [])
      .find((e) => e.key === 'app.kubernetes.io/name')?.values;
    expect(names).toContain('postgres-exporter');
  });
});
