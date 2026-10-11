#!/usr/bin/env bash
# Prints the state of the k3d cluster after a failed e2e run. It never fails.
# Usage: bash packages/e2e/scripts/diagnostics.sh
set -uo pipefail

context="${HYDRA_E2E_KUBE_CONTEXT:-k3d-hydra-dev}"

section() {
  echo "::group::$*"
  "$@" 2>&1
  echo "::endgroup::"
}

section kubectl --context "$context" get nodes -o wide
section kubectl --context "$context" get pods,statefulsets,services,persistentvolumeclaims -A -o wide
# The newest 300 events (sorted by time, oldest first).
echo "::group::kubectl --context $context get events -A --sort-by=.lastTimestamp | tail -n 300"
kubectl --context "$context" get events -A --sort-by=.lastTimestamp 2>&1 | tail -n 300
echo "::endgroup::"
section kubectl --context "$context" logs -n hydra deployment/hydra-gateway --tail=300
for pod in $(kubectl --context "$context" get pods -n hydra-sessions -o name 2>/dev/null); do
  section kubectl --context "$context" describe -n hydra-sessions "$pod"
  section kubectl --context "$context" logs -n hydra-sessions "$pod" --all-containers --tail=100
done
exit 0
