#!/usr/bin/env bash
# shellcheck disable=SC2016 # ${DEBIAN_SNAPSHOT} is literal text of the Dockerfile
# Static tests for deploy/session/Dockerfile.{session,mcp}: bash deploy/test/session-images.test.sh
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

session_file="$HYDRA_REPO_DIR/deploy/session/Dockerfile.session"
mcp_file="$HYDRA_REPO_DIR/deploy/session/Dockerfile.mcp"
session="$(cat "$session_file")"
mcp="$(cat "$mcp_file")"
node_image='node:24.21.0-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6'
package_manager="$(node -p "require('$HYDRA_REPO_DIR/package.json').packageManager")"

assert_contains 'session: pinned Neko Chromium 3.1.6' "$session" \
  'FROM ghcr.io/m1k1o/neko/chromium:3.1.6@sha256:2471119c7b4010067f76f3421a78a8bcf35e3c223b2d1f4db084914ec915fb30'
assert_contains 'session: snapshot build argument' "$session" 'ARG DEBIAN_SNAPSHOT=20261002T203108Z'
assert_contains 'session: snapshot sources' "$session" 'http://snapshot.debian.org/archive/debian/${DEBIAN_SNAPSHOT}'
assert_contains 'session: snapshot security sources' "$session" 'http://snapshot.debian.org/archive/debian-security/${DEBIAN_SNAPSHOT}'
assert_contains 'session: font set of spec 7.7' "$session" \
  'fonts-noto fonts-noto-cjk fonts-noto-color-emoji fonts-liberation fonts-dejavu'
assert_eq 'session: no COPY until spike S1' '0' "$(count_lines "$session" 'COPY ')"

assert_eq 'mcp: both stages use the pinned node image' '2' "$(count_lines "$mcp" "FROM $node_image")"
assert_contains 'mcp: pnpm version of packageManager' "$mcp" "npm install -g $package_manager"
assert_contains 'mcp: frozen lockfile' "$mcp" 'pnpm install --frozen-lockfile'
assert_contains 'mcp: pnpm deploy of spec 3.4.4' "$mcp" 'pnpm --filter @hydra/mcp-sidecar deploy --prod /out'
assert_not_contains 'mcp: no global Playwright MCP install' "$mcp" 'npm install -g @playwright'
assert_contains 'mcp: non-root numeric user' "$mcp" 'USER 1000:1000'
assert_contains 'mcp: playwright-mcp is the command' "$mcp" 'ENTRYPOINT ["playwright-mcp"]'
assert_contains 'mcp: playwright-mcp is on PATH' "$mcp" 'ln -s /app/node_modules/@playwright/mcp/cli.js /usr/local/bin/playwright-mcp'
assert_contains 'mcp: HOME on the /tmp volume' "$mcp" 'ENV HOME=/tmp'
for file in "$session_file" "$mcp_file"; do
  assert_eq "$(basename "$file"): every FROM line has a digest" '0' "$(grep '^FROM ' "$file" | grep -vc '@sha256:' || true)"
  assert_eq "$(basename "$file"): build context filter" 'yes' "$([[ -f "$file.dockerignore" ]] && echo yes)"
done
# The mcp filter lists the files to exclude. The session filter denies everything (no secret can enter).
assert_contains 'mcp: build context filter excludes .env files' "$(cat "$mcp_file.dockerignore")" '**/.env'
assert_contains 'mcp: build context filter excludes .env.* files' "$(cat "$mcp_file.dockerignore")" '**/.env.*'
assert_eq 'session: build context filter denies everything' '*' "$(grep -v '^#' "$session_file.dockerignore")"
finish_tests
