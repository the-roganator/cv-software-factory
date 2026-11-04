/**
 * The egress attack's probe (attack 4): the pinned program its pod runs in place of the agent, apart from the rules
 * in `attacks.ts` because it is text a pod runs, not code anything here runs. Its own import of the agent step's
 * fence wait would read, to a walk of the code that decides a merge, as an import at run time.
 */
import { EGRESS_CONTROL, EGRESS_TARGETS } from './attacks.ts';

/** The runner image's agent step, whose fence wait the egress probe makes: the image copies the runner to `/repo`. */
export const RUNNER_AGENT_MODULE = '/repo/apps/runner/src/agent.ts';

/** What the egress probe calls the line it prints about its fence wait. */
export const EGRESS_FENCE_LINE = 'the fence';

/**
 * The egress pod's probe, run in place of the agent with `node -e`: it tries each target and the control, and prints
 * one JSON line each, so the harness reads the pod's log and records what the egress policy refused, and that the
 * control was reached, from the pod's own words and never by timing. Any answer at all is a reach, a redirect too,
 * which it does not follow: an address can answer with one to a name the pod cannot resolve, and following it would
 * read a reach as a refused name. It first waits for the pod's fence with the agent step's own wait, so the attack meets
 * what an agent's code meets: a pod starts before its enforcer fences it, and the agent step runs nothing until then.
 * Pinned, so the harness cannot run anything else on a runner image: the admission rule holds the pod's `command`, `args` and `env` to exactly these
 * (`deploy/base/admission/factory/red-team-pods.yaml`, kept in step by `apps/factory/test/red-team-fences.test.ts`).
 */
export const EGRESS_PROBE = [
  // As the agent step does before it runs anything (awaitFence): wait for the pod's fence, say how the wait ended,
  // then try the outside, fenced or not, so a pod its policy never fenced reports what it reached. A wait it cannot
  // make (the module gone) ends the pod with nothing said, which the harness records unfinished.
  `const { awaitFence } = await import(${JSON.stringify(RUNNER_AGENT_MODULE)});`,
  `const fence = await awaitFence(${JSON.stringify(new URL(EGRESS_CONTROL.url).origin)}).then(() => "up", (e) => "not up: " + String((e && e.message) || e));`,
  `console.log(JSON.stringify({ what: ${JSON.stringify(EGRESS_FENCE_LINE)}, result: fence }));`,
  `const targets = ${JSON.stringify(EGRESS_TARGETS)}; const control = ${JSON.stringify(EGRESS_CONTROL)};`,
  'const BLOCKED = ["ECONNREFUSED","ECONNRESET","EHOSTUNREACH","ENETUNREACH","UND_ERR_CONNECT_TIMEOUT","TimeoutError"];',
  'const attempt = async (url) => { try { await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(3000) }); return "reached"; }',
  '  catch (e) { const code = (e && e.cause && e.cause.code) || (e && e.name);',
  '    if (BLOCKED.includes(code)) return "blocked"; if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "no-name";',
  '    return "unclear"; } };',
  'for (const t of targets) { const r = await attempt(t.url);',
  '  console.log(JSON.stringify({ what: t.what, result: r, refused: r === "blocked" || (t.byName && r === "no-name") })); }',
  'const c = await attempt(control.url);',
  'console.log(JSON.stringify({ what: control.what, result: c, reached: c === "reached" }));',
].join('\n');

/** The pinned command and args of the egress pod: `node -e <the probe>`, which the admission rule holds it to. */
export const EGRESS_COMMAND = ['node'] as const;
export const EGRESS_ARGS = ['-e', EGRESS_PROBE] as const;
