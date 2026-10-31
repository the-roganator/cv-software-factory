import { describe, expect, it } from 'vitest';
import type { Step } from '../../runner/src/step.ts';
import { agentJob, prepareJob } from '../src/runners/jobs.ts';
import { type LabelSelector, type Manifest, rendered, selects } from './deploy.ts';

/**
 * The runners' fences as each profile renders them (ADR 0008, spec 6 guardrail 6): everything in `runners` is denied
 * both ways; the agent pod reaches the gateway and the line's handback in `factory`, and nothing else, not even DNS;
 * the prepare pod reaches DNS and 443 on public addresses alone; and of all the cluster's fences, only the gateway's
 * and the line's let a runner in, the agent pod alone. The pods are labelled as the line makes them
 * (runners/jobs.ts). `make egress` shows the same on the cluster.
 */
type Labels = Record<string, string>;
type Selector = LabelSelector;
interface Peer {
  namespaceSelector?: Selector;
  podSelector?: Selector;
  ipBlock?: { cidr: string; except?: string[] };
}
interface Rule {
  ports?: { protocol?: string; port?: number | string; endPort?: number }[];
}
type Policy = Manifest & {
  kind: 'NetworkPolicy';
  metadata: { name: string; namespace: string };
  spec: {
    podSelector: Selector;
    policyTypes: string[];
    ingress?: (Rule & { from?: Peer[] })[];
    egress?: (Rule & { to?: Peer[] })[];
  };
};

/** The addresses the prepare pod may not reach: the cluster's, the local network's, link-local and the host's. */
const PRIVATE = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16', '100.64.0.0/10', '0.0.0.0/8'];

const STEP: Step = { agent: 'coder', repository: 'r', commit: 'c', prompt: 'p', maxTurns: 1 };
const NAMES = { job: 'coder-1-1-1', workItem: '1' };
const SETTINGS = { image: 'runner', deadlineSeconds: 60, gatewayUrl: '', handbackUrl: '', token: '', hosts: [] };
const AGENT = agentJob(NAMES, STEP, SETTINGS).spec.template.metadata.labels as Labels;
const PREPARE = prepareJob(NAMES, STEP, SETTINGS).spec.template.metadata.labels as Labels;

const NAMESPACE = 'kubernetes.io/metadata.name';

/** A selector's labels, `name=gateway` for the usual name label, and `*` for every pod. */
const labelsOf = (selector: Selector | undefined) => {
  if (selector?.matchExpressions?.length) throw new Error('This test reads matchLabels alone');
  const named = Object.entries(selector?.matchLabels ?? {}).map(
    ([key, value]) => `${key === 'app.kubernetes.io/name' ? 'name' : key}=${value}`,
  );
  return named.join(',') || '*';
};

/** A rule's ports, `TCP/8080`; no ports is every port, and a range or a named port is refused rather than misread. */
const portsOf = (rule: Rule) => {
  if (!rule.ports?.length) return ['every port'];
  return rule.ports.map((p) => {
    if (p.endPort !== undefined || typeof p.port !== 'number') throw new Error('This test reads single numbered ports');
    return `${p.protocol ?? 'TCP'}/${p.port}`;
  });
};

/**
 * A peer and its ports, in a line: `factory/name=gateway TCP/8080`. A rule with no peers is every address, and reads
 * as `anywhere`.
 */
const reach = (peer: Peer | undefined, rule: Rule) => {
  const where = !peer
    ? 'anywhere'
    : peer.ipBlock
      ? [peer.ipBlock.cidr, ...(peer.ipBlock.except?.length ? ['except', ...peer.ipBlock.except] : [])].join(' ')
      : `${peer.namespaceSelector ? (peer.namespaceSelector.matchLabels?.[NAMESPACE] ?? labelsOf(peer.namespaceSelector)) : '(own namespace)'}/${labelsOf(peer.podSelector)}`;
  return `${where} ${portsOf(rule).join(' ')}`;
};

/** A rule's peers, or `[undefined]` for a rule that names none, which Kubernetes reads as everywhere. */
const peersOf = (peers: Peer[] | undefined) => (peers?.length ? peers : [undefined]);

/** Every place a pod with these labels in `runners` may reach, from each policy that selects it. */
const egressOf = (policies: Policy[], labels: Labels) =>
  policies
    .filter((p) => selects(p.spec.podSelector, labels))
    .flatMap((p) => (p.spec.egress ?? []).flatMap((rule) => peersOf(rule.to).map((peer) => reach(peer, rule))));

const profiles = () => {
  const byOverlay = new Map<string, Policy[]>();
  for (const { overlay, manifest } of rendered<Policy>()) {
    if (manifest.kind !== 'NetworkPolicy') continue;
    byOverlay.set(overlay, [...(byOverlay.get(overlay) ?? []), manifest]);
  }
  return [...byOverlay];
};

describe('the runners’ fences, in every profile', () => {
  const all = profiles();

  it('are rendered for every profile', () => {
    expect(all.map(([overlay]) => overlay)).toContain('local');
    expect(AGENT['factory.mrogan.dev/runner']).toBe('agent');
    expect(PREPARE['factory.mrogan.dev/runner']).toBe('prepare');
  });

  it('deny everything in runners, both ways, and let nothing in', () => {
    for (const [overlay, policies] of all) {
      const runners = policies.filter((p) => p.metadata.namespace === 'runners');
      const denyAll = runners.filter(
        (p) => Object.keys(p.spec.podSelector).length === 0 && !p.spec.ingress?.length && !p.spec.egress?.length,
      );
      expect(
        denyAll.map((p) => p.spec.policyTypes.sort()),
        overlay,
      ).toEqual([['Egress', 'Ingress']]);
      expect(
        runners.filter((p) => p.spec.ingress?.length),
        overlay,
      ).toEqual([]);
    }
  });

  it('let the agent pod reach the gateway and the line’s handback alone, with no DNS', () => {
    for (const [overlay, policies] of all) {
      const runners = policies.filter((p) => p.metadata.namespace === 'runners');
      expect(egressOf(runners, AGENT), overlay).toEqual([
        'factory/name=gateway TCP/8080',
        'factory/name=line TCP/8081',
      ]);
    }
  });

  it('let the prepare pod reach DNS, and 443 on public addresses, alone', () => {
    for (const [overlay, policies] of all) {
      const runners = policies.filter((p) => p.metadata.namespace === 'runners');
      expect(egressOf(runners, PREPARE).sort(), overlay).toEqual(
        ['kube-system/k8s-app=kube-dns UDP/53 TCP/53', `0.0.0.0/0 except ${PRIVATE.join(' ')} TCP/443`].sort(),
      );
    }
  });

  it('are crossed only into the gateway and the line, by the agent pod alone, on the ports it reaches', () => {
    for (const [overlay, policies] of all) {
      const fromRunners = policies.flatMap((p) =>
        (p.spec.ingress ?? []).flatMap((rule) =>
          peersOf(rule.from)
            // A rule open to every peer, an address block, or a namespace selector that picks runners lets them in.
            .filter(
              (peer) =>
                !peer ||
                peer.ipBlock ||
                (peer.namespaceSelector && selects(peer.namespaceSelector, { [NAMESPACE]: 'runners' })),
            )
            .map((peer) => ({
              to: `${p.metadata.namespace}/${labelsOf(p.spec.podSelector)}`,
              from: reach(peer, rule),
              agent: !peer || !!peer.ipBlock || selects(peer.podSelector, AGENT),
              prepare: !peer || !!peer.ipBlock || selects(peer.podSelector, PREPARE),
            })),
        ),
      );
      expect(fromRunners, overlay).toEqual([
        {
          to: 'factory/name=gateway',
          from: 'runners/factory.mrogan.dev/runner=agent TCP/8080',
          agent: true,
          prepare: false,
        },
        {
          to: 'factory/name=line',
          from: 'runners/factory.mrogan.dev/runner=agent TCP/8081',
          agent: true,
          prepare: false,
        },
        // The API server's calls to Kyverno's webhook, from the node's private address. A runner's pod is on one too,
        // and its own fence keeps it from Kyverno, as from everything else the tests above do not name.
        ...['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'].map((cidr) => ({
          to: 'kyverno/app.kubernetes.io/component=admission-controller',
          from: `${cidr} TCP/9443`,
          agent: true,
          prepare: true,
        })),
      ]);
    }
  });
});

describe('reading a fence', () => {
  it('selects by every label and every expression a selector names, and refuses an operator it does not know', () => {
    const runner = 'factory.mrogan.dev/runner';
    expect(selects({}, AGENT)).toBe(true);
    expect(selects(undefined, AGENT)).toBe(true);
    expect(selects({ matchLabels: { [runner]: 'agent' } }, AGENT)).toBe(true);
    expect(selects({ matchLabels: { [runner]: 'agent' } }, PREPARE)).toBe(false);
    const expression = (operator: string, values?: string[]) => ({
      matchExpressions: [{ key: runner, operator, ...(values && { values }) }],
    });
    expect(selects(expression('In', ['agent', 'x']), AGENT)).toBe(true);
    expect(selects(expression('In', ['x']), AGENT)).toBe(false);
    expect(selects(expression('NotIn', ['agent']), AGENT)).toBe(false);
    expect(selects(expression('NotIn', ['agent']), PREPARE)).toBe(true);
    expect(selects(expression('Exists'), AGENT)).toBe(true);
    expect(selects(expression('DoesNotExist'), AGENT)).toBe(false);
    // A key the labels lack: In never selects it, even when its values hold an empty string; NotIn always does.
    expect(selects({ matchExpressions: [{ key: 'absent', operator: 'In', values: [''] }] }, AGENT)).toBe(false);
    expect(selects({ matchExpressions: [{ key: 'absent', operator: 'NotIn', values: ['x'] }] }, AGENT)).toBe(true);
    // Labels and expressions together: both must hold.
    expect(selects({ matchLabels: { [runner]: 'agent' }, ...expression('NotIn', ['agent']) }, AGENT)).toBe(false);
    expect(() => selects(expression('Gt', ['1']), AGENT)).toThrow();
  });

  it('reads a rule with no peers as anywhere, and no ports as every port, and refuses a range', () => {
    expect(peersOf(undefined).map((peer) => reach(peer, {}))).toEqual(['anywhere every port']);
    expect(peersOf([]).map((peer) => reach(peer, { ports: [{ port: 443 }] }))).toEqual(['anywhere TCP/443']);
    expect(() => portsOf({ ports: [{ port: 8080, endPort: 65535 }] })).toThrow();
    expect(() => portsOf({ ports: [{ port: 'http' }] })).toThrow();
  });
});
