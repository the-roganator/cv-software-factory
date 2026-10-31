import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ASKS,
  type Binding,
  beyond,
  canonical,
  differences,
  grants,
  named,
  nameOf,
  PROFILE,
  policyHash,
  RECORDS,
  type RecordName,
  type Resource,
  taken,
  writers,
} from '../../../scripts/policy-hash.ts';
import { DEPLOY, rendered } from './deploy.ts';

/**
 * The refusal records in deploy/test/, each held to the policies and Roles it was taken against: a record keeps their
 * hash (scripts/policy-hash.ts), and it must be the hash of what deploy/ renders now. So a policy or Role loosened, or
 * tightened, without its script run again against the cluster fails here, and the record never speaks for policies
 * that did not give its answers.
 */

const profile = () =>
  rendered<Resource>()
    .filter((r) => r.overlay === PROFILE)
    .map((r) => r.manifest);
const files = () => readdirSync(join(DEPLOY, 'test')).filter((f) => f.endsWith('.json'));
const record = (file: string) =>
  JSON.parse(readFileSync(join(DEPLOY, 'test', file), 'utf-8')) as {
    policyHash?: string;
    policies?: string[];
    revision?: string;
  };

describe('each refusal record', () => {
  const manifests = profile();

  it('is one the hash names objects for, and each it names objects for is kept, but egress.sh’s', () => {
    expect(
      files()
        .map((f) => f.replace(/\.json$/, ''))
        .sort(),
    ).toEqual(
      Object.keys(RECORDS)
        .filter((r) => r !== 'egress')
        .sort(),
    );
  });

  for (const file of files()) {
    const name = file.replace(/\.json$/, '') as RecordName;
    it(`${name} was taken against the policies deploy/ renders now`, () => {
      const kept = record(file);
      const now = taken(name, manifests);
      expect(kept.policies, 'the objects it names').toEqual(now.policies);
      expect(
        kept.policyHash,
        `${file} was taken against other policies: run its script again, against a cluster that runs these`,
      ).toBe(now.policyHash);
      expect(kept.policyHash).toMatch(/^[0-9a-f]{64}$/);
      expect(kept.revision, 'the commit Argo CD had synced when it was taken').toMatch(/^[0-9a-f]{40}$/);
    });
  }

  it('names every Role bound to an account it asks as, in the namespace it asks in', () => {
    for (const [name, { namespace, accounts }] of Object.entries(ASKS)) {
      const binds = (b: Binding) => grants(b, accounts);
      const bindings = (manifests as Binding[]).filter(
        (m) =>
          (m.kind === 'RoleBinding' && m.metadata?.namespace === namespace && binds(m)) ||
          (m.kind === 'ClusterRoleBinding' && binds(m)),
      );
      expect(bindings.length, name).toBeGreaterThan(0);
      const needed = bindings.flatMap((b) => [
        nameOf(b),
        `${b.roleRef.kind} ${b.roleRef.kind === 'Role' ? `${namespace}/` : ''}${b.roleRef.name}`,
      ]);
      const names = named(name as RecordName, manifests).map(nameOf);
      for (const n of needed) expect(names, name).toContain(n);
    }
  });

  it('fails when a policy it was taken against is loosened', () => {
    const loosened = structuredClone(manifests);
    const routes = loosened.find((m) => m.kind === 'ValidatingPolicy' && m.metadata?.name === 'website-routes') as
      | (Resource & { spec: { validations: unknown[] } })
      | undefined;
    if (!routes) throw new Error('No website-routes policy');
    routes.spec.validations = routes.spec.validations.slice(1);
    expect(taken('route-refusals', loosened).policyHash).not.toBe(record('route-refusals.json').policyHash);
    // A Role granted one more verb, too.
    const role = loosened.find((m) => m.kind === 'Role' && m.metadata?.name === 'admin-controls-release') as
      | (Resource & { rules: { verbs: string[] }[] })
      | undefined;
    role?.rules[0]?.verbs.push('delete');
    expect(taken('rollout-refusals', loosened).policyHash).not.toBe(record('rollout-refusals.json').policyHash);
  });
});

describe('the hash of a record’s policies', () => {
  const policy: Resource = {
    apiVersion: 'admissionregistration.k8s.io/v1',
    kind: 'ValidatingAdmissionPolicy',
    metadata: { name: 'p', annotations: { 'argocd.argoproj.io/sync-wave': '0' } },
    spec: { failurePolicy: 'Fail', validations: [{ expression: 'false' }] },
  };

  it('reads what deploy/ gives an object, and none of what the cluster adds', () => {
    const live: Resource = {
      ...policy,
      metadata: {
        name: 'p',
        uid: 'u',
        resourceVersion: '7',
        managedFields: [],
        annotations: { 'argocd.argoproj.io/tracking-id': 'root:x' },
      },
      status: { observedGeneration: 1 },
    };
    expect(canonical(live)).toEqual(canonical(policy));
    expect(canonical(policy)).toEqual({
      apiVersion: 'admissionregistration.k8s.io/v1',
      kind: 'ValidatingAdmissionPolicy',
      metadata: { name: 'p' },
      spec: { failurePolicy: 'Fail', validations: [{ expression: 'false' }] },
    });
    expect(policyHash([live])).toBe(policyHash([policy]));
  });

  it('is of the objects, whatever their order or their keys’, and changes with any field', () => {
    const other: Resource = { ...policy, metadata: { name: 'q' } };
    expect(policyHash([policy, other])).toBe(policyHash([other, policy]));
    const reordered = { spec: { validations: [{ expression: 'false' }], failurePolicy: 'Fail' }, ...policy };
    expect(policyHash([reordered])).toBe(policyHash([policy]));
    expect(
      policyHash([{ ...policy, spec: { failurePolicy: 'Ignore', validations: [{ expression: 'false' }] } }]),
    ).not.toBe(policyHash([policy]));
    expect(policyHash([{ ...policy, metadata: { name: 'p', namespace: 'n' } }])).not.toBe(policyHash([policy]));
    expect(policyHash([policy])).toMatch(/^[0-9a-f]{64}$/);
  });

  it('reads a ClusterRole’s labels, which aggregate its rules into another role', () => {
    const role: Resource = { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRole', metadata: { name: 'r' } };
    const aggregated = {
      ...role,
      metadata: { name: 'r', labels: { 'rbac.authorization.k8s.io/aggregate-to-view': 'true' } },
    };
    expect(policyHash([aggregated])).not.toBe(policyHash([role]));
    const labelled = { ...policy, metadata: { name: 'p', labels: { team: 'x' } } };
    expect(policyHash([labelled])).toBe(policyHash([policy]));
  });

  it('names a missing object rather than hashing without it', () => {
    expect(() => named('route-refusals', [policy])).toThrow(/ValidatingPolicy website-routes: 0 found/);
  });
});

describe('telling the live object from what deploy/ gives it', () => {
  const want = canonical({
    apiVersion: 'v1',
    kind: 'K',
    metadata: { name: 'n' },
    spec: { a: 1, list: [{ b: 'x' }], empty: {}, none: [] },
  });

  it('passes over what the cluster adds, and an empty field it leaves out', () => {
    expect(differences(want, { ...want, spec: { a: 1, list: [{ b: 'x', c: 2 }], defaulted: true } })).toEqual([]);
  });

  it('finds a field changed, one missing, and a list grown or shrunk', () => {
    expect(differences(want, { ...want, spec: { a: 2, list: [{ b: 'x' }] } })).toEqual(['/spec/a: 2, not 1']);
    expect(differences(want, { ...want, spec: { list: [{ b: 'x' }] } })).toEqual(['/spec/a: undefined, not 1']);
    expect(differences(want, { ...want, spec: { a: 1, list: [{ b: 'x' }, { b: 'y' }] } })).toEqual([
      '/spec/list: [{"b":"x"},{"b":"y"}]',
    ]);
    expect(differences(want, { ...want, spec: { a: 1, list: [] } })).toEqual(['/spec/list: []']);
  });
});

describe('telling a field added by hand from what deploy/ gives', () => {
  const fence: Resource = {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: { name: 'f', namespace: 'n' },
    spec: {
      podSelector: { matchLabels: { app: 'a' } },
      policyTypes: ['Egress'],
      egress: [{ ports: [{ port: 53, protocol: 'UDP' }] }],
    },
  };
  const live = (managedFields: unknown[]): Resource => ({
    ...fence,
    metadata: { ...fence.metadata, managedFields },
  });
  const deploys = {
    'f:spec': { 'f:podSelector': {}, 'f:policyTypes': {}, 'f:egress': {} },
  };

  it('lets be a field deploy/ gives, whoever wrote it, and whatever Argo CD and a status writer hold', () => {
    const fields = [
      {
        manager: 'kubectl-client-side-apply',
        operation: 'Update',
        fieldsV1: { 'f:metadata': { 'f:annotations': {} }, ...deploys },
      },
      { manager: 'argocd-controller', operation: 'Update', fieldsV1: { 'f:spec': { 'f:ingress': {} } } },
      { manager: 'kyverno', operation: 'Update', subresource: 'status', fieldsV1: { 'f:status': {} } },
    ];
    expect(writers(live(fields), fence)).toEqual([]);
  });

  it('names a field deploy/ does not give that another wrote', () => {
    const fields = [
      {
        manager: 'kubectl-edit',
        operation: 'Update',
        fieldsV1: { 'f:spec': { 'f:ingress': {}, 'f:podSelector': {} } },
      },
    ];
    expect(writers(live(fields), fence)).toEqual(["/f:spec/f:ingress, written by kubectl-edit, not deploy/'s"]);
  });

  it('follows a list’s items by their keys, and a set’s by their values', () => {
    const rule = { apiGroups: [''], resources: ['secrets'], verbs: ['get'] };
    const want = { rules: [rule], subjects: [{ kind: 'ServiceAccount', name: 's', namespace: 'n' }], set: ['a'] };
    const sa = 'k:{"kind":"ServiceAccount","name":"s","namespace":"n"}';
    expect(beyond({ 'f:subjects': { [sa]: { '.': {}, 'f:name': {} } }, 'f:set': { 'v:"a"': {} } }, want)).toEqual([]);
    expect(
      beyond({ 'f:subjects': { 'k:{"kind":"ServiceAccount","name":"t","namespace":"n"}': { '.': {} } } }, want),
    ).toEqual(['/f:subjects/k:{"kind":"ServiceAccount","name":"t","namespace":"n"}']);
    expect(beyond({ 'f:set': { 'v:"b"': {} } }, want)).toEqual(['/f:set/v:"b"']);
    expect(beyond({ 'f:subjects': { [sa]: { 'f:apiGroup': {} } } }, want)).toEqual([`/f:subjects/${sa}/f:apiGroup`]);
  });

  it('reads a ClusterRole’s labels written by hand, and no other object’s', () => {
    const role: Resource = { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRole', metadata: { name: 'r' } };
    const labelled = [
      {
        manager: 'kubectl-label',
        operation: 'Update',
        fieldsV1: { 'f:metadata': { 'f:labels': { 'f:rbac.authorization.k8s.io/aggregate-to-view': {} } } },
      },
    ];
    expect(writers({ ...role, metadata: { name: 'r', managedFields: labelled } }, role)).toEqual([
      "/f:metadata/f:labels, written by kubectl-label, not deploy/'s",
    ]);
    expect(writers(live(labelled), fence)).toEqual([]);
  });
});

describe('a grant to an account a record asks as', () => {
  const binding = (subjects: Binding['subjects']): Binding => ({
    kind: 'RoleBinding',
    metadata: { name: 'b', namespace: 'website' },
    roleRef: { kind: 'Role', name: 'r' },
    ...(subjects && { subjects }),
  });

  it('is one to the account by name, or to a group every service account, or every one of its namespace, is in', () => {
    const accounts = ['factory/admin'];
    expect(grants(binding([{ kind: 'ServiceAccount', namespace: 'factory', name: 'admin' }]), accounts)).toBe(true);
    for (const group of ['system:authenticated', 'system:serviceaccounts', 'system:serviceaccounts:factory']) {
      expect(grants(binding([{ kind: 'Group', name: group }]), accounts), group).toBe(true);
    }
  });

  it('is not one to another account, or another namespace’s', () => {
    const accounts = ['factory/admin'];
    expect(grants(binding([{ kind: 'ServiceAccount', namespace: 'factory', name: 'line' }]), accounts)).toBe(false);
    expect(grants(binding([{ kind: 'Group', name: 'system:serviceaccounts:website' }]), accounts)).toBe(false);
    expect(grants(binding(undefined), accounts)).toBe(false);
  });
});
