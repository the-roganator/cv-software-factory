import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

/**
 * The Makefile makes each password the cluster keeps (the store's roles, Grafana's admin) once, and never again while
 * the Secret holds one. So a password it stored empty would be kept by every later run, and the role it is for could
 * not log in until someone deleted the Secret by hand. It stores one only once it has it, through stdin, never on a
 * command line, and makes again a Secret that holds an empty one.
 */

type Cluster = 'holds one' | 'holds an empty one' | 'has none' | 'cannot be read';

/** The Makefile's `password` helper, run by make itself against a kubectl that logs each call and an openssl stub. */
async function password(cluster: Cluster, { openssl = 'works', call = 'factory,postgres-console' } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'password-'));
  const log = join(dir, 'calls');
  const stdin = join(dir, 'stdin');
  const held = { 'holds one': 'c2VjcmV0', 'holds an empty one': '', 'has none': '', 'cannot be read': '' }[cluster];
  const kubectl = join(dir, 'kubectl');
  await writeFile(
    kubectl,
    `#!/usr/bin/env bash
echo "$*" >> ${JSON.stringify(log)}
case "$1 $2 $3 $4" in
  "get namespace"*) echo namespace/factory ;;
  *"get secret"*) ${cluster === 'cannot be read' ? 'echo "Unable to connect to the server" >&2; exit 1' : `printf %s '${held}'`} ;;
  *"create secret"*) cat > ${JSON.stringify(stdin)} ;;
esac
`,
  );
  await writeFile(
    join(dir, 'openssl'),
    `#!/usr/bin/env bash\n${{ works: 'echo 0123456789abcdef0123456789abcdef0123456789abcdef', fails: 'exit 1', 'says nothing': 'exit 0' }[openssl]}\n`,
  );
  await chmod(kubectl, 0o755);
  await chmod(join(dir, 'openssl'), 0o755);
  const makefile = join(dir, 'Makefile');
  await writeFile(makefile, `include ${join(process.cwd(), 'Makefile')}\npw:\n\t@$(call password,${call})\n`);
  // Not the outer make's flags (`make check` runs the tests), which would have this one talk about directories and jobs.
  const { MAKEFLAGS, MFLAGS, MAKELEVEL, ...env } = process.env;
  try {
    const result = await promisify(execFile)('make', ['-s', '-f', makefile, `KUBECTL=${kubectl}`, 'pw'], {
      env: { ...env, PATH: `${dir}:${env.PATH}` },
    }).then(
      ({ stdout, stderr }) => ({ code: 0, out: stdout + stderr }),
      (e: { code: number | string; stdout?: string; stderr?: string }) => {
        if (typeof e.code === 'string') throw e; // make itself did not run
        return { code: e.code, out: `${e.stdout}${e.stderr}` };
      },
    );
    const calls = (await readFile(log, 'utf-8')).trim().split('\n');
    const stored = await readFile(stdin, 'utf-8').catch(() => undefined);
    return { ...result, calls, stored };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const read = 'get secret postgres-console -o jsonpath={.data.password} --ignore-not-found';
const made = [
  'get namespace factory -o name --ignore-not-found',
  `-n factory ${read}`,
  '-n factory delete secret postgres-console --ignore-not-found',
  '-n factory create secret generic postgres-console --from-file=password=/dev/stdin',
];

describe('making a password from the Makefile', () => {
  it('leaves a Secret that holds one alone', async () => {
    expect(await password('holds one')).toEqual({
      code: 0,
      out: '',
      calls: made.slice(0, 2),
      stored: undefined,
    });
  });

  it.each(['has none', 'holds an empty one'] as const)(
    'makes one when the cluster %s, through stdin',
    async (cluster) => {
      expect(await password(cluster)).toEqual({
        code: 0,
        out: '',
        calls: made,
        stored: '0123456789abcdef0123456789abcdef0123456789abcdef',
      });
    },
  );

  it.each(['fails', 'says nothing'] as const)('stores nothing, and fails, when openssl %s', async (openssl) => {
    const result = await password('has none', { openssl });
    expect(result.code).not.toBe(0);
    expect(result.calls).toEqual(made.slice(0, 2));
    expect(result.stored).toBeUndefined();
  });

  it('stops when the Secret cannot be read, and stores nothing', async () => {
    const result = await password('cannot be read');
    expect(result.code).not.toBe(0);
    expect(result.out).toContain('Unable to connect to the server');
    expect(result.calls).toEqual(made.slice(0, 2));
  });

  it('keeps the password under the key named, beside any more data', async () => {
    const result = await password('has none', {
      call: 'factory,grafana-admin,admin-password,--from-literal=admin-user=admin',
    });
    expect(result.calls.slice(1)).toEqual([
      '-n factory get secret grafana-admin -o jsonpath={.data.admin-password} --ignore-not-found',
      '-n factory delete secret grafana-admin --ignore-not-found',
      '-n factory create secret generic grafana-admin --from-file=admin-password=/dev/stdin --from-literal=admin-user=admin',
    ]);
    expect(result.stored).toBe('0123456789abcdef0123456789abcdef0123456789abcdef');
  });
});
