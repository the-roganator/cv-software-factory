import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { objectives } from '../../../policy/objectives.ts';
import { DEPLOY, manifests, PROMETHEUS } from './deploy.ts';

/**
 * The pod log collector as deploy/ declares it (#385): one on each node, in `pod-logs`, reading every container's log
 * from the node's files and sending it to Loki. It holds a host path and runs as root, so what it may read, what it
 * names its records, and where it may reach are held here.
 */
interface Values {
  fullnameOverride: string;
  mode: string;
  podAnnotations: Record<string, string>;
  ports: Record<string, { enabled: boolean; containerPort?: number }>;
  serviceAccount: { automountServiceAccountToken: boolean };
  alternateConfig: {
    receivers: Record<
      string,
      { include: string[]; exclude: string[]; storage?: string; retry_on_failure?: { max_elapsed_time?: number } }
    >;
    processors: Record<string, { attributes?: { key: string; value: string; action: string }[] }>;
    exporters: Record<
      string,
      { endpoint: string; sending_queue?: { storage?: string }; retry_on_failure?: { max_elapsed_time?: number } }
    >;
    extensions: Record<string, { directory?: string; endpoint?: string }>;
    service: {
      telemetry?: {
        metrics?: { readers?: { pull?: { exporter?: { prometheus?: { host: string; port: number } } } }[] };
      };
      pipelines: Record<string, { receivers: string[]; processors: string[]; exporters: string[] }>;
    };
  };
  extraVolumes: { name: string; hostPath?: { path: string } }[];
  extraVolumeMounts: { name: string; mountPath: string; readOnly?: boolean }[];
  podSecurityContext: Record<string, unknown>;
  securityContext: { allowPrivilegeEscalation: boolean; readOnlyRootFilesystem: boolean; capabilities: unknown };
}
interface Peer {
  namespaceSelector?: { matchLabels?: Record<string, string> };
  podSelector?: { matchLabels?: Record<string, string> };
}
interface Manifest {
  kind?: string;
  metadata?: { name?: string; namespace?: string; labels?: Record<string, string> };
  spec?: {
    destination?: { namespace: string };
    sources?: { chart?: string; targetRevision?: string }[];
    podSelector?: { matchLabels?: Record<string, string> };
    policyTypes?: string[];
    ingress?: { from?: Peer[]; ports?: { protocol: string; port: number }[] }[];
    egress?: { to?: Peer[]; ports?: { protocol: string; port: number }[] }[];
  };
}

const values = async () => parse(await readFile(join(DEPLOY, 'base/pod-logs/values.yaml'), 'utf-8')) as Values;

/** Whether a filelog glob matches a path: `*` within one path segment, as Go's filepath.Match. */
const matches = (glob: string, path: string) =>
  new RegExp(`^${glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '[^/]*')}$`).test(path);

/** Whether the collector reads a container's log, by the path the kubelet writes it to. */
async function reads(namespace: string, pod: string, container: string) {
  const { alternateConfig } = await values();
  const [receiver] = Object.values(alternateConfig.receivers);
  const path = `/var/log/pods/${namespace}_${pod}_0f8e2b9c-1d3a-4e5f-9a7b-6c5d4e3f2a1b/${container}/0.log`;
  return (
    (receiver?.include ?? []).some((glob) => matches(glob, path)) &&
    !(receiver?.exclude ?? []).some((glob) => matches(glob, path))
  );
}

describe('the pod log collector', () => {
  it('reads every pod’s log, the runners’ and the platform’s, but the scoreboard’s and its own', async () => {
    const { mode, alternateConfig } = await values();
    expect(mode).toBe('daemonset');
    expect(Object.keys(alternateConfig.receivers)).toEqual(['file_log']);
    expect(await reads('argocd', 'argocd-server-7d9f8b6c5-x2x4q', 'server')).toBe(true);
    expect(await reads('kyverno', 'kyverno-admission-controller-0', 'kyverno')).toBe(true);
    expect(await reads('runners', 'step-42-agent-abcde', 'agent')).toBe(true);
    expect(await reads('factory', 'postgres-0', 'postgres')).toBe(true);
    expect(await reads('telemetry', 'loki-0', 'loki')).toBe(true);
    // The scoreboard sends nothing by design, its log included.
    expect(await reads('scoreboard', 'scoreboard-6b7c8d9e0f-abcde', 'scoreboard')).toBe(false);
    expect(await reads('pod-logs', 'pod-logs-agent-abcde', 'opentelemetry-collector')).toBe(false);
  });

  it('names every record its own service, never the app’s, whose stream the senses read by its pod', async () => {
    const { alternateConfig } = await values();
    // Loki makes k8s.pod.name a stream label, the stamp the senses read beside the app's service name
    // (provenance.ts): under any other name, the app's pods' output is not counted twice.
    const { logs } = alternateConfig.service.pipelines;
    expect(Object.keys(alternateConfig.service.pipelines)).toEqual(['logs']);
    const named = (logs?.processors ?? []).flatMap((p) =>
      (alternateConfig.processors[p]?.attributes ?? []).filter((a) => a.key === 'service.name'),
    );
    expect(named).toEqual([{ key: 'service.name', value: 'pod-logs', action: 'upsert' }]);
    expect(named[0]?.value).not.toBe(objectives.app.logsService);
    expect(logs?.exporters.map((e) => alternateConfig.exporters[e]?.endpoint)).toEqual([
      'http://loki.telemetry:3100/otlp',
    ]);
  });

  it('mounts the node’s pod logs read-only and its own marks and queue, and nothing else of the node', async () => {
    const { extraVolumes, extraVolumeMounts, alternateConfig } = await values();
    expect(extraVolumes.map((v) => v.hostPath?.path)).toEqual(['/var/log/pods', '/var/lib/otelcol/pod-logs']);
    const mount = (path: string) => extraVolumeMounts.find((m) => m.mountPath === path);
    expect(mount('/var/log/pods')?.readOnly).toBe(true);
    expect(alternateConfig.extensions.file_storage?.directory).toBe(mount('/var/lib/otelcol/pod-logs')?.mountPath);
    expect(alternateConfig.receivers.file_log?.storage).toBe('file_storage');
    // What it has read and Loki has yet to take is kept there too, and tried until Loki takes it.
    const [exporter] = Object.values(alternateConfig.exporters);
    expect(exporter?.sending_queue?.storage).toBe('file_storage');
    expect(exporter?.retry_on_failure?.max_elapsed_time).toBe(0);
    // And the reader waits for room in the queue as long as it takes, rather than dropping what it read.
    expect(alternateConfig.receivers.file_log?.retry_on_failure?.max_elapsed_time).toBe(0);
  });

  it('serves its own metrics on 8888 at its pod’s address, and asks Prometheus to scrape them there', async () => {
    const { ports, podAnnotations, alternateConfig } = await values();
    // Its whole configuration replaces the chart's, which would serve them, so it serves them itself, at the pod's own
    // address as its health check is: the collector's own default is localhost, where nothing can scrape them (#446).
    const podAddress = alternateConfig.extensions.health_check?.endpoint?.replace(/:13133$/, '');
    expect(podAddress).toMatch(/MY_POD_IP/);
    expect(alternateConfig.service.telemetry?.metrics?.readers).toEqual([
      { pull: { exporter: { prometheus: { host: podAddress, port: 8888 } } } },
    ]);
    expect(podAnnotations).toEqual({ 'prometheus.io/scrape': 'true', 'prometheus.io/port': '8888' });
    expect(ports.metrics?.containerPort).toBe(8888);
  });

  it('runs as root with every capability dropped, listens on its metrics and health check alone, and has no token', async () => {
    const { ports, serviceAccount, podSecurityContext, securityContext } = await values();
    // Its health check's port is the chart's own, outside `ports`, and the kubelet probes it from the node.
    expect(Object.keys(ports).filter((name) => ports[name]?.enabled)).toEqual(['metrics']);
    expect(serviceAccount.automountServiceAccountToken).toBe(false);
    expect(podSecurityContext).toMatchObject({ runAsUser: 0, seccompProfile: { type: 'RuntimeDefault' } });
    expect(securityContext).toEqual({
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      capabilities: { drop: ['ALL'] },
    });
  });

  it('is alone in the one namespace that does not enforce the restricted standard', async () => {
    const all = await manifests<Manifest>();
    const loose = all.filter(
      ({ manifest }) =>
        manifest.kind === 'Namespace' &&
        manifest.metadata?.labels?.['pod-security.kubernetes.io/enforce'] !== 'restricted',
    );
    expect(loose.map(({ manifest }) => manifest.metadata?.name)).toEqual(['pod-logs']);
    const into = all.filter(
      ({ manifest }) => manifest.kind === 'Application' && manifest.spec?.destination?.namespace === 'pod-logs',
    );
    expect(into.map(({ manifest }) => manifest.metadata?.name)).toEqual(['pod-logs']);
    // Beside the chart, only its fences.
    const beside = all.filter(({ namespace }) => namespace === 'pod-logs').map(({ manifest }) => manifest.kind);
    expect(new Set(beside)).toEqual(new Set(['NetworkPolicy']));
    // The same chart at the same version as the collector in `telemetry`, so the two move together.
    const chart = (name: string) =>
      all.find(({ manifest }) => manifest.kind === 'Application' && manifest.metadata?.name === name)?.manifest.spec
        ?.sources?.[0];
    expect(chart('pod-logs')).toMatchObject({
      chart: chart('otel-collector')?.chart,
      targetRevision: chart('otel-collector')?.targetRevision,
    });
  });

  it('is fenced: only Prometheus reaches it, on its metrics, and it reaches Loki and DNS alone', async () => {
    const policies = (await manifests<Manifest>())
      .filter(({ manifest, namespace }) => manifest.kind === 'NetworkPolicy' && namespace === 'pod-logs')
      .map(({ manifest }) => manifest);
    const deny = policies.find((p) => p.metadata?.name === 'default-deny');
    expect(deny?.spec).toEqual({ podSelector: {}, policyTypes: ['Ingress', 'Egress'] });
    const reachedBy = policies.flatMap((p) =>
      (p.spec?.ingress ?? []).flatMap((rule) =>
        (rule.from ?? [{}]).map((peer) => ({
          to: p.spec?.podSelector?.matchLabels,
          peer,
          ports: (rule.ports ?? []).map((port) => `${port.protocol}/${port.port}`),
        })),
      ),
    );
    expect(reachedBy).toEqual([
      {
        to: { 'app.kubernetes.io/name': 'opentelemetry-collector' },
        peer: PROMETHEUS,
        ports: ['TCP/8888'],
      },
    ]);
    const egress = policies.flatMap((p) => p.spec?.egress ?? []);
    const reaches = egress.flatMap((rule) =>
      (rule.to ?? [{}]).map((peer) => ({
        namespace: peer.namespaceSelector?.matchLabels?.['kubernetes.io/metadata.name'],
        pods: peer.podSelector?.matchLabels,
        ports: (rule.ports ?? []).map((p) => `${p.protocol}/${p.port}`),
      })),
    );
    expect(reaches).toEqual([
      { namespace: 'kube-system', pods: { 'k8s-app': 'kube-dns' }, ports: ['UDP/53', 'TCP/53'] },
      {
        namespace: 'telemetry',
        pods: { 'app.kubernetes.io/name': 'loki', 'app.kubernetes.io/component': 'single-binary' },
        ports: ['TCP/3100'],
      },
    ]);
  });

  it('is waited for by `make egress` under the name the chart gives a DaemonSet', async () => {
    const { fullnameOverride, mode } = await values();
    // In daemonset mode the chart adds `-agent` to the name it is given.
    expect(mode).toBe('daemonset');
    const egress = await readFile(join(DEPLOY, '../scripts/egress.sh'), 'utf-8');
    expect(egress).toContain(`-n pod-logs rollout status daemonset/${fullnameOverride}-agent `);
  });
});
