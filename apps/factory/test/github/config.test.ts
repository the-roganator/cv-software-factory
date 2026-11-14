import { describe, expect, it } from 'vitest';
import { configFromEnv, REPOSITORIES, stateKeyName } from '../../src/github/config.ts';
import { newKey } from '../../src/vulnerabilities/state.ts';
import { type Manifest, manifests } from '../deploy.ts';

describe('the GitHub worker’s settings', () => {
  it('fail closed on the dry run: an unclear answer, or nowhere to record, stops it starting', () => {
    expect(() => configFromEnv({ GITHUB_DRY_RUN: 'yes', ARTIFACTS_DIR: '/tmp/a' })).toThrow('must be true or false');
    expect(() => configFromEnv({ GITHUB_DRY_RUN: 'true' })).toThrow('ARTIFACTS_DIR');
    expect(configFromEnv({ GITHUB_DRY_RUN: 'True', ARTIFACTS_DIR: '/tmp/a' }).dryRun).toBe(true);
    expect(configFromEnv({}).dryRun).toBe(false);
  });

  it('listen on loopback unless told otherwise, on a port that is a port', () => {
    expect(configFromEnv({}).host).toBe('127.0.0.1');
    expect(configFromEnv({ HOST: '0.0.0.0' }).host).toBe('0.0.0.0');
    expect(() => configFromEnv({ PORT: 'eighty' })).toThrow('port number');
  });

  it('take each repository’s key for its scan’s state from a setting of its own, and only those given', () => {
    expect(REPOSITORIES.map(stateKeyName)).toEqual([
      'SCAN_STATE_KEY_CV_SOFTWARE_FACTORY',
      'SCAN_STATE_KEY_CV_WORLDS_WORST_WEBSITE',
    ]);
    expect(stateKeyName('someone/a.b-c')).toBe('SCAN_STATE_KEY_A_B_C');
    expect(configFromEnv({}).stateKeys).toEqual(new Map());
    const [factory, app] = [newKey(), newKey()];
    const both = configFromEnv({
      SCAN_STATE_KEY_CV_SOFTWARE_FACTORY: factory,
      SCAN_STATE_KEY_CV_WORLDS_WORST_WEBSITE: `${app}\n`,
    }).stateKeys;
    expect([...both.keys()]).toEqual(REPOSITORIES);
    expect(both.get(REPOSITORIES[0] ?? '')?.toString('base64')).toBe(factory);
    expect(both.get(REPOSITORIES[1] ?? '')?.toString('base64')).toBe(app);
    // One alone, and one left empty as an optional Secret's is: only the one given.
    const one = configFromEnv({
      SCAN_STATE_KEY_CV_SOFTWARE_FACTORY: factory,
      SCAN_STATE_KEY_CV_WORLDS_WORST_WEBSITE: '',
    });
    expect([...one.stateKeys.keys()]).toEqual([REPOSITORIES[0]]);
    // A repository it does not act on has no key read.
    const narrowed = configFromEnv({
      GITHUB_REPOSITORIES: 'someone/else',
      SCAN_STATE_KEY_CV_SOFTWARE_FACTORY: factory,
    });
    expect(narrowed.stateKeys).toEqual(new Map());
    expect(
      configFromEnv({ GITHUB_REPOSITORIES: 'someone/else', SCAN_STATE_KEY_ELSE: app }).stateKeys.has('someone/else'),
    ).toBe(true);
  });

  it('stop it starting on a key that is set and is not one, naming the setting and never its text', () => {
    for (const bad of ['c2VjcmV0', Buffer.alloc(16, 1).toString('base64'), Buffer.alloc(33, 1).toString('base64')]) {
      let error: Error | undefined;
      try {
        configFromEnv({ SCAN_STATE_KEY_CV_WORLDS_WORST_WEBSITE: bad });
      } catch (e) {
        error = e as Error;
      }
      expect(error?.message).toBe(
        'SCAN_STATE_KEY_CV_WORLDS_WORST_WEBSITE is not a key for a scan’s state: it must be 32 bytes in base64.',
      );
      expect(error?.message).not.toContain(bad);
    }
  });

  it('are given each key the deployment names, from the Secret `make scan-state-key` makes, optional', async () => {
    type Deployment = Manifest & { spec?: { template: { spec: { containers: { env?: { name: string }[] }[] } } } };
    const worker = (await manifests<Deployment>()).find(
      ({ manifest }) => manifest.kind === 'Deployment' && manifest.metadata?.name === 'github',
    );
    const env = worker?.manifest.spec?.template.spec.containers[0]?.env;
    for (const repo of REPOSITORIES) {
      const name = stateKeyName(repo);
      expect(env?.find((each) => each.name === name)).toEqual({
        name,
        valueFrom: { secretKeyRef: { name: 'scan-state-key', key: repo.split('/')[1], optional: true } },
      });
    }
  });
});
