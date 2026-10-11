#!/usr/bin/env bash
# Tests for scripts/setup-k3s.sh (the parts that run without root): bash deploy/test/setup-k3s.test.sh
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

assert_eq 'script syntax' 'ok' "$(bash -n "$HYDRA_REPO_DIR/scripts/setup-k3s.sh" && echo ok)"
# shellcheck source=scripts/setup-k3s.sh
. "$HYDRA_REPO_DIR/scripts/setup-k3s.sh"

assert_eq 'versions.sh: K3S_VERSION' 'yes' "$([[ "$K3S_VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+\+k3s[0-9]+$ ]] && echo yes)"
assert_eq 'install.sh hash is for the pinned k3s' "$K3S_VERSION" "$K3S_INSTALL_SH_VERSION"
assert_eq 'install.sh hash format' 'yes' "$([[ "$K3S_INSTALL_SH_SHA256" =~ ^[0-9a-f]{64}$ ]] && echo yes)"
assert_eq 'versions.sh: K3S_IMAGE has a digest' 'yes' "$([[ "$K3S_IMAGE" == *:*@sha256:* ]] && echo yes)"

expected='secrets-encryption: true
write-kubeconfig-mode: "0600"
default-local-storage-path: /var/lib/hydra/volumes
protect-kernel-defaults: true
service-node-port-range: 30000-52099'
assert_eq 'k3s config' "$expected" "$(render_k3s_config /var/lib/hydra "$(hydra_node_port_range 52000-52099)")"
assert_eq 'install.sh URL' 'https://raw.githubusercontent.com/k3s-io/k3s/v1.36.5%2Bk3s1/install.sh' \
  "$(k3s_install_url v1.36.5+k3s1)"
assert_eq 'gateway-data folder' '/var/lib/hydra/volumes/hydra/gateway-data' "$(gateway_data_dir /var/lib/hydra)"
assert_eq 'first install' 'install' "$(k3s_action '' v1.36.5+k3s1 1)"
assert_eq 'upgrade' 'install' "$(k3s_action v1.35.9+k3s1 v1.36.5+k3s1 0)"
assert_eq 'config change restarts k3s' 'restart' "$(k3s_action v1.36.5+k3s1 v1.36.5+k3s1 1)"
assert_eq 'no change, no restart' 'none' "$(k3s_action v1.36.5+k3s1 v1.36.5+k3s1 0)"
assert_eq 'sourcing does not run main' 'defined' "$(declare -F main >/dev/null && echo defined)"

# HYDRA_STATE_DIR runs as root and is written into the k3s YAML: only plain absolute paths.
assert_eq 'state dir: default accepted' 'ok' "$(validate_state_dir /var/lib/hydra >/dev/null 2>&1 && echo ok)"
assert_fails 'state dir: empty rejected' validate_state_dir ''
assert_fails 'state dir: / rejected' validate_state_dir /
assert_fails 'state dir: relative rejected' validate_state_dir relative
assert_fails 'state dir: .. rejected' validate_state_dir /a/../b
assert_fails 'state dir: // rejected' validate_state_dir /a//b
assert_fails 'state dir: trailing / rejected' validate_state_dir /a/b/
assert_fails 'state dir: newline rejected' validate_state_dir "$(printf '/var/lib/hy\ndra')"
assert_fails 'state dir: space rejected' validate_state_dir '/var/lib/my hydra'
assert_fails 'state dir: # rejected' validate_state_dir '/var/lib/a#b'
assert_fails 'state dir: single quote rejected' validate_state_dir "/var/lib/a'b"
assert_fails 'state dir: double quote rejected' validate_state_dir '/var/lib/a"b'
assert_fails 'state dir: /. rejected (chmod of the root folder)' validate_state_dir /.
assert_fails 'state dir: /a/./b rejected' validate_state_dir /a/./b
assert_fails 'state dir: trailing /. rejected' validate_state_dir /a/b/.
assert_fails 'state dir: leading /./ rejected' validate_state_dir /./a
assert_eq 'state dir: hidden folder accepted' 'ok' "$(validate_state_dir /var/lib/.hydra >/dev/null 2>&1 && echo ok)"
assert_eq 'state dir: dots inside a name accepted' 'ok' "$(validate_state_dir /var/lib/hydra.v1/a.b >/dev/null 2>&1 && echo ok)"

# Step 10 waits for the CRD of the Traefik values before the apply (the k3s helm controller creates it).
main_body="$(declare -f main)"
assert_contains 'step 10 waits for the HelmChartConfig CRD' "$main_body" 'wait_for_crd helmchartconfigs.helm.cattle.io'
wait_line="$(printf '%s\n' "$main_body" | grep -n 'wait_for_crd helmchartconfigs' | cut -d: -f1)"
apply_line="$(printf '%s\n' "$main_body" | grep -n 'deploy/traefik/prod.yaml' | cut -d: -f1)"
assert_eq 'the wait comes before the apply' 'yes' "$([[ -n "$wait_line" && -n "$apply_line" ]] && ((wait_line < apply_line)) && echo yes)"
assert_contains 'wait_for_crd waits until Established' "$(declare -f wait_for_crd)" '--for=condition=Established'
assert_contains 'next steps mention a non-default media range' "$(declare -f step_next_steps)" 'sessions-ingress-media'
finish_tests
