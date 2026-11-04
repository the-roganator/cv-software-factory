/**
 * Attacks 4 (`egress`) and 5 (`image`): a pod the harness makes in `runners`, where an agent's pod runs. RBAC lets
 * the harness create a pod but cannot say what the pod holds, so the red-team admission rule
 * (deploy/base/admission/factory/red-team-pods.yaml) holds a marked pod to the agent's runner label plus the marker,
 * one of two images, pinned command, args and env, and no volumes, secrets or service-account token: a compromised
 * harness can make these two pods and nothing else. The agent NetworkPolicy fences the pod to the gateway and the
 * handback and nothing else, as it fences an agent.
 *
 * - **`egress`:** the pod runs a connectivity probe in place of the agent (the pinned `node -e` in policy/attacks.ts).
 *   It tries an outside address by name and by number and the model provider's host, each of which a runner's egress
 *   policy refuses, and the gateway as the control, which it may reach. The harness reads the pod's own record of each
 *   from its log and appends an `egress-policy` refusal for each one refused (guardrail 5), which its role alone may.
 *   A control that is not reached means the pod reached nothing for some other reason, so the attack is unfinished,
 *   not refused.
 * - **`image`:** the pod asks for the one image `build.yml` did not sign, which admission control refuses as it is
 *   created. The harness does not record that refusal: the line reads admission's denials from the cluster's Events
 *   (deviation 7) and appends `admission-control` about the pod, which the harness waits for, matched by the pod's
 *   name and uid. If the image is admitted (as under `try-the-line`, with `factory-images` in audit), nothing refused
 *   it and the attack is not refused.
 */

import { lookup } from 'node:dns/promises';
import { cutTo, type NewEvent, VERSIONS } from '@software-factory/events';
import type { EventWriter } from '@software-factory/store';
import { z } from 'zod';
import {
  EGRESS_ARGS,
  EGRESS_COMMAND,
  EGRESS_TARGETS,
  IMAGE_ARGS,
  IMAGE_COMMAND,
  RED_TEAM_DNS,
  RED_TEAM_HOST_ALIAS,
  redTeamPodLabels,
} from '../../../../policy/attacks.ts';
import { guardrailsFor } from '../../../../policy/refusals.ts';
import { DENIED, IMAGE_WEBHOOK } from '../line/refusals.ts';
import type { Kube } from '../runners/kube.ts';
import { KubeError } from '../runners/kube.ts';
import { waitFor } from './wait.ts';
import type { Attempt, AttemptContext, AttemptResult } from './worker.ts';

export const RUNNERS = 'runners';

/** How long a pod is given to run its probe, and how often the harness looks at it. */
const POD_DEADLINE_SECONDS = 120;
const LOOK_MS = 3000;

const POD = z.object({
  metadata: z.object({ uid: z.string().optional() }),
  status: z
    .object({ phase: z.string().optional(), containerStatuses: z.array(z.object({ name: z.string() })).optional() })
    .optional(),
});

/** One line the egress probe prints: a target it tried, or the control. */
const PROBE_LINE = z.object({
  what: z.string(),
  result: z.string(),
  refused: z.boolean().optional(),
  reached: z.boolean().optional(),
});

/** Finds the address of a name, for the pod's one host alias: `node:dns` unless a test gives another. */
export type Lookup = (hostname: string) => Promise<string>;
const resolve: Lookup = async (hostname) => (await lookup(hostname)).address;

/**
 * The pod spec the admission rule holds the harness to: one container, pinned, with nothing it does not need, and an
 * agent's DNS (`runners/jobs.ts`): no resolver, and the control's name as a host alias at the address the harness
 * looked up. Without it the pod could resolve nothing, the control would fail, and the attack would end unfinished
 * every time.
 */
function podBody(
  name: string,
  attack: 'egress' | 'image',
  image: string,
  command: readonly string[],
  args: readonly string[],
  controlIp: string,
) {
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name, namespace: RUNNERS, labels: redTeamPodLabels(attack) },
    spec: {
      restartPolicy: 'Never',
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      activeDeadlineSeconds: POD_DEADLINE_SECONDS,
      dnsPolicy: RED_TEAM_DNS.dnsPolicy,
      dnsConfig: { nameservers: [...RED_TEAM_DNS.nameservers] },
      hostAliases: [{ ip: controlIp, hostnames: [RED_TEAM_HOST_ALIAS] }],
      securityContext: {
        runAsNonRoot: true,
        runAsUser: 65532,
        runAsGroup: 65532,
        seccompProfile: { type: 'RuntimeDefault' },
      },
      containers: [
        {
          name: attack,
          image,
          command: [...command],
          args: [...args],
          securityContext: {
            allowPrivilegeEscalation: false,
            readOnlyRootFilesystem: true,
            capabilities: { drop: ['ALL'] },
          },
          resources: { requests: { cpu: '50m', memory: '128Mi' }, limits: { memory: '256Mi' } },
        },
      ],
    },
  };
}

const podPath = (name: string) => `/api/v1/namespaces/${RUNNERS}/pods/${name}`;

/** Appends one `action.refused`, as the harness, and gives back its seq. */
async function refuse(
  events: Pick<EventWriter, 'append'>,
  workItem: string,
  payload: { mechanism: 'egress-policy'; action: string; output: string; guardrails: number[] },
): Promise<number> {
  const event: NewEvent = {
    id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    work_item: workItem,
    type: 'action.refused',
    version: VERSIONS['action.refused'],
    actor: 'factory',
    summary: 'A runner’s egress policy refused a connection',
    payload,
    artifacts: [],
  } as NewEvent;
  const [stored] = await events.append([event]);
  if (stored?.seq === undefined) throw new Error('the store did not return a seq for the egress refusal');
  return stored.seq;
}

export const egressAttempt =
  ({
    kube,
    runnerImage,
    find = resolve,
  }: {
    kube: Pick<Kube, 'create' | 'get' | 'text' | 'remove'>;
    runnerImage: string;
    find?: Lookup;
  }): Attempt =>
  async (ctx) => {
    const name = `red-team-egress-${crypto.randomUUID().slice(0, 8)}`;
    try {
      await kube.create(
        `/api/v1/namespaces/${RUNNERS}/pods`,
        podBody(name, 'egress', runnerImage, EGRESS_COMMAND, EGRESS_ARGS, await find(RED_TEAM_HOST_ALIAS)),
      );
      const log = await runToEnd(kube, name, ctx);
      if (log === undefined) {
        return unfinished('The egress pod did not finish its probe within the limit.');
      }
      return await recordEgress(ctx, log);
    } finally {
      await kube.remove(podPath(name)).catch(() => undefined);
    }
  };

/** Reads the probe's lines once the pod has ended, or undefined if it did not end in time. */
async function runToEnd(
  kube: Pick<Kube, 'get' | 'text'>,
  name: string,
  ctx: AttemptContext,
): Promise<string | undefined> {
  const done = await waitFor(
    async () => {
      const pod = await kube.get(podPath(name), POD);
      const phase = pod?.status?.phase;
      return phase === 'Succeeded' || phase === 'Failed' ? phase : undefined;
    },
    { limitMs: ctx.limitMs, everyMs: LOOK_MS, signal: ctx.signal },
  );
  if (done === undefined) return undefined;
  return (await kube.text(`${podPath(name)}/log`)) ?? '';
}

/** Reads each probe line, appends a refusal for each target the egress policy refused, and says how the attack ended. */
async function recordEgress(ctx: AttemptContext, log: string): Promise<AttemptResult> {
  const lines = log
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const parsed = PROBE_LINE.safeParse(JSON.parse(line));
        return parsed.success ? [parsed.data] : [];
      } catch {
        return [];
      }
    });
  const byWhat = new Map(lines.map((line) => [line.what, line]));
  const attempts: AttemptResult['attempts'] = [];
  const refusals: number[] = [];
  // A target is a finding only when the pod says it reached it. One it said nothing of, or could not tell (a line it
  // called unclear), proves neither a reach nor a refusal: the attack is unfinished, not a finding and not a pass, and
  // it is no attempt, since to the line an attempt not refused is one that got through. The reason says so.
  let anyReached = false;
  let anyUnclear = false;
  const refusedTargets: { what: string; result: string }[] = [];
  for (const target of EGRESS_TARGETS) {
    const line = byWhat.get(target.what);
    const refused = line?.refused === true;
    const result = line ? line.result : 'the pod said nothing of it';
    if (line?.result === 'reached') {
      anyReached = true;
      attempts.push({ what: target.what, result, refused: false });
    } else if (refused) {
      attempts.push({ what: target.what, result, refused: true });
      refusedTargets.push({ what: target.what, result });
    } else anyUnclear = true;
  }
  // The refusals are appended once the attack's end is known. When a target was reached, that is the finding, and an
  // append that fails must not turn it into an attempt that threw, which the worker records unfinished: the reach is
  // recorded with the refusals that were appended, and the failure logged.
  for (const target of refusedTargets) {
    try {
      refusals.push(
        await refuse(ctx.events, ctx.workItem, {
          mechanism: 'egress-policy',
          action: cutTo(target.what, 200),
          output: cutTo(`${target.what}: ${target.result}`, 4000),
          guardrails: guardrailsFor('egress-policy', 'egress'),
        }),
      );
    } catch (error) {
      if (!anyReached) throw error;
      ctx.log.warn({ workItem: ctx.workItem, err: error }, 'a refusal could not be appended beside a reached target');
    }
  }
  const controlLine = byWhat.get('the gateway');
  const control = {
    what: 'the gateway',
    result: controlLine ? controlLine.result : 'the pod said nothing of it',
    reached: controlLine?.reached === true,
  };
  if (!control.reached) {
    return {
      outcome: 'unfinished',
      refusals,
      attempts,
      control,
      reason: 'The control failed: the pod could not reach the gateway, so its refusals prove nothing.',
    };
  }
  if (anyReached) {
    return {
      outcome: 'not-refused',
      refusals,
      attempts,
      control,
      reason: 'An outside address was reached: a runner’s egress policy did not refuse it.',
    };
  }
  if (anyUnclear || refusals.length !== EGRESS_TARGETS.length) {
    return {
      outcome: 'unfinished',
      refusals,
      attempts,
      control,
      reason: 'The pod could not say of every outside address whether it was refused, so the attack proves nothing.',
    };
  }
  return {
    outcome: 'refused',
    refusals,
    attempts,
    control,
    reason: 'A runner’s egress policy refused every outside address, and the gateway control was reached.',
  };
}

export const imageAttempt =
  ({
    kube,
    unsignedImage,
    find = resolve,
  }: {
    kube: Pick<Kube, 'create' | 'remove'>;
    unsignedImage: string;
    find?: Lookup;
  }): Attempt =>
  async (ctx) => {
    const name = `red-team-image-${crypto.randomUUID().slice(0, 8)}`;
    let admitted = false;
    // The same shape as the egress pod's, alias included, so the rule holds one shape and the refusal is the image's.
    const controlIp = await find(RED_TEAM_HOST_ALIAS);
    try {
      await kube.create(
        `/api/v1/namespaces/${RUNNERS}/pods`,
        podBody(name, 'image', unsignedImage, IMAGE_COMMAND, IMAGE_ARGS, controlIp),
      );
      admitted = true;
    } catch (error) {
      // Only an image policy's denial is the attack working: the API server words one as the line reads it from the
      // cluster's Events. Anything else (RBAC, a body the red-team rule refused, a name taken, a server error) means
      // the attempt could not be made, and says why rather than wait for a record the line will never make.
      const message = error instanceof Error ? error.message : String(error);
      const imageRefused = error instanceof KubeError && DENIED.test(message) && IMAGE_WEBHOOK.test(message);
      if (!imageRefused) {
        await kube.remove(podPath(name)).catch(() => undefined);
        return unfinished(`The pod could not be created to test admission: ${message}`);
      }
    }
    if (admitted) {
      // Admitted: `factory-images` did not refuse the unsigned image (it is in audit, as under `try-the-line`). The
      // attack got through; take the pod away.
      await kube.remove(podPath(name)).catch(() => undefined);
      return {
        outcome: 'not-refused',
        refusals: [],
        attempts: [
          { what: 'asked to run an unsigned image', result: 'admission control admitted the pod', refused: false },
        ],
        subject: { pod: { namespace: RUNNERS, name, uid: '00000000-0000-0000-0000-000000000000' } },
        reason: 'Admission control admitted an unsigned image: it must be enforcing for this attack (factory-images).',
      };
    }
    // The line reads the cluster's Events and records admission's refusal of the pod; the harness waits for the one
    // about this pod, by name, and reads its uid back, so the refusal it cites is about the pod it asked for.
    const found = await waitFor(
      async () => {
        const [row] = await ctx.sql<{ seq: string; uid: string | null }[]>`
          select seq::text as seq, payload->'subject'->>'uid' as uid from events
          where type = 'action.refused' and payload->>'mechanism' = 'admission-control'
            and appended_by = 'factory_line'
            and payload->'subject'->>'namespace' = ${RUNNERS}
            and payload->'subject'->>'name' = ${name}
          order by seq desc limit 1`;
        return row?.uid ? { seq: Number(row.seq), uid: row.uid } : undefined;
      },
      { limitMs: ctx.limitMs, everyMs: LOOK_MS, signal: ctx.signal },
    );
    if (!found) {
      return unfinished('Admission refused the pod, but the line did not record it within the limit.');
    }
    return {
      outcome: 'refused',
      refusals: [found.seq],
      attempts: [
        { what: 'asked to run an unsigned image', result: 'admission control refused the pod', refused: true },
      ],
      subject: { pod: { namespace: RUNNERS, name, uid: found.uid } },
      reason: 'Admission control refused the unsigned image, as it should.',
    };
  };

const unfinished = (reason: string): AttemptResult => ({
  outcome: 'unfinished',
  refusals: [],
  // No attempt: to the line an attempt not refused is one that got through, and a pod not made let nothing through.
  attempts: [],
  reason,
});
