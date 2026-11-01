#!/usr/bin/env bash
# Runs the prepare step in a factory-runner image, as the line's prepare pod runs it, and fails unless it leaves the
# agent step what it needs. CI runs it on the image each pull request builds (check.yml's `image` job), so an image
# whose prepare cannot run fails its pull request before it is ever pinned. On the Mac, against an image built there:
#
#     docker build --file apps/runner/Dockerfile --tag factory-runner:try .
#     apps/runner/scripts/image-check.sh factory-runner:try
#
# The container is the prepare pod's (apps/factory/src/runners/jobs.ts): user 65532, a read-only root, every
# capability dropped, /work, /tmp and /prepare its only writable folders, and the pod's environment. It has no network
# at all, where the pod has DNS and 443 out: the check must not depend on the internet, and whatever the image would
# fetch, such as a pnpm, fails here as it fails in a pod with a read-only home.
#
# Its origin is a small repository made here, cloned by path as prepare's tests do: a package whose one dependency is
# a folder of its own, so its lockfile installs offline. It names a pnpm of the image's major but another version, as
# the app's does (this repository's is the one the image holds), so an image that tries to switch to it fails.
#
# It passes when prepare exits 0, the checkout on /work is at the commit, and its dependency is installed. What prepare
# checks and logs itself, the two pnpm versions among it, is in its output, printed as it runs.
set -euo pipefail

image=${1:?usage: image-check.sh <image>}
root=$(cd "$(dirname "$0")/../../.." && pwd)

# This repository's pnpm, the image's (mise.lock, held equal to package.json's by scripts/toolchain.test.ts), and
# another of its major for the checkout to name: x.0.0, or x.0.1 when that is the image's own.
own=$(sed -nE 's/^ *"packageManager": "pnpm@([0-9]+\.[0-9]+\.[0-9]+).*/\1/p' "$root/package.json")
[ -n "$own" ] || { echo "package.json names no pnpm" >&2; exit 1; }
named="${own%%.*}.0.0"
[ "$named" != "$own" ] || named="${own%%.*}.0.1"

# Everything it makes is its own, and goes when it ends, however it ends.
id="runner-image-check-$$"
fixture=$(mktemp -d)
cleanup() {
  rm -rf "$fixture"
  docker volume rm --force "$id-origin" "$id-work" > /dev/null
}
trap cleanup EXIT

git_() { git -C "$fixture" -c user.name=check -c user.email=check@factory.invalid "$@"; }
git_ init --quiet
mkdir "$fixture/dep"
cat > "$fixture/package.json" << EOF
{ "name": "shop", "private": true, "packageManager": "pnpm@$named", "dependencies": { "dep": "link:dep" } }
EOF
echo '{ "name": "dep", "version": "1.0.0" }' > "$fixture/dep/package.json"
cat > "$fixture/pnpm-lock.yaml" << 'EOF'
lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .:
    dependencies:
      dep:
        specifier: link:dep
        version: link:dep
EOF
echo 'export const count = 1;' > "$fixture/count.ts"
git_ add .
git_ commit --quiet --message base
# Fetching a commit by its sha, as GitHub allows.
git_ config uploadpack.allowReachableSHA1InWant true
commit=$(git_ rev-parse HEAD)

# The origin and the job's volume, owned by the pod's user as a PVC with its fsGroup is: git refuses a repository
# another user owns.
docker volume create "$id-origin" > /dev/null
docker volume create "$id-work" > /dev/null
docker run --rm --network none --user 0:0 --entrypoint sh \
  --volume "$fixture:/fixture:ro" --volume "$id-origin:/origin" --volume "$id-work:/work" \
  "$image" -c 'cp -a /fixture/. /origin/ && chown -R 65532:65532 /origin /work'

step=$(printf '{"agent":"coder","repository":"file:///origin","commit":"%s","prompt":"Check the image.","maxTurns":1}' "$commit")
echo "The prepare step, in $image, on a checkout that names pnpm $named (the image's should be $own):"
status=0
docker run --rm --network none --read-only --user 65532:65532 --cap-drop ALL --security-opt no-new-privileges \
  --tmpfs /tmp:exec,mode=0777 --tmpfs /prepare:exec,mode=0777 \
  --volume "$id-work:/work" --volume "$id-origin:/origin:ro" \
  --env WORK=/work --env PREPARE=/prepare --env HOME=/prepare/home --env npm_config_store_dir=/prepare/store \
  --env RUNNER_JOB=coder-0-1-1 --env RUNNER_WORK_ITEM=0 --env RUNNER_STEP="$step" \
  "$image" prepare || status=$?
if [ "$status" -ne 0 ]; then
  echo "::error::The prepare step failed in $image (exit $status): a runner on it could take no work."
  exit 1
fi

# What the agent step reads: the checkout at the commit, and its dependencies installed in it.
if ! docker run --rm --network none --read-only --user 65532:65532 --entrypoint sh \
  --volume "$id-work:/work:ro" "$image" -c '
    head=$(git -C /work/repo rev-parse HEAD) && [ "$head" = "$1" ] || { echo "the checkout is at ${head:-nothing}, not $1"; exit 1; }
    [ -f /work/repo/node_modules/dep/package.json ] || { echo "its dependencies are not installed"; exit 1; }
  ' check "$commit"; then
  echo "::error::The prepare step in $image ended, but did not leave the agent step its checkout."
  exit 1
fi
echo "The prepare step ran in $image, and left the checkout at $commit with its dependencies."
