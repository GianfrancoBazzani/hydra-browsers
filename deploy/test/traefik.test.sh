#!/usr/bin/env bash
# Tests for deploy/traefik/*.yaml: bash deploy/test/traefik.test.sh
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

prod="$(cat "$HYDRA_REPO_DIR/deploy/traefik/prod.yaml")"
dev="$(cat "$HYDRA_REPO_DIR/deploy/traefik/dev.yaml")"
timeouts() { printf '%s\n' "$1" | grep -E '^ +(readTimeout|writeTimeout|idleTimeout):'; }

assert_eq 'same entry point timeouts in both files' "$(timeouts "$prod")" "$(timeouts "$dev")"

# node_port TEXT ENTRYPOINT : the nodePort value of one entry point (the line after "<name>:")
node_port() {
  printf '%s\n' "$1" | awk -v ep="      $2:" '
    $0 == ep { inside = 1; next }
    inside && /^        nodePort: / { print $2; exit }
    inside && /^      [^ ]/ { exit }
  '
}

check_both() { # NAME TEXT
  assert_eq "$1: no read timeout on web and websecure" '2' "$(count_lines "$2" 'readTimeout: "0s"')"
  assert_eq "$1: no write timeout on web and websecure" '2' "$(count_lines "$2" 'writeTimeout: "0s"')"
  assert_contains "$1: client IP is kept" "$2" 'externalTrafficPolicy: Local'
  assert_contains "$1: HelmChartConfig of the bundled Traefik" "$2" 'name: traefik'
  assert_eq "$1: fixed node port of web (spec 11.3)" '30080' "$(node_port "$2" web)"
  assert_eq "$1: fixed node port of websecure (spec 11.3)" '30081' "$(node_port "$2" websecure)"
  assert_contains "$1: fixed health check node port (spec 11.3)" "$2" 'healthCheckNodePort: 30082'
}
check_both prod "$prod"
check_both dev "$dev"

assert_contains 'prod: ACME resolver letsencrypt' "$prod" 'letsencrypt:'
assert_contains 'prod: HTTP-01 challenge on web' "$prod" 'entryPoint: web'
assert_contains 'prod: acme.json on a hydra-retain volume' "$prod" 'storageClass: hydra-retain'
assert_contains 'prod: redirect to HTTPS' "$prod" 'to: websecure'
assert_not_contains 'dev: no ACME' "$dev" 'certificatesResolvers'
assert_not_contains 'dev: no redirect' "$dev" 'redirections'
finish_tests
