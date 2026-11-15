/**
 * Every third-party image the cluster's node pulls, one reference to a line, as the pods name them: each image a chart
 * renders (the vulnerability scan's list, apps/factory/src/vulnerabilities/inventory.ts, rendered as the scan renders
 * it), each image k3s's release lists, and each other image `kustomize build deploy/overlays/local` runs. Not the
 * images in GHCR (ours, and any third party's there already), nor the k3s and k3d images Docker pulls to make the
 * node. `scripts/ci-images.sh sync` copies each to GHCR for the platform check's cluster (deploy/k3d/ci-registries.yaml).
 *
 *     node scripts/cluster-images.ts <checkout>
 *
 * It fails, naming it, when a chart does not render or k3s's list cannot be fetched: a copy left out unsaid would send
 * the cluster to the image's own registry with no word.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Item, inventory } from '../apps/factory/src/vulnerabilities/inventory.ts';
import { apiVersionsOf, imagesIn, kubeVersionOf, realTools } from '../apps/factory/src/vulnerabilities/scan.ts';

/** The kinds the node pulls: the rest are built on, run by CI, or pulled by Docker to make the node. */
const PULLED: ReadonlySet<Item['kind']> = new Set(['chart', 'k3s-release', 'third-party']);

/** Whether the node would pull an image from GHCR anyway. */
const inGhcr = (reference: string) => reference.startsWith('ghcr.io/');

export async function clusterImages(root: string, tools = realTools('', tmpdir(), tmpdir())) {
  const { items } = inventory(root);
  const kubeVersion = kubeVersionOf(items);
  const apiVersions = apiVersionsOf(root);
  const found = new Set<string>();
  const failed: string[] = [];
  for (const item of items.filter((each) => PULLED.has(each.kind))) {
    try {
      let images: string[];
      if (item.chart) images = imagesIn(await tools.render(item.chart, root, kubeVersion, apiVersions));
      else if (item.list)
        images = (await tools.fetch(item.list))
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line && !line.startsWith('#'));
      else images = item.image ? [item.image] : [];
      for (const image of images) found.add(image);
    } catch (error) {
      failed.push(`${item.name} (${item.file}:${item.line}): ${String(error).split('\n')[0]}`);
    }
  }
  return { images: [...found].filter((image) => !inGhcr(image)).sort(), failed };
}

async function main(args: string[]) {
  const [root] = args;
  if (!root) {
    console.error('Usage: cluster-images.ts <checkout>');
    return 2;
  }
  const work = mkdtempSync(join(tmpdir(), 'cluster-images-'));
  try {
    const { images, failed } = await clusterImages(root, realTools('', work, work));
    for (const why of failed) console.error(`::error::Not read: ${why}`);
    for (const image of images) console.log(image);
    return failed.length ? 1 : 0;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
