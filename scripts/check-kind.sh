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
#   code       anything else: every check runs. A pin move of the App's (scripts/pin-move.ts) is this kind: the review
#              gate passes one only once the job that runs its pin (ZAP scan, image builds, tests) succeeded at its
#              head, so none of them may be skipped for it. One under deploy/ that only a cluster runs is `manifests`,
#              and the gate passes it once `platform`, which every change to deploy/ runs, succeeded at its head.
#
# `scripts/check-kind.sh platform` says instead whether platform.yml's cluster runs, `cluster` or `none`: `cluster` when
# HEAD changes from HEAD^1 any input, which is any path outside the classes a cluster is not made from (is_input, below:
# a path no one listed is an input), unless the kind is `deploy`, whose images were built from commits already merged
# and whose merge decides nothing (ADR 0017). Anything it cannot tell is `cluster`. In the
# merge queue, a `cluster` is `matched` instead when platform.yml's own job made one from the same inputs at the queued
# pull request's head and passed there (passed_at_head, below), and the job is skipped. Its log says the inputs' hash.
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

# A pin file at a commit, unpinned, and its size: awk ends every line it prints with a newline, so a file that lost its
# last one would read the same unpinned, and a digest is written the same length either side.
unpinned_at() {
  git show "$1:$2" | unpinned && git cat-file -s "$1:$2"
}

# Whether a line of `git diff --raw` from $1 to $2 is a pin file changed only in its digests: there before and after,
# with its mode unchanged, and the same once unpinned.
pin_digests_only() {
  local path before after
  [[ $3 =~ ^:100644\ 100644\ [0-9a-f]{40,64}\ [0-9a-f]{40,64}\ M$'\t'(.+)$ ]] || return 1
  path=${BASH_REMATCH[1]}
  [ "$path" = "$CONSOLE_PINS" ] || [ "$path" = "$FACTORY_PINS" ] || return 1
  before=$(unpinned_at "$1" "$path") || return 1
  after=$(unpinned_at "$2" "$path") || return 1
  [ "$before" = "$after" ]
}

# Whether HEAD changes nothing from HEAD^1 but digests in the pin files.
moves_only_pins() {
  local changes line
  changes=$(git diff --raw --no-renames --no-abbrev HEAD^1 HEAD) || return 1
  [ -n "$changes" ] || return 1
  while IFS= read -r line; do
    pin_digests_only HEAD^1 HEAD "$line" || return 1
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

# What a cluster is made from, its inputs: every path in the repository but those in a class below, each a class with
# a reason, and a test that the reason still holds (scripts/check-kind.test.ts, "the classes a cluster is not made
# from"). It fails closed: a file no one thought of, a new tool's config or a new directory, is an input, and costs a
# cluster, never a skip. This one rule decides both whether a change makes a cluster and the hash the queue compares.
#
# Kept whatever the classes say: deploy/, which Argo CD renders, every file in it; the workflow and any action of ours
# it could run; and the modules of the image sources that the scripts the job runs import (a test walks their imports).
KEPT='^(deploy/|\.github/workflows/platform\.yml$|\.github/actions/|policy/flags\.ts$|apps/factory/src/github/(registry|signatures)\.ts$|apps/factory/src/vulnerabilities/api-versions\.ts$)'
EXCLUDED_CLASSES=(
  # Words for people, and tests: nothing the job runs reads them.
  '^docs(/|$)' '\.md$' '(^|/)test(/|$)' '\.test\.ts$' '(^|/)e2e(/|$)'
  # Source that reaches the cluster only as an image built on main and pinned by digest in deploy/overlays/local, which
  # `make up` builds none of: the console's browser code among it.
  '^apps/(factory|runner|console)(/|$)' '^packages/(events|store|triage)(/|$)' '^policy(/|$)'
  # Every other workflow: the job runs none of them.
  '^\.github(/|$)'
  # Claude Code's own files and the dev container's: nothing the job runs reads them.
  '^\.claude(/|$)' '^\.devcontainer(/|$)'
  # What installs the modules (an accepted limit). The job installs with --ignore-scripts and --ignore-pnpmfile, so a
  # change here runs nothing: it can change which versions of the modules install, which the job's scripts run on the
  # host, and can break the install, failing the check. A change to these alone makes no cluster, so such a break shows
  # on the next change that makes one; in the queue, one merged ahead is not run again.
  # Each class names a directory with what is in it, the directory itself too, as a link to it reads.
  '^pnpm-lock\.yaml$' '^pnpm-workspace\.yaml$' '(^|/)package\.json$'
)
EXCLUDED=$(IFS='|'; echo "${EXCLUDED_CLASSES[*]}")
is_input() {
  [[ $1 =~ $KEPT ]] || ! [[ $1 =~ $EXCLUDED ]]
}

# Whether HEAD changes an input from HEAD^1: both sides of a rename, each path whole however git would quote it. A
# diff it cannot read counts as a change.
changes_platform() {
  local changes path
  changes=$(mktemp) || return 0
  git diff --name-only -z --no-renames HEAD^1 HEAD > "$changes" || { rm -f "$changes"; return 0; }
  while IFS= read -r -d '' path; do
    is_input "$path" && { rm -f "$changes"; return 0; }
  done < "$changes"
  rm -f "$changes"
  return 1
}

# In the merge queue, a cluster made at the pull request's head stands for the queue's commit when the cluster would be
# made from the same inputs. An input is read as git holds it, its mode, type and object, so a mode, a symlink or a
# deletion differs; the App's deploy pins of our own images are read with their digests written the same, as ADR 0017
# reads them, where their move alone makes no cluster either.
# How long a pass at the head stands: what the cluster pulls that no input pins by digest (the app's main, which the
# website follows, each chart at its version, k3s at its tag, the runner's image) moves by itself.
PASS_HOURS=24
# The workflow, its job and the step that make the cluster, which the pass must have run.
PLATFORM_WORKFLOW=.github/workflows/platform.yml
CLUSTER_STEP='Make the cluster'

# The inputs at a commit, a line each, `<mode> <type> <object><tab><path>`: a pin file's object is its unpinned text's.
inputs_at() {
  local listing entry meta path object
  listing=$(mktemp) || return 1
  git ls-tree -r -z --full-tree "$1" > "$listing" || { rm -f "$listing"; return 1; }
  while IFS= read -r -d '' entry; do
    meta=${entry%%$'\t'*}
    path=${entry#*$'\t'}
    is_input "$path" || continue
    if [[ $meta == '100644 blob '* ]] && { [ "$path" = "$CONSOLE_PINS" ] || [ "$path" = "$FACTORY_PINS" ]; }; then
      object=$(unpinned_at "$1" "$path" | git hash-object --stdin) || { rm -f "$listing"; return 1; }
      meta="100644 unpinned $object"
    fi
    printf '%s\t%q\n' "$meta" "$path"
  done < "$listing"
  rm -f "$listing"
}

# One hash of the inputs at a commit, a git object's.
inputs_hash() {
  local listing
  listing=$(inputs_at "$1") || return 1
  git hash-object --stdin <<< "$listing"
}

# Whether each commit on $2's first-parent line since $1, which must be on it, changes no input but the pins' digests:
# so that a merge of the head into any of them makes the head's inputs. Says the first that does in `why`.
inputs_still() {
  local commits commit last changes meta path
  git merge-base --is-ancestor "$1" "$2" || { why "${1:0:7} is not under ${2:0:7}"; return 1; }
  commits=$(git rev-list --first-parent "$1..$2") || { why "git could not list ${1:0:7}..${2:0:7}"; return 1; }
  [ -z "$commits" ] && return 0
  last=$(tail -n 1 <<< "$commits")
  [ "$(git rev-parse "$last^1")" = "$(git rev-parse "$1^{commit}")" ] ||
    { why "${1:0:7} is not on the first-parent line of ${2:0:7}"; return 1; }
  changes=$(mktemp) || { why 'no room to read the commits in'; return 1; }
  for commit in $commits; do
    git diff --raw -z --no-renames --no-abbrev "$commit^1" "$commit" > "$changes" ||
      { rm -f "$changes"; why "git could not read ${commit:0:7}"; return 1; }
    while IFS= read -r -d '' meta && IFS= read -r -d '' path; do
      is_input "$path" || continue
      pin_digests_only "$commit^1" "$commit" "$meta"$'\t'"$path" && continue
      rm -f "$changes"
      why "${commit:0:7}, on main since the head's base, changes $(printf %q "$path")"
      return 1
    done < "$changes"
  done
  rm -f "$changes"
}

# Why the queue makes a cluster, said once in the log.
reason=''
why() {
  reason=$1
}

# Whether `platform` made a cluster from the queue's inputs at the head of the pull request the queue's branch names,
# and passed there, within PASS_HOURS. It reads the head's inputs from git, and the pass from GitHub's check runs at
# that head alone: the check run `platform` of the GitHub Actions app, the latest of its check suite, whose suite is a
# run of this workflow, on that pull request into main, from its branch in this repository, made since it was opened,
# and whose job ran the step that makes the cluster, every such run a success. Anything it cannot tell is a cluster.
# Takes the inputs' hash at the queue's commit, and sets `matched` to what it found.
matched=''
passed_at_head() {
  local repo=${GITHUB_REPOSITORY:-} at_queue=${1:-} number pull state base head ref from created b0 at_head shallow=''
  local events siblings sharing checks runs latest read_ok id status conclusion completed run attempt ran fresh
  # Off at any value but none or `on`, so a spelling of off never leaves it on.
  case "${PLATFORM_SKIP:-}" in
    '' | on) ;;
    *) why "the repository variable PLATFORM_SKIP is ${PLATFORM_SKIP}"; return 1 ;;
  esac
  [[ ${QUEUE_BRANCH:-} =~ $QUEUE ]] || { why "the queue's branch names no pull request"; return 1; }
  number=${BASH_REMATCH[2]}
  [[ $repo =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { why 'no repository is named'; return 1; }
  pull=$(gh api "repos/$repo/pulls/$number" |
    jq -r '[.state, .base.ref, .head.sha, .head.ref, .head.repo.full_name, .created_at] | map(. // "") | join("\u001f")') ||
    { why "GitHub did not say what #$number is"; return 1; }
  # Split on a separator that is not whitespace, so an empty field stays a field.
  IFS=$'\x1f' read -r state base head ref from created <<< "$pull"
  [ "$state" = open ] && [ "$base" = main ] || { why "#$number is $state, into $base"; return 1; }
  [ "$from" = "$repo" ] || { why "#$number's head is in ${from:-no repository}, not $repo"; return 1; }
  [[ $head =~ ^[0-9a-f]{40}$ ]] && [[ $created =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:]{8}Z$ ]] ||
    { why "GitHub named no head or opening time for #$number"; return 1; }

  # The head's inputs, by git alone: the queue's commit makes the same, and so does a merge of the head into main as
  # it was at any time since the head was made, so the cluster made at the head was made from these.
  [ "$(git rev-parse --is-shallow-repository)" = true ] && shallow=--unshallow
  git fetch --quiet --no-tags --filter=blob:none $shallow origin "+refs/pull/$number/head:refs/platform/head" ||
    { why "git could not fetch #$number's head"; return 1; }
  [ "$(git rev-parse refs/platform/head)" = "$head" ] || { why "#$number's head moved"; return 1; }
  [ -n "$at_queue" ] && at_head=$(inputs_hash "$head") ||
    { why "git could not read the inputs"; return 1; }
  [ "$at_queue" = "$at_head" ] ||
    { why "the inputs at the queue's commit ($at_queue) are not those at #$number's head ${head:0:7} ($at_head)"; return 1; }
  b0=$(git merge-base "$head" HEAD^1) || { why "#$number's head has no base on main"; return 1; }
  inputs_still "$b0" HEAD^1 || return 1

  # The pull request ran it for itself alone: never retargeted, no other from its branch since it was opened, and no
  # other with its head. A run's pull requests are those it matches now, not the one it ran for (scripts/pin-moves.ts).
  events=$(gh api --paginate "repos/$repo/issues/$number/events?per_page=100" | jq -r '.[].event') ||
    { why "GitHub did not list #$number's events"; return 1; }
  ! grep -qxE 'base_ref_changed|automatic_base_change_succeeded' <<< "$events" ||
    { why "#$number's base was changed"; return 1; }
  siblings=$(gh api --paginate "repos/$repo/pulls?state=all&per_page=100&head=$(jq -rn --arg h "${repo%%/*}:$ref" '$h | @uri')" |
    jq -r --argjson n "$number" --arg created "$created" \
      '.[] | select(.number != $n and (.state == "open" or .closed_at == null or .closed_at >= $created)) | .number') ||
    { why "GitHub did not list the pull requests from #$number's branch"; return 1; }
  [ -z "$siblings" ] || { why "#$(head -n 1 <<< "$siblings") comes from the same branch"; return 1; }
  sharing=$(gh api --paginate "repos/$repo/commits/$head/pulls?per_page=100" |
    jq -r --argjson n "$number" --arg head "$head" '.[] | select(.number != $n and .head.sha == $head) | .number') ||
    { why "GitHub did not list the pull requests at ${head:0:7}"; return 1; }
  [ -z "$sharing" ] || { why "#$(head -n 1 <<< "$sharing") has the same head"; return 1; }

  # As files, never arguments: the lists outgrow what one argument may hold on Linux (128 KiB).
  checks=$(mktemp) || { why 'no room to read the check runs in'; return 1; }
  runs=$(mktemp) || { rm -f "$checks"; why 'no room to read the check runs in'; return 1; }
  gh api --paginate "repos/$repo/commits/$head/check-runs?check_name=platform&filter=all&per_page=100" |
    jq '.check_runs[]' > "$checks" || { rm -f "$checks" "$runs"; why "GitHub did not list the check runs at ${head:0:7}"; return 1; }
  gh api --paginate "repos/$repo/actions/runs?head_sha=$head&event=pull_request&per_page=100" |
    jq '.workflow_runs[]' > "$runs" || { rm -f "$checks" "$runs"; why "GitHub did not list the workflow runs at ${head:0:7}"; return 1; }
  latest=$(jq -rn --slurpfile checks "$checks" --slurpfile runs "$runs" --arg head "$head" --arg repo "$repo" \
    --arg ref "$ref" --arg created "$created" --argjson n "$number" --arg workflow "$PLATFORM_WORKFLOW" '
    [$runs[] | select(.path == $workflow and .event == "pull_request" and .head_sha == $head
      and .repository.full_name == $repo and .head_repository.full_name == $repo and .head_branch == $ref
      and .created_at >= $created and any(.pull_requests[]?; .number == $n and .base.ref == "main"))] as $ours
    | [$checks[] | select(.name == "platform" and .head_sha == $head and .app.slug == "github-actions")
        | . as $check | ([$ours[] | select(.check_suite_id == $check.check_suite.id)] | first) as $run
        | select($run != null)
        | {id, status, conclusion, completed_at, suite: .check_suite.id, run: $run.id, attempt: $run.run_attempt}]
    | group_by(.suite) | map(max_by(.id)) | sort_by(-.id)[]
    | [.id, .status, (.conclusion // "-"), (.completed_at // "-"), .run, .attempt] | map(tostring) | join("\u001f")')
  read_ok=$?
  rm -f "$checks" "$runs"
  [ "$read_ok" = 0 ] || { why "the check runs at ${head:0:7} could not be read"; return 1; }
  [ -n "$latest" ] || { why "no run of $PLATFORM_WORKFLOW for #$number has a platform job at ${head:0:7}"; return 1; }
  while IFS=$'\x1f' read -r id status conclusion completed run attempt; do
    [ "$status" = completed ] && [ "$conclusion" = success ] ||
      { why "platform at ${head:0:7}, in run $run, is $status, $conclusion"; return 1; }
    ran=$(gh api "repos/$repo/actions/runs/$run/attempts/$attempt/jobs?per_page=100" |
      jq -r --argjson id "$id" --arg step "$CLUSTER_STEP" '[.jobs[] | select(.id == $id and .name == "platform"
        and .conclusion == "success" and any(.steps[]?; .name == $step and .conclusion == "success"))] | length') ||
      { why "GitHub did not list run $run's jobs"; return 1; }
    [ "$ran" = 1 ] || { why "platform at ${head:0:7}, in run $run, did not make a cluster"; return 1; }
  done <<< "$latest"
  # The newest pass, the first row.
  IFS=$'\x1f' read -r id status conclusion completed run attempt <<< "$latest"
  fresh=$(jq -rn --arg t "$completed" --argjson hours "$PASS_HOURS" '($t | fromdateiso8601) > (now - $hours * 3600)') ||
    { why "GitHub named no time platform ended at ${head:0:7}"; return 1; }
  [ "$fresh" = true ] || { why "platform passed at ${head:0:7} at $completed, more than $PASS_HOURS hours ago"; return 1; }
  matched="#$number's head ${head:0:7}, where run $run made a cluster and passed at $completed (inputs $at_queue)"
}

mode=${1:-kind}
case "$mode" in
  kind | platform) ;;
  # The rule alone, for its tests: of the paths on stdin, a line each, it prints those that are inputs.
  inputs)
    while IFS= read -r path; do
      if is_input "$path"; then printf '%s\n' "$path"; fi
    done
    exit 0
    ;;
  *) echo "usage: $0 [platform | inputs]" >&2; exit 2 ;;
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
  exit 0
fi
if [ "$kind" = deploy ] || ! changes_platform; then
  echo none
  exit 0
fi
# The inputs' hash, for the log: at the commit checked out, and at the pull request's head, its second parent, if any.
hashed_head=$(inputs_hash HEAD) || hashed_head=''
echo "Inputs at $(git rev-parse --short HEAD): ${hashed_head:-not read}" >&2
if sha=$(git rev-parse --verify --quiet 'HEAD^2^{commit}'); then
  echo "Inputs at ${sha:0:7}: $(inputs_hash "$sha" || echo 'not read')" >&2
fi
if [ "${GITHUB_EVENT_NAME:-}" != merge_group ]; then
  echo cluster
elif passed_at_head "$hashed_head"; then
  echo "No cluster in the queue: its inputs are those at $matched. To make one every time, set the repository variable PLATFORM_SKIP to off." >&2
  echo matched
else
  echo "A cluster in the queue: ${reason:-it could not tell why}. It makes none when platform passed on the same inputs at the pull request's head (scripts/check-kind.sh)." >&2
  echo cluster
fi
