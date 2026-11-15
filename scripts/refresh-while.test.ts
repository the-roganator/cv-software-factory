import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/*
 * `make up`'s waits for Argo CD, run by scripts/refresh-while.sh, which asks Argo CD to refresh each Application still
 * Progressing while they run: here against a kubectl that names the Progressing Applications it is asked for, and
 * writes down each annotation it is asked to make.
 */

const SCRIPT = resolve('scripts/refresh-while.sh');
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function run(command: string[], progressing: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'refresh-while-'));
  dirs.push(dir);
  const kubectl = join(dir, 'kubectl');
  writeFileSync(
    kubectl,
    `#!/usr/bin/env bash
case "$*" in
  *"get applications"*'status.health.status=="Progressing"'*) printf '%b' ${JSON.stringify(progressing.map((a) => `${a}\n`).join(''))} ;;
  *annotate*) echo "$*" >> "${dir}/annotated" ;;
  *) exit 1 ;;
esac
`,
  );
  chmodSync(kubectl, 0o755);
  const result = spawnSync(SCRIPT, command, {
    encoding: 'utf-8',
    env: { ...process.env, KUBECTL: `${kubectl} --context test`, INTERVAL: '0.2' },
  });
  let annotated: string[] = [];
  try {
    annotated = readFileSync(join(dir, 'annotated'), 'utf-8').trim().split('\n');
  } catch {}
  return { ...result, annotated };
}

describe('refresh-while.sh', () => {
  it('refreshes each Progressing Application while the waits run, and exits as they do', () => {
    const { status, stdout, annotated } = run(
      ['sh', '-c', 'sleep 1; echo waited; exit 3'],
      ['kyverno', 'argo-rollouts'],
    );
    expect(status).toBe(3);
    expect(stdout).toBe('waited\n');
    expect(annotated.length).toBeGreaterThanOrEqual(4);
    expect(new Set(annotated)).toEqual(
      new Set(
        ['kyverno', 'argo-rollouts'].map(
          (app) =>
            `--context test -n argocd annotate application ${app} --overwrite --request-timeout=10s argocd.argoproj.io/refresh=normal`,
        ),
      ),
    );
  });

  it('refreshes nothing when nothing is Progressing, or when the waits end first', () => {
    expect(run(['sh', '-c', 'sleep 0.6'], []).annotated).toEqual([]);
    const quick = run(['true'], ['kyverno']);
    expect(quick.status).toBe(0);
    expect(quick.annotated).toEqual([]);
  });
});
