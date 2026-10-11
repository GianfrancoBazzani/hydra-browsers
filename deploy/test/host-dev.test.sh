#!/usr/bin/env bash
# Tests for `scripts/dev-cluster.sh dev`, the k3d part of `pnpm dev` (spec sections 4 and 11.7), and
# for its contracts with plans 01 and 07: bash deploy/test/host-dev.test.sh (needs node and git)
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
unset HYDRA_MEDIA_PORT_RANGE
# shellcheck source=scripts/dev-cluster.sh
. "$HYDRA_REPO_DIR/scripts/dev-cluster.sh"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cat >"$work/kustomization.yaml" <<'YAML'
configMapGenerator:
  - name: hydra-images
    namespace: hydra
    literals:
      - HYDRA_SESSION_IMAGE=k3d-hydra-registry:5111/hydra-session:dev-a@sha256:22
      - HYDRA_MCP_IMAGE=k3d-hydra-registry:5111/hydra-mcp:dev-a@sha256:33
YAML
assert_eq 'session image of the generated overlay' 'k3d-hydra-registry:5111/hydra-session:dev-a@sha256:22' \
  "$(generated_literal HYDRA_SESSION_IMAGE "$work/kustomization.yaml")"
assert_eq 'MCP image of the generated overlay' 'k3d-hydra-registry:5111/hydra-mcp:dev-a@sha256:33' \
  "$(generated_literal HYDRA_MCP_IMAGE "$work/kustomization.yaml")"
assert_eq 'a missing value is empty' '' "$(generated_literal HYDRA_OTHER "$work/kustomization.yaml")"

expected='KUBECONFIG=/x/kubeconfig
HYDRA_SESSION_TRANSPORT=port-forward
HYDRA_PUBLIC_URL=http://hydra.localhost:5173
HYDRA_LIVE_URL=http://live.hydra.localhost:8080
HYDRA_PUBLIC_IP=127.0.0.1
HYDRA_MEDIA_PORT_RANGE=52000-52099
HYDRA_SESSION_IMAGE=s@sha256:1
HYDRA_MCP_IMAGE=m@sha256:2
PORT=8080'
assert_eq 'environment of the gateway on the host (spec 4, 11.7)' "$expected" \
  "$(host_gateway_env s@sha256:1 m@sha256:2 /x/kubeconfig)"
assert_eq 'kubeconfig in the generated folder' \
  "$HYDRA_REPO_DIR/deploy/k8s/overlays/dev/generated/kubeconfig" "$HOST_KUBECONFIG"
assert_eq 'git ignores the kubeconfig' 'yes' \
  "$(git -C "$HYDRA_REPO_DIR" check-ignore -q deploy/k8s/overlays/dev/generated/kubeconfig && echo yes || echo no)"
# The media range comes from the ports that the cluster publishes (no Docker needed: sample text).
sample_ports="$(printf '%s\n' '80/tcp -> 127.0.0.1:80' '6443/tcp -> 0.0.0.0:55767' '8443/tcp -> [::]:8443')"
for port in 52100 52101 52102 52103 52198 52199; do
  sample_ports="$sample_ports
$port/tcp -> 127.0.0.1:$port
$port/udp -> 127.0.0.1:$port"
done
assert_eq 'range of the cluster with other ports (non-default range)' '52100-52103' \
  "$(printf '%s\n' "$sample_ports" | grep -v '^5219' | media_range_from_docker_port)"
full_ports="$(for port in $(seq 52000 52099); do printf '%s\n' "$port/tcp -> 127.0.0.1:$port" "$port/udp -> 127.0.0.1:$port"; done)"
assert_eq 'range of the cluster, default range' '52000-52099' \
  "$(printf '6443/tcp -> 0.0.0.0:55767\n%s\n' "$full_ports" | media_range_from_docker_port)"
full_ports="$(for port in $(seq 52100 52199); do printf '%s\n' "$port/tcp -> 127.0.0.1:$port" "$port/udp -> 127.0.0.1:$port"; done)"
assert_eq 'range of the cluster, 100 ports from 52100' '52100-52199' \
  "$(printf '80/tcp -> 127.0.0.1:80\n6443/tcp -> 0.0.0.0:55767\n%s\n' "$full_ports" | media_range_from_docker_port)"
assert_fails 'no media ports published is an error' bash -c \
  ". '$HYDRA_REPO_DIR/scripts/dev-cluster.sh'; printf '80/tcp -> 127.0.0.1:80\n' | media_range_from_docker_port"
assert_fails 'empty input is an error' bash -c \
  ". '$HYDRA_REPO_DIR/scripts/dev-cluster.sh'; media_range_from_docker_port </dev/null"
dev_body="$(declare -f dev_main)"
assert_contains 'dev_main takes the media range from the cluster' "$dev_body" '"$(cluster_media_range)"'

assert_contains 'default command runs both dev scripts' "$dev_body" \
  'pnpm --parallel --filter @hydra/server --filter @hydra/web run dev'
assert_contains 'scales the in-cluster gateway to 0' "$dev_body" 'scale deploy/hydra-gateway --replicas=0'
assert_contains 'main has the dev subcommand' "$(declare -f main)" 'dev_main'

# Contracts with plan 01 (root and server dev scripts) and plan 07 (Vite dev server).
script_of() { node -p "require('$HYDRA_REPO_DIR/$1').scripts.dev ?? ''"; }
assert_eq 'root pnpm dev calls this subcommand (plan 01)' 'bash scripts/dev-cluster.sh dev' \
  "$(script_of package.json)"
assert_eq 'server dev script (plan 01, index 2.1)' 'tsx watch --conditions=@hydra/source src/main.ts' \
  "$(script_of packages/server/package.json)"
assert_eq 'web dev script (plan 07)' 'vite' "$(script_of packages/web/package.json)"
vite_config="$(cat "$HYDRA_REPO_DIR/packages/web/vite.config.ts")"
assert_contains 'Vite listens on the port of HYDRA_PUBLIC_URL' "$vite_config" "port: ${HOST_PUBLIC_URL##*:},"
assert_contains 'Vite proxies to the gateway on the host' "$vite_config" "'http://127.0.0.1:$HOST_GATEWAY_PORT'"
assert_eq 'the live URL is the gateway port' "$HOST_GATEWAY_PORT" "${HOST_LIVE_URL##*:}"
finish_tests
