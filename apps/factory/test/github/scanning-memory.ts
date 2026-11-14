/**
 * One read of the scan's moves over `MAX_ALERTS` open alerts, as `scanning.test.ts` runs it in a process of its own
 * with a small heap: about five times the alerts of both repositories together, ten times either's, each as large
 * as GitHub sends it. Every alert but the fixtures' four is a result with no fix, which no move keeps, so the read
 * keeps what the fixtures' does and must fit in the heap whatever GitHub has. Prints the answer's findings and the
 * heap's peak, in megabytes.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { MAX_ALERTS, ScanReads } from '../../src/github/scanning.ts';
import { client, REPO, type Route } from './fake.ts';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'scanning');
const fixture = (name: string) => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'));
const alerts = fixture('alerts.json') as { number: number; rule: Record<string, unknown> }[];
const [noFix] = alerts.filter((a) => a.number === 105);
const PER_PAGE = 100;
/** About what GitHub sends of a real alert's rule: its help, a few kilobytes of an advisory's text. */
const HELP = 'An advisory’s help, as GitHub sends it with every alert. '.repeat(40);

/** The one file of the artifact, stored. */
function zipOf(name: string, text: string): Buffer {
  const data = Buffer.from(text);
  const nameBytes = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  const packed = deflateRawSync(data);
  local.writeUInt32LE(crc32(data), 14);
  local.writeUInt32LE(packed.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc32(data), 16);
  central.writeUInt32LE(packed.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + nameBytes.length, 12);
  end.writeUInt32LE(local.length + nameBytes.length + packed.length, 16);
  return Buffer.concat([local, nameBytes, packed, central, nameBytes, end]);
}

/** As many alerts as the cap allows, a full page at a time, the fixtures' own first, then filler; then an empty page. */
const pages = MAX_ALERTS / PER_PAGE;
const filler = (from: number, length: number) =>
  Array.from({ length }, (_, i) => ({ ...noFix, number: from + i, rule: { ...noFix?.rule, help: HELP } }));
/** Each page made when it is asked for, so the fake holds none of them. */
const page = (n: number) =>
  n > pages
    ? []
    : n === 1
      ? [...alerts, ...filler(1000, PER_PAGE - alerts.length)]
      : filler(1000 + (n - 1) * PER_PAGE, PER_PAGE);

const routes: Route[] = [
  { method: 'GET', path: `/repos/${REPO}`, answer: () => ({ body: { default_branch: 'main' } }) },
  { method: 'GET', path: /\/runs\?.*status=completed/, answer: () => ({ body: fixture('runs.json') }) },
  { method: 'GET', path: /\/runs\?.*status=in_progress/, answer: () => ({ body: { workflow_runs: [] } }) },
  { method: 'GET', path: /\/artifacts\?name=moves/, answer: () => ({ body: fixture('artifacts.json') }) },
  {
    method: 'GET',
    path: /\/artifacts\/77\/zip$/,
    answer: () => ({ status: 302, headers: { location: 'https://storage.test/artifact/77/moves.zip' } }),
  },
  {
    method: 'GET',
    path: '/artifact/77/moves.zip',
    answer: () => ({ body: zipOf('moves.json', JSON.stringify(fixture('moves.json'))) }),
  },
  {
    method: 'GET',
    path: /sort=updated/,
    answer: () => ({ body: [{ number: 104, state: 'open', updated_at: '2026-11-10T06:19:30Z' }] }),
  },
  {
    method: 'GET',
    path: /\/code-scanning\/alerts\?state=open/,
    answer: ({ path }) => ({ body: page(Number(new URL(path, 'https://x').searchParams.get('page'))) }),
  },
];

let peak = 0;
const timer = setInterval(() => {
  peak = Math.max(peak, process.memoryUsage().heapUsed);
}, 5);
const moves = await new ScanReads(client(routes).github).moves(REPO);
clearInterval(timer);
peak = Math.max(peak, process.memoryUsage().heapUsed);
console.log(
  JSON.stringify({
    pages,
    findings: moves.moves.flatMap((move) => move.findings.map((finding) => finding.alert)),
    peakMB: Math.round(peak / 2 ** 20),
  }),
);
