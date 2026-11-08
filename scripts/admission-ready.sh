#!/usr/bin/env bash
# Whether admission control can enforce without stopping anything: `make admission-ready` (#173).
#
# Lists every image the guarded namespaces run or will start (their pods; the templates of their Deployments,
# StatefulSets, DaemonSets, Jobs and CronJobs; image volumes; the runner image the line is pinned to; and, for
# `website`, the Jobs of the canary's ClusterAnalysisTemplates, which Argo Rollouts starts there), and checks
# each as the image policies do (deploy/base/admission): by digest; named in the namespace's policy, or ours on GHCR,
# from a repository that policy admits, signed by `build.yml` on `main` of the repository that builds it. Then it asks
# Kyverno: any pod a policy that only audits reports as failing is listed too (one that enforces refuses instead, and
# the images it guards are checked above). Then it says, for each policy, whether it enforces or audits and whether
# every image its namespaces need would be admitted, signed, or named by digest in the policy: a copy switched to Audit
# (the `try-the-line` skill) goes back to Deny only once they would. Exits non-zero if anything would be refused.
#
# cosign is the same check the deploy pull requests make, but not Kyverno's own code, so an image cosign passes could
# still be one Kyverno refuses; Kyverno's reports cover the pods it has seen made since it was installed.
set -euo pipefail

context="${KUBE_CONTEXT:-k3d-software-factory}"
kubectl=(kubectl --context "$context")
command -v cosign >/dev/null || { echo "cosign isn't installed: run 'mise install'."; exit 1; }

issuer=https://token.actions.githubusercontent.com
identity() { echo "https://github.com/the-roganator/$1/.github/workflows/build.yml@refs/heads/main"; }

# The strings a policy's variable lists: `allowed`, the images it admits from another registry, and
# `factoryRepositories` and `websiteRepositories`, the repositories of ours it admits.
# A policy without the variable is older than this script: Argo CD has not synced it yet.
listed() { # policy variable
  local expression
  expression=$("${kubectl[@]}" get imagevalidatingpolicy "$1" -o json |
    jq -er --arg name "$2" '.spec.variables[] | select(.name == $name) | .expression') ||
    { echo "$1 has no variable $2: is it synced?" >&2; return 1; }
  { grep -o "'[^']*'" || true; } <<<"$expression" | tr -d "'"
}

# The pod specs a list of objects names: pods' own, and their templates'.
specs() {
  jq '.items[] | (.spec.jobTemplate.spec.template.spec // .spec.template.spec // .spec)'
}

# The pod specs of the Jobs the canary's analysis starts in `website`: cluster-scoped, so not in the namespace's own
# list. None until Argo Rollouts is installed.
analysis_jobs() {
  local kinds
  kinds=$("${kubectl[@]}" api-resources --api-group=argoproj.io -o name) || return 1
  grep -qxF clusteranalysistemplates.argoproj.io <<<"$kinds" || return 0
  "${kubectl[@]}" get clusteranalysistemplates -o json |
    jq '.items[].spec.metrics[] | .provider.job.spec.template.spec | select(. != null)'
}

# Every image a namespace names: running, in a template, in an image volume, or the line's RUNNER_IMAGE.
images() {
  local objects analysis=""
  # Each read on its own, so a cluster that cannot answer fails the script rather than checking nothing.
  objects=$("${kubectl[@]}" -n "$1" get pods,deployments,statefulsets,daemonsets,jobs,cronjobs -o json) || return 1
  if [ "$1" = website ]; then analysis=$(analysis_jobs) || return 1; fi
  { specs <<<"$objects"; echo "$analysis"; } | jq -r '
    (((.containers // []) + (.initContainers // []) + (.ephemeralContainers // []))[] |
      .image, (.env // [] | .[] | select(.name == "RUNNER_IMAGE") | .value)),
    ((.volumes // [])[] | .image.reference) | select(. != null)' | sort -u
}

failed=0
check() { # namespace policy allowed factory-repositories website-repositories image
  local ns=$1 policy=$2 allowed=$3 factory=$4 website=$5 image=$6 repository repo="" error
  if [[ ! "$image" =~ ^[^@]+@sha256:[0-9a-f]{64}$ ]]; then
    echo "  refused  $ns  $image: not by digest"; failed=1; return
  fi
  if grep -qxF "$image" <<<"$allowed"; then
    echo "  allowed  $ns  $image: named in $policy"; return
  fi
  # The repository, without the digest or a tag.
  repository=${image%%@*}
  [[ "$repository" =~ ^(.*/[^/:]+):[^/]+$ ]] && repository=${BASH_REMATCH[1]}
  if grep -qxF "$repository" <<<"$factory"; then repo=cv-software-factory
  elif grep -qxF "$repository" <<<"$website"; then repo=cv-worlds-worst-website
  else
    case "$repository" in
      ghcr.io/the-roganator/cv-software-factory/* | ghcr.io/the-roganator/cv-worlds-worst-website)
        echo "  refused  $ns  $image: ours, but not one $policy admits"; failed=1; return ;;
      *) echo "  refused  $ns  $image: from another registry"; failed=1; return ;;
    esac
  fi
  local trust=(--certificate-identity "$(identity "$repo")" --certificate-oidc-issuer "$issuer")
  if ! error=$(cosign verify "${trust[@]}" "$image" 2>&1 >/dev/null); then
    echo "  refused  $ns  $image: not signed by build.yml on main of $repo ($(tail -1 <<<"$error"))"; failed=1; return
  fi
  echo "  signed   $ns  $image"
}

notready="" # the policies with an image refused in their namespaces
refusing() { if [[ " $notready " != *" $1 "* ]]; then notready="$notready $1"; fi; }
for pair in factory:factory-images runners:factory-images red-team:factory-images website:website-images \
  scoreboard:scoreboard-images flagd:flagd-images; do
  ns=${pair%%:*} policy=${pair#*:} before=$failed failed=0
  # Read first, so a cluster that cannot answer fails the script rather than checking nothing.
  allowed=$(listed "$policy" allowed)
  factory=$(listed "$policy" factoryRepositories)
  website=$(listed "$policy" websiteRepositories)
  list=$(images "$ns")
  for image in $list; do check "$ns" "$policy" "$allowed" "$factory" "$website" "$image"; done
  if [ "$failed" = 1 ]; then refusing "$policy"; fi
  if [ "$before" = 1 ]; then failed=1; fi
done

# Each policy's mode, read on its own, so a cluster that cannot answer fails the script rather than skipping reports.
factory_actions=$("${kubectl[@]}" get imagevalidatingpolicy factory-images -o jsonpath='{.spec.validationActions}')
website_actions=$("${kubectl[@]}" get imagevalidatingpolicy website-images -o jsonpath='{.spec.validationActions}')
scoreboard_actions=$("${kubectl[@]}" get imagevalidatingpolicy scoreboard-images -o jsonpath='{.spec.validationActions}')
flagd_actions=$("${kubectl[@]}" get imagevalidatingpolicy flagd-images -o jsonpath='{.spec.validationActions}')
mode() {
  local actions
  case "$1" in
    website-images) actions=$website_actions ;;
    scoreboard-images) actions=$scoreboard_actions ;;
    flagd-images) actions=$flagd_actions ;;
    *) actions=$factory_actions ;;
  esac
  [[ "$actions" == *Audit* ]] && echo audits || echo enforces
}
auditing=""
for policy in factory-images website-images scoreboard-images flagd-images; do
  if [ "$(mode "$policy")" = audits ]; then auditing="$auditing$policy"$'\n'; fi
done
reports=$("${kubectl[@]}" get policyreports -A -o json | jq -r --arg auditing "$auditing" '
  ($auditing | split("\n")) as $audits |
  .items[] | select(.metadata.namespace | IN("factory", "runners", "red-team", "website", "scoreboard", "flagd")) | . as $report | .results[]? |
  select((.result == "fail" or .result == "error") and (.policy | IN($audits[]))) |
  "  refused  \($report.metadata.namespace)  pod \($report.scope.name): \(.policy): \(.message)"')
if [ -n "$reports" ]; then
  echo "Kyverno reports:"; echo "$reports"; failed=1
  for policy in $auditing; do
    if grep -qF ": $policy: " <<<"$reports"; then refusing "$policy"; fi
  done
fi

for policy in factory-images website-images scoreboard-images flagd-images; do
  mode=$(mode "$policy")
  if [[ " $notready " == *" $policy "* && "$mode" = audits ]]; then
    echo "$policy audits: not ready, the images above would be refused once it enforces again."
  elif [[ " $notready " == *" $policy "* ]]; then
    echo "$policy enforces: the images above are refused: pin signed ones in their place."
  elif [ "$mode" = audits ]; then
    echo "$policy audits: ready, every image its namespaces need would be admitted once it enforces again."
  else
    echo "$policy enforces: every image its namespaces need is admitted."
  fi
done
exit "$failed"
