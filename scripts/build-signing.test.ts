import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * The sign job's `sigstore` function in build.yml, as the job runs it, against a stand-in for cosign that answers each
 * call in turn, and a `sleep` that only notes how long it was asked to wait. The job checks out nothing, so the function
 * lives in the step itself, and is read from there.
 */
interface Step {
  run?: string;
}
const workflow = parse(readFileSync('.github/workflows/build.yml', 'utf-8')) as {
  jobs: Record<string, { steps: Step[] }>;
};
const step = workflow.jobs.sign?.steps.find((s) => s.run?.includes('sigstore() {'))?.run ?? '';
const FUNCTION = /^sigstore\(\) \{\n[\s\S]*?\n\}$/m.exec(step)?.[0] ?? '';

/** What Rekor answered on 2026-11-07, as cosign reported it. */
const REKOR_500 =
  'Error: signing ghcr.io/the-roganator/cv-worlds-worst-website@sha256:a4140dc2: creating bundle: signing bundle: error signing bundle: Post "https://rekor.sigstore.dev/api/v1/log/entries": giving up after 2 attempt(s): status 500: {"code":500,"message":"unexpected result from transparency log"}';

/** Runs `sigstore cosign sign` with cosign answering each call with the next of `answers`: an exit code and its output. */
async function sign(answers: [number, string][]) {
  const dir = await mkdtemp(join(tmpdir(), 'build-signing-'));
  await writeFile(join(dir, 'answers'), answers.map(([code, out]) => `${code}\t${out}\n`).join(''));
  await writeFile(join(dir, 'calls'), '');
  await writeFile(join(dir, 'waits'), '');
  await writeFile(
    join(dir, 'cosign'),
    `#!/usr/bin/env bash
echo "$*" >> "${dir}/calls"
n=$(wc -l < "${dir}/calls")
IFS=$'\\t' read -r code out < <(sed -n "\${n}p" "${dir}/answers")
echo "$out" >&2
exit "\${code:-0}"
`,
  );
  await writeFile(join(dir, 'sleep'), `#!/usr/bin/env bash\necho "$1" >> "${dir}/waits"\n`);
  await chmod(join(dir, 'cosign'), 0o755);
  await chmod(join(dir, 'sleep'), 0o755);
  const script = `set -euo pipefail\n${FUNCTION}\nsigstore cosign sign --yes ghcr.io/example@sha256:0\necho signed\n`;
  const result = await promisify(execFile)('bash', ['-c', script], {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
  }).then(
    ({ stdout, stderr }) => ({ code: 0, out: stdout + stderr }),
    (e: { code: number; stdout: string; stderr: string }) => ({ code: e.code, out: e.stdout + e.stderr }),
  );
  const lines = async (file: string) => (await readFile(join(dir, file), 'utf-8')).split('\n').filter(Boolean);
  return { ...result, calls: (await lines('calls')).length, waits: (await lines('waits')).map(Number) };
}

describe("the sign job's tries again at Sigstore (build.yml)", () => {
  it('is read from the step that signs', () => {
    expect(FUNCTION).toContain('sleep "$wait"');
  });

  it('runs every cosign command of the step through it', () => {
    const commands = step.split('\n').filter((line) => /\bcosign (attest|sign)\b/.test(line));
    expect(commands.length).toBe(2);
    for (const line of commands) expect(line.trim()).toMatch(/^sigstore cosign /);
  });

  it('signs once when cosign succeeds, and waits for nothing', async () => {
    expect(await sign([[0, 'Signing artifact...']])).toMatchObject({ code: 0, calls: 1, waits: [] });
  });

  it("tries again after Rekor's 500, waiting longer each time, and goes on once one passes", async () => {
    const result = await sign([
      [1, REKOR_500],
      [1, REKOR_500],
      [0, 'Signing artifact...'],
    ]);
    expect(result).toMatchObject({ code: 0, calls: 3, waits: [20, 60] });
    expect(result.out).toContain('signed');
    expect(result.out).toContain('trying again in 20s');
  });

  it('gives up after four tries, about three and a half minutes, and fails the step', async () => {
    const result = await sign(Array.from({ length: 6 }, () => [1, REKOR_500] as [number, string]));
    expect(result).toMatchObject({ code: 1, calls: 4, waits: [20, 60, 120] });
    expect(result.out).toContain('still failed after four tries');
    expect(result.out).not.toContain('signed\n');
  });

  it.each([
    [
      'Fulcio unavailable',
      'getting signer: retrieving cert: POST https://fulcio.sigstore.dev/api/v2/signingCert: status 503',
    ],
    ['GHCR unavailable', 'PUT https://ghcr.io/v2/x/manifests/sha256-0: unexpected status code 503 Service Unavailable'],
    ['rate-limited', 'GET https://ghcr.io/token: unexpected status code 429 Too Many Requests'],
    ['a connection reset', 'Post "https://rekor.sigstore.dev/api/v1/log/entries": read: connection reset by peer'],
    ['a timeout', 'Post "https://fulcio.sigstore.dev/api/v2/signingCert": net/http: TLS handshake timeout'],
  ])('tries again on %s', async (_, out) => {
    expect(
      await sign([
        [1, out],
        [0, ''],
      ]),
    ).toMatchObject({ code: 0, calls: 2, waits: [20] });
  });

  it.each([
    ['an identity Fulcio refuses', 'retrieving cert: POST https://fulcio.sigstore.dev/api/v2/signingCert: status 403'],
    ['a token it cannot get', 'getting signer: no ACTIONS_ID_TOKEN_REQUEST_URL: is id-token: write set?'],
    ['GHCR refusing the push', 'PUT https://ghcr.io/v2/x/manifests/sha256-0: unexpected status code 401 Unauthorized'],
    ['a status that only starts with 5', 'status 5000'],
  ])('fails at once on %s, with no wait', async (_, out) => {
    const result = await sign([
      [1, out],
      [0, ''],
    ]);
    expect(result).toMatchObject({ code: 1, calls: 1, waits: [] });
    expect(result.out).toContain('a try again would not pass');
  });
});
