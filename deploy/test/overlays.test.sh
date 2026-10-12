#!/usr/bin/env bash
# shellcheck disable=SC2016 # the backticks are part of the Traefik Host() rules
# Tests for deploy/k8s/write-overlay-component.sh and both overlays, with sample generated files in
# a temporary copy of deploy/k8s: bash deploy/test/overlays.test.sh (needs kubectl)
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cp -R "$HYDRA_REPO_DIR/deploy/k8s" "$work/k8s"
rm -rf "$work/k8s/overlays/dev/generated"
writer="$HYDRA_REPO_DIR/deploy/k8s/write-overlay-component.sh"
d1="sha256:$(printf '1%.0s' {1..64})"
d2="sha256:$(printf '2%.0s' {1..64})"
d3="sha256:$(printf '3%.0s' {1..64})"
d4="sha256:$(printf '4%.0s' {1..64})"

# dev overlay with the files that dev-cluster.sh writes
mkdir -p "$work/k8s/overlays/dev/generated"
bash "$writer" --out "$work/k8s/overlays/dev/generated/kustomization.yaml" \
  --registry k3d-hydra-registry:5111 --tag dev-test --node-ip 172.18.0.2 \
  --image "hydra-gateway=$d1" --image "hydra-session=$d2" --image "hydra-mcp=$d3" \
  --image "hydra-testsite=$d4" --source 'scripts/dev-cluster.sh'
dev="$(kubectl kustomize "$work/k8s/overlays/dev")"
assert_contains 'dev gateway image' "$dev" "image: k3d-hydra-registry:5111/hydra-gateway:dev-test@$d1"
assert_contains 'dev pre-pull session image' "$dev" "image: k3d-hydra-registry:5111/hydra-session:dev-test@$d2"
assert_contains 'dev pre-pull mcp image' "$dev" "image: k3d-hydra-registry:5111/hydra-mcp:dev-test@$d3"
assert_contains 'dev test site image' "$dev" "image: k3d-hydra-registry:5111/hydra-testsite:dev-test@$d4"
assert_contains 'dev HYDRA_SESSION_IMAGE' "$dev" "HYDRA_SESSION_IMAGE: k3d-hydra-registry:5111/hydra-session:dev-test@$d2"
assert_contains 'dev HYDRA_MCP_IMAGE' "$dev" "HYDRA_MCP_IMAGE: k3d-hydra-registry:5111/hydra-mcp:dev-test@$d3"
assert_contains 'dev public URL' "$dev" 'HYDRA_PUBLIC_URL: http://hydra.localhost'
assert_contains 'dev live URL' "$dev" 'HYDRA_LIVE_URL: http://live.hydra.localhost'
assert_contains 'dev public IP' "$dev" 'HYDRA_PUBLIC_IP: 127.0.0.1'
assert_contains 'dev vault http host: the test site (spec 15.3)' "$dev" 'HYDRA_VAULT_HTTP_HOSTS: testsite.hydra-testsite.svc.cluster.local'
assert_contains 'dev node IP in the API server rule' "$(k8s_doc "$dev" NetworkPolicy gateway-egress-apiserver)" 'cidr: 172.18.0.2/32'
dev_public="$(k8s_doc "$dev" IngressRoute hydra-public)"
assert_contains 'dev public host' "$dev_public" 'match: Host(`hydra.localhost`)'
assert_contains 'dev uses the web entry point' "$dev_public" '- web'
assert_not_contains 'dev has no TLS' "$dev_public" 'certResolver'
assert_contains 'dev live host' "$(k8s_doc "$dev" IngressRoute hydra-live)" 'match: Host(`live.hydra.localhost`)'
assert_contains 'dev test site egress exception' "$(k8s_doc "$dev" NetworkPolicy sessions-egress-testsite)" 'app: hydra-testsite'
gateway="$(k8s_doc "$dev" Deployment hydra-gateway)"
assert_contains 'gateway reads the generated hydra-images' "$gateway" 'name: hydra-images-'
assert_contains 'gateway reads the generated hydra-config' "$gateway" 'name: hydra-config-'

assert_not_contains 'dev default: no media range in hydra-config' "$dev" 'HYDRA_MEDIA_PORT_RANGE'
assert_contains 'dev default: media policy ports' "$(k8s_doc "$dev" NetworkPolicy sessions-ingress-media)" 'endPort: 52099'

# dev overlay with a non-default media port range (--media-port-range)
bash "$writer" --out "$work/k8s/overlays/dev/generated/kustomization.yaml" \
  --registry k3d-hydra-registry:5111 --tag dev-test --node-ip 172.18.0.2 --media-port-range 52100-52199 \
  --image "hydra-gateway=$d1" --image "hydra-session=$d2" --image "hydra-mcp=$d3" \
  --image "hydra-testsite=$d4" --source 'scripts/dev-cluster.sh'
dev_range="$(kubectl kustomize "$work/k8s/overlays/dev")"
assert_contains 'dev range: HYDRA_MEDIA_PORT_RANGE in hydra-config' "$dev_range" 'HYDRA_MEDIA_PORT_RANGE: 52100-52199'
assert_contains 'dev range: hydra-config keeps the public URL' "$dev_range" 'HYDRA_PUBLIC_URL: http://hydra.localhost'
assert_contains 'dev range: hydra-config keeps the public IP' "$dev_range" 'HYDRA_PUBLIC_IP: 127.0.0.1'
assert_contains 'dev range: gateway reads hydra-config' "$(k8s_doc "$dev_range" Deployment hydra-gateway)" 'name: hydra-config-'
media="$(k8s_doc "$dev_range" NetworkPolicy sessions-ingress-media)"
assert_eq 'dev range: both policy entries start at the first port' '2' "$(count_lines "$media" 'port: 52100')"
assert_eq 'dev range: both policy entries end at the last port' '2' "$(count_lines "$media" 'endPort: 52199')"
assert_not_contains 'dev range: no default port left in the policy' "$media" '52000'
assert_contains 'dev range: protocols kept' "$media" 'protocol: UDP'
assert_contains 'dev range: node IP patch kept' "$(k8s_doc "$dev_range" NetworkPolicy gateway-egress-apiserver)" 'cidr: 172.18.0.2/32'
# without the option the component is byte-identical to one that never knew the option
bash "$writer" --out "$work/dev-a.yaml" --registry r --tag t --node-ip 10.0.0.1 --image "hydra-mcp=$d3" --image "hydra-session=$d2"
assert_not_contains 'no option: no media range in the component' "$(cat "$work/dev-a.yaml")" 'MEDIA_PORT'
assert_not_contains 'no option: no media policy patch' "$(cat "$work/dev-a.yaml")" 'sessions-ingress-media'
bash "$writer" --out "$work/dev-b.yaml" --registry r --tag t --node-ip 10.0.0.1 --media-port-range 52100-52199 \
  --image "hydra-mcp=$d3" --image "hydra-session=$d2"
bash "$writer" --out "$work/dev-c.yaml" --registry r --tag t --node-ip 10.0.0.1 --media-port-range 52100-52199 \
  --image "hydra-mcp=$d3" --image "hydra-session=$d2"
assert_eq 'media range: same arguments give the same bytes' "$(cat "$work/dev-b.yaml")" "$(cat "$work/dev-c.yaml")"
bash "$writer" --out "$work/dev-d.yaml" --registry r --tag t --media-port-range 52100-52199 \
  --image "hydra-mcp=$d3" --image "hydra-session=$d2"
assert_contains 'media range without a node IP: one patches key' "$(cat "$work/dev-d.yaml")" 'sessions-ingress-media'
assert_eq 'media range without a node IP: one patches key only' '1' "$(count_lines "$(cat "$work/dev-d.yaml")" 'patches:')"
for bad in 52100 52199-52100 100-200 52000-70000 'a-b' '52000-52099; x'; do
  assert_fails "writer rejects the media range '$bad'" bash "$writer" --out "$work/c.yaml" --registry r --tag t \
    --image "hydra-session=$d2" --image "hydra-mcp=$d3" --media-port-range "$bad"
done

# prod overlay as committed
prod="$(kubectl kustomize "$work/k8s/overlays/prod")"
assert_not_contains 'prod: no vault http host (spec 4)' "$prod" 'HYDRA_VAULT_HTTP_HOSTS'
prod_public="$(k8s_doc "$prod" IngressRoute hydra-public)"
assert_contains 'prod public host' "$prod_public" 'match: Host(`hydra.example.com`)'
assert_contains 'prod uses TLS from the ACME resolver' "$prod_public" 'certResolver: letsencrypt'
assert_contains 'prod live host' "$(k8s_doc "$prod" IngressRoute hydra-live)" 'match: Host(`live.hydra.example.com`)'
assert_contains 'prod node IP in the API server rule' "$(k8s_doc "$prod" NetworkPolicy gateway-egress-apiserver)" 'cidr: 192.0.2.10/32'

# prod overlay after a release
bash "$writer" --out "$work/k8s/overlays/prod/images/kustomization.yaml" \
  --registry ghcr.io/example --tag 0123456789abcdef0123456789abcdef01234567 \
  --image "hydra-gateway=$d1" --image "hydra-session=$d2" --image "hydra-mcp=$d3" \
  --source 'release workflow'
prod="$(kubectl kustomize "$work/k8s/overlays/prod")"
tag=0123456789abcdef0123456789abcdef01234567
assert_contains 'prod gateway image' "$prod" "image: ghcr.io/example/hydra-gateway:$tag@$d1"
assert_contains 'prod HYDRA_SESSION_IMAGE' "$prod" "HYDRA_SESSION_IMAGE: ghcr.io/example/hydra-session:$tag@$d2"
assert_contains 'prod HYDRA_MCP_IMAGE' "$prod" "HYDRA_MCP_IMAGE: ghcr.io/example/hydra-mcp:$tag@$d3"
assert_not_contains 'prod has no test site' "$prod" 'hydra-testsite'

# writer: same arguments give the same bytes (the release job skips an empty commit)
args=(--registry ghcr.io/example --tag t1 --image "hydra-mcp=$d3" --image "hydra-session=$d2")
bash "$writer" --out "$work/a.yaml" "${args[@]}"
bash "$writer" --out "$work/b.yaml" "${args[@]}"
assert_eq 'writer output is deterministic' "$(cat "$work/a.yaml")" "$(cat "$work/b.yaml")"
assert_fails 'writer rejects a short digest' bash "$writer" --out "$work/c.yaml" --registry r --tag t \
  --image hydra-session=sha256:abc --image "hydra-mcp=$d3"
assert_fails 'writer rejects an unknown image' bash "$writer" --out "$work/c.yaml" --registry r --tag t \
  --image "hydra-session=$d2" --image "hydra-mcp=$d3" --image "other=$d1"
assert_fails 'writer needs hydra-mcp' bash "$writer" --out "$work/c.yaml" --registry r --tag t \
  --image "hydra-session=$d2"
assert_fails 'writer rejects a bad node IP' bash "$writer" --out "$work/c.yaml" --registry r --tag t \
  --image "hydra-session=$d2" --image "hydra-mcp=$d3" --node-ip 'x; rm -rf /'
finish_tests
