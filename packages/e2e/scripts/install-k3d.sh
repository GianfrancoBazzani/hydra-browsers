#!/usr/bin/env bash
# Installs the k3d version of scripts/versions.sh into <install-dir> and checks its SHA-256.
# Usage: bash packages/e2e/scripts/install-k3d.sh <install-dir>
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <install-dir>" >&2
  exit 2
fi
install_dir="$1"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
# shellcheck source=/dev/null
source "$repo_root/scripts/versions.sh"
version="v${K3D_VERSION#v}"

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) asset=k3d-linux-amd64 ;;
  Linux-aarch64 | Linux-arm64) asset=k3d-linux-arm64 ;;
  Darwin-arm64) asset=k3d-darwin-arm64 ;;
  Darwin-x86_64) asset=k3d-darwin-amd64 ;;
  *)
    echo "Unsupported platform: $(uname -s) $(uname -m)" >&2
    exit 1
    ;;
esac

# SHA-256 values from checksums.txt of each k3d release. A change of K3D_VERSION in
# scripts/versions.sh needs the four values of the new release here, in the same change.
case "$version/$asset" in
  v5.9.0/k3d-linux-amd64) expected=06d8f25bc3a971c4eb29e0ff08429b180402db0f4dec838c9eac427e296800a0 ;;
  v5.9.0/k3d-linux-arm64) expected=03cde5cf23e6e8e67de5a039ecf26e5b85aca82fba3e5d13dadf904cd218a250 ;;
  v5.9.0/k3d-darwin-arm64) expected=fe106541d5d0a3f18debcd4d432a16f8c0ce3e6ddc06f8fbb6f696a122313e00 ;;
  v5.9.0/k3d-darwin-amd64) expected=b4aabc37534f95b9c764e7823f2df923f50d57600837aa60a06266cce47db732 ;;
  v5.8.3/k3d-linux-amd64) expected=dbaa79a76ace7f4ca230a1ff41dc7d8a5036a8ad0309e9c54f9bf3836dbe853e ;;
  v5.8.3/k3d-linux-arm64) expected=0b8110f2229631af7402fb828259330985918b08fefd38b7f1b788a1c8687216 ;;
  v5.8.3/k3d-darwin-arm64) expected=8da468daa7dc7cf7cdd4735f90a9bb05179fa27858250f62e3d8cdf5b5ca0698 ;;
  v5.8.3/k3d-darwin-amd64) expected=fd0f8e9e8ea4d8bc3674572ca6ed0833b639bf57c43c708616d937377324cfea ;;
  *)
    echo "K3D_VERSION $version has no SHA-256 entry: add the four values from the release checksums.txt (in $0)" >&2
    exit 1
    ;;
esac

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
curl --fail --silent --show-error --location --retry 3 --output "$tmp/k3d" \
  "https://github.com/k3d-io/k3d/releases/download/$version/$asset"
if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "$tmp/k3d" | cut -d ' ' -f 1)"
else
  actual="$(shasum -a 256 "$tmp/k3d" | cut -d ' ' -f 1)"
fi
if [[ "$actual" != "$expected" ]]; then
  echo "SHA-256 mismatch for $asset $version: expected $expected, got $actual" >&2
  exit 1
fi
mkdir -p "$install_dir"
install -m 0755 "$tmp/k3d" "$install_dir/k3d"
"$install_dir/k3d" version
