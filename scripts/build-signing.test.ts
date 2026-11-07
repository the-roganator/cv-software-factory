import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * The `retry` function that build.yml's sign job and check.yml's signature check run each call to Sigstore and GHCR
 * through. The sign job checks out nothing, so the function lives in each step, and is read from there. It runs here in
 * bash as the steps call it, with errexit on, with a stand-in for cosign that fails a given number of times and a
 * `sleep` that notes how long it would wait.
 */
interface Step {
  name?: string;
  run?: string;
}
const steps = (file: string, job: string) =>
  (parse(readFileSync(`.github/workflows/${file}`, 'utf-8')) as { jobs: Record<string, { steps: Step[] }> }).jobs[job]
    ?.steps ?? [];
const sign = steps('build.yml', 'sign').find((s) => s.run?.includes('cosign sign'))?.run ?? '';
const verify =
  steps('check.yml', 'image').find((s) => s.name === 'Check the images it moves to were signed by build.yml on main')
    ?.run ?? '';
const retry = (script: string) => /^retry\(\) \{\n[\s\S]*?\n\}$/m.exec(script)?.[0] ?? '';

function run(failures: number) {
  const bash = `set -euo pipefail
${retry(sign)}
sleep() { echo "slept $1"; }
calls=0
cosign() { calls=$((calls + 1)); echo "cosign $* ($calls)"; [ "$calls" -gt ${failures} ]; }
retry cosign sign --yes ref
echo ok`;
  const result = spawnSync('bash', ['-c', bash], { encoding: 'utf-8' });
  return {
    out: result.stdout.trim().split('\n'),
    err: result.stderr.trim().split('\n').filter(Boolean),
    gaveUp: result.status !== 0,
  };
}

/** Every line of a script that runs cosign or Syft, whatever its subcommand. */
const calls = (script: string) =>
  script
    .split('\n')
    .map((line) => line.trim())
    .filter(
      (line) =>
        !line.startsWith('#') && !line.startsWith('echo') && /(?:^|[\s"(])(?:cosign\b|\$SYFT\b|\$\{SYFT\})/.test(line),
    );

describe('trying Sigstore and GHCR again (build.yml, check.yml)', () => {
  it('is found, whole, and the same in both', () => {
    expect(retry(sign)).toContain('sleep $((15 << (try - 1)))');
    expect(retry(verify)).toBe(retry(sign));
  });

  it('calls cosign once when it works', () => {
    expect(run(0)).toEqual({ out: ['cosign sign --yes ref (1)', 'ok'], err: [], gaveUp: false });
  });

  it('tries again, waiting longer each time, while a call fails', () => {
    expect(run(3)).toEqual({
      out: [
        'cosign sign --yes ref (1)',
        'slept 15',
        'cosign sign --yes ref (2)',
        'slept 30',
        'cosign sign --yes ref (3)',
        'slept 60',
        'cosign sign --yes ref (4)',
        'ok',
      ],
      // On stderr, so a note is seen where the call's own output is sent nowhere, as check.yml sends it.
      err: [
        '::warning::cosign sign failed (try 1 of 4); trying again in 15s',
        '::warning::cosign sign failed (try 2 of 4); trying again in 30s',
        '::warning::cosign sign failed (try 3 of 4); trying again in 60s',
      ],
      gaveUp: false,
    });
  });

  it('fails the step after four tries, without waiting again', () => {
    const { out, err, gaveUp } = run(4);
    expect(out.filter((line) => line.startsWith('cosign '))).toHaveLength(4);
    expect(out.at(-1)).toBe('cosign sign --yes ref (4)');
    expect(err.at(-1)).toBe('::error::cosign sign failed four times');
    expect(gaveUp).toBe(true);
  });

  it('names a command called by its path by its last part', () => {
    const result = spawnSync('bash', ['-c', `${retry(sign)}\nsleep() { :; }\nretry /bin/false scan x || true`], {
      encoding: 'utf-8',
    });
    expect(result.stderr).toContain('::error::false scan failed four times');
  });

  it('signs through it: both scans, both attestations and the signature, last, each cosign try with a time limit', () => {
    expect(calls(sign).map((call) => call.split(' ').slice(0, 3).join(' '))).toEqual([
      'retry "$SYFT" scan',
      'retry cosign attest',
      'retry cosign sign',
    ]);
    for (const call of calls(sign).filter((c) => c.includes('cosign'))) expect(call).toContain('--timeout 1m');
  });

  it("checks a deploy pull request's signatures and SBOMs through it, each try with a time limit", () => {
    const checks = calls(verify);
    expect(
      checks.map((call) =>
        call
          .replace(/^if ! /, '')
          .split(' ')
          .slice(0, 3)
          .join(' '),
      ),
    ).toEqual(['retry cosign verify', 'retry cosign verify-attestation']);
    for (const call of checks) expect(call).toContain('--timeout 1m');
  });
});
