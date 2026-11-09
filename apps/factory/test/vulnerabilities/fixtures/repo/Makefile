ARGOCD_CHART := 9.0.0

up:
	helm upgrade --install argocd argo-cd --repo https://argoproj.github.io/argo-helm --version $(ARGOCD_CHART) \
		--namespace argocd --create-namespace \
		--values deploy/argocd/values.yaml --wait
