# One entry point for the factory. `make` on its own lists the targets.

CLUSTER := software-factory
CONTEXT := k3d-$(CLUSTER)
KUBECTL := kubectl --context $(CONTEXT)
# mise.toml holds Argo CD's CLI to the minor release this chart runs (its appVersion): move them together.
ARGOCD_CHART := 10.9.5
# The browser tests run in this image, so their snapshots match wherever they run. Its one pin is Dockerfile.browser's.
PLAYWRIGHT := $(shell grep -oE 'mcr\.microsoft\.com/playwright:[^ ]+' apps/factory/Dockerfile.browser)
# The Postgres the console's live browser tests run beside, as in CI: the cluster's, whose one pin is its StatefulSet's.
POSTGRES := $(shell sed -nE 's/^ +image: (postgres:[^ ]+@sha256:[0-9a-f]{64})$$/\1/p' deploy/base/postgres/statefulset.yaml | head -1)
# The branch Argo CD deploys this repository's deploy/ from. `make up REVISION=my-branch` tries a change there
# before it merges; the charts' values and the app's repository are still read from main.
REVISION ?= main
# The private checkout, which holds the answer key: `make up` gives the scoreboard each entry's id and fingerprint.
PRIVATE_DIR ?= $(CURDIR)/../cv-software-factory-private
# The workers that connect to the store, each as a role of its own (packages/store/migrations/0022_worker-roles.sql).
STORE_WORKERS := triage line gateway probes crawler intake logs
# The local certificate authority behind the console's HTTPS, outside the repository (scripts/local-ca.ts).
LOCAL_CA = $(or $(shell node scripts/local-ca.ts dir),$(error node cannot say where the local CA is: run 'mise install'))

# $(call as-martin,role,command): run a command on the host as one of Martin's own roles in the store, through a
# port-forward to Postgres: `operator` for his commands, which only his roles may append
# (packages/store/migrations/0023_martins-commands.sql), and `enrol` for `factory admin enrol`. Its password is in a
# Secret no pod reads, made here if it is not there, and set on the role here as the database's owner
# (packages/store/src/operator.ts), so it works on any cluster as soon as it is made. A store not yet migrated has no
# operator, and the owner appends there; it cannot enrol at all.
as-martin = $(call secret,factory,postgres-$(1),--from-literal=password="$$(openssl rand -hex 24)") && \
	{ $(KUBECTL) -n factory port-forward svc/postgres 15432:5432 >/dev/null 2>&1 & forward=$$!; \
	trap 'kill $$forward' EXIT; sleep 2; \
	secret() { $(KUBECTL) -n factory get secret "$$1" -o jsonpath='{.data.password}' | base64 -d; }; \
	export PGHOST=127.0.0.1 PGPORT=15432 PGDATABASE=factory; \
	role="$$(secret postgres-$(1) | PGUSER=factory PGPASSWORD="$$(secret postgres)" \
		node packages/store/src/operator.ts factory_$(1))" && \
	if [ "$$role" = factory ]; then from=postgres; else from=postgres-$${role\#factory_}; fi && \
	PGUSER="$$role" PGPASSWORD="$$(secret $$from)" $(2); }
as-operator = $(call as-martin,operator,$(1))

# $(call namespace,name): create a namespace unless it exists, and never touch one that does. Argo CD makes each of ours
# from deploy/base/namespaces.yaml, with its pod security label; applying a bare Namespace over one would take that
# label, and Argo CD's tracking, away until Argo CD synced it again, and pods there would be admitted without the
# restricted profile meanwhile. One made here gets them when Argo CD syncs it. Made only when the cluster says there is
# none: any other failure to read it stops here.
namespace = { made="$$($(KUBECTL) get namespace $(1) -o name --ignore-not-found)" && \
	{ [ -n "$$made" ] || $(KUBECTL) create namespace $(1) >/dev/null; }; }

# $(call secret,namespace,name,data): create a Secret unless it exists.
secret = $(call namespace,$(1)) && \
	{ $(KUBECTL) -n $(1) get secret $(2) >/dev/null 2>&1 || $(KUBECTL) -n $(1) create secret generic $(2) $(3); }

.DEFAULT_GOAL := help
.PHONY: help up down gateway-key github-key pushover-key scoreboard-secrets worker-secrets share-key refusal-key judgements-token check check-static check-tests status e2e zap egress admission-ready eval samples real-store stop-the-line start-the-line enrol guardrails

help: ## List the targets
	@awk 'BEGIN { FS = ":.*## " } /^[a-z0-9-]+:.*## / { printf "  \033[1m%-14s\033[0m %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

up: ## Create the local cluster; Argo CD then deploys everything from main (or REVISION=<branch>)
	@docker info >/dev/null 2>&1 || { echo "Docker isn't running. Start OrbStack (or another runtime) and try again."; exit 1; }
	@k3d cluster list $(CLUSTER) >/dev/null 2>&1 || k3d cluster create --config deploy/k3d/cluster.yaml
	@# A cluster without the console's HTTPS port gets it in place: k3d makes the cluster's load balancer again, and keeps
	@# everything in the cluster, the store included. The load balancer's configured ports, so a stopped one counts too.
	@docker inspect -f '{{json .HostConfig.PortBindings}}' k3d-$(CLUSTER)-serverlb | grep -q '"443/tcp"' || { \
		echo "  This cluster has no HTTPS port: adding 127.0.0.1:8443, which restarts its load balancer and nothing else."; \
		k3d cluster edit $(CLUSTER) --port-add 127.0.0.1:8443:443@loadbalancer; }
	helm upgrade --install argocd argo-cd --repo https://argoproj.github.io/argo-helm --version $(ARGOCD_CHART) \
		--kube-context $(CONTEXT) --namespace argocd --create-namespace \
		--values deploy/argocd/values.yaml --wait --timeout 5m --hide-notes
	@# Passwords live only in the cluster: made here once, never committed.
	@$(call secret,factory,postgres,--from-literal=password="$$(openssl rand -hex 24)")
	@$(call secret,factory,postgres-console,--from-literal=password="$$(openssl rand -hex 24)")
	@$(call secret,factory,postgres-metrics,--from-literal=password="$$(openssl rand -hex 24)")
	@$(call secret,factory,postgres-admin,--from-literal=password="$$(openssl rand -hex 24)")
	@# The proofs' role, which `make guardrails` connects as from the Mac; the migrate Job sets it.
	@$(call secret,factory,postgres-proofs,--from-literal=password="$$(openssl rand -hex 24)")
	@$(MAKE) --no-print-directory worker-secrets
	@$(MAKE) --no-print-directory gateway-key
	@$(MAKE) --no-print-directory github-key
	@$(MAKE) --no-print-directory pushover-key
	@$(MAKE) --no-print-directory scoreboard-secrets
	@$(MAKE) --no-print-directory share-key
	@$(MAKE) --no-print-directory refusal-key
	@$(MAKE) --no-print-directory judgements-token
	@$(call secret,telemetry,grafana-admin,--from-literal=admin-user=admin --from-literal=admin-password="$$(openssl rand -hex 24)")
	@$(MAKE) --no-print-directory local-tls
	sed 's|targetRevision: main|targetRevision: $(REVISION)|' deploy/argocd/root.yaml | $(KUBECTL) apply -f -
	@echo "Waiting for Argo CD to deploy everything (a few minutes the first time)..."
	@# An Application reads healthy before it has deployed anything, so wait for each to sync before its health.
	@# Root syncs first: then every other Application exists.
	@$(KUBECTL) -n argocd wait application/root --for=jsonpath='{.status.sync.status}'=Synced --timeout=5m >/dev/null
	@$(KUBECTL) -n argocd wait applications --all --for=jsonpath='{.status.sync.status}'=Synced --timeout=5m >/dev/null
	@# Then everything healthy, except the website, whose health is its release's (scripts/wait-deployed.sh).
	@KUBECTL="$(KUBECTL)" scripts/wait-deployed.sh
	@$(MAKE) --no-print-directory status

down: ## Delete the local cluster, and everything in it
	k3d cluster delete $(CLUSTER)
	@echo "  The local certificate authority stays, trusted, for the next 'make up'. 'make untrust-ca' removes it."

.PHONY: local-tls untrust-ca

# The console's HTTPS: a local certificate authority that may sign for `localhost` names only, made once and kept
# outside the repository; the Mac's trust in it, for TLS servers only, asked for once; and its certificate for the
# console, renewed in its last 30 days, in the Secret Traefik serves it from. Declining the trust prompt leaves the
# console behind a browser warning, and the admin sign-in unusable, until the next `make up` asks again.
local-tls: ## Make the console's certificate (and its local authority) if due, have the Mac trust it, and give it to Traefik
	@node scripts/local-ca.ts issue
	@node scripts/local-ca.ts trust
	@$(call namespace,factory)
	@$(KUBECTL) -n factory create secret tls console-tls --cert="$(LOCAL_CA)/tls.crt" --key="$(LOCAL_CA)/tls.key" \
		--dry-run=client -o yaml | $(KUBECTL) apply -f - >/dev/null

untrust-ca: ## Stop the Mac trusting the local certificate authority, and delete it; the next `make up` makes another
	@node scripts/local-ca.ts untrust

# The gateway's keys, TypeSafe's and Anthropic's, from the environment or the macOS Keychain, go to the cluster and
# nowhere else: each is piped through stdin, never written to a file or put on a command line. Without one there is no
# Secret, and the gateway replays that provider's cassettes only. Restart the gateway after changing a key: it reads
# them when it starts.
gateway-key:
	@key="$${TYPESAFE_API_KEY:-$$(security find-generic-password -s typesafe-api-key -w 2>/dev/null)}"; \
		if [ -n "$$key" ]; then \
			printf %s "$$key" | $(KUBECTL) -n factory create secret generic typesafe --from-file=api-key=/dev/stdin --dry-run=client -o yaml | \
				$(KUBECTL) apply -f - >/dev/null && echo "  The gateway has the TypeSafe key, so it records what Jev answers."; \
		else echo "  No TypeSafe key (TYPESAFE_API_KEY, or the Keychain's typesafe-api-key): the gateway replays cassettes only."; fi
	@key="$${ANTHROPIC_API_KEY:-$$(security find-generic-password -s anthropic-api-key -w 2>/dev/null)}"; \
		if [ -n "$$key" ]; then \
			printf %s "$$key" | $(KUBECTL) -n factory create secret generic anthropic --from-file=api-key=/dev/stdin --dry-run=client -o yaml | \
				$(KUBECTL) apply -f - >/dev/null && echo "  The gateway has the Anthropic key, so agents' calls reach Claude."; \
		else echo "  No Anthropic key (ANTHROPIC_API_KEY, or the Keychain's anthropic-api-key): agents' calls to Claude replay only."; fi

# The factory's GitHub App key, from the macOS Keychain (base64, because the Keychain prints a value with newlines as
# hex), goes to the cluster the same way: through stdin, decoded on the way. Without it the GitHub worker reads and
# writes nothing. Restart the worker after changing the key.
github-key:
	@if security find-generic-password -s factory-github-app-key >/dev/null 2>&1; then \
			security find-generic-password -s factory-github-app-key -w | base64 -d | \
				$(KUBECTL) -n factory create secret generic github-app --from-file=private-key=/dev/stdin --dry-run=client -o yaml | \
				$(KUBECTL) apply -f - >/dev/null && echo "  The GitHub worker has the App's key, so it acts as the factory in GitHub."; \
		else echo "  No App key (the Keychain's factory-github-app-key): the GitHub worker reads and writes nothing."; fi

# Pushover's application token and Martin's user key, from the macOS Keychain, go to Alertmanager the same way: through
# stdin, as one Secret's two entries, never written to a file or put on a command line. Without both there is no
# Secret, and any made before is deleted: Alertmanager still comes up and still sends the app's objective alerts to the intake, but nothing reaches
# Martin's phone. Alertmanager reads the keys each time it sends, so a change needs no restart.
pushover-key: ## Give Alertmanager Pushover's keys from the Keychain (pushover-app-token, pushover-user-key)
	@token="$$(security find-generic-password -s pushover-app-token -w 2>/dev/null)"; \
		user="$$(security find-generic-password -s pushover-user-key -w 2>/dev/null)"; \
		if [ -n "$$token" ] && [ -n "$$user" ]; then \
			$(call namespace,telemetry) && \
			printf 'app-token=%s\nuser-key=%s\n' "$$token" "$$user" | \
				$(KUBECTL) -n telemetry create secret generic pushover --from-env-file=/dev/stdin --dry-run=client -o yaml | \
				$(KUBECTL) apply -f - >/dev/null && echo "  Alertmanager has Pushover's keys, so pages and notifications reach Martin's phone."; \
		else $(KUBECTL) -n telemetry delete secret pushover --ignore-not-found >/dev/null || \
				echo "  Could not delete the old pushover Secret: Alertmanager may still page with the keys it had."; \
			echo "  No Pushover keys (the Keychain's pushover-app-token and pushover-user-key): nothing reaches Martin's phone."; fi

# The scoreboard's Secrets (deploy/base/scoreboard). Its role's password, made once, is in two: `factory`'s, for the
# migrations that set it, and the scoreboard's own, for its pod. The answer key, each entry's id and fingerprint and
# nothing else, goes from the private checkout to the cluster through stdin, checked as the scoreboard checks it, never
# written to a file. Without the checkout there is no key, and any key written before is deleted: the scoreboard is off.
# It reads the key when it starts, so this restarts it. The migrations set the role's password from `factory`'s Secret
# when Argo CD next syncs, so on a cluster made before the scoreboard, run this before the deploy that brings it.
scoreboard-secrets: node_modules ## Give the scoreboard its password, and the answer key from the private checkout (PRIVATE_DIR)
	@$(call namespace,scoreboard)
	@$(KUBECTL) -n factory get secret postgres-scoreboard >/dev/null 2>&1 || \
		printf %s "$$(openssl rand -hex 24)" | \
		$(KUBECTL) -n factory create secret generic postgres-scoreboard --from-file=password=/dev/stdin >/dev/null
	@password="$$($(KUBECTL) -n factory get secret postgres-scoreboard -o jsonpath='{.data.password}' | base64 -d)" && \
		[ -n "$$password" ] && printf %s "$$password" | \
		$(KUBECTL) -n scoreboard create secret generic postgres --from-file=password=/dev/stdin --dry-run=client -o yaml | \
		$(KUBECTL) apply -f - >/dev/null
	@if [ -d "$(PRIVATE_DIR)/defects" ]; then \
			key="$$(node scripts/answer-key.ts "$(PRIVATE_DIR)")" && printf %s "$$key" | \
				$(KUBECTL) -n scoreboard create secret generic answer-key --from-file=key.json=/dev/stdin --dry-run=client -o yaml | \
				$(KUBECTL) apply -f - >/dev/null && echo "  The scoreboard has the answer key, so it counts the tickets."; \
		else $(KUBECTL) -n scoreboard delete secret answer-key --ignore-not-found >/dev/null && \
			echo "  No private checkout at $(PRIVATE_DIR): no answer key, and the scoreboard is off."; fi
	@$(KUBECTL) -n scoreboard delete pod -l app.kubernetes.io/name=scoreboard --ignore-not-found >/dev/null

# The traffic generator's signing key, for a flag's share stage (docs/COMPONENTS/FEATURE-FLAGS.md): an Ed25519 key
# pair, made once. The private key is the Secret share-signing-key in `factory`, which only the generator mounts; once
# made, that Secret is the source, and the app's ConfigMap share-key in `website`, its public key and nothing else, is
# written again from it each time. Each goes through stdin, never a file or a command line. Admission lets only this
# user, the local kubeconfig's, write share-key (deploy/base/admission/website/share-key.yaml). The generator reads its
# key when it starts, so a new one restarts it; the app reads share-key as its own pull request says.
share-key: ## Give the traffic generator its signing key, made once, and the app its public half (the ConfigMap share-key)
	@for namespace in factory website; do $(call namespace,$$namespace) || exit 1; done
	@# Made only when the cluster says there is none: any other failure to read it stops here, and keeps the key.
	@made="$$($(KUBECTL) -n factory get secret share-signing-key -o name --ignore-not-found)" || exit 1; \
	if [ -z "$$made" ]; then \
		key="$$(node scripts/share-key.ts new)" && printf '%s\n' "$$key" | \
			$(KUBECTL) -n factory create secret generic share-signing-key --from-file=private-key=/dev/stdin >/dev/null && \
		$(KUBECTL) -n factory delete pod -l app.kubernetes.io/name=traffic --ignore-not-found >/dev/null && \
		echo "  The traffic generator has a new signing key, so it signs an id on each request."; fi
	@public="$$($(KUBECTL) -n factory get secret share-signing-key -o jsonpath='{.data.private-key}' | base64 -d | \
			node scripts/share-key.ts public)" && printf '%s\n' "$$public" | \
		$(KUBECTL) -n website create configmap share-key --from-file=public-key=/dev/stdin --dry-run=client -o yaml | \
		$(KUBECTL) apply -f - >/dev/null && echo "  The app has the generator's public key, in share-key."

# The GitHub worker's key for signing its refusals (apps/factory/src/github/refusals.ts): an Ed25519 key pair, made once,
# as share-key's is. The private key is the Secret refusal-signing-key in `factory`, which only the GitHub worker reads;
# once made, that Secret is the source, and the ConfigMap refusal-key in `factory`, its public key and nothing else, is
# written again from it each time, for the line to verify each refusal it records. Each goes through stdin, never a file
# or a command line. Admission lets only this user, the local kubeconfig's, write refusal-key
# (deploy/base/admission/factory/refusal-key.yaml). Each pod reads its key when it starts: a new Secret restarts the
# worker and the line, and a public key that was missing or not the Secret's restarts the line.
refusal-key: ## Give the GitHub worker its key for signing refusals, made once, and the line its public half (refusal-key)
	@$(call namespace,factory)
	@# Made only when the cluster says there is none: any other failure to read it stops here, and keeps the key.
	@made="$$($(KUBECTL) -n factory get secret refusal-signing-key -o name --ignore-not-found)" || exit 1; \
	if [ -z "$$made" ]; then \
		key="$$(node scripts/share-key.ts new)" && printf '%s\n' "$$key" | \
			$(KUBECTL) -n factory create secret generic refusal-signing-key --from-file=private-key=/dev/stdin >/dev/null || exit 1; \
	fi; \
	was="$$($(KUBECTL) -n factory get configmap refusal-key -o jsonpath='{.data.public-key}' --ignore-not-found)" || exit 1; \
	public="$$($(KUBECTL) -n factory get secret refusal-signing-key -o jsonpath='{.data.private-key}' | base64 -d | \
			node scripts/share-key.ts public)" && printf '%s\n' "$$public" | \
		$(KUBECTL) -n factory create configmap refusal-key --from-file=public-key=/dev/stdin --dry-run=client -o yaml | \
		$(KUBECTL) apply -f - >/dev/null && echo "  The line has the GitHub worker's public key, in refusal-key." || exit 1; \
	if [ -z "$$made" ]; then \
		$(KUBECTL) -n factory delete pod -l 'app.kubernetes.io/name in (github,line)' --ignore-not-found >/dev/null && \
		echo "  The GitHub worker has a new key, so it signs each refusal it answers."; \
	elif [ "$$was" != "$$public" ]; then \
		$(KUBECTL) -n factory delete pod -l app.kubernetes.io/name=line --ignore-not-found >/dev/null && \
		echo "  refusal-key was missing or not the GitHub worker's, so the line starts again with the right one."; fi

# Triage's caller token for the gateway's judgements (docs/COMPONENTS/LLM-GATEWAY.md#judgements): 32 random bytes in hex,
# made once, in the Secret judgements-token in `factory`, which only triage and the gateway name, through stdin and never
# a file or a command line. Both read it when they start and need it to start, so a new one restarts both: until then a
# triage with the old token is refused, and one waiting for the Secret starts with it.
judgements-token: ## Give triage and the gateway the token judgements take, made once
	@$(call namespace,factory)
	@# Made only when the cluster says there is none: any other failure to read it stops here, and keeps the token.
	@made="$$($(KUBECTL) -n factory get secret judgements-token -o name --ignore-not-found)" || exit 1; \
	if [ -z "$$made" ]; then \
		token="$$(openssl rand -hex 32)" && printf %s "$$token" | \
			$(KUBECTL) -n factory create secret generic judgements-token --from-file=token=/dev/stdin >/dev/null && \
		$(KUBECTL) -n factory delete pod -l 'app.kubernetes.io/name in (gateway,triage)' --ignore-not-found >/dev/null && \
		echo "  Triage and the gateway have a new judgements token, so triage's judgements are taken and no one else's."; fi

# A password for each worker's own role in the store, in a Secret of its own, made once: the migrate Job sets each role's
# password from it as Argo CD syncs. Each goes through stdin, never on a command line. On a cluster made before the
# workers had roles, run this before the deploy whose image brings their migration, or their roles have no password
# until the sync after it.
worker-secrets: ## Give each worker that uses the store a password for its own role
	@for worker in $(STORE_WORKERS); do \
		$(KUBECTL) -n factory get secret postgres-$$worker >/dev/null 2>&1 || \
			printf %s "$$(openssl rand -hex 24)" | \
			$(KUBECTL) -n factory create secret generic postgres-$$worker --from-file=password=/dev/stdin >/dev/null || \
			exit 1; \
	done

egress: ## Prove the fences: only the gateway, the GitHub worker and Kyverno leave the cluster; the scoreboard reaches Postgres alone, and no service account of ours may read its Secrets (needs the workers running)
	scripts/egress.sh

admission-ready: ## Say whether every image the guarded namespaces run is signed, so admission control can enforce
	scripts/admission-ready.sh

# All of the tests, whatever SHARD the shell or the command line says.
check: override SHARD :=
check: check-static check-tests ## Lint, type-check, test, build the browser code, check generated files are current, render the manifests

# CI runs the two halves of `make check` side by side, and the tests in parts (check.yml).
check-static: ## All of `make check` but the tests
	pnpm exec biome ci --error-on-warnings
	pnpm exec tsc
	pnpm exec tsc -p apps/console/web
	pnpm exec tsc -p apps/console/e2e
	node docs/design/system/build.ts --check
	node packages/samples/src/export.ts --check
	node apps/factory/src/alerts/rules.ts --check
	node apps/factory/src/release/analysis.ts --check
	pnpm --filter @software-factory/console build --logLevel warn
	node apps/console/scripts/budget.ts
	@# Argo CD renders each profile's overlay from main, so one that doesn't render must not get there.
	@for overlay in deploy/overlays/*/; do kustomize build $$overlay >/dev/null || exit 1; done

check-tests: ## The unit and database tests; SHARD=1/3 runs the first of three parts
	pnpm exec vitest run --project unit --project database $(if $(SHARD),--shard $(SHARD))

# The live tests' Postgres is the store tests' throwaway kind (packages/store/test/postgres.ts): its data goes with it,
# so it writes without waiting for the disk. UPDATE=1 runs no live test, so starts none. CPUS=1.5 gives the browsers
# as little CPU as CI's runner, and ARGS goes to Playwright, which then runs only the console's tests: ARGS='-g "<name>"'.
e2e: ## Run every browser test CI runs, in the pinned Playwright image beside a throwaway Postgres; UPDATE=1 rewrites the snapshots
	@set -e; net=software-factory-e2e-$$$$; db=$$net-postgres; url=; \
	trap 'docker rm -f -v $$db >/dev/null 2>&1 || true; docker network rm $$net >/dev/null 2>&1 || true' EXIT; \
	trap 'exit 129' HUP; trap 'exit 130' INT; trap 'exit 143' TERM; \
	docker network create $$net >/dev/null; \
	if [ -z "$(UPDATE)" ]; then \
		docker run -d --name $$db --network $$net -e POSTGRES_USER=factory -e POSTGRES_PASSWORD=test $(POSTGRES) \
			-c fsync=off -c synchronous_commit=off -c full_page_writes=off >/dev/null; \
		tries=0; until docker exec $$db psql -q -h 127.0.0.1 -U factory -c 'select 1' >/dev/null 2>&1; do \
			tries=$$((tries + 1)); [ $$tries -lt 240 ] || { echo "Postgres did not start in a minute" >&2; exit 1; }; sleep 0.25; done; \
		url=postgres://factory:test@$$db:5432/postgres; \
	fi; \
	docker run --rm --init --ipc=host --network $$net $(if $(CPUS),--cpus=$(CPUS)) -e UPDATE=$(UPDATE) \
		-e TEST_DATABASE_URL=$$url -v "$(CURDIR):/src:ro" \
		-v "$(CURDIR)/apps/console/e2e/snapshots:/out/snapshots" -v "$(CURDIR)/apps/console/e2e-results:/out/results" \
		$(PLAYWRIGHT) /src/apps/console/e2e/in-docker.sh $(ARGS)

zap: node_modules ## ZAP's baseline scan of the console with Martin's session, as CI runs it (Docker, and Playwright's Chromium)
	pnpm --filter @software-factory/console exec playwright install --only-shell chromium
	pnpm --filter @software-factory/console build --logLevel warn
	node apps/console/zap/scan.ts

eval: node_modules ## Run triage's evaluation set against Jev live, recording its cassettes; RUNS=3 shows the drift
	@TYPESAFE_API_KEY="$${TYPESAFE_API_KEY:-$$(security find-generic-password -s typesafe-api-key -w 2>/dev/null)}" \
		node apps/factory/scripts/eval.ts --runs $(or $(RUNS),1)

# The artifacts copier runs the Postgres image the cluster runs, read from its StatefulSet: the image's one pin.
define apply-artifacts-copier
sed "s|image: postgres$$|image: $$($(KUBECTL) -n factory get statefulset postgres -o jsonpath='{.spec.template.spec.containers[0].image}')|" \
	deploy/k3d/artifacts-copier.yaml | $(KUBECTL) apply -f - >/dev/null
endef

samples: node_modules ## Load the sample work items into the cluster's store, with their times moved so the last is now
	@# Screenshots first, into the artifacts volume, through a pod that mounts it for a moment (and not one still
	@# going from an earlier run).
	@$(KUBECTL) -n factory delete pod artifacts-copier --ignore-not-found --wait >/dev/null
	@$(apply-artifacts-copier)
	@$(KUBECTL) -n factory wait pod/artifacts-copier --for=condition=Ready --timeout=2m >/dev/null
	@# No macOS metadata files in the archive (COPYFILE_DISABLE); Linux ignores the setting.
	@COPYFILE_DISABLE=1 tar -C packages/samples/log/artifacts -cf - . | \
		$(KUBECTL) -n factory exec -i artifacts-copier -- tar -C /var/lib/factory/artifacts -xf -
	@$(KUBECTL) -n factory delete pod artifacts-copier --wait=false >/dev/null
	@# Then the events, as Martin, through a port-forward to Postgres: the samples hold his commands too.
	@$(call as-operator,ARTIFACTS_DIR=packages/samples/log/artifacts node apps/factory/src/cli.ts events load packages/samples/log)
	@echo "  Console  https://console.localhost:8443"

real-store: node_modules ## Replace the cluster's store with an empty one for real events (FORCE=1 if it holds some)
	@# As the database's owner, through a port-forward: only the owner may drop the schema.
	@$(KUBECTL) -n factory port-forward svc/postgres 15432:5432 >/dev/null 2>&1 & forward=$$!; \
		trap 'kill $$forward' EXIT; sleep 2; \
		PGHOST=127.0.0.1 PGPORT=15432 PGDATABASE=factory PGUSER=factory \
		PGPASSWORD="$$($(KUBECTL) -n factory get secret postgres -o jsonpath='{.data.password}' | base64 -d)" \
		node packages/store/src/real-store.ts $(if $(FORCE),--force)
	@# The samples' screenshots go too, and the console starts again from an empty history.
	@$(KUBECTL) -n factory delete pod artifacts-copier --ignore-not-found --wait >/dev/null
	@$(apply-artifacts-copier)
	@$(KUBECTL) -n factory wait pod/artifacts-copier --for=condition=Ready --timeout=2m >/dev/null
	@$(KUBECTL) -n factory exec artifacts-copier -- find /var/lib/factory/artifacts -mindepth 1 -delete
	@$(KUBECTL) -n factory delete pod artifacts-copier --wait=false >/dev/null
	@$(KUBECTL) -n factory rollout restart deployment/console >/dev/null
	@echo "  Console  https://console.localhost:8443"

stop-the-line: node_modules ## Stop the line: agents stop, workers take nothing new, a canary in flight aborts (REASON="...")
	@# Both halves run whichever fails: a canary is aborted even if the store cannot be reached, and the other way round.
	@{ $(call as-operator,node apps/factory/src/cli.ts line stop $(if $(REASON),--reason "$(REASON)")); } || failed=1; \
		KUBECTL="$(KUBECTL)" scripts/abort-canaries.sh || failed=1; exit $${failed:-0}

start-the-line: node_modules ## Start the line again; workers take what waited in the inbox (REASON="...")
	@$(call as-operator,node apps/factory/src/cli.ts line start $(if $(REASON),--reason "$(REASON)"))

# The proofs' role, through a port-forward of its own (as-martin's is 15432, which the drill's stop and start use), with
# its password from the Secret `make up` makes. Every proof is taken from this checkout, which must be main's head,
# clean; the drill asks first; nothing runs on a schedule (apps/factory/src/commands/guardrails.ts).
guardrails: node_modules ## Take every guardrail's proof but the attacks, and record each in the store, from a clean main (PROOFS="egress bypass" for some)
	@secret() { $(KUBECTL) -n factory get secret "$$1" -o jsonpath='{.data.password}' | base64 -d; }; \
	password="$$(secret postgres-proofs)" && [ -n "$$password" ] || { echo "No postgres-proofs Secret: run make up." >&2; exit 2; }; \
	{ $(KUBECTL) -n factory port-forward svc/postgres 15433:5432 >/dev/null 2>&1 & forward=$$!; \
	trap 'kill $$forward' EXIT; sleep 2; \
	PGHOST=127.0.0.1 PGPORT=15433 PGDATABASE=factory PGUSER=factory_proofs PGPASSWORD="$$password" KUBE_CONTEXT=$(CONTEXT) \
		node apps/factory/src/cli.ts guardrails $(foreach proof,$(PROOFS),--only $(proof)); }

enrol: node_modules ## Print a one-time code to enrol a passkey on the console (REVOKE_OTHERS=1: revoke every passkey and session first)
	@$(call as-martin,enrol,node apps/factory/src/cli.ts admin enrol $(if $(REVOKE_OTHERS),--revoke-others))

# The factory command runs on the host, so loading the samples needs the dependencies: installed on first use, and
# again when the lockfile changes.
node_modules: pnpm-lock.yaml
	pnpm install --frozen-lockfile
	@touch node_modules

status: ## Show what is running, and where to open it
	@if ! k3d cluster list $(CLUSTER) >/dev/null 2>&1; then echo "No cluster. Run 'make up'."; else \
		$(KUBECTL) -n argocd get applications -o custom-columns='APPLICATION:.metadata.name,SYNC:.status.sync.status,HEALTH:.status.health.status'; \
		echo; \
		echo "  Deployed from $$($(KUBECTL) -n argocd get application root -o jsonpath='{.spec.source.targetRevision}') at $$($(KUBECTL) -n argocd get application root -o jsonpath='{.status.sync.revision}' | cut -c1-7)"; \
		echo "  Console  https://console.localhost:8443  $$(curl -sf --cacert "$(LOCAL_CA)/ca.crt" https://console.localhost:8443/version || echo '(not up yet)')"; \
		echo "  Website  http://website.localhost:8080   $$(curl -sf http://website.localhost:8080/version || echo '(not up yet)')"; \
		echo "  Grafana  http://grafana.localhost:8080"; \
		echo "  Argo CD  http://argocd.localhost:8080    read-only; the admin password is in the argocd-initial-admin-secret Secret"; \
	fi
