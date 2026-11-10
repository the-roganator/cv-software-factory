/**
 * What a local cluster holds of Martin's, as figures a moved cluster must match: `make upgrade-cluster`
 * (scripts/upgrade-cluster.sh) takes them before it stops the cluster and again once the new one serves the store, and
 * calls the move done only when they match.
 *
 *     node scripts/cluster-figures.ts take <context> [--upto <seq>]    prints the figures, as JSON
 *     node scripts/cluster-figures.ts compare <before.json> <after.json> says what moved, and exits 1 if anything did
 *
 * The figures are counts and digests, never content: nothing of a report, a key or a credential is in them.
 *
 * - The event store: its last seq, and the count and digest of every event up to a seq (the last, before; the same
 *   seq, after). Martin's settings and controls, and every command of his, are events.
 * - Martin's tables, digested whole but for what a sign-in moves: his passkeys, his sessions, the line's place for
 *   each work item, and whether the store holds samples.
 * - Every other table's count, shown beside the other but not judged: a sense may add to the inbox while the cluster
 *   comes back.
 * - The feature flags (the `FeatureFlag` flagd serves, none on a cluster without flagd), the Secrets in `factory`
 *   (the passwords, keys and tokens made once), and which claim each persistent volume is bound to.
 * - Whether the line is stopped: the move refuses a running line, which would move the tables it is compared on.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface Figures {
  lastSeq: number;
  events: { upto: number; count: number; digest: string };
  kept: Record<string, { count: number; digest: string }>;
  counts: Record<string, number>;
  flags: string | null;
  secrets: string;
  volumes: string[];
  line: 'started' | 'stopped' | 'never started';
}

/** Martin's tables, each with the columns that stay put while the cluster is down: a sign-in moves the rest. */
export const KEPT: Record<string, { columns: string; order: string }> = {
  passkeys: { columns: 'id, public_key, name, enrolled_with, enrolled_at, revoked_at', order: 'id' },
  sessions: { columns: 'id_sha256, passkey, signed_in_at, expires_at, ended_at, ended_by', order: 'id_sha256' },
  // Its places, not their stages: a Reject or a close of Martin's moves a stage while the line is stopped.
  line: { columns: 'work_item, taken_at', order: 'work_item' },
  store: { columns: 'sample, chosen_at', order: 'sample' },
};

/**
 * The query that takes the store's figures, events up to `upto` (the last seq when none is given), as one JSON row.
 * Each digest is the md5 of its rows' md5s in order, so a large store is digested a row at a time.
 */
export function storeQuery(upto?: number): string {
  if (upto !== undefined && !(Number.isSafeInteger(upto) && upto >= 0)) throw new Error(`${upto} is not a seq`);
  const bound = upto === undefined ? '(select coalesce(max(seq), 0) from events)' : String(upto);
  const kept = Object.entries(KEPT)
    .map(
      ([table, { columns, order }]) =>
        `'${table}', (select json_build_object('count', count(*), 'digest', md5(coalesce(string_agg(md5(row(${columns})::text), '' order by ${order}), ''))) from ${table})`,
    )
    .join(',\n    ');
  return `select json_build_object(
  'lastSeq', (select coalesce(max(seq), 0) from events),
  'events', (select json_build_object('upto', ${bound}::bigint, 'count', count(*), 'digest',
    md5(coalesce(string_agg(md5(e::text), '' order by seq), ''))) from events e where seq <= ${bound}),
  'kept', json_build_object(
    ${kept}),
  'counts', (select json_object_agg(table_name, (xpath('/row/c/text()',
    query_to_xml(format('select count(*) as c from %I.%I', table_schema, table_name), false, true, '')))[1]::text::bigint
    order by table_name) from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'),
  'line', coalesce((select case type when 'line.started' then 'started' else 'stopped' end from events
    where type in ('line.started', 'line.stopped') order by seq desc limit 1), 'never started')
)`;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Takes the figures from the cluster `context` names, through kubectl: psql in the store's pod, as its owner. */
export function take(context: string, upto?: number): Figures {
  const kubectl = (...args: string[]) =>
    execFileSync('kubectl', ['--context', context, ...args], { encoding: 'utf-8', maxBuffer: 64 << 20 });
  const store = JSON.parse(
    kubectl(
      '-n',
      'factory',
      'exec',
      '-i',
      'postgres-0',
      '--',
      'psql',
      '-U',
      'factory',
      '-d',
      'factory',
      '-X',
      '-At',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      storeQuery(upto),
    ),
  ) as Pick<Figures, 'lastSeq' | 'events' | 'kept' | 'counts' | 'line'>;
  // A cluster without flagd's resource has no flags to keep; any other failure stops here.
  const kinds = kubectl('api-resources', '-o', 'name').split('\n');
  const flags = kinds.includes('featureflags.core.openfeature.dev')
    ? sha256(kubectl('-n', 'flagd', 'get', 'featureflag', 'flags', '--ignore-not-found', '-o', 'jsonpath={.spec}'))
    : null;
  // Each Secret by its name and its data's digest; the data itself never leaves kubectl's pipe.
  const secrets = JSON.parse(kubectl('-n', 'factory', 'get', 'secrets', '-o', 'json')) as {
    items: { metadata: { name: string }; data?: Record<string, string> }[];
  };
  const volumes = kubectl(
    'get',
    'pv',
    '-o',
    'jsonpath={range .items[*]}{.metadata.name} {.spec.claimRef.namespace}/{.spec.claimRef.name}{"\\n"}{end}',
  )
    .split('\n')
    .filter(Boolean)
    .sort();
  return {
    ...store,
    flags,
    secrets: sha256(
      secrets.items
        .map(({ metadata, data }) => `${metadata.name} ${sha256(JSON.stringify(Object.entries(data ?? {}).sort()))}`)
        .sort()
        .join('\n'),
    ),
    volumes,
  };
}

/** What differs between the figures before a move and after it; none means nothing of Martin's was lost. */
export function compare(before: Figures, after: Figures): string[] {
  const moved: string[] = [];
  if (after.events.upto !== before.events.upto)
    moved.push(`the events were counted to seq ${after.events.upto} after, not ${before.events.upto}`);
  if (after.lastSeq < before.lastSeq) moved.push(`the last seq is ${after.lastSeq}, was ${before.lastSeq}`);
  if (after.events.count !== before.events.count || after.events.digest !== before.events.digest)
    moved.push(
      `the events to seq ${before.events.upto} differ: ${after.events.count} with digest ${after.events.digest}, were ${before.events.count} with ${before.events.digest}`,
    );
  for (const table of Object.keys(KEPT)) {
    const was = before.kept[table];
    const is = after.kept[table];
    if (was?.count !== is?.count || was?.digest !== is?.digest)
      moved.push(
        `${table} differs: ${is?.count ?? 'none'} rows, were ${was?.count ?? 'none'} (or the same count, changed)`,
      );
  }
  if (after.flags !== before.flags) moved.push('the feature flags differ');
  if (after.secrets !== before.secrets) moved.push('the Secrets in factory differ');
  const volumes = (list: string[]) => list.join(', ');
  if (volumes(after.volumes) !== volumes(before.volumes))
    moved.push(`the volumes differ: ${volumes(after.volumes) || 'none'}, were ${volumes(before.volumes) || 'none'}`);
  return moved;
}

/** The figures side by side, for the move's output. */
export function report(before: Figures, after: Figures): string {
  const rows: [string, string, string][] = [
    ['last seq', String(before.lastSeq), String(after.lastSeq)],
    [`events to seq ${before.events.upto}`, String(before.events.count), String(after.events.count)],
    ...Object.keys(KEPT).map((t): [string, string, string] => [
      t,
      String(before.kept[t]?.count ?? '-'),
      String(after.kept[t]?.count ?? '-'),
    ]),
    ...Object.keys({ ...before.counts, ...after.counts })
      .filter((t) => t !== 'events' && !(t in KEPT))
      .sort()
      .map((t): [string, string, string] => [
        `${t} (not judged)`,
        String(before.counts[t] ?? '-'),
        String(after.counts[t] ?? '-'),
      ]),
    ['volumes', String(before.volumes.length), String(after.volumes.length)],
  ];
  const width = Math.max(...rows.map(([name]) => name.length));
  return [
    `  ${''.padEnd(width)}  before  after`,
    ...rows.map(([n, b, a]) => `  ${n.padEnd(width)}  ${b.padStart(6)}  ${a.padStart(5)}`),
  ].join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'take' && args[0]) {
    const at = args.indexOf('--upto');
    process.stdout.write(`${JSON.stringify(take(args[0], at > 0 ? Number(args[at + 1]) : undefined), null, 2)}\n`);
  } else if (command === 'compare' && args[0] && args[1]) {
    const read = (path: string) => JSON.parse(readFileSync(path, 'utf-8')) as Figures;
    const [before, after] = [read(args[0]), read(args[1])];
    console.log(report(before, after));
    const moved = compare(before, after);
    if (moved.length) {
      console.error(`Not the same:\n${moved.map((m) => `  ${m}`).join('\n')}`);
      process.exit(1);
    }
    console.log(
      '  Everything of Martin’s is as it was: the events, passkeys, sessions, the line, the flags and the Secrets.',
    );
  } else {
    console.error('Usage: cluster-figures.ts take <context> [--upto <seq>] | compare <before.json> <after.json>');
    process.exit(2);
  }
}
