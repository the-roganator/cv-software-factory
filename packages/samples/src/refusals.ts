/**
 * Refusals on no work item, as the line records them over the week, and the samples' own key for the relayed ones.
 *
 * Admission control refusing an image no pipeline signed, applied by hand, and a write to the app's Rollout (the line
 * reads both from the cluster's Events); and what the GitHub worker refused the line, relayed with the record it kept
 * and its signature: a comment on an issue it did not open, a deploy it does not own, a merge the review check held,
 * whose words quote something shaped like a secret, so a visitor reads them redacted, and a 403 from GitHub whose
 * signature does not check out, so the console shows it unverified and does not count it. One more image refusal is
 * from before the week the panel shows.
 *
 * The relayed ones are signed as the GitHub worker signs, with a key made from a name, so an export is the same every
 * time; its public half is written beside the events (`refusal-key.pem`), and each record into the artifacts, where the
 * console's server checks them. Nothing real is signed with it.
 */
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import type { PayloadOf } from '@software-factory/events';
import { recordBytes } from '@software-factory/events/signed';
import { guardrailsFor } from '../../../policy/refusals.ts';
import { Item } from './build.ts';

/** Ed25519's PKCS #8 wrapping of a 32-byte seed. */
const SEED_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const SEED = createHash('sha256').update('sample-refusal-key').digest();
const KEY = createPrivateKey({ key: Buffer.concat([SEED_PREFIX, SEED]), format: 'der', type: 'pkcs8' });

/** The samples' public key, as the ConfigMap `refusal-key` holds the GitHub worker's. */
export const SAMPLE_REFUSAL_KEY = createPublicKey(KEY).export({ type: 'spki', format: 'pem' }).toString();

/** Every relayed refusal's record, by hash, to write into the artifacts. */
export const RECORDS = new Map<string, Uint8Array>();

type Refused = PayloadOf<'action.refused'>;
type Signed = Omit<Refused, 'record' | 'signature' | 'count' | 'lastAt'>;

const APP = 'the-roganator/cv-worlds-worst-website';

/**
 * A refusal the GitHub worker kept and signed, as the line appends it for no work item: with its record and signature,
 * and what was refused. `tampered` changes the payload after it was signed, so its signature does not check out.
 */
function relayed(
  repo: string,
  number: number | null,
  at: string,
  payload: Signed,
  tampered?: Partial<Signed>,
): Refused {
  const bytes = recordBytes({ repo, number, at, payload });
  const record = createHash('sha256').update(bytes).digest('hex');
  RECORDS.set(record, bytes);
  return {
    ...payload,
    ...tampered,
    record,
    signature: sign(null, bytes, KEY).toString('base64'),
    subject: {
      kind: number === null ? 'repository' : 'issue or pull request',
      name: number === null ? repo : `${repo}#${number}`,
    },
  };
}

const line = new Item(null, '2026-09-29T11:00:00+01:00', 'line/refusals');

/** A relayed refusal at an offset from the start, signed at that time. */
const at = (offset: string) => line.time(offset);

export default line
  // Before the week the panel shows: an image applied by hand in factory.
  .at('0:00', 'action.refused', 'factory', 'Admission control refused a pod: its image is not signed', {
    mechanism: 'admission-control',
    action: 'Admit Pod factory/scratch, refused by factory-images',
    output:
      'admission webhook "ivpol.validate.kyverno.svc-fail-finegrained-factory-images" denied the request: Policy factory-images failed: images must be signed by build.yml on main',
    guardrails: guardrailsFor('admission-control', 'image'),
    subject: { namespace: 'factory', kind: 'Pod', name: 'scratch', uid: '7f3c9a52-0d4e-4b1a-9c2f-5e8d6a1b3c40' },
  })
  // Thursday morning: another, an image built on the Mac, applied by hand.
  .at('46:12:00', 'action.refused', 'factory', 'Admission control refused a pod: its image is not signed', {
    mechanism: 'admission-control',
    action: 'Admit Pod factory/try-runner, refused by factory-images',
    output:
      'admission webhook "ivpol.validate.kyverno.svc-fail-finegrained-factory-images" denied the request: Policy factory-images failed: images must be signed by build.yml on main: ghcr.io/the-roganator/cv-software-factory/factory-runner:dev',
    guardrails: guardrailsFor('admission-control', 'image'),
    subject: { namespace: 'factory', kind: 'Pod', name: 'try-runner', uid: '2b8e4f10-6c3d-4e7a-8b19-0a5d2c7e9f31' },
  })
  // Friday: a comment on an issue someone else opened, which the GitHub worker's guard refused.
  .at(
    '72:02:00',
    'action.refused',
    'factory',
    'The GitHub worker refused an action: github-guard',
    relayed(APP, 41, at('72:02:00'), {
      mechanism: 'github-guard',
      action: `Comment on issue #41 in ${APP}`,
      output: `refused: issue #41 in ${APP} was not opened by the factory's App, which acts only on what it opened`,
      guardrails: guardrailsFor('github-guard', 'issue'),
    }),
  )
  // Saturday: a write to the app's Rollout by hand, which only the admin service may pause.
  .at('101:20:00', 'action.refused', 'factory', 'Admission control refused a write to the app’s Rollout', {
    mechanism: 'admission-control',
    action: 'Admit Rollout website/website, refused by rollout-controls',
    output:
      "ValidatingAdmissionPolicy 'rollout-controls' with binding 'rollout-controls' denied request: the admin service may change only spec.paused of the app's Rollout",
    guardrails: guardrailsFor('admission-control', 'production'),
    subject: { namespace: 'website', kind: 'Rollout', name: 'website' },
  })
  // Sunday: a merge the review check held for a risk tag; its summary quotes a test's credential, which a visitor reads
  // redacted.
  .at(
    '120:30:00',
    'action.refused',
    'factory',
    'The GitHub worker refused an action: review-gate',
    relayed(APP, 1305, at('120:30:00'), {
      mechanism: 'review-gate',
      action: `merge #1305 in ${APP}`,
      output:
        'review: held · test-loosening: test/login.test.ts no longer checks the login of password=hunter2, a wrong one · needs Martin’s approval at its head',
      guardrails: guardrailsFor('review-gate', 'risk'),
    }),
  )
  // Monday afternoon: GitHub's 403 to the App's token, whose payload was changed after it was signed.
  .at(
    '148:05:00',
    'action.refused',
    'factory',
    'The GitHub worker refused an action: token-permission',
    relayed(
      APP,
      null,
      at('148:05:00'),
      {
        mechanism: 'token-permission',
        action: `commit branch factory/1308 in ${APP}`,
        output:
          'refusing to allow a GitHub App to create or update workflow `.github/workflows/check.yml` without `workflows` permission',
        guardrails: guardrailsFor('token-permission', 'forbidden'),
      },
      { action: `commit branch factory/1308-canary in ${APP}` },
    ),
  )
  // Tuesday morning: a deploy pull request the line does not own, which the guard refused.
  .at(
    '166:40:00',
    'action.refused',
    'factory',
    'The GitHub worker refused an action: github-guard',
    relayed('the-roganator/cv-software-factory', null, at('166:40:00'), {
      mechanism: 'github-guard',
      action: 'openDeploy branch deploy/console in the-roganator/cv-software-factory',
      output: 'refused: branch deploy/console is not one of the factory’s deploy branches',
      guardrails: guardrailsFor('github-guard', 'deploy'),
    }),
  );
