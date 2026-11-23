#!/usr/bin/env bash
# The scratch copies of the factory and the app, for the patching tests (../TESTS.md).
#
#   ./copies.sh build        build both baselines locally from ../baseline.env (work/factory, work/app)
#   ./copies.sh check        `make check` in both baselines, as each copy's CI will run it
#   ./copies.sh create       once: make the two repositories, push, apply the real ones' settings, keys and variables
#   ./copies.sh pin-images   once per baseline: pin each copy's deploy overlays to the images its own build made
#   ./copies.sh settings     the real ones' settings, rulesets and environments again, from the baseline built (after a baseline that moves them)
#   ./copies.sh reset        put both copies back to their baseline, with nothing left open, for the next run
#   ./copies.sh status       what each copy holds now
#   ./copies.sh store-save   once, at a clean point: the scratch store, Martin's passkey and controls in it
#   ./copies.sh store-restore  the scratch store back to that point, its migrations run, its workers restarted
#   ./copies.sh forget-closed  make the watches forget the pull requests a reset closed (reset does this itself)
#   ./copies.sh dependabot   close the copies' Dependabot pull requests the real ones closed, or no test needs
#   ./copies.sh worker 0|1   stop or start the scratch cluster's GitHub worker
#   ./copies.sh app          once: make the scratch cluster's own GitHub App (app.ts), for Martin to create and install
#   ./copies.sh up           make the scratch cluster (k3d software-factory-scratch); Argo CD deploys each copy's main
#   ./copies.sh down         delete the scratch cluster and its state
#
# The scratch cluster is the copies' alone: its own k3d name and kube context (k3d-software-factory-scratch), ports
# (9080, 9443, the API on 6551, the store's forwards on 25432 and 25433), lock, App and keys (cluster.pl). It is made by
# the factory copy's own `make up`, in work/factory, never the main checkout's, and with no private checkout.
#
# Runs as Martin's gh login (an owner of the-roganator). Never touches the real two: every write names a *_COPY.
#
# What it makes and keeps is in the state folder, never in the tracked tree: the main checkout's git-ignored
# scratch/patching-harness/, or PATCHING_HARNESS_STATE. There: work/ (the two clones, the logs, store-clean.dump),
# images.env and images.prev.env (pin-images), batch.env (a batch's PIN_WATCH_ONLY and STAGED_EXTRA, read after
# ../baseline.env), and staged/<side>/*.patch (set-ups not committed, applied in name order with ../staged/<side>/).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SKILL="$(dirname "$HERE")"
REPO="$(git -C "$HERE" rev-parse --show-toplevel)"
MAIN_CHECKOUT="$(dirname "$(git -C "$HERE" rev-parse --path-format=absolute --git-common-dir)")"
STATE="${PATCHING_HARNESS_STATE:-$MAIN_CHECKOUT/scratch/patching-harness}"
# shellcheck source=../baseline.env
source "$SKILL/baseline.env"
# shellcheck source=/dev/null
if [[ -f "$STATE/batch.env" ]]; then source "$STATE/batch.env"; fi
WORK="$STATE/work"
REVIEW_APP_KEYCHAIN=review-gate-app-key
SCRATCH_CLUSTER=software-factory-scratch
SCRATCH_CONTEXT=k3d-$SCRATCH_CLUSTER
REAL_CONTEXT=k3d-software-factory

say() { printf '\n== %s\n' "$*"; }
die() { printf 'copies.sh: %s\n' "$*" >&2; exit 1; }

for copy in "$FACTORY_COPY" "$APP_COPY"; do
  [[ "$copy" == the-roganator/*-scratch ]] || die "$copy does not look like a scratch copy; refusing."
done

# Every name of a real one, as the copy's (rename.pl).
rename() {
  local F; F=$(tr 'a-z-' 'A-Z_' <<<"${FACTORY_REAL#*/}"); local A; A=$(tr 'a-z-' 'A-Z_' <<<"${APP_REAL#*/}")
  git grep -lzI -e "${FACTORY_REAL#*/}" -e "${APP_REAL#*/}" -e "$F" -e "$A" -- . ':!pnpm-lock.yaml' |
    FACTORY=${FACTORY_REAL#*/} APP=${APP_REAL#*/} FACTORY_COPY=${FACTORY_COPY#*/} APP_COPY=${APP_COPY#*/} \
      xargs -0 perl -pi "$HERE/rename.pl"
}

# The scratch cluster's names and App, wherever the copy names the real cluster's (cluster.pl).
second_cluster() {
  [[ -f "$SKILL/app.env" ]] || die "no app.env: ./copies.sh app makes the scratch App first"
  # shellcheck source=../app.env
  source "$SKILL/app.env"
  git grep -lzI -e k3d-software-factory -e 'CLUSTER := ' -e 'name: software-factory' -e cluster.lock -e localhost:8080 \
    -e localhost:8443 -e 127.0.0.1:8 -e 6550 -e factory-github-app-key -e pushover- -e mrogan-software-factory \
    -e Iv23liE1Dj3iYkwWX59z -e 5187559 -e 337765427 -e 5_187_559 -e 337_765_427 -e 1543 -e PRIVATE_DIR -e '^options:' -- . ':!pnpm-lock.yaml' |
    SLUG=$SCRATCH_APP_SLUG APP_ID=$SCRATCH_APP_ID CLIENT_ID=$SCRATCH_APP_CLIENT_ID BOT_ID=$SCRATCH_APP_BOT_ID \
      xargs -0 perl -pi "$HERE/cluster.pl"
}

# CI's copies of third-party images stay the real factory's (ghcr.io/<factory>/mirror/, which rename.pl keeps and the
# real caches.yml's `images` job fills daily, public), where the code would name them from the running repository: a
# copy's own would be empty, as its caches.yml cannot write there, and is disabled (settings). That workflow's
# `toolchain` job goes with it, so the copy's main no longer warms the toolchain's caches: its runs save them only where
# a workflow that runs on main does (cache_save), and a pull request's check may install without one.
real_mirror() {
  local real="ghcr.io/$FACTORY_REAL/mirror/"
  REAL=$real perl -pi -e 's{^const MIRROR = `ghcr\.io/\$\{FACTORY_REPOSITORY\}/mirror/`;}{const MIRROR = \x27$ENV{REAL}\x27;};
    s{^import \{ FACTORY_REPOSITORY, repositoryOfImage \}}{import { repositoryOfImage }}' apps/factory/src/vulnerabilities/inventory.ts
  REAL=$real perl -pi -e 's{^MIRROR=ghcr\.io/\$\(tr .*\)/mirror/$}{MIRROR=$ENV{REAL}}' scripts/ci-images.sh
  grep -qxF "const MIRROR = '$real';" apps/factory/src/vulnerabilities/inventory.ts &&
    grep -qxF "MIRROR=$real" scripts/ci-images.sh || die "the factory's CI mirror is named somewhere new: real_mirror"
}

# The longer names, formatted as each repository formats its code, so its lint passes.
tidy() {
  mise trust -q . >/dev/null && mise install -q && mise exec -- pnpm install --frozen-lockfile --silent
  git diff --name-only -z -- "*.ts" "*.tsx" "*.js" "*.json" | xargs -0 mise exec -- pnpm exec biome format --write >/dev/null
  # The samples are generated from code that names the repositories.
  if [[ -f packages/samples/src/export.ts ]]; then mise exec -- node packages/samples/src/export.ts >/dev/null; fi
  # The console's visual snapshots show those samples, whose names and hashes carry the repositories' names: taken
  # again in the pinned Playwright image, as `make e2e UPDATE=1` takes them (two minutes; Docker).
  if [[ -d apps/console/e2e/snapshots ]]; then
    env -u KUBECONFIG mise exec -- make e2e UPDATE=1 >"$WORK/e2e-update.log" 2>&1 || die "the snapshots: see work/e2e-update.log"
  fi
  # The refusal records, re-hashed over the renamed policies (rehash.ts).
  if [[ -f scripts/policy-hash.ts ]]; then mise exec -- node "$HERE/rehash.ts" .; fi
  # The scan's recorded answer, whose marks hash the repository's name.
  if [[ -f apps/factory/test/github/fixtures/scanning/answer.txt ]]; then
    mise exec -- pnpm exec vitest run -u apps/factory/test/github/scanning.test.ts >/dev/null
  fi
}

clone() { # <real> <dir> <from>
  local real=$1 dir=$2 from=$3
  if [[ ! -d "$dir/.git" ]]; then
    local reference=()
    [[ "$real" == "$FACTORY_REAL" ]] && reference=(--reference-if-able "$MAIN_CHECKOUT")
    git clone -q ${reference[@]+"${reference[@]}"} "https://github.com/$real" "$dir"
  fi
  git -C "$dir" fetch -q origin
  git -C "$dir" checkout -q -f --detach "$from"
  git -C "$dir" reset -q --hard "$from"
  git -C "$dir" clean -qfdx -e node_modules
}

revert_all() { # <dir> <commits…>
  local dir=$1; shift
  for c in "$@"; do git -C "$dir" revert --no-edit "$c" >/dev/null || die "revert of $c in $dir does not apply"; done
}

# What no real merge can put back (a test's starting point staged by hand): staged/<side>/*.patch, in name order, each
# a commit of its own, after the reverts and before the rename, so a patch names the real repositories as `git diff`
# on the real one's main would. Its first line, a `# ` comment, is the commit's subject; `git apply` skips it.
# The committed ones (../staged/<side>/) and the state folder's (a set-up being tried, or a local diagnostic) are one
# list in name order; a name in both is refused.
apply_staged() { # <side> <dir>
  local side=$1 dir=$2 p
  local patches=()
  while IFS=$'\t' read -r _ p; do patches+=("$p"); done < <(
    for p in "$SKILL/staged/$side"/*.patch "$STATE/staged/$side"/*.patch; do
      if [[ -e "$p" ]]; then printf '%s\t%s\n' "$(basename "$p")" "$p"; fi
    done | LC_ALL=C sort)
  local twice; twice=$(for p in ${patches[@]+"${patches[@]}"}; do basename "$p"; done | sort | uniq -d)
  [[ -z $twice ]] || die "staged in both ../staged/$side/ and $STATE/staged/$side/: $twice"
  # A test's own set-up, for a baseline of its own (STAGED_EXTRA in batch.env: ../staged/<side>-<extra>/), after the rest.
  [[ -n ${STAGED_EXTRA:-} && -d "$SKILL/staged/$side-$STAGED_EXTRA" ]] && patches+=("$SKILL/staged/$side-$STAGED_EXTRA"/*.patch)
  for p in ${patches[@]+"${patches[@]}"}; do
    [[ -e "$p" ]] || continue
    git -C "$dir" apply --index "$p" || die "$p does not apply"
    git -C "$dir" -c commit.gpgsign=false commit -q \
      -m "chore(scratch): staged, $(basename "$p" .patch)" -m "$(sed -n '1s/^# //p' "$p")"
  done
}

commit() { # <dir> <message>
  git -C "$1" add -A
  git -C "$1" -c commit.gpgsign=false commit -q -m "$2" -m "Scratch copy for the patching tests: not the real repository." \
    || die "nothing to commit in $1"
}

# A small run: the scratch pin watch takes only the moves batch.env names (PIN_WATCH_ONLY, the worker's own setting,
# comma-separated names as moves.json gives them; unset or `*`, every move), so a reset opens a few pull requests and
# not twenty. `node harness.ts only <tests>` prints the line for a set of tests. The value is no part of the baseline:
# the copy's worker reads it from the ConfigMap `scratch-pin-watch` on the scratch cluster, which no commit holds and
# Argo CD does not track, so one baseline serves every batch. `build` points the copy's manifest at it
# (pin_watch_from_cluster), and `worker 1` writes it from batch.env before the worker starts (pin_watch). Without the
# ConfigMap the variable is unset, and the worker takes no move.
pin_watch_from_cluster() { # <dir>
  local file="$1/deploy/base/factory/github.yaml"
  perl -0pi -e 's{^( +)- name: PIN_WATCH_ONLY\n +value: "\*"\n}{$1- name: PIN_WATCH_ONLY\n$1  valueFrom:\n$1    configMapKeyRef:\n$1      name: scratch-pin-watch\n$1      key: only\n$1      optional: true\n}m' "$file"
  grep -qx ' *name: scratch-pin-watch' "$file" || die "PIN_WATCH_ONLY in $file is not read from scratch-pin-watch"
}

pin_watch() {
  local only=${PIN_WATCH_ONLY:-*}
  kubectl --context "$SCRATCH_CONTEXT" -n factory create configmap scratch-pin-watch --from-literal=only="$only" \
    --dry-run=client -o yaml | kubectl --context "$SCRATCH_CONTEXT" apply -f - >/dev/null
  echo "  the scratch pin watch takes: $only"
}

build() {
  mkdir -p "$WORK"
  say "factory baseline from $FACTORY_FROM"
  clone "$FACTORY_REAL" "$WORK/factory" "$FACTORY_FROM"
  revert_all "$WORK/factory" $FACTORY_REVERTS
  apply_staged factory "$WORK/factory"
  (cd "$WORK/factory" && rename && real_mirror && second_cluster && tidy)
  pin_watch_from_cluster "$WORK/factory"
  # The last pins, so main never names an image the copy has not built; pin-images moves them to this baseline's own.
  [[ -f "$STATE/images.env" ]] && pin_overlays factory
  commit "$WORK/factory" "chore(scratch): $FACTORY_COPY, the baseline"
  local factory_sha; factory_sha=$(git -C "$WORK/factory" rev-parse HEAD)

  say "app baseline from $APP_FROM"
  clone "$APP_REAL" "$WORK/app" "$APP_FROM"
  revert_all "$WORK/app" $APP_REVERTS
  apply_staged app "$WORK/app"
  (cd "$WORK/app" && rename && second_cluster && tidy)
  # The app calls the factory copy's workflows at the factory baseline, whose code names the copies.
  perl -pi -e "s{(uses: the-roganator/${FACTORY_COPY#*/}/\\.github/workflows/[^@]+)\@[0-9a-f]{40}}{\$1\@$factory_sha}" \
    "$WORK/app"/.github/workflows/*.yml
  [[ -f "$STATE/images.env" ]] && pin_overlays app
  commit "$WORK/app" "chore(scratch): $APP_COPY, the baseline"

  git -C "$WORK/factory" rev-parse HEAD >"$WORK/factory.sha"
  git -C "$WORK/app" rev-parse HEAD >"$WORK/app.sha"
  say "built: factory $(cat "$WORK/factory.sha"), app $(cat "$WORK/app.sha")"
}

check() {
  for side in factory app; do
    say "make check in $side"
    (cd "$WORK/$side" && mise trust -q . && mise install -q && mise exec -- pnpm install --frozen-lockfile --silent \
      && mise exec -- make check) || die "make check fails in the $side baseline"
  done
}

# Overlays name the copy's images by digest (images.env, from pin-images).
pin_overlays() {
  # shellcheck source=/dev/null
  source "$STATE/images.env"
  local dir="$WORK/$1"
  if [[ $1 == factory ]]; then
    for name in factory factory-browser factory-runner console; do
      local var="DIGEST_${name//-/_}"; local digest=${!var}
      local file="$dir/deploy/overlays/local/factory-image/kustomization.yaml"
      [[ $name == console ]] && file="$dir/deploy/overlays/local/console-image/kustomization.yaml"
      NAME=$name DIGEST=$digest perl -0pi -e \
        's{(- digest: )sha256:[0-9a-f]{64}(\n  name: \Q$ENV{NAME}\E\n)}{$1$ENV{DIGEST}$2}' "$file"
    done
  else
    DIGEST=$DIGEST_website perl -0pi -e 's{(digest: )sha256:[0-9a-f]{64}}{$1$ENV{DIGEST}}' \
      "$dir/deploy/overlays/local/image/kustomization.yaml"
  fi
}

# Admission's refusal record (scripts/admission-refusals.sh) names seven images by digest: three signed builds, the
# amd64 manifests inside the factory's and the app's (unsigned), and the arm64 manifests inside the factory's and its
# browser's, signed by another identity (other-identity.yml, on the branch refusal/other-identity). The rename leaves the
# real ones' digests under the copies' names, which do not exist; the platform check stops on the first. So the copy's
# own: from the builds pin-images just made, the arm64 two signed as another identity from that branch in the factory
# copy (kept after, as the real one keeps it), and each digest written where the real one's was. Run in work/factory.
refusal_images() {
  local idx_f="ghcr.io/$FACTORY_COPY/factory@$DIGEST_factory" idx_b="ghcr.io/$FACTORY_COPY/factory-browser@$DIGEST_factory_browser"
  local idx_w="ghcr.io/$APP_COPY@$DIGEST_website"
  child() { # index arch: the digest of its linux/<arch> manifest
    docker buildx imagetools inspect --raw "$1" |
      jq -er --arg a "$2" '[.manifests[] | select(.platform.os == "linux" and .platform.architecture == $a)][0].digest'
  }
  # bash 3.2 (macOS) has no associative arrays: one variable each, new_<name>.
  local NAMES="factory website browser factory_unsigned website_unsigned factory_other browser_other"
  # The three signed builds are the previous pin-images' (images.prev.env): signed by build.yml on main too, and no
  # longer pinned, as scripts/deploy-files.test.ts requires of every digest another file names.
  # shellcheck source=/dev/null
  [[ -f "$STATE/images.prev.env" ]] || die "no images.prev.env: the record needs an earlier build than the one pinned"
  local new_factory new_website new_browser
  new_factory=$(sed -n 's/^DIGEST_factory=//p' "$STATE/images.prev.env")
  new_website=$(sed -n 's/^DIGEST_website=//p' "$STATE/images.prev.env")
  new_browser=$(sed -n 's/^DIGEST_factory_browser=//p' "$STATE/images.prev.env")
  [[ $new_factory != "$DIGEST_factory" && $new_browser != "$DIGEST_factory_browser" ]] ||
    die "images.prev.env pins what images.env pins"
  local new_factory_unsigned new_website_unsigned new_factory_other new_browser_other
  new_factory_unsigned=$(child "$idx_f" amd64) && new_website_unsigned=$(child "$idx_w" amd64) &&
    new_factory_other=$(child "$idx_f" arm64) && new_browser_other=$(child "$idx_b" arm64) || die "the builds' manifests"
  local name old
  local v
  for name in $NAMES; do v="new_$name"; [[ ${!v} == sha256:* ]] || die "no $name digest from the copy's builds"; done
  # Signed as another identity: a branch of the factory copy that adds the real one's workflow, naming the copy's two.
  local sign; sign=$(mktemp -d)
  git -C . worktree add -q --detach "$sign" HEAD
  mkdir -p "$sign/.github/workflows"
  git -C . show c13743cac853b7038b97a4717ffb62a04cc8c219:.github/workflows/other-identity.yml 2>/dev/null >"$sign/.github/workflows/other-identity.yml" ||
    git -C "$MAIN_CHECKOUT" show c13743cac853b7038b97a4717ffb62a04cc8c219:.github/workflows/other-identity.yml >"$sign/.github/workflows/other-identity.yml"
  FO="ghcr.io/$FACTORY_COPY/factory@${new_factory_other}" BO="ghcr.io/$FACTORY_COPY/factory-browser@${new_browser_other}" \
    perl -pi -e 's{^(\s+)ghcr\.io/\S+/factory\@sha256:[0-9a-f]{64}}{$1$ENV{FO}}; s{^(\s+)ghcr\.io/\S+/factory-browser\@sha256:[0-9a-f]{64}}{$1$ENV{BO}}' \
    "$sign/.github/workflows/other-identity.yml"
  grep -qF "${new_factory_other}" "$sign/.github/workflows/other-identity.yml" || die "other-identity.yml was not rewritten"
  git -C "$sign" add .github/workflows/other-identity.yml
  git -C "$sign" -c commit.gpgsign=false commit -q -m "ci(refusal): sign two of the copy's images as another identity" \
    -m "Scratch copy for the patching tests: admission's other-identity refusal."
  git -C "$sign" push -q --force "https://github.com/$FACTORY_COPY" HEAD:refs/heads/refusal/other-identity
  local head; head=$(git -C "$sign" rev-parse HEAD)
  git -C . worktree remove --force "$sign"
  local run=
  for _ in $(seq 1 30); do
    run=$(gh run list -R "$FACTORY_COPY" -w other-identity.yml -L 5 --json databaseId,headSha \
      --jq ".[] | select(.headSha == \"$head\") | .databaseId" | head -1)
    [[ -n $run ]] && break; sleep 10
  done
  [[ -n $run ]] || die "other-identity.yml did not start on refusal/other-identity"
  run_ok "$run" "$FACTORY_COPY" || die "other-identity.yml failed (run $run)"
  # Each real digest, read from the script, replaced wherever it is named.
  for name in $NAMES; do
    v="new_$name"
    old=$(sed -nE "s/^$name=[^@]+@(sha256:[0-9a-f]{64})\$/\\1/p" scripts/admission-refusals.sh)
    [[ -n $old ]] || die "scripts/admission-refusals.sh names no $name"
    [[ $old == "${!v}" ]] && continue
    git grep -lzF "$old" | OLD=$old NEW=${!v} xargs -0 perl -pi -e 's{\Q$ENV{OLD}\E}{$ENV{NEW}}g'
  done
  mise exec -- node "$HERE/rehash.ts" .
  mise exec -- pnpm exec biome format --write policy/attacks.ts >/dev/null
}

# Whether a run, once it completes, succeeded: polled, as `gh run watch` can give up on one still running.
run_ok() { # <run> <repository>
  local state
  for _ in $(seq 1 240); do
    state=$(gh run view "$1" -R "$2" --json status,conclusion --jq '"\(.status) \(.conclusion)"' 2>/dev/null) || state=
    case $state in completed\ success) return 0 ;; completed\ *) return 1 ;; esac
    sleep 15
  done
  return 1
}

# Every branch ruleset on the copy (github-settings.ts makes one, "main"): off for a force-push to main, on again after.
ruleset() { # <copy> active|disabled
  local id
  for id in $(gh api "repos/$1/rulesets" --jq '.[] | select(.target == "branch") | .id'); do
    gh api -X PUT "repos/$1/rulesets/$id" -f enforcement="$2" >/dev/null
  done
}

push_baseline() { # <copy> <dir>
  local copy=$1 dir=$2
  ruleset "$copy" disabled
  git -C "$dir" push -q --force "https://github.com/$copy" HEAD:refs/heads/baseline HEAD:refs/heads/main
  ruleset "$copy" active
}

settings() {
  # The real two's settings, rulesets and environments (scripts/github-settings.ts), from the factory baseline, whose
  # code names the copies.
  # Its first pass makes the environments and stops at the ruleset, which waits for the review App's key; the second,
  # with the keys in place, applies the ruleset.
  (cd "$WORK/factory" && mise exec -- node scripts/github-settings.ts) || true
  for copy in "$FACTORY_COPY" "$APP_COPY"; do
    gh repo edit "$copy" --description "Scratch copy for the patching tests. Reset often; nothing here is real." >/dev/null
    gh variable set FACTORY_REPOSITORY -R "$copy" -b "$FACTORY_COPY"
    gh variable set APP_REPOSITORY -R "$copy" -b "$APP_COPY"
    # The real ones' labels: the line, the worker and the gate read them.
    local real=$FACTORY_REAL; [[ $copy == "$APP_COPY" ]] && real=$APP_REAL
    gh label clone "$real" -R "$copy" --force >/dev/null
    for env in review scan-state; do gh api -X PUT "repos/$copy/environments/$env" >/dev/null; done
    security find-generic-password -s "$REVIEW_APP_KEYCHAIN" -w | base64 -d |
      gh secret set REVIEW_APP_PRIVATE_KEY --env review -R "$copy"
  done
  scan_state_keys
  (cd "$WORK/factory" && mise exec -- node scripts/github-settings.ts)
  # The drift check is the real cluster's, and its App is not installed on the copy.
  gh workflow disable drift-check.yml -R "$FACTORY_COPY" 2>/dev/null || true
  # CI's image copies are the real factory's (real_mirror), which a copy cannot write. caches.yml holds both the image
  # copies (`images`) and the toolchain cache's saves on main (`toolchain`); both stop.
  gh workflow disable caches.yml -R "$FACTORY_COPY" 2>/dev/null || true
}

# Each copy's scan seals its state with a key of its own, which the scratch cluster's GitHub worker holds: the factory
# copy's `make scan-state-key` makes each there, once, and gives each copy's scan-state environment the same key.
# Nothing of the real cluster's is read or written. With no scratch cluster yet, `up` gives the keys.
scan_state_keys() {
  if ! kubectl config get-contexts -o name | grep -qx "$SCRATCH_CONTEXT"; then
    echo "  no scratch cluster yet: ./copies.sh up gives each copy its scan-state key"
    return
  fi
  in_copy make scan-state-key
}

# Run a command in the factory copy, as the scratch cluster: refused unless the copy's code names the scratch cluster
# and nowhere the real one's context, so the real one's names never reach a command. The environment keeps nothing
# that would name the real App's key, Pushover, a private checkout or other repositories.
in_copy() {
  local dir="$WORK/factory"
  grep -qx "CLUSTER := $SCRATCH_CLUSTER" "$dir/Makefile" || die "work/factory's Makefile does not name $SCRATCH_CLUSTER: build again"
  grep -qx "  name: $SCRATCH_CLUSTER" "$dir/deploy/k3d/cluster.yaml" || die "work/factory's cluster.yaml does not name $SCRATCH_CLUSTER"
  if grep -rqE -- "$REAL_CONTEXT([^-]|$)" "$dir/Makefile" "$dir/scripts" "$dir/.claude"; then
    die "work/factory still names $REAL_CONTEXT"
  fi
  (cd "$dir" && env -u GITHUB_APP_PRIVATE_KEY -u PUSHOVER_APP_TOKEN -u PUSHOVER_USER_KEY -u PRIVATE_DIR -u KUBECONFIG \
    -u FACTORY_REPOSITORY -u APP_REPOSITORY mise exec -- "$@")
}

# The scratch cluster, made by the factory copy's own `make up` at its baseline: Argo CD then deploys each copy's main.
up() {
  [[ -f "$WORK/factory.sha" ]] || die "build first"
  git -C "$WORK/factory" checkout -q --detach "$(cat "$WORK/factory.sha")"
  [[ -z "$(git -C "$WORK/factory" status --porcelain --untracked-files=no)" ]] || die "work/factory has changes: build again"
  security find-generic-password -s scratch-factory-github-app-key >/dev/null 2>&1 ||
    die "no scratch-factory-github-app-key in the Keychain: ./copies.sh app"
  in_copy pnpm install --frozen-lockfile --silent
  in_copy make up
  scan_state_keys
}

down() { in_copy make down; }

create() {
  [[ -f "$WORK/factory.sha" && -f "$WORK/app.sha" ]] || die "build first"
  for copy in "$FACTORY_COPY" "$APP_COPY"; do
    gh repo view "$copy" >/dev/null 2>&1 || gh repo create "$copy" --public --disable-wiki \
      --description "Scratch copy for the patching tests. Reset often; nothing here is real." >/dev/null
  done
  say "pushing the baselines"
  git -C "$WORK/factory" push -q "https://github.com/$FACTORY_COPY" "$(cat "$WORK/factory.sha"):refs/heads/main" 2>/dev/null \
    || push_baseline "$FACTORY_COPY" "$WORK/factory"
  git -C "$WORK/factory" push -q --force "https://github.com/$FACTORY_COPY" HEAD:refs/heads/baseline
  git -C "$WORK/app" push -q "https://github.com/$APP_COPY" "$(cat "$WORK/app.sha"):refs/heads/main" 2>/dev/null \
    || push_baseline "$APP_COPY" "$WORK/app"
  git -C "$WORK/app" push -q --force "https://github.com/$APP_COPY" HEAD:refs/heads/baseline
  say "settings"
  settings
}

# Each copy's build, on its main, makes its own images, signed by its own build.yml; the overlays then name them.
pin_images() {
  local f a
  f=$(git ls-remote "https://github.com/$FACTORY_COPY" refs/heads/main | cut -f1)
  a=$(git ls-remote "https://github.com/$APP_COPY" refs/heads/main | cut -f1)
  [[ $f == "$(cat "$WORK/factory.sha")" && $a == "$(cat "$WORK/app.sha")" ]] ||
    die "the copies' main is not the baseline in work/: build, then reset, then pin-images"
  worker 0
  for pair in "$FACTORY_COPY:$f" "$APP_COPY:$a"; do
    local copy=${pair%%:*} sha=${pair#*:}
    say "build.yml on $copy at $sha"
    local since run=; since=$(date -u +%FT%TZ)
    gh workflow run build.yml -R "$copy" --ref main
    # The run this dispatch started: by its event and its time, not merely the newest.
    for _ in $(seq 1 30); do
      run=$(gh run list -R "$copy" -w build.yml -e workflow_dispatch -L 5 --json databaseId,createdAt,headSha \
        --jq "[.[] | select(.createdAt >= \"$since\" and .headSha == \"$sha\")][0].databaseId // empty")
      [[ -n $run ]] && break; sleep 10
    done
    [[ -n $run ]] || die "build.yml did not start in $copy"
    run_ok "$run" "$copy" || die "build.yml failed in $copy (run $run)"
  done
  digest() { docker buildx imagetools inspect "$1" --format '{{json .Manifest}}' | jq -r .digest; }
  # The last ones stay, for the refusal record's signed builds (refusal_images).
  [[ -f "$STATE/images.env" ]] && cp "$STATE/images.env" "$STATE/images.prev.env"
  {
    echo "# The images each copy's own build made from its baseline (pin-images, $(date -u +%FT%TZ))."
    for name in factory factory-browser factory-runner console; do
      echo "DIGEST_${name//-/_}=$(digest "ghcr.io/$FACTORY_COPY/$name:$f")"
    done
    echo "DIGEST_website=$(digest "ghcr.io/$APP_COPY:$a")"
  } >"$STATE/images.env"
  cat "$STATE/images.env"
  # The pins go in a commit on top of the one the images were built from, never in a baseline built again: the review
  # gate passes a deploy as an exact pin only when the new image's commit descends from the one the pin replaces.
  local side
  for side in factory app; do
    local built=$f; [[ $side == app ]] && built=$a
    git -C "$WORK/$side" checkout -q -f --detach "$built"
    pin_overlays "$side"
    if [[ $side == factory ]]; then (cd "$WORK/factory" && refusal_images) || die "the refusal record's images failed"; fi
    commit "$WORK/$side" "chore(scratch): pin the images this copy's build made from its baseline"
    git -C "$WORK/$side" rev-parse HEAD >"$WORK/$side.sha"
  done
  push_baseline "$FACTORY_COPY" "$WORK/factory"
  push_baseline "$APP_COPY" "$WORK/app"
  worker 1
  say "pinned: factory $(cat "$WORK/factory.sha"), app $(cat "$WORK/app.sha")"
}

# Dependabot remembers each pull request closed unmerged and skips that version for good; the real repositories have
# closed many, the copies none. So a copy's Dependabot pull request is closed when the real repository closed the same
# one, by title in any case, unmerged: the copy's Dependabot then skips what the real one skips.
# Every other open Dependabot pull request on a copy is closed too, but those the tests need (DEPENDABOT_KEEP_*, a
# regex over the lowercased title, in baseline.env): each runs the copy's CI on the organisation's shared runners at
# every reset, and closing one makes only the copy's Dependabot skip that version.
dependabot_only_needed() { # <copy>
  local copy=$1 keep=$DEPENDABOT_KEEP_FACTORY
  [[ $copy == "$APP_COPY" ]] && keep=$DEPENDABOT_KEEP_APP
  gh pr list -R "$copy" --author app/dependabot --state open --limit 200 --json number,title \
    --jq '.[] | "\(.number)\t\(.title | ascii_downcase)"' |
    while IFS=$'\t' read -r n title; do
      if ! grep -qE -- "$keep" <<<"$title"; then
        gh pr close "$n" -R "$copy" -c "Closed for the patching tests: the copy keeps only the Dependabot pull requests they need." >/dev/null
        echo "  closed Dependabot's #$n ($title): no test needs it"
      else
        # Made again on the baseline just pushed, so its checks are the baseline's, not a run from before the reset.
        gh pr comment "$n" -R "$copy" -b "@dependabot recreate" >/dev/null
        echo "  asked Dependabot to recreate #$n ($title) on the baseline"
      fi
    done
}

# The App's pull requests a reset closed, changed so the watches forget them: the pin watch opens no pull request for a
# file's moves while a closed, unmerged one of the App's on that branch carries the same edits' mark in its description
# and the App did not close it (closedByMartin in apps/factory/src/github/pins.ts),
# and a reset closes them as Martin's login. So the title becomes `chore(reset): <its subject>`, which the deploy watch's title (`chore(deploy): …`) no longer matches and the title check still passes, and the mark loses its hash. A pull request
# cannot be deleted.
forget_closed() { # <copy>
  local copy=$1
  # shellcheck source=/dev/null
  source "$SKILL/app.env"
  gh pr list -R "$copy" --author "app/$SCRATCH_APP_SLUG" --state closed --limit 500 --json number,title,mergedAt,body \
    --jq '.[] | select(.mergedAt == null) | select((((.title | startswith("chore(reset): ")) or (.title | startswith("[reset] "))) | not) or (.body | test("<!-- factory: pin-edits [0-9a-f]{64} -->"))) | "\(.number)\t\(.title)"' |
    while IFS=$'\t' read -r n title; do
      gh pr view "$n" -R "$copy" --json body --jq .body | sed -E 's/<!-- factory: pin-edits [0-9a-f]{64} -->/<!-- factory: pin-edits reset -->/' |
        gh pr edit "$n" -R "$copy" --title "chore(reset): $(printf %s "${title#\[reset\] }" | sed -E "s/^[a-z]+(\\([a-z0-9-]+\\))?!?: //")" --body-file - >/dev/null && echo "  retitled #$n, closed by a reset"
    done
}

dependabot_like_real() { # <copy> <real>
  local copy=$1 real=$2 closed
  closed=$(gh pr list -R "$real" --author app/dependabot --state closed --limit 500 --json title,mergedAt \
    --jq '.[] | select(.mergedAt == null) | .title | ascii_downcase')
  gh pr list -R "$copy" --author app/dependabot --state open --limit 200 --json number,title \
    --jq '.[] | "\(.number)\t\(.title | ascii_downcase)"' |
    while IFS=$'\t' read -r n title; do
      if grep -qxF "$title" <<<"$closed"; then
        gh pr close "$n" -R "$copy" -c "Closed as $real closed it: the copy's Dependabot skips what the real one skips." >/dev/null
        echo "  closed Dependabot's #$n ($title), as $real did"
      fi
    done
}

reset_one() { # <copy> <dir>
  local copy=$1 dir=$2
  say "reset $copy"
  # Pull requests: everything but Dependabot's is closed and its branch deleted. Closing Dependabot's would tell it to
  # skip that version for good; left open, it rebases them on the baseline itself.
  gh pr list -R "$copy" --state open --limit 200 --json number,author,headRefName \
    --jq '.[] | select(.author.login != "app/dependabot") | "\(.number) \(.headRefName)"' |
    while read -r n branch; do gh pr close "$n" -R "$copy" --delete-branch >/dev/null || true; done
  # Every other branch but main, baseline and Dependabot's.
  gh api --paginate "repos/$copy/branches" --jq '.[].name' |
    { grep -vxE 'main|baseline|dependabot/.*' || true; } | while read -r b; do
      gh api -X DELETE "repos/$copy/git/refs/heads/$b" >/dev/null || true
    done
  # Issues (the worker's), deleted, so the next run's numbers and texts are its own.
  gh issue list -R "$copy" --state all --limit 500 --json id --jq '.[].id' | while read -r id; do
    gh api graphql -f query='mutation($id:ID!){deleteIssue(input:{issueId:$id}){clientMutationId}}' -f id="$id" >/dev/null
  done
  # Releases and every tag, which release-please makes from merges after the baseline.
  gh release list -R "$copy" --limit 200 --json tagName --jq '.[].tagName' | while read -r t; do
    gh release delete "$t" -R "$copy" --yes --cleanup-tag >/dev/null || true
  done
  gh api --paginate "repos/$copy/tags" --jq '.[].name' | while read -r t; do
    gh api -X DELETE "repos/$copy/git/refs/tags/$t" >/dev/null || true
  done
  # The scan's sealed state (the artifact `state`), so the next scan starts its clocks afresh.
  gh api --paginate "repos/$copy/actions/artifacts?name=state" --jq '.artifacts[].id' | while read -r id; do
    gh api -X DELETE "repos/$copy/actions/artifacts/$id" >/dev/null || true
  done
  # Code scanning: every analysis, and so every alert, so the next scan finds its findings anew.
  local next
  while next=$(gh api "repos/$copy/code-scanning/analyses?per_page=100" --jq '[.[] | select(.deletable)][0].id' 2>/dev/null) \
    && [[ -n "$next" && "$next" != null ]]; do
    gh api -X DELETE "repos/$copy/code-scanning/analyses/$next?confirm_delete=true" >/dev/null || break
  done
  # main, back to the baseline.
  local was; was=$(git ls-remote "https://github.com/$copy" refs/heads/main | cut -f1)
  push_baseline "$copy" "$dir"
  # A main already at the baseline gets no push, so no CodeQL push run makes the analysis just deleted again, and the
  # scan stops at code scanning's 404. Its last push run on the baseline is run again instead.
  local sha; sha=$(git -C "$dir" rev-parse HEAD)
  if [[ $was == "$sha" ]]; then
    local codeql
    codeql=$(gh run list -R "$copy" -w codeql.yml -e push -c "$sha" -L 1 --json databaseId --jq '.[0].databaseId // empty')
    if [[ -n $codeql ]] && gh run rerun "$codeql" -R "$copy" >/dev/null 2>&1; then
      echo "  main was already the baseline: CodeQL's push run $codeql on it runs again, for an analysis of main"
    else
      echo "  main was already the baseline, and CodeQL has no push run on it to run again: no analysis of main until one" >&2
    fi
  fi
  local real=$FACTORY_REAL; [[ $copy == "$APP_COPY" ]] && real=$APP_REAL
  dependabot_like_real "$copy" "$real"
  dependabot_only_needed "$copy"
  forget_closed "$copy"
}

# reset [factory|app] [--store]: both copies unless one is named; --store also puts the scratch store back to its clean
# point (store-restore).
reset() {
  local sides=() store=
  for a in "$@"; do
    case $a in
      factory | app) sides+=("$a") ;;
      --store) store=1 ;;
      *) die "reset takes factory, app and --store, not $a" ;;
    esac
  done
  [[ ${#sides[@]} -gt 0 ]] || sides=(factory app)
  [[ -z $store || -f "$STORE_DUMP" ]] || die "no clean store saved: ./copies.sh store-save first"
  [[ -f "$WORK/factory.sha" && -f "$WORK/app.sha" ]] || build
  # The scratch cluster's GitHub worker stops while the copies are reset, so it opens nothing on one half reset, and
  # starts again on the baseline.
  worker 0
  local side
  for side in "${sides[@]}"; do
    git -C "$WORK/$side" checkout -q --detach "$(cat "$WORK/$side.sha")"
    local copy=$FACTORY_COPY; [[ $side == app ]] && copy=$APP_COPY
    reset_one "$copy" "$WORK/$side"
  done
  # KEEP_WORKER_DOWN=1 leaves the worker stopped (confirm.sh's batch D, which starts it once main is on a commit the
  # merge queue ran: `./copies.sh worker 1`), or it opens the deploy pull request on the pushed baseline at once.
  [[ -n ${KEEP_WORKER_DOWN:-} ]] || worker 1
  [[ -z $store ]] || store_restore
  say "reset done (${sides[*]}${store:+, and the store}): factory $(cat "$WORK/factory.sha"), app $(cat "$WORK/app.sha")"
}

# The scratch store at a clean point, Martin's passkey and controls in it (../SKILL.md), so a reset can
# start the line from nothing without him. A dump of the schema `public` as its owner, kept beside the clones,
# readable by Martin alone: it holds his passkey's public key and his sessions.
STORE_DUMP="$WORK/store-clean.dump"

psql_scratch() { kubectl --context "$SCRATCH_CONTEXT" -n factory exec -i statefulset/postgres -- "$@"; }

store_save() {
  kubectl config get-contexts -o name | grep -qx "$SCRATCH_CONTEXT" || die "no scratch cluster"
  local open
  open=$(psql_scratch psql -U factory -d factory -At -c \
    "select count(distinct work_item) from events where type = 'work-item.opened' and work_item not in
       (select work_item from events where type = 'work-item.closed')")
  [[ $open == 0 ]] || echo "  note: the store holds $open work items opened and not closed; the snapshot keeps them"
  (umask 077 && psql_scratch pg_dump -U factory -d factory -n public -Fc >"$STORE_DUMP.new") &&
    mv "$STORE_DUMP.new" "$STORE_DUMP" || die "pg_dump failed"
  say "saved the scratch store's clean point: $STORE_DUMP ($(du -h "$STORE_DUMP" | cut -f1))"
}

# Every Deployment in `factory` that reads the store stops (root's automated sync off meanwhile), the schema is dropped
# and the dump restored as its owner (the roles and their passwords are the cluster's, not the schema's, and stay), the
# artifacts are emptied as `make real-store` empties them, and each starts again with nothing cached.
store_restore() {
  [[ -f "$STORE_DUMP" ]] || die "no clean store saved: ./copies.sh store-save first"
  local k="kubectl --context $SCRATCH_CONTEXT"
  $k config get-contexts -o name >/dev/null
  $k -n argocd patch application root --type json -p '[{"op":"remove","path":"/spec/syncPolicy/automated"}]' >/dev/null 2>&1 || true
  local deploys; deploys=$($k -n factory get deploy -o name)
  # shellcheck disable=SC2086
  $k -n factory scale $deploys --replicas=0 >/dev/null
  $k -n factory wait pod -l 'app.kubernetes.io/name,app.kubernetes.io/name notin (postgres)' --for=delete --timeout=3m >/dev/null 2>&1 || true
  # The runs a restored store forgets: their step Jobs and their work volumes in `runners`, whose quota (six) would
  # otherwise stop the next Build step ("exceeded quota: runners").
  $k -n runners delete jobs --all --wait=false >/dev/null 2>&1 || true
  $k -n runners delete pvc --all >/dev/null || echo "  could not delete the work volumes in runners" >&2
  # The dump makes the schema itself. It goes into the pod as a file: pg_restore reading it through `kubectl exec`'s
  # stdin never started.
  $k -n factory cp "$STORE_DUMP" postgres-0:/tmp/store.dump -c postgres || die "could not copy the dump to postgres-0"
  psql_scratch psql -U factory -d factory -v ON_ERROR_STOP=1 -q -c 'drop schema if exists public cascade' ||
    die "could not drop the store's schema"
  # Postgres 18.7 stamps each column with an option, pg_attver, that 18.6 refuses, and a reset puts the factory copy's
  # Postgres back to 18.6: the dump is restored as SQL without those lines, which either version takes.
  $k -n factory exec postgres-0 -c postgres -- sh -c \
    "set -o pipefail; pg_restore -f - /tmp/store.dump | grep -v 'SET (pg_attver=' | psql -U factory -d factory -v ON_ERROR_STOP=1 -q >/dev/null" ||
    die "the restore failed: the store has no schema; ./copies.sh store-restore again"
  $k -n factory exec postgres-0 -c postgres -- rm -f /tmp/store.dump
  # The dump predates the baseline's newest migrations, and the migrate Job is a hook of root's sync, which a restore
  # does not start: a copy of the Job, without the hook's marks, brings the store to the baseline's schema before any
  # worker reads it. Without it the GitHub worker cannot read the level (0054) and queues nothing. The copy is made from
  # the baseline's own render, not the live Job, which Argo CD deletes before each sync's and may not be there.
  $k -n factory delete job migrate-after-restore --ignore-not-found >/dev/null
  (cd "$WORK/factory" && kubectl kustomize deploy/overlays/local | node --input-type=module -e '
      import { parseAllDocuments, stringify } from "yaml";
      let text = ""; for await (const chunk of process.stdin) text += chunk;
      const jobs = parseAllDocuments(text).map((d) => d.toJS()).filter((d) => d?.kind === "Job" && d.metadata.name === "migrate");
      if (jobs.length !== 1) { console.error(`${jobs.length} migrate Jobs in the render`); process.exit(1); }
      const [job] = jobs;
      job.metadata = { name: "migrate-after-restore", namespace: job.metadata.namespace, labels: job.metadata.labels };
      process.stdout.write(stringify(job));') | $k apply -f - >/dev/null || die "could not make the migrate Job from the baseline's render"
  $k -n factory wait job/migrate-after-restore --for=condition=Complete --timeout=3m >/dev/null ||
    die "the migrations did not run after the restore: kubectl -n factory logs job/migrate-after-restore"
  $k -n factory logs job/migrate-after-restore | grep -E 'Applied|migration' | sed 's/^/  /' || true
  $k -n factory delete job migrate-after-restore >/dev/null
  psql_scratch psql -U factory -d factory -q -c "select pg_notify('events', '0')" >/dev/null
  (cd "$WORK/factory" && sed "s|image: postgres\$|image: $($k -n factory get statefulset postgres -o jsonpath='{.spec.template.spec.containers[0].image}')|" \
    deploy/k3d/artifacts-copier.yaml) | $k apply -f - >/dev/null
  $k -n factory wait pod/artifacts-copier --for=condition=Ready --timeout=2m >/dev/null
  $k -n factory exec artifacts-copier -- find /var/lib/factory/artifacts -mindepth 1 -delete
  $k -n factory delete pod artifacts-copier --wait=false >/dev/null
  # shellcheck disable=SC2086
  $k -n factory scale $deploys --replicas=1 >/dev/null
  $k -n argocd patch application root --type merge -p '{"spec":{"syncPolicy":{"automated":{"prune":true,"selfHeal":true}}}}' >/dev/null
  for d in $deploys; do $k -n factory rollout status "$d" --timeout=5m >/dev/null || echo "  not ready: $d"; done
  say "the scratch store is back at its clean point ($STORE_DUMP)"
}

# The scratch cluster's GitHub worker, at <replicas>, if there is a scratch cluster (never the real one's). It starts
# reading the pin watch's moves as batch.env has them now (pin_watch).
# Argo CD self-heals root, so root's automated sync is off while the worker is stopped, and back as main sets it after.
worker() {
  kubectl config get-contexts -o name | grep -qx "$SCRATCH_CONTEXT" || return 0
  local k="kubectl --context $SCRATCH_CONTEXT"
  if [[ $1 == 0 ]]; then
    $k -n argocd patch application root --type json -p '[{"op":"remove","path":"/spec/syncPolicy/automated"}]' >/dev/null 2>&1 || true
    $k -n factory scale deploy/github --replicas=0 >/dev/null
    $k -n factory wait pod -l app.kubernetes.io/name=github --for=delete --timeout=2m >/dev/null
  else
    pin_watch
    $k -n factory scale deploy/github --replicas=1 >/dev/null
    $k -n argocd patch application root --type merge -p '{"spec":{"syncPolicy":{"automated":{"prune":true,"selfHeal":true}}}}' >/dev/null
  fi
  echo "  the scratch cluster's GitHub worker: $1"
}

status() {
  for copy in "$FACTORY_COPY" "$APP_COPY"; do
    say "$copy"
    echo "main     $(git ls-remote "https://github.com/$copy" refs/heads/main | cut -c1-12)"
    echo "baseline $(git ls-remote "https://github.com/$copy" refs/heads/baseline | cut -c1-12)"
    echo "open PRs $(gh pr list -R "$copy" --json number --jq length)"
    echo "issues   $(gh issue list -R "$copy" --state all --json number --jq length)"
  done
}

case "${1:-}" in
  app) (cd "$REPO" && mise exec -- node "$HERE/app.ts") ;;
  up) up ;;
  down) down ;;
  build) build ;;
  check) check ;;
  create) create ;;
  settings) settings ;;
  pin-images) pin_images ;;
  reset) shift; reset "$@" ;;
  store-save) store_save ;;
  store-restore) store_restore ;;
  dependabot) dependabot_like_real "$FACTORY_COPY" "$FACTORY_REAL"; dependabot_like_real "$APP_COPY" "$APP_REAL"
    dependabot_only_needed "$FACTORY_COPY"; dependabot_only_needed "$APP_COPY" ;;
  forget-closed) forget_closed "$FACTORY_COPY"; forget_closed "$APP_COPY" ;;
  status) status ;;
  worker) worker "${2:?0 or 1}" ;;
  *) sed -n '2,29p' "$0"; exit 2 ;;
esac
