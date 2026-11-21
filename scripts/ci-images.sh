#!/usr/bin/env bash
# CI's copy of the third-party images the repository pins, in this repository's GHCR: Docker's official images, and
# Playwright's from Microsoft's registry.
#
# Hosted runners share their addresses, and Docker Hub limits anonymous pulls by address, so CI's pulls of the images
# the repository pins fail now and then; Microsoft's registry is now and then slow, a few minutes for Playwright's
# image. Every pin names its own registry, as `node:<tag>@<digest>` or `mcr.microsoft.com/playwright:<tag>@<digest>`,
# which the cluster pulls and Dependabot reads. CI pulls the same digest from this repository's GHCR instead, when it is
# there, and from its own registry when it is not yet. Only caches.yml writes to GHCR, copying once a day: a handful of
# requests.
#
#   ci-images.sh resolve <ref>      the copy of <ref>, by digest, if it can be pulled with no credentials; else <ref>
#   ci-images.sh postgres           the same, for the Postgres the cluster runs: its one pin is its StatefulSet's
#   ci-images.sh contexts <name>…   for each, the build contexts that point each FROM its Dockerfile pins at the copy, as
#                                   the step output <name>, for build-push-action's build-contexts: apps/<name>/Dockerfile,
#                                   or for `browser`, apps/factory/Dockerfile.browser
#   ci-images.sh sync               copy into GHCR every pinned digest, each pinned tag's current one, and the newest tag
#                                   of each pin's line, then each image the cluster runs (`cluster`), with crane, which
#                                   must be logged in to ghcr.io (caches.yml); every read is crane's, with no credentials
#   ci-images.sh cluster            each third-party image the cluster runs (scripts/cluster-images.ts), its copy, and
#                                   whether the copy is there and current, copying nothing; it fails only when an image
#                                   cannot be listed, read or given a copy, not for a copy not made yet
#
# A copy is byte for byte, by digest: Docker Hub's <name>@<digest> at ghcr.io/<repository>/mirror/docker/library/<name>,
# Microsoft's mcr.microsoft.com/<name>@<digest> at ghcr.io/<repository>/mirror/mcr/<name>. Its one tag,
# digest-<hex>, never moves, and nothing reads it.
#
# The platform check's cluster pulls every image it runs from a registry deploy/k3d/ci-registries.yaml names from the
# copy that file's rewrite gives (Docker Hub's official images among them, at the same copies), and from the image's
# own registry when the copy is not there. An image pinned by digest is copied as a pin is; one the cluster pulls by
# tag (most charts' images) is copied under that tag, and again whenever the tag names another digest upstream, so the
# copy is what the image's own registry would give, to the day.
set -uo pipefail

# Microsoft's registry, which the repository pins Playwright's image from, by its whole name.
MCR=mcr.microsoft.com/
# GHCR's names are lowercase.
MIRROR=ghcr.io/$(tr '[:upper:]' '[:lower:]' <<< "${GITHUB_REPOSITORY:-the-roganator/cv-software-factory}")/mirror/
# A pin, as a Dockerfile's FROM or a manifest's image names it: a name with no registry (Docker Hub's official images)
# or Playwright's on Microsoft's registry, an optional tag, and a digest. The pin is its last word.
PIN='(^FROM|image:) +([a-z0-9._-]+|mcr\.microsoft\.com/playwright)(:[A-Za-z0-9._-]+)?@sha256:[0-9a-f]{64}'

# The pins in grep's matches.
pins() { awk '{print $NF}'; }

# crane with no credentials, as CI's jobs pull: a Docker config of its own with nothing in it, so no login, credential
# helper or Podman's auth file is read (go-containerregistry's default keychain reads the first it finds).
ANONYMOUS=$(mktemp -d) && echo '{}' > "$ANONYMOUS/config.json" || exit 1
trap 'rm -rf "$ANONYMOUS"' EXIT
anonymous() { env -u DOCKER_AUTH_CONFIG DOCKER_CONFIG="$ANONYMOUS" crane "$@"; }

# Where a pin's name comes from, by its whole name: Docker Hub's official images under docker.io/library/.
upstream_of() { if [[ "$1" == "$MCR"* ]]; then echo "$1"; else echo "docker.io/library/$1"; fi; }

# The copy of a pin, by digest.
mirror_of() {
  local name=${1%@*}
  name=${name%%:*}
  if [[ "$name" == "$MCR"* ]]; then echo "${MIRROR}mcr/${name#"$MCR"}@${1##*@}"; else echo "${MIRROR}docker/library/$name@${1##*@}"; fi
}

# Copies an image to a tag, every platform, byte for byte, so the copy's digest is the source's: crane copies an index's
# manifest as it is, an index whose entries carry an artifactType (Kyverno's) among them. Tried again on a fault, three
# times, as a registry that limits by address now and then refuses one; crane must be logged in to the copy's registry
# (caches.yml).
crane_copy() {
  local from=$1 to=$2 try
  for try in 1 2 3 4; do
    crane copy "$from" "$to" && return 0
    [ "$try" -lt 4 ] && echo "$to: the copy failed, trying again" >&2 && sleep $((try * 10))
  done
  return 1
}

# Whether an image can be pulled with no credentials, as CI's jobs pull it.
pullable() { anonymous manifest "$1" > /dev/null 2>&1; }

resolve() {
  local ref=$1 copy
  copy=$(mirror_of "$ref")
  if pullable "$copy"; then
    echo "$copy"
  else
    echo "::warning::$ref is not in GHCR yet, so it comes from its own registry (caches.yml copies it daily)" >&2
    echo "$ref"
  fi
}

postgres() {
  local pin
  pin=$(grep -oE "$PIN" deploy/base/postgres/statefulset.yaml | pins)
  [ -n "$pin" ] || { echo "::error::No Postgres pin found" >&2 && return 1; }
  resolve "$pin"
}

contexts() {
  local app dockerfile ref copy
  for app in "$@"; do
    dockerfile=apps/$app/Dockerfile
    [ "$app" = browser ] && dockerfile=apps/factory/Dockerfile.browser
    {
      echo "$app<<EOF"
      for ref in $(grep -oE "$PIN" "$dockerfile" | pins | sort -u); do
        copy=$(resolve "$ref")
        [ "$copy" = "$ref" ] || echo "$ref=docker-image://$copy"
      done
      echo EOF
    } >> "$GITHUB_OUTPUT"
  done
}

# The newest tag on a pin's line: the same first number, as many numbers, and the same prefix and suffix
# (24.21.0-alpine3.24 → 24.x.y-alpine3.24, v1.64.1-noble → v1.x.y-noble), the tag Dependabot would move the pin to,
# outside a major version. Nothing for a tag that is not a version; fails when the tags cannot be listed.
newest() {
  local name=$1 tag=$2 prefix version suffix pattern tags
  version=${tag%%-*}
  prefix=${version%%[0-9]*}
  version=${version#"$prefix"}
  [[ "$prefix" =~ ^v?$ && "$version" =~ ^[0-9]+(\.[0-9]+)*$ ]] || return 0
  suffix=${tag#"$prefix$version"}
  pattern="^$prefix${version%%.*}$(sed -E 's/[0-9]+/[0-9]+/g; s/\./\\./g' <<< "${version#"${version%%.*}"}")$(sed 's/\./\\./g' <<< "$suffix")\$"
  tags=$(anonymous ls "$(upstream_of "$name")") || return 1
  { grep -E "$pattern" <<< "$tags" || true; } | sort -V | tail -n 1
}

# The digest a tag names on its own registry now: the SHA-256 of its raw manifest, piped as it is (a command
# substitution would drop its last newline, and so change its digest); pipefail fails the function when crane does.
current() { anonymous manifest "$(upstream_of "$1")" | sha256sum | sed 's/^/sha256:/; s/ .*//'; }

sync() {
  local failed=() wanted=() pins ref name tag latest digest copy
  pins=$(git grep -hoE "$PIN" -- ':!*.md' | pins | sort -u)
  [ -n "$pins" ] || { echo "::error::No pin of a third-party image found" && return 1; }
  # What to copy, as name@digest: every pin, and the current digest of each pinned tag and of its line's newest tag.
  for ref in $pins; do
    name=${ref%@*}
    wanted+=("${name%%:*}@${ref##*@}")
    [[ "$name" == *:* ]] || continue
    tag=${name#*:}
    name=${name%%:*}
    latest=$(newest "$name" "$tag") || failed+=("$name: could not list its tags")
    for tag in "$tag" "$latest"; do
      [ -n "$tag" ] || continue
      if digest=$(current "$name:$tag"); then
        wanted+=("$name@$digest")
      else
        failed+=("$name:$tag: could not read its digest")
      fi
    done
  done
  # Docker's images first: Playwright's is two gigabytes, so a slow copy of it cannot hold the others up.
  for ref in $(printf '%s\n' "${wanted[@]}" | sort -u | grep -v "^$MCR"; printf '%s\n' "${wanted[@]}" | sort -u | grep "^$MCR"); do
    copy=$(mirror_of "$ref")
    if pullable "$copy"; then
      echo "$copy: copied already"
      continue
    fi
    echo "$copy: copying from $(upstream_of "$ref")"
    if ! crane_copy "$(upstream_of "$ref")" "${copy%@*}:digest-${ref##*:}"; then
      failed+=("$copy: the copy failed")
    elif ! pullable "$copy"; then
      # A private package would send every build back to the image's own registry, with only a warning.
      failed+=("$copy: copied, but it cannot be pulled with no credentials: make ${copy%@*} public in its settings")
    fi
  done
  [ ${#failed[@]} -eq 0 ] && return 0
  printf '::error::%s\n' "${failed[@]}"
  return 1
}

# The platform check's cluster's registries, and where each one's copies are.
REGISTRIES=deploy/k3d/ci-registries.yaml

# An image as containerd pulls it: its registry, its path there, its tag (`latest` for none) and its digest (`-` for
# none), Docker Hub's for a name with no registry or index.docker.io's, and under `library/` for one of Docker's
# official images.
parse() {
  local ref=$1 digest=- tag=latest registry=docker.io
  [[ "$ref" == *@* ]] && digest=${ref##*@} && ref=${ref%@*}
  if [[ "$ref" == */* && ("${ref%%/*}" == *.* || "${ref%%/*}" == *:* || "${ref%%/*}" == localhost) ]]; then
    registry=${ref%%/*}
    ref=${ref#*/}
  fi
  [[ "$registry" == index.docker.io ]] && registry=docker.io
  [[ "$registry" == docker.io && "$ref" != */* ]] && ref=library/$ref
  [[ "${ref##*/}" == *:* ]] && tag=${ref##*:} && ref=${ref%:*}
  echo "$registry $ref $tag $digest"
}

# The digest a reference names now, with no credentials, as containerd would resolve it: the SHA-256 of its raw
# manifest, kept in a file as it is (a command substitution would drop its last newline, and so change its digest).
# Tried again on a fault, three times, as a registry that limits by address now and then refuses one; not on the
# registry's answer that there is no such image, or none to read without a login.
digest_of() {
  local try manifest=$ANONYMOUS/manifest error=$ANONYMOUS/error
  for try in 1 2 3 4; do
    if anonymous manifest "$1" > "$manifest" 2> "$error"; then
      sha256sum < "$manifest" | sed 's/^/sha256:/; s/ .*//'
      return 0
    fi
    grep -qE 'MANIFEST_UNKNOWN|NAME_UNKNOWN|DENIED|UNAUTHORIZED' "$error" && break
    [ "$try" -lt 4 ] && sleep $((try * 5))
  done
  cat "$error" >&2
  return 1
}

# Each image the cluster runs, against its copy: `check` says whether each is there and current, `sync` copies each
# that is not.
cluster() {
  local mode=$1 failed=() images ref registry path tag digest rewrite copy from target want have
  images=$(node scripts/cluster-images.ts .) || failed+=("the cluster's images could not all be listed: the errors above say which")
  for ref in $images; do
    want= have=
    read -r registry path tag digest <<< "$(parse "$ref")"
    rewrite=$(yq ".mirrors[\"$registry\"].rewrite[\"^(.*)\$\"] // \"\"" "$REGISTRIES")
    if [ -z "$rewrite" ]; then
      failed+=("$ref: $REGISTRIES names no copy for $registry, so the platform check pulls it from there")
      continue
    fi
    copy=ghcr.io/${rewrite//\$1/$path}
    if [ "$digest" != - ]; then
      from=$registry/$path@$digest
      target=$copy@$digest
      if pullable "$target"; then echo "$target: copied already"; continue; fi
    else
      from=$registry/$path:$tag
      target=$copy:$tag
      if ! want=$(digest_of "$from"); then failed+=("$ref: could not read its digest"); continue; fi
      have=$(digest_of "$target" 2> /dev/null) || have=
      if [ "$want" = "$have" ]; then echo "$target: copied already, at $want"; continue; fi
    fi
    if [ "$mode" = check ]; then echo "$target: not copied${have:+ (the copy is at $have)}, from $from"; continue; fi
    echo "$target: copying from $from"
    # A digest's copy is tagged digest-<hex>, as a pin's.
    if ! crane_copy "$from" "$([ "$digest" != - ] && echo "$copy:digest-${digest#sha256:}" || echo "$target")"; then
      failed+=("$target: the copy failed")
    elif ! pullable "$target"; then
      failed+=("$target: copied, but it cannot be pulled with no credentials: make $copy public in its settings")
    fi
  done
  [ ${#failed[@]} -eq 0 ] && return 0
  printf '::error::%s\n' "${failed[@]}"
  return 1
}

case "${1:-}" in
  resolve) resolve "$2" ;;
  postgres) postgres ;;
  contexts) shift && contexts "$@" ;;
  sync)
    status=0
    sync || status=1
    cluster sync || status=1
    exit "$status"
    ;;
  cluster) cluster check ;;
  *) echo "usage: $0 resolve <ref> | postgres | contexts <app>... | sync | cluster" >&2 && exit 2 ;;
esac
