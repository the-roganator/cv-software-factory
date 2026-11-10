// A live try on the local cluster, begun and ended by one command each: `try begin <branch>`, `try status`, `try end`.
// Everything a try changes is recorded, as it was, in a state file under ~/.config/software-factory/ before the first
// change, so `try end` puts it back from that file alone, from any shell, after the session that began it has gone.
// It never starts or stops the line, never writes the store, and never touches website-images, scoreboard-images or
// flagd-images: the one image policy it changes is factory-images. The judgement (what to try, what to watch, a live
// try's terms) is the try-the-line skill's; this is its mechanical half. The cluster is reached through Ops
// (try-ops.ts), which the tests replace with a cluster of their own.
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, hostname, userInfo } from 'node:os';
import { dirname, join } from 'node:path';

/** This repository's images, each with the Dockerfile that builds it. */
export const REGISTRY = 'ghcr.io/the-roganator/cv-software-factory';
export const IMAGES: Record<string, string> = {
  factory: 'apps/factory/Dockerfile',
  'factory-runner': 'apps/runner/Dockerfile',
  console: 'apps/console/Dockerfile',
  'factory-browser': 'apps/factory/Dockerfile.browser',
};
/** What `try begin` moves when not told: every deployment on the images the line's code is built into. */
const DEFAULT_IMAGES = new Set(['factory', 'factory-runner']);
/** The one policy a try changes; the other three are never written (AGENTS.md). */
export const POLICY = 'factory-images';
/** Where the try's pods can be: the factory's deployments, the line's runners and the harness's attack pods. */
export const NAMESPACES = ['factory', 'runners', 'red-team'] as const;
/** What a branch can change that `try begin` does not apply, and so cannot put back. */
const BY_HAND = ['deploy/', 'packages/store/migrations/'];
const VERSION = 1;

export interface Container {
  name: string;
  init: boolean;
  image: string;
}
export interface EnvVar {
  container: string;
  name: string;
  /** Its literal value, or undefined when it is set from a Secret or ConfigMap. */
  value?: string;
  fromRef: boolean;
}
export interface Deployment {
  name: string;
  containers: Container[];
  env: EnvVar[];
  /** Whether its latest spec is rolled out and every replica available. */
  rolledOut: boolean;
}
export interface Workload {
  namespace: string;
  kind: 'pod' | 'job';
  name: string;
  /** A pod its ReplicaSet replaces or its Job takes with it; anything else on a try's image is deleted. */
  owned: boolean;
  /** Every image it names and, for a pod, every image id its containers run. */
  images: string[];
}
export interface Root {
  syncPolicy: Record<string, unknown> | undefined;
  sync: string;
  health: string;
}
export interface Line {
  state: 'started' | 'stopped' | 'never';
  take: unknown;
  seq: number;
}

/** Everything the script reads and changes, and nothing else. */
export interface Ops {
  /** The board's `cluster.holder`, or undefined when there is no board to read. */
  holder(): string | undefined;
  root(): Root;
  pauseRoot(): void;
  setRootPolicy(policy: Record<string, unknown>): void;
  policies(): Record<string, string[]>;
  setFactoryImages(actions: string[]): void;
  deployments(): Deployment[];
  setImages(deployment: string, images: Record<string, string>): void;
  /** Sets each name to its value, and removes each one whose value is null, on one container. */
  setEnv(deployment: string, container: string, env: Record<string, string | null>): void;
  /** Waits, at most `seconds`, for the deployment's rollout; whether it finished. */
  rollout(deployment: string, seconds: number): boolean;
  workloads(): Workload[];
  remove(workload: Workload): void;
  line(): Line;
  workItemsSince(seq: number): string[];
  /** The full commit a branch names, or undefined. */
  commit(branch: string): string | undefined;
  /** The paths the commit changes against origin/main. */
  changed(commit: string): string[];
  hasLocal(ref: string): boolean;
  build(commit: string, dockerfile: string, ref: string): void;
  load(refs: string[]): void;
  /** The digest the node's containerd holds for a reference, or undefined when it holds none. */
  onNode(ref: string): string | undefined;
  /** Every reference the node's containerd holds to a digest: tags, digest references and the id k3d's import adds. */
  namedOnNode(digest: string): string[];
  tagOnNode(ref: string, as: string): void;
  removeFromNode(ref: string): void;
  removeLocal(ref: string): void;
  /** Whether the pid is a `try begin` still running (not whatever has the pid since). */
  alive(pid: number): boolean;
  sleep(ms: number): void;
  now(): Date;
  say(line: string): void;
}

export interface Moved {
  name: string;
  /** Each container the try repoints, with the image it had. */
  images: Record<string, string>;
  /** Each variable the try writes, with the value it had, or null when it had none. */
  /** `to` is the value it is set to, or, with `image`, empty: it follows that image to the try's reference. */
  env: { container: string; name: string; was: string | null; to: string; image?: string }[];
}
export interface State {
  version: number;
  phase: 'beginning' | 'open';
  holder: string;
  user: string;
  host: string;
  pid: number;
  began: string;
  branch: string;
  commit: string;
  tag: string;
  root: Record<string, unknown>;
  policies: Record<string, string[]>;
  line: Line;
  deployments: Moved[];
  /** Each image the try builds: its tag reference, and whether the Mac had it before the try. */
  images: { image: string; ref: string; existed: boolean }[];
  /** The digest references made on the node, which the deployments are pointed at. */
  nodeRefs: string[];
}

export class Refused extends Error {}

function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`${what} is missing`);
  return value;
}

export function statePath(env: NodeJS.ProcessEnv = process.env): string {
  return env.TRY_STATE ?? join(homedir(), '.config', 'software-factory', 'try', 'state.json');
}

/** The open try's state, or undefined when none is open. A file that is not a try's is an error, never ignored. */
export function readState(path: string): State | undefined {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
  let state: unknown;
  try {
    state = JSON.parse(text);
  } catch {
    throw new Refused(`${path} is not JSON: look at it, and remove it only once the cluster is shown back`);
  }
  const s = state as Partial<State>;
  if (s.version !== VERSION) throw new Refused(`${path} is version ${s.version}, not ${VERSION}: read it by hand`);
  const missing = (
    [
      'phase',
      'holder',
      'began',
      'branch',
      'commit',
      'tag',
      'root',
      'policies',
      'line',
      'deployments',
      'images',
      'nodeRefs',
    ] as const
  ).filter((k) => s[k] === undefined);
  if (missing.length) throw new Refused(`${path} lacks ${missing.join(', ')}: read it by hand`);
  for (const d of s.deployments ?? []) {
    if (typeof d.name !== 'string' || typeof d.images !== 'object' || !Array.isArray(d.env)) {
      throw new Refused(`${path} has a deployment it cannot read: read it by hand`);
    }
  }
  return s as State;
}

/** Writes the state; `create` refuses if a try is already open, so two begins cannot both hold the cluster. */
export function writeState(path: string, state: State, create = false): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, { flag: create ? 'wx' : 'w', mode: 0o600 });
}

const ours = (image: string): string | undefined => {
  if (!image.startsWith(`${REGISTRY}/`)) return undefined;
  const name = image.slice(REGISTRY.length + 1).split(/[@:]/)[0];
  return name !== undefined && name in IMAGES ? name : undefined;
};

export interface BeginOptions {
  branch: string;
  only: string[];
  env: string[];
  holder: string | undefined;
  byHand: boolean;
}

/** The moves a begin makes, worked out before anything changes. */
export function plan(
  deployments: Deployment[],
  options: Pick<BeginOptions, 'only' | 'env'>,
): { moves: { name: string; containers: Record<string, string> }[]; env: Record<string, Record<string, string>> } {
  const byName = new Map(deployments.map((d) => [d.name, d]));
  for (const name of options.only) {
    const d = byName.get(name);
    if (!d) throw new Refused(`no deployment ${name} in factory (a try moves only the factory's)`);
    if (!d.containers.some((c) => ours(c.image))) throw new Refused(`${name} runs none of this repository's images`);
  }
  const chosen = options.only.length
    ? options.only.map((n) => byName.get(n) as Deployment)
    : deployments.filter((d) => d.containers.some((c) => DEFAULT_IMAGES.has(ours(c.image) ?? '')));
  const moves = chosen.map((d) => ({
    name: d.name,
    containers: Object.fromEntries(
      d.containers.flatMap((c) => {
        const image = ours(c.image);
        return image ? [[c.name, image]] : [];
      }),
    ),
  }));
  const env: Record<string, Record<string, string>> = {};
  for (const spec of options.env) {
    const m = /^([a-z0-9-]+):([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(spec);
    if (!m) throw new Refused(`--env ${spec}: write it <deployment>:<NAME>=<value>`);
    const [, name = '', key = '', value = ''] = m;
    const d = byName.get(name);
    if (!d) throw new Refused(`--env ${spec}: no deployment ${name} in factory`);
    if (!d.containers.some((c) => c.name === name && !c.init)) {
      throw new Refused(`--env ${spec}: ${name} has no container ${name} to set it on`);
    }
    if (d.env.some((e) => e.container === name && e.name === key && e.fromRef)) {
      throw new Refused(`--env ${spec}: ${key} is set from a Secret or ConfigMap there; a try leaves those alone`);
    }
    env[name] = { ...env[name], [key]: value };
  }
  return { moves, env };
}

/** Whether an image is one a try made: a local- tag, or one of this try's references or digests. */
function tryImage(image: string, state: State | undefined): boolean {
  if (/:local-[0-9a-f]+(@|$)/.test(image)) return true;
  if (!state) return false;
  const digests = state.nodeRefs.map((r) => r.slice(r.indexOf('@') + 1));
  return (
    state.images.some((i) => image === i.ref) ||
    state.nodeRefs.includes(image) ||
    digests.some((d) => image === d || image.endsWith(`@${d}`))
  );
}

function sameJSON(a: unknown, b: unknown): boolean {
  const canon = (v: unknown): unknown =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>)
            .sort(([x], [y]) => x.localeCompare(y))
            .map(([k, w]) => [k, canon(w)]),
        )
      : Array.isArray(v)
        ? v.map(canon)
        : v;
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b));
}

/** Whether something already says a try is open, by this script or by hand; each reason, or none. */
function openTry(ops: Ops): string[] {
  const reasons: string[] = [];
  const root = ops.root();
  if (!root.syncPolicy?.automated) reasons.push('Argo CD root is paused (a try by hand?)');
  for (const [name, actions] of Object.entries(ops.policies())) {
    if (!sameJSON(actions, ['Deny'])) reasons.push(`${name} is on ${JSON.stringify(actions)}, not [Deny]`);
  }
  for (const w of ops.workloads()) {
    const local = w.images.filter((i) => tryImage(i, undefined));
    if (local.length) reasons.push(`${w.kind} ${w.namespace}/${w.name} runs ${local.join(', ')}`);
  }
  return reasons;
}

export function begin(ops: Ops, path: string, options: BeginOptions): void {
  const open = readState(path);
  if (open)
    throw new Refused(`a try is open: ${open.branch} since ${open.began}, by ${open.holder}. \`try end\` first`);
  const holder = ops.holder();
  if (holder !== undefined) {
    if (!options.holder) throw new Refused('name yourself: --holder <your key> (TRY_HOLDER), as the board names you');
    if (holder !== options.holder) {
      throw new Refused(
        holder === 'none'
          ? `the board's cluster.holder is none: write yourself on it (holder: ${options.holder}) before the first change`
          : `the board's cluster.holder is ${holder}: the cluster is theirs until they give it back`,
      );
    }
  }
  const already = openTry(ops);
  if (already.length) throw new Refused(`the cluster is not as main sets it:\n  ${already.join('\n  ')}`);
  const root = ops.root();
  if (root.sync !== 'Synced' || root.health !== 'Healthy') {
    throw new Refused(
      `Argo CD root is ${root.sync} and ${root.health}: begin from a cluster that is Synced and Healthy`,
    );
  }
  const commit = ops.commit(options.branch);
  if (!commit) throw new Refused(`no branch ${options.branch} here or on origin (git fetch?)`);
  const byHand = ops.changed(commit).filter((p) => BY_HAND.some((d) => p.startsWith(d)));
  if (byHand.length && !options.byHand) {
    throw new Refused(
      `${options.branch} changes what a try applies by hand, which \`try end\` cannot put back:\n  ${byHand.join('\n  ')}\n` +
        'apply them as the skill says (steps 7 and 8), list them in your undo list, and pass --by-hand',
    );
  }
  const deployments = ops.deployments();
  const { moves, env } = plan(deployments, options);
  const tag = `local-${commit.slice(0, 8)}`;
  const images = [...new Set(moves.flatMap((m) => Object.values(m.containers)))].sort();
  const byName = new Map(deployments.map((d) => [d.name, d]));

  // What each deployment had, before anything changes: its images, and every variable the try writes. A variable
  // that names an image the try replaces (the line's RUNNER_IMAGE) follows it to the new one.
  const recorded: Moved[] = [];
  for (const name of new Set([...moves.map((m) => m.name), ...Object.keys(env)])) {
    const d = byName.get(name) as Deployment;
    const move = moves.find((m) => m.name === name);
    const was = Object.fromEntries(d.containers.filter((c) => move?.containers[c.name]).map((c) => [c.name, c.image]));
    const vars: Moved['env'] = [];
    for (const e of d.env) {
      if (e.fromRef || !e.value) continue;
      const image = ours(e.value);
      const from = d.containers.find((c) => c.image === e.value && move?.containers[c.name]);
      if (image && from && images.includes(image))
        vars.push({ container: e.container, name: e.name, was: e.value, to: '', image });
    }
    for (const [key, value] of Object.entries(env[name] ?? {})) {
      const current = d.env.find((e) => e.container === name && e.name === key);
      const i = vars.findIndex((v) => v.container === name && v.name === key);
      if (i >= 0) vars.splice(i, 1);
      vars.push({ container: name, name: key, was: current?.value ?? null, to: value });
    }
    recorded.push({ name, images: was, env: vars });
  }

  const me = userInfo().username;
  const state: State = {
    version: VERSION,
    phase: 'beginning',
    holder: options.holder ?? me,
    user: me,
    host: hostname(),
    pid: process.pid,
    began: ops.now().toISOString(),
    branch: options.branch,
    commit,
    tag,
    root: root.syncPolicy as Record<string, unknown>,
    policies: ops.policies(),
    line: ops.line(),
    deployments: recorded,
    images: images.map((image) => {
      const ref = `${REGISTRY}/${image}:${tag}`;
      return { image, ref, existed: ops.hasLocal(ref) };
    }),
    nodeRefs: [],
  };
  try {
    writeState(path, state, true);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new Refused('another begin wrote its state first');
    throw e;
  }
  ops.say(`Recorded what the try changes in ${path}. From here, \`try end\` puts it back.`);

  // The images, built from the branch, loaded onto the node, and each found there by its tag before any deployment
  // is pointed at it. Deployments are pointed at a digest reference made from it, which admission's digest-only rules
  // take as they take main's.
  for (const i of state.images) {
    if (!i.existed) ops.build(commit, must(IMAGES[i.image], `${i.image}'s Dockerfile`), i.ref);
  }
  ops.load(state.images.map((i) => i.ref));
  const to: Record<string, string> = {};
  for (const i of state.images) {
    const digest = ops.onNode(i.ref);
    if (!digest) throw new Refused(`${i.ref} is not on the node after loading it: nothing is pointed at it`);
    // Removing the try's image from the node removes every name its digest has, so it must be no image main runs.
    if (recorded.some((d) => Object.values(d.images).some((was) => was.endsWith(`@${digest}`)))) {
      throw new Refused(`${i.ref} is the image main runs (${digest}): there is nothing to try`);
    }
    to[i.image] = `${REGISTRY}/${i.image}@${digest}`;
  }
  state.nodeRefs = Object.values(to);
  writeState(path, state);
  const at = (image: string): string => must(to[image], `${image}'s reference on the node`);
  for (const i of state.images) ops.tagOnNode(i.ref, at(i.image));
  for (const i of state.images) {
    if (!ops.onNode(at(i.image))) throw new Refused(`${at(i.image)} is not on the node: nothing is pointed at it`);
  }

  ops.pauseRoot();
  ops.say('Argo CD root paused.');
  ops.setFactoryImages(['Audit']);
  ops.say(`${POLICY} on Audit; the other policies untouched.`);
  for (const d of recorded) {
    const move = moves.find((m) => m.name === d.name);
    if (move)
      ops.setImages(d.name, Object.fromEntries(Object.entries(move.containers).map(([c, image]) => [c, at(image)])));
    const byContainer = new Map<string, Record<string, string>>();
    for (const v of d.env) {
      const value = v.image ? at(v.image) : v.to;
      byContainer.set(v.container, { ...byContainer.get(v.container), [v.name]: value });
    }
    for (const [container, vars] of byContainer) ops.setEnv(d.name, container, vars);
  }
  const rollouts = ops.now().getTime() + 600_000;
  for (const d of recorded) {
    if (!ops.rollout(d.name, left(ops, rollouts)))
      throw new Refused(`${d.name} did not roll out within ten minutes of the first: \`try end\` puts it back`);
    ops.say(`${d.name} on ${state.tag}${d.env.length ? `, with ${d.env.map((v) => v.name).join(', ')}` : ''}.`);
  }
  state.phase = 'open';
  writeState(path, state);
  ops.say(
    `The try of ${options.branch} (${commit.slice(0, 8)}) is open. \`try status\` says what it changed; \`try end\` puts it all back.`,
  );
}

/** Seconds to a deadline, at least one, so a rollout past it is asked once and not waited for. */
const left = (ops: Ops, deadline: number): number => Math.max(1, Math.ceil((deadline - ops.now().getTime()) / 1000));

const nodeDigests = (state: State): string[] => state.nodeRefs.map((r) => r.slice(r.indexOf('@') + 1));

/** Each way the cluster is not yet as the state recorded it; none when it is back. */
export function notBack(ops: Ops, state: State): string[] {
  const wrong: string[] = [];
  const root = ops.root();
  if (!sameJSON(root.syncPolicy, state.root))
    wrong.push(`Argo CD root's sync policy is ${JSON.stringify(root.syncPolicy ?? null)}`);
  if (root.sync !== 'Synced' || root.health !== 'Healthy')
    wrong.push(`Argo CD root is ${root.sync} and ${root.health}`);
  const policies = ops.policies();
  for (const [name, actions] of Object.entries(state.policies)) {
    if (!sameJSON(policies[name], actions))
      wrong.push(`${name} is on ${JSON.stringify(policies[name] ?? null)}, was ${JSON.stringify(actions)}`);
  }
  const deployments = new Map(ops.deployments().map((d) => [d.name, d]));
  for (const moved of state.deployments) {
    const d = deployments.get(moved.name);
    if (!d) continue;
    for (const c of d.containers) if (tryImage(c.image, state)) wrong.push(`${d.name}'s ${c.name} is on ${c.image}`);
    // A variable main sets is main's again once root is Synced; one it does not set is checked to be gone.
    for (const v of moved.env) {
      if (v.was !== null) continue;
      const now = d.env.find((e) => e.container === v.container && e.name === v.name);
      if (now) wrong.push(`${d.name}'s ${v.container} still has ${v.name}=${now.value ?? '(from a ref)'}`);
    }
    for (const e of d.env)
      if (e.value && tryImage(e.value, state)) wrong.push(`${d.name}'s ${e.container} has ${e.name}=${e.value}`);
    if (!d.rolledOut) wrong.push(`${d.name} has not finished rolling out`);
  }
  for (const w of ops.workloads()) {
    const local = w.images.filter((i) => tryImage(i, state));
    if (local.length) wrong.push(`${w.kind} ${w.namespace}/${w.name} runs ${[...new Set(local)].join(', ')}`);
  }
  for (const ref of state.images.map((i) => i.ref)) if (ops.onNode(ref)) wrong.push(`${ref} is still on the node`);
  for (const digest of nodeDigests(state)) {
    for (const name of ops.namedOnNode(digest)) wrong.push(`${name} (${digest}) is still on the node`);
  }
  for (const i of state.images) if (!i.existed && ops.hasLocal(i.ref)) wrong.push(`${i.ref} is still on the Mac`);
  return wrong;
}

export interface EndOptions {
  timeoutSeconds: number;
}

/** Puts back everything the state recorded; whether all of it is back (and the state file gone). */
export function end(ops: Ops, path: string, options: EndOptions): boolean {
  const state = readState(path);
  if (!state) {
    ops.say('No try is open.');
    return true;
  }
  if (state.phase === 'beginning' && state.host === hostname() && state.pid !== process.pid && ops.alive(state.pid)) {
    throw new Refused(
      `the begin that opened this try is still running (pid ${state.pid}): let it finish, or stop it, first`,
    );
  }
  const moved = new Set(state.deployments.map((d) => d.name));
  let line: Line | undefined;
  try {
    line = ops.line();
  } catch (e) {
    // Whether the line is started matters only when the try moved it: then nothing is put back unknowing.
    if (moved.has('line')) {
      throw new Refused(
        `the store cannot be read, so whether the line is started is not known: ${(e as Error).message}`,
      );
    }
    ops.say(`The store cannot be read (${(e as Error).message}); putting back without the line's state.`);
  }
  if (moved.has('line') && line?.state === 'started') {
    throw new Refused(
      "the line is started, on the try's images: stop it first, which only Martin's command line writes,\n" +
        '  make stop-the-line KUBECTL="kubectl --context k3d-software-factory" REASON="putting a try back"\n' +
        'then run `try end` again. Nothing has been changed.',
    );
  }
  ops.say(
    `Putting back the try of ${state.branch} (${state.commit.slice(0, 8)}), begun ${state.began} by ${state.holder}.`,
  );

  // Runner Jobs and attack pods on the try's images go first: once factory-images is on Deny again, nothing on them
  // would be admitted, and none is a deployment's to replace.
  for (const w of ops.workloads()) {
    if (!w.owned && w.images.some((i) => tryImage(i, state))) {
      try {
        ops.remove(w);
        ops.say(`Deleted ${w.kind} ${w.namespace}/${w.name}.`);
      } catch (e) {
        ops.say(
          `Could not delete ${w.kind} ${w.namespace}/${w.name} (${(e as Error).message}); the check below says if it is still there.`,
        );
      }
    }
  }
  // Each deployment back on the images it had, then each variable as it was: the images first, so the rollout the
  // variables make runs main's image, which Deny admits.
  const current = new Map(ops.deployments().map((d) => [d.name, d]));
  for (const d of state.deployments) {
    const now = current.get(d.name);
    if (!now) continue;
    const images = Object.fromEntries(
      Object.entries(d.images).filter(([c, was]) => now.containers.find((x) => x.name === c)?.image !== was),
    );
    if (Object.keys(images).length) ops.setImages(d.name, images);
    const byContainer = new Map<string, Record<string, string | null>>();
    for (const v of d.env) {
      const value = now.env.find((e) => e.container === v.container && e.name === v.name)?.value ?? null;
      if (value !== v.was) byContainer.set(v.container, { ...byContainer.get(v.container), [v.name]: v.was });
    }
    for (const [container, vars] of byContainer) ops.setEnv(d.name, container, vars);
    if (Object.keys(images).length || byContainer.size) {
      ops.say(
        `${d.name}: ${Object.keys(images).length ? 'images' : ''}${Object.keys(images).length && byContainer.size ? ' and ' : ''}${byContainer.size ? 'env' : ''} as they were.`,
      );
    }
  }
  // Every wait shares the one deadline, so factory-images is on Audit no longer than --timeout says.
  const deadline = ops.now().getTime() + options.timeoutSeconds * 1000;
  for (const d of state.deployments) {
    if (current.has(d.name) && !ops.rollout(d.name, left(ops, deadline))) ops.say(`${d.name} has not rolled out yet.`);
  }
  if (!sameJSON(ops.policies()[POLICY], state.policies[POLICY])) {
    ops.setFactoryImages(must(state.policies[POLICY], `the recorded ${POLICY}`));
    ops.say(`${POLICY} back on ${JSON.stringify(state.policies[POLICY])}.`);
  }
  if (!sameJSON(ops.root().syncPolicy, state.root)) {
    ops.setRootPolicy(state.root);
    ops.say('Argo CD root has its sync policy back.');
  }
  // Every name the node holds for the try's digests (a begin stopped before it recorded them has only the tags).
  const digests = new Set([...nodeDigests(state), ...state.images.flatMap((i) => ops.onNode(i.ref) ?? [])]);
  for (const i of state.images) if (ops.onNode(i.ref)) ops.removeFromNode(i.ref);
  for (const digest of digests) for (const name of ops.namedOnNode(digest)) ops.removeFromNode(name);
  for (const i of state.images) if (!i.existed && ops.hasLocal(i.ref)) ops.removeLocal(i.ref);

  let wrong = notBack(ops, state);
  while (wrong.length && ops.now().getTime() < deadline) {
    ops.sleep(10_000);
    wrong = notBack(ops, state);
  }
  if (wrong.length) {
    ops.say(
      `Not back after ${options.timeoutSeconds}s; the state is kept, and \`try end\` can be run again:\n  ${wrong.join('\n  ')}`,
    );
    return false;
  }
  unlinkSync(path);
  ops.say(
    "Back as it was: root Synced and Healthy on its own policy, every image policy as recorded, no pod or Job on the try's images, its images off the node and the Mac.",
  );
  if (line) report(ops, state, line);
  return true;
}

/** What only Martin acts on: the line, the take and the work items the try moved, read from the store. */
function report(ops: Ops, state: State, line: Line): void {
  ops.say(`The line is ${line.state} (it was ${state.line.state} when the try began); a try never starts or stops it.`);
  if (!sameJSON(line.take, state.line.take)) {
    ops.say(
      `The take is ${JSON.stringify(line.take)}, was ${JSON.stringify(state.line.take)}: Martin's to set back (make take-the-line).`,
    );
  }
  const items = ops.workItemsSince(state.line.seq);
  ops.say(
    items.length
      ? `Work items with events since seq ${state.line.seq}: ${items.join(', ')}; the store is now at seq ${line.seq}.`
      : `No work item has an event since seq ${state.line.seq}.`,
  );
}

export function status(ops: Ops, path: string): void {
  const state = readState(path);
  if (!state) {
    const open = openTry(ops);
    ops.say(
      open.length
        ? `No try is open by this script, but:\n  ${open.join('\n  ')}`
        : 'No try is open; the cluster is as main sets it.',
    );
    return;
  }
  ops.say(
    `A try of ${state.branch} (${state.commit.slice(0, 8)}, ${state.tag}) is ${state.phase === 'open' ? 'open' : 'being begun, or its begin stopped part way'}.`,
  );
  ops.say(`Begun ${state.began} by ${state.holder} (${state.user} on ${state.host}, pid ${state.pid}).`);
  for (const d of state.deployments) {
    const vars = d.env.map((v) => `${v.name} (was ${v.was ?? 'unset'})`).join(', ');
    ops.say(`  ${d.name}: ${Object.keys(d.images).join(', ') || 'no image'} moved${vars ? `; ${vars}` : ''}`);
  }
  ops.say(
    `Recorded: root ${JSON.stringify(state.root)}; ${POLICY} ${JSON.stringify(state.policies[POLICY])}; the line ${state.line.state} at seq ${state.line.seq}.`,
  );
  const wrong = notBack(ops, state);
  ops.say(
    wrong.length
      ? `Changed now:\n  ${wrong.join('\n  ')}`
      : 'Nothing is changed now: `try end` only removes the state.',
  );
}

export function parse(
  argv: string[],
): { command: 'begin'; options: BeginOptions } | { command: 'end'; options: EndOptions } | { command: 'status' } {
  const [command, ...rest] = argv;
  if (command === 'status' && !rest.length) return { command };
  if (command === 'end') {
    let timeoutSeconds = 600;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--timeout' && /^\d+$/.test(rest[i + 1] ?? '')) timeoutSeconds = Number(rest[++i]);
      else throw new Refused(`try end: unknown ${rest[i]}`);
    }
    if (timeoutSeconds > 1200) throw new Refused('try end --timeout: 1200 seconds at most');
    return { command, options: { timeoutSeconds } };
  }
  if (command === 'begin') {
    const options: BeginOptions = { branch: '', only: [], env: [], holder: process.env.TRY_HOLDER, byHand: false };
    const args = [...rest];
    const value = (flag: string): string => {
      const v = args.shift();
      if (v === undefined || v.startsWith('--')) throw new Refused(`${flag} takes a value`);
      return v;
    };
    for (let a = args.shift(); a !== undefined; a = args.shift()) {
      if (a === '--only') {
        options.only.push(...value(a).split(',').filter(Boolean));
      } else if (a === '--env') options.env.push(value(a));
      else if (a === '--holder') options.holder = value(a);
      else if (a === '--by-hand') options.byHand = true;
      else if (!a.startsWith('--') && !options.branch) options.branch = a;
      else throw new Refused(`try begin: unknown ${a}`);
    }
    if (!options.branch) throw new Refused('try begin <branch>: which branch?');
    return { command, options };
  }
  throw new Refused(
    'usage: try begin <branch> [--only <deployment>[,…]]… [--env <deployment>:<NAME>=<value>]… [--holder <key>] [--by-hand]\n' +
      '       try status\n       try end [--timeout <seconds>]',
  );
}

export async function main(argv: string[], ops: Ops, path = statePath()): Promise<number> {
  try {
    const command = parse(argv);
    if (command.command === 'begin') {
      try {
        begin(ops, path, command.options);
      } catch (e) {
        const left = readState(path);
        if (left?.phase === 'beginning' && left.pid === process.pid && left.host === hostname())
          ops.say('The begin stopped part way: `try end` puts back what it changed.');
        throw e;
      }
    } else if (command.command === 'status') status(ops, path);
    else return end(ops, path, command.options) ? 0 : 1;
    return 0;
  } catch (e) {
    if (e instanceof Refused) {
      ops.say(e.message);
      return 2;
    }
    throw e;
  }
}
