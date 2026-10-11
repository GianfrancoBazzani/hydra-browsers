# shellcheck shell=bash
# Shared values and helpers of scripts/setup-k3s.sh and scripts/dev-cluster.sh (spec sections 5,
# 11.6, 11.7). Source this file. It defines values and functions only. It works with bash 3.2.

# The user of the hydra-gateway image (deploy/Dockerfile) and Deployment (deploy/k8s/base/gateway.yaml).
# shellcheck disable=SC2034 # used by the scripts that source this file
HYDRA_GATEWAY_UID=65532
# The folder of the gateway-data volume below the local-path storage folder (spec section 5.2). The
# scripts create it for the gateway user with mode 0700 before the PVC exists. local-path-provisioner
# keeps an existing folder (its setup script runs mkdir -p), so the non-root gateway owns
# HYDRA_DATA_DIR (spec section 5.1).
# shellcheck disable=SC2034 # used by the scripts that source this file
HYDRA_GATEWAY_DATA_PATH=hydra/gateway-data
# The lowest permitted first media port (spec section 4). The node ports 30000-30127 are for the
# fixed node ports of other Services: Traefik uses 30080, 30081, and 30082 (deploy/traefik/*.yaml).
HYDRA_MEDIA_PORT_MIN=30128

# Prints "FIRST LAST" for a media port range "FIRST-LAST", or fails with a message on stderr.
hydra_media_ports() {
  local range="$1"
  if [[ ! "$range" =~ ^([1-9][0-9]{0,4})-([1-9][0-9]{0,4})$ ]]; then
    echo "HYDRA_MEDIA_PORT_RANGE must look like 52000-52099, got '$range'" >&2
    return 1
  fi
  local first="${BASH_REMATCH[1]}" last="${BASH_REMATCH[2]}"
  if ((first < HYDRA_MEDIA_PORT_MIN)); then
    echo "the first port of HYDRA_MEDIA_PORT_RANGE must be $HYDRA_MEDIA_PORT_MIN or more, got '$range'" >&2
    return 1
  fi
  if ((last > 65535 || first > last)); then
    echo "HYDRA_MEDIA_PORT_RANGE must end at 65535 or less with FIRST <= LAST, got '$range'" >&2
    return 1
  fi
  echo "$first $last"
}

# Prints the k3s service-node-port-range for a media port range (spec section 11.6):
# 30000-<last media port>. kube-apiserver accepts only one range, so "30000-32767,52000-52099" is
# not valid. Kubernetes keeps the lowest 128 ports of this range (30000-30127) for fixed node ports
# and gives automatic node ports from the ports above them first, so each Service with node ports
# uses fixed node ports (Traefik: deploy/traefik/*.yaml; media Services: the orchestrator).
hydra_node_port_range() {
  local ports
  ports="$(hydra_media_ports "$1")" || return 1
  echo "30000-${ports#* }"
}
