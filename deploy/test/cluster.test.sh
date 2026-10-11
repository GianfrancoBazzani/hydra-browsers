#!/usr/bin/env bash
# Tests for deploy/lib/cluster.sh: bash deploy/test/cluster.test.sh
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
. "$HYDRA_REPO_DIR/deploy/lib/cluster.sh"

assert_eq 'default media range (spec 11.6)' '30000-52099' "$(hydra_node_port_range 52000-52099)"
assert_eq 'lowest permitted media range' '30000-30227' "$(hydra_node_port_range 30128-30227)"
assert_eq 'range ends at the last media port' '30000-31009' "$(hydra_node_port_range 31000-31009)"
assert_eq 'media ports' '52000 52099' "$(hydra_media_ports 52000-52099)"
assert_fails 'first port below 30128 is rejected (spec 4)' hydra_node_port_range 30127-30200
assert_fails 'range below 30000 is rejected' hydra_node_port_range 20000-20099
assert_fails 'privileged port is rejected' hydra_node_port_range 80-90
assert_fails 'leading zero is rejected' hydra_node_port_range 052000-052099
assert_fails 'comma list is rejected' hydra_node_port_range 30000-32767,52000-52099
assert_fails 'missing last port is rejected' hydra_node_port_range 52000
assert_fails 'reversed range is rejected' hydra_node_port_range 52099-52000
assert_fails 'port above 65535 is rejected' hydra_node_port_range 65000-65536
assert_fails 'empty value is rejected' hydra_node_port_range ''
assert_eq 'lowest first media port of spec 4' '30128' "$HYDRA_MEDIA_PORT_MIN"
assert_eq 'gateway user' '65532' "$HYDRA_GATEWAY_UID"
assert_eq 'gateway-data folder of spec 5.2' 'hydra/gateway-data' "$HYDRA_GATEWAY_DATA_PATH"
finish_tests
