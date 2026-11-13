/**
 * Nothing else that runs changes (ADR 0019, condition 6): the renderings at the base and at the head, read as both YAML
 * versions, compared object by object and then line by line, with only the move's own differences set aside.
 */
import { isAlias, isMap, isNode, isPair, isScalar, parseAllDocuments, visit } from 'yaml';
import { compareVersions } from '../apps/factory/src/vulnerabilities/deadlines.ts';
import type { Side } from './pin-move-readers.ts';
import { literal, record, sameMajor, short, VERSION_WORD, variantOf } from './pin-move-shared.ts';

/** The labels whose values are the chart's own versions, by their exact keys, in an object's or a template's metadata. */
const VERSION_LABELS = new Set(['helm.sh/chart', 'app.kubernetes.io/version']);

/** Where each workload of the core API writes its pod template; a kind of another group is no pod template. */
const POD_TEMPLATES: Readonly<Record<string, readonly string[]>> = {
  'apps/v1 Deployment': ['spec', 'template'],
  'apps/v1 StatefulSet': ['spec', 'template'],
  'apps/v1 DaemonSet': ['spec', 'template'],
  'apps/v1 ReplicaSet': ['spec', 'template'],
  'batch/v1 Job': ['spec', 'template'],
  'batch/v1 CronJob': ['spec', 'jobTemplate', 'spec', 'template'],
};

/** Whether an object is a core ConfigMap, whose `data` condition 6 sets aside, in its objects and in its text alike. */
const isCoreConfigMap = (object: Record<string, unknown>) => object.apiVersion === 'v1' && object.kind === 'ConfigMap';

/** Where a core workload writes its pod template, whose `checksum/` annotations condition 6 sets aside, or undefined. */
const podTemplatePath = (object: Record<string, unknown>) => POD_TEMPLATES[`${object.apiVersion} ${object.kind}`];

/** An annotation a chart writes from its configuration so that a change to it restarts the pods. */
const isChecksum = (key: string) => key.startsWith('checksum/');

/** An object of a rendering: how it is named in a hold, and what it is once the move's own differences are written the same. */
interface Rendered {
  label: string;
  body: unknown;
}

/**
 * Whether a code point is one the gate's reader and the cluster's read alike: the gate reads with the `yaml` package,
 * Argo CD with apimachinery's decoder and sigs.k8s.io/yaml, and they agree on a text's lines only where it holds tab, LF
 * and printable characters: U+0020 to U+007E, U+00A0 to U+D7FF, U+E000 to U+FFFD and above U+FFFF, YAML's printable set,
 * but for anything a reader may take as a line break other than LF (CR, U+0085, U+2028, U+2029) and the byte order mark.
 * Everything else is refused by what it is not, not by name.
 */
const readAlike = (code: number) =>
  code === 0x09 ||
  code === 0x0a ||
  (code >= 0x20 && code <= 0x7e) ||
  (code >= 0xa0 && code <= 0xd7ff && code !== 0x2028 && code !== 0x2029) ||
  (code >= 0xe000 && code <= 0xfffd && code !== 0xfeff) ||
  code >= 0x10000;

/** The first character of a rendering the readers may not read alike, with its line, or undefined. */
export function strangeCharacter(rendered: string): string | undefined {
  let line = 1;
  for (const character of rendered) {
    const code = character.codePointAt(0) as number;
    if (!readAlike(code)) return `U+${code.toString(16).toUpperCase().padStart(4, '0')} at line ${line}`;
    if (code === 0x0a) line++;
  }
  return undefined;
}

/** The YAML versions a rendering is read as: what Helm, kustomize, Argo CD and the API server read is 1.1 in places. */
const YAML_VERSIONS = ['1.2', '1.1'] as const;

/**
 * A rendering as its objects, keyed by kind, namespace and name, or why it cannot be read so. Anything that a second
 * reader could read another way holds: a document with an error (a duplicate key among them), a directive, an explicit
 * tag, an anchor, an alias or a merge key; and anything the cluster would not take as one object: a document that is not
 * a mapping, one with no kind or name, a List that wraps objects, or two documents with one key. A document with nothing
 * in it (a comment, an empty `---`) is no object.
 */
export function objectsOf(
  rendered: string,
  version: (typeof YAML_VERSIONS)[number] = '1.2',
): Map<string, Rendered> | string {
  const read = readRendering(rendered, version);
  return typeof read === 'string' ? read : read.objects;
}

/** Where a place the text rule sets aside lies in a rendering: its start and its end, by the parser's own offsets. */
type Span = [number, number];

/** The source span of a node the parser read, from its first character to the end of its value, or none. */
const spanOf = (node: unknown, offset: number): Span | undefined => {
  const range = isNode(node) ? node.range : undefined;
  return range ? [offset + range[0], offset + range[1]] : undefined;
};

/**
 * A rendering's objects, as `objectsOf` reads them, and the spans the text rule sets aside, as this parser places them
 * and never by a search of the text: the value of a core ConfigMap's `data`, and each `checksum/` annotation of a core
 * workload's pod template, from its key to the end of its value.
 */
export function readRendering(
  rendered: string,
  version: (typeof YAML_VERSIONS)[number],
): { objects: Map<string, Rendered>; exempt: Span[] } | string {
  const objects = new Map<string, Rendered>();
  const exempt: Span[] = [];
  const strange = strangeCharacter(rendered);
  if (strange) return `the rendering writes ${strange}, which readers may read apart`;
  // The stream split as Kubernetes' YAML reader splits it (kubectl, kustomize, Argo CD and Helm alike): on a line that is
  // `---`, with a comment or nothing after it, and on nothing else. Each part is one document: a part this parser reads
  // as more (after a `...`) is one whose later objects the cluster never gets.
  // A directive before a `---` would be a part of its own, with no document to hold it to: any line that begins one holds.
  if (/^%/m.test(rendered)) return 'the rendering writes a YAML directive, which readers may read apart';
  // Each document with where its part begins in the rendering, so the parser's offsets are the rendering's.
  const docs = [];
  const separator = /^---[ \t]*(?:#[^\n]*)?\r?$/gm;
  let start = 0;
  for (const end of [...[...rendered.matchAll(separator)].map((m) => m.index), rendered.length]) {
    const read = parseAllDocuments(rendered.slice(start, end), { version, intAsBigInt: true });
    if (read.length > 1)
      return 'the rendering has a document that does not begin with `---`, which readers split apart';
    docs.push(...read.map((doc) => ({ doc, offset: start })));
    start = rendered.indexOf('\n', end) + 1 || rendered.length;
  }
  for (const { doc, offset } of docs) {
    if (doc.errors.length)
      return `the rendering is not YAML the gate can read (${doc.errors[0]?.code}), so nothing shows what changes`;
    if (doc.directives?.yaml.explicit || Object.keys(doc.directives?.tags ?? {}).some((handle) => handle !== '!!'))
      return 'the rendering writes a YAML directive, which readers may read apart';
    let unsure: string | undefined;
    visit(doc, (_, node) => {
      if (isAlias(node)) unsure = 'an alias';
      else if (isPair(node)) {
        if (!isScalar(node.key)) unsure = 'a key that is not a scalar';
        // A key that is no string would be one once read as JSON, and could stand for another key of the same text.
        else if (typeof node.key.value !== 'string' && typeof node.key.value !== 'symbol')
          unsure = `a key that is not a string (${short(String(node.key.source ?? node.key.value))})`;
        // YAML 1.1's schema reads `<<` as a symbol of its own, and merges it.
        else if (node.key.value === '<<' || typeof node.key.value === 'symbol' || node.key.source === '<<')
          unsure = 'a merge key';
      } else if (isNode(node)) {
        if (node.tag) unsure = `a tag (${short(node.tag)})`;
        else if (node.anchor) unsure = 'an anchor';
      }
      return unsure ? visit.BREAK : undefined;
    });
    if (unsure) return `the rendering writes ${unsure}, which readers may read apart`;
    const value = doc.toJS({ maxAliasCount: 0 }) as unknown;
    if (value === null || value === undefined) continue;
    const object = record(value);
    if (object !== value) return 'the rendering has a document that is not an object';
    const metadata = record(object.metadata);
    const { kind } = object;
    const { name, namespace } = metadata;
    if (typeof kind !== 'string' || !kind || typeof name !== 'string' || !name)
      return 'the rendering has an object with no kind or no name';
    if (namespace !== undefined && typeof namespace !== 'string')
      return `${kind} ${name} has a namespace that is not a name`;
    if (kind.endsWith('List') || Object.hasOwn(object, 'items'))
      return `the rendering has a ${kind} that wraps objects the gate does not key`;
    const label = `${kind} ${namespace ? `${namespace}/` : namespace === '' ? '""/' : ''}${name}`;
    const key = JSON.stringify([kind, namespace ?? null, name]);
    if (objects.has(key)) return `the rendering has ${label} twice`;
    objects.set(key, { label, body: object });
    // A duplicate key holds above, so each path names one node.
    if (isCoreConfigMap(object)) {
      const data = spanOf(doc.get('data', true), offset);
      if (data) exempt.push(data);
    }
    const path = podTemplatePath(object);
    const annotations = path && doc.getIn([...path, 'metadata', 'annotations'], true);
    if (isMap(annotations))
      for (const pair of annotations.items) {
        if (!isScalar(pair.key) || typeof pair.key.value !== 'string' || !isChecksum(pair.key.value)) continue;
        const [from, to] = [spanOf(pair.key, offset), spanOf(pair.value, offset) ?? spanOf(pair.key, offset)];
        if (from && to) exempt.push([from[0], to[1]]);
      }
  }
  return { objects, exempt };
}

/** A version label's line, its key plain, its value alone after it, in no quotes or in one kind. */
const VERSION_LINE = /^([ \t]*(?:helm\.sh\/chart|app\.kubernetes\.io\/version):[ \t]+)(["']?)([^"'#\s]+)\2([ \t]*)$/;

/**
 * The lines of a rendering the text rule compares: every line but one that lies wholly in an exempt span, from its
 * first character after its indentation to its end. The line that opens a span (`data:`, `config.yaml: |`, a flow
 * mapping's `{`) and the one that closes it beyond its end are compared, as is a blank line at a span's edge. Each line
 * is written with the moved images' references as their pairs' placeholders; a version label's line has its value is written `<version>` only where it is one the object rule saw move as the chart's (`moved`), in the same
 * quotes, with nothing after it, so a label's text the gate reads alike and another reader may not (`1e400` for
 * `9e999`) is compared. Each comes with its number in the rendering, for the hold to name.
 */
export function comparedLines(
  rendered: string,
  exempt: readonly Span[],
  written: readonly [string, string][],
  moved: ReadonlySet<string> = new Set(),
): { line: number; text: string }[] {
  const lines: { line: number; text: string }[] = [];
  let start = 0;
  for (const [i, line] of rendered.split('\n').entries()) {
    const end = start + line.length;
    const first = start + (/^[ \t]*/.exec(line)?.[0].length ?? 0);
    const inside = exempt.some(([from, to]) => from <= first && end <= to && first < to);
    if (!inside) {
      const label = VERSION_LINE.exec(line);
      const text =
        label && moved.has(label[3] as string) ? `${label[1]}${label[2]}<version>${label[2]}${label[4]}` : line;
      lines.push({ line: i + 1, text: writtenAlike(text, written) });
    }
    start = end + 1;
  }
  return lines;
}

/**
 * Whether the head's rendering writes any line outside its exempt spans (`readRendering`'s) otherwise than the base, in
 * order: whatever any reader makes of a text the gate's reader takes for no change, it is the same text. Undefined when
 * every line is.
 */
export function linesDiffer(
  base: string,
  head: string,
  exempt: { base: readonly Span[]; head: readonly Span[] },
  pairs: readonly ImagePair[],
  moved: ReadonlySet<string>,
): string | undefined {
  const a = comparedLines(base, exempt.base, placeholders(pairs, 'base'), moved);
  const b = comparedLines(head, exempt.head, placeholders(pairs, 'head'), moved);
  // Each named as the rendering writes it.
  const [baseLines, headLines] = [base.split('\n'), head.split('\n')];
  const at = (lines: string[], n: number) => short((lines[n - 1] ?? '').trim());
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const [x, y] = [a[i], b[i]];
    if (x?.text === y?.text) continue;
    const outside = "outside a ConfigMap's data and the checksums, the head's";
    if (!y) return `${outside} rendering ends where the base's writes line ${x?.line}: ${at(baseLines, x?.line ?? 0)}`;
    if (!x) return `${outside} rendering writes line ${y.line} past the base's end: ${at(headLines, y.line)}`;
    return `${outside} line ${y.line} is not the base's line ${x.line}: ${at(headLines, y.line)}`;
  }
  return undefined;
}

/** A mapping as YAML reads one: an object of no class. A Date (YAML 1.1's timestamp) is a value, kept as it is. */
const isPlain = (value: unknown): value is Record<string, unknown> =>
  value !== null &&
  typeof value === 'object' &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value) as object | null);

/** One moved image: its reference at the base, and the one at the head that replaces it. */
export interface ImagePair {
  from: string;
  to: string;
}

/** The chart a rendering is of, at the base's version and at the head's: the same for a value's move. */
export interface ChartVersions {
  chart: string;
  from: string;
  to: string;
}

/**
 * What one side's moved references are written as: each pair's reference, and its digest alone, by a placeholder of
 * that pair's, the base's `from` and the head's `to` alone. The old reference left at the head, or one pair's image in
 * another's place, is no placeholder, and differs.
 */
export function placeholders(pairs: readonly ImagePair[], side: Side): [string, string][] {
  const entries = pairs.flatMap((pair, i): [string, string][] => {
    const ref = side === 'base' ? pair.from : pair.to;
    const digest = ref.split('@')[1];
    return [[ref, `<image ${i}>`], ...(digest ? [[digest, `<digest ${i}>`] as [string, string]] : [])];
  });
  return entries.filter(([text]) => text).sort(([a], [b]) => b.length - a.length);
}

/** Any character an image reference may hold: a registry, a path, a tag, a digest. */
const REFERENCE_CHARACTER = 'A-Za-z0-9_./:@+-';

/** Each placeholder list's patterns, compiled once: a rendering's every line and string is written with them. */
const PATTERNS = new WeakMap<readonly [string, string][], [RegExp, string][]>();

/**
 * A text with each moved reference written as its placeholder where it stands whole: nothing a reference may hold on
 * either side of it, so `app:1.1` never covers `app:1.10`, `app:1.1_debug`, `app:1.1-alpine` or `mirror.io/app:1.1`.
 * A digest alone (`sha256:…`, or another algorithm's) may follow `@`, as an image written by its digest does, under
 * any repository: a digest names one content, which the runtime checks as it pulls. Nothing may follow it.
 */
export function writtenAlike(text: string, written: readonly [string, string][]): string {
  let patterns = PATTERNS.get(written);
  if (!patterns) {
    patterns = written.map(([ref, as]) => {
      const before = /^[a-z0-9]+:[0-9a-f]+$/.test(ref) ? REFERENCE_CHARACTER.replace('@', '') : REFERENCE_CHARACTER;
      return [new RegExp(`(?<![${before}])${literal(ref)}(?![${REFERENCE_CHARACTER}])`, 'g'), as];
    });
    PATTERNS.set(written, patterns);
  }
  return patterns.reduce((at, [whole, as]) => at.replace(whole, () => as), text);
}

/** A value with every string's moved references written as their placeholders. */
function withoutImage(value: unknown, written: readonly [string, string][]): unknown {
  if (typeof value === 'string') return writtenAlike(value, written);
  if (Array.isArray(value)) return value.map((each) => withoutImage(each, written));
  if (isPlain(value))
    return Object.fromEntries(Object.entries(value).map(([key, each]) => [key, withoutImage(each, written)]));
  return value;
}

/**
 * The `metadata.labels` the chart's version labels may change in, by their path: the object's own, its pod template's
 * (and a CronJob's job template's), and a StatefulSet's claim templates'. Nowhere else: a resource's spec may carry
 * metadata a controller reads as input.
 */
function labelPlaces(object: Record<string, unknown>): Map<string, Record<string, unknown>> {
  const places = new Map<string, Record<string, unknown>>();
  const add = (path: string, metadata: unknown) => {
    const labels = record(metadata).labels;
    if (isPlain(labels)) places.set(`${path}metadata.labels`, labels);
  };
  add('', object.metadata);
  const kind = `${object.apiVersion} ${object.kind}`;
  const path = POD_TEMPLATES[kind];
  if (path) add(`${path.join('.')}.`, record(path.reduce<unknown>((at, each) => record(at)[each], object)).metadata);
  if (kind === 'batch/v1 CronJob') add('spec.jobTemplate.', record(record(object.spec).jobTemplate).metadata);
  const claims = kind === 'apps/v1 StatefulSet' ? record(object.spec).volumeClaimTemplates : undefined;
  if (Array.isArray(claims))
    for (const [i, claim] of claims.entries()) add(`spec.volumeClaimTemplates[${i}].`, record(claim).metadata);
  return places;
}

/** A chart's version, as Helm requires one: SemVer's three numbers, then a prerelease or build if any. */
const CHART_VERSION = /^v?\d+\.\d+\.\d+([-+][A-Za-z0-9.+-]*)?$/;

/**
 * Each way a chart's label (`tempo-3.2.1`, a subchart's `alertmanager-2.5.1`) reads as a name and a version: split at
 * any `-` with a chart's version after it, so a name that holds part of a version (`foo-1-2.0.0`, `k-1.0.0-2.0.0`) is
 * read both ways where both are versions, and neither reading hides the other's.
 */
function chartLabelReadings(label: string): Map<string, string> {
  const readings = new Map<string, string>();
  for (let at = label.indexOf('-'); at > 0; at = label.indexOf('-', at + 1))
    if (CHART_VERSION.test(label.slice(at + 1))) readings.set(label.slice(0, at), label.slice(at + 1));
  return readings;
}

/**
 * Why a version label's change is not the chart's, or undefined when it is: `helm.sh/chart` the chart's own label at
 * the base (`<chart>-<from>`) and at the head (`<chart>-<to>`), or a subchart's of the same name at both, each at a
 * version; `app.kubernetes.io/version` a version at both. A value's move or an image's changes neither.
 */
function versionLabelWrong(label: string, was: string, now: string, chart?: ChartVersions): string | undefined {
  if (!chart || chart.from === chart.to) return 'a version label changes in a move that moves no chart';
  if (label === 'app.kubernetes.io/version')
    return VERSION_WORD.test(was) && VERSION_WORD.test(now) ? undefined : `${short(now)} is no version`;
  const [own, next] = [`${chart.chart}-${chart.from}`, `${chart.chart}-${chart.to}`];
  if (was === own || now === next) return was === own && now === next ? undefined : `${short(now)} is not ${next}`;
  // A label written as the chart's own name and a version is the chart's, which moves from its version to its version
  // alone: a subchart of its parent's name, or of its name and a version's (`x-v2`), is held with it.
  const owns = (value: string) =>
    value.startsWith(`${chart.chart}-`) && VERSION_WORD.test(value.slice(chart.chart.length + 1));
  if (owns(was) || owns(now)) return `${short(now)} is not ${next}`;
  // A subchart's: the same name, at its version or a later one on the same major, as its parent moves forward.
  // Every reading that names one chart at both must be forward on its major and its line (its variant, as an image a
  // chart runs keeps its), so a name that may hold part of the version cannot pass a major as a minor.
  const [a, b] = [chartLabelReadings(was), chartLabelReadings(now)];
  const names = [...a.keys()].filter((name) => b.has(name));
  if (!names.length) return `${short(now)} is not ${short(was)}'s chart at another version`;
  for (const name of names) {
    const [from, to] = [a.get(name) as string, b.get(name) as string];
    if (compareVersions(to, from) < 0 || !sameMajor(from, to) || variantOf(from) !== variantOf(to))
      return `${short(now)} is not ${short(was)} forward on its major`;
  }
  return undefined;
}

/** Where an object names a version label anywhere but a place it may change (a selector, a policy), or undefined. */
function namesVersionLabel(value: unknown, places: ReadonlySet<unknown>, path = ''): string | undefined {
  if (places.has(value)) return undefined;
  if (typeof value === 'string') return VERSION_LABELS.has(value) ? path : undefined;
  if (Array.isArray(value)) {
    for (const [i, each] of value.entries()) {
      const at = namesVersionLabel(each, places, `${path}[${i}]`);
      if (at !== undefined) return at;
    }
    return undefined;
  }
  if (!isPlain(value)) return undefined;
  for (const [key, each] of Object.entries(value)) {
    if (VERSION_LABELS.has(key)) return `${path}${step(key)}`;
    const at = namesVersionLabel(each, places, `${path}${step(key)}`);
    if (at !== undefined) return at;
  }
  return undefined;
}

/**
 * The first object of a rendering (main's overlay, say) that names a version label anywhere but its own labels, as a
 * selector would: a chart's version labels moving would select other pods for it. Undefined when none does, or when the
 * rendering cannot be read, which condition 6 holds on its own.
 */
export function versionLabelNamed(rendered: string): string | undefined {
  const objects = objectsOf(rendered);
  if (typeof objects === 'string') return undefined;
  for (const { label, body } of objects.values()) {
    const object = record(body);
    if (isCoreConfigMap(object)) continue;
    const at = namesVersionLabel(object, new Set(labelPlaces(object).values()));
    if (at !== undefined) return `${label} names a version label at ${at.replace(/^\./, '')}`;
  }
  return undefined;
}

/**
 * An object as condition 6 compares it: the moved image's references written as their pair's placeholders, a core
 * ConfigMap's `data` set aside (its `binaryData`, metadata, labels and annotations are not `data`), and a core
 * workload's pod template's annotations by the `checksum/` prefix taken out, which a chart writes from the
 * configuration so a change to it restarts the pods. The version labels are set aside pairwise, in `manifestsDiffer`.
 */
export function comparable(body: unknown, written: readonly [string, string][]): Record<string, unknown> {
  const object = record(withoutImage(body, written));
  // Its data whole, keys added or gone among it, and the data itself added or gone.
  if (isCoreConfigMap(object)) object.data = '<configuration>';
  const path = podTemplatePath(object);
  const template = path?.reduce<unknown>((at, each) => record(at)[each], object);
  const metadata = template === undefined ? undefined : record(record(template).metadata);
  const annotations = metadata?.annotations;
  if (metadata && isPlain(annotations)) {
    const kept = Object.entries(annotations).filter(([key]) => !isChecksum(key));
    if (kept.length) metadata.annotations = Object.fromEntries(kept);
    else delete metadata.annotations;
  }
  return object;
}

const step = (key: string) => (/^[A-Za-z_][\w-]*$/.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`);

/** The first place two values differ, by its path from the object, or undefined when they are the same. */
function firstDifference(a: unknown, b: unknown, path = ''): string | undefined {
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (i >= a.length || i >= b.length) return `${path}[${i}]`;
      const at = firstDifference(a[i], b[i], `${path}[${i}]`);
      if (at !== undefined) return at;
    }
    return undefined;
  }
  // YAML 1.1 reads a timestamp as a Date, which has no keys to compare: compared by its time. Any other object that is
  // not a plain mapping is never the same as anything.
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime() ? undefined : path;
  if (!isPlain(a) || !isPlain(b)) return a === b ? undefined : path;
  for (const key of new Set([...Object.keys(b), ...Object.keys(a)])) {
    if (!Object.hasOwn(a, key) || !Object.hasOwn(b, key)) return `${path}${step(key)}`;
    const at = firstDifference(a[key], b[key], `${path}${step(key)}`);
    if (at !== undefined) return at;
  }
  return undefined;
}

const beyond = (label: string, at: string, as: string) =>
  `the manifests change beyond the image: ${label} at ${at.replace(/^\./, '') || 'the object'}${as}`;

/**
 * Whether two renderings differ in anything but the moved images (each pair's `from` at the base for its `to` at the
 * head), the chart's own version labels, a ConfigMap's data and a pod template's checksums, compared object by object:
 * the same objects at the base and at the head, none added or gone, each the same once those are set aside. A version
 * label may change only as the chart's (`versionLabelWrong`), and not at all where any object names one elsewhere, as a
 * selector would. Each is read as YAML 1.2 and as YAML 1.1, and a difference in either holds, so a scalar two readers
 * read apart (`yes`, `0777`) is read both ways. The first difference is named, with its object and field. Then the
 * text (`linesDiffer`): outside the exempt spans, every line the base's, so a change one reader takes for none (`0X10`
 * for `"0X10"`, `9e999` for `1e400`) holds whatever another reader makes of it.
 */
export function manifestsDiffer(
  base: string,
  head: string,
  pairs: readonly ImagePair[],
  chart?: ChartVersions,
): string | undefined {
  const [fromBase, fromHead] = [placeholders(pairs, 'base'), placeholders(pairs, 'head')];
  // The version labels' values the object rule saw move as the chart's: only these are written alike in the text.
  const moved = new Set<string>();
  // The spans the text rule sets aside, from the YAML 1.2 reading: where a place lies does not depend on the schema.
  const exempt: { base: Span[]; head: Span[] } = { base: [], head: [] };
  for (const version of YAML_VERSIONS) {
    const [readBase, readHead] = [readRendering(base, version), readRendering(head, version)];
    if (typeof readBase === 'string') return `at the base, ${readBase}`;
    if (typeof readHead === 'string') return `at the head, ${readHead}`;
    if (version === '1.2') Object.assign(exempt, { base: readBase.exempt, head: readHead.exempt });
    const [was, now] = [readBase.objects, readHead.objects];
    if (!was.size || !now.size) return 'a rendering came out empty: nothing to compare';
    const as = version === '1.2' ? '' : ` (as YAML ${version} reads it)`;
    for (const [key, object] of now)
      if (!was.has(key)) return `the head renders ${object.label}, which the base does not`;
    for (const [key, object] of was) if (!now.has(key)) return `the head no longer renders ${object.label}`;
    let relabelled = false;
    const compared: [Rendered, Record<string, unknown>, Record<string, unknown>][] = [];
    for (const [key, object] of now) {
      const [a, b] = [comparable((was.get(key) as Rendered).body, fromBase), comparable(object.body, fromHead)];
      const [placesA, placesB] = [labelPlaces(a), labelPlaces(b)];
      for (const [path, labels] of placesB) {
        const before = placesA.get(path);
        if (!before) continue;
        for (const label of VERSION_LABELS) {
          const [x, y] = [before[label], labels[label]];
          if (typeof x !== 'string' || typeof y !== 'string' || x === y) continue;
          const wrong = versionLabelWrong(label, x, y, chart);
          if (wrong) return `${beyond(object.label, `${path}${step(label)}`, as)}: ${wrong}`;
          before[label] = labels[label] = '<version>';
          moved.add(x).add(y);
          relabelled = true;
        }
      }
      compared.push([object, a, b]);
    }
    for (const [object, a, b] of compared) {
      const at = firstDifference(a, b);
      if (at !== undefined) return beyond(object.label, at, as);
    }
    // A version label that moved must select nothing: an object naming one elsewhere would select other pods now.
    if (relabelled)
      for (const [object, , b] of compared) {
        const at = namesVersionLabel(b, new Set(labelPlaces(b).values()));
        if (at !== undefined)
          return `${object.label} names a version label at ${at.replace(/^\./, '')}, and the chart's version labels change${as}`;
      }
  }
  return linesDiffer(base, head, exempt, pairs, moved);
}
