import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { REAL, repositoriesFrom } from '../../../policy/repositories.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

const COPIES = { factory: 'the-roganator/scratch-factory', app: 'the-roganator/scratch-app' };

describe('the two repositories', () => {
  it('are the real two unless a setting names another, blank or spaced as unset', () => {
    expect(repositoriesFrom({})).toEqual(REAL);
    expect(repositoriesFrom({ FACTORY_REPOSITORY: '', APP_REPOSITORY: '  ' })).toEqual(REAL);
    expect(repositoriesFrom({ FACTORY_REPOSITORY: ` ${COPIES.factory} `, APP_REPOSITORY: COPIES.app })).toEqual(COPIES);
    expect(repositoriesFrom({ APP_REPOSITORY: COPIES.app })).toEqual({ factory: REAL.factory, app: COPIES.app });
  });

  it('refuses a name outside the-roganator, in another case, not owner/name, or one for both', () => {
    for (const name of [
      'someone/cv-worlds-worst-website',
      'The-Roganator/scratch-app',
      'the-roganator/Scratch',
      'scratch-app',
      'the-roganator/a/b',
    ])
      expect(() => repositoriesFrom({ APP_REPOSITORY: name }), name).toThrow(
        /APP_REPOSITORY is .*the-roganator\/<name>/,
      );
    expect(() => repositoriesFrom({ APP_REPOSITORY: REAL.factory })).toThrow(/must be two/);
  });

  /** What each part that decides by name takes the two to be, in a process of its own given `env`. */
  function decided(env: Record<string, string>) {
    const script = `
      const { DEPLOYS } = await import('./apps/factory/src/github/deploys.ts');
      const { QUEUES_DEPLOYS_IN } = await import('./apps/factory/src/github/deploy-queue.ts');
      const { PIN_REPOS } = await import('./apps/factory/src/github/pins.ts');
      const { REPOSITORIES } = await import('./apps/factory/src/github/config.ts');
      const { APP_REPOSITORY } = await import('./apps/factory/src/line/worker.ts');
      const { SMOKE_REPOSITORY } = await import('./apps/factory/src/runners/smoke.ts');
      const { APP } = await import('./apps/factory/src/vulnerabilities/moves.ts');
      const inventory = await import('./apps/factory/src/vulnerabilities/inventory.ts');
      const routing = await import('./scripts/review-routing.ts');
      const settings = await import('./scripts/github-settings.ts');
      const { REPOSITORY: PROVED_IN } = await import('./apps/factory/src/guardrails/proofs.ts');
      console.log(JSON.stringify({
        deploys: DEPLOYS.map((d) => [d.repo, ...d.pins.flatMap((p) => p.images.map((i) => i.image))]),
        queuesDeploysIn: QUEUES_DEPLOYS_IN,
        pinRepos: PIN_REPOS,
        worker: REPOSITORIES,
        line: APP_REPOSITORY,
        smoke: SMOKE_REPOSITORY,
        scanApp: APP,
        signers: ['factory', 'app'].map((r) => inventory.signerOf('ghcr.io/' + ${JSON.stringify(COPIES)}[r] + '/x')),
        realSigners: ['factory', 'app'].map((r) => inventory.signerOf('ghcr.io/' + ${JSON.stringify(REAL)}[r] + '/x')),
        gate: [routing.FACTORY_REPO, routing.APP_REPO],
        settings: Object.keys(settings.REPOSITORIES),
        provedIn: PROVED_IN,
      }));`;
    const { FACTORY_REPOSITORY: _f, APP_REPOSITORY: _a, ...rest } = process.env;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: ROOT,
      env: { ...rest, LOG_LEVEL: 'silent', ...env },
      encoding: 'utf-8',
    });
    return JSON.parse(out.trim().split('\n').at(-1) ?? '');
  }

  const expected = ({ factory, app }: typeof COPIES) => ({
    deploys: [
      [factory, `${factory}/console`, `${factory}/factory`, `${factory}/factory-browser`, `${factory}/factory-runner`],
      [app, app],
    ],
    queuesDeploysIn: factory,
    pinRepos: [factory],
    worker: [factory, app],
    line: app,
    smoke: app,
    scanApp: app,
    gate: [factory, app],
    settings: [factory, app],
    provedIn: factory,
  });

  it('are the real two everywhere they decide, when nothing names copies', { timeout: 30_000 }, () => {
    const real = decided({});
    expect(real).toMatchObject(expected(REAL));
    expect(real.realSigners).toEqual([
      `https://github.com/${REAL.factory}/.github/workflows/build.yml@refs/heads/main`,
      `https://github.com/${REAL.app}/.github/workflows/build.yml@refs/heads/main`,
    ]);
    expect(real.signers).toEqual([null, null]);
  });

  it('are the copies everywhere they decide, when the settings name them, and the real two are none of ours', {
    timeout: 30_000,
  }, () => {
    const copies = decided({ FACTORY_REPOSITORY: COPIES.factory, APP_REPOSITORY: COPIES.app });
    expect(copies).toMatchObject(expected(COPIES));
    expect(copies.signers).toEqual([
      `https://github.com/${COPIES.factory}/.github/workflows/build.yml@refs/heads/main`,
      `https://github.com/${COPIES.app}/.github/workflows/build.yml@refs/heads/main`,
    ]);
    expect(copies.realSigners).toEqual([null, null]);
  });
});
