import { describe, expect, it } from 'vitest';
import { UnsignedError } from '../apps/factory/src/github/signatures.ts';
import { signedBy } from './signed-by.ts';

const IMAGE = `ghcr.io/the-roganator/cv-software-factory/factory@sha256:${'a'.repeat(64)}`;
const OTHER =
  'https://github.com/the-roganator/cv-software-factory/.github/workflows/other-identity.yml@refs/heads/refusal/other-identity';
const refusing = (error: Error) => ({
  verify: async () => {
    throw error;
  },
});

describe('who signed an image', () => {
  it('is the pipeline when its signature verifies as build.yml on main', async () => {
    const found = await signedBy(IMAGE, { verify: async () => {} });
    expect(found.signature).toBe('pipeline');
  });

  it('is nobody when it carries no signature', async () => {
    const found = await signedBy(IMAGE, refusing(new UnsignedError('unsigned', `${IMAGE} has no signature`)));
    expect(found).toMatchObject({ signature: 'none', by: [] });
  });

  it('is someone else only when a signature verified, by an identity that is not the pipeline’s', async () => {
    const message = `${IMAGE} has no signature by build.yml (sha256:0123456789ab…: it is signed by ${OTHER})`;
    const found = await signedBy(IMAGE, refusing(new UnsignedError('refused', message)));
    expect(found).toMatchObject({ signature: 'other', by: [OTHER] });
  });

  it('fails on a signature that verifies for nobody, rather than call it another’s', async () => {
    for (const why of ['it holds no bundle', 'signature verification failed', 'it is signed by no identity']) {
      const message = `${IMAGE} has no signature by build.yml (sha256:0123456789ab…: ${why})`;
      await expect(signedBy(IMAGE, refusing(new UnsignedError('refused', message)))).rejects.toThrow('does not verify');
    }
  });
});
