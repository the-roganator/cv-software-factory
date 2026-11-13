/**
 * The record of the API versions Argo CD renders the cluster's charts with: a leaf the scan, the review gate and
 * platform.yml's script (scripts/api-versions.ts) each read, importing nothing of the scan.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The API versions Argo CD renders the cluster's charts with (`--api-versions`), as `platform.yml` takes them from its
 * cluster made from `main`: each `group/version`, and each `group/version/Kind`, Argo CD's own list
 * (`scripts/api-versions.ts`). A chart may render otherwise for an API the cluster has, so the scan and the gate render
 * with this list, never a head's.
 */
export const API_VERSIONS_RECORD = 'deploy/k3d/api-versions.json';

/** The record's API versions in a checkout, none where it keeps no record (the app's), or a throw when it cannot be read. */
export function apiVersionsOf(root: string): string[] | undefined {
  const file = join(root, API_VERSIONS_RECORD);
  if (!existsSync(file)) return undefined;
  const { apiVersions } = JSON.parse(readFileSync(file, 'utf-8')) as { apiVersions?: unknown };
  if (
    !Array.isArray(apiVersions) ||
    !apiVersions.length ||
    !apiVersions.every((v) => typeof v === 'string' && /^[\w./-]+$/.test(v))
  )
    throw new Error(`${API_VERSIONS_RECORD} lists no API versions the gate can read`);
  return apiVersions as string[];
}
