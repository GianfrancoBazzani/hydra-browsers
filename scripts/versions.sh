# shellcheck shell=sh
# Pinned versions of the cluster software (spec sections 3.4.2 and 3.4.5).
# scripts/setup-k3s.sh and scripts/dev-cluster.sh source this file.
#
# Selected on 2026-10-10 with the 7-day minimum release age (published on or before 2026-10-03):
# - k3s: the release of the k3s "stable" channel (https://update.k3s.io/v1-release/channels).
# - k3d: the newest k3d release.
# Renovate updates the lines after a "# renovate:" comment (renovate.json). A k3s update changes
# K3S_VERSION and K3S_IMAGE together, and the SHA-256 of install.sh in scripts/setup-k3s.sh
# (README.md, section "Update k3s").

# renovate: datasource=github-releases depName=k3s-io/k3s
K3S_VERSION="v1.36.5+k3s1"

# The k3s image for k3d: the same release (tag with "-" instead of "+"), multi-arch index digest.
# renovate: datasource=docker depName=rancher/k3s
K3S_IMAGE="rancher/k3s:v1.36.5-k3s1@sha256:057cfd5a9d51b89f1f0ee139c28d5d5fdd5aa7ddeac2742a0ba90c6dbc0329bb"

# renovate: datasource=github-releases depName=k3d-io/k3d
K3D_VERSION="v5.9.0"

# The local image registry of the k3d dev cluster (scripts/dev-cluster.sh). Added by plan 08.
# Bumping K3D_VERSION also needs the k3d checksums of the installer (packages/e2e/scripts/install-k3d.sh, plan 10;
# README "Install k3d").
# renovate: datasource=docker depName=registry
K3D_REGISTRY_IMAGE="registry:3.1.2@sha256:ddf754342cfc8acc51a56d5d0ab6af06826461864460636d8bd5c546dab2a7b8"
