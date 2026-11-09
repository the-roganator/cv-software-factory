/**
 * The daily scan's proof that it can see: an image of ours that `main` pinned while it ran Node 24.22.0, before #536
 * moved it to 24.22.1. It is the runner, whose runtime was `node:24.22.0-trixie-slim`, as `build.yml` signed it on the
 * repository's `main` under the owner it had then. Every run scans it as it scans ours, uploads nothing for it, and
 * fails unless the advisory is found in its Node. Nothing runs it: inventory.ts passes over this reference alone.
 */
export const PROOF = {
  file: 'apps/factory/src/vulnerabilities/proof.ts',
  image:
    'ghcr.io/mrogan/cv-software-factory/factory-runner@sha256:464bf089bc42ffd0df9decbf2640152ede7d6c602691764d5cf09f03e36eb622',
  signer: 'https://github.com/mrogan/cv-software-factory/.github/workflows/build.yml@refs/heads/main',
  advisory: 'CVE-2026-111497',
} as const;
