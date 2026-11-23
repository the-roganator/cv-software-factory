#!/usr/bin/env bash
# The confirming pass: every test on one code baseline, in batches of a few, with the two level checks.
#   ./confirm.sh <a directory for its baseline logs>
#   STEPS="C D" ./confirm.sh <dir> runs some of its steps (A B C D apps W; all by default).
# About twelve hours. It prints one section a step, and `harness.ts summary` at the end. Each factory batch is a
# baseline of its own, as PIN_WATCH_ONLY is part of one; the code staged is the same throughout. A batch's
# PIN_WATCH_ONLY and STAGED_EXTRA are written to the state folder's batch.env (copies.sh), never to a tracked file.
H="$(cd "$(dirname "$0")" && pwd)"
STATE="${PATCHING_HARNESS_STATE:-$(dirname "$(git -C "$H" rev-parse --path-format=absolute --git-common-dir)")/scratch/patching-harness}"
BATCH="$STATE/batch.env"
mkdir -p "$STATE" && touch "$BATCH"
R=the-roganator/cv-software-factory-scratch
APP_COPY=the-roganator/cv-worlds-worst-website-scratch
LOGS=${1:?a directory for the baseline logs}
STEPS=${STEPS:-A B C D apps W}
want() { [[ " $STEPS " == *" $1 "* ]]; }
k() { kubectl --context k3d-software-factory-scratch "$@"; }

# The switches of the title check that fails on purpose (staged/factory/15-checks-red-on-purpose.patch): repository
# variables the catalogue names for W1 and W2, set just before their run and cleared after it, and on any exit, as one
# left set makes red every pull request whose title it names (the harness refuses to run beside one).
red_on() { # <tests>
  (cd "$H" && mise exec -- node harness.ts variables "$1") | while IFS=$'\t' read -r repo name value; do
    gh variable set "$name" -R "$repo" -b "$value" >/dev/null && echo "set $name on $repo: $value"
  done
}
red_off() {
  local repo name
  for repo in "$R" "$APP_COPY"; do
    for name in $(gh variable list -R "$repo" --json name -q '.[].name | select(startswith("SCRATCH_RED_"))'); do
      gh variable delete "$name" -R "$repo" && echo "cleared $name on $repo"
    done
  done
}
trap red_off EXIT

baseline() { # <tests> <log>
  local line
  line="$(cd "$H" && mise exec -- node harness.ts only "$1" | grep '^PIN_WATCH_ONLY')" || return 1
  LINE="$line" perl -0pi -e 's/^PIN_WATCH_ONLY=.*\n//mg; $_ .= "$ENV{LINE}\n"' "$BATCH"
  echo "real repo queued: $(gh run list -R the-roganator/cv-software-factory --status queued -L 100 --json databaseId -q length)"
  # SKIP_CHECK=1 leaves out `make check` in the copies, for a baseline one of the copy's own tests fails by design (X4).
  for step in build check reset pin-images; do
    [ -n "${SKIP_CHECK:-}" ] && [ "$step" = check ] && { echo "== check skipped $(date -u +%H:%MZ)"; continue; }
    echo "== $step $(date -u +%H:%MZ)"
    (cd "$H" && ./copies.sh "$step") >>"$2" 2>&1 || {
      echo "FAILED at $step"
      grep -n "FAIL \|AssertionError\|copies.sh:\|error:" "$2" | tail -8 | cut -c1-300
      return 1
    }
  done
  local state
  for _ in $(seq 1 60); do
    state=$(k -n argocd get app root -o jsonpath='{.status.sync.status} {.status.health.status}')
    [ "$state" = "Synced Healthy" ] && break
    sleep 20
  done
  # A reset that takes the app back past an ordinary fix (a work item run between campaigns) is a release the canary
  # rightly aborts: the baseline is the tests' starting point, so it is promoted whole, or every app test's deploy fails.
  if [ "$(k -n website get rollout website -o jsonpath='{.status.abort}')" = true ]; then
    kubectl argo rollouts --context k3d-software-factory-scratch -n website promote --full website
    for _ in $(seq 1 30); do
      state=$(k -n argocd get app root -o jsonpath='{.status.sync.status} {.status.health.status}')
      [ "$state" = "Synced Healthy" ] && break
      sleep 20
    done
  fi
  echo "root: $state $(date -u +%H:%MZ)"
}
campaign() { (cd "$H" && mise exec -- node harness.ts factory "$@" --limit "${LIMIT:-60}" 2>&1 | tail -22 | cut -c1-520); }
# What the watches said of their branches after the run's own restart of the worker.
watches() {
  echo "--- the watches after the run's restart:"
  k -n factory logs deploy/github --since=90m |
    grep -o '"msg":"[^"]*deploy branch[^"]*"\|"msg":"made the deploy pull request again[^"]*"\|"msg":"[^"]*pin branch[^"]*"' | sort | uniq -c
}
# A failed cluster's reason, which a dead runner still delivers as a step's name.
why() {
  echo "--- platform steps named Why:"
  for id in $(gh api "repos/$R/actions/workflows/419399571/runs?per_page=60" -q '.workflow_runs[]|select(.conclusion!="success")|.id'); do
    gh api "repos/$R/actions/runs/$id/jobs" -q '.jobs[].steps[]?|select((.name|startswith("Why:")) and (.name|length>6))|.name'
  done | head -5
}

if want A; then
echo "##### A: 1,2,3,5,14a and the forgeries, Guarded $(date -u +%H:%MZ)"
(cd "$H" && ./level.sh guarded >/dev/null)
baseline 1,2,3,5,14a "$LOGS/confirm-a.log" && campaign --only 1,2,3,5,14a,N3a,N3b,N4,N5
watches
why
fi

if want B; then
echo "##### B: 4a,4b,6,7a,7b,9,14b, Guarded $(date -u +%H:%MZ)"
baseline 4a,4b,6,7a,7b,9,14b "$LOGS/confirm-b.log" && campaign --only 4a,4b,6,7a,7b,9,14b --no-forge
watches
why
fi

if want C; then
echo "##### C: 4a,4b at Lights-out $(date -u +%H:%MZ)"
baseline 2,4a,4b "$LOGS/confirm-c.log" && {
  (cd "$H" && ./level.sh lights-out | grep '|')
  campaign --only 2,4a,4b --no-forge --lights-out
}
fi

if want D; then
echo "##### D: Supervised, no move queued $(date -u +%H:%MZ)"
(cd "$H" && ./level.sh supervised | grep '|')
since=$(date -u +%Y-%m-%dT%H:%M:%SZ)
# On the baseline step C left; a build that failed part way leaves `work/` dirty and the reset refuses.
# The worker stays stopped from the reset until that base has merged: started on the pushed baseline it opens the deploy
# pull request at once, red, runs its checks again three times and is out of runs before the base is there.
(cd "$H" && KEEP_WORKER_DOWN=1 ./copies.sh reset factory) >"$LOGS/confirm-d.log" 2>&1 || echo "the reset FAILED: see $LOGS/confirm-d.log; what follows is no verdict"
# A reset pushes main, so the deploy pull request's check finds no merge-queue run of its base and is red. Here alone,
# where the deploy pin merging at Supervised is the test, one docs pull request of Martin's goes through the queue: the
# deploy watch then writes its pull request on a base the queue ran. Elsewhere the red one keeps a deploy from
# restarting the factory mid-watch.
queued_base() {
  local branch=scratch/queued-base main readme n
  main=$(gh api "repos/$R/git/ref/heads/main" -q .object.sha) || return 1
  gh api -X DELETE "repos/$R/git/refs/heads/$branch" >/dev/null 2>&1 || true
  gh api -X POST "repos/$R/git/refs" -f ref="refs/heads/$branch" -f sha="$main" >/dev/null || return 1
  # Through GraphQL's createCommitOnBranch, which GitHub signs: the copy's ruleset requires signed commits.
  readme=$({ gh api "repos/$R/contents/README.md?ref=$branch" -H 'Accept: application/vnd.github.raw'; \
    printf '\n<!-- scratch: %s, a commit through the merge queue for the deploy pull request'"'"'s base -->\n' "$since"; } | base64 | tr -d '\n')
  gh api graphql -f expected="$main" -f repo="$R" -f branch="$branch" -f readme="$readme" -f query='
    mutation($repo: String!, $branch: String!, $expected: GitObjectID!, $readme: Base64String!) {
      createCommitOnBranch(input: {
        branch: { repositoryNameWithOwner: $repo, branchName: $branch }, expectedHeadOid: $expected,
        message: { headline: "docs(scratch): put main on a commit the merge queue ran" },
        fileChanges: { additions: [{ path: "README.md", contents: $readme }] } }) { commit { oid } } }' >/dev/null || return 1
  n=$(gh pr create -R "$R" --head "$branch" --base main --title "docs(scratch): put main on a commit the merge queue ran" \
    --body "The patching harness's batch D: a reset pushes main, so a deploy pull request's base has no merge-queue run." | grep -o '[0-9]*$') || return 1
  gh pr merge "$n" -R "$R" --squash --auto >/dev/null || return 1
  for _ in $(seq 1 60); do
    [ "$(gh pr view "$n" -R "$R" --json state -q .state)" = MERGED ] && { echo "queued base: #$n merged $(date -u +%H:%MZ)"; return 0; }
    # The ruleset wants every review thread resolved; Copilot's on this harness commit are resolved unread.
    gh api graphql -F n="$n" -f query='query($n: Int!) { repository(owner: "the-roganator", name: "cv-software-factory-scratch") {
      pullRequest(number: $n) { reviewThreads(first: 20) { nodes { id isResolved comments(first: 1) { nodes { author { login } } } } } } } }' \
      -q '.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved | not) | select(.comments.nodes[0].author.login == "copilot-pull-request-reviewer") | .id' |
      while read -r thread; do
        gh api graphql -f id="$thread" -f query='mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { isResolved } } }' >/dev/null &&
          echo "queued base: resolved Copilot's thread on #$n"
      done
    sleep 30
  done
  echo "queued base: #$n did not merge in 30 minutes"; return 1
}
queued_base || echo "the queued base FAILED: the deploy pin's verdict below is no verdict"
(cd "$H" && ./copies.sh worker 1)
k -n factory rollout restart deploy/patching >/dev/null
since=$(date -u +%Y-%m-%dT%H:%M:%SZ)
sleep 2100
deploy=$(gh pr list -R "$R" --state all -L 20 --json number,title,mergedAt,createdAt \
  -q "[.[]|select(.createdAt>\"$since\")|select(.title|startswith(\"chore(deploy): \"))][0]|\"#\(.number) merged=\(.mergedAt)\"")
case "$deploy" in
  *merged=null|"") echo "deploy pin: FAIL, not merged at Supervised (${deploy:-no deploy pull request})" ;;
  *) echo "deploy pin: PASS, merged at Supervised: $deploy" ;;
esac
gh pr list -R "$R" --state all -L 12 --json number,title,state,createdAt,mergedAt \
  -q ".[]|select(.createdAt>\"$since\")|\"#\(.number) \(.state) merged=\(.mergedAt) \(.title)\""
echo "queue: $(gh api graphql -f query='{repository(owner:"the-roganator",name:"cv-software-factory-scratch"){mergeQueue(branch:"main"){entries(first:20){nodes{pullRequest{number}}}}}}' -q '.data.repository.mergeQueue.entries.nodes|map(.pullRequest.number)|join(",")')"
k -n factory logs deploy/github --since-time="$since" | grep -o '"why":"[^"]*"' | sort | uniq -c | sort -rn | head -6
(cd "$H" && ./level.sh guarded | grep '|')
fi

if want apps; then
for test in 8a 10 11 12 13 N1; do
  echo "##### app $test $(date -u +%H:%MZ)"
  (cd "$H" && mise exec -- node harness.ts app "$test" --limit "${LIMIT:-60}" 2>&1 | tail -9 | cut -c1-700)
done
fi

# The recovery tests, W1 to W4. W1's baseline first (prometheus and the otel-collector alone), so the step stands on its own whatever baseline came before: the staged `15-…` patches are in
# it. Then the app's three, which take any baseline, then W1's campaign, which resets the factory copy itself. Guarded.
if want W; then
echo "##### W: the baseline for W1 to W4 $(date -u +%H:%MZ)"
(cd "$H" && ./level.sh guarded >/dev/null)
# KEEP_BASELINE=1 runs on the baseline as built, when it is already W1's.
if [ -n "${KEEP_BASELINE:-}" ] || baseline W1a,W1b "$LOGS/confirm-w.log"; then
for test in ${W_APPS:-W2 W3 W4}; do  # W_APPS='W2 W4' W1=no runs some of them again
  echo "##### app $test $(date -u +%H:%MZ)"
  red_on "$test"
  (cd "$H" && mise exec -- node harness.ts app "$test" --limit "${LIMIT:-60}" 2>&1 | tail -12 | cut -c1-700)
  red_off
done
if [ "${W1:-yes}" != no ]; then
echo "##### W1: a check red on purpose on two pin moves, Guarded $(date -u +%H:%MZ)"
red_on W1a,W1b
# W1b is watched to 100 minutes whatever the limit (its watchMin): three runs of a chart's checks, then nothing.
campaign --only W1a,W1b --no-forge
red_off
watches
why
fi
fi
fi

# The security tests X1 and X2; X3 cannot be staged, and X4 is a step of its own (below). Not in the default STEPS:
# STEPS=X ./confirm.sh <dir>. Guarded.
if want X; then
(cd "$H" && ./level.sh guarded >/dev/null)
# X1: two forged app moves the gate must hold, on any baseline that carries no staged extra. Alone (about 30 minutes,
# the line parked), or X_BESIDE=<app test> rides them beside that test's scan and its ticket.
echo "##### X1: two forged app moves, held by the gate $(date -u +%H:%MZ)"
if [ -n "${X_BESIDE:-}" ]; then x1=("$X_BESIDE" --with X1a,X1b); else x1=(X1a --with X1b); fi
(cd "$H" && mise exec -- node harness.ts app "${x1[@]}" --limit "${LIMIT:-60}" 2>&1 | tail -12 | cut -c1-700)
# X2: a baseline of its own, with staged/factory-x2/ (copies.sh's STAGED_EXTRA, in batch.env), the day's lockfile
# moves and ejs's major. The line is taken out of batch.env after, and the next baseline is built without it (the
# harness refuses any other test on this one).
if [ "${X2:-yes}" != no ]; then
  echo "##### X2: a major that clears a Trivy Critical, Guarded $(date -u +%H:%MZ)"
  perl -0pi -e 's/^STAGED_EXTRA=.*\n//mg; $_ .= "STAGED_EXTRA=x2\n"' "$BATCH"
  baseline X2 "$LOGS/confirm-x2.log" && campaign --only X2 --no-forge
  perl -0pi -e 's/^STAGED_EXTRA=.*\n//mg' "$BATCH"
  watches
fi
fi
# X4: a baseline of its own, with staged/app-x4/ (mise at the scan's target Node, the Dockerfile behind). The app's own
# test/node-pins.test.ts fails on that baseline by design, so its `make check` is skipped; the move's pull request mends
# it. The line is taken out of batch.env after: the next baseline is built without it.
if want X4; then
echo "##### X4: a half-made Node move, finished by the line $(date -u +%H:%MZ)"
(cd "$H" && ./level.sh guarded >/dev/null)
perl -0pi -e 's/^STAGED_EXTRA=.*\n//mg; $_ .= "STAGED_EXTRA=x4\n"' "$BATCH"
SKIP_CHECK=1 baseline W1a,W1b "$LOGS/confirm-x4.log" &&
  (cd "$H" && mise exec -- node harness.ts app X4 --limit "${LIMIT:-60}" 2>&1 | tail -12 | cut -c1-700)
perl -0pi -e 's/^STAGED_EXTRA=.*\n//mg' "$BATCH"
fi
echo "##### summary $(date -u +%H:%MZ)"
(cd "$H" && mise exec -- node harness.ts summary | cut -c1-170)
