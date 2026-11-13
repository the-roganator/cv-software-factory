/**
 * An image reference, read one way wherever the factory reads one: `name[:tag][@digest]`, as Docker writes it.
 *
 *     ghcr.io/aquasecurity/trivy:0.69.3@sha256:…   repository ghcr.io/aquasecurity/trivy, tag 0.69.3, digest sha256:…
 *     localhost:5000/app                            repository localhost:5000/app, no tag (the colon is the port's)
 *
 * And a digest, matched by one pattern: `DIGEST` for a digest alone, `DIGEST_PATTERN` inside a larger pattern.
 *
 * Node alone: the scan's and the dependency graph's jobs run it from a sparse checkout of this folder.
 */

/** A SHA-256 digest as a registry writes one, for a pattern that holds more than the digest. */
export const DIGEST_PATTERN = 'sha256:[0-9a-f]{64}';

/** A SHA-256 digest, and nothing else. */
export const DIGEST = new RegExp(`^${DIGEST_PATTERN}$`);

/** A reference's parts, as written: nothing added for Docker Hub, nothing lowercased. */
interface ReferenceParts {
  /** The reference without its digest: the repository and its tag. */
  name: string;
  /** Without the tag or the digest, what stays the same when the pin moves. */
  repository: string;
  tag?: string | undefined;
  /** Everything after the first `@`, unchecked: `DIGEST` says whether it is one. */
  digest?: string | undefined;
}

/** `postgres:17@sha256:…` as `{ name: 'postgres:17', repository: 'postgres', tag: '17', digest: 'sha256:…' }`. */
export function splitReference(reference: string): ReferenceParts {
  const at = reference.indexOf('@');
  const name = at < 0 ? reference : reference.slice(0, at);
  const digest = at < 0 ? undefined : reference.slice(at + 1);
  // A colon after the last slash is the tag's; one before it is a registry's port.
  const slash = name.lastIndexOf('/');
  const colon = name.lastIndexOf(':');
  const tagged = colon > slash;
  return {
    name,
    repository: tagged ? name.slice(0, colon) : name,
    tag: tagged ? name.slice(colon + 1) : undefined,
    digest,
  };
}

/** An image's repository: its name without the tag or the digest, what stays the same when its pin moves. */
export const repositoryOf = (reference: string) => splitReference(reference).repository;

/** Whether a repository's first part is a registry's host, as Docker decides: one with a `.` or a port, or localhost. */
export function hasRegistry(repository: string) {
  const [first = '', ...rest] = repository.split('/');
  return rest.length > 0 && (first.includes('.') || first.includes(':') || first === 'localhost');
}

/** A reference's parts, as Docker reads one: the registry named, Docker Hub's included. */
export interface Reference {
  repository: string;
  tag?: string | undefined;
  digest?: string | undefined;
}

/** `postgres:17@sha256:…` as `{ repository: 'docker.io/library/postgres', tag: '17', digest: 'sha256:…' }`. */
export function parseReference(reference: string): Reference {
  const { repository: written, tag, digest } = splitReference(reference);
  let repository = written;
  if (!hasRegistry(repository))
    repository = `docker.io/${repository.includes('/') ? repository : `library/${repository}`}`;
  else if (repository.startsWith('index.docker.io/'))
    repository = `docker.io/${repository.slice('index.docker.io/'.length)}`;
  return { repository: repository.toLowerCase(), tag, digest };
}
