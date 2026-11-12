/**
 * Records the chart renderings pin-move.test.ts compares, with the gate's own renderer (`realTools().render`, the
 * scan's, as Argo CD renders it: its namespace, its `crds/`, the k3s and the API versions this checkout records), each
 * chart at the version this checkout pins and at the release its move goes to, with this checkout's
 * values (record them from main):
 *
 *   mise exec -- node scripts/fixtures/pin-move/record.ts
 *
 * Kyverno's renderings are kept without their CustomResourceDefinitions, which are nearly all of their bytes: its move
 * adds none and removes none, so the first object it adds is the same with them or without.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseAllDocuments } from 'yaml';
import { inventory } from '../../../apps/factory/src/vulnerabilities/inventory.ts';
import { apiVersionsOf, kubeVersionOf, realTools } from '../../../apps/factory/src/vulnerabilities/scan.ts';

const ROOT = join(import.meta.dirname, '../../..');
/** Each chart's move, as the scan named it on 12 November 2026. */
export const MOVES = [
  { item: 'tempo', to: '3.2.1' },
  { item: 'otel-collector', to: '0.178.3' },
  { item: 'prometheus', to: '29.47.2' },
  { item: 'kyverno', to: '3.10.0' },
] as const;

const withoutCrds = (text: string) =>
  parseAllDocuments(text)
    .filter((doc) => (doc.toJS() as { kind?: string } | null)?.kind !== 'CustomResourceDefinition')
    .map((doc) => doc.toString())
    .join('---\n');

if (import.meta.main) {
  const work = mkdtempSync(join(tmpdir(), 'pin-move-fixtures-'));
  try {
    const tools = realTools('unused', work, work);
    const items = inventory(ROOT).items;
    for (const { item, to } of MOVES) {
      const chart = items.find((each) => each.name === item)?.chart;
      if (!chart) throw new Error(`main lists no chart ${item}`);
      for (const version of [chart.version, to]) {
        let text = await tools.render({ ...chart, version }, ROOT, kubeVersionOf(items), apiVersionsOf(ROOT));
        if (item === 'kyverno') text = withoutCrds(text);
        writeFileSync(join(import.meta.dirname, `${item}-${version}.yaml`), text);
        console.log(`${item} ${version}: ${text.length} bytes`);
      }
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
