#!/usr/bin/env bash
# Static tests for deploy/testsite/Dockerfile: bash deploy/test/testsite-image.test.sh
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

file="$HYDRA_REPO_DIR/deploy/testsite/Dockerfile"
text="$(cat "$file")"
node_image='node:24.21.0-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6'
package_manager="$(node -p "require('$HYDRA_REPO_DIR/package.json').packageManager")"

assert_eq 'both stages use the pinned node image' '2' "$(count_lines "$text" "FROM $node_image")"
assert_eq 'every FROM line has a digest' '0' "$(grep '^FROM ' "$file" | grep -vc '@sha256:' || true)"
assert_contains 'pnpm version of packageManager' "$text" "npm install -g $package_manager"
assert_contains 'frozen lockfile' "$text" 'pnpm install --frozen-lockfile'
assert_contains 'copy of the built test site' "$text" 'cp -a packages/testsite/dist packages/testsite/package.json /out/'
assert_contains 'non-root numeric user' "$text" 'USER 1000:1000'
assert_eq 'build context filter' 'yes' "$([[ -f "$file.dockerignore" ]] && echo yes)"
assert_contains 'build context filter excludes .env files' "$(cat "$file.dockerignore")" '**/.env'
assert_contains 'build context filter excludes .env.* files' "$(cat "$file.dockerignore")" '**/.env.*'
assert_contains 'comment on why pnpm deploy is not used' "$text" 'No runtime dependencies, so `pnpm deploy`'
finish_tests
