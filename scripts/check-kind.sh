#!/usr/bin/env bash
# Which of check.yml's checks can see what a change makes (its `kind` job). It reads the commit checked out, HEAD, and
# the one it is made on, HEAD^1: on a pull request, its merge commit and the base it merges into; in the merge queue,
# the queue's commit for one pull request and the commit that entry is made on, main or the entry ahead of it. It
# prints one word, and anything it cannot tell is `code`:
#
#   release    a pull request into main by the factory's App that changes only the changelog, the release manifest and
#              the version line of package.json. On a pull request only: the queue runs a release as `code`.
#   deploy     a change by the factory's App into main whose every changed line is the digest of an image the two pin
#              files of the local profile pin, on a pull request or in the queue.
#   manifests  a pull request, anyone's, that changes only files under deploy/, but for the Postgres the console's
#              browser tests run beside. On a pull request only.
#   code       anything else: every check runs.
#
# `scripts/check-kind.sh platform` says instead whether platform.yml's cluster runs, `cluster` or `none`: `cluster` when
# HEAD changes from HEAD^1 anything a cluster made from the change runs or makes it with (deploy/, the Makefile, mise's
# pins, k3d's among them, the workflow, the scripts it runs and the modules they import), unless the kind is `deploy`, whose images were built
# from commits already merged and whose merge decides nothing (ADR 0017). Anything it cannot tell is `cluster`.
#
# The pull request's author and base come from the event on a pull request (AUTHOR, GITHUB_BASE_REF), and in the queue,
# whose event names no pull request, from the API, for the pull request the queue's branch names (QUEUE_BRANCH,
# GITHUB_REPOSITORY, GH_TOKEN). A queued stack or batch has an entry for each of its pull requests, each on a branch
# that names it and each made on the entry ahead of it, so the change from HEAD^1 is that one pull request's: an entry
# is a deploy only when that pull request is the App's, into main, and its change moves only pins. What it is made on
# is the entry ahead's change, which that entry's own run checks, and which a deploy's tests wait for (check.yml's
# required check).
set -uo pipefail

APP='mrogan-software-factory[bot]'
CONSOLE_PINS=deploy/overlays/local/console-image/kustomization.yaml
FACTORY_PINS=deploy/overlays/local/factory-image/kustomization.yaml
# The branch the merge queue makes for a pull request into main, its number the second group: the same expression as
# scripts/review-gate.ts's QUEUE_BRANCH, which a test holds it to.
QUEUE='^(refs/heads/)?gh-readonly-queue/main/pr-([0-9]+)-[0-9a-f]{7,40}$'

# A pin file as written, with each image's digest under its top-level `images:` written the same, so that two copies
# that differ only in those digests read the same. A digest is `- digest: sha256:` and 64 hex digits, a line of 81
# characters; a line written any other way is left as it is, and so differs.
unpinned() {
  awk '/^[^[:space:]#-]/ || /^---/ { top = $0 }
    top == "images:" && /^- digest: sha256:[0-9a-f]+$/ && length($0) == 81 { $0 = "- digest: sha256:<digest>" }
    { print }'
}

# A pin file at a commit, unpinned, with a line after it, so that a change to the newlines at its end still differs.
unpinned_at() {
  git show "$1:$2" | unpinned && echo .
}

# Whether HEAD changes nothing from HEAD^1 but digests in the pin files: each file it changes is one of them, there
# before and after, with its mode unchanged, and the same once unpinned.
moves_only_pins() {
  local changes line path before after
  changes=$(git diff --raw --no-renames --no-abbrev HEAD^1 HEAD) || return 1
  [ -n "$changes" ] || return 1
  while IFS= read -r line; do
    [[ $line =~ ^:100644\ 100644\ [0-9a-f]{40,64}\ [0-9a-f]{40,64}\ M$'\t'(.+)$ ]] || return 1
    path=${BASH_REMATCH[1]}
    [ "$path" = "$CONSOLE_PINS" ] || [ "$path" = "$FACTORY_PINS" ] || return 1
    before=$(unpinned_at HEAD^1 "$path") || return 1
    after=$(unpinned_at HEAD "$path") || return 1
    [ "$before" = "$after" ] || return 1
  done <<< "$changes"
}

# Whether HEAD changes from HEAD^1 only the changelog, the release manifest and package.json's version line.
releases_only() {
  local files lines others
  files=$(git diff --name-only --no-renames HEAD^1 HEAD) || return 1
  [ -n "$files" ] || return 1
  ! grep -vqxE 'CHANGELOG\.md|package\.json|\.release-please-manifest\.json' <<< "$files" || return 1
  lines=$(git diff --unified=0 HEAD^1 HEAD -- package.json) || return 1
  others=$(grep -E '^[-+]' <<< "$lines" | grep -vE '^(\+\+\+|---) ' | grep -vE '^[-+]  "version": "[^"]+",$')
  [ -z "$others" ]
}

# Whether HEAD changes from HEAD^1 only files under deploy/, but not the Postgres the console's browser tests run beside
# (scripts/ci-images.sh postgres). Both sides of a rename, so that moving a file into deploy/ counts the place it left.
manifests_only() {
  local files
  files=$(git diff --name-only --no-renames HEAD^1 HEAD) || return 1
  [ -n "$files" ] && ! grep -vqE '^deploy/' <<< "$files" \
    && ! grep -qxF 'deploy/base/postgres/statefulset.yaml' <<< "$files"
}

# The author and base of the pull request the queue's branch names, as `<login> <base>`.
queued() {
  [[ ${QUEUE_BRANCH:-} =~ $QUEUE ]] || return 1
  gh api "repos/$GITHUB_REPOSITORY/pulls/${BASH_REMATCH[2]}" --jq '"\(.user.login) \(.base.ref)"'
}

# Whether HEAD changes from HEAD^1 anything the platform check's cluster is made from or runs: both sides of a rename.
# The modules the scripts import are named file by file, as scripts/check-kind.test.ts finds them: a directory would
# give a cluster to every change beside one of them. scripts/answer-key.ts is not among them: `make up` runs it only
# with the private checkout, which the check's runner never has.
# A diff it cannot read counts as a change.
PLATFORM='^(deploy/|Makefile$|mise\.(toml|lock)$|\.github/workflows/platform\.yml$|scripts/(check-kind\.sh|wait-deployed\.sh|platform-watch\.sh|admission-ready\.sh|[a-z-]+-refusals\.(sh|ts)|local-ca\.ts|share-key\.ts|signed-by\.ts|policy-hash\.ts)$|policy/flags\.ts$|apps/factory/src/github/(registry|signatures)\.ts$)'
changes_platform() {
  local files
  files=$(git diff --name-only --no-renames HEAD^1 HEAD) || return 0
  grep -qE "$PLATFORM" <<< "$files"
}

mode=${1:-kind}
case "$mode" in
  kind | platform) ;;
  *) echo "usage: $0 [platform]" >&2; exit 2 ;;
esac

kind=code
case "${GITHUB_EVENT_NAME:-}" in
  pull_request)
    if [ "${AUTHOR:-}" = "$APP" ] && [ "${GITHUB_BASE_REF:-}" = main ]; then
      if releases_only; then
        kind=release
      elif moves_only_pins; then
        kind=deploy
      fi
    fi
    if [ "$kind" = code ] && manifests_only; then
      kind=manifests
    fi
    ;;
  merge_group)
    if pull=$(queued) && [ "$pull" = "$APP main" ] && moves_only_pins; then
      kind=deploy
    fi
    ;;
esac
if [ "$mode" = kind ]; then
  echo "$kind"
elif [ "$kind" != deploy ] && changes_platform; then
  echo cluster
else
  echo none
fi
