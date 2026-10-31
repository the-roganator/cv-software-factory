#!/usr/bin/env bash
# Asks the cluster to make, in `website`, the Traefik routes, splits and Middlewares the app's repository might send to
# put back the mark, `x-unmeasured`, that its route removes, and keeps the answers of the `website-mark` admission
# policy (deploy/base/admission/website/mark.yaml) in deploy/test/mark-refusals.json, with the cluster's Traefik
# settings that keep a reference from crossing namespaces. apps/factory/test/mark-fences.test.ts holds each case to what
# it must get. Run it with the policy, and the app's route and Middleware, on the cluster as `main` has them, whenever
# the policy, the app's route or the cluster's k3s changes.
#
# Each request is a server-side dry run: it passes through admission exactly as a real one does, and nothing is made
# or changed. A refusal must be this policy's; any other answer that is not a success (no connection, another policy's
# refusal, a change the schema refuses) stops the script, so the record holds only this policy's own answers. Each
# route names the app's host, so that the `website-routes` policy (routes.yaml) admits it.
#
#   IngressRoutes
#   route-app            the app's route as its repository has it: `visitors` alone              admitted
#   route-namespaced     `visitors`, its namespace named, `website`                               admitted
#   route-bare           no middleware                                                            refused
#   route-second         `visitors`, then another                                                 refused
#   route-other          another Middleware in its place                                          refused
#   route-elsewhere      `visitors` in another namespace                                          refused
#   route-provider       a Middleware by provider, `website-visitors@kubernetescrd`               refused
#   route-service-mw     a middleware on the route's service                                      refused
#   route-internal       Traefik's own API, `api@internal`, as the route's service                refused
#   route-service-ns     a Service in another namespace                                           refused
#   route-dropped        the app's route changed to drop `visitors`                               refused
#   TraefikServices
#   split-app            the canary's weighted split as the app's repository has it               admitted
#   split-mw             a middleware on one of its services                                      refused
#   split-internal       `api@internal` as one of its services                                    refused
#   split-mirror         a mirroring service                                                      refused
#   Middlewares
#   strip                `visitors` as the app's repository has it                                admitted
#   set                  `headers` setting `x-unmeasured`                                         refused
#   set-cased            `headers` setting `X-Unmeasured`                                         refused
#   strip-and-set        removing `x-unmeasured` and setting `X-Unmeasured`                       refused
#   other-header         `headers` setting another request header                                 refused
#   strip-and-response   the strip, with a response header beside it                              refused
#   chain                a chain of others                                                        refused
#   plugin               a plugin                                                                 refused
#   forward-auth         `forwardAuth` copying `X-Unmeasured` from the auth server's answer       refused
#   forward-auth-regex   `forwardAuth` copying every header that matches `.*`                     refused
#   basic-auth           `basicAuth` writing the user to `x-unmeasured`                           refused
#   strip-changed        `visitors` changed to set `x-unmeasured`                                 refused
#
# Then each IngressRoute, TraefikService and Middleware already in `website`, sent back unchanged as an update, which
# the policy must admit: it holds what is made and changed, so this shows that what was there before it holds too.
#
# The record keeps the hash of the policy it was taken against (scripts/policy-hash.ts), which stops the script first
# unless the cluster runs it as deploy/ renders it here, and which apps/factory/test/refusal-records.test.ts holds to
# deploy/, so a change to it fails `make check` until this is run again.
set -euo pipefail

context="${KUBE_CONTEXT:-k3d-software-factory}"
kubectl=(kubectl --context "$context")
# REFUSALS_OUT writes the record elsewhere, as `make guardrails` takes it, and leaves deploy/test/ as it is.
out="${REFUSALS_OUT:-$(dirname "$0")/../deploy/test/mark-refusals.json}"
policy="Policy website-mark failed"
# The policies as the cluster runs them, or nothing asked (scripts/policy-hash.ts).
taken=$(node "$(dirname "$0")/policy-hash.ts" mark-refusals)

try() { # case command...: one JSON line, admitted on success, refused only by the policy
  local kind=$1 answer outcome
  shift
  if answer=$("$@" 2>&1); then outcome=admitted
  elif [[ $answer == *"$policy"* ]]; then outcome=refused
  else
    echo "$kind: neither admitted nor refused by the policy:" >&2
    echo "$answer" >&2
    exit 1
  fi
  jq -cn --arg kind "$kind" --arg outcome "$outcome" --arg answer "$answer" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{case: $kind, at: $at, outcome: $outcome,
      message: ($answer | sub("^Error from server[^:]*: (error when creating \"STDIN\": )?"; ""))}'
}

send() { # kind spec: a server-side dry run of a new resource of that kind in website, named mark-refusal
  "${kubectl[@]}" -n website create --dry-run=server -o name -f - <<EOF
apiVersion: traefik.io/v1alpha1
kind: $1
metadata:
  name: mark-refusal
spec:
$2
EOF
}

route() { # middlewares service: an IngressRoute on the app's host, with these middlewares and this one service
  send IngressRoute "  entryPoints: [web]
  routes:
    - kind: Rule
      match: Host(\`website.localhost\`)
      middlewares: $1
      services:
        - $2"
}
app='kind: TraefikService
          name: website'

split() { # services: a weighted TraefikService sharing out these
  send TraefikService "  weighted:
    services: $1"
}

middleware() { # spec: a Middleware
  send Middleware "$1"
}

# Kept aside until every case has answered, so a script that stops leaves the record as it was.
answers=$(mktemp)
trap 'rm -f "$answers"' EXIT
{
  try route-app route '[{name: visitors}]' "$app"
  try route-namespaced route '[{name: visitors, namespace: website}]' "$app"
  try route-bare route '[]' "$app"
  try route-second route '[{name: visitors}, {name: mark-refusal}]' "$app"
  try route-other route '[{name: mark-refusal}]' "$app"
  try route-elsewhere route '[{name: visitors, namespace: factory}]' "$app"
  try route-provider route '[{name: website-visitors@kubernetescrd}]' "$app"
  try route-service-mw route '[{name: visitors}]' "$app
          middlewares: [{name: visitors}]"
  try route-internal route '[{name: visitors}]' 'kind: TraefikService
          name: api@internal'
  try route-service-ns route '[{name: visitors}]' 'name: console
          namespace: factory
          port: 80'
  try route-dropped "${kubectl[@]}" -n website patch ingressroute website --type json --dry-run=server -o name \
    -p '[{"op": "remove", "path": "/spec/routes/0/middlewares"}]'

  try split-app split '[{name: website, port: 80, weight: 100}, {name: website-canary, port: 80, weight: 0}]'
  try split-mw split '[{name: website, port: 80, weight: 100, middlewares: [{name: visitors}]}]'
  try split-internal split '[{name: website, port: 80, weight: 100}, {name: api@internal, kind: TraefikService, weight: 1}]'
  try split-mirror send TraefikService '  mirroring:
    name: website
    port: 80
    mirrors: [{name: website-canary, port: 80, percent: 100}]'

  try strip middleware '  headers:
    customRequestHeaders:
      x-unmeasured: ""'
  try set middleware '  headers:
    customRequestHeaders:
      x-unmeasured: "1"'
  try set-cased middleware '  headers:
    customRequestHeaders:
      X-Unmeasured: "1"'
  try strip-and-set middleware '  headers:
    customRequestHeaders:
      x-unmeasured: ""
      X-Unmeasured: "1"'
  try other-header middleware '  headers:
    customRequestHeaders:
      x-refusal: "1"'
  try strip-and-response middleware '  headers:
    customRequestHeaders:
      x-unmeasured: ""
    customResponseHeaders:
      x-refusal: "1"'
  try chain middleware '  chain:
    middlewares: [{name: visitors}]'
  try plugin middleware '  plugin:
    refusal:
      header: x-unmeasured'
  try forward-auth middleware '  forwardAuth:
    address: http://auth.website
    authResponseHeaders: [X-Unmeasured]'
  try forward-auth-regex middleware '  forwardAuth:
    address: http://auth.website
    authResponseHeadersRegex: ".*"'
  try basic-auth middleware '  basicAuth:
    secret: refusal
    headerField: x-unmeasured'
  try strip-changed "${kubectl[@]}" -n website patch middleware visitors --type merge --dry-run=server -o name \
    -p '{"spec": {"headers": {"customRequestHeaders": {"x-unmeasured": "1"}}}}'
} >"$answers"

live=$(mktemp)
trap 'rm -f "$answers" "$live"' EXIT
for kind in ingressroutes.traefik.io traefikservices.traefik.io middlewares.traefik.io; do
  for name in $("${kubectl[@]}" -n website get "$kind" -o name); do
    resource=$("${kubectl[@]}" -n website get "$name" -o json)
    try "$name" "${kubectl[@]}" -n website replace --dry-run=server -o name -f - <<<"$resource"
  done
done >"$live"

# What keeps Traefik from reading a reference across namespaces: its providers' settings, as k3s's bundled chart
# renders them, and nothing on the cluster that changes the chart's values.
traefik=$("${kubectl[@]}" -n kube-system get deployment traefik -o json |
  jq '.spec.template.spec.containers[] | select(.name == "traefik") |
    {image, providers: [.args[] | select(startswith("--providers."))], args, env: [.env[]?.name], envFrom: (.envFrom // [])}')
k3s=$("${kubectl[@]}" version -o json | jq -r .serverVersion.gitVersion)
configs=$("${kubectl[@]}" get helmchartconfigs.helm.cattle.io -A -o json | jq '[.items[].metadata | "\(.namespace)/\(.name)"]')

jq -n --argjson taken "$taken" --arg k3s "$k3s" --argjson traefik "$traefik" --argjson configs "$configs" \
  --slurpfile cases "$answers" --slurpfile live "$live" \
  '$taken + {k3s: $k3s, helmChartConfigs: $configs, traefik: $traefik, cases: $cases, live: $live}' >"$out"
# As `make check` would have it.
[ -n "${REFUSALS_OUT:-}" ] || pnpm exec biome format --write "$out" >/dev/null
jq -r '"k3s \(.k3s), Traefik \(.traefik.image)", (.traefik.providers[] | "  \(.)"),
  (.cases[], .live[] | "\(.outcome)  \(.case): \(.message)")' "$out"
