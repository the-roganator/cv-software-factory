import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse, parseAllDocuments } from 'yaml';
import { REPOSITORIES } from '../src/github/config.ts';
import { GITHUB_ACTIONS, pipeline } from '../src/github/signatures.ts';

/** Admission control as deploy/base/admission declares it (ADR 0010), and the refusals the cluster gave. */

/** Where our images are in GHCR: under the owner of both repositories. */
const OURS = `ghcr.io/${REPOSITORIES[0].split('/')[0]}/`;

const DEPLOY = fileURLToPath(new URL('../../../deploy/', import.meta.url));
const read = (path: string) => readFile(join(DEPLOY, path), 'utf-8');

interface Op {
  op: string;
  path: string;
  value: unknown;
}

/** The strings an expression lists: `['a', 'b']`. */
const listed = (expression: unknown) => [...String(expression ?? '[]').matchAll(/'([^']+)'/g)].map((m) => m[1]);

/**
 * The third-party images a copy of the policy admits, as kustomize renders it: deploy/base/kustomization.yaml copies
 * Postgres's one pin, its StatefulSet's, and the Postgres exporter's, its Deployment's, into the factory's, and flagd's,
 * its Deployment's, into flagd's.
 */
let rendered: {
  kind: string;
  metadata: { name: string };
  spec: {
    variables: { name: string; expression: string }[];
    attestors?: { name: string; cosign?: { keyless?: { identities?: unknown[] } } }[];
  };
}[];
function render() {
  rendered ??= parseAllDocuments(
    execFileSync('kustomize', ['build', join(DEPLOY, 'base')], { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 }),
  ).map((doc) => doc.toJS());
  return rendered;
}
function admitted(policy: string) {
  const found = render().find((r) => r.kind === 'ImageValidatingPolicy' && r.metadata.name === policy);
  return listed(found?.spec.variables.find((v) => v.name === 'allowed')?.expression);
}

/**
 * One copy of the image policy: the namespaces it guards, the repositories of ours it admits, by which identity, and
 * the images it names from other registries.
 */
async function copy(name: 'factory' | 'website' | 'scoreboard' | 'flagd') {
  const kustomization = parse(await read(`base/admission/${name}/kustomization.yaml`)) as {
    namePrefix: string;
    patches: { patch: string }[];
  };
  const ops = kustomization.patches.flatMap((p) => parse(p.patch) as Op[]);
  const value = (path: string) => ops.find((o) => o.path === path)?.value;
  return {
    policy: `${kustomization.namePrefix}images`,
    namespaces: value('/spec/matchConstraints/namespaceSelector/matchExpressions/0/values') as string[],
    allowed: admitted(`${kustomization.namePrefix}images`),
    factory: listed(value('/spec/variables/1/expression')),
    website: listed(value('/spec/variables/2/expression')),
  };
}

const policy = async () =>
  parse(await read('base/admission/images/policy.yaml')) as {
    spec: {
      attestors: { name: string; cosign: { keyless: { identities: Record<string, string>[] } } }[];
      variables: { name: string; expression: string }[];
      validationActions: string[];
    };
  };

/** Every image named anywhere in a manifest: a container's `image`, an image volume's `reference`, kustomize's. */
function named(node: unknown, into: Set<string>): Set<string> {
  if (Array.isArray(node)) for (const item of node) named(item, into);
  else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === 'image' && typeof value === 'string') into.add(value);
      else if (key === 'image' && value && typeof value === 'object' && 'reference' in value)
        into.add(String(value.reference));
      else if (key === 'newName' && typeof value === 'string') into.add(value);
      else named(value, into);
    }
  }
  return into;
}

/** Every image the manifests in these directories, and these files, name that is not one of ours. */
async function thirdParty(dirs: string[], files: string[]) {
  for (const dir of dirs) {
    files.push(...(await readdir(join(DEPLOY, dir))).filter((f) => f.endsWith('.yaml')).map((f) => join(dir, f)));
  }
  const images = new Set<string>();
  for (const file of files) for (const doc of parseAllDocuments(await read(file))) named(doc.toJS(), images);
  // A bare name with no digest (`factory`) is ours, pinned by the profile's kustomize `images:`; one with a digest
  // (`postgres:<tag>@<digest>`) is Docker Hub's, and one with a registry (`quay.io/...`) is that registry's.
  return [...images].filter((i) => (i.includes('/') || i.includes('@')) && !i.startsWith(OURS)).sort();
}

/** Who signed each kept case's image, as scripts/signed-by.ts read it. */
const SIGNED: Record<string, string> = { unsigned: 'none', 'other-identity': 'other', misplaced: 'pipeline' };

/** Whether the image policy's `matchImageReferences` take in an image: Kyverno verifies the signatures of these alone. */
const GLOBS = (() => {
  const globs = (
    parse(readFileSync(join(DEPLOY, 'base/admission/images/policy.yaml'), 'utf-8')) as {
      spec: { matchImageReferences: { glob: string }[] };
    }
  ).spec.matchImageReferences.map(({ glob }) => glob);
  const escaped = (part: string) => part.replace(/[.+?^$()|[\]{}\\/]/g, '\\$&');
  return globs.map((glob) => new RegExp(`^${glob.split('*').map(escaped).join('.*')}$`));
})();
function globbed(image: string) {
  return GLOBS.some((pattern) => pattern.test(image));
}

const copies = async () => [
  await copy('factory'),
  await copy('website'),
  await copy('scoreboard'),
  await copy('flagd'),
];

/** Which of the policy's checks refuses each kept case. */
const REFUSED_BY: Record<string, string> = {
  unsigned: 'images must be signed by build.yml on main of the repository that builds them: ',
  'other-identity': 'images must be signed by build.yml on main of the repository that builds them: ',
  misplaced: "images from this project's GHCR must be ones this namespace runs: ",
  'other-digest': "images must come from this project's GHCR, or be named by digest in the policy: ",
};

describe('admission control', () => {
  it("trusts each repository's build.yml on main, by its whole identity, as the deploy watch does", async () => {
    const { spec } = await policy();
    const identities = spec.attestors.flatMap((a) => a.cosign.keyless.identities);
    expect(identities).toEqual(
      REPOSITORIES.map((repo) => ({ issuer: GITHUB_ACTIONS, subject: pipeline(repo).identity })),
    );
    expect(spec.attestors.map((a) => a.name)).toEqual(['factory', 'website']);
    // One owner holds both repositories, whose GHCR the policy takes for ours.
    expect(REPOSITORIES.map((repo) => `ghcr.io/${repo.split('/')[0]}/`)).toEqual([OURS, OURS]);
    // The copies set the first three variables by position.
    expect(spec.variables.slice(0, 3).map((v) => v.name)).toEqual([
      'allowed',
      'factoryRepositories',
      'websiteRepositories',
    ]);
    // The images each attestor vouches for are its own repository's, and only those.
    const variable = (name: string) => spec.variables.find((v) => v.name === name)?.expression;
    expect(variable('factoryImages')).toContain('variables.factoryRepositories.exists(');
    expect(variable('websiteImages')).toContain('variables.websiteRepositories.exists(');
    const expression = variable('unsigned')?.replace(/\s+/g, ' ') ?? '';
    expect(expression).toMatch(
      /variables\.factoryImages\.filter\([^+]*verifyImageSignatures\(i, \[attestors\.factory\]\) == 0\)/,
    );
    expect(expression).toMatch(
      /variables\.websiteImages\.filter\([^+]*verifyImageSignatures\(i, \[attestors\.website\]\) == 0\)/,
    );
    expect(expression).not.toMatch(/factoryImages[^+]*attestors\.website|websiteImages[^+]*attestors\.factory/);
  });

  it('gives every keyless attestor in every copy one identity, as Kyverno verifies no other', async () => {
    // With two, Kyverno refuses every image it checks against that attestor: "failed to verify cosign signatures: no
    // matching attestations: unsupported: multiple identities are not supported at this time".
    const copies = render().filter((r) => r.kind === 'ImageValidatingPolicy');
    expect(copies.map((c) => c.metadata.name).sort()).toEqual([
      'factory-images',
      'flagd-images',
      'scoreboard-images',
      'website-images',
    ]);
    const several = copies.flatMap((c) =>
      (c.spec.attestors ?? [])
        .filter((a) => a.cosign?.keyless && a.cosign.keyless.identities?.length !== 1)
        .map((a) => `${c.metadata.name}: ${a.name}`),
    );
    expect(several, 'Kyverno: "multiple identities are not supported at this time"').toEqual([]);
  });

  it('takes the same images for ours in its globs, its `ours` and make admission-ready', async () => {
    const source = parse(await read('base/admission/images/policy.yaml')) as {
      spec: { matchImageReferences: { glob: string }[]; variables: { name: string; expression: string }[] };
    };
    expect(source.spec.matchImageReferences.map((m) => m.glob)).toEqual([
      `${OURS}cv-software-factory/*@*`,
      `${OURS}cv-worlds-worst-website@*`,
      `${OURS}cv-worlds-worst-website:*@*`,
    ]);
    const ours = source.spec.variables.find((v) => v.name === 'ours')?.expression ?? '';
    expect(listed(ours)).toEqual([
      `${OURS}cv-software-factory/`,
      `${OURS}cv-worlds-worst-website`,
      `${OURS}cv-worlds-worst-website:`,
      `${OURS}cv-worlds-worst-website@`,
    ]);
    const ready = readFileSync(fileURLToPath(new URL('../../../scripts/admission-ready.sh', import.meta.url)), 'utf-8');
    expect(ready).toContain(`${OURS}cv-software-factory/* | ${OURS}cv-worlds-worst-website)`);
    expect(ready).toContain(`https://github.com/${OURS.split('/')[1]}/$1/.github/workflows/build.yml@refs/heads/main`);
  });

  it('verifies the signature only: the deploy checks require the SBOM, which is too large to parse at admission', async () => {
    const source = await read('base/admission/images/policy.yaml');
    const { spec } = parse(source) as { spec: { attestations?: unknown[] } };
    expect(spec.attestations ?? []).toEqual([]);
    expect(source).not.toMatch(/verifyAttestationSignatures/);
  });

  it('guards every namespace the factory and the app run in; the rest run only upstream charts', async () => {
    const namespaces = parseAllDocuments(await read('base/namespaces.yaml')).map(
      (d) => (d.toJS() as { metadata: { name: string } }).metadata.name,
    );
    const guarded = [
      ...(await copy('factory')).namespaces,
      ...(await copy('website')).namespaces,
      ...(await copy('scoreboard')).namespaces,
      ...(await copy('flagd')).namespaces,
    ];
    const charts = ['telemetry', 'pod-logs', 'argo-rollouts'];
    expect(guarded.sort()).toEqual(namespaces.filter((n) => !charts.includes(n)).sort());
  });

  it('admits in each namespace only the images of ours that run there', async () => {
    // The factory's namespaces: every image the profile pins from build.yml, and none of the app's.
    const pinned = [...named(parse(await read('overlays/local/factory-image/kustomization.yaml')), new Set())];
    pinned.push(...named(parse(await read('overlays/local/console-image/kustomization.yaml')), new Set()));
    expect(pinned.filter((i) => !i.startsWith(`${OURS}cv-software-factory/`))).toEqual([]);
    const factory = await copy('factory');
    expect(factory.factory.sort()).toEqual(pinned.sort());
    expect(factory.website).toEqual([]);
    // The app's namespace: the app, and the factory's browser for the analysis Job that walks a canary's journeys.
    const website = await copy('website');
    expect(website.factory).toEqual([`${OURS}cv-software-factory/factory-browser`]);
    expect(website.website).toEqual([`${OURS}cv-worlds-worst-website`]);
    // The scoreboard's namespace, beside the answer key: the factory's own image, which the scoreboard runs, alone.
    const scoreboard = await copy('scoreboard');
    expect(scoreboard.namespaces).toEqual(['scoreboard']);
    expect(scoreboard.factory).toEqual([`${OURS}cv-software-factory/factory`]);
    expect(scoreboard.website).toEqual([]);
    const deployment = parse(await read('base/scoreboard/deployment.yaml')) as {
      spec: { template: { spec: { containers: { image: string }[]; initContainers?: unknown[] } } };
    };
    expect(deployment.spec.template.spec.containers.map((c) => c.image)).toEqual(['factory']);
    expect(deployment.spec.template.spec.initContainers).toBeUndefined();
    // flagd's namespace: none of ours, since flagd is all that runs there.
    const flagd = await copy('flagd');
    expect(flagd.namespaces).toEqual(['flagd']);
    expect(flagd.factory).toEqual([]);
    expect(flagd.website).toEqual([]);
  });

  it('admits from another registry only the images the factory runs, each by digest', async () => {
    const factory = await copy('factory');
    expect(factory.allowed).toEqual(
      await thirdParty(
        ['base/postgres', 'base/postgres-exporter', 'base/factory', 'base/runners', 'base/migrate', 'base/console'],
        ['k3d/artifacts-copier.yaml'],
      ),
    );
    for (const image of factory.allowed) expect(image).toMatch(/@sha256:[0-9a-f]{64}$/);
    expect((await copy('website')).allowed).toEqual([]);
    expect((await copy('scoreboard')).allowed).toEqual([]);
    expect(await thirdParty(['base/scoreboard'], [])).toEqual([]);
    // flagd's, alone, and only in its own namespace's copy: `website-images` admits no third-party image.
    const flagd = await copy('flagd');
    expect(flagd.allowed).toEqual(await thirdParty(['base/flagd'], []));
    expect(flagd.allowed).toEqual([
      expect.stringMatching(/^ghcr\.io\/open-feature\/flagd:v[\d.]+@sha256:[0-9a-f]{64}$/),
    ]);
  });

  it('refuses in every guarded namespace: nothing in deploy/ switches a copy to Audit', async () => {
    expect((await policy()).spec.validationActions).toEqual(['Deny']);
    // Only each policy sets its own mode: the images policy, the app's routes' (admin-fences.test.ts), the mark's
    // (mark-fences.test.ts), the admin service's hold on the app's Rollout (release-fences.test.ts), the holds on
    // `flags` and on the admin service's stages (flag-fences.test.ts), on `share-key` (share-fences.test.ts) and on
    // `refusal-key` (refusal-fences.test.ts), which deny too. The `try-the-line` skill switches `factory-images` to
    // Audit on the cluster for a run, and Argo CD puts it back; no manifest here does.
    // Nothing switches `website-images`, `scoreboard-images`, `flagd-images`, `website-routes`, `website-mark`,
    // `website-rollout-controls`, `website-share-key`, `factory-refusal-key`, `flagd-flags` or `flagd-flag-stages`.
    const policies = [
      join('base', 'admission', 'images', 'policy.yaml'),
      join('base', 'admission', 'website', 'routes.yaml'),
      join('base', 'admission', 'website', 'mark.yaml'),
      join('base', 'admission', 'website', 'rollout-controls.yaml'),
      join('base', 'admission', 'website', 'share-key.yaml'),
      join('base', 'admission', 'factory', 'refusal-key.yaml'),
      join('base', 'admission', 'flagd', 'flags.yaml'),
      join('base', 'admission', 'flagd', 'flag-stages.yaml'),
    ];
    const files = (await readdir(DEPLOY, { recursive: true })).filter(
      (f) => /\.ya?ml$/.test(f) && !policies.includes(f),
    );
    for (const file of files) expect(await read(file), file).not.toMatch(/validationActions/);
  });

  it("kept Kyverno's refusals in every guarded namespace (scripts/admission-refusals.sh)", async () => {
    const kept = (
      JSON.parse(await read('test/admission-refusals.json')) as {
        cases: {
          namespace: string;
          case: string;
          image: string;
          outcome: string;
          message: string;
          signature?: 'pipeline' | 'none' | 'other';
          signedBy?: string[];
        }[];
      }
    ).cases;
    const all = await copies();
    for (const { policy: name, namespaces } of all) {
      for (const namespace of namespaces) {
        const refusals = kept.filter((r) => r.namespace === namespace);
        // No image of ours runs in `flagd`, so one unsigned would be refused as misplaced: flagd's own image at
        // another digest is refused there instead.
        expect(refusals.map((r) => r.case).sort()).toEqual(
          namespace === 'flagd'
            ? ['misplaced', 'other-digest', 'other-identity']
            : ['misplaced', 'other-identity', 'unsigned'],
        );
        for (const refusal of refusals) {
          const at = `${namespace} ${refusal.case}`;
          expect(refusal.outcome, at).toBe('refused');
          // A refusal names the policy, the check that refused it and the image. In `flagd`, where no image of ours
          // runs, one signed by another is refused for its place before its signature is looked at.
          const by = namespace === 'flagd' && refusal.case === 'other-identity' ? 'misplaced' : refusal.case;
          expect(refusal.message, at).toContain(`Policy ${name} failed: ${REFUSED_BY[by]}`);
          expect(refusal.message, at).toContain(refusal.image);
          // Every image of ours is one the policy verifies, by its globs, as Kyverno verifies no other's signature.
          // So one refused for its signature was looked at, and refused for the signature it has.
          const ours = refusal.case !== 'other-digest';
          expect(globbed(refusal.image), at).toBe(ours);
          expect(refusal.signature, at).toBe(ours ? SIGNED[refusal.case] : undefined);
        }
        // An image signed by someone else, which the namespace runs: past the checks of its registry and place, and
        // refused by its signature alone, which is not build.yml's on main.
        const other = refusals.find((r) => r.case === 'other-identity');
        expect(other?.signedBy?.length, namespace).toBeGreaterThan(0);
        for (const identity of other?.signedBy ?? []) {
          expect(
            REPOSITORIES.map((repo) => pipeline(repo).identity),
            namespace,
          ).not.toContain(identity);
        }
        if (namespace !== 'flagd') {
          const runs = all.find((c) => c.namespaces.includes(namespace));
          const repository = other?.image.split('@')[0];
          expect([...(runs?.factory ?? []), ...(runs?.website ?? [])], namespace).toContain(repository);
        }
      }
    }
  });
});
