/**
 * Git, run as a child process in the job's checkout. Only the runner's pods run git in it, and with no settings but
 * their own: not the system's, and not a global file from a home the agent could write. No hook runs, whatever a
 * checkout's own config says, since an agent shares the volume a checkout may be on.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export async function git(cwd: string, ...args: string[]): Promise<string> {
  return gitWith({}, cwd, ...args);
}

const options = (cwd: string, env: Record<string, string>) => ({
  cwd,
  maxBuffer: 64 * 1024 * 1024,
  env: {
    ...process.env,
    ...env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    // Given on the command line's level, over any file's.
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.hooksPath',
    GIT_CONFIG_VALUE_0: '/dev/null',
  },
});

/** Git with some variables of its own, such as a commit's dates. */
export async function gitWith(env: Record<string, string>, cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, options(cwd, env));
  return stdout;
}

/** Git with `input` on its standard input, such as a patch for `git apply`: nothing is written to a file first. */
export function gitInput(input: string, cwd: string, ...args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile('git', args, options(cwd, {}), (error, stdout) => (error ? reject(error) : resolve(stdout)));
    child.stdin?.end(input);
  });
}
