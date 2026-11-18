import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { problems } from './commit-msg.ts';

const SCRIPT = fileURLToPath(new URL('./commit-msg.ts', import.meta.url));

/** #360's title, 117 characters. */
const LONG =
  'chore(deps): Bump nginxinc/nginx-unprivileged from 1.30.5-alpine-slim to 1.31.6-alpine-slim in /deploy/base/telemetry';

/** The script as pull-request.yml's title job runs it, with its exit status. */
const run = (args: string[]) =>
  promisify(execFile)(process.execPath, [SCRIPT, ...args]).then(
    ({ stderr }) => ({ code: 0, err: stderr }),
    (e: { code: number; stderr: string }) => ({ code: e.code, err: e.stderr }),
  );

describe('commit messages', () => {
  it.each([
    'feat: add the scoreboard',
    'fix(console): keep the clock in step',
    'feat(gateway)!: replay cassettes by default',
    'chore(deps): bump vitest from 5.0.2 to 5.0.3',
    'docs: explain the promotion pull request\n\nWith a body that can be as long as it likes, and Ends with a full stop.',
  ])('accepts %j', (message) => {
    expect(problems(message)).toEqual([]);
  });

  it.each(['Merge branch main', 'Revert "feat: add the scoreboard"', 'fixup! feat: add the scoreboard'])(
    'leaves messages git writes itself alone: %j',
    (message) => {
      expect(problems(message)).toEqual([]);
    },
  );

  it('ignores comment lines git adds to the message file', () => {
    expect(problems('# Please enter the commit message\nfix: close the popover')).toEqual([]);
  });

  it('rejects a message with no type', () => {
    expect(problems('Update the README')).toEqual([
      '"Update the README" should look like "type(scope): subject", for example "fix(console): keep the clock in step"',
    ]);
  });

  it('names the types when one is unknown', () => {
    expect(problems('feature: add the scoreboard')[0]).toMatch(
      /^"feature" is not a type we use; choose one of feat, fix/,
    );
  });

  it('asks for the full stop to be left off the subject', () => {
    expect(problems('fix: close the popover.')).toEqual(['leave the full stop off the subject']);
  });

  it("accepts Dependabot's capitalised subjects", () => {
    expect(problems('chore(deps): Bump pino from 10.3.1 to 10.4.0')).toEqual([]);
  });

  it('limits the first line to 100 characters', () => {
    const long = `fix: ${'a'.repeat(96)}`;
    expect(problems(long)).toEqual(['keep the first line to 100 characters (it is 101)']);
  });

  it("lets Dependabot's titles run long, and checks the rest of them", () => {
    expect(problems(LONG, { anyLength: true })).toEqual([]);
    expect(problems(`${LONG}.`, { anyLength: true })).toEqual(['leave the full stop off the subject']);
  });
});

describe('the title check, as pull-request.yml runs it', () => {
  it('fails a long title', async () => {
    const { code, err } = await run(['--title', LONG]);
    expect(code).toBe(1);
    expect(err).toContain('keep the first line to 100 characters (it is 117)');
  });

  it.each([
    ['after the title', ['--title', LONG, '--any-length']],
    ['before it', ['--any-length', '--title', LONG]],
  ])('passes it with --any-length %s', async (_, args) => {
    expect(await run(args)).toEqual({ code: 0, err: '' });
  });

  it('still checks every other rule with --any-length', async () => {
    const { code, err } = await run(['--title', `${LONG}.`, '--any-length']);
    expect(code).toBe(1);
    expect(err).toContain('leave the full stop off the subject');
  });
});
