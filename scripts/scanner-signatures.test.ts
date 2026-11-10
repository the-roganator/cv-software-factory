import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * check.yml's check of the scanners' pins (issue #978): a change to a scanner's pin passes only when the image it moves
 * to is signed by its publisher's release workflow, named whole. The step runs here as the runner runs it, in bash with
 * errexit and pipefail, in a repository of two commits, the base and the change, with a stand-in for cosign that
 * verifies only what a table says was signed, by whom, and notes each call.
 */
const STEP = "Check the scanners it moves to were signed by their publishers' release workflows";
const step =
  (
    parse(readFileSync('.github/workflows/check.yml', 'utf-8')) as {
      jobs: Record<string, { steps: { name?: string; run?: string }[] }>;
    }
  ).jobs.image?.steps.find((s) => s.name === STEP)?.run ?? '';

const ISSUER = 'https://token.actions.githubusercontent.com';
const TRIVY = 'ghcr.io/aquasecurity/trivy';
const SYFT = 'ghcr.io/anchore/syft';
const release = (version: string) =>
  `https://github.com/aquasecurity/trivy/.github/workflows/reusable-release.yaml@refs/tags/v${version}`;
const digest = (c: string) => `sha256:${c.repeat(64)}`;

/** The stand-in: passes when the reference was signed by the identity and issuer it is asked for, exactly. */
const COSIGN = `#!/usr/bin/env bash
echo "$*" >> "$CALLS"
[ "$1" = verify ] || exit 2
identity="" issuer="" ref="\${@: -1}"
while [ $# -gt 0 ]; do
  case "$1" in
    --certificate-identity) identity=$2; shift ;;
    --certificate-oidc-issuer) issuer=$2; shift ;;
    --certificate-identity-regexp|--certificate-oidc-issuer-regexp) exit 3 ;;
  esac
  shift
done
grep -qxF "$ref $identity $issuer" "$SIGNED" || { echo "no matching signatures" >&2; exit 1; }
`;

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

/**
 * Runs the step on a change from `base` to `head` (each a map of path to content, null to leave a file out), with the
 * signatures `signed` lists as `<ref> <identity> <issuer>`, and `also`, a command run in the repository before the
 * change is committed.
 */
function check(
  base: Record<string, string>,
  head: Record<string, string | null>,
  signed: string[] = [],
  also?: () => string[],
) {
  const dir = mkdtempSync(join(tmpdir(), 'scanner-signatures-'));
  dirs.push(dir);
  const repo = join(dir, 'repo');
  const bin = join(dir, 'bin');
  mkdirSync(repo);
  mkdirSync(bin);
  writeFileSync(join(bin, 'cosign'), COSIGN);
  writeFileSync(join(bin, 'sleep'), '#!/usr/bin/env bash\n');
  chmodSync(join(bin, 'cosign'), 0o755);
  chmodSync(join(bin, 'sleep'), 0o755);
  writeFileSync(join(dir, 'signed'), signed.map((line) => `${line}\n`).join(''));
  writeFileSync(join(dir, 'calls'), '');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  git('config', 'commit.gpgsign', 'false');
  const write = (files: Record<string, string | null>, before?: () => string[]) => {
    for (const [path, content] of Object.entries(files)) {
      if (content === null) rmSync(join(repo, path), { force: true });
      else {
        mkdirSync(dirname(join(repo, path)), { recursive: true });
        writeFileSync(join(repo, path), content);
      }
    }
    const command = before?.();
    if (command) execFileSync(command[0] ?? 'false', command.slice(1), { cwd: repo });
    git('add', '-A');
    git('commit', '-q', '--allow-empty', '-m', 'commit');
  };
  write({ '.github/workflows/check.yml': 'base\n', ...base });
  write(head, also);
  const result = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', step], {
    cwd: repo,
    encoding: 'utf-8',
    env: { PATH: `${bin}:${process.env.PATH}`, CALLS: join(dir, 'calls'), SIGNED: join(dir, 'signed') },
  });
  const calls = readFileSync(join(dir, 'calls'), 'utf-8').split('\n').filter(Boolean);
  return { status: result.status, out: result.stdout, err: result.stderr, calls };
}

const trivyPin = (version: string, d: string) => `# Trivy\nFROM ${TRIVY}:${version}@${d}\n`;
const syftPin = (version: string, d: string) => `# Syft\nFROM ${SYFT}:${version}@${d}\n`;
const TRIVY_FILE = 'deploy/images/trivy/Dockerfile';
const SYFT_FILE = 'deploy/images/syft/Dockerfile';
const BASE = { [TRIVY_FILE]: trivyPin('0.74.0', digest('a')), [SYFT_FILE]: syftPin('v1.54.0', digest('b')) };

describe("the scanners' signatures (check.yml)", () => {
  it('is found', () => {
    expect(step).toContain('cosign verify');
  });

  it("passes a Trivy bump signed by Aqua's release workflow on the tag of the version it pins", () => {
    const ref = `${TRIVY}@${digest('c')}`;
    const result = check(BASE, { [TRIVY_FILE]: trivyPin('0.76.2', digest('c')) }, [
      `${ref} ${release('0.76.2')} ${ISSUER}`,
    ]);
    expect(result.status, result.err).toBe(0);
    expect(result.calls).toEqual([
      `verify --timeout 1m --certificate-identity ${release('0.76.2')} --certificate-oidc-issuer ${ISSUER} ${ref}`,
    ]);
    expect(result.out).toContain(`${TRIVY_FILE}: ${ref}, signed by ${release('0.76.2')}`);
  });

  it('fails a digest signed by any other identity: another tag, a canary, a fork, or another issuer', () => {
    const ref = `${TRIVY}@${digest('c')}`;
    for (const other of [
      `${ref} ${release('0.76.1')} ${ISSUER}`,
      `${ref} https://github.com/aquasecurity/trivy/.github/workflows/reusable-release.yaml@refs/heads/main ${ISSUER}`,
      `${ref} https://github.com/someone/trivy/.github/workflows/reusable-release.yaml@refs/tags/v0.76.2 ${ISSUER}`,
      `${ref} ${release('0.76.2')} https://accounts.google.com`,
    ]) {
      const result = check(BASE, { [TRIVY_FILE]: trivyPin('0.76.2', digest('c')) }, [other]);
      expect(result.status, other).toBe(1);
      expect(result.out).toContain(`::error file=${TRIVY_FILE}::${ref} is not signed by ${release('0.76.2')}`);
      // Every try failed, and none passed on a looser match.
      expect(result.calls).toHaveLength(4);
    }
  });

  it("checks a pin under .github/images/ too, where Trivy's was before it moved", () => {
    const file = '.github/images/trivy/Dockerfile';
    const ref = `${TRIVY}@${digest('c')}`;
    const signed = [`${ref} ${release('0.76.2')} ${ISSUER}`];
    const moved = check(
      { [file]: trivyPin('0.74.0', digest('a')) },
      { [file]: trivyPin('0.76.2', digest('c')) },
      signed,
    );
    expect(moved.status, moved.err).toBe(0);
    expect(moved.out).toContain(`${file}: ${ref}, signed by ${release('0.76.2')}`);
    const unsigned = check({ [file]: trivyPin('0.74.0', digest('a')) }, { [file]: trivyPin('0.76.2', digest('c')) });
    expect(unsigned.status).toBe(1);
  });

  it('fails a pin that is a link, which could point it at a file the check does not watch', () => {
    const result = check({ 'elsewhere/Dockerfile': trivyPin('0.76.2', digest('c')) }, {}, [], () => [
      'sh',
      '-c',
      `mkdir -p ${dirname(TRIVY_FILE)} && ln -s ../../../elsewhere/Dockerfile ${TRIVY_FILE}`,
    ]);
    expect(result.status).toBe(1);
    expect(result.out).toContain('must be a regular file (mode 120000)');
    expect(result.calls).toEqual([]);
  });

  it('fails an unsigned digest', () => {
    const result = check(BASE, { [TRIVY_FILE]: trivyPin('0.76.2', digest('c')) });
    expect(result.status).toBe(1);
    expect(result.out).toContain('is not signed by');
  });

  it('names the signer whole: never a pattern', () => {
    expect(step).not.toMatch(/regexp/);
    expect(step).toContain(
      'identity="https://github.com/aquasecurity/trivy/.github/workflows/reusable-release.yaml@refs/tags/v$version"',
    );
    expect(step).toContain('issuer=https://token.actions.githubusercontent.com');
  });

  it("passes Syft's pin on its digest alone, saying so, since Anchore signs no image of it", () => {
    const result = check(BASE, { [SYFT_FILE]: syftPin('v1.55.0', digest('d')) });
    expect(result.status, result.err).toBe(0);
    expect(result.calls).toEqual([]);
    expect(result.out).toContain(`::notice file=${SYFT_FILE}::${SYFT}@${digest('d')}: Anchore signs no image of Syft`);
  });

  it('fails a pin of an image it names no signer for, in either place a pin may live', () => {
    for (const file of ['deploy/images/grype/Dockerfile', '.github/images/grype/Dockerfile']) {
      const result = check(BASE, { [file]: `FROM ghcr.io/anchore/grype:v0.90.0@${digest('e')}\n` });
      expect(result.status, file).toBe(1);
      expect(result.out).toContain('ghcr.io/anchore/grype has no publisher');
    }
  });

  it('fails a pin that is not one FROM with a version and a digest', () => {
    for (const pin of [
      `FROM ${TRIVY}:0.76.2\n`,
      `FROM ${TRIVY}@${digest('c')}\n`,
      `FROM ${TRIVY}:0.76.2@${digest('c')} AS scanner\n`,
      `FROM ${TRIVY}:0.76.2@${digest('c')}\nFROM ${TRIVY}:0.76.1@${digest('a')}\n`,
      '# no image\n',
    ]) {
      const result = check(BASE, { [TRIVY_FILE]: pin });
      expect(result.status, pin).toBe(1);
      expect(result.out, pin).toContain('must pin one image');
      expect(result.calls).toEqual([]);
    }
    // Aqua tags v<major>.<minor>.<patch>, so a pin's version is that, without its `v`.
    const tagged = check(BASE, { [TRIVY_FILE]: trivyPin('v0.76.2', digest('c')) });
    expect(tagged.status).toBe(1);
    expect(tagged.out).toContain('version must be <major>.<minor>.<patch>');
  });

  it('checks nothing when no pin changes, and nothing of a pin file removed', () => {
    const none = check(BASE, { 'README.md': 'words\n' });
    expect(none.status).toBe(0);
    expect(none.calls).toEqual([]);
    expect(none.out).toContain("No scanner's pin changes");
    const removed = check(BASE, { [TRIVY_FILE]: null });
    expect(removed.status).toBe(0);
    expect(removed.calls).toEqual([]);
  });

  it('checks every pin when check.yml changes, so a change to the check proves itself', () => {
    const ref = `${TRIVY}@${digest('a')}`;
    const result = check(BASE, { '.github/workflows/check.yml': 'changed\n' }, [
      `${ref} ${release('0.74.0')} ${ISSUER}`,
    ]);
    expect(result.status, result.err).toBe(0);
    expect(result.calls).toHaveLength(1);
    expect(result.out).toContain(`${ref}, signed by`);
    expect(result.out).toContain('Anchore signs no image of Syft');
  });
});
