/**
 * The store's grants are exactly those `policy/store-grants.ts` sets out: a grant that grows, a role that gains one or
 * a membership that changes fails here until the table says so. Then what each worker's role may and may not do, as
 * the worker would try it; that only Martin's roles append his commands; and the tables of signing in.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ADMIN_TYPES,
  EVENT_TYPES,
  type EventType,
  type InboxSignal,
  LINE_ONLY_TYPES,
  type NewEvent,
  PROOFS_ONLY_TYPES,
  REFUSAL_MECHANISMS,
  type RefusalMechanism,
  VERSIONS,
} from '@software-factory/events';
import type { JSONValue, Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ENROLMENT_CODE, PASSKEYS, SESSION } from '../../../policy/access.ts';
import { mayAppend, REFUSAL_READS, REFUSAL_ROWS, REFUSALS } from '../../../policy/refusals.ts';
import { MARTINS_ROLES, PROOFS_ONLY_ROWS, STORE_GRANTS } from '../../../policy/store-grants.ts';
import { DiskArtifacts } from '../src/artifacts.ts';
import { EventWriter } from '../src/events.ts';
import { sendSignal } from '../src/inbox.ts';
import { type Database, freshDatabase } from './database.ts';
import { WORKERS } from './postgres.ts';

let db: Database;

beforeAll(async () => {
  db = await freshDatabase('grants');
});

afterAll(() => db?.end());

/** `insert (b, a)` as `insert (a, b)`, so the table may name columns in any order. */
const normal = (grant: string) => {
  const [, privilege, columns] = /^(\w+)(?: \((.+)\))?$/.exec(grant) ?? [];
  if (!privilege) throw new Error(`${grant} is not a privilege, or one with columns`);
  return columns ? `${privilege} (${columns.split(/,\s*/).sort().join(', ')})` : privilege;
};

interface Granted {
  role: string;
  object: string;
  privilege: string;
  columns: string[] | null;
}

/** Every grant on a table, view or sequence in the store's schema, but its owner's, as `policy/store-grants.ts` puts it. */
async function granted(): Promise<Record<string, Record<string, string[]>>> {
  const rows = await db.owner<Granted[]>`
    with objects as (
      select c.oid, c.relname, c.relowner, c.relacl from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
    )
    select coalesce(r.rolname, 'PUBLIC') as role, o.relname as object, lower(a.privilege_type) as privilege,
           null::text[] as columns
    from objects o cross join aclexplode(o.relacl) a left join pg_roles r on r.oid = a.grantee
    where a.grantee <> o.relowner
    union all
    select coalesce(r.rolname, 'PUBLIC'), o.relname, lower(a.privilege_type), array_agg(att.attname::text)
    from objects o join pg_attribute att on att.attrelid = o.oid and att.attnum > 0 and not att.attisdropped
    cross join aclexplode(att.attacl) a left join pg_roles r on r.oid = a.grantee
    where a.grantee <> o.relowner
    group by 1, 2, 3`;
  const found: Record<string, Record<string, string[]>> = {};
  for (const row of rows) {
    found[row.role] ??= {};
    const on = found[row.role] as Record<string, string[]>;
    on[row.object] = [
      ...(on[row.object] ?? []),
      normal(row.columns ? `${row.privilege} (${row.columns})` : row.privilege),
    ];
  }
  return found;
}

describe('the grants', () => {
  it('are exactly those policy/store-grants.ts sets out, role by role', async () => {
    const found = await granted();
    const roles = new Set([...Object.keys(STORE_GRANTS), ...Object.keys(found)]);
    for (const role of roles) {
      const declared = (STORE_GRANTS as Record<string, { on: Record<string, readonly string[]> }>)[role]?.on;
      const want = Object.fromEntries(
        Object.entries(declared ?? {}).map(([object, grants]) => [object, grants.map(normal).sort()]),
      );
      const got = Object.fromEntries(
        Object.entries(found[role] ?? {}).map(([object, grants]) => [object, grants.sort()]),
      );
      expect(got, `${role}'s grants`).toEqual(want);
    }
  });

  it('let each role at only the rows the table names, on the tables with row security', async () => {
    const policies = await db.owner<
      { table: string; command: string; roles: string[]; using: string; check: string }[]
    >`
      select tablename as table, lower(cmd) as command, roles::text[] as roles, qual as using, with_check as check
      from pg_policies where schemaname = 'public' and permissive = 'PERMISSIVE'`;
    // As Postgres prints a condition, and as the table writes it: no casts to text, `in` for `= any (array[...])` and
    // `not in` for `<> all (array[...])`.
    const condition = (printed: string | null) =>
      printed
        ?.replaceAll(/::text(\[\])?/g, '')
        .replaceAll(/(\w+) = ANY \(ARRAY\[(.+?)\]\)/g, '$1 in ($2)')
        .replaceAll(/(\w+) <> ALL \(ARRAY\[(.+?)\]\)/g, '$1 not in ($2)')
        .replace(/^\((.*)\)$/, '$1');
    const found: Record<string, Record<string, Record<string, string>>> = {};
    for (const policy of policies) {
      const using = condition(policy.using);
      const check = condition(policy.check);
      const rows = using && check && using !== check ? `using ${using}, check ${check}` : (using ?? check ?? '');
      for (const role of policy.roles) {
        found[role] ??= {};
        const tables = found[role] as Record<string, Record<string, string>>;
        tables[policy.table] ??= {};
        const commands = tables[policy.table] as Record<string, string>;
        expect(
          commands[policy.command],
          `${role} has two policies for ${policy.command} on ${policy.table}`,
        ).toBeUndefined();
        commands[policy.command] = rows;
      }
    }
    const declared = Object.fromEntries(
      Object.entries(STORE_GRANTS as Record<string, { rows?: Record<string, Record<string, string>> }>).flatMap(
        ([role, grants]) => (grants.rows ? [[role, grants.rows]] : []),
      ),
    );
    expect(found).toEqual(declared);

    // Row security is on wherever the table names rows, and nowhere else, so none can be switched off unseen.
    const secured = await db.owner<{ relname: string }[]>`
      select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relrowsecurity order by 1`;
    expect(secured.map((t) => t.relname)).toEqual(
      [...new Set(Object.values(declared).flatMap((tables) => Object.keys(tables)))].sort(),
    );
  });

  it('give each role the memberships the table names, and no others', async () => {
    const members = await db.owner<{ role: string; member_of: string[] }[]>`
      select r.rolname as role,
             array(select b.rolname::text from pg_auth_members m join pg_roles b on b.oid = m.roleid
                   where m.member = r.oid order by 1) as member_of
      from pg_roles r where r.rolname = any(${Object.keys(STORE_GRANTS)})`;
    expect(Object.fromEntries(members.map((m) => [m.role, m.member_of]))).toEqual(
      Object.fromEntries(
        Object.entries(STORE_GRANTS).map(([role, grants]) => [role, 'memberOf' in grants ? [...grants.memberOf] : []]),
      ),
    );
  });

  it('let only the roles the table names call a function that runs with its owner’s rights', async () => {
    const callers = await db.owner<{ fn: string; role: string }[]>`
      select p.oid::regprocedure::text as fn,
             coalesce(r.rolname, 'PUBLIC') as role
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      cross join aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
      left join pg_roles r on r.oid = a.grantee
      where n.nspname = 'public' and p.prosecdef and a.grantee <> p.proowner and a.privilege_type = 'EXECUTE'`;
    const found: Record<string, string[]> = {};
    for (const { fn, role } of callers) found[role] = [...(found[role] ?? []), fn].sort();
    const declared = Object.fromEntries(
      Object.entries(STORE_GRANTS as Record<string, { calls?: readonly string[] }>).flatMap(([role, grants]) =>
        grants.calls ? [[role, [...grants.calls].sort()]] : [],
      ),
    );
    expect(found).toEqual(declared);
    await expect(db.as.line`select * from forget_reports(now())`).rejects.toThrow('permission denied');
    await expect(db.as.triage`select * from forget_reports(now())`).resolves.toHaveLength(1);
  });

  it('let every worker log in as itself, and nobody as the role they share or as the writer', async () => {
    const roles = await db.owner<{ rolname: string; rolcanlogin: boolean }[]>`
      select rolname, rolcanlogin from pg_roles where rolname like 'factory\\_%'`;
    // 0024 drops the writer, or, where another database on the server still grants it something, leaves it there
    // unable to log in; the grants above show it holds nothing here.
    const { factory_writer: writer, ...rest } = Object.fromEntries(roles.map((r) => [r.rolname, r.rolcanlogin]));
    expect(writer ?? false).toBe(false);
    expect(rest).toEqual({
      factory_worker: false,
      ...Object.fromEntries(WORKERS.map((w) => [`factory_${w}`, true])),
      factory_admin: true,
      factory_operator: true,
      factory_enrol: true,
      factory_proofs: true,
    });
    for (const worker of WORKERS) {
      const [me] = await db.as[worker]<{ me: string }[]>`select current_user as me`;
      expect(me?.me).toBe(`factory_${worker}`);
    }
  });
});

const artifacts = new DiskArtifacts(mkdtempSync(join(tmpdir(), 'artifacts-')));
const opened = (workItem: string): NewEvent<'work-item.opened'> => ({
  id: crypto.randomUUID(),
  ts: new Date().toISOString(),
  work_item: workItem,
  type: 'work-item.opened',
  version: 2,
  actor: 'visitor',
  summary: 'A visitor sent a report',
  payload: { kind: 'visitor-report', title: 'A report', sample: true, visitor: { key: 'amber-otter' } },
  artifacts: [],
});

/** A signal from a sense, as the inbox takes it. */
const signal = (sense: 'probe' | 'crawler' | 'metrics' | 'logs' | 'canary'): InboxSignal => ({
  sense,
  check: 'home journey',
  route: '/',
  version: 'v1.0.0',
  symptom: 'server-error',
  observedAt: new Date().toISOString(),
  artifacts: [],
});

describe('each worker', () => {
  it('has its signals kept by id alone: the inbox has no other unique key', async () => {
    // sendSignal's `on conflict do nothing` names no key, so that a sense needs no right to read the inbox; this
    // keeps it from swallowing a conflict on any other.
    const unique = await db.owner<{ name: string }[]>`
      select indexrelid::regclass::text as name from pg_index where indrelid = 'inbox'::regclass and indisunique`;
    expect(unique.map((i) => i.name)).toEqual(['inbox_pkey']);
  });

  it('appends and reads events through the role they share', async () => {
    let n = 3000;
    for (const worker of WORKERS) {
      const [stored] = await new EventWriter(db.as[worker], { kind: 'sample', artifacts }).append(opened(String(++n)));
      expect(stored?.seq).toBeGreaterThan(0);
      await expect(db.as[worker]`update events set summary = 'rewritten'`).rejects.toThrow('permission denied');
    }
  });

  it('sends only its own senses’ signals to the inbox', async () => {
    const sends = { probes: 'probe', crawler: 'crawler', intake: 'metrics', logs: 'logs', line: 'canary' } as const;
    for (const [worker, sense] of Object.entries(sends)) {
      const sql = db.as[worker as keyof typeof sends];
      const id = await sendSignal(sql, signal(sense));
      // Sent again with its id, it is dropped, as a sender that cannot tell whether it sent it relies on.
      await sendSignal(sql, signal(sense), id);
      const other = sense === 'probe' ? 'crawler' : 'probe';
      await expect(sendSignal(sql, signal(other)), `${worker} sending a ${other} signal`).rejects.toThrow(
        'row-level security',
      );
    }
    await expect(sendSignal(db.as.triage, signal('probe'))).rejects.toThrow('permission denied');
    await expect(sendSignal(db.as.gateway, signal('probe'))).rejects.toThrow('permission denied');
  });

  it('leaves what triage made of a signal to triage', async () => {
    const id = await sendSignal(db.as.probes, signal('probe'));
    for (const worker of WORKERS.filter((w) => w !== 'triage')) {
      await expect(
        db.as[worker]`update inbox set outcome = 'counted', triaged_at = now() where id = ${id}`,
      ).rejects.toThrow('permission denied');
      await expect(db.as[worker]`delete from inbox where id = ${id}`).rejects.toThrow('permission denied');
    }
    // Triage deletes only the repeats it counted: row security keeps every other signal, whatever the query asks.
    expect((await db.as.triage`delete from inbox where id = ${id}`).count).toBe(0);
    await db.as.triage`update inbox set outcome = 'counted', triaged_at = now() where id = ${id}`;
    expect((await db.as.triage`delete from inbox where id = ${id}`).count).toBe(1);
  });

  it('cannot move a work item on the line, or end a job’s token, unless it is the line', async () => {
    await db.owner`insert into line (work_item, stage) values ('3100', 'plan')`;
    await db.owner`insert into job_tokens (token_sha256, job, work_item, agent)
                   values (${'a'.repeat(64)}, 'plan-3100-1', '3100', 'planner')`;
    for (const worker of WORKERS.filter((w) => w !== 'line')) {
      await expect(db.as[worker]`update line set stage = 'ended' where work_item = '3100'`).rejects.toThrow(
        'permission denied',
      );
      await expect(db.as[worker]`update job_tokens set ended_at = now() where job = 'plan-3100-1'`).rejects.toThrow(
        'permission denied',
      );
    }
    await db.as.line`update job_tokens set ended_at = now() where job = 'plan-3100-1'`;
    // Not even the line may set a row's own facts: when it was taken, or when a token was issued.
    await expect(db.as.line`update line set taken_at = now() where work_item = '3100'`).rejects.toThrow(
      'permission denied',
    );
    await expect(
      db.as.line`insert into job_tokens (token_sha256, job, work_item, agent, issued_at)
                 values (${'b'.repeat(64)}, 'plan-3100-2', '3100', 'planner', now() - interval '1 day')`,
    ).rejects.toThrow('permission denied');
  });

  it('keeps only its own sense’s looks, and reads only the signals it needs', async () => {
    const look = (sense: string) =>
      db.owner.json({ sense, check: 'home journey', route: '/', path: '/', elements: [] });
    await db.owner`insert into looks (sense, "check", route, path, elements, seen_at)
                   values ('probe', 'home journey', '/', '/', ${look('probe')}, now())`;
    await expect(
      db.as.crawler`insert into looks (sense, "check", route, path, elements, seen_at)
                    values ('probe', 'other', '/', '/', '[]', now())`,
    ).rejects.toThrow('row-level security');
    expect((await db.as.crawler`update looks set path = '/elsewhere' where sense = 'probe'`).count).toBe(0);
    expect(await db.as.crawler`select path from looks where sense = 'probe'`).toEqual([]);
    expect(await db.as.probes`select path from looks where sense = 'probe'`).toEqual([{ path: '/' }]);
    // A visitor's report is read by triage alone, waiting or not, and a counted signal by neither the probes nor the
    // log watcher.
    const report = await sendSignal(db.as.logs, {
      sense: 'report',
      check: 'report widget',
      route: '/',
      version: 'v1.0.0',
      observedAt: new Date().toISOString(),
      report: { page: '/', text: 'The lid is missing' },
      artifacts: [],
    });
    expect(await db.as.probes`select signal from inbox where signal->>'sense' = 'report'`).toEqual([]);
    await db.as.triage`update inbox set outcome = 'counted', triaged_at = now() where id = ${report}`;
    expect(await db.as.probes`select signal from inbox where triaged_at is not null`).toEqual([]);
    expect((await db.as.logs`select sense from inbox`).every((r) => ['logs', 'report'].includes(r.sense))).toBe(true);
  });

  it('cannot delete a picture unless it is the probes', async () => {
    for (const worker of WORKERS.filter((w) => w !== 'probes')) {
      await expect(db.as[worker]`delete from pictures`).rejects.toThrow('permission denied');
    }
    expect((await db.as.probes`delete from pictures`).count).toBe(0);
  });

  it('keeps a flag’s pictures as the probes alone write them, and the line reads them', async () => {
    const shot = { kind: 'screenshot', hash: 'f'.repeat(64), size: 1 };
    await db.as.probes`
      insert into flag_pictures (flag, stage, revision, version, path, route, shot)
      values ('gift-note', 'off', 'r1', ${'a'.repeat(40)}, '/', '/', ${db.as.probes.json(shot)})`;
    expect(await db.as.line`select flag, stage from flag_pictures`).toEqual([{ flag: 'gift-note', stage: 'off' }]);
    for (const worker of WORKERS.filter((w) => w !== 'probes')) {
      await expect(
        db.as[worker]`insert into flag_pictures (flag, stage, revision, version, path, route, shot)
                      values ('x', 'off', 'r1', 'v', '/', '/', '{}')`,
      ).rejects.toThrow('permission denied');
      await expect(db.as[worker]`delete from flag_pictures`).rejects.toThrow('permission denied');
    }
    await expect(db.as.probes`update flag_pictures set route = '/x'`).rejects.toThrow('permission denied');
    expect((await db.as.probes`delete from flag_pictures`).count).toBe(1);
  });
});

/** One of Martin's commands, as `actor: martin`. A command added to ADMIN_TYPES needs its payload here. */
const command = (type: EventType, workItem: string | null = '3200'): NewEvent =>
  ({
    id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    work_item: ON_WORK_ITEM.includes(type) ? workItem : null,
    type,
    version: VERSIONS[type],
    actor: 'martin',
    summary: `${type}, as Martin`,
    payload: PAYLOADS[type] ?? {},
    artifacts: [],
  }) as NewEvent;

/** Martin's commands that are on a work item: the rest are the line's. */
const ON_WORK_ITEM: readonly EventType[] = ['hold.answered', 'flag.staged', 'improvement.requested'];

/** A payload for each of Martin's commands that has one to give. */
const PAYLOADS: Partial<Record<EventType, object>> = {
  'hold.answered': { decision: 'approved' },
  'line.stopped': { reason: 'Martin stopped the line' },
  'line.started': { reason: 'Back from lunch' },
  'admin.signed-out': { everywhere: false },
  'passkey.revoked': { from: 'console' },
  'release.controlled': { action: 'pause', release: '68ff668868-4', version: 'v0.9.4', weight: 25 },
  'settings.changed': {
    agents: {
      planner: { model: 'claude-sonnet-5-5', effort: 'medium' },
      coder: { model: 'claude-opus-5-5', effort: 'high' },
      reviewer: { model: 'claude-sonnet-5-5', effort: 'medium' },
      describer: { model: 'claude-sonnet-5-5', effort: 'low' },
    },
    caps: { dayUsd: 20, monthUsd: null, workItemUsd: 1 },
    changes: [{ field: 'model', agent: 'coder', before: 'claude-sonnet-5-5', after: 'claude-opus-5-5' }],
  },
  'controls.changed': {
    autonomy: 'guarded',
    newWork: true,
    autoMerge: false,
    take: null,
    autoRollback: true,
    change: { control: 'autonomy', before: 'supervised', after: 'guarded' },
  },
  'alerts.switched': { phone: false },
  'flag.staged': {
    flag: 'delivery-dates',
    from: { stage: 'checks' },
    to: { stage: 'share', share: 50 },
    action: 'flag.widen',
    revision: 'r3',
    steppedUp: true,
  },
  'improvement.requested': { words: 'Show when an order would arrive on each product page.', steppedUp: true },
};

/** A work item of kind improvement, opened as Martin asks for one. */
const improvement = (workItem: string, kind: 'improvement' | 'defect-fix' = 'improvement'): NewEvent =>
  ({
    ...opened(workItem),
    actor: 'martin',
    summary: 'Martin asked for an improvement from the console',
    payload: { kind, title: 'Delivery dates on each product', sample: true, category: 'improvement' },
  }) as NewEvent;

const writer = (sql: Sql) => new EventWriter(sql, { kind: 'sample', artifacts });

describe("Martin's commands", () => {
  it('are the same types to the store as to the factory', async () => {
    const rows = await db.owner<{ type: string }[]>`
      select type from unnest(${[...EVENT_TYPES, 'not.a-command']}::text[]) as type where admin_event(type)`;
    expect(rows.map((r) => r.type).sort()).toEqual([...ADMIN_TYPES].sort());
  });

  it('are refused from every worker’s role and the scoreboard’s', async () => {
    await writer(db.operator).append(opened('3200'));
    for (const type of ADMIN_TYPES) {
      for (const [name, sql] of [...Object.entries(db.as), ['scoreboard', db.scoreboard]]) {
        // The scoreboard's own trigger (0012) refuses it first.
        await expect(writer(sql as Sql).append(command(type, '3200')), `${type} from ${name}`).rejects.toThrow(
          /row-level security|the scoreboard appends its own figures/,
        );
      }
    }
    expect(await db.owner`select 1 from events where type in ${db.owner(ADMIN_TYPES)}`).toEqual([]);
    // Were the guard to fail, the console would still not show one.
    await db.owner`alter table events disable row level security`;
    try {
      await writer(db.as.line).append(command('line.stopped'));
    } finally {
      await db.owner`alter table events enable row level security`;
    }
    expect(await db.owner`select 1 from events where type = 'line.stopped'`).toHaveLength(1);
    expect(await db.reader`select seq from events where type = 'line.stopped'`).toEqual([]);
    await writer(db.admin).append(command('line.started'));
    expect(await db.reader`select seq from events where type = 'line.started'`).toHaveLength(1);
  });

  it('are appended by Martin’s roles alone: the admin service nothing else, his command line anything', async () => {
    await writer(db.admin).append(command('hold.answered', '3200'));
    await writer(db.admin).append(command('line.stopped'));
    await writer(db.operator).append(command('line.started'));
    await expect(writer(db.admin).append(opened('3201'))).rejects.toThrow('row-level security');
    await writer(db.operator).append(opened('3201'));
    expect(MARTINS_ROLES.sort()).toEqual(['factory_admin', 'factory_enrol', 'factory_operator']);
  });

  it('open an improvement, with its request, and no worker can open one', async () => {
    // The admin service numbers it as triage does, and appends its opening and his request together.
    const [number] = await db.admin<{ next: string }[]>`select nextval('work_items')::text as next`;
    const workItem = number?.next ?? '';
    await writer(db.admin).append([improvement(workItem), command('improvement.requested', workItem)]);
    // A work item of any other kind is the workers' to open, never the admin service's.
    await expect(writer(db.admin).append(improvement('3211', 'defect-fix'))).rejects.toThrow('row-level security');
    let n = 3220;
    for (const [name, sql] of Object.entries(db.as)) {
      await expect(writer(sql).append(improvement(String(++n))), name).rejects.toThrow('row-level security');
    }
    // His command line opens anything, the samples' improvements among them.
    await writer(db.operator).append(improvement('3212'));
    expect(
      (
        await db.owner<{ appended_by: string }[]>`
        select appended_by from events where type = 'work-item.opened' and payload->>'kind' = 'improvement'
        order by seq`
      ).map((row) => row.appended_by),
    ).toEqual(['factory_admin', 'factory_operator']);
  });

  it('carry the role that appended them, which the store sets and no client may', async () => {
    const [mine] = await writer(db.as.line).append(opened('3202'));
    const [answer] = await writer(db.admin).append(command('hold.answered', '3202'));
    const stamped = await db.owner<{ seq: string; appended_by: string }[]>`
      select seq, appended_by from events where seq in ${db.owner([mine?.seq ?? 0, answer?.seq ?? 0])} order by seq`;
    expect(stamped.map((row) => row.appended_by)).toEqual(['factory_line', 'factory_admin']);
    const insert = (sql: Sql, as: string | null) => sql`
      insert into events (id, ts, work_item, type, version, actor, summary, payload, artifacts, public, sample,
                          appended_by)
      values (${crypto.randomUUID()}, now(), '3202', 'work-item.summarised', 1, 'planner', 'A summary', '{}', '[]',
              '{}', true, ${as})`;
    await expect(insert(db.as.line, 'factory_admin')).rejects.toThrow('records the role that appends an event');
    await expect(insert(db.as.line, null)).rejects.toThrow('records the role that appends an event');
    await expect(insert(db.owner, 'factory_admin')).rejects.toThrow('records the role that appends an event');
    // Nor may a worker take one of Martin's roles.
    await expect(db.as.line`set role factory_admin`).rejects.toThrow('permission denied');
    // The console's server sees who appended an event, a role's name, so it can count a refusal by who recorded it.
    const read = await db.reader<{ appended_by: string }[]>`
      select appended_by from events where seq in ${db.reader([mine?.seq ?? 0, answer?.seq ?? 0])} order by seq`;
    expect(read.map((row) => row.appended_by)).toEqual(['factory_line', 'factory_admin']);
  });
});

describe("the line's record of a release", () => {
  /** An event of a type, inserted as it stands, real or a sample, as any client could try. */
  const insert = (sql: Sql, type: string, sample: boolean) => sql`
    insert into events (id, ts, work_item, type, version, actor, summary, payload, artifacts, public, sample)
    values (${crypto.randomUUID()}, now(), null, ${type}, 1, 'rollouts', 'A release', '{}', '[]', '{}', ${sample})`;

  it('is the same types to the store as to the factory', async () => {
    const rows = await db.owner<{ type: string }[]>`
      select type from unnest(${[...EVENT_TYPES, 'not.a-release']}::text[]) as type where line_only_event(type)`;
    expect(rows.map((r) => r.type).sort()).toEqual([...LINE_ONLY_TYPES].sort());
  });

  it('is appended by the line alone, and by no other role, in a real store', async () => {
    const real = await freshDatabase('line_only');
    try {
      for (const type of LINE_ONLY_TYPES) {
        await insert(real.as.line, type, false);
        const others: [string, Sql][] = [
          ...Object.entries(real.as).filter(([name]) => name !== 'line'),
          ['admin', real.admin],
          ['operator', real.operator],
          ['enrol', real.enrol],
          ['scoreboard', real.scoreboard],
          ['console', real.reader],
        ];
        for (const [name, sql] of others) {
          await expect(insert(sql, type, false), `${type} from ${name}`).rejects.toThrow(
            /row-level security|permission denied|the scoreboard appends its own figures/,
          );
        }
      }
      const appended = await real.owner<{ type: string; appended_by: string }[]>`
        select type, appended_by from events order by seq`;
      expect(appended).toEqual(LINE_ONLY_TYPES.map((type) => ({ type, appended_by: 'factory_line' })));
      // A release's start is the line's to record too, but not held to it: nothing trusts it alone.
      await insert(real.as.triage, 'release.started', false);
    } finally {
      await real.end();
    }
  });

  it("is appended as a sample by Martin's command line too, for `make samples`", async () => {
    await insert(db.operator, 'release.rolled-back', true);
    await insert(db.as.line, 'release.rolled-back', true);
    await expect(insert(db.as.triage, 'release.rolled-back', true)).rejects.toThrow('row-level security');
  });
});

describe("a guardrail's proof", () => {
  /** An event of a type, inserted as it stands, real or a sample, as any client could try. */
  const insert = (sql: Sql, type: string, sample: boolean, payload: object = {}) => sql`
    insert into events (id, ts, work_item, type, version, actor, summary, payload, artifacts, public, sample)
    values (${crypto.randomUUID()}, now(), null, ${type}, 1, 'martin', 'A proof', ${sql.json(payload as JSONValue)},
            '[]', '{}', ${sample})`;
  const proved = (held = true): NewEvent<'guardrail.proved'> => ({
    id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    work_item: null,
    type: 'guardrail.proved',
    version: VERSIONS['guardrail.proved'],
    actor: 'martin',
    summary: held ? 'The egress proof held' : 'The egress proof did not hold',
    payload: {
      guardrails: [5],
      proof: 'egress',
      mechanism: 'egress-policy',
      held,
      output: 'PASS  a runner reaches the gateway',
      commit: 'a'.repeat(40),
    },
    artifacts: [],
  });

  it('is the type the store holds to the proofs', () => {
    expect([...PROOFS_ONLY_TYPES]).toEqual(['guardrail.proved']);
  });

  it('is appended by the proofs alone, and by no other role, in a real store; and the proofs append nothing else', async () => {
    const real = await freshDatabase('proofs_only');
    try {
      const roles: [string, Sql][] = [
        ...Object.entries(real.as).map(([name, sql]): [string, Sql] => [`factory_${name}`, sql]),
        ['factory_admin', real.admin],
        ['factory_operator', real.operator],
        ['factory_enrol', real.enrol],
        ['scoreboard_writer', real.scoreboard],
        ['console_reader', real.reader],
        ['metrics_reader', real.metrics],
      ];
      for (const [role, sql] of roles) {
        await expect(insert(sql, 'guardrail.proved', false), role).rejects.toThrow(
          /row-level security|permission denied|the scoreboard appends its own figures/,
        );
      }
      await insert(real.proofs, 'guardrail.proved', false);
      for (const type of EVENT_TYPES.filter((type) => !PROOFS_ONLY_TYPES.includes(type))) {
        await expect(insert(real.proofs, type, false), type).rejects.toThrow('row-level security');
      }
      expect(await real.owner`select type, appended_by from events order by seq`).toEqual([
        { type: 'guardrail.proved', appended_by: 'factory_proofs' },
      ]);
      // Nor may another role take the proofs' name.
      await expect(real.as.line`set role factory_proofs`).rejects.toThrow('permission denied');
      await expect(real.admin`set role factory_proofs`).rejects.toThrow('permission denied');
    } finally {
      await real.end();
    }
  });

  it("is appended as a sample by Martin's command line too, for `make samples`, and by no other role", async () => {
    await insert(db.operator, 'guardrail.proved', true);
    await insert(db.proofs, 'guardrail.proved', true);
    await expect(insert(db.as.line, 'guardrail.proved', true)).rejects.toThrow('row-level security');
    await expect(insert(db.admin, 'guardrail.proved', true)).rejects.toThrow('row-level security');
  });

  it('is appended through the store’s writer, and an append retried is stored once', async () => {
    const event = proved(false);
    const [first] = await writer(db.proofs).append(event);
    const [again] = await writer(db.proofs).append(event);
    expect(again?.seq).toBe(first?.seq);
    expect(await db.owner`select appended_by from events where id = ${event.id}`).toEqual([
      { appended_by: 'factory_proofs' },
    ]);
  });

  it('is read by the proofs with only what their proofs read, each from the role that alone appends it', async () => {
    const real = await freshDatabase('proofs_read');
    try {
      const refused = (mechanism: string) => ({
        mechanism,
        action: 'Call a model',
        output: 'Refused.',
        guardrails: mechanism === 'gateway' ? [9] : [11],
      });
      const appended = async (sql: Sql, type: string, payload: object = {}) => {
        const [row] = await sql<{ seq: string }[]>`
          insert into events (id, ts, work_item, type, version, actor, summary, payload, artifacts, public, sample)
          values (${crypto.randomUUID()}, now(), null, ${type}, ${type === 'action.refused' ? 3 : 1}, 'martin', 'An event',
                  ${sql.json(payload as JSONValue)}, '[]',
                  ${sql.json({ payload } as JSONValue)}, false)
          returning seq`;
        return row?.seq;
      };
      const read = [
        await appended(real.proofs, 'guardrail.proved'),
        await appended(real.operator, 'line.stopped'),
        await appended(real.admin, 'line.started'),
        await appended(real.as.line, 'release.aborted'),
        await appended(real.as.line, 'release.rolled-back'),
      ];
      // What no proof reads, and what another role appended that no proof trusts. No proof reads a refusal, the
      // gateway's included: its refusal of a stopped line is proved from CI.
      await appended(real.as.gateway, 'action.refused', refused('gateway'));
      await appended(real.as.line, 'action.refused', refused('scope-fence'));
      await appended(real.as.triage, 'work-item.summarised');
      await appended(real.as.line, 'release.started');
      await appended(real.as.line, 'canary.stepped');
      await appended(real.admin, 'settings.changed');
      await appended(real.operator, 'work-item.summarised');
      const seen = await real.proofs<{ seq: string }[]>`select seq from events order by seq`;
      expect(seen.map((row) => row.seq)).toEqual(read);
      // As the line above shows, said plainly: the role sees no refusal at all.
      expect(await real.proofs`select seq from events where type = 'action.refused'`).toEqual([]);
      // When each work item was taken onto the line, and nothing more of it, nor of any other table.
      await real.as.line`insert into line (work_item, stage) values ('1001', 'plan')`;
      expect(await real.proofs`select work_item from line where taken_at <= now()`).toEqual([{ work_item: '1001' }]);
      await expect(real.proofs`select held_by from line`).rejects.toThrow('permission denied');
      for (const table of ['inbox', 'job_tokens', 'model_calls', 'step_logs', 'sessions', 'passkeys']) {
        await expect(real.proofs.unsafe(`select 1 from ${table}`), table).rejects.toThrow('permission denied');
      }
    } finally {
      await real.end();
    }
  });
});

describe('a refusal', () => {
  /** The guardrails a mechanism shows, or the repository's for one that is no mechanism. */
  const shown = (mechanism: string): number[] =>
    mechanism in REFUSALS
      ? [...new Set(Object.values(REFUSALS[mechanism as RefusalMechanism].guardrails).flat())]
      : [1];

  /**
   * A refusal by a mechanism, inserted as it stands, real or a sample, as any client could try: with the guardrails
   * its mechanism shows (none, for `null`), and a public view that names them, unless it says otherwise.
   */
  const refuse = (
    sql: Sql,
    mechanism: string,
    sample: boolean,
    {
      version = 3,
      guardrails = shown(mechanism) as unknown,
      seen = {} as Record<string, unknown>,
    }: { version?: number; guardrails?: unknown; seen?: Record<string, unknown> } = {},
  ) => {
    const payload = {
      mechanism,
      action: 'An action',
      output: 'Refused.',
      ...(guardrails !== null && { guardrails }),
    };
    const view = { summary: 'Refused', payload: { ...payload, ...seen }, artifacts: [] };
    return sql`
      insert into events (id, ts, work_item, type, version, actor, summary, payload, artifacts, public, sample)
      values (${crypto.randomUUID()}, now(), '3300', 'action.refused', ${version}, 'factory', 'Refused',
              ${sql.json(payload as JSONValue)}, '[]', ${sql.json(view as JSONValue)}, ${sample})`;
  };

  it('is held to its mechanism’s roles by the table in policy/refusals.ts, mechanism by mechanism', async () => {
    const mechanisms = [...REFUSAL_MECHANISMS, 'not-a-mechanism'];
    const rows = await db.owner<{ mechanism: string; roles: string[] }[]>`
      select mechanism, refusal_appenders(mechanism) as roles from unnest(${mechanisms}::text[]) as mechanism`;
    expect(Object.fromEntries(rows.map((row) => [row.mechanism, [...row.roles].sort()]))).toEqual({
      ...Object.fromEntries(
        Object.entries(REFUSALS).map(([mechanism, rule]) => [mechanism, [...rule.appendedBy].sort()]),
      ),
      'not-a-mechanism': [],
    });
  });

  it('shows only the guardrails policy/refusals.ts gives its mechanism, mechanism by mechanism', async () => {
    const mechanisms = [...REFUSAL_MECHANISMS, 'not-a-mechanism'];
    const rows = await db.owner<{ mechanism: string; guardrails: number[] }[]>`
      select mechanism, refusal_guardrails(mechanism) as guardrails from unnest(${mechanisms}::text[]) as mechanism`;
    expect(Object.fromEntries(rows.map((row) => [row.mechanism, [...row.guardrails].sort((a, b) => a - b)]))).toEqual({
      ...Object.fromEntries(REFUSAL_MECHANISMS.map((m) => [m, shown(m).sort((a, b) => a - b)])),
      'not-a-mechanism': [],
    });
  });

  it('is held by the restrictive policies on the store, for every role', async () => {
    const restrictive = await db.owner<
      { name: string; table: string; command: string; roles: string[]; check: string }[]
    >`
      select policyname as name, tablename as table, lower(cmd) as command, roles::text[] as roles,
             with_check as check
      from pg_policies where schemaname = 'public' and permissive = 'RESTRICTIVE' order by policyname`;
    // As the table writes it: no casts to text, on one line, and no parentheses round the whole.
    const check = (printed: string) =>
      printed
        .replaceAll('::text', '')
        .replace(/\s+/g, ' ')
        .replace(/^\((.*)\)$/, '$1');
    expect(restrictive.map((policy) => ({ ...policy, check: check(policy.check) }))).toEqual([
      {
        name: 'events_proved_by_the_proofs',
        table: 'events',
        command: 'insert',
        roles: ['public'],
        check: PROOFS_ONLY_ROWS,
      },
      {
        name: 'events_refused_as_it_reads',
        table: 'events',
        command: 'insert',
        roles: ['public'],
        check: REFUSAL_READS,
      },
      {
        name: 'events_refused_by_its_mechanism',
        table: 'events',
        command: 'insert',
        roles: ['public'],
        check: REFUSAL_ROWS,
      },
    ]);
  });

  it('reads in the console as it was appended, under its own mechanism’s guardrails', async () => {
    const real = await freshDatabase('refusals_read');
    try {
      const line = real.as.line;
      // The public view names another mechanism, or other guardrails, than the refusal.
      await expect(refuse(line, 'scope-fence', false, { seen: { mechanism: 'admission-control' } })).rejects.toThrow(
        'row-level security',
      );
      await expect(refuse(line, 'scope-fence', false, { seen: { guardrails: [3] } })).rejects.toThrow(
        'row-level security',
      );
      await expect(refuse(line, 'scope-fence', false, { seen: { mechanism: undefined } })).rejects.toThrow(
        'row-level security',
      );
      // Guardrails its mechanism does not show, none, or not a list of them.
      for (const guardrails of [[3], [11, 1], [11, 11], [], 11, ['11'], null]) {
        await expect(refuse(line, 'scope-fence', false, { guardrails }), JSON.stringify(guardrails)).rejects.toThrow(
          'row-level security',
        );
      }
      await expect(refuse(real.as.gateway, 'gateway', false, { guardrails: [6, 1] })).rejects.toThrow(
        'row-level security',
      );
      // Before version 3 a refusal named no guardrails, and only version 2's mechanisms.
      await expect(refuse(real.as.gateway, 'gateway', false, { version: 2, guardrails: null })).rejects.toThrow(
        'row-level security',
      );
      // Nor any guardrails, in its payload and its public view alike.
      for (const guardrails of [[11], [1], 'any']) {
        await expect(
          refuse(line, 'scope-fence', false, { version: 2, guardrails }),
          `version 2 ${JSON.stringify(guardrails)}`,
        ).rejects.toThrow('row-level security');
      }
      await refuse(line, 'scope-fence', false, { version: 2, guardrails: null });
      await refuse(line, 'admission-control', false, { guardrails: [4] });
      await refuse(real.as.gateway, 'gateway', false, { guardrails: [9] });
      const stored = await real.owner<{ mechanism: string }[]>`
        select payload->>'mechanism' as mechanism from events order by seq`;
      expect(stored.map((row) => row.mechanism)).toEqual(['scope-fence', 'admission-control', 'gateway']);
    } finally {
      await real.end();
    }
  });

  it('is appended by its mechanism’s roles alone, Martin’s and the console’s refused, in a real store', async () => {
    const real = await freshDatabase('refusals');
    try {
      const roles: [string, Sql][] = [
        ...Object.entries(real.as).map(([name, sql]): [string, Sql] => [`factory_${name}`, sql]),
        ['factory_admin', real.admin],
        ['factory_operator', real.operator],
        ['factory_enrol', real.enrol],
        ['scoreboard_writer', real.scoreboard],
        ['console_reader', real.reader],
      ];
      const appended: string[] = [];
      for (const mechanism of [...REFUSAL_MECHANISMS, 'not-a-mechanism']) {
        for (const [role, sql] of roles) {
          const allowed = REFUSAL_MECHANISMS.some((m) => m === mechanism && mayAppend(m, role));
          if (allowed) {
            await refuse(sql, mechanism, false);
            appended.push(`${mechanism} ${role}`);
          } else {
            await expect(refuse(sql, mechanism, false), `${mechanism} from ${role}`).rejects.toThrow(
              /row-level security|permission denied|the scoreboard appends its own figures/,
            );
          }
        }
      }
      const stored = await real.owner<{ mechanism: string; appended_by: string }[]>`
        select payload->>'mechanism' as mechanism, appended_by from events order by seq`;
      expect(stored.map((row) => `${row.mechanism} ${row.appended_by}`)).toEqual(appended);
      expect(appended).toEqual([
        'token-permission factory_line',
        'admission-control factory_line',
        'scope-fence factory_line',
        'github-guard factory_line',
        'review-gate factory_line',
        'gateway factory_gateway',
        'typed-judgement factory_triage',
      ]);
      // Any other event is as it was: a worker appends it whatever its payload names.
      await real.as.probes`
        insert into events (id, ts, work_item, type, version, actor, summary, payload, artifacts, public, sample)
        values (${crypto.randomUUID()}, now(), '3300', 'work-item.summarised', 1, 'planner', 'A summary',
                ${real.as.probes.json({ mechanism: 'gateway' })}, '[]', '{}', false)`;
    } finally {
      await real.end();
    }
  });

  it("is appended as a sample by Martin's command line too, for `make samples`, and by no other role for another", async () => {
    await refuse(db.operator, 'admission-control', true);
    await refuse(db.as.line, 'scope-fence', true);
    await expect(refuse(db.as.triage, 'scope-fence', true)).rejects.toThrow('row-level security');
    await expect(refuse(db.admin, 'scope-fence', true)).rejects.toThrow('row-level security');
  });
});

describe('signing in', () => {
  const hex = (n: number) => n.toString(16).padStart(64, '0');
  const key = (n: number) => `credential-${String(n).padStart(8, '0')}`;
  let codes = 0;
  /** A code from `factory admin enrol`, and a passkey the admin service enrols with it. */
  const enrolled = async (n: number) => {
    const code = hex(++codes);
    await db.enrol`insert into enrolment_codes (code_sha256) values (${code})`;
    await db.admin`update enrolment_codes set used_at = now() where code_sha256 = ${code}`;
    await db.admin`insert into passkeys (id, public_key, name, enrolled_with)
                   values (${key(n)}, '\\x00', ${`Device ${n}`}, ${code})`;
  };

  it('gives no worker, the console or the scoreboard anything of it', async () => {
    for (const [name, sql] of [
      ...Object.entries(db.as),
      ['console', db.reader],
      ['scoreboard', db.scoreboard],
      ['operator', db.operator],
    ]) {
      for (const table of ['passkeys', 'enrolment_codes', 'sessions', 'webauthn_challenges']) {
        await expect((sql as Sql)`select * from ${db.owner(table)}`, `${name} reading ${table}`).rejects.toThrow(
          'permission denied',
        );
      }
    }
  });

  it('lets the line read when each session started, to compare with the sign-ins, and nothing else of it', async () => {
    await db.as.line`select signed_in_at from sessions`;
    for (const column of ['id_sha256', 'passkey', 'expires_at', 'stepped_up_at', 'ended_at', 'ended_by']) {
      await expect(db.as.line`select ${db.owner(column)} from sessions`, column).rejects.toThrow('permission denied');
    }
    await expect(db.as.line`update sessions set ended_at = now()`).rejects.toThrow('permission denied');
  });

  it('lets the enrolment add a code and revoke, and nothing more', async () => {
    await expect(
      db.enrol`insert into enrolment_codes (code_sha256, expires_at) values (${hex(900)}, now() + interval '1 day')`,
    ).rejects.toThrow('permission denied');
    await expect(db.enrol`select code_sha256 from enrolment_codes`).rejects.toThrow('permission denied');
    await expect(db.enrol`select public_key from passkeys`).rejects.toThrow('permission denied');
    await expect(db.enrol`update sessions set expires_at = now() + interval '1 day'`).rejects.toThrow(
      'permission denied',
    );
    // Of the events, it appends the passkeys it revokes, and reads back only those.
    await expect(writer(db.enrol).append(opened('3300'))).rejects.toThrow('row-level security');
    // A command on a work item is refused sooner: the enrolment cannot see the work item it is on.
    for (const type of ADMIN_TYPES.filter((t) => t !== 'passkey.revoked' && !ON_WORK_ITEM.includes(t))) {
      await expect(writer(db.enrol).append(command(type)), type).rejects.toThrow('row-level security');
    }
    const [revoked] = await writer(db.enrol).append(command('passkey.revoked'));
    expect(await db.enrol`select seq from events`).toEqual([{ seq: String(revoked?.seq) }]);
    expect(await db.reader`select seq from events where seq = ${revoked?.seq ?? 0}`).toHaveLength(1);
  });

  it('holds a code to the policy’s ten minutes and five tries, used once', async () => {
    const code = hex(++codes);
    await db.enrol`insert into enrolment_codes (code_sha256) values (${code})`;
    const [row] = await db.admin<{ minutes: number }[]>`
      select extract(epoch from expires_at - created_at) / 60 as minutes from enrolment_codes where code_sha256 = ${code}`;
    expect(Number(row?.minutes)).toBe(ENROLMENT_CODE.minutes);
    for (let i = 0; i < ENROLMENT_CODE.tries; i++) {
      await db.admin`update enrolment_codes set tries = tries + 1 where code_sha256 = ${code}`;
    }
    await expect(db.admin`update enrolment_codes set tries = tries + 1 where code_sha256 = ${code}`).rejects.toThrow(
      'check constraint',
    );
    await db.admin`update enrolment_codes set used_at = now() where code_sha256 = ${code}`;
    await expect(db.admin`update enrolment_codes set used_at = now() where code_sha256 = ${code}`).rejects.toThrow(
      'used once',
    );
  });

  it('holds Martin to two passkeys, and a session to 30 minutes, ended when its passkey is revoked', async () => {
    expect(PASSKEYS.most).toBe(2);
    expect(SESSION.minutes).toBe(30);
    await enrolled(1);
    await enrolled(2);
    await expect(enrolled(3)).rejects.toThrow('two passkeys already');
    const session = hex(500);
    // The store sets a session's 30 minutes from its own clock: the admin service cannot set either end.
    await expect(
      db.admin`insert into sessions (id_sha256, passkey, expires_at)
               values (${session}, ${key(1)}, now() + interval '1 day')`,
    ).rejects.toThrow('permission denied');
    await expect(
      db.admin`insert into sessions (id_sha256, passkey, signed_in_at)
               values (${session}, ${key(1)}, now() - interval '1 day')`,
    ).rejects.toThrow('permission denied');
    await db.admin`insert into sessions (id_sha256, passkey) values (${session}, ${key(1)})`;
    const [lasts] = await db.admin<{ minutes: number }[]>`
      select extract(epoch from expires_at - signed_in_at) / 60 as minutes from sessions where id_sha256 = ${session}`;
    expect(Number(lasts?.minutes)).toBe(SESSION.minutes);
    // Nor can the database's owner keep one longer.
    await expect(
      db.owner`update sessions set expires_at = signed_in_at + interval '31 minutes' where id_sha256 = ${session}`,
    ).rejects.toThrow('sessions_lasts');
    // `factory admin enrol --revoke-others` revokes, and the store ends the passkey's sessions with it.
    await db.enrol`update passkeys set revoked_at = now() where id = ${key(1)}`;
    const [ended] = await db.admin<{ ended_by: string }[]>`select ended_by from sessions where id_sha256 = ${session}`;
    expect(ended?.ended_by).toBe('revoked');
    await expect(db.admin`update passkeys set revoked_at = null where id = ${key(1)}`).rejects.toThrow('stays revoked');
    await expect(
      db.admin`update sessions set ended_at = null, ended_by = null where id_sha256 = ${session}`,
    ).rejects.toThrow('stays ended');
    await enrolled(3);
  });

  it('cuts the sessions it keeps to 30 minutes from their sign-in, ended ones too', async () => {
    // Sessions kept under the eight hours 0023 allowed, before 0031 cut it to 30 minutes.
    const migration = readFileSync(new URL('../migrations/0031_session-30-minutes.sql', import.meta.url), 'utf-8');
    await db.owner`alter table sessions drop constraint sessions_lasts`;
    await db.owner`alter table sessions add constraint sessions_check
                   check (expires_at > signed_in_at and expires_at <= signed_in_at + interval '8 hours')`;
    try {
      const kept = [
        { id: hex(600), signedIn: '1 hour', expires: '7 hours', ended: false },
        { id: hex(601), signedIn: '10 minutes', expires: '7 hours 50 minutes', ended: false },
        { id: hex(602), signedIn: '9 hours', expires: '-1 hour', ended: true },
        { id: hex(603), signedIn: '5 minutes', expires: '25 minutes', ended: false },
      ];
      for (const { id, signedIn, expires, ended } of kept) {
        await db.owner`
        insert into sessions (id_sha256, passkey, signed_in_at, expires_at, ended_at, ended_by)
        values (${id}, ${key(2)}, now() - ${signedIn}::interval, now() + ${expires}::interval,
                ${ended ? db.owner`now() - interval '2 hours'` : null}, ${ended ? 'sign-out' : null})`;
      }
      await db.owner.unsafe(migration);
      const rows = await db.owner<{ id_sha256: string; minutes: number; live: boolean; ended_by: string | null }[]>`
      select id_sha256, extract(epoch from expires_at - signed_in_at) / 60 as minutes, expires_at > now() as live,
             ended_by
      from sessions where id_sha256 in ${db.owner(kept.map((k) => k.id))} order by id_sha256`;
      expect(rows.map((r) => ({ ...r, minutes: Number(r.minutes) }))).toEqual([
        // Signed in an hour ago: it ends at once, and Martin signs in again.
        { id_sha256: hex(600), minutes: 30, live: false, ended_by: null },
        { id_sha256: hex(601), minutes: 30, live: true, ended_by: null },
        // An ended session stays ended, with only its end cut.
        { id_sha256: hex(602), minutes: 30, live: false, ended_by: 'sign-out' },
        // Within 30 minutes already: left as it was.
        { id_sha256: hex(603), minutes: 30, live: true, ended_by: null },
      ]);
      // The trigger that keeps an ended session ended is back on.
      await expect(
        db.owner`update sessions set ended_at = null, ended_by = null where id_sha256 = ${hex(602)}`,
      ).rejects.toThrow('stays ended');
    } finally {
      // Whatever failed, the tests after this one meet the store as 0031 leaves it.
      const [old] = await db.owner`select 1 from pg_constraint where conname = 'sessions_check'`;
      if (old) await db.owner.unsafe(migration);
    }
  });

  it('uses each WebAuthn challenge once', async () => {
    const challenge = 'c'.repeat(43);
    await db.admin`insert into webauthn_challenges (challenge, purpose, expires_at)
                   values (${challenge}, 'sign-in', now() + interval '5 minutes')`;
    await db.admin`update webauthn_challenges set used_at = now() where challenge = ${challenge}`;
    await expect(
      db.admin`update webauthn_challenges set used_at = now() where challenge = ${challenge}`,
    ).rejects.toThrow('used once');
    await expect(
      db.admin`insert into webauthn_challenges (challenge, purpose, expires_at)
               values (${'d'.repeat(43)}, 'step-up', now() + interval '5 minutes')`,
    ).rejects.toThrow('check constraint');
  });
});
