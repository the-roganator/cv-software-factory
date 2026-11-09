#!/usr/bin/env node
/**
 * What a runner's pods run: `runner prepare` in the prepare pod, `runner agent` in the agent pod. Settings come from
 * the environment the job gives them (`step.ts`). Each prints JSON lines (`log.ts`), and a step that fails says why
 * in its last one before the pod ends in failure.
 */
import { handBack, runAgent } from './agent.ts';
import { errorText, runnerLog } from './log.ts';
import { prepare } from './prepare.ts';

const [command] = process.argv.slice(2);
if (command === 'prepare' || command === 'agent') {
  const log = runnerLog(process.env, command);
  try {
    if (command === 'prepare') {
      await prepare();
    } else {
      const handback = await runAgent();
      log(`the agent ${handback.ending}`, {
        ending: handback.ending,
        turns: handback.turns,
        patch: handback.patch.length,
        ...(handback.error ? { error: handback.error } : {}),
      });
      await handBack(process.env, handback);
      log('handed back');
    }
  } catch (error) {
    log(`the ${command} step failed`, { level: 'error', error: errorText(error) });
    process.exitCode = 1;
  }
  // Nothing is left to wait on once the step is done: a handle a tool's child held open must not keep the pod up. Its
  // lines are written out first, since stdout and stderr may be pipes written asynchronously.
  await Promise.all([process.stdout, process.stderr].map((out) => new Promise((resolve) => out.write('', resolve))));
  process.exit();
} else {
  console.log('Usage:\n  runner prepare\n  runner agent');
  process.exitCode = 2;
}
