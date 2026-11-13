import { DIGEST_PATTERN } from './reference.ts';

const TRIVY = new RegExp(String.raw`^FROM (ghcr\.io/aquasecurity/trivy:(\d+\.\d+\.\d+)@${DIGEST_PATTERN})$`, 'm');

/**
 * The Trivy image a Dockerfile pins, by version and digest, as scripts/workflows.test.ts holds it. A module of its own,
 * so the coverage and graph jobs, which check out this folder without the policy, import nothing that needs it.
 */
export function trivyPin(dockerfile: string) {
  return TRIVY.exec(dockerfile);
}
