#!/usr/bin/env bash
# Tests for deploy/Dockerfile and deploy/write-hydra-cli.sh: bash deploy/test/gateway-image.test.sh
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
# shellcheck source=deploy/lib/cluster.sh
. "$HYDRA_REPO_DIR/deploy/lib/cluster.sh"

file="$HYDRA_REPO_DIR/deploy/Dockerfile"
text="$(cat "$file")"
package_manager="$(node -p "require('$HYDRA_REPO_DIR/package.json').packageManager")"
assert_contains 'build stage uses the pinned node image' "$text" \
  'FROM node:24.21.0-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS build'
assert_contains 'runtime is the pinned distroless Node.js 24' "$text" \
  'FROM gcr.io/distroless/nodejs24-debian13:nonroot@sha256:9eeb7f5887d0e239e78264b06f7f11d2e14be534050481803a9e4728fcdd278e'
assert_eq 'every FROM line has a digest' '0' "$(grep '^FROM ' "$file" | grep -vc '@sha256:' || true)"
assert_contains 'pnpm version of packageManager' "$text" "npm install -g $package_manager"
assert_contains 'frozen lockfile' "$text" 'pnpm install --frozen-lockfile'
assert_contains 'production dependencies only' "$text" 'pnpm install --frozen-lockfile --prod --filter "@hydra/server..."'
assert_contains 'the whole packages/server is copied (drizzle migrations, dist, package files)' "$text" \
  'cp -a packages/server packages/shared /out/app/packages/'
assert_contains 'hydra on PATH' "$text" 'COPY --from=build /out/hydra /usr/local/bin/hydra'
assert_contains 'dashboard build in the repository layout that plan 03 reads' "$text" \
  'cp -a packages/web/dist /out/app/packages/web/dist'
assert_contains 'gateway starts without a shebang' "$text" 'CMD ["/app/packages/server/dist/main.js"]'
assert_not_contains 'no /usr/bin/env in the runtime image' "$text" '/usr/bin/env'
assert_contains 'non-root numeric user of deploy/lib/cluster.sh' "$text" "USER $HYDRA_GATEWAY_UID:$HYDRA_GATEWAY_UID"
assert_contains 'build context filter excludes node_modules' "$(cat "$file.dockerignore")" '**/node_modules'
assert_contains 'build context filter excludes .env files' "$(cat "$file.dockerignore")" '**/.env'
assert_contains 'build context filter excludes .env.* files' "$(cat "$file.dockerignore")" '**/.env.*'

work="$(cd "$(mktemp -d)" && pwd -P)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/server/dist/cli"
cat >"$work/server/package.json" <<'JSON'
{ "name": "@hydra/server", "type": "module", "bin": { "hydra": "./dist/cli/main.js" } }
JSON
# A fake CLI that runs only when it is the main module, like many ESM CLIs.
cat >"$work/server/dist/cli/main.js" <<'JS'
import { pathToFileURL } from 'node:url';
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(`cli ${process.argv.slice(2).join(' ')}`);
}
JS

sh "$HYDRA_REPO_DIR/deploy/write-hydra-cli.sh" "$work/server" "$work/server" "$work/hydra" "$(command -v node)"
assert_eq 'shebang is the given node binary' "#!$(command -v node)" "$(head -n 1 "$work/hydra")"
assert_contains 'resolves the CLI path' "$(cat "$work/hydra")" "realpathSync(\"$work/server/dist/cli/main.js\")"
assert_eq 'wrapper is executable' 'yes' "$([[ -x "$work/hydra" ]] && echo yes || echo no)"
assert_eq 'runs the CLI with its arguments' 'cli user create --admin' "$("$work/hydra" user create --admin)"

sh "$HYDRA_REPO_DIR/deploy/write-hydra-cli.sh" "$work/server" /app/packages/server "$work/hydra-image"
assert_eq 'default shebang is the distroless node' '#!/nodejs/bin/node' "$(head -n 1 "$work/hydra-image")"
assert_contains 'uses the CLI path in the image' "$(cat "$work/hydra-image")" 'realpathSync("/app/packages/server/dist/cli/main.js")'

printf '{ "name": "@hydra/server" }\n' >"$work/server/package.json"
assert_fails 'fails without a hydra bin' sh "$HYDRA_REPO_DIR/deploy/write-hydra-cli.sh" "$work/server" /app "$work/x"
printf '{ "bin": { "hydra": "./dist/missing.js" } }\n' >"$work/server/package.json"
assert_fails 'fails when the bin is not built' sh "$HYDRA_REPO_DIR/deploy/write-hydra-cli.sh" "$work/server" /app "$work/x"
finish_tests
