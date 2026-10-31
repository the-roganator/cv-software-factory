/**
 * Judging a refusal record taken again by `make guardrails` against the one kept in `deploy/test/`, which the fences'
 * tests hold to what each case must get, and to the policies deploy/ renders (refusal-records.test.ts). A record taken
 * now holds when it was taken against the same policies and Roles (its `policyHash`), and the cluster answered each
 * case as the kept record says: so a proof holds only while the cluster refuses what the reviewed record says it
 * refuses, and admits its controls.
 */

/** One case of a record: what was asked, and what the cluster answered. */
export interface Case {
  case: string;
  namespace?: string;
  as?: string;
  outcome: string;
  message?: string;
}

/** A refusal record, as the scripts write it: its cases under `cases` or, for the flag stages, `answers`. */
export interface RefusalRecord {
  policyHash?: string;
  cases?: Case[];
  answers?: Case[];
  /**
   * What the script read of the live objects beside its cases: the mark's routes admitted as they are (cases, judged
   * as the rest), or the share key's public half matching its Secret (judged as the kept record has it).
   */
  live?: Case[] | Record<string, unknown>;
}

export interface Judged {
  held: boolean;
  /** A line for each case as the cluster answered it now, then each way it differs from the kept record. */
  lines: string[];
}

export const casesOf = (record: RefusalRecord | Case[]): Case[] =>
  Array.isArray(record)
    ? record
    : [...(record.cases ?? record.answers ?? []), ...(Array.isArray(record.live) ? record.live : [])];

/** How a case is named: its namespace, its name, and whom it asked as, as far as it has each. */
const nameOf = (c: Case) => [c.namespace, c.case, c.as && `(as ${c.as})`].filter(Boolean).join(' ');

/** Whether a record taken now answers as the kept one, and how it answered. */
export function judgeRecord(kept: RefusalRecord | Case[], fresh: RefusalRecord): Judged {
  const before = casesOf(kept);
  const now = casesOf(fresh);
  const lines = now.map((c) => `${c.outcome}  ${nameOf(c)}: ${c.message ?? ''}`);
  const problems: string[] = [];
  const keptHash = Array.isArray(kept) ? undefined : kept.policyHash;
  if (!keptHash) problems.push('the record in deploy/test/ keeps no policy hash: take it again with its script');
  else if (fresh.policyHash !== keptHash) {
    problems.push(`taken against other policies (${fresh.policyHash ?? 'none'}) than deploy/test/'s (${keptHash})`);
  }
  if (!before.some((c) => c.outcome === 'refused')) problems.push('the record in deploy/test/ refuses nothing');
  const named = new Map(now.map((c) => [nameOf(c), c]));
  for (const c of before) {
    const answer = named.get(nameOf(c));
    if (!answer) problems.push(`${nameOf(c)}: not asked now`);
    else if (answer.outcome !== c.outcome)
      problems.push(`${nameOf(c)}: ${answer.outcome} now, ${c.outcome} in deploy/test/`);
  }
  const keptLive = Array.isArray(kept) ? undefined : kept.live;
  if (keptLive && !Array.isArray(keptLive) && JSON.stringify(fresh.live) !== JSON.stringify(keptLive)) {
    problems.push(`live: ${JSON.stringify(fresh.live ?? null)} now, ${JSON.stringify(keptLive)} in deploy/test/`);
  }
  const keptNames = new Set(before.map(nameOf));
  for (const c of now) if (!keptNames.has(nameOf(c))) problems.push(`${nameOf(c)}: not in deploy/test/`);
  return { held: problems.length === 0, lines: [...lines, ...problems.map((p) => `✗ ${p}`)] };
}

/**
 * The admission proof's own demand beyond the record: each image signed by another identity, where an image of ours
 * runs (everywhere but `flagd`), is refused for its signature, not its registry or its place (ADR 0010).
 */
export function otherIdentityProblems(fresh: RefusalRecord): string[] {
  const cases = casesOf(fresh).filter((c) => c.case === 'other-identity' && c.namespace !== 'flagd');
  if (!cases.length) return ['✗ no other-identity case was asked'];
  return cases
    .filter((c) => c.outcome !== 'refused' || !/must be signed by build\.yml on main/.test(c.message ?? ''))
    .map((c) => `✗ ${nameOf(c)}: not refused for its signature`);
}

/** A check of `scripts/egress.sh`'s record. */
export interface EgressCheck {
  group: string;
  check: string;
  from: string;
  address: string;
  wanted: string;
  got: string;
  result: string;
  tag?: string;
}

export interface EgressRecord {
  policyHash?: string;
  held?: boolean;
  checks?: EgressCheck[];
}

const checkLine = (c: EgressCheck) =>
  `${c.result === 'ok' ? 'ok  ' : 'FAIL'}  ${c.check} (from ${c.from}, to ${c.address}): ${c.got}${
    c.result === 'ok' ? '' : `, wanted ${c.wanted}`
  }`;

/** egress.sh's record judged: every check as wanted. The failures first, then how many held. */
export function judgeEgress(record: EgressRecord, tag?: string): Judged {
  const checks = (record.checks ?? []).filter((c) => tag === undefined || c.tag === tag);
  const failed = checks.filter((c) => c.result !== 'ok');
  const lines = [...failed.map(checkLine), `${checks.length - failed.length} of ${checks.length} checks as wanted`];
  if (tag !== undefined) lines.push(...checks.filter((c) => c.result === 'ok').map(checkLine));
  const held = checks.length > 0 && failed.length === 0 && (tag !== undefined || record.held === true);
  if (!checks.length) lines.push(`✗ no check${tag ? ` tagged ${tag}` : ''} in the record`);
  return { held, lines };
}
