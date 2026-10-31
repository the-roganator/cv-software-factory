#!/usr/bin/env bash
# Proves the network policies in deploy/, and that no service account of ours may read the scoreboard's Secrets:
# `make egress`.
#
# Only the gateway (TypeSafe, Anthropic) and the GitHub worker (GitHub and GHCR) may reach the internet, over TLS, and
# only triage and runners' agent pods may reach the gateway. This starts a pod labelled like a worker, which is what a
# compromised one would be, and shows that it cannot reach TypeSafe, GitHub, the gateway, the GitHub worker, the app or
# a public address, while the gateway can reach TypeSafe and the GitHub worker can reach GitHub.
#
# Then the line, which reaches the Kubernetes API and the probes' verification, and not another address on the API's
# port, the node's other ports, the probes' page reader or the app.
#
# Then the readers of telemetry (triage, the intake, the log watcher and the line), which query Prometheus, Loki and
# Tempo through the read-only proxy in `telemetry` and cannot write through it: not metrics, not logs, not a reload of
# Prometheus or a flush of Tempo. They cannot reach the backends themselves, Tempo's intake, Grafana, or a stranger in
# `telemetry` listening on the backends' ports. And Prometheus, asked directly, will not reload: its lifecycle
# endpoints are off.
#
# Then the runners (ADR 0008): a pod made like an agent pod (its labels, no DNS, the line's two addresses in its hosts)
# reaches the gateway and the line's handback and nothing else: not GitHub, the Kubernetes API, the cloud metadata
# address, Postgres, the console, the admin service or the host, nor a name. A pod labelled like a prepare pod reaches GitHub and the npm
# registry, and none of the cluster.
#
# Then the release (milestone 6): the traffic generator reaches the app only through Traefik, its front door; a pod
# made like the canary's analysis Job reaches the app's stable and canary Services and nothing else; a pod labelled
# like the Argo Rollouts controller reaches the Kubernetes API and Prometheus and not the internet; and in Kyverno's
# namespace, a pod labelled like the admission controller reaches GHCR and Sigstore's trust root, while one without
# that label reaches neither.
#
# Then the app's own pods, whose code agents write: a pod labelled like them reaches DNS, the collector and flagd's sync
# port, and not flagd's other ports (its management port among them, where the kubelet's probes find it ready),
# Prometheus, Loki, Tempo, Postgres, the gateway, the Kubernetes API or the internet. The app is reached through
# Traefik and by the probes, the crawler, the admin service and the analysis, and not by another pod beside it, which
# neither of `website`'s policies selects and so reaches nothing at all, not even DNS; nor does a worker reach flagd.
# flagd's own fence is seen from outside alone: `flagd-images` admits flagd's image and nothing else, so no pod labelled
# like it can be started there.
#
# Then the pod log collector, which reads every pod's log from the node's files: a pod labelled like it reaches Loki's
# intake, and nothing else: not Prometheus, Tempo, the collector in `telemetry`, Postgres, the app, the Kubernetes API
# or the internet.
#
# Then the platform's metrics, which Prometheus's server scrapes across the fences: a pod labelled like it reaches
# Kyverno's two controllers on 8000, Argo Rollouts' controller on 8090, the Postgres exporter on 9187 and the pod log
# collector on 8888, and the stranger in `telemetry`, labelled otherwise, reaches none of them. And a pod labelled like
# the exporter reaches Postgres, and nothing else: not the collector, the gateway, the app, the Kubernetes API or the
# internet.
#
# Then Alertmanager (milestone 7), which sends Martin's pages: a pod labelled like it reaches the intake and the
# internet on 443, for Pushover, and nothing else: not Prometheus, Postgres, the gateway, the admin service, the
# Kubernetes API, the host, the metadata address or the internet on another port. Only Prometheus's server and Grafana
# reach it, as anything that did could silence a page: Prometheus's server does, and the stranger in `telemetry`, whose
# own egress is open, does not, so only Alertmanager's fence stops it. A worker cannot either, though its own fence
# would stop it first.
#
# Then the admin service (milestone 7), which believes forwarded headers from the pod network because only Traefik may
# reach it: a worker, an agent pod and the scoreboard cannot, nor the stranger in `telemetry`, whose own egress is
# open, so only the admin service's fence stops it; and it reaches Postgres, the collector and the Kubernetes API, for
# Martin's controls of the canary, and the app's pods on 8080, each at its own address, to ask which flags it holds, and
# not the gateway, the node's ingress or the internet. The stranger in `telemetry` does not reach the app's pods, so
# only the app's fence, which lets the admin service in, stops it.
#
# Then the scoreboard, which holds the answer key (milestone 6): it reaches Postgres, and nothing else: not the
# collector, the gateway, the GitHub worker, the console, the probes, Prometheus, Loki, the app, the Kubernetes API, the
# host, the metadata address or the internet. Nothing can reach it, as it serves nothing; its fence's ingress is
# checked in scoreboard-fences.test.ts. And no service account of ours, or of a chart but Argo Rollouts' controller,
# may read its Secrets or reach them through a pod: each is asked of the API server (`kubectl auth can-i --as`).
#
# A worker's own checks run from a probe pod made from its live Deployment, never inside the worker, whose memory a
# second Node beside its own could run out: the pod keeps what decides what it may reach (namespace, labels, DNS,
# hosts, image, security contexts), and only idles in place of the worker's code, which makes no call here. So the
# checks prove the worker's fences, and not that the worker's own code keeps to them.
#
# Every pod this starts runs an image the cluster already runs, pinned by digest, so nothing else is pulled and
# admission control lets it in: the probe pods their worker's own, the pod labelled like a worker the factory image the
# gateway runs, as does the pod labelled like the Postgres exporter, the runners' pods and the ones in Kyverno's, Argo
# Rollouts', the pod log collector's and telemetry's namespaces the runner image the line pins (Node is on its PATH),
# and the analysis Job's and the app's the `factory-browser` image the analysis pins. Each tries an address with Node's
# `fetch`, or, to name the app's host to Traefik, with `http.get`.
#
# A check that must be blocked passes only when the connection is refused, reset, unreachable or never answered, as a
# policy blocks it: any other failure, such as a name that does not resolve, proves nothing about the fence.
#
# A check whose `kubectl exec` fails is a FAIL naming the exit status, and the rest go on. The workers, the proxy and
# the metrics' targets are rolled out before anything starts, so a run during a rollout waits for it; one Argo CD has
# yet to sync is not waited for.
#
# The controls matter: if the gateway could not reach TypeSafe either, the pod's failure would prove only that the
# network was down.
#
#     scripts/egress.sh [record.json]
#
# Given a file, it also writes there a record of every check, for `make guardrails` to read: the hash of the fences
# and Roles it was taken against (scripts/policy-hash.ts, which stops it first unless the cluster runs them as deploy/
# renders them here), when, whether all held, and each check's group, what was tried, from where, what it wanted and
# what it got. The checks of the readers of telemetry, which show a reader can query and cannot write, are tagged
# `read-only-telemetry`, for the proof that nothing of ours writes to production but what may.
set -euo pipefail

context="${KUBE_CONTEXT:-k3d-software-factory}"
kubectl=(kubectl --context "$context" -n factory)
record=${1:-}
taken=null
if [ -n "$record" ]; then taken=$(node "$(dirname "$0")/policy-hash.ts" egress); fi
pod=egress-intruder

image=$("${kubectl[@]}" get deployment gateway -o jsonpath='{.spec.template.spec.containers[0].image}')
runner_image=$("${kubectl[@]}" get deployment line -o jsonpath='{.spec.template.spec.initContainers[0].image}')
browser_image=$(kubectl --context "$context" get clusteranalysistemplate website-step \
  -o jsonpath='{.spec.metrics[?(@.name=="journeys")].provider.job.spec.template.spec.containers[0].image}')
runners=(kubectl --context "$context" -n runners)

# The workers whose own checks run from a probe pod made from their Deployment (start_probe), as
# <namespace>/<deployment>.
workers=(factory/gateway factory/github factory/triage factory/intake factory/logs factory/line factory/traffic
  factory/probes factory/crawler factory/admin scoreboard/scoreboard)

# What Prometheus's server scrapes beyond `telemetry`, behind fences that let in its server alone.
scraped=(kyverno/kyverno-admission-controller kyverno/kyverno-reports-controller argo-rollouts/argo-rollouts
  factory/postgres-exporter)

# The workers, the read-only proxy the readers query, and what Prometheus scrapes, rolled out first: each probe pod is
# then made from the template its worker runs, and not one about to replace it, and every Service or pod a check
# reaches is there, as a worker replaced (by recreating it) has none for a moment. kubectl says why one that has not
# rolled out has not.
for deployment in "${workers[@]}" telemetry/query "${scraped[@]}"; do
  if ! kubectl --context "$context" -n "${deployment%%/*}" rollout status "deployment/${deployment#*/}" \
    --timeout=3m >/dev/null; then
    echo "$deployment has not rolled out: run this again when it has." >&2
    exit 1
  fi
done
# Alertmanager, whose fence the checks of who reaches it prove, is a StatefulSet.
if ! kubectl --context "$context" -n telemetry rollout status statefulset/prometheus-alertmanager --timeout=3m >/dev/null
then
  echo "telemetry/prometheus-alertmanager has not rolled out: run this again when it has." >&2
  exit 1
fi
# The pod log collector, which Prometheus scrapes too, is a DaemonSet.
if ! kubectl --context "$context" -n pod-logs rollout status daemonset/pod-logs-agent --timeout=3m >/dev/null; then
  echo "pod-logs/pod-logs-agent has not rolled out: run this again when it has." >&2
  exit 1
fi
cleanup() {
  rm -f "${exec_errors:-}" "${checks:-}"
  # Each delete goes on whether the one before failed, so no probe pod is left behind.
  "${kubectl[@]}" delete pod "$pod" egress-postgres-exporter --ignore-not-found --wait=false >/dev/null || true
  "${runners[@]}" delete pod egress-agent egress-prepare --ignore-not-found --wait=false >/dev/null || true
  kubectl --context "$context" -n website delete pod egress-journeys egress-app egress-stranger --ignore-not-found \
    --wait=false >/dev/null || true
  kubectl --context "$context" -n argo-rollouts delete pod egress-rollouts --ignore-not-found --wait=false >/dev/null || true
  kubectl --context "$context" -n pod-logs delete pod egress-pod-logs --ignore-not-found --wait=false >/dev/null || true
  kubectl --context "$context" -n kyverno delete pod egress-admission egress-kyverno --ignore-not-found --wait=false >/dev/null || true
  kubectl --context "$context" -n telemetry delete pod egress-stranger egress-prometheus egress-tempo egress-alertmanager \
    --ignore-not-found --wait=false >/dev/null || true
  for worker in "${workers[@]}"; do
    kubectl --context "$context" -n "${worker%%/*}" delete pod "egress-${worker#*/}" --ignore-not-found --wait=false \
      >/dev/null || true
  done
}
trap cleanup EXIT
# What a failed exec said, for its FAIL line.
exec_errors=$(mktemp)
# Each check as a JSON line, for the record.
checks=$(mktemp)

# What a pod runs to try an address: prints the HTTP status, or why it could not connect. A server's certificate is
# not checked: the Kubernetes API's is the cluster's own, and reaching it at all is what counts. Given a host as well,
# it names that host over plain HTTP, as a visitor's browser does to Traefik; `fetch` will not send a Host header. A
# tcp:// address is only connected to, for a server that does not speak HTTP, such as Postgres.
try='process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const blocks = ["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "UND_ERR_CONNECT_TIMEOUT", "TimeoutError"];
const names = ["ENOTFOUND", "EAI_AGAIN"];
// An address may start with a method, as "POST http://...": it is sent with an empty body.
const [target, host] = process.argv.slice(1);
const [method, url] = target.includes(" ") ? target.split(" ") : ["GET", target];
const tcp = url.startsWith("tcp://") && new URL(url);
const get = tcp
  ? new Promise((resolve, reject) => {
      const socket = require("node:net").connect({ host: tcp.hostname, port: Number(tcp.port), timeout: 6000 }, () => {
        socket.end();
        resolve({ tcp: true });
      });
      socket.on("timeout", () => socket.destroy(Object.assign(new Error("timeout"), { code: "TimeoutError" })));
      socket.on("error", reject);
    })
  : host
  ? new Promise((resolve, reject) => {
      const req = require("node:http").get(url, { headers: { host }, timeout: 6000 }, (r) => {
        r.resume();
        resolve({ status: r.statusCode });
      });
      req.on("timeout", () => req.destroy(Object.assign(new Error("timeout"), { code: "TimeoutError" })));
      req.on("error", reject);
    })
  : fetch(url, { method, body: method === "GET" ? undefined : "", signal: AbortSignal.timeout(6000) });
get.then(
  (r) => console.log(r.tcp ? "reached, TCP" : "reached, HTTP " + r.status),
  (e) => {
    const code = e.cause?.code ?? e.code ?? e.name;
    console.log((blocks.includes(code) ? "blocked: " : names.includes(code) ? "no name: " : "failed: ") + code);
  })'

# Starts a pod that idles, or runs the script given, with the fences every namespace here enforces (the restricted
# standard).
# $1: namespace; $2: name; $3: image; $4: Node's path in it; $5: its labels, one per line; $6: more of its spec; $7:
# what it runs.
start_pod() {
  local script=${7:-'setTimeout(() => {}, 600000)'}
  kubectl --context "$context" -n "$1" delete pod "$2" --ignore-not-found --wait >/dev/null
  kubectl --context "$context" -n "$1" apply -f - >/dev/null <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: $2
  labels:
$(sed 's/^/    /' <<<"$5")
spec:
  restartPolicy: Never
  automountServiceAccountToken: false
${6:-}
  securityContext:
    runAsNonRoot: true
    runAsUser: 65532
    seccompProfile:
      type: RuntimeDefault
  containers:
    - name: $2
      image: $3
      command: [$4, -e, '$script']
      securityContext:
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        capabilities:
          drop: [ALL]
EOF
}

# The workers' own checks run from a probe pod made from the worker's live Deployment, and not from inside the worker,
# where a second Node beside the worker's own could run it out of memory. Its template keeps everything that decides
# what the pod may reach (its namespace, labels and annotations, DNS, hosts, host network, service account, image and
# security contexts), and a network policy selects by nothing else. Replaced: the command, a Node that idles until the
# run deletes it; the resources, its own; and the service account's token, not mounted. Dropped, as they would run the
# worker or hand it the worker's things: the init containers, the volumes, the environment, and every container but
# the first, which a network policy would treat the same. And it is never ready, by a probe of a port nothing listens
# on, so the worker's Service does not send the worker's callers to it.
# $1: namespace; $2: the Deployment; $3: Node's path in its image.
start_probe() {
  kubectl --context "$context" -n "$1" delete pod "egress-$2" --ignore-not-found --wait >/dev/null
  kubectl --context "$context" -n "$1" get deployment "$2" -o json | jq --arg name "egress-$2" --arg node "$3" '
    .spec.template as $template | {
      apiVersion: "v1",
      kind: "Pod",
      metadata: { name: $name, labels: $template.metadata.labels, annotations: ($template.metadata.annotations // {}) },
      spec: ($template.spec | del(.initContainers, .ephemeralContainers, .volumes, .resources, .resourceClaims) + {
        restartPolicy: "Never",
        automountServiceAccountToken: false,
        containers: [$template.spec.containers[0] | {
          name, image, imagePullPolicy, securityContext,
          command: [$node, "-e", "setInterval(() => {}, 3600000)"],
          resources: { requests: { cpu: "10m", memory: "32Mi" }, limits: { memory: "256Mi" } },
          readinessProbe: { tcpSocket: { port: 1 }, periodSeconds: 3600 }
        }]
      })
    }' | kubectl --context "$context" -n "$1" apply -f - >/dev/null
}

# Addresses, for the agent pod, which has no DNS, and for the checks of the node's own ports.
ip() { kubectl --context "$context" -n "$1" get service "$2" -o jsonpath='{.spec.clusterIP}'; }
gateway_ip=$(ip factory gateway) line_ip=$(ip factory line) github_ip=$(ip factory github)
api_ip=$(ip default kubernetes) postgres_ip=$(ip factory postgres) console_ip=$(ip factory console)
website_ip=$(ip website website) admin_ip=$(ip factory admin) collector_ip=$(ip telemetry otel-collector)
# Argo Rollouts' controller, the Postgres exporter and the pod log collector have no Service: their pods are scraped
# where they are. A pod a ReplicaSet made has its template's hash ($3, by default), one a DaemonSet made its revision's,
# and the pods this starts have neither; one shutting down is passed over, and a ready one is taken before one that is
# not, such as a pod restarting. With none, the address is empty, and each check of it FAILs ("failed", which proves
# nothing either way) while the rest go on.
pod_ip() {
  kubectl --context "$context" -n "$1" get pods -l "$2,${3:-pod-template-hash}" -o json | jq -r '
    [.items[] | select(.status.phase == "Running" and .metadata.deletionTimestamp == null)]
    | sort_by(any(.status.conditions[]?; .type == "Ready" and .status == "True") | not)[0].status.podIP // ""'
}
rollouts_ip=$(pod_ip argo-rollouts app.kubernetes.io/name=argo-rollouts)
exporter_ip=$(pod_ip factory app.kubernetes.io/name=postgres-exporter)
pod_logs_ip=$(pod_ip pod-logs app.kubernetes.io/name=opentelemetry-collector controller-revision-hash)
flagd_ip=$(pod_ip flagd app.kubernetes.io/name=flagd)
# One of the app's pods, which the Rollout's ReplicaSets label with their hash, and not the pod this starts beside it.
app_pod_ip=$(pod_ip website app.kubernetes.io/name=website rollouts-pod-template-hash)
node_ip=$(kubectl --context "$context" get nodes -o jsonpath='{.items[0].status.addresses[?(@.type=="InternalIP")].address}')

# A worker's labels, which is what a compromised one would have.
start_pod factory "$pod" "$image" /nodejs/bin/node "app.kubernetes.io/name: intruder
app.kubernetes.io/part-of: software-factory
app.kubernetes.io/component: worker"
# A runner's two pods. The agent pod's spec is what the line writes into it: no DNS, and the two addresses it needs.
start_pod runners egress-agent "$runner_image" node "app.kubernetes.io/part-of: software-factory
factory.mrogan.dev/runner: agent" "  dnsPolicy: None
  dnsConfig:
    nameservers: [127.0.0.1]
  hostAliases:
    - { ip: $gateway_ip, hostnames: [gateway.factory.svc] }
    - { ip: $line_ip, hostnames: [line.factory.svc] }"
start_pod runners egress-prepare "$runner_image" node "app.kubernetes.io/part-of: software-factory
factory.mrogan.dev/runner: prepare"
# The analysis Job's pod, by its labels in the ClusterAnalysisTemplate, on its image.
start_pod website egress-journeys "$browser_image" node "app.kubernetes.io/name: journeys
app.kubernetes.io/part-of: software-factory"
# The app's pods by the one label its fence selects on, and not by all of theirs: neither the app's Services nor its
# ReplicaSets must take this pod for one of theirs. And a pod beside the app that no policy selects.
start_pod website egress-app "$browser_image" node "app.kubernetes.io/name: website"
start_pod website egress-stranger "$browser_image" node "app.kubernetes.io/name: egress-stranger"
# The controllers' pods by the one label their policies select on, and not by all of their own: their ReplicaSets
# must not take these pods for theirs.
start_pod argo-rollouts egress-rollouts "$runner_image" node "app.kubernetes.io/component: rollouts-controller"
start_pod pod-logs egress-pod-logs "$runner_image" node "app.kubernetes.io/name: opentelemetry-collector"
start_pod kyverno egress-admission "$runner_image" node "app.kubernetes.io/component: admission-controller"
start_pod kyverno egress-kyverno "$runner_image" node "app.kubernetes.io/component: reports-controller"
# A pod in `telemetry` that is none of its backends, answering on their query ports, as anything new there might.
start_pod telemetry egress-stranger "$runner_image" node "app.kubernetes.io/name: egress-stranger" "" \
  'for (const port of [9090, 3100, 3200]) require("node:http").createServer((q, r) => r.end("stranger")).listen(port)'
# Prometheus's server by the two labels the fences of what it scrapes select on, and not its instance's: the
# prometheus-server Service must not take this pod for one of its own.
start_pod telemetry egress-prometheus "$runner_image" node "app.kubernetes.io/name: prometheus
app.kubernetes.io/component: server"
# Tempo by the one label Prometheus's fence selects on, and not its instance's: the tempo Service and StatefulSet must not
# take this pod for one of theirs.
start_pod telemetry egress-tempo "$runner_image" node "app.kubernetes.io/name: tempo"
# Alertmanager by the one label its fence, and the intake's, select on, and not its instance's: neither its Service and
# StatefulSet nor Prometheus, which sends alerts to the pods of its own instance, must take this pod for Alertmanager.
start_pod telemetry egress-alertmanager "$runner_image" node "app.kubernetes.io/name: alertmanager"
# The Postgres exporter by the one label its fence, and Postgres's, select on, on the factory image: the exporter's
# own has no Node.
start_pod factory egress-postgres-exporter "$image" /nodejs/bin/node "app.kubernetes.io/name: postgres-exporter"
# The workers', each from its Deployment. The factory image's Node is /nodejs/bin/node; the probes' and the crawler's
# browser image has it on its PATH.
for worker in "${workers[@]}"; do
  case $worker in
    factory/probes | factory/crawler) start_probe "${worker%%/*}" "${worker#*/}" node ;;
    *) start_probe "${worker%%/*}" "${worker#*/}" /nodejs/bin/node ;;
  esac
done
for started in factory/$pod runners/egress-agent runners/egress-prepare website/egress-journeys website/egress-app \
  website/egress-stranger argo-rollouts/egress-rollouts pod-logs/egress-pod-logs kyverno/egress-admission \
  kyverno/egress-kyverno telemetry/egress-stranger telemetry/egress-prometheus telemetry/egress-tempo \
  telemetry/egress-alertmanager factory/egress-postgres-exporter
do
  kubectl --context "$context" -n "${started%%/*}" wait "pod/${started#*/}" --for=condition=Ready --timeout=2m >/dev/null
done
# A probe pod is never ready, so it is waited for until its Node has started.
for worker in "${workers[@]}"; do
  kubectl --context "$context" -n "${worker%%/*}" wait "pod/egress-${worker#*/}" --timeout=2m \
    --for=jsonpath='{.status.containerStatuses[0].started}'=true >/dev/null
done
# The policy reaches a new pod a moment after it starts.
sleep 5
stranger_ip=$(kubectl --context "$context" -n telemetry get pod egress-stranger -o jsonpath='{.status.podIP}')

failed=0
group='' tag=''
# A group of checks: its heading, printed, and given to each check after it. $1: the heading; $2: a tag for its checks.
group() {
  group=$1 tag=${2:-}
  echo "$1:"
}
# One check, for the record. $1: what was tried; $2: where from; $3: the address; $4: what it wanted; $5: what it got;
# $6: ok or fail.
note() {
  jq -cn --arg group "$group" --arg tag "$tag" --arg check "$1" --arg from "$2" --arg address "$3" --arg wanted "$4" \
    --arg got "$5" --arg result "$6" \
    '{group: $group, check: $check, from: $from, address: $address, wanted: $wanted, got: $got, result: $result}
      + if $tag == "" then {} else {tag: $tag} end' >>"$checks"
}
# $1: what is being tried; $2: where from (the pod); $3: the address; $4: blocked or reached, as it must be; $5: the
# host to name, if any.
expect() {
  local result
  local namespace=factory target=$2 node=/nodejs/bin/node
  # A target written <namespace>:<pod> runs the node on its PATH, which every image keeps but the factory image, whose
  # node is /nodejs/bin/node. So the probes and the crawler, on the browser image, are written factory:<pod> too; the
  # scoreboard runs the factory image.
  if [[ "$2" == *:* ]]; then namespace=${2%%:*} target=${2#*:} node=node; fi
  if [ "$namespace" = scoreboard ]; then node=/nodejs/bin/node; fi
  local status=0
  # An exec that fails is that check's FAIL, and the rest go on. One killed (137) ran its pod out of memory.
  result=$(kubectl --context "$context" -n "$namespace" exec "$target" -- "$node" -e "$try" "$3" ${5:+"$5"} \
    2>"$exec_errors") || status=$?
  if [ "$status" != 0 ]; then
    local why
    why=$(tail -n 1 "$exec_errors")
    if [ "$status" = 137 ]; then why="killed${why:+; $why}"; fi
    printf '  FAIL  %-62s kubectl exec into %s exited %s%s (wanted %s)\n' "$1" "$2" "$status" "${why:+: $why}" "$4"
    note "$1" "$2" "$3" "$4" "kubectl exec exited $status${why:+: $why}" fail
    failed=1
  elif [[ "$result" == "$4"* ]]; then
    printf '  ok    %-62s %s\n' "$1" "$result"
    note "$1" "$2" "$3" "$4" "$result" ok
  else
    printf '  FAIL  %-62s %s (wanted %s)\n' "$1" "$result" "$4"
    note "$1" "$2" "$3" "$4" "$result" fail
    failed=1
  fi
}

group "A pod labelled like a worker (${pod}), the gateway and the GitHub worker"
expect "the gateway reaches TypeSafe" egress-gateway https://api.typesafe.ai reached
expect "the worker cannot reach TypeSafe" "$pod" https://api.typesafe.ai blocked
expect "the worker cannot reach GitHub" "$pod" https://api.github.com blocked
expect "the worker cannot reach a public address" "$pod" https://1.1.1.1 blocked
expect "the worker cannot reach the gateway" "$pod" http://gateway:8080/health blocked
expect "the worker cannot reach the GitHub worker" "$pod" http://github:8080/health blocked
expect "the worker cannot reach the app" "$pod" http://website.website blocked
expect "the worker cannot reach Prometheus" "$pod" http://prometheus-server.telemetry/-/healthy blocked
expect "the gateway cannot reach the app" egress-gateway http://website.website blocked
expect "the GitHub worker reaches GitHub" egress-github https://api.github.com reached
expect "the GitHub worker reaches GHCR" egress-github https://ghcr.io/v2/ reached
expect "the GitHub worker cannot reach the app" egress-github http://website.website blocked
expect "the GitHub worker cannot reach the gateway" egress-github http://gateway:8080/health blocked
expect "triage reaches the gateway" egress-triage http://gateway:8080/health reached
expect "the intake cannot reach the gateway" egress-intake http://gateway:8080/health blocked
expect "the worker cannot reach the probes" "$pod" http://probes:8080/health blocked
expect "the worker cannot reach the probes' verification" "$pod" http://probes:8081/health blocked

group "The line"
expect "the line reaches the Kubernetes API" egress-line "https://$api_ip/version" reached
expect "the line reaches the API server on the node" egress-line "https://$node_ip:6443/version" reached
expect "the line reaches the probes' verification" egress-line http://probes:8081/health reached
expect "the line cannot reach the probes' page reader" egress-line http://probes:8080/health blocked
expect "the line cannot reach the app" egress-line http://website.website blocked
expect "the line cannot reach the node's ingress" egress-line "https://$node_ip:443" blocked
expect "the line cannot reach a public address" egress-line https://1.1.1.1 blocked
expect "the line cannot reach the gateway" egress-line http://gateway:8080/health blocked
expect "the line cannot reach the host" egress-line http://0.250.250.254:1234/v1/models blocked

# What a reader of telemetry may do: query each backend it reads through the proxy, and nothing else. A write the proxy
# refuses is answered 405, a path it does not pass 403, before it reaches a backend.
# $1: the reader; $2: its pod; $3: "tempo" if it reads Tempo as well as Prometheus and Loki.
reads_telemetry() {
  local q=http://query.telemetry
  expect "$1 queries Prometheus through the proxy" "$2" "$q:9090/api/v1/query?query=up" "reached, HTTP 200"
  expect "$1 queries Loki through the proxy" "$2" "$q:3100/loki/api/v1/query?query=vector(1)" "reached, HTTP 200"
  if [ "${3:-}" = tempo ]; then
    expect "$1 searches Tempo through the proxy" "$2" "$q:3200/api/search?limit=1" "reached, HTTP 200"
    # The log watcher's count of a window's requests by route, over the minute before last.
    local now count
    now=$(date +%s)
    count="q=%7B%20kind%20%3D%20server%20%7D%20%7C%20count_over_time()%20by%20(span.http.route)"
    expect "$1 counts Tempo's spans through the proxy" "$2" \
      "$q:3200/api/metrics/query?$count&start=$((now - 120))&end=$((now - 60))" "reached, HTTP 200"
    expect "$1 cannot post a query to Tempo through the proxy" "$2" "POST $q:3200/api/metrics/query" "reached, HTTP 405"
    expect "$1 cannot flush Tempo through the proxy" "$2" "$q:3200/flush" "reached, HTTP 403"
  else
    expect "$1 cannot reach Tempo through the proxy" "$2" "$q:3200/ready" blocked
  fi
  expect "$1 cannot write metrics through the proxy" "$2" "POST $q:9090/api/v1/otlp/v1/metrics" "reached, HTTP 405"
  expect "$1 cannot push logs through the proxy" "$2" "POST $q:3100/loki/api/v1/push" "reached, HTTP 405"
  expect "$1 cannot push OTLP logs through the proxy" "$2" "POST $q:3100/otlp/v1/logs" "reached, HTTP 405"
  expect "$1 cannot have Prometheus reload through the proxy" "$2" "POST $q:9090/-/reload" "reached, HTTP 405"
  expect "$1 cannot read Prometheus's configuration through the proxy" "$2" "$q:9090/api/v1/status/config" \
    "reached, HTTP 403"
  expect "$1 cannot reach Prometheus itself" "$2" http://prometheus-server.telemetry/-/healthy blocked
  expect "$1 cannot reach Loki itself" "$2" http://loki.telemetry:3100/ready blocked
  expect "$1 cannot reach Tempo itself" "$2" http://tempo.telemetry:3200/ready blocked
  expect "$1 cannot reach Tempo's intake" "$2" http://tempo.telemetry:4318/ blocked
  expect "$1 cannot reach Grafana" "$2" http://grafana.telemetry/api/health blocked
  for port in 9090 3100 3200; do
    expect "$1 cannot reach the stranger in telemetry on $port" "$2" "http://$stranger_ip:$port" blocked
  done
}

group "The readers of telemetry, through the read-only proxy, and Prometheus itself" read-only-telemetry
# The control: the stranger answers on each port, so a reader's "blocked" there is the policy's doing.
for port in 9090 3100 3200; do
  expect "the stranger in telemetry answers on $port" telemetry:egress-stranger "http://$stranger_ip:$port" reached
done
expect "the stranger in telemetry cannot reach Prometheus" telemetry:egress-stranger \
  http://prometheus-server.telemetry/-/healthy blocked
expect "Prometheus, asked directly, will not reload" argo-rollouts:egress-rollouts \
  "POST http://prometheus-server.telemetry/-/reload" "reached, HTTP 403"
# An empty write: Prometheus refuses it as malformed, so nothing is written, and that it answers shows the way is open.
expect "Tempo reaches Prometheus's remote-write receiver" telemetry:egress-tempo \
  "POST http://prometheus-server.telemetry/api/v1/write" "reached, HTTP 400"
reads_telemetry triage egress-triage tempo
reads_telemetry "the intake" egress-intake
reads_telemetry "the log watcher" egress-logs tempo
reads_telemetry "the line" egress-line tempo
expect "the worker cannot reach the proxy" "$pod" http://query.telemetry:9090/-/healthy blocked

group "Pods labelled like a runner's agent pod and prepare pod"
expect "the agent pod reaches the gateway" runners:egress-agent http://gateway.factory.svc:8080/health reached
expect "the agent pod reaches the handback" runners:egress-agent http://line.factory.svc:8081/health reached
expect "the agent pod cannot reach the line's step API" runners:egress-agent http://line.factory.svc:8080/health blocked
expect "the agent pod cannot look up a name" runners:egress-agent https://api.github.com "no name"
expect "the agent pod cannot reach a public address" runners:egress-agent https://1.1.1.1 blocked
expect "the agent pod cannot reach the Kubernetes API" runners:egress-agent "https://$api_ip/version" blocked
expect "the agent pod cannot reach the API server on the node" runners:egress-agent "https://$node_ip:6443" blocked
expect "the agent pod cannot reach the metadata address" runners:egress-agent http://169.254.169.254 blocked
expect "the agent pod cannot reach Postgres" runners:egress-agent "http://$postgres_ip:5432" blocked
expect "the agent pod cannot reach the console" runners:egress-agent "http://$console_ip" blocked
expect "the agent pod cannot reach the GitHub worker" runners:egress-agent "http://$github_ip:8080/health" blocked
expect "the agent pod cannot reach the app" runners:egress-agent "http://$website_ip" blocked
expect "the agent pod cannot reach the host" runners:egress-agent http://0.250.250.254:1234/v1/models blocked
expect "the prepare pod reaches GitHub" runners:egress-prepare https://api.github.com reached
expect "the prepare pod reaches the npm registry" runners:egress-prepare https://registry.npmjs.org reached
expect "the prepare pod cannot reach the gateway" runners:egress-prepare http://gateway.factory.svc:8080/health blocked
expect "the prepare pod cannot reach the host" runners:egress-prepare http://0.250.250.254:1234/v1/models blocked
expect "the prepare pod cannot reach the Kubernetes API" runners:egress-prepare "https://$api_ip/version" blocked
expect "the prepare pod cannot reach the metadata address" runners:egress-prepare http://169.254.169.254 blocked
expect "the prepare pod cannot reach Postgres" runners:egress-prepare "http://$postgres_ip:5432" blocked
expect "the prepare pod cannot reach the line's handback" runners:egress-prepare http://line.factory.svc:8081/health blocked

group "The traffic generator, and a pod made like the canary's analysis Job (egress-journeys)"
expect "the traffic generator reaches Traefik" egress-traffic http://traefik.kube-system reached
expect "the traffic generator cannot reach the app but through it" egress-traffic http://website.website blocked
expect "the traffic generator cannot reach the canary but through it" egress-traffic http://website-canary.website blocked
expect "the traffic generator cannot reach Postgres" egress-traffic "http://$postgres_ip:5432" blocked
expect "the traffic generator cannot reach the gateway" egress-traffic http://gateway:8080/health blocked
expect "the traffic generator cannot reach a public address" egress-traffic https://1.1.1.1 blocked
expect "the analysis reaches the app" website:egress-journeys http://website.website reached
expect "the analysis reaches the canary" website:egress-journeys http://website-canary.website reached
expect "the analysis cannot reach Prometheus" website:egress-journeys http://prometheus-server.telemetry/-/healthy blocked
expect "the analysis cannot reach the collector" website:egress-journeys http://otel-collector.telemetry:4318 blocked
expect "the analysis cannot reach Postgres" website:egress-journeys "http://$postgres_ip:5432" blocked
expect "the analysis cannot reach the gateway" website:egress-journeys "http://$gateway_ip:8080/health" blocked
expect "the analysis cannot reach the Kubernetes API" website:egress-journeys "https://$api_ip/version" blocked
expect "the analysis cannot reach a public address" website:egress-journeys https://1.1.1.1 blocked

group "A pod labelled like the app (egress-app), and who reaches the app"
expect "the app reaches the collector, by its name" website:egress-app http://otel-collector.telemetry:4318 reached
expect "the app cannot reach the collector on another port" website:egress-app http://otel-collector.telemetry:4317 blocked
expect "the app cannot reach Prometheus" website:egress-app http://prometheus-server.telemetry/-/healthy blocked
expect "the app cannot reach Loki" website:egress-app http://loki.telemetry:3100/ready blocked
expect "the app cannot reach Tempo" website:egress-app http://tempo.telemetry:3200/ready blocked
expect "the app cannot reach the read-only proxy" website:egress-app http://query.telemetry:9090/-/healthy blocked
expect "the app cannot reach Postgres" website:egress-app "http://$postgres_ip:5432" blocked
expect "the app cannot reach the gateway" website:egress-app "http://$gateway_ip:8080/health" blocked
expect "the app cannot reach the Kubernetes API" website:egress-app "https://$api_ip/version" blocked
expect "the app cannot reach a public address" website:egress-app https://1.1.1.1 blocked
expect "the app reaches flagd's sync port" website:egress-app http://flagd.flagd:8015/v1/flags reached
expect "the app cannot reach flagd's management port" website:egress-app "http://$flagd_ip:8014/healthz" blocked
expect "the app cannot reach flagd's evaluation port" website:egress-app "http://$flagd_ip:8013" blocked
expect "the app cannot reach flagd's OFREP port" website:egress-app "http://$flagd_ip:8016" blocked
expect "a pod beside the app cannot reach flagd" website:egress-stranger "http://$flagd_ip:8015/v1/flags" blocked
expect "a worker cannot reach flagd" "$pod" http://flagd.flagd:8015/v1/flags blocked
expect "Traefik passes a visitor to the app" egress-traffic http://traefik.kube-system/health "reached, HTTP 200" \
  website.localhost
expect "the probes reach the app" factory:egress-probes http://website.website/health "reached, HTTP 200"
expect "the probes reach the canary, for its pictures" factory:egress-probes http://website-canary.website/health "reached, HTTP 200"
expect "the crawler reaches the app" factory:egress-crawler http://website.website/health "reached, HTTP 200"
expect "the probes reach the console, to ask whether it answers" factory:egress-probes http://console.factory/health \
  "reached, HTTP 200"
expect "the crawler cannot reach the console" factory:egress-crawler http://console.factory/health blocked
# A pod beside the app that neither the app's policy nor the journeys' selects, as one the app's repository relabelled
# would be: `website`'s default deny leaves it nothing, not even DNS.
expect "a pod beside the app cannot look up a name" website:egress-stranger http://otel-collector.telemetry:4318 "no name"
expect "a pod beside the app cannot reach the collector" website:egress-stranger "http://$collector_ip:4318" blocked
expect "a pod beside the app cannot reach flagd's management port" website:egress-stranger "http://$flagd_ip:8014/healthz" blocked
expect "a pod beside the app cannot reach it" website:egress-stranger "http://$website_ip" blocked
expect "a pod beside the app cannot reach a public address" website:egress-stranger https://1.1.1.1 blocked

group "A pod labelled like the Argo Rollouts controller (egress-rollouts)"
expect "the controller reaches the Kubernetes API" argo-rollouts:egress-rollouts "https://$api_ip/version" reached
expect "the controller reaches Prometheus" argo-rollouts:egress-rollouts http://prometheus-server.telemetry/-/healthy reached
expect "the controller cannot reach GitHub" argo-rollouts:egress-rollouts https://api.github.com blocked
expect "the controller cannot reach a public address" argo-rollouts:egress-rollouts https://1.1.1.1 blocked
expect "the controller cannot reach the app" argo-rollouts:egress-rollouts http://website.website blocked
expect "the controller cannot reach Loki" argo-rollouts:egress-rollouts http://loki.telemetry:3100/ready blocked
expect "the controller cannot reach Postgres" argo-rollouts:egress-rollouts "http://$postgres_ip:5432" blocked

group "A pod labelled like the pod log collector (egress-pod-logs)"
expect "the collector reaches Loki's intake" pod-logs:egress-pod-logs http://loki.telemetry:3100/ready reached
expect "the collector cannot reach Prometheus" pod-logs:egress-pod-logs http://prometheus-server.telemetry/-/healthy blocked
expect "the collector cannot reach Tempo" pod-logs:egress-pod-logs http://tempo.telemetry:3200/ready blocked
expect "the collector cannot reach the collector in telemetry" pod-logs:egress-pod-logs http://otel-collector.telemetry:4318 blocked
expect "the collector cannot reach Postgres" pod-logs:egress-pod-logs "http://$postgres_ip:5432" blocked
expect "the collector cannot reach the app" pod-logs:egress-pod-logs http://website.website blocked
expect "the collector cannot reach the Kubernetes API" pod-logs:egress-pod-logs "https://$api_ip/version" blocked
expect "the collector cannot reach a public address" pod-logs:egress-pod-logs https://1.1.1.1 blocked

group "Pods labelled like Kyverno's admission controller (egress-admission) and its reports controller (egress-kyverno)"
expect "the admission controller reaches GHCR" kyverno:egress-admission https://ghcr.io/v2/ reached
expect "the admission controller reaches GHCR's storage" kyverno:egress-admission https://pkg-containers.githubusercontent.com reached
expect "the admission controller reaches Sigstore's trust root" kyverno:egress-admission https://tuf-repo-cdn.sigstore.dev/root.json reached
expect "the admission controller reaches the Kubernetes API" kyverno:egress-admission "https://$api_ip/version" reached
expect "the admission controller cannot leave on another port" kyverno:egress-admission http://1.1.1.1 blocked
expect "the admission controller cannot reach the app" kyverno:egress-admission http://website.website blocked
expect "the admission controller cannot reach Postgres" kyverno:egress-admission "http://$postgres_ip:5432" blocked
expect "the admission controller cannot reach the metadata address" kyverno:egress-admission http://169.254.169.254 blocked
expect "the admission controller cannot reach the host" kyverno:egress-admission http://0.250.250.254:1234/v1/models blocked
expect "the reports controller cannot reach GHCR" kyverno:egress-kyverno https://ghcr.io/v2/ blocked
expect "the reports controller cannot reach a public address" kyverno:egress-kyverno https://1.1.1.1 blocked
expect "the reports controller reaches the Kubernetes API" kyverno:egress-kyverno "https://$api_ip/version" reached

# What Prometheus's server scrapes beyond its own namespace, each behind a fence that lets in its server alone: a pod
# labelled like it reaches the target, which is the control, and the stranger in `telemetry` does not.
# $1: what is scraped; $2: its metrics' address.
scrapes() {
  expect "Prometheus's server scrapes $1" telemetry:egress-prometheus "$2" "reached, HTTP 200"
  expect "another pod in telemetry cannot reach $1" telemetry:egress-stranger "$2" blocked
}

group "A pod labelled like Prometheus's server (egress-prometheus), and the platform's metrics"
scrapes "Kyverno's admission controller" http://kyverno-svc-metrics.kyverno:8000/metrics
scrapes "Kyverno's reports controller" http://kyverno-reports-controller-metrics.kyverno:8000/metrics
scrapes "Argo Rollouts' controller" "http://$rollouts_ip:8090/metrics"
scrapes "the Postgres exporter" "http://$exporter_ip:9187/metrics"
scrapes "the pod log collector" "http://$pod_logs_ip:8888/metrics"
expect "a worker beside the exporter cannot reach it" "$pod" "http://$exporter_ip:9187/metrics" blocked

group "A pod labelled like the Postgres exporter (egress-postgres-exporter)"
expect "the exporter reaches Postgres" egress-postgres-exporter tcp://postgres:5432 reached
expect "the exporter cannot reach the collector" egress-postgres-exporter http://otel-collector.telemetry:4318 blocked
expect "the exporter cannot reach the gateway" egress-postgres-exporter http://gateway:8080/health blocked
expect "the exporter cannot reach the app" egress-postgres-exporter http://website.website blocked
expect "the exporter cannot reach the Kubernetes API" egress-postgres-exporter "https://$api_ip/version" blocked
expect "the exporter cannot reach a public address" egress-postgres-exporter https://1.1.1.1 blocked

group "A pod labelled like Alertmanager (egress-alertmanager), and who reaches Alertmanager"
alertmanager=http://prometheus-alertmanager.telemetry:9093/-/healthy
expect "Alertmanager reaches the intake" telemetry:egress-alertmanager http://intake.factory:8080/health "reached, HTTP 200"
expect "Alertmanager reaches Pushover" telemetry:egress-alertmanager https://api.pushover.net/1/messages.json reached
expect "Alertmanager reaches a public address on 443" telemetry:egress-alertmanager https://1.1.1.1 reached
expect "Alertmanager cannot leave on another port" telemetry:egress-alertmanager http://1.1.1.1 blocked
expect "Alertmanager cannot reach Prometheus" telemetry:egress-alertmanager http://prometheus-server.telemetry/-/healthy blocked
expect "Alertmanager cannot reach Postgres" telemetry:egress-alertmanager "http://$postgres_ip:5432" blocked
expect "Alertmanager cannot reach the gateway" telemetry:egress-alertmanager http://gateway.factory:8080/health blocked
expect "Alertmanager cannot reach the admin service" telemetry:egress-alertmanager "http://$admin_ip:8080/admin/health" blocked
expect "Alertmanager cannot reach the Kubernetes API" telemetry:egress-alertmanager "https://$api_ip/version" blocked
expect "Alertmanager cannot reach the API server on the node" telemetry:egress-alertmanager "https://$node_ip:6443" blocked
expect "Alertmanager cannot reach the host" telemetry:egress-alertmanager http://0.250.250.254:1234/v1/models blocked
expect "Alertmanager cannot reach the metadata address" telemetry:egress-alertmanager https://169.254.169.254 blocked
expect "Prometheus's server reaches Alertmanager" telemetry:egress-prometheus "$alertmanager" "reached, HTTP 200"
expect "the stranger in telemetry cannot reach Alertmanager" telemetry:egress-stranger "$alertmanager" blocked
expect "the worker cannot reach Alertmanager" "$pod" "$alertmanager" blocked

group "The admin service"
expect "the admin service reaches Postgres" egress-admin tcp://postgres:5432 reached
expect "the admin service reaches the collector" egress-admin http://otel-collector.telemetry:4318 reached
expect "the admin service cannot reach the gateway" egress-admin http://gateway:8080/health blocked
expect "the admin service reaches the app's pods" egress-admin "http://$app_pod_ip:8080/health" "reached, HTTP 200"
expect "the stranger in telemetry cannot reach the app's pods" telemetry:egress-stranger \
  "http://$app_pod_ip:8080/health" blocked
expect "the admin service reaches the Kubernetes API" egress-admin "https://$api_ip/version" reached
expect "the admin service reaches the API server on the node" egress-admin "https://$node_ip:6443/version" reached
expect "the admin service cannot reach the node's ingress" egress-admin "https://$node_ip:443" blocked
expect "the admin service cannot reach a public address" egress-admin https://1.1.1.1 blocked
expect "the worker cannot reach the admin service" "$pod" http://admin:8080/admin/health blocked
expect "the agent pod cannot reach the admin service" runners:egress-agent "http://$admin_ip:8080/admin/health" blocked
expect "the scoreboard cannot reach the admin service" scoreboard:egress-scoreboard "http://$admin_ip:8080/admin/health" blocked
expect "the stranger in telemetry cannot reach the admin service" telemetry:egress-stranger \
  "http://$admin_ip:8080/admin/health" blocked

group "The scoreboard"
expect "the scoreboard reaches Postgres" scoreboard:egress-scoreboard tcp://postgres.factory:5432 reached
expect "the scoreboard cannot reach the collector" scoreboard:egress-scoreboard http://otel-collector.telemetry:4318 blocked
expect "the scoreboard cannot reach the gateway" scoreboard:egress-scoreboard http://gateway.factory:8080/health blocked
expect "the scoreboard cannot reach the GitHub worker" scoreboard:egress-scoreboard http://github.factory:8080/health blocked
expect "the scoreboard cannot reach the console" scoreboard:egress-scoreboard http://console.factory blocked
expect "the scoreboard cannot reach the probes" scoreboard:egress-scoreboard http://probes.factory:8080/health blocked
expect "the scoreboard cannot reach Prometheus" scoreboard:egress-scoreboard http://prometheus-server.telemetry/-/healthy blocked
expect "the scoreboard cannot reach Loki" scoreboard:egress-scoreboard http://loki.telemetry:3100/ready blocked
expect "the scoreboard cannot reach the read-only proxy" scoreboard:egress-scoreboard http://query.telemetry:9090/-/healthy blocked
expect "the scoreboard cannot reach the app" scoreboard:egress-scoreboard http://website.website blocked
expect "the scoreboard cannot reach the Kubernetes API" scoreboard:egress-scoreboard "https://$api_ip/version" blocked
expect "the scoreboard cannot reach the API server on the node" scoreboard:egress-scoreboard "https://$node_ip:6443" blocked
expect "the scoreboard cannot reach the host" scoreboard:egress-scoreboard http://0.250.250.254:1234/v1/models blocked
expect "the scoreboard cannot reach the metadata address" scoreboard:egress-scoreboard http://169.254.169.254 blocked
expect "the scoreboard cannot reach GitHub" scoreboard:egress-scoreboard https://api.github.com blocked
expect "the scoreboard cannot reach a public address" scoreboard:egress-scoreboard https://1.1.1.1 blocked

# Who may read the scoreboard's Secrets, or reach them another way: start a pod or a workload beside them that would
# mount them, change one that runs there, run a command in the scoreboard's pod or add a debug container to it, or
# give itself any of these rights (a role or binding there or cluster-wide, `bind` or `escalate`, impersonation). Every
# service account in the namespaces the factory, the app, flagd, the telemetry, the pod log collector, Argo Rollouts and
# Kyverno run in is asked of the API server, the scoreboard's own included.
#
# Argo Rollouts' controller runs the app's canaries from a cluster-wide install, whose role reads Secrets everywhere,
# for its analyses' credentials, and makes and changes ReplicaSets, Jobs and pods' templates wherever a Rollout is. It
# keeps those rights, and only those: a pod it changed in `scoreboard` would still have to run the factory's own signed
# image (`scoreboard-images`). Argo CD's controllers, which deploy everything, and the cluster's own, in `kube-system`,
# may read every Secret, as they must; neither namespace runs anything of ours.
rights=(
  "get secrets" "list secrets" "watch secrets"
  "create pods" "patch pods" "update pods" "create pods/exec" "create pods/attach"
  "patch pods/ephemeralcontainers" "update pods/ephemeralcontainers"
)
for kind in deployments.apps replicasets.apps statefulsets.apps daemonsets.apps jobs.batch cronjobs.batch; do
  rights+=("create $kind" "patch $kind" "update $kind")
done
for kind in roles rolebindings clusterroles clusterrolebindings; do
  rights+=("create $kind.rbac.authorization.k8s.io" "patch $kind.rbac.authorization.k8s.io"
    "update $kind.rbac.authorization.k8s.io")
done
rights+=("bind roles.rbac.authorization.k8s.io" "escalate roles.rbac.authorization.k8s.io"
  "bind clusterroles.rbac.authorization.k8s.io" "escalate clusterroles.rbac.authorization.k8s.io"
  "impersonate serviceaccounts" "impersonate users" "impersonate groups")
rollouts_needs=" get secrets | list secrets | watch secrets | update pods | create replicasets.apps |
  patch replicasets.apps | update replicasets.apps | update deployments.apps | create jobs.batch | patch jobs.batch |
  update jobs.batch "
group "The scoreboard's Secrets"
asks=()
for ns in factory runners website scoreboard flagd telemetry pod-logs argo-rollouts kyverno; do
  for account in $(kubectl --context "$context" -n "$ns" get serviceaccounts -o jsonpath='{.items[*].metadata.name}'); do
    for right in "${rights[@]}"; do
      if [ "$ns/$account" = argo-rollouts/argo-rollouts ] && [[ "$rollouts_needs" == *" $right "* ]]; then continue; fi
      asks+=("$ns $account $right")
    done
  done
done
# Many questions, so several at once. `can-i` answers no with exit status 1, and fails otherwise: only its own answer
# counts, and anything but "no" is printed.
# A subresource is asked as one: given `pods/exec`, `can-i` would ask about a pod named `exec`.
answers=$(printf '%s\n' "${asks[@]}" | xargs -P 16 -L 1 bash -c '
  resource=${4%%/*} subresource=()
  if [ "$resource" != "$4" ]; then subresource=(--subresource "${4#*/}"); fi
  answer=$(kubectl --context "$0" -n scoreboard auth can-i "$3" "$resource" "${subresource[@]}" \
    --as "system:serviceaccount:$1:$2" 2>/dev/null) || true
  if [ "$answer" != no ]; then printf "  FAIL  %-62s %s\n" "$1/$2 may $3 $4 in scoreboard" "${answer:-no answer}"; fi
' "$context")
secrets="no service account may reach them, and Argo Rollouts' controller only as its canaries need"
if [ -n "$answers" ]; then
  echo "$answers"
  note "$secrets" "the API server" "kubectl auth can-i, in scoreboard" no "$answers" fail
  failed=1
else
  printf '  ok    %s\n' "$secrets"
  note "$secrets" "the API server" "kubectl auth can-i, in scoreboard" no "no, to each of ${#asks[@]}" ok
fi

if [ "$failed" = 0 ]; then
  echo "Only the gateway, the GitHub worker, a runner's prepare pod, Kyverno's admission controller and Alertmanager leave"
  echo "the cluster; the readers of telemetry only query the backends; only Prometheus's server scrapes the platform's"
  echo "metrics; a stranger cannot reach Alertmanager; the runners, the release, the traffic, the app, the Postgres exporter"
  echo "and the scoreboard are fenced."
else echo "The network policies do not hold."; fi
if [ -n "$record" ]; then
  jq -s --argjson taken "$taken" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --argjson held "$([ "$failed" = 0 ] && echo true || echo false)" \
    '$taken + {at: $at, held: $held, checks: .}' "$checks" >"$record"
fi
exit "$failed"
