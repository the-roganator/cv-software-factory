/**
 * The refusal records' policy hashes, again, over the copy's policies (deploy/test/*.json). The rename changes the
 * repositories' names in the policies and nothing else, so each record's answers stand; it was not taken again against
 * a cluster running these. Run from the copy's checkout: node <this> .
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(process.argv[2] ?? '.');
const { render, taken } = await import(pathToFileURL(join(root, 'scripts/policy-hash.ts')).href);
const manifests = render();
const dir = join(root, 'deploy/test');
for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
  const path = join(dir, file);
  const text = readFileSync(path, 'utf8');
  const record = JSON.parse(text);
  const now = taken(file.replace(/\.json$/, ''), manifests);
  if (record.policyHash === now.policyHash) continue;
  writeFileSync(path, text.replace(record.policyHash, now.policyHash));
  console.log(`${file}: re-hashed over the copy's policies`);
}
