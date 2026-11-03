/**
 * The Guardrails checklist at t: spec 6's eleven, each with what holds it, its last proof and whether it held, and the
 * attack made against it, if one is, with its last run (`policy/guardrails.ts` is the catalogue).
 *
 * How a guardrail reads (deviation 6): each of its proofs' latest result counts, its attack's among them. It reads
 * **did not hold** while any proof's latest result failed, showing that one; otherwise **held**, showing the newest.
 * A failure stands until that same proof holds again: a later pass of another cannot hide it. A guardrail nothing has
 * proved yet reads as **not proved**, which is neither.
 *
 * - **A proof** is a `guardrail.proved` appended by the proofs' role, `make guardrails`'s, under each guardrail it
 *   names: one from any other role proves nothing.
 * - **An attack's result** is how its latest run ended, as `attacks.ts` reads it: refused holds; not refused, or a
 *   refused the stream does not bear out, fails. One running, or unfinished, proves nothing either way, and leaves the
 *   attack's result before it standing.
 * - **An attack not available yet** (`available` in `policy/attacks.ts`) proves nothing, and its row shows no run of
 *   it: its guardrail reads by its other proofs alone. One of its launches still in flight, recorded before it was held
 *   back, still makes every Launch wait, as the admin service does.
 *
 * Plain TypeScript, so Node tests it directly.
 */
import type { Attack, PublicEvent } from '@software-factory/events';
import { ATTACK_RULES, attackAvailable } from '@software-factory/policy/attacks';
import { GUARDRAILS } from '@software-factory/policy/guardrails';
import { limitOf, type Verdict, verdictAt } from './attacks.ts';
import type { ItemState } from './items.ts';

/** The one role whose proofs are trusted (0043_guardrail-proofs.sql). */
export const PROOFS_ROLE = 'factory_proofs';

/** Where a proof's result came from. */
export type ProofSource =
  | { kind: 'make'; proof: string }
  | { kind: 'ci'; proof: string; commit: string; url: string }
  | { kind: 'attack'; attack: Attack; workItem: string; verdict: Verdict; why: string | undefined };

export interface ProofResult {
  held: boolean;
  source: ProofSource;
  at: number;
  /** What a proof that did not hold printed, its first line: an attack's says it on its card. */
  output: string | undefined;
}

/** An attack's last run: how it stands, when it was launched, and its work item. */
export interface AttackRun {
  verdict: Verdict;
  at: number;
  workItem: string;
  /** When one running counts as unfinished. */
  until: number;
}

export interface AttackRow {
  attack: Attack;
  name: string;
  tries: string;
  /** Whether Martin can launch it yet: one that is not has no Launch, and no run. */
  available: boolean;
  last: AttackRun | undefined;
}

export interface GuardrailRow {
  n: number;
  name: string;
  mechanism: string;
  state: 'held' | 'not-held' | 'unproved';
  /** The proof it reads by: the failure that stands, or the newest. */
  proof: ProofResult | undefined;
  attack: AttackRow | undefined;
}

export interface GuardrailsView {
  rows: GuardrailRow[];
  held: number;
  notHeld: number;
  unproved: number;
  /** The attack in flight, if one is: every Launch waits for it. */
  running: (AttackRun & { attack: Attack }) | undefined;
}

/** Each guardrail's proofs from `make guardrails`, the latest of each by its id: what no time changes. */
export type FoldedProofs = Map<number, Map<string, PublicEvent<'guardrail.proved'>>>;

/** The latest result of each proof of each guardrail, from the proofs' role alone. */
export function foldProofs(seen: readonly PublicEvent[]): FoldedProofs {
  const proofs: FoldedProofs = new Map();
  for (const event of seen) {
    if (event.type !== 'guardrail.proved' || event.appended_by !== PROOFS_ROLE) continue;
    for (const n of event.payload.guardrails) {
      const of = proofs.get(n) ?? new Map<string, PublicEvent<'guardrail.proved'>>();
      of.set(event.payload.proof, event);
      proofs.set(n, of);
    }
  }
  return proofs;
}

const firstLine = (output: string) =>
  output
    .split('\n')
    .find((line) => line.trim())
    ?.trim() ?? output;

function proofResult(event: PublicEvent<'guardrail.proved'>): ProofResult {
  const { proof, held, output, commit, run } = event.payload;
  return {
    held,
    source: run ? { kind: 'ci', proof, commit, url: run.url } : { kind: 'make', proof },
    at: Date.parse(event.ts),
    output: held ? undefined : firstLine(output),
  };
}

/** Whether an attack's result proves anything: refused holds, and not refused or not confirmed fails. */
const proves = (verdict: Verdict) => verdict === 'refused' || verdict === 'not-refused' || verdict === 'unconfirmed';

/** The checklist at t. */
export function guardrailsView(
  proofs: FoldedProofs,
  items: readonly ItemState[],
  t: number,
  available: (attack: Attack) => boolean = attackAvailable,
): GuardrailsView {
  // Each attack's runs, oldest first, as their work items opened.
  const runs = new Map<Attack, (AttackRun & { why: string | undefined })[]>();
  for (const item of items) {
    const { attack } = item;
    if (!attack) continue;
    const run = {
      verdict: verdictAt(attack, t),
      at: attack.launchedAt,
      workItem: item.number,
      until: limitOf(attack),
      why: attack.finished?.why,
    };
    runs.set(attack.attack, [...(runs.get(attack.attack) ?? []), run]);
  }
  let running: GuardrailsView['running'];
  for (const [attack, list] of runs) {
    for (const run of list)
      if (run.verdict === 'running' && (!running || run.at > running.at)) running = { ...run, attack };
  }

  const rows = GUARDRAILS.map((guardrail): GuardrailRow => {
    const results = [...(proofs.get(guardrail.n)?.values() ?? [])].map(proofResult);
    const attack = 'attack' in guardrail ? guardrail.attack : undefined;
    const offered = attack !== undefined && available(attack);
    const ran = offered ? (runs.get(attack) ?? []) : [];
    const result = ran.findLast((run) => proves(run.verdict));
    if (attack && result) {
      results.push({
        held: result.verdict === 'refused',
        source: { kind: 'attack', attack, workItem: result.workItem, verdict: result.verdict, why: result.why },
        at: result.at,
        output: undefined,
      });
    }
    const newest = (list: ProofResult[]) =>
      list.reduce<ProofResult | undefined>((a, b) => (a && a.at >= b.at ? a : b), undefined);
    const failed = newest(results.filter((r) => !r.held));
    const proof = failed ?? newest(results);
    const last = ran.at(-1);
    return {
      n: guardrail.n,
      name: guardrail.name,
      mechanism: guardrail.mechanism,
      state: failed ? 'not-held' : proof ? 'held' : 'unproved',
      proof,
      attack: attack && {
        attack,
        name: ATTACK_RULES[attack].name,
        tries: ATTACK_RULES[attack].tries,
        available: offered,
        last: last && { verdict: last.verdict, at: last.at, workItem: last.workItem, until: last.until },
      },
    };
  });
  const count = (state: GuardrailRow['state']) => rows.filter((row) => row.state === state).length;
  return { rows, held: count('held'), notHeld: count('not-held'), unproved: count('unproved'), running };
}
