#!/usr/bin/env bash
# Local k3d cluster for development and the e2e tests (spec section 11.7): ./scripts/dev-cluster.sh
# Development on the host (pnpm dev): bash scripts/dev-cluster.sh dev (see dev_main below).
#
# It creates the cluster hydra-dev (pinned k3s image) and a local registry, applies the Traefik dev
# values, builds the four images, pushes them, writes deploy/k8s/overlays/dev/generated/, and
# applies the dev overlay with the gateway in the cluster. Run it again after a change: it keeps the
# cluster and the registry, deploys new images, and scales the in-cluster gateway back to 1 (pnpm dev
# scales it to 0). Remove everything:
#   k3d cluster delete hydra-dev && k3d registry delete k3d-hydra-registry
# HYDRA_MEDIA_BIND_ADDRESS (default 127.0.0.1, the plan 08 default) is the host address of the media ports
# (WebRTC). Docker Desktop for macOS does not forward UDP published on 127.0.0.1: use 0.0.0.0 there
# (it opens the media ports on all interfaces). It only affects a NEW cluster; an existing cluster
# keeps its mapping (a different value gives a warning). Port 80 always stays on 127.0.0.1.
# The load balancer idle timeout (settings.defaultProxyTimeout=3600) also applies only to a NEW
# cluster: an existing cluster keeps the 600 s default (delete and recreate it).
# Needs Docker, k3d (the version of scripts/versions.sh), kubectl, curl, git, and openssl.
# Sourcing this file only defines the functions (deploy/test/dev-cluster.test.sh does that).
# Works with bash 3.2 (macOS).
set -euo pipefail

HYDRA_REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/versions.sh
. "$HYDRA_REPO_DIR/scripts/versions.sh"
# shellcheck source=deploy/lib/cluster.sh
. "$HYDRA_REPO_DIR/deploy/lib/cluster.sh"

# The media port range of a NEW cluster: the environment variable, else the default. An existing
# cluster keeps the range it was created with (adopt_cluster_media_range in cluster_main).
DEFAULT_MEDIA_PORT_RANGE=52000-52099
REQUESTED_MEDIA_PORT_RANGE="${HYDRA_MEDIA_PORT_RANGE:-}"
HYDRA_MEDIA_PORT_RANGE="${HYDRA_MEDIA_PORT_RANGE:-$DEFAULT_MEDIA_PORT_RANGE}"
DEFAULT_MEDIA_BIND_ADDRESS=127.0.0.1
REQUESTED_MEDIA_BIND_ADDRESS="${HYDRA_MEDIA_BIND_ADDRESS:-}"
HYDRA_MEDIA_BIND_ADDRESS="${HYDRA_MEDIA_BIND_ADDRESS:-$DEFAULT_MEDIA_BIND_ADDRESS}"
CLUSTER_NAME=hydra-dev
KUBE_CONTEXT="k3d-$CLUSTER_NAME"
SERVER_NODE="k3d-$CLUSTER_NAME-server-0"
REGISTRY_NAME=hydra-registry
REGISTRY_CONTAINER="k3d-$REGISTRY_NAME"
REGISTRY_PORT=5111
# The host pushes to localhost:5111. The k3d node pulls k3d-hydra-registry:5111 (k3d writes this
# mirror into the k3s registries.yaml). Both names reach the same registry, so the digests match.
PUSH_REGISTRY="localhost:$REGISTRY_PORT"
CLUSTER_REGISTRY="$REGISTRY_CONTAINER:$REGISTRY_PORT"
GENERATED_DIR="$HYDRA_REPO_DIR/deploy/k8s/overlays/dev/generated"
SECCOMP_DIR="$HYDRA_REPO_DIR/deploy/session/seccomp"
# The default local-path storage folder of k3s inside the k3d node.
K3D_STORAGE_DIR=/var/lib/rancher/k3s/storage

log() { printf '==> %s\n' "$*" >&2; }
die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}
kc() { kubectl --context "$KUBE_CONTEXT" "$@"; }

# Reads `k3d version` output and prints the k3d version, for example v5.9.0.
parse_k3d_version() { sed -n 's/^k3d version \(v[^ ]*\).*/\1/p' | head -n 1; }

# Reads `curl -sI` headers of a registry manifest request and prints the digest.
parse_digest_header() { tr -d '\r' | awk 'tolower($1) == "docker-content-digest:" { print $2 }'; }

dev_image_tag() { # COMMIT DIRTY
  if [[ "$2" == 1 ]]; then echo "dev-$1-dirty"; else echo "dev-$1"; fi
}

# Succeeds if ADDRESS is an IPv4 dotted quad (four decimal numbers of 0 to 255).
is_ipv4_address() { # ADDRESS
  local octet
  [[ "$1" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || return 1
  while IFS= read -r octet; do
    ((10#$octet <= 255)) || return 1
  done < <(printf '%s\n' "${1//./$'\n'}")
}

check_media_bind_address() {
  is_ipv4_address "$HYDRA_MEDIA_BIND_ADDRESS" ||
    die "HYDRA_MEDIA_BIND_ADDRESS='$HYDRA_MEDIA_BIND_ADDRESS' is not an IPv4 address (for example 127.0.0.1 or 0.0.0.0)"
}

# The arguments of `k3d cluster create`, one per line. The media ports use HYDRA_MEDIA_BIND_ADDRESS.
# The k3d load balancer (nginx stream) cuts idle TCP connections after 600 s by default. Production
# has no such component, and the 10 min MCP stream test (spec 15.3) must verify the Traefik
# timeouts, not this one, so the dev cluster raises it to 1 h.
k3d_create_args() { # NODE_PORT_RANGE FIRST_MEDIA_PORT LAST_MEDIA_PORT WITH_SECCOMP
  local ports="$2-$3" bind="$HYDRA_MEDIA_BIND_ADDRESS"
  check_media_bind_address
  printf '%s\n' cluster create "$CLUSTER_NAME" \
    --image "$K3S_IMAGE" \
    --servers 1 \
    --agents 0 \
    --registry-use "$CLUSTER_REGISTRY" \
    --k3s-arg "--service-node-port-range=$1@server:0" \
    --port '127.0.0.1:80:80@loadbalancer' \
    --port "$bind:$ports:$ports/udp@server:0:direct" \
    --port "$bind:$ports:$ports/tcp@server:0:direct" \
    --lb-config-override settings.defaultProxyTimeout=3600 \
    --wait \
    --timeout 300s
  if [[ "$4" == 1 ]]; then
    printf '%s\n' --volume "$SECCOMP_DIR:/var/lib/kubelet/seccomp/hydra@server:0"
  fi
}

# The sh command that prepares the gateway-data folder in the k3d node (deploy/lib/cluster.sh).
gateway_data_command() {
  local dir="$K3D_STORAGE_DIR/$HYDRA_GATEWAY_DATA_PATH"
  echo "mkdir -p $dir && chown $HYDRA_GATEWAY_UID:$HYDRA_GATEWAY_UID $dir && chmod 0700 $dir"
}

wait_for_crd() { # NAME
  for _ in $(seq 1 90); do
    if kc get crd "$1" >/dev/null 2>&1; then
      break
    fi
    sleep 2
  done
  kc wait --for=condition=Established "crd/$1" --timeout=60s >/dev/null
}

# Step 1: tools and the k3d version.
step_check_tools() {
  local tool installed
  for tool in docker k3d kubectl curl git openssl; do
    command -v "$tool" >/dev/null 2>&1 || die "$tool is not installed"
  done
  docker info >/dev/null 2>&1 || die 'the Docker daemon does not run (start Docker Desktop)'
  installed="$(k3d version | parse_k3d_version)"
  [[ "$installed" == "$K3D_VERSION" ]] ||
    die "k3d $K3D_VERSION is necessary (scripts/versions.sh), found '${installed:-none}'"
}

# Step 2a: the local registry (pinned image, only on 127.0.0.1).
step_registry() {
  if docker container inspect "$REGISTRY_CONTAINER" >/dev/null 2>&1; then
    docker start "$REGISTRY_CONTAINER" >/dev/null
    return
  fi
  log "creating the registry $REGISTRY_CONTAINER"
  k3d registry create "$REGISTRY_NAME" --image "$K3D_REGISTRY_IMAGE" \
    --port "127.0.0.1:$REGISTRY_PORT" --enforce-port-match --no-help
}

# Step 2b: the cluster with the pinned k3s image, the node port range of setup-k3s.sh, the media
# ports on HYDRA_MEDIA_BIND_ADDRESS, and the seccomp profile if it exists.
step_cluster() { # NODE_PORT_RANGE
  local ports first last with_seccomp=0 line running
  local -a args=()
  ports="$(hydra_media_ports "$HYDRA_MEDIA_PORT_RANGE")"
  first="${ports% *}"
  last="${ports#* }"
  if [[ -f "$SECCOMP_DIR/chromium.json" ]]; then with_seccomp=1; fi
  if k3d cluster list "$CLUSTER_NAME" >/dev/null 2>&1; then
    k3d cluster start "$CLUSTER_NAME" >/dev/null
    running="$(docker exec "$SERVER_NODE" k3s --version | awk 'NR == 1 { print $3 }')"
    if [[ "$running" != "$K3S_VERSION" ]]; then
      die "the cluster runs k3s $running, not $K3S_VERSION: run 'k3d cluster delete $CLUSTER_NAME' and this script again"
    fi
    if [[ "$with_seccomp" == 1 ]] &&
      ! docker exec "$SERVER_NODE" test -f /var/lib/kubelet/seccomp/hydra/chromium.json; then
      die "the cluster has no seccomp profile: run 'k3d cluster delete $CLUSTER_NAME' and this script again"
    fi
    return
  fi
  log "creating the cluster $CLUSTER_NAME (k3s $K3S_VERSION)"
  while IFS= read -r line; do args+=("$line"); done < <(k3d_create_args "$1" "$first" "$last" "$with_seccomp")
  k3d "${args[@]}"
}

# Step 3: the Traefik dev values.
step_traefik() {
  wait_for_crd helmchartconfigs.helm.cattle.io
  kc apply -f "$HYDRA_REPO_DIR/deploy/traefik/dev.yaml"
}

image_digest() { # NAME TAG
  curl -fsSI \
    -H 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json' \
    "http://$PUSH_REGISTRY/v2/$1/manifests/$2" | parse_digest_header
}

# Builds and pushes one image, then prints NAME=DIGEST.
build_and_push() { # NAME DOCKERFILE TAG
  local ref="$PUSH_REGISTRY/$1:$3" digest
  log "building $1"
  docker build --file "$HYDRA_REPO_DIR/$2" --tag "$ref" "$HYDRA_REPO_DIR" >&2
  docker push "$ref" >&2
  digest="$(image_digest "$1" "$3")"
  [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || die "the registry has no digest for $ref"
  echo "$1=$digest"
}

# Step 4: images and the generated overlay files (spec section 3.4.4).
step_images() {
  local commit dirty=0 tag gateway session mcp testsite node_ip
  local -a range_args=()
  # The base overlay has the default range. Only another range needs the hydra-config value and the
  # NetworkPolicy ports (spec sections 4 and 11.4), so the default output stays the same.
  if [[ "$HYDRA_MEDIA_PORT_RANGE" != "$DEFAULT_MEDIA_PORT_RANGE" ]]; then
    range_args=(--media-port-range "$HYDRA_MEDIA_PORT_RANGE")
  fi
  commit="$(git -C "$HYDRA_REPO_DIR" rev-parse --short=12 HEAD)"
  if [[ -n "$(git -C "$HYDRA_REPO_DIR" status --porcelain)" ]]; then dirty=1; fi
  tag="$(dev_image_tag "$commit" "$dirty")"
  gateway="$(build_and_push hydra-gateway deploy/Dockerfile "$tag")"
  session="$(build_and_push hydra-session deploy/session/Dockerfile.session "$tag")"
  mcp="$(build_and_push hydra-mcp deploy/session/Dockerfile.mcp "$tag")"
  testsite="$(build_and_push hydra-testsite deploy/testsite/Dockerfile "$tag")"
  node_ip="$(kc get nodes -o jsonpath='{.items[0].status.addresses[?(@.type=="InternalIP")].address}')"
  mkdir -p "$GENERATED_DIR"
  bash "$HYDRA_REPO_DIR/deploy/k8s/write-overlay-component.sh" \
    --out "$GENERATED_DIR/kustomization.yaml" --registry "$CLUSTER_REGISTRY" --tag "$tag" \
    --image "$gateway" --image "$session" --image "$mcp" --image "$testsite" \
    --node-ip "$node_ip" ${range_args[@]+"${range_args[@]}"} --source 'scripts/dev-cluster.sh'
  log "wrote $GENERATED_DIR/kustomization.yaml (node IP $node_ip, media ports $HYDRA_MEDIA_PORT_RANGE)"
}

# Step 5: the dev overlay: the gateway (HYDRA_PUBLIC_IP=127.0.0.1) and the test site.
step_apply() {
  wait_for_crd ingressroutes.traefik.io
  kc apply -f "$HYDRA_REPO_DIR/deploy/k8s/base/namespaces.yaml"
  if ! kc -n hydra get secret hydra-secret-key >/dev/null 2>&1; then
    log 'creating the Secret hydra-secret-key with a new random key'
    kc -n hydra create secret generic hydra-secret-key \
      --from-literal=HYDRA_SECRET_KEY="$(openssl rand -base64 32)"
  fi
  docker exec "$SERVER_NODE" sh -c "$(gateway_data_command)"
  kc apply -k "$HYDRA_REPO_DIR/deploy/k8s/overlays/dev"
  # `pnpm dev` (scripts/dev-cluster.sh dev) scales the in-cluster gateway to 0. Bring it back.
  kc -n hydra scale deploy/hydra-gateway --replicas=1 >/dev/null
  kc -n hydra-testsite rollout status deploy/testsite --timeout=180s
  kc -n hydra-sessions rollout status ds/session-image-prepull --timeout=900s
  kc -n hydra rollout status deploy/hydra-gateway --timeout=300s
}

# An existing cluster keeps the media ports that k3d published at its creation, so its range is the
# effective range (a run without HYDRA_MEDIA_PORT_RANGE must not change it). cluster_media_range
# is defined below with dev_main. A different value in the environment is only a warning.
adopt_cluster_media_range() {
  local cluster_range
  cluster_range="$(cluster_media_range)" ||
    die "the node $SERVER_NODE publishes no media ports: run 'k3d cluster delete $CLUSTER_NAME' and this script again"
  hydra_media_ports "$cluster_range" >/dev/null || exit 1
  if [[ -n "$REQUESTED_MEDIA_PORT_RANGE" && "$REQUESTED_MEDIA_PORT_RANGE" != "$cluster_range" ]]; then
    log "warning: HYDRA_MEDIA_PORT_RANGE=$REQUESTED_MEDIA_PORT_RANGE is ignored: the cluster $CLUSTER_NAME publishes $cluster_range (run 'k3d cluster delete $CLUSTER_NAME' and this script again to change it)"
  fi
  HYDRA_MEDIA_PORT_RANGE="$cluster_range"
  log "media ports $HYDRA_MEDIA_PORT_RANGE (published by the existing cluster)"
  local cluster_address
  cluster_address="$(cluster_media_address 2>/dev/null)" || cluster_address=''
  if [[ -n "$REQUESTED_MEDIA_BIND_ADDRESS" && "$REQUESTED_MEDIA_BIND_ADDRESS" != "$cluster_address" ]]; then
    log "warning: HYDRA_MEDIA_BIND_ADDRESS=$REQUESTED_MEDIA_BIND_ADDRESS is ignored: the cluster $CLUSTER_NAME publishes the media ports on ${cluster_address:-an unknown address} (run 'k3d cluster delete $CLUSTER_NAME' and this script again to change it)"
  fi
}

cluster_main() {
  local node_port_range existed=0
  node_port_range="$(hydra_node_port_range "$HYDRA_MEDIA_PORT_RANGE")"
  step_check_tools
  check_media_bind_address
  step_registry
  if k3d cluster list "$CLUSTER_NAME" >/dev/null 2>&1; then existed=1; fi
  step_cluster "$node_port_range"
  if [[ "$existed" == 1 ]]; then adopt_cluster_media_range; fi
  step_traefik
  step_images
  step_apply
  cat <<EOF

The Hydra dev cluster is ready (kubectl context $KUBE_CONTEXT):
  dashboard  http://hydra.localhost
  live view  http://live.hydra.localhost
Create an admin:
  kubectl --context $KUBE_CONTEXT exec -it -n hydra deploy/hydra-gateway -- hydra user create --admin --email <email>
Stop pnpm dev before you run this script: it starts the in-cluster gateway again.
EOF
}

# Development on the host (spec sections 4 and 11.7). The root script `pnpm dev` (plan 01) runs
# `bash scripts/dev-cluster.sh dev`: the Vite dev server serves the dashboard, and the gateway runs
# on the host and reaches the session pods through Kubernetes port-forwards.
HOST_PUBLIC_URL=http://hydra.localhost:5173
HOST_LIVE_URL=http://live.hydra.localhost:8080
HOST_GATEWAY_PORT=8080
# The kubeconfig of only the k3d cluster (admin credentials): mode 0600, ignored by git and by the
# Docker build contexts. Thus the gateway on the host never uses another kubectl context.
HOST_KUBECONFIG="$GENERATED_DIR/kubeconfig"

# Prints the value of the literal NAME=VALUE of a generated overlay file, or nothing.
generated_literal() { # NAME FILE
  sed -n "s/^ *- $1=//p" "$2" | head -n 1
}

# The environment of the gateway on the host, one NAME=VALUE per line (without the root key).
host_gateway_env() { # SESSION_IMAGE MCP_IMAGE KUBECONFIG_FILE
  printf '%s\n' \
    "KUBECONFIG=$3" \
    HYDRA_SESSION_TRANSPORT=port-forward \
    "HYDRA_PUBLIC_URL=$HOST_PUBLIC_URL" \
    "HYDRA_LIVE_URL=$HOST_LIVE_URL" \
    HYDRA_PUBLIC_IP=127.0.0.1 \
    "HYDRA_MEDIA_PORT_RANGE=$HYDRA_MEDIA_PORT_RANGE" \
    "HYDRA_SESSION_IMAGE=$1" \
    "HYDRA_MCP_IMAGE=$2" \
    "PORT=$HOST_GATEWAY_PORT"
}

wait_for_no_gateway_pod() {
  for _ in $(seq 1 60); do
    if [[ -z "$(kc -n hydra get pods -l app=hydra-gateway -o name)" ]]; then
      return 0
    fi
    sleep 2
  done
  die 'the in-cluster gateway pod did not stop within 120 s'
}

# Reads the output of `docker port` of the k3d server node and prints FIRST-LAST, the media port
# range of the cluster: the longest run of consecutive TCP host ports of 30128 or more (the first
# media port allowed by hydra_media_ports). Other published ports are ignored. Prints nothing and
# fails if there is none. The cluster is the source of truth: it maps the ports at creation
# (k3d_create_args), so the gateway on the host must use the same range, whatever the environment says.
media_range_from_docker_port() {
  local range
  range="$(awk -v min="$HYDRA_MEDIA_PORT_MIN" '
    $1 ~ /^[0-9]+\/tcp$/ {
      n = split($NF, part, ":"); port = part[n] + 0
      if (port >= min) seen[port] = 1
    }
    END {
      for (port = min; port <= 65535; port++) {
        if (seen[port]) {
          if (!run) { start = port }
          run++
          if (run > best) { best = run; best_first = start; best_last = port }
        } else { run = 0 }
      }
      if (best) { print best_first "-" best_last }
    }')"
  [[ -n "$range" ]] || return 1
  echo "$range"
}

cluster_media_range() {
  docker port "$SERVER_NODE" | media_range_from_docker_port
}

# Reads the output of `docker port` and prints the host address of the first media TCP port (the
# first published TCP port of $HYDRA_MEDIA_PORT_MIN or more), for example 0.0.0.0.
media_address_from_docker_port() {
  local address
  address="$(awk -v min="$HYDRA_MEDIA_PORT_MIN" '
    $1 ~ /^[0-9]+\/tcp$/ {
      n = split($NF, part, ":"); port = part[n] + 0
      if (port >= min) { print substr($NF, 1, length($NF) - length(part[n]) - 1); exit }
    }')"
  [[ -n "$address" ]] || return 1
  echo "$address"
}

cluster_media_address() {
  docker port "$SERVER_NODE" | media_address_from_docker_port
}

# dev [COMMAND [ARGUMENT...]]: the k3d part of `pnpm dev` (spec section 11.7). It scales the
# in-cluster gateway to 0, sets the variables of the gateway on the host (the media port range comes
# from the cluster, not from the environment), and runs COMMAND from the
# repository root. The default COMMAND runs the dev scripts of @hydra/server (tsx watch, port 8080)
# and @hydra/web (Vite, port 5173) in the foreground. Another COMMAND gets the same variables, for
# example the CLI for the database of the gateway on the host:
#   bash scripts/dev-cluster.sh dev pnpm --filter @hydra/server run hydra user create --admin --email <email>
# The gateway on the host keeps its own database in packages/server/.data (default HYDRA_DATA_DIR).
# ./scripts/dev-cluster.sh (no argument) starts the in-cluster gateway again.
dev_main() {
  local tool session_image mcp_image secret_key line generated="$GENERATED_DIR/kustomization.yaml"
  if (($# == 0)); then
    set -- pnpm --parallel --filter @hydra/server --filter @hydra/web run dev
  fi
  for tool in docker k3d kubectl openssl "$1"; do
    command -v "$tool" >/dev/null 2>&1 || die "$tool is not installed"
  done
  docker info >/dev/null 2>&1 || die 'the Docker daemon does not run (start Docker Desktop)'
  k3d cluster list "$CLUSTER_NAME" >/dev/null 2>&1 ||
    die "the cluster $CLUSTER_NAME does not exist: run ./scripts/dev-cluster.sh first"
  [[ -f "$generated" ]] || die "$generated is missing: run ./scripts/dev-cluster.sh first"
  session_image="$(generated_literal HYDRA_SESSION_IMAGE "$generated")"
  mcp_image="$(generated_literal HYDRA_MCP_IMAGE "$generated")"
  [[ -n "$session_image" && -n "$mcp_image" ]] || die "$generated has no image values"
  k3d cluster start "$CLUSTER_NAME" >/dev/null
  # The range of the cluster, not the environment (the cluster maps these ports on 127.0.0.1).
  HYDRA_MEDIA_PORT_RANGE="$(cluster_media_range)" ||
    die "the node $SERVER_NODE publishes no media ports: delete the cluster and run ./scripts/dev-cluster.sh again"
  hydra_media_ports "$HYDRA_MEDIA_PORT_RANGE" >/dev/null || exit 1
  log "media ports $HYDRA_MEDIA_PORT_RANGE (published by the cluster)"
  (umask 077 && k3d kubeconfig get "$CLUSTER_NAME" >"$HOST_KUBECONFIG.tmp")
  mv "$HOST_KUBECONFIG.tmp" "$HOST_KUBECONFIG"
  export KUBECONFIG="$HOST_KUBECONFIG"
  log 'scaling the in-cluster gateway to 0 (spec section 11.7)'
  kc -n hydra scale deploy/hydra-gateway --replicas=0 >/dev/null
  wait_for_no_gateway_pod
  # The root key of the dev cluster, so the Neko passwords of existing session Secrets still match.
  secret_key="$(kc -n hydra get secret hydra-secret-key -o jsonpath='{.data.HYDRA_SECRET_KEY}' | openssl base64 -d -A)"
  [[ -n "$secret_key" ]] || die 'the Secret hydra-secret-key in hydra has no HYDRA_SECRET_KEY'
  while IFS= read -r line; do
    export "${line?}"
  done < <(host_gateway_env "$session_image" "$mcp_image" "$HOST_KUBECONFIG")
  export HYDRA_SECRET_KEY="$secret_key"
  log "dashboard $HOST_PUBLIC_URL (Vite), live view $HOST_LIVE_URL (gateway on the host)"
  cd "$HYDRA_REPO_DIR"
  exec "$@"
}

main() {
  case "${1:-}" in
    '') cluster_main ;;
    dev)
      shift
      dev_main "$@"
      ;;
    *) die "usage: $0 [dev [COMMAND [ARGUMENT...]]]" ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
