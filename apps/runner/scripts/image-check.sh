#!/usr/bin/env bash
# Runs the prepare step in a factory-runner image, as the line's prepare pod runs it, and fails unless it leaves the
# agent step what it needs. CI runs it on the amd64 image each pull request builds (check.yml's `image builds`), so an
# image whose prepare cannot run fails its pull request before it is ever pinned. On the Mac, against an image built
# there:
#
#     docker build --file apps/runner/Dockerfile --tag factory-runner:try .
#     apps/runner/scripts/image-check.sh factory-runner:try
#
# The container is the prepare pod's (apps/factory/src/runners/jobs.ts): user 65532, a read-only root, every
# capability dropped, /work, /tmp and /prepare its only writable folders, and the pod's environment. It has no network
# at all, where the pod has DNS and 443 out: the check must not depend on the internet, and whatever the image would
# fetch, such as a pnpm, fails here as it fails in a pod with a read-only home. So it does not show that the image can
# fetch over HTTPS.
#
# Its origin is a small repository made here, cloned by path as prepare's tests do: two commits, the step's base and
# its commit, and a package whose one dependency is a folder of its own, so its lockfile installs offline. The step
# reads a change, so prepare fetches the base and deepens to it, and has a dry run's commit, so prepare applies a patch
# and commits it, as the user it runs as. The package names a pnpm of the image's major but another version, as the
# app's does (this repository's is the one the image holds), so an image that tries to switch to it fails.
#
# The lockfile has no entries for that pnpm, which the app's has: pnpm 12.16 installs without them, but 12.15.0, with
# no network, refused to (ERR_PNPM_FROZEN_LOCKFILE_WITH_OUTDATED_LOCKFILE). A pnpm that refuses again fails here in the
# pull request that moves pnpm, and this fixture moves with it.
#
# It passes when prepare exits 0 and leaves on /work the checkout at the dry run's commit on the step's, the base
# named, and the dependency installed. What prepare checks and logs itself, the two pnpm versions among it, is in its
# output, printed as it runs.
set -euo pipefail

image=${1:?usage: image-check.sh <image>}
root=$(cd "$(dirname "$0")/../../.." && pwd)

# This repository's pnpm (mise.lock, held equal to package.json's by scripts/toolchain.test.ts), the one an image built
# from this checkout holds, and another of its major for the checkout to name: x.0.0, or x.0.1 when that is its own.
own=$(sed -nE 's/^ *"packageManager": "pnpm@([0-9]+\.[0-9]+\.[0-9]+).*/\1/p' "$root/package.json")
[ -n "$own" ] || { echo "package.json names no pnpm" >&2; exit 1; }
named="${own%%.*}.0.0"
[ "$named" != "$own" ] || named="${own%%.*}.0.1"

# Everything it makes is its own, and goes when it ends, however it ends.
id="runner-image-check-$$"
fixture=$(mktemp -d)
cleanup() {
  docker rm --force "$id-prepare" > /dev/null 2>&1 || true
  docker volume rm --force "$id-origin" "$id-work" > /dev/null 2>&1 || true
  rm -rf "$fixture"
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
base=$(git_ rev-parse HEAD)
echo 'export const count = 2;' > "$fixture/count.ts"
git_ commit --quiet --all --message change
commit=$(git_ rev-parse HEAD)
# Fetching a commit by its sha, as GitHub allows.
git_ config uploadpack.allowReachableSHA1InWant true
patch='diff --git a/pushed.ts b/pushed.ts\nnew file mode 100644\n--- /dev/null\n+++ b/pushed.ts\n@@ -0,0 +1 @@\n+export const pushed = true;\n'

# The origin and the job's volume, owned by the pod's user as a PVC with its fsGroup is: git refuses a repository
# another user owns. The origin goes in through a pipe, not a bind mount, which some ways of running Docker on a Mac
# would show empty.
docker volume create "$id-origin" > /dev/null
docker volume create "$id-work" > /dev/null
tar -C "$fixture" -cf - . | docker run --rm --interactive --network none --user 0:0 --entrypoint sh \
  --volume "$id-origin:/origin" --volume "$id-work:/work" \
  "$image" -c 'tar --warning=no-unknown-keyword -xf - -C /origin && chown -R 65532:65532 /origin /work && [ -d /origin/.git ]'

step=$(printf '{"agent":"reviewer","repository":"file:///origin","commit":"%s","base":"%s","commits":[{"message":"fix: pushed","patch":"%s"}],"prompt":"Check the image.","maxTurns":1}' \
  "$commit" "$base" "$patch")
echo "The prepare step, in $image, on a checkout that names pnpm $named (this repository's is $own):"
status=0
docker run --rm --name "$id-prepare" --network none --read-only --user 65532:65532 --cap-drop ALL \
  --security-opt no-new-privileges --tmpfs /tmp:exec,mode=0777 --tmpfs /prepare:exec,mode=0777 \
  --volume "$id-work:/work" --volume "$id-origin:/origin:ro" \
  --env WORK=/work --env PREPARE=/prepare --env HOME=/prepare/home --env npm_config_store_dir=/prepare/store \
  --env RUNNER_JOB=reviewer-0-1-1 --env RUNNER_WORK_ITEM=0 --env RUNNER_STEP="$step" \
  "$image" prepare || status=$?
if [ "$status" -ne 0 ]; then
  echo "::error::The prepare step failed in $image (exit $status): a runner on it could take no work."
  exit 1
fi

# What the agent step reads: the dry run's commit on the step's, the base named, and the dependency installed.
if ! docker run --rm --network none --read-only --user 65532:65532 --entrypoint sh \
  --volume "$id-work:/work:ro" "$image" -c '
    cd /work/repo || exit 1
    on=$(git rev-parse HEAD^ 2> /dev/null); [ "$on" = "$1" ] || { echo "the checkout is on ${on:-nothing}, not $1"; exit 1; }
    named=$(git rev-parse base 2> /dev/null); [ "$named" = "$2" ] || { echo "its base is ${named:-not named}, not $2"; exit 1; }
    [ -f pushed.ts ] || { echo "the dry run'\''s commit is not in it"; exit 1; }
    [ -f node_modules/dep/package.json ] || { echo "its dependencies are not installed"; exit 1; }
  ' check "$commit" "$base"; then
  echo "::error::The prepare step in $image ended, but did not leave the agent step its checkout."
  exit 1
fi
echo "The prepare step ran in $image, and left the checkout on $commit, its base named, with its dependencies."
