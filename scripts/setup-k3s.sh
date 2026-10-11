#!/usr/bin/env bash
# Production host setup for Hydra Browsers (spec section 11.6). Run it as root from a checkout of
# this repository on the EC2 host:
#   sudo HYDRA_STATE_DIR=/var/lib/hydra HYDRA_MEDIA_PORT_RANGE=52000-52099 ./scripts/setup-k3s.sh
# Both variables are optional (the values above are the defaults). If HYDRA_MEDIA_PORT_RANGE is not
# the default, also set the same value as HYDRA_MEDIA_PORT_RANGE in the hydra-config of the prod
# overlay and patch the port range of the NetworkPolicy sessions-ingress-media there (and open the
# range in the security group of the instance, spec section 11.5): this script does not do it.
# The script is idempotent: run it again after a change, for example a new k3s pin in
# scripts/versions.sh.
# Sourcing this file only defines the functions (deploy/test/setup-k3s.test.sh does that).
set -euo pipefail

HYDRA_REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/versions.sh
. "$HYDRA_REPO_DIR/scripts/versions.sh"
# shellcheck source=deploy/lib/cluster.sh
. "$HYDRA_REPO_DIR/deploy/lib/cluster.sh"

HYDRA_STATE_DIR="${HYDRA_STATE_DIR:-/var/lib/hydra}"
HYDRA_MEDIA_PORT_RANGE="${HYDRA_MEDIA_PORT_RANGE:-52000-52099}"
K3S_CONFIG_FILE=/etc/rancher/k3s/config.yaml
SYSCTL_FILE=/etc/sysctl.d/90-kubelet.conf
SECCOMP_PROFILE="$HYDRA_REPO_DIR/deploy/session/seccomp/chromium.json"
KUBELET_SECCOMP_PROFILE=/var/lib/kubelet/seccomp/hydra/chromium.json
K3S_CONFIG_CHANGED=0

# The SHA-256 of install.sh at the k3s release tag K3S_INSTALL_SH_VERSION (spec section 3.4.5).
# When scripts/versions.sh changes K3S_VERSION, read the new install.sh and update both values
# (README.md, section "Update k3s"). deploy/test/setup-k3s.test.sh fails until then.
K3S_INSTALL_SH_VERSION="v1.36.5+k3s1"
K3S_INSTALL_SH_SHA256="46177d4c99440b4c0311b67233823a8e8a2fc09693f6c89af1a7161e152fbfad"

log() { printf '==> %s\n' "$*" >&2; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}
kubectl() { k3s kubectl "$@"; }

# The content of /etc/rancher/k3s/config.yaml.
render_k3s_config() { # STATE_DIR NODE_PORT_RANGE
  cat <<EOF
secrets-encryption: true
write-kubeconfig-mode: "0600"
default-local-storage-path: $1/volumes
protect-kernel-defaults: true
service-node-port-range: $2
EOF
}

# install.sh at the k3s release tag. The "+" of the tag must be encoded in the URL.
k3s_install_url() { # K3S_VERSION
  echo "https://raw.githubusercontent.com/k3s-io/k3s/${1//+/%2B}/install.sh"
}

# The gateway-data folder of the local-path volumes (spec section 5.2).
gateway_data_dir() { # STATE_DIR
  echo "$1/volumes/$HYDRA_GATEWAY_DATA_PATH"
}

# Prints an error and returns 1 unless STATE_DIR is a plain absolute path: it runs as root and is
# written into the k3s config unquoted, so no relative paths, "..", ".", "//", or YAML/shell
# characters. A "." segment is refused too: "/." is the root folder, and the script runs chmod on it.
validate_state_dir() { # STATE_DIR
  if [[ ! "$1" =~ ^/[A-Za-z0-9._/-]+$ || "$1" == *//* || "$1" == */ || "$1" == *..* ||
    "$1" == */./* || "$1" == */. ]]; then
    echo "HYDRA_STATE_DIR must be an absolute path of letters, digits, '.', '_', '-' and '/' with no '//', no trailing '/', no '..', and no '.' segment, got '$1'" >&2
    return 1
  fi
}

# Prints install, restart, or none.
k3s_action() { # INSTALLED_VERSION WANTED_VERSION CONFIG_CHANGED
  if [[ "$1" != "$2" ]]; then
    echo install
  elif [[ "$3" == 1 ]]; then
    echo restart
  else
    echo none
  fi
}

# Step 1: root on Debian or Ubuntu.
step_check_host() {
  [[ "$(id -u)" == 0 ]] || die 'run this script as root'
  [[ -r /etc/os-release ]] || die '/etc/os-release is missing'
  local os_id
  # shellcheck source=/dev/null
  os_id="$(. /etc/os-release && echo "${ID:-}")"
  case "$os_id" in
    debian | ubuntu) ;;
    *) die "this script supports Debian and Ubuntu, not '$os_id'" ;;
  esac
}

# Step 2: the kernel settings that protect-kernel-defaults needs (k3s hardening guide).
step_sysctls() {
  cat >"$SYSCTL_FILE" <<'EOF'
vm.panic_on_oom=0
vm.overcommit_memory=1
kernel.panic=10
kernel.panic_on_oops=1
EOF
  sysctl -p "$SYSCTL_FILE" >/dev/null
}

# Step 3: automatic security updates.
step_security_updates() {
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -q
  apt-get install -y -q --no-install-recommends unattended-upgrades curl ca-certificates
  cat >/etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
  systemctl enable --now unattended-upgrades.service >/dev/null
}

# Step 4: the state folder. The operator mounts the persistent volume here (spec section 11.5).
# Also the gateway-data folder, owned by the non-root gateway with mode 0700 (deploy/lib/cluster.sh).
step_state_dir() {
  local data_dir
  data_dir="$(gateway_data_dir "$HYDRA_STATE_DIR")"
  mkdir -p "$HYDRA_STATE_DIR"
  chmod 0700 "$HYDRA_STATE_DIR"
  if ! mountpoint -q "$HYDRA_STATE_DIR"; then
    warn "$HYDRA_STATE_DIR is not a mount point; mount the persistent volume there (spec 11.5)"
  fi
  mkdir -p "$data_dir"
  chown "$HYDRA_GATEWAY_UID:$HYDRA_GATEWAY_UID" "$data_dir"
  chmod 0700 "$data_dir"
}

# Step 5: the k3s config. Sets K3S_CONFIG_CHANGED to 1 if the file changed.
step_k3s_config() { # NODE_PORT_RANGE
  local wanted
  wanted="$(render_k3s_config "$HYDRA_STATE_DIR" "$1")"
  mkdir -p "$(dirname "$K3S_CONFIG_FILE")"
  if [[ -f "$K3S_CONFIG_FILE" && "$(cat "$K3S_CONFIG_FILE")" == "$wanted" ]]; then
    K3S_CONFIG_CHANGED=0
    return
  fi
  printf '%s\n' "$wanted" >"$K3S_CONFIG_FILE.tmp"
  chmod 0600 "$K3S_CONFIG_FILE.tmp"
  mv "$K3S_CONFIG_FILE.tmp" "$K3S_CONFIG_FILE"
  K3S_CONFIG_CHANGED=1
  log "wrote $K3S_CONFIG_FILE"
}

# Step 6: the Chromium seccomp profile of spike S1, if it exists.
step_seccomp() {
  if [[ -f "$SECCOMP_PROFILE" ]]; then
    install -D -m 0644 "$SECCOMP_PROFILE" "$KUBELET_SECCOMP_PROFILE"
    log "installed $KUBELET_SECCOMP_PROFILE"
  fi
}

# Step 7: k3s at the pinned version. install.sh checks the checksum of the k3s binary.
step_k3s() {
  local installed='' action tmp
  if command -v k3s >/dev/null 2>&1; then
    installed="$(k3s --version | awk 'NR == 1 { print $3 }')"
  fi
  action="$(k3s_action "$installed" "$K3S_VERSION" "$K3S_CONFIG_CHANGED")"
  case "$action" in
    none) log "k3s $K3S_VERSION is installed and its config did not change" ;;
    restart)
      log 'restarting k3s for the new config'
      systemctl restart k3s
      ;;
    install)
      log "installing k3s $K3S_VERSION"
      tmp="$(mktemp -d)"
      curl -fsSL --retry 3 -o "$tmp/install.sh" "$(k3s_install_url "$K3S_VERSION")"
      if ! echo "$K3S_INSTALL_SH_SHA256  $tmp/install.sh" | sha256sum -c --status -; then
        rm -rf "$tmp"
        die "install.sh of k3s $K3S_VERSION does not match K3S_INSTALL_SH_SHA256"
      fi
      INSTALL_K3S_VERSION="$K3S_VERSION" sh "$tmp/install.sh"
      rm -rf "$tmp"
      ;;
  esac
}

# Step 8: wait until the node is Ready.
step_wait_for_node() {
  for _ in $(seq 1 60); do
    if kubectl get nodes -o name 2>/dev/null | grep -q .; then
      break
    fi
    sleep 5
  done
  kubectl wait --for=condition=Ready nodes --all --timeout=300s
}

# Waits until a CRD of k3s exists and is established (the k3s helm controller creates
# helmchartconfigs.helm.cattle.io a little after the node is Ready). Same approach as
# scripts/dev-cluster.sh (this script stays self-contained).
wait_for_crd() { # NAME
  local _
  for _ in $(seq 1 90); do
    if kubectl get crd "$1" >/dev/null 2>&1; then
      break
    fi
    sleep 2
  done
  kubectl wait --for=condition=Established "crd/$1" --timeout=60s >/dev/null
}

# Step 11: the next steps for the operator.
step_next_steps() {
  local node_ip
  node_ip="$(kubectl get nodes -o jsonpath='{.items[0].status.addresses[?(@.type=="InternalIP")].address}')"
  cat <<EOF

k3s $K3S_VERSION is ready. Next steps (spec sections 6.1, 6.3, 11.8):
  1. Create the namespaces and the root key Secret. Keep a copy of the key in a secret store:
       kubectl apply -f $HYDRA_REPO_DIR/deploy/k8s/base/namespaces.yaml
       kubectl -n hydra create secret generic hydra-secret-key \\
         --from-literal=HYDRA_SECRET_KEY="\$(openssl rand -base64 32)"
  2. In deploy/k8s/overlays/prod/kustomization.yaml, set the hostnames, the Elastic IP, and the
     node IP $node_ip. If you set HYDRA_MEDIA_PORT_RANGE to a value other than 52000-52099, also
     set the same HYDRA_MEDIA_PORT_RANGE in the hydra-config of that overlay and patch the port
     range (port and endPort of the UDP and TCP entries) of the NetworkPolicy
     sessions-ingress-media there, and open the range in the security group (spec section 11.5).
     Run the release workflow and merge its pull request, so that the prod
     overlay has image digests. If the images on ghcr.io are private, give k3s a read token in
     /etc/rancher/k3s/registries.yaml.
  3. Apply the prod overlay:
       kubectl apply -k $HYDRA_REPO_DIR/deploy/k8s/overlays/prod
       kubectl -n hydra rollout status deploy/hydra-gateway
  4. Create the first admin:
       kubectl exec -it -n hydra deploy/hydra-gateway -- hydra user create --admin --email <email>
EOF
}

main() {
  step_check_host
  [[ "$K3S_VERSION" == "$K3S_INSTALL_SH_VERSION" ]] ||
    die "scripts/versions.sh pins k3s $K3S_VERSION, but K3S_INSTALL_SH_SHA256 is for $K3S_INSTALL_SH_VERSION: read the new install.sh and update both values in this script"
  validate_state_dir "$HYDRA_STATE_DIR" || exit 1
  local node_port_range
  node_port_range="$(hydra_node_port_range "$HYDRA_MEDIA_PORT_RANGE")"
  step_sysctls
  step_security_updates
  step_state_dir
  step_k3s_config "$node_port_range"
  step_seccomp
  step_k3s
  step_wait_for_node
  log 'step 9: applying the StorageClasses (the Traefik volume needs hydra-retain)'
  kubectl apply -f "$HYDRA_REPO_DIR/deploy/k8s/base/storageclasses.yaml"
  log 'step 10: applying the Traefik values'
  wait_for_crd helmchartconfigs.helm.cattle.io
  kubectl apply -f "$HYDRA_REPO_DIR/deploy/traefik/prod.yaml"
  step_next_steps
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
