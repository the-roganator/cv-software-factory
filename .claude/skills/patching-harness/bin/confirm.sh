#!/usr/bin/env bash
# The confirming pass: every test on one code baseline, in batches of a few, with the two level checks.
#   ./confirm.sh <a directory for its baseline logs>
#   STEPS="C D" ./confirm.sh <dir> runs some of its steps (A B C D apps W; all by default; X, X4 and 21 by name).
#   D is three phases on one reset: Supervised with the line stopped, Guarded with it stopped (26), Supervised with it
#   running. It prints their lines itself; the summary has none for them.
#   APP_TESTS="16 20" names the app tests the apps step runs, in that order (all eight by default).
# It prints one section a step, and `harness.ts summary` at the end. One baseline (every staged set-up, no
# STAGED_EXTRA) serves A, B, C, D, the apps and W: a batch differs only in the moves the pin watch takes, which the
# harness's reset of the factory copy gives the scratch worker. X2, X4 and 21 each build a baseline of their own. A
# batch's PIN_WATCH_ONLY and STAGED_EXTRA are written to the state folder's batch.env (copies.sh), never to a tracked
# file. The app's tests run with the factory copy at rest: at its baseline, the pin watch taking no move (at_rest).
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

# What broke: one step's failure does not stop the next, but each is said at once and again after the summary, and the
# pass then exits 1. A verdict of FAIL is the summary's, not a break.
broken=()
broke() { broken+=("$*"); echo "BROKE: $*"; }
# The autonomy level, written to the scratch store; `show` prints the row it wrote.
level() { # <level> [show]
  local out
  out=$(cd "$H" && ./level.sh "$1") || { broke "level $1"; return 1; }
  if [ -n "${2:-}" ]; then grep '|' <<<"$out"; fi
}
# A harness run, its last lines shown: pipefail keeps harness.ts's own status past `tail` and `cut`.
harness() { # <lines> <args…>
  local lines=$1; shift
  (cd "$H" && set -o pipefail && mise exec -- node harness.ts "$@" 2>&1 | tail -"$lines" | cut -c1-700) ||
    broke "harness.ts $*"
}

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
# The scratch line, stopped or running, written to the scratch store (stop.sh). Batch D stops it; it is put back
# running, with new work off, on any exit, as a stopped line queues no move in whatever runs next.
line() { # stopped|running
  local out
  out=$(cd "$H" && ./stop.sh "$1") || { broke "the line is not $1"; return 1; }
  echo "the line: $out"
}
line_stopped=
on_exit() {
  red_off
  if [ -n "$line_stopped" ]; then (cd "$H" && ./stop.sh running >/dev/null) || echo "BROKE: the scratch line may still be stopped: ./stop.sh running"; fi
}
trap on_exit EXIT
# A signal ends the pass through the same exit, so a line D stopped is started again.
trap 'exit 130' INT
trap 'exit 143' TERM HUP

# A batch: the moves the scratch pin watch takes, in batch.env. No baseline is built for it: the harness's own reset of
# the factory copy writes them where the worker reads them as it starts (copies.sh's pin_watch).
batch() { # <tests>
  # Written by the harness, which reads the line back as copies.sh will before it says so.
  (cd "$H" && mise exec -- node harness.ts batch "$1") || { broke "batch $1"; return 1; }
}
# A baseline's STAGED_EXTRA in batch.env: the folder named, or with no name, none. Written whole, as a filter that
# reads no line of an empty file appends none to it.
extra() { # [<name>]
  { grep -v '^STAGED_EXTRA=' "$BATCH" || true; if [ -n "${1:-}" ]; then echo "STAGED_EXTRA=$1"; fi; } >"$BATCH.new" &&
    mv "$BATCH.new" "$BATCH"
}
# A baseline, with batch.env's STAGED_EXTRA: built, checked, reset and pinned, then root Synced and Healthy.
baseline() { # <log>
  echo "real repo queued: $(gh run list -R the-roganator/cv-software-factory --status queued -L 100 --json databaseId -q length)"
  # SKIP_CHECK=1 leaves out `make check` in the copies, for a baseline one of the copy's own tests fails by design (X4).
  for step in build check reset pin-images; do
    [ -n "${SKIP_CHECK:-}" ] && [ "$step" = check ] && { echo "== check skipped $(date -u +%H:%MZ)"; continue; }
    echo "== $step $(date -u +%H:%MZ)"
    (cd "$H" && ./copies.sh "$step") >>"$1" 2>&1 || {
      echo "FAILED at $step"
      grep -n "FAIL \|AssertionError\|copies.sh:\|error:" "$1" | tail -8 | cut -c1-300
      broke "baseline: $step (see $1)"
      return 1
    }
  done
  # On the commit pin-images pushed, so a look before Argo CD has seen that push is not taken for it.
  await_root baseline "$(cat "$STATE/work/factory.sha")"
}
# Root Synced and Healthy, waited for up to 30 minutes; with a commit named, on that commit, so a look that comes
# before Argo CD has seen a push is not taken for the push's.
# The app's release of its baseline goes through the full canary, which no test judges, and one that takes the app
# back past an ordinary fix (a work item run between campaigns) is rightly aborted: the baseline is the tests'
# starting point, so while it is in flight or aborted it is promoted whole (a full promotion asked twice is one),
# and root is waited for until Synced and Healthy, the Rollout with it.
await_root() { # <what waits for it> [<the factory copy's commit root must be on>]
  local state app_main synced phase on
  app_main=$(gh api "repos/$APP_COPY/commits/main" -q .sha)
  for _ in $(seq 1 90); do
    state=$(k -n argocd get app root -o jsonpath='{.status.sync.status} {.status.health.status}')
    on=$(k -n argocd get app root -o jsonpath='{.status.sync.revision}')
    [ "$state" = "Synced Healthy" ] && { [ -z "${2:-}" ] || [ "$on" = "$2" ]; } && break
    [ "$state" = "Synced Healthy" ] && state="Synced Healthy at ${on:0:7}, not ${2:0:7}"
    # Argo CD looks at the copies' main every few minutes: asked to look now, it takes the baseline just pushed at
    # once. A refresh reads git and each resource's health again and changes nothing in the cluster.
    k -n argocd annotate application root website argocd.argoproj.io/refresh=normal --overwrite >/dev/null 2>&1 || true
    synced=$(k -n argocd get app website -o jsonpath='{.status.sync.revision}')
    phase=$(k -n website get rollout website -o jsonpath='{.status.phase}')
    if [ "$synced" = "$app_main" ] && [ -n "$phase" ] && [ "$phase" != Healthy ]; then
      kubectl argo rollouts --context k3d-software-factory-scratch -n website promote --full website >/dev/null
    fi
    sleep 20
  done
  echo "root: $state $(date -u +%H:%MZ)"
  if [ "$state" != "Synced Healthy" ]; then
    broke "$1: root is $state after 30 minutes, not Synced Healthy"
    return 1
  fi
}
# The factory copy at rest, for the app's tests: the pin watch told no move, the copy back at its baseline with
# everything of the App's closed, and root Synced and Healthy on it. An app's test is judged clean on one look at every
# pod, so nothing of the factory copy's may merge and roll the factory under it; the harness refuses an app run
# otherwise. Nothing is done when the copy already rests (`harness.ts rests`), but the pin watch is told no move, which
# each app run's own restart of the worker gives it.
at_rest() { # <log>
  batch none || return 1
  if (cd "$H" && mise exec -- node harness.ts rests); then return 0; fi
  echo "== the factory copy back to its baseline, the pin watch taking no move $(date -u +%H:%MZ)"
  (cd "$H" && ./copies.sh reset factory) >>"$1" 2>&1 || { broke "the factory copy's reset (see $1)"; return 1; }
  await_root "the factory copy at rest" "$(gh api "repos/$R/commits/main" -q .sha)"
}
campaign() { harness 22 factory "$@" --limit "${LIMIT:-60}"; }
# What the watches said of their branches after the run's own restart of the worker.
watches() {
  echo "--- the watches after the run's restart:"
  k -n factory logs deploy/github --since=90m |
    grep -o '"msg":"[^"]*deploy branch[^"]*"\|"msg":"made the deploy pull request again[^"]*"\|"msg":"[^"]*pin branch[^"]*"' | sort | uniq -c
}
# A failed cluster's reason, which a dead runner still delivers as a step's name.
why() {
  echo "--- platform steps named Why:"
  for id in $(gh api "repos/$R/actions/workflows/platform.yml/runs?per_page=60" -q '.workflow_runs[]|select(.conclusion!="success")|.id'); do
    gh api "repos/$R/actions/runs/$id/jobs" -q '.jobs[].steps[]?|select((.name|startswith("Why:")) and (.name|length>6))|.name'
  done | head -5
}

# One baseline for every step but X and X4: every staged set-up, no STAGED_EXTRA. A batch differs from another only in
# the moves the pin watch takes (batch). KEEP_BASELINE=1 runs on the baseline as built. A step whose baseline failed
# runs nothing.
based=yes
if want A || want B || want C || want D || want apps || want W; then
  if [ -z "${KEEP_BASELINE:-}" ]; then
    echo "##### the baseline $(date -u +%H:%MZ)"
    extra
    baseline "$LOGS/confirm-baseline.log" || based=
  fi
fi

if want A && [ -n "$based" ]; then
# With them the Makefile's pin (17), the workflow's pin that stays an issue (N6) and its forgery (N7). Test 19, the image no registry serves, is on the baseline, so every factory batch's scan has it and
# each batch judges it.
# Beside test 1, at no time of its own: Dependabot's pull request for Postgres, which the run summons Dependabot for
# and the worker closes once 1's move has merged (22); and the first scan after the reset, which must not list
# Postgres's fix, first seen that day (28). Beside the batch's moves, k3d's, 14b's in B, with Martin's review asking
# for changes on it (25). After the batch's own verdicts, k3s's move, 14a's, put back on main and scanned again (27),
# a scan test 2's major is read from too.
echo "##### A: 1,2,3,5,14a,17,N6,19,22,25,27,28 and the forgeries, Guarded $(date -u +%H:%MZ)"
level guarded
batch 1,2,3,5,14a,17,N6,25 && campaign --only 1,2,3,5,14a,17,N6,19,22,25,27,28,N3a,N3b,N4,N5,N7,N9,N10
watches
why
fi

if want B && [ -n "$based" ]; then
# The lockfile's routine updates are here beside its findings' moves: 15 merges and deploys with the day's others, and
# 18, the one across a major, is held beside 4a and 4b.
# Beside them, at no time of its own: the routine update pnpm refuses, an issue beside 15's pull request (23).
echo "##### B: 4a,4b,6,7a,7b,9,14b,15,18,19,23, Guarded $(date -u +%H:%MZ)"
batch 4a,4b,6,7a,7b,9,14b,15,18,23 && campaign --only 4a,4b,6,7a,7b,9,14b,15,18,19,23 --no-forge
watches
why
fi

if want C && [ -n "$based" ]; then
# At Lights-out the majors merge, 18 among them; a workflow's pin is still an issue (N6) and its forgery still held (N7).
echo "##### C: 4a,4b,18 at Lights-out, with N6, N7 and 19 $(date -u +%H:%MZ)"
batch 2,4a,4b,18,N6 && {
  level lights-out show && campaign --only 2,4a,4b,18,N6,N7,19 --lights-out
}
fi

if want D && [ -n "$based" ]; then
# Three phases on one reset. First Supervised with the line stopped: the deploy pin merges, as neither governs it, and
# every move waits. Then Guarded, the line still stopped (26): the stop alone holds prometheus's move,
# which Guarded would queue. Then Supervised with the line running: the level alone holds them.
echo "##### D: Supervised and the line stopped, no move queued $(date -u +%H:%MZ)"
# The stop first, and nothing of D without it: on a line still running Guarded queues the batch's moves, and 26 would
# read FAIL with a move merged for a fault of the set-up. on_exit puts the line back whatever it came to.
line_stopped=yes
if ! line stopped; then
  echo "D: pre-flight, no verdict: the scratch line could not be stopped (./stop.sh stopped says why); no phase was run"
else
level supervised show
since=$(date -u +%Y-%m-%dT%H:%M:%SZ)
# C's moves, on the shared baseline; a build that failed part way leaves `work/` dirty and the reset refuses.
batch 2,4a,4b
# The worker stays stopped from the reset until that base has merged: started on the pushed baseline it opens the deploy
# pull request at once, red, runs its checks again three times and is out of runs before the base is there.
(cd "$H" && KEEP_WORKER_DOWN=1 ./copies.sh reset factory) >"$LOGS/confirm-d.log" 2>&1 || broke "D: the reset (see $LOGS/confirm-d.log); what follows is no verdict"
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
  # The reset's own scan first, which has no state and lists no chart whose content it first saw today: the scan of
  # this merge's push must find the state that one left, so it lists D's moves (staged/factory/28-…).
  for _ in $(seq 1 60); do
    [ "$(gh api "repos/$R/actions/workflows/vulnerabilities.yml/runs?branch=main&per_page=20" \
      -q '[.workflow_runs[] | select(.status != "completed")] | length')" = 0 ] && break
    sleep 20
  done
  gh pr merge "$n" -R "$R" --squash --auto >/dev/null || return 1
  for _ in $(seq 1 60); do
    [ "$(gh pr view "$n" -R "$R" --json state -q .state)" = MERGED ] && { echo "queued base: #$n merged $(date -u +%H:%MZ)"; return 0; }
    # The ruleset wants every review thread resolved; Copilot's on this harness commit are resolved unread.
    gh api graphql -F n="$n" -f owner="${R%%/*}" -f name="${R#*/}" -f query='query($n: Int!, $owner: String!, $name: String!) { repository(owner: $owner, name: $name) {
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
queued_base || broke "D: the queued base; the deploy pin's verdict below is no verdict"
(cd "$H" && ./copies.sh worker 1) || broke "D: the worker's start"
k -n factory rollout restart deploy/patching >/dev/null
since=$(date -u +%Y-%m-%dT%H:%M:%SZ)
# Whether every move's pull request the App opened since waits as <want> says (stopped, supervised or either), unqueued,
# its checks in, by the worker's last word at its head (`harness.ts waits`, decide.ts's `waitsReading`). The worker says
# that word only after the gate's verdict, the checks and mergeability are through, the last step before it would queue
# (deploy-queue.ts's queueOne), so it is the pass where the stop or the level is asked; its earlier words at that head
# (`verdict`, `checks`, `conflict`) decide nothing.
# The worker says a wait once a head, so a word may be older than the level or the stop a phase sets: a phase that
# restarted the worker after its change sets `said_since` to that restart, and only the words from then count.
said_since=
moves_wait() { # <want>
  (cd "$H" && mise exec -- node harness.ts waits "$since" "$1" ${said_since:+"$said_since"}) 2>&1 | cut -c1-300
  return "${PIPESTATUS[0]}"
}
# Done once the deploy pin's pull request has merged and every move waits for the stop or the level, both in force. A
# move the gate held never gets that word, and D then watches to 35 minutes, whatever stands then.
d_settled() {
  local merged
  merged=$(gh pr list -R "$R" --state merged -L 20 --json title,createdAt \
    -q "[.[]|select(.createdAt>\"$since\")|select(.title|startswith(\"chore(deploy): \"))]|length")
  [ "${merged:-0}" -gt 0 ] || return 1
  moves_wait either >/dev/null
}
# A phase after the first: watched until every move waits as <want> says, <minutes> at most, and then, for <hold>
# seconds more, that none was queued meanwhile. One line: PASS or FAIL, and what the worker said; or NO VERDICT, where
# the only pull request that does not wait so is one whose target moved during the run (`harness.ts waits` exits 3).
phase() { # <label> <want> <minutes> <hold seconds>
  local until said mark=PASS
  until=$(($(date +%s) + $3 * 60))
  while ! moves_wait "$2" >/dev/null && [ "$(date +%s)" -lt "$until" ]; do sleep 20; done
  sleep "$4"
  said=$(moves_wait "$2") || { [ $? -eq 3 ] && mark="NO VERDICT" || mark=FAIL; }
  echo "$1: $mark, $(tail -1 <<<"$said")"
  sed '$d' <<<"$said" | sed 's/^/  /'
}
until_d=$(($(date +%s) + 2100))
while [ "$(date +%s)" -lt "$until_d" ]; do
  d_settled && { echo "settled $(date -u +%H:%MZ)"; break; }
  sleep 20
done
deploy=$(gh pr list -R "$R" --state all -L 20 --json number,title,mergedAt,createdAt \
  -q "[.[]|select(.createdAt>\"$since\")|select(.title|startswith(\"chore(deploy): \"))][0]|\"#\(.number) merged=\(.mergedAt)\"")
case "$deploy" in
  *merged=null|"") echo "deploy pin: FAIL, not merged at Supervised with the line stopped (${deploy:-no deploy pull request})" ;;
  *) echo "deploy pin: PASS, merged at Supervised with the line stopped: $deploy" ;;
esac
phase "no move queued, Supervised and stopped" either 0 0
# 26: Guarded, and the line still stopped. The worker's word that a move waits for the stop was
# said at Supervised, once a head, and it says nothing new when the level alone changes: so the worker is restarted
# once the level is Guarded, and 26 stands on what the new one says of each head, having read the level as Guarded,
# and then on five minutes more in which each of its passes would queue prometheus's move were the line running. A
# worker that starts takes each head as its own where `main` has not moved under it, and writes it again where it has,
# which is a round of checks: so the wait for its words is thirty minutes at most, and ends when they are in.
level guarded show
said_since=$(date -u +%Y-%m-%dT%H:%M:%SZ)
k -n factory rollout restart deploy/github >/dev/null && k -n factory rollout status deploy/github --timeout=300s >/dev/null ||
  broke "D: the worker's restart at Guarded; 26 below is no verdict"
phase "26 a stopped line queues no move, Guarded" stopped 30 300
# Supervised, and then the line running: the worker says of each move that it waits for the level, in new words.
said_since=
level supervised show
if line running; then
  phase "no move queued, Supervised and running" supervised 6 0
else
  echo "no move queued, Supervised and running: pre-flight, no verdict: the scratch line could not be started"
fi
gh pr list -R "$R" --state all -L 12 --json number,title,state,createdAt,mergedAt \
  -q ".[]|select(.createdAt>\"$since\")|\"#\(.number) \(.state) merged=\(.mergedAt) \(.title)\""
echo "queue: $(gh api graphql -f owner="${R%%/*}" -f name="${R#*/}" -f query='query($owner: String!, $name: String!) {repository(owner:$owner,name:$name){mergeQueue(branch:"main"){entries(first:20){nodes{pullRequest{number}}}}}}' -q '.data.repository.mergeQueue.entries.nodes|map(.pullRequest.number)|join(",")')"
k -n factory logs deploy/github --since-time="$since" | grep -o '"why":"[^"]*"' | sort | uniq -c | sort -rn | head -6
# D's move pull requests are still open, waiting for the level: at Guarded the worker would queue them all, and their
# builds' deploy pin would roll the factory under the app's tests. So the copy rests before the level goes back.
at_rest "$LOGS/confirm-d.log"
level guarded show
fi
line running && line_stopped=
fi

# The app's forgeries, X1a and X1b, ride beside test 13's scan, judged by the gate alone; the line works 13's ticket.
# N8a rides beside test 20, Dependabot's pull request, which the line has no part in. 24, the move nobody can make, is
# an issue of the worker's from the same scan, read beside 8a.
if want apps && [ -n "$based" ] && at_rest "$LOGS/confirm-apps.log"; then
for test in ${APP_TESTS:-8a 10 11 12 13 16 20 N1}; do  # APP_TESTS='16 20' runs some of them
  echo "##### app $test $(date -u +%H:%MZ)"
  with=(); [ "$test" = 13 ] && with=(--with X1a,X1b)
  [ "$test" = 8a ] && with=(--with 24)
  [ "$test" = 20 ] && with=(--with N8a)
  harness 12 app "$test" ${with[@]+"${with[@]}"} --limit "${LIMIT:-60}"
done
fi

# The recovery tests, W1 to W5, on the shared baseline, whose staged `15-…` patches have the check they turn red: the
# app's five with the factory copy at rest (W5, the store restarted under a report, resets nothing and scans nothing),
# then W1's campaign (prometheus and the otel-collector alone), which resets the factory copy itself. Guarded.
if want W && [ -n "$based" ]; then
echo "##### W: W1 to W5 $(date -u +%H:%MZ)"
level guarded
if at_rest "$LOGS/confirm-w.log"; then
for test in ${W_APPS:-W5 W2 W3 W3b W4}; do  # W_APPS='W2 W4' W1=no runs some of them again
  echo "##### app $test $(date -u +%H:%MZ)"
  red_on "$test"
  harness 12 app "$test" --limit "${LIMIT:-60}"
  red_off
done
fi
if [ "${W1:-yes}" != no ] && batch W1a,W1b; then
echo "##### W1: a check red on purpose on two pin moves, Guarded $(date -u +%H:%MZ)"
red_on W1a,W1b
# W1b is watched to 100 minutes whatever the limit (its watchMin): three runs of a chart's checks, then nothing.
campaign --only W1a,W1b --no-forge
red_off
watches
why
fi
fi

# The security test X2; X1 rides beside test 13 in the apps step, X3 cannot be staged, and X4 is a step of its own
# (below). Not in the default STEPS: STEPS=X ./confirm.sh <dir>. Guarded.
if want X; then
level guarded
# X2: a baseline of its own, with staged/factory-x2/ (copies.sh's STAGED_EXTRA, in batch.env), the day's lockfile
# moves and ejs's major. The line is taken out of batch.env after, and the next baseline is built without it (the
# harness refuses any other test on this one).
if [ "${X2:-yes}" != no ]; then
  echo "##### X2: a major that clears a Trivy Critical, Guarded $(date -u +%H:%MZ)"
  extra x2
  batch X2 && baseline "$LOGS/confirm-x2.log" && campaign --only X2 --no-forge
  extra
  watches
fi
fi
# X4: a baseline of its own, with staged/app-x4/ (mise at the scan's target Node, the Dockerfile behind). The app's own
# test/node-pins.test.ts fails on that baseline by design, so its `make check` is skipped; the move's pull request mends
# it. The line is taken out of batch.env after: the next baseline is built without it.
if want X4; then
echo "##### X4: a half-made Node move, finished by the line $(date -u +%H:%MZ)"
level guarded
extra x4
batch none && SKIP_CHECK=1 baseline "$LOGS/confirm-x4.log" &&
  harness 12 app X4 --limit "${LIMIT:-60}"
extra
fi
# 21: a baseline of its own, with staged/app-21/ (a package pinned exactly, behind two fixes) and staged/factory-21/
# (the factory's exception, for the app, of the advisory only the later release fixes). The harness lifts the exception
# once the line's pull request is open, and scans the app again. The line is taken out of batch.env after.
if want 21; then
echo "##### 21: a move whose target moves on after its pull request opened $(date -u +%H:%MZ)"
level guarded
extra 21
batch none && baseline "$LOGS/confirm-21.log" &&
  harness 14 app 21 --limit "${LIMIT:-60}"
extra
fi
echo "##### summary $(date -u +%H:%MZ)"
(cd "$H" && set -o pipefail && mise exec -- node harness.ts summary | cut -c1-170) || broke "the summary"
if [ ${#broken[@]} -gt 0 ]; then
  echo "##### broke, so no pass:"
  printf '  %s\n' "${broken[@]}"
  exit 1
fi
