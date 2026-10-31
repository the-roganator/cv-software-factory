/**
 * Who signed an image of ours in GHCR, as the deploy watch reads it (apps/factory/src/github/signatures.ts): its
 * repository's build.yml on main, nobody, or someone else, with the identity each other signature was made by.
 * scripts/admission-refusals.sh keeps it beside each refusal, so the record shows an image refused for its signature
 * was refused for the signature it has, and not for having none.
 *
 *     node scripts/signed-by.ts ghcr.io/<owner>/<repository>[/<name>]@sha256:<digest>
 *
 * prints {"signature": "pipeline" | "none" | "other", "by": [identity...], "message"}, and fails on a signature that does
 * not verify for anyone, which is neither ours nor another's. It reads GHCR anonymously and
 * Sigstore's trust root through TUF, and writes nothing.
 */
import { Registry } from '../apps/factory/src/github/registry.ts';
import { pipeline, Signatures, UnsignedError } from '../apps/factory/src/github/signatures.ts';

export interface SignedBy {
  signature: 'pipeline' | 'none' | 'other';
  /** For `other`: the identity each signature it carries was made by, as Fulcio certified it. */
  by: string[];
  message: string;
}

/** The identities a refusal of the pipeline's signature names: "…: it is signed by <identity>". */
export const identities = (message: string) =>
  [...message.matchAll(/it is signed by (\S+?)(?=[;)]|$)/g)].map((m) => m[1] as string);

export async function signedBy(reference: string, signatures: Pick<Signatures, 'verify'>): Promise<SignedBy> {
  const match = /^ghcr\.io\/(([^/@]+\/[^/@]+)(?:\/[^@]+)?)@(sha256:[0-9a-f]{64})$/.exec(reference);
  if (!match) throw new Error(`${reference} is not an image in GHCR, by digest`);
  const [, image, repository, digest] = match as unknown as [string, string, string, string];
  const signer = pipeline(repository);
  try {
    await signatures.verify(image, digest, signer);
    return { signature: 'pipeline', by: [signer.identity], message: `signed by ${signer.identity}` };
  } catch (error) {
    if (!(error instanceof UnsignedError)) throw error;
    if (error.kind === 'unsigned') return { signature: 'none', by: [], message: error.message };
    // Refused with no identity named is a signature broken, or over another digest, or with no bundle: not one by
    // someone else, which only a signature that verified, by an identity Fulcio certified, can show.
    const by = identities(error.message);
    if (!by.length) throw new Error(`${reference} carries a signature that does not verify: ${error.message}`);
    return { signature: 'other', by, message: error.message };
  }
}

if (import.meta.main) {
  const reference = process.argv[2];
  if (!reference) {
    console.error('usage: node scripts/signed-by.ts ghcr.io/<owner>/<repository>[/<name>]@sha256:<digest>');
    process.exit(2);
  }
  console.log(JSON.stringify(await signedBy(reference, new Signatures({ registry: new Registry() }))));
}
