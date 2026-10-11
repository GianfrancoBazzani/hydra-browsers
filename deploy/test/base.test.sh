#!/usr/bin/env bash
# Tests for deploy/k8s/base: bash deploy/test/base.test.sh (needs kubectl for `kubectl kustomize`)
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
# shellcheck source=deploy/lib/cluster.sh
. "$HYDRA_REPO_DIR/deploy/lib/cluster.sh"

# rule_verbs ROLE_TEXT RESOURCE : the verbs of the Role rule that lists RESOURCE, on one line
rule_verbs() {
  printf '%s\n' "$1" | awk -v res="$2" '
    function flush() { if (hit) print verbs; verbs = ""; hit = 0; section = "" }
    /^- apiGroups:/ { flush(); section = "apiGroups"; next }
    /^  resources:/ { section = "resources"; next }
    /^  verbs:/ { section = "verbs"; next }
    /^  - / {
      item = substr($0, 5)
      if (section == "resources" && item == res) hit = 1
      if (section == "verbs") verbs = verbs (verbs == "" ? "" : " ") item
    }
    END { flush() }
  '
}

out="$(kubectl kustomize "$HYDRA_REPO_DIR/deploy/k8s/base")"

ns_hydra="$(k8s_doc "$out" Namespace hydra)"
assert_contains 'hydra is restricted' "$ns_hydra" 'pod-security.kubernetes.io/enforce: restricted'
ns_sessions="$(k8s_doc "$out" Namespace hydra-sessions)"
assert_contains 'hydra-sessions is baseline' "$ns_sessions" 'pod-security.kubernetes.io/enforce: baseline'

for class in hydra-retain hydra-profile; do
  sc="$(k8s_doc "$out" StorageClass "$class")"
  assert_contains "$class uses local-path" "$sc" 'provisioner: rancher.io/local-path'
  assert_contains "$class has the fixed path pattern" "$sc" "pathPattern: '{{ .PVC.Namespace }}/{{ .PVC.Name }}/'"
done
assert_contains 'hydra-retain retains' "$(k8s_doc "$out" StorageClass hydra-retain)" 'reclaimPolicy: Retain'
assert_contains 'hydra-profile deletes' "$(k8s_doc "$out" StorageClass hydra-profile)" 'reclaimPolicy: Delete'

role="$(k8s_doc "$out" Role hydra-gateway)"
assert_contains 'Role is in hydra-sessions' "$role" 'namespace: hydra-sessions'
assert_contains 'Role can read pod logs' "$role" '- pods/log'
assert_not_contains 'no port-forward right' "$out" 'pods/portforward'
assert_not_contains 'no exec right' "$out" 'pods/exec'
assert_not_contains 'no ClusterRole' "$out" 'kind: ClusterRole'
all_verbs='get list watch create update patch delete deletecollection'
for resource in statefulsets services configmaps secrets persistentvolumeclaims; do
  assert_eq "all verbs on $resource" "$all_verbs" "$(rule_verbs "$role" "$resource")"
done
assert_eq 'pods are read-only' 'get list watch' "$(rule_verbs "$role" pods)"
assert_eq 'pod logs are get only' 'get' "$(rule_verbs "$role" pods/log)"

gw="$(k8s_doc "$out" Deployment hydra-gateway)"
assert_contains 'one replica' "$gw" 'replicas: 1'
assert_contains 'Recreate strategy' "$gw" 'type: Recreate'
assert_contains 'pod label for the session ingress rule' "$gw" 'app: hydra-gateway'
assert_contains 'data volume' "$gw" 'claimName: gateway-data'
assert_contains 'HYDRA_DATA_DIR is the volume' "$gw" 'value: /data'
assert_contains 'secret key from the Secret' "$gw" 'name: hydra-secret-key'
assert_contains 'images from hydra-images' "$gw" 'name: hydra-images'
assert_contains 'liveness probe' "$gw" 'path: /healthz'
assert_contains 'readiness probe' "$gw" 'path: /readyz'
assert_contains 'read-only root filesystem' "$gw" 'readOnlyRootFilesystem: true'
assert_contains 'runs as non-root' "$gw" 'runAsNonRoot: true'
assert_contains 'runs as the user of deploy/lib/cluster.sh' "$gw" "runAsUser: $HYDRA_GATEWAY_UID"
assert_contains 'PVC uses hydra-retain' "$(k8s_doc "$out" PersistentVolumeClaim gateway-data)" 'storageClassName: hydra-retain'

assert_eq 'eight NetworkPolicies' '8' "$(count_lines "$out" 'kind: NetworkPolicy')"
egress="$(k8s_doc "$out" NetworkPolicy sessions-egress)"
for cidr in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 100.64.0.0/10; do
  assert_contains "session egress excludes $cidr" "$egress" "- $cidr"
done
media="$(k8s_doc "$out" NetworkPolicy sessions-ingress-media)"
assert_eq 'media rule for UDP and TCP' '2' "$(count_lines "$media" 'endPort: 52099')"
assert_contains 'API server rule on 6443' "$(k8s_doc "$out" NetworkPolicy gateway-egress-apiserver)" 'port: 6443'
assert_contains 'Traefik may reach the gateway' "$(k8s_doc "$out" NetworkPolicy gateway-ingress-traefik)" 'app.kubernetes.io/name: traefik'

assert_contains 'public route uses the ACME resolver' "$(k8s_doc "$out" IngressRoute hydra-public)" 'certResolver: letsencrypt'
assert_contains 'live route uses the ACME resolver' "$(k8s_doc "$out" IngressRoute hydra-live)" 'certResolver: letsencrypt'

ds="$(k8s_doc "$out" DaemonSet session-image-prepull)"
assert_contains 'pre-pull of hydra-session' "$ds" 'image: hydra-session'
assert_contains 'pre-pull of hydra-mcp' "$ds" 'image: hydra-mcp'
assert_contains 'pinned pause image' "$ds" 'image: registry.k8s.io/pause:3.10.2@sha256:'
assert_not_contains 'no object has the reconciler label' "$out" 'app.kubernetes.io/managed-by'
finish_tests
