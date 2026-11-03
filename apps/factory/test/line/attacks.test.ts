/**
 * The line's judgement of each red-team attack, from the stored events, as the security count reads it: the kinds that
 * page Martin when an attack was not refused, was refused by what should not have refused it, or did not finish.
 */
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VERSIONS } from '@software-factory/events';
import { DiskArtifacts } from '@software-factory/store';
import { refusalIdFor } from '@software-factory/triage/events';
import type { JSONValue, Sql } from 'postgres';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Database, freshDatabase } from '../../../../packages/store/test/database.ts';
import { ATTACK_RULES, ATTACK_TITLE } from '../../../../policy/attacks.ts';
import { RefusalRecorder } from '../../src/github/refusals.ts';
import { judge } from '../../src/line/attacks.ts';
import { emptyTally, readOn } from '../../src/line/security.ts';

let database: Database;
beforeEach(async () => {
  database = await freshDatabase('line_attacks');
});
afterEach(() => database?.end());

/** Appends an event straight to the store as `sql`'s role, unchecked but by row security, and gives its seq. */
async function append(
  sql: Sql,
  type: string,
  payload: object,
  workItem: string | null,
  { id = crypto.randomUUID(), appendedAt }: { id?: string; appendedAt?: Date } = {},
): Promise<number> {
  const version = (VERSIONS[type as keyof typeof VERSIONS] as number | undefined) ?? 1;
  const [row] = await sql<{ seq: string }[]>`
    insert into events (id, ts, work_item, type, version, actor, summary, payload, artifacts, public, sample,
                        appended_at)
    values (${id}, now(), ${workItem}, ${type}, ${version}, 'martin', ${type}, ${sql.json(payload as JSONValue)}, '[]',
            ${sql.json({ payload } as JSONValue)}, false, coalesce(${appendedAt ?? null}::timestamptz, clock_timestamp()))
    returning seq`;
  return Number(row?.seq);
}

/** Martin launches an attack from the console: its work item opened, and the launch on it, by the admin service. */
async function launch(workItem: string, attack: keyof typeof ATTACK_RULES, appendedAt?: Date): Promise<number> {
  await append(
    database.admin,
    'work-item.opened',
    { kind: 'red-team', category: 'red-team', title: ATTACK_TITLE },
    workItem,
    appendedAt ? { appendedAt } : {},
  );
  return append(database.admin, 'attack.launched', { attack }, workItem, appendedAt ? { appendedAt } : {});
}

const refusal = (mechanism: string, guardrails: number[], extra: object = {}) => ({
  mechanism,
  action: `Refused by ${mechanism}`,
  output: 'Refused.',
  guardrails,
  ...extra,
});

const egress = () => refusal('egress-policy', [5]);

/** The harness's end of an attack, as it records it. */
const finished = (attack: keyof typeof ATTACK_RULES, refusals: number[], extra: object = {}) => ({
  attack,
  outcome: 'refused',
  expected: [...ATTACK_RULES[attack].expects],
  refusals,
  attempts: ATTACK_RULES[attack].expects.map((mechanism, n) => ({
    what: `Attempt ${n + 1}`,
    result: `Refused by ${mechanism}`,
    refused: true,
  })),
  // The egress attack's control: the gateway, which its pod may reach.
  ...(attack === 'egress' && { control: { what: 'Reach the gateway', result: 'HTTP/1.1 200 OK', reached: true } }),
  ...extra,
});

const kinds = async () => (await readOn(database.as.line, emptyTally())).kinds;
const NONE = { 'attack-not-refused': 0, 'attack-wrong-mechanism': 0, 'attack-unfinished': 0 };

/** The egress attack, refused as it should be: three refusals the harness recorded from its pod, on its work item. */
async function egressRefused(workItem: string) {
  await launch(workItem, 'egress');
  const seqs = [];
  for (let n = 0; n < 3; n++) seqs.push(await append(database.redteam, 'action.refused', egress(), workItem));
  return seqs;
}

describe('the line’s judgement of an attack', () => {
  it('counts nothing for an attack refused as it should be: the guardrail working', async () => {
    const seqs = await egressRefused('5001');
    await append(database.redteam, 'attack.finished', finished('egress', seqs), '5001');
    expect(await kinds()).toMatchObject(NONE);
  });

  it('pages for an attack the harness says was not refused, as one made to get through does', async () => {
    await launch('5002', 'egress');
    const seq = await append(database.redteam, 'action.refused', egress(), '5002');
    await append(
      database.redteam,
      'attack.finished',
      finished('egress', [seq], {
        outcome: 'not-refused',
        attempts: [
          { what: 'Reach example.com by name', result: 'Refused.', refused: true },
          { what: 'Reach 93.184.215.14', result: 'HTTP/1.1 200 OK', refused: false },
        ],
      }),
      '5002',
    );
    expect(await kinds()).toMatchObject({ ...NONE, 'attack-not-refused': 1 });
  });

  it('pages for an attempt that got through, whatever the harness says of the attack as a whole', async () => {
    await launch('5003', 'egress');
    await append(
      database.redteam,
      'attack.finished',
      finished('egress', [], {
        outcome: 'unfinished',
        attempts: [{ what: 'Reach example.com by name', result: 'HTTP/1.1 200 OK', refused: false }],
      }),
      '5003',
    );
    expect(await kinds()).toMatchObject({ 'attack-not-refused': 1, 'attack-wrong-mechanism': 0 });
  });

  it('pages when it cannot agree that an attack was refused: a refusal by another mechanism, missing, early or elsewhere', async () => {
    // By another mechanism than the one expected at its place.
    await launch('5010', 'egress');
    const scope = await append(database.as.line, 'action.refused', refusal('scope-fence', [11]), '5010');
    const two = [
      await append(database.redteam, 'action.refused', egress(), '5010'),
      await append(database.redteam, 'action.refused', egress(), '5010'),
    ];
    await append(database.redteam, 'attack.finished', finished('egress', [scope, ...two]), '5010');
    // Citing a seq that is no refusal.
    const seqs = await egressRefused('5011');
    const opened = await append(database.admin, 'line.stopped', { reason: 'night' }, null);
    await append(database.redteam, 'attack.finished', finished('egress', [opened, ...seqs.slice(1)]), '5011');
    // A refusal from before its launch: another attack's.
    const old = await egressRefused('5012');
    await launch('5013', 'egress');
    await append(database.redteam, 'attack.finished', finished('egress', old), '5013');
    // Fewer refusals than it expects.
    const few = await egressRefused('5014');
    await append(database.redteam, 'attack.finished', finished('egress', few.slice(0, 2)), '5014');
    // Expecting what the attack does not.
    const other = await egressRefused('5015');
    await append(
      database.redteam,
      'attack.finished',
      finished('egress', other.slice(0, 1), { expected: ['egress-policy'] }),
      '5015',
    );
    expect(await kinds()).toMatchObject({ 'attack-not-refused': 0, 'attack-wrong-mechanism': 5 });
  });

  it('cannot agree that an egress attack was refused without its control reached, however its refusals read', async () => {
    const without = await egressRefused('5016');
    await append(database.redteam, 'attack.finished', finished('egress', without, { control: undefined }), '5016');
    const failed = await egressRefused('5017');
    await append(
      database.redteam,
      'attack.finished',
      finished('egress', failed, { control: { what: 'Reach the gateway', result: 'ECONNREFUSED', reached: false } }),
      '5017',
    );
    expect(await kinds()).toMatchObject({ 'attack-not-refused': 0, 'attack-wrong-mechanism': 2 });
  });

  it('counts a refusal only from a role the table lets append its mechanism, were row security to let another', async () => {
    await launch('5020', 'egress');
    await database.owner`alter table events disable row level security`;
    let seqs: number[];
    try {
      seqs = [
        await append(database.as.line, 'action.refused', egress(), '5020'),
        await append(database.redteam, 'action.refused', egress(), '5020'),
        await append(database.redteam, 'action.refused', egress(), '5020'),
      ];
    } finally {
      await database.owner`alter table events enable row level security`;
    }
    await append(database.redteam, 'attack.finished', finished('egress', seqs), '5020');
    expect(await kinds()).toMatchObject({ 'attack-wrong-mechanism': 1 });
  });

  it('judges only the harness’s end of an attack Martin launched', async () => {
    const seqs = await egressRefused('5030');
    // An end from another role, which only a hole in row security would let in, saying it was not refused.
    await database.owner`alter table events disable row level security`;
    try {
      await append(database.as.line, 'attack.finished', finished('egress', seqs, { outcome: 'not-refused' }), '5030');
      // And the harness's end on a work item no one of Martin's roles launched an attack on.
      await append(database.redteam, 'attack.finished', finished('egress', [], { outcome: 'not-refused' }), '5031');
    } finally {
      await database.owner`alter table events enable row level security`;
    }
    expect(await kinds()).toMatchObject(NONE);
  });

  it('matches the image attack’s refusal to its own pod, by its uid', async () => {
    const pod = { namespace: 'runners', name: 'red-team-image', uid: crypto.randomUUID() };
    const denied = (uid: string) =>
      refusal('admission-control', [3], { subject: { namespace: 'runners', kind: 'Pod', name: pod.name, uid } });
    await launch('5040', 'image');
    const its = await append(database.as.line, 'action.refused', denied(pod.uid), null);
    await append(database.redteam, 'attack.finished', finished('image', [its], { subject: { pod } }), '5040');
    expect(await kinds()).toMatchObject(NONE);
    // Another pod's refusal, of the same name, in the same minute.
    await launch('5041', 'image');
    const another = await append(database.as.line, 'action.refused', denied(crypto.randomUUID()), null);
    await append(database.redteam, 'attack.finished', finished('image', [another], { subject: { pod } }), '5041');
    expect(await kinds()).toMatchObject({ 'attack-wrong-mechanism': 1 });
  });

  it('matches the report attack’s refusal to its own report, by the id triage gives that report’s refusal', async () => {
    const report = crypto.randomUUID();
    const quarantined = () => refusal('typed-judgement', [8]);
    await launch('5050', 'report');
    const its = await append(database.as.triage, 'action.refused', quarantined(), '5052', { id: refusalIdFor(report) });
    await append(database.redteam, 'attack.finished', finished('report', [its], { subject: { report } }), '5050');
    expect(await kinds()).toMatchObject(NONE);
    // A visitor's report quarantined in the same minute.
    await launch('5051', 'report');
    const visitor = await append(database.as.triage, 'action.refused', quarantined(), '5053');
    await append(database.redteam, 'attack.finished', finished('report', [visitor], { subject: { report } }), '5051');
    expect(await kinds()).toMatchObject({ 'attack-wrong-mechanism': 1 });
  });

  it('counts a relayed refusal only once it verifies, against the GitHub worker’s record and key', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const artifacts = new DiskArtifacts(mkdtempSync(join(tmpdir(), 'attack-records-')));
    const recorder = new RefusalRecorder({ artifacts, key: privateKey });
    const relayed = async (mechanism: 'github-guard' | 'token-permission') => {
      const signed = await recorder.record({
        repo: 'the-roganator/cv-worlds-worst-website',
        number: null,
        action: 'Commit .github/workflows/ci.yml',
        output: mechanism === 'github-guard' ? 'A protected path.' : 'Resource not accessible by integration',
        ...(mechanism === 'github-guard'
          ? { mechanism, cause: 'protected' as const }
          : { mechanism, cause: 'forbidden' as const }),
      });
      if (!signed) throw new Error('not kept');
      return { ...signed.payload, record: signed.record, signature: signed.signature };
    };
    await launch('5060', 'workflow');
    const seqs = [
      await append(database.redteam, 'action.refused', await relayed('github-guard'), '5060'),
      await append(database.redteam, 'action.refused', await relayed('token-permission'), '5060'),
    ];
    await append(database.redteam, 'attack.finished', finished('workflow', seqs), '5060');
    const verifier = { key: publicKey, artifacts };
    expect((await readOn(database.as.line, emptyTally(), verifier)).kinds).toMatchObject(NONE);
    // With no key, or a changed payload, it does not verify.
    expect((await kinds())['attack-wrong-mechanism']).toBe(1);
    await launch('5061', 'workflow');
    const changed = { ...(await relayed('github-guard')), output: 'Something else.' };
    const unverified = [
      await append(database.redteam, 'action.refused', changed, '5061'),
      await append(database.redteam, 'action.refused', await relayed('token-permission'), '5061'),
    ];
    await append(database.redteam, 'attack.finished', finished('workflow', unverified), '5061');
    expect((await readOn(database.as.line, emptyTally(), verifier)).kinds['attack-wrong-mechanism']).toBe(1);
    // And one with no signature at all, of a mechanism that is always relayed.
    await launch('5062', 'workflow');
    const unsigned = [
      await append(database.redteam, 'action.refused', refusal('github-guard', [1]), '5062'),
      await append(database.redteam, 'action.refused', await relayed('token-permission'), '5062'),
    ];
    await append(database.redteam, 'attack.finished', finished('workflow', unsigned), '5062');
    expect((await readOn(database.as.line, emptyTally(), verifier)).kinds['attack-wrong-mechanism']).toBe(2);
  });
});

describe('an attack that did not finish', () => {
  const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000);

  it('pages for a launch past its limit with no end from the harness, and not before', async () => {
    const limit = ATTACK_RULES.egress.minutes;
    await launch('5100', 'egress', ago(limit + 1));
    await launch('5101', 'egress', ago(limit - 1));
    expect(await kinds()).toMatchObject({ 'attack-unfinished': 1 });
  });

  it('pages for an end that came after the limit, and for one the harness says is unfinished, once each', async () => {
    const limit = ATTACK_RULES.egress.minutes;
    // Ended within its limit, refused: nothing.
    await launch('5110', 'egress', ago(limit + 5));
    const seqs = [];
    for (let n = 0; n < 3; n++) seqs.push(await append(database.redteam, 'action.refused', egress(), '5110'));
    await append(database.redteam, 'attack.finished', finished('egress', seqs), '5110', { appendedAt: ago(limit + 4) });
    // Ended after its limit: unfinished, however it says it went.
    await launch('5111', 'egress', ago(limit + 5));
    const late = [];
    for (let n = 0; n < 3; n++) late.push(await append(database.redteam, 'action.refused', egress(), '5111'));
    await append(database.redteam, 'attack.finished', finished('egress', late), '5111');
    // The harness says its control failed, within the limit: unfinished, at once.
    await launch('5112', 'egress');
    await append(
      database.redteam,
      'attack.finished',
      finished('egress', [], {
        outcome: 'unfinished',
        attempts: [],
        control: { what: 'Reach the gateway', result: 'ECONNREFUSED', reached: false },
      }),
      '5112',
    );
    // And an end from another role counts for nothing.
    await launch('5113', 'egress', ago(limit + 5));
    await database.owner`alter table events disable row level security`;
    try {
      await append(database.as.line, 'attack.finished', finished('egress', [], { outcome: 'not-refused' }), '5113');
    } finally {
      await database.owner`alter table events enable row level security`;
    }
    const tally = await readOn(database.as.line, emptyTally());
    expect(tally.kinds).toMatchObject({ 'attack-unfinished': 3, 'attack-not-refused': 0 });
    // Read on, it is the same, and never falls.
    expect((await readOn(database.as.line, tally)).kinds['attack-unfinished']).toBe(3);
  });

  it('waits the longest any attack may take for a launch of an attack this code does not know', async () => {
    await append(database.admin, 'attack.launched', { attack: 'later' }, '5120', { appendedAt: ago(15) });
    expect(await kinds()).toMatchObject({ 'attack-unfinished': 0 });
  });
});

describe('judging an end of an attack', () => {
  it('cannot agree with an end it cannot read, but takes its word that it was not refused', () => {
    const launch = { seq: 1, attack: 'egress' };
    const end = (payload: unknown) => ({ seq: 2, workItem: '1', version: 1, payload });
    expect(judge(end({ outcome: 'refused' }), launch, new Map()).verdict).toBe('wrong-mechanism');
    expect(judge(end({ outcome: 'not-refused' }), launch, new Map()).verdict).toBe('not-refused');
  });

  it('cannot agree with an end of another attack than the one launched', () => {
    const end = { seq: 2, workItem: '1', version: 1, payload: finished('image', [9]) };
    expect(judge(end, { seq: 1, attack: 'egress' }, new Map())).toEqual({
      verdict: 'wrong-mechanism',
      why: 'it ends a launch of egress, not image',
    });
  });
});
