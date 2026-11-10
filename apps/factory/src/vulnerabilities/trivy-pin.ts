/**
 * The Trivy image a Dockerfile pins, by version and digest, as scripts/workflows.test.ts holds it. A module of its own,
 * so the coverage and graph jobs, which check out this folder without the policy, import nothing that needs it.
 */
export function trivyPin(dockerfile: string) {
  return /^FROM (ghcr\.io\/aquasecurity\/trivy:(\d+\.\d+\.\d+)@sha256:[0-9a-f]{64})$/m.exec(dockerfile);
}
