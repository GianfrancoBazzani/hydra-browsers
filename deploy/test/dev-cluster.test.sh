#!/usr/bin/env bash
# Tests for scripts/dev-cluster.sh (the parts that run without Docker): bash deploy/test/dev-cluster.test.sh
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

assert_eq 'script syntax' 'ok' "$(bash -n "$HYDRA_REPO_DIR/scripts/dev-cluster.sh" && echo ok)"
# shellcheck source=scripts/dev-cluster.sh
. "$HYDRA_REPO_DIR/scripts/dev-cluster.sh"

assert_eq 'versions.sh: K3D_VERSION' 'yes' "$([[ "$K3D_VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] && echo yes)"
assert_eq 'versions.sh: K3D_REGISTRY_IMAGE has a digest' 'yes' "$([[ "$K3D_REGISTRY_IMAGE" == *:*@sha256:* ]] && echo yes)"
assert_eq 'k3d version' 'v5.9.0' "$(printf 'k3d version v5.9.0\nk3s version v1.31.5-k3s1 (default)\n' | parse_k3d_version)"
assert_eq 'digest header' 'sha256:abc' "$(printf 'HTTP/1.1 200 OK\r\nDocker-Content-Digest: sha256:abc\r\n\r\n' | parse_digest_header)"
assert_eq 'clean tag' 'dev-0123456789ab' "$(dev_image_tag 0123456789ab 0)"
assert_eq 'dirty tag' 'dev-0123456789ab-dirty' "$(dev_image_tag 0123456789ab 1)"

create_args="$(k3d_create_args 30000-52099 52000 52099 0)"
assert_contains 'pinned k3s image' "$create_args" "$K3S_IMAGE"
assert_contains 'local registry' "$create_args" 'k3d-hydra-registry:5111'
assert_contains 'node port range of setup-k3s.sh' "$create_args" '--service-node-port-range=30000-52099@server:0'
assert_contains 'HTTP port' "$create_args" '127.0.0.1:80:80@loadbalancer'
assert_contains 'media ports UDP' "$create_args" '127.0.0.1:52000-52099:52000-52099/udp@server:0:direct'
assert_contains 'media ports TCP' "$create_args" '127.0.0.1:52000-52099:52000-52099/tcp@server:0:direct'
assert_contains 'load balancer idle timeout above the 10 min stream test' "$create_args" 'settings.defaultProxyTimeout=3600'
assert_not_contains 'no seccomp mount without a profile' "$create_args" '/var/lib/kubelet/seccomp/hydra'
create_args="$(k3d_create_args 30000-52099 52000 52099 1)"
assert_contains 'seccomp mount with a profile' "$create_args" 'seccomp:/var/lib/kubelet/seccomp/hydra@server:0'
assert_eq 'gateway-data folder for the non-root gateway' \
  'mkdir -p /var/lib/rancher/k3s/storage/hydra/gateway-data && chown 65532:65532 /var/lib/rancher/k3s/storage/hydra/gateway-data && chmod 0700 /var/lib/rancher/k3s/storage/hydra/gateway-data' \
  "$(gateway_data_command)"
assert_eq 'default media bind address' '127.0.0.1' "$HYDRA_MEDIA_BIND_ADDRESS"
# HYDRA_MEDIA_BIND_ADDRESS changes only the media-port mappings (Docker Desktop for macOS needs 0.0.0.0).
bind_args() { # ADDRESS : the create args with that media bind address
  bash -c ". '$HYDRA_REPO_DIR/scripts/dev-cluster.sh'; HYDRA_MEDIA_BIND_ADDRESS='$1'; k3d_create_args 30000-52099 52000 52099 0"
}
wide_args="$(bind_args 0.0.0.0)"
assert_contains 'wide bind: media ports UDP' "$wide_args" '0.0.0.0:52000-52099:52000-52099/udp@server:0:direct'
assert_contains 'wide bind: media ports TCP' "$wide_args" '0.0.0.0:52000-52099:52000-52099/tcp@server:0:direct'
assert_contains 'wide bind: HTTP stays on 127.0.0.1' "$wide_args" '127.0.0.1:80:80@loadbalancer'
assert_not_contains 'wide bind: no media port on 127.0.0.1' "$wide_args" '127.0.0.1:52000'
assert_fails 'a hostname is not a bind address' bash -c "$(declare -f bind_args); HYDRA_REPO_DIR='$HYDRA_REPO_DIR'; bind_args localhost"
assert_fails 'an octet above 255 is not a bind address' bash -c "$(declare -f bind_args); HYDRA_REPO_DIR='$HYDRA_REPO_DIR'; bind_args 256.0.0.1"
assert_fails 'a port is not part of the bind address' bash -c "$(declare -f bind_args); HYDRA_REPO_DIR='$HYDRA_REPO_DIR'; bind_args 0.0.0.0:1"
assert_fails 'an empty value after set is not a bind address' bash -c "$(declare -f bind_args); HYDRA_REPO_DIR='$HYDRA_REPO_DIR'; bind_args ''"
assert_contains 'cluster_main validates the bind address' "$(declare -f cluster_main)" 'check_media_bind_address'
assert_eq 'sourcing does not run main' 'defined' "$(declare -F main >/dev/null && echo defined)"

# An existing cluster keeps its media range (spec section 11.7): the cluster is the source of truth.
adopt() { # REQUESTED_RANGE : prints the log lines, then the effective range
  bash -c ". '$HYDRA_REPO_DIR/scripts/dev-cluster.sh'; cluster_media_range() { echo 52100-52199; };
    REQUESTED_MEDIA_PORT_RANGE='$1'; adopt_cluster_media_range 2>&1; echo \"range=\$HYDRA_MEDIA_PORT_RANGE\""
}
out="$(adopt '')"
assert_contains 'no variable: the existing cluster range is used' "$out" 'range=52100-52199'
assert_contains 'no variable: the range is logged' "$out" 'media ports 52100-52199 (published by the existing cluster)'
assert_not_contains 'no variable: no warning' "$out" 'warning'
out="$(adopt 52100-52199)"
assert_not_contains 'same variable: no warning' "$out" 'warning'
out="$(adopt 52000-52099)"
assert_contains 'other variable: warning' "$out" 'warning: HYDRA_MEDIA_PORT_RANGE=52000-52099 is ignored'
assert_contains 'other variable: the cluster range wins' "$out" 'range=52100-52199'
assert_fails 'a cluster without media ports is an error' bash -c \
  ". '$HYDRA_REPO_DIR/scripts/dev-cluster.sh'; cluster_media_range() { return 1; }; adopt_cluster_media_range"
# The bind address of an existing cluster comes from docker port; a different value only warns.
adopt_address() { # REQUESTED_ADDRESS
  bash -c ". '$HYDRA_REPO_DIR/scripts/dev-cluster.sh'; cluster_media_range() { echo 52100-52199; };
    cluster_media_address() { echo 127.0.0.1; };
    REQUESTED_MEDIA_BIND_ADDRESS='$1'; adopt_cluster_media_range 2>&1"
}
assert_not_contains 'no bind address variable: no warning' "$(adopt_address '')" 'warning'
assert_not_contains 'same bind address: no warning' "$(adopt_address 127.0.0.1)" 'warning'
assert_contains 'other bind address: warning' "$(adopt_address 0.0.0.0)" 'warning: HYDRA_MEDIA_BIND_ADDRESS=0.0.0.0 is ignored'
assert_eq 'address of the media ports from docker port' '0.0.0.0' "$(printf '%s\n' '80/tcp -> 127.0.0.1:80' '52100/tcp -> 0.0.0.0:52100' '52100/udp -> 0.0.0.0:52100' | media_address_from_docker_port)"
assert_contains 'cluster_main adopts the range of an existing cluster' "$(declare -f cluster_main)" 'adopt_cluster_media_range'
assert_eq 'the default range is the old default' '52000-52099' "$DEFAULT_MEDIA_PORT_RANGE"
images_body="$(declare -f step_images)"
assert_contains 'step_images passes the range only if it is not the default' "$images_body" \
  '[[ "$HYDRA_MEDIA_PORT_RANGE" != "$DEFAULT_MEDIA_PORT_RANGE" ]]'
assert_contains 'step_images passes --media-port-range' "$images_body" '--media-port-range "$HYDRA_MEDIA_PORT_RANGE"'
finish_tests
