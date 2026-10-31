import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PASSWORDS, WORKERS } from '../../../packages/store/src/migrate.ts';
import { DEPLOY, manifests } from './deploy.ts';

/**
 * Each worker's own role in the store (#435) gets its password as the store's other roles do: from a Secret `make up`
 * makes, which the migrate Job reads and sets.
 */
interface Env {
  name: string;
  value?: string;
  valueFrom?: { secretKeyRef?: { name: string; key: string; optional?: boolean } };
}
interface Job {
  kind?: string;
  metadata?: { name?: string };
  spec?: { template?: { spec: { containers: { env?: Env[] }[] } } };
}

interface Deployment {
  kind?: string;
  metadata?: { name?: string };
  spec?: { template?: { spec: { containers: { env?: Env[] }[]; initContainers?: { env?: Env[] }[] } } };
}

const migrateJob = async () => {
  const found = (await manifests<Job>()).find(
    (m) => m.manifest.kind === 'Job' && m.manifest.metadata?.name === 'migrate',
  );
  return found?.manifest.spec?.template?.spec.containers[0]?.env ?? [];
};

describe('the store’s passwords', () => {
  it('are each set by the migrate Job from a Secret, for every role the migrations give one', async () => {
    const env = await migrateJob();
    for (const { variable } of Object.values(PASSWORDS)) {
      expect(env.find((e) => e.name === variable)?.valueFrom?.secretKeyRef?.key, variable).toBe('password');
    }
  });

  it('include none for the factory’s writer, which is gone (0024), and nothing makes or reads its Secret', async () => {
    expect(Object.values(PASSWORDS).map((p) => p.role)).not.toContain('factory_writer');
    for (const { manifest } of await manifests<Job>()) {
      expect(JSON.stringify(manifest), manifest.metadata?.name).not.toMatch(/postgres-writer|WRITER_PASSWORD/);
    }
    const makefile = await readFile(join(DEPLOY, '../Makefile'), 'utf-8');
    expect(makefile).not.toMatch(/postgres-writer|factory_writer/);
  });

  it('come from a Secret of each worker’s own, optional so a cluster made before them still migrates', async () => {
    const env = await migrateJob();
    for (const worker of WORKERS) {
      expect(env.find((e) => e.name === PASSWORDS[worker].variable)?.valueFrom?.secretKeyRef).toEqual({
        name: `postgres-${worker}`,
        key: 'password',
        optional: true,
      });
    }
  });

  it('are made by `make worker-secrets`, which `make up` runs, one for each worker', async () => {
    const makefile = await readFile(join(DEPLOY, '../Makefile'), 'utf-8');
    expect(makefile).toMatch(/^STORE_WORKERS := (.+)$/m);
    expect(makefile.match(/^STORE_WORKERS := (.+)$/m)?.[1]?.split(' ')).toEqual([...WORKERS]);
    expect(makefile).toMatch(/^up:[^\n]*\n(?:\t[^\n]*\n)*\t@\$\(MAKE\) --no-print-directory worker-secrets$/m);
    expect(makefile).toMatch(/^worker-secrets: .*## /m);
    expect(makefile).toMatch(/create secret generic postgres-\$\$worker --from-file=password=\/dev\/stdin/);
  });
});

describe('each worker that uses the store', () => {
  it('connects as its own role, with the password from its own Secret', async () => {
    const deployments = (await manifests<Deployment>()).filter((m) => m.manifest.kind === 'Deployment');
    for (const worker of WORKERS) {
      const found = deployments.find((m) => m.manifest.metadata?.name === worker);
      const env = found?.manifest.spec?.template?.spec.containers[0]?.env ?? [];
      expect(env.find((e) => e.name === 'PGUSER')?.value, worker).toBe(PASSWORDS[worker].role);
      expect(env.find((e) => e.name === 'PGPASSWORD')?.valueFrom?.secretKeyRef, worker).toEqual({
        name: `postgres-${worker}`,
        key: 'password',
      });
    }
  });

  it('is the only Deployment that reads its Secret, and none names a connection string', async () => {
    const secrets = new Set(WORKERS.map((worker) => `postgres-${worker}`));
    for (const { manifest } of (await manifests<Deployment>()).filter((m) => m.manifest.kind === 'Deployment')) {
      const pod = manifest.spec?.template?.spec;
      for (const e of [...(pod?.containers ?? []), ...(pod?.initContainers ?? [])].flatMap((c) => c.env ?? [])) {
        // A connection string would win over PGUSER, and could name any role.
        expect(e.name, manifest.metadata?.name).not.toBe('DATABASE_URL');
        const secret = e.valueFrom?.secretKeyRef?.name;
        if (secret && secrets.has(secret)) expect(secret).toBe(`postgres-${manifest.metadata?.name}`);
      }
    }
  });
});

describe("Martin's own role", () => {
  it('is what the make targets that append his commands connect as, and no other target or pod', async () => {
    const makefile = await readFile(join(DEPLOY, '../Makefile'), 'utf-8');
    for (const target of ['samples', 'stop-the-line', 'start-the-line']) {
      const recipe = makefile.match(new RegExp(`^${target}:[^\\n]*\\n((?:\\t[^\\n]*\\n)+)`, 'm'))?.[1] ?? '';
      expect(recipe, target).toContain('$(call as-operator,');
    }
  });

  it('has its password from a Secret no pod reads, which the make targets make and set as the owner', async () => {
    const makefile = await readFile(join(DEPLOY, '../Makefile'), 'utf-8');
    expect(makefile).toMatch(/^as-martin = \$\(call secret,factory,postgres-\$\(1\),/m);
    expect(makefile).toMatch(/^as-operator = \$\(call as-martin,operator,\$\(1\)\)$/m);
    expect(makefile).toMatch(
      /secret postgres-\$\(1\) \| PGUSER=factory .*\n.*node packages\/store\/src\/operator\.ts factory_\$\(1\)/,
    );
    await expectNoPodReads('postgres-operator');
  });
});

describe('the enrolment’s role', () => {
  it('is what `make enrol` connects as, with its password from a Secret no pod reads', async () => {
    const makefile = await readFile(join(DEPLOY, '../Makefile'), 'utf-8');
    const recipe = makefile.match(/^enrol:[^\n]*\n((?:\t[^\n]*\n)+)/m)?.[1] ?? '';
    expect(recipe).toContain('$(call as-martin,enrol,node apps/factory/src/cli.ts admin enrol');
    await expectNoPodReads('postgres-enrol');
  });
});

describe('the admin service’s role', () => {
  it('has its password from a Secret `make up` makes, which the migrate Job sets', async () => {
    const makefile = await readFile(join(DEPLOY, '../Makefile'), 'utf-8');
    expect(makefile).toMatch(/^\t@\$\(call secret,factory,postgres-admin,/m);
    expect((await migrateJob()).find((e) => e.name === 'ADMIN_PASSWORD')?.valueFrom?.secretKeyRef).toEqual({
      name: 'postgres-admin',
      key: 'password',
      optional: true,
    });
  });
});

describe('the proofs’ role', () => {
  it('has its password from a Secret `make up` makes, which the migrate Job alone reads and sets', async () => {
    const makefile = await readFile(join(DEPLOY, '../Makefile'), 'utf-8');
    expect(makefile).toMatch(/^\t@\$\(call secret,factory,postgres-proofs,/m);
    expect((await migrateJob()).find((e) => e.name === 'PROOFS_PASSWORD')?.valueFrom?.secretKeyRef).toEqual({
      name: 'postgres-proofs',
      key: 'password',
      optional: true,
    });
    await expectNoPodReads('postgres-proofs', 'migrate');
  });
});

/** No Deployment's pod reads this Secret, nor any other workload's but the one named. */
async function expectNoPodReads(secret: string, except?: string) {
  for (const { manifest } of await manifests<Deployment>()) {
    if (except !== undefined && manifest.metadata?.name === except) continue;
    const pod = manifest.spec?.template?.spec;
    for (const e of [...(pod?.containers ?? []), ...(pod?.initContainers ?? [])].flatMap((c) => c.env ?? [])) {
      expect(e.valueFrom?.secretKeyRef?.name, manifest.metadata?.name).not.toBe(secret);
    }
  }
}
