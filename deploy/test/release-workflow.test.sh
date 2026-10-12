#!/usr/bin/env bash
# shellcheck disable=SC2016 # ${{ ... }} is GitHub Actions syntax, not shell
# Static tests for .github/workflows/release.yml: bash deploy/test/release-workflow.test.sh
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

file="$HYDRA_REPO_DIR/.github/workflows/release.yml"
text="$(cat "$file")"

uses_lines="$(grep -E '^[[:space:]]*(- )?uses:' "$file" || true)"
assert_eq 'seven action steps' '7' "$(count_lines "$uses_lines" 'uses:')"
assert_eq 'every action is pinned to a full commit SHA' '0' \
  "$(printf '%s\n' "$uses_lines" | grep -vcE 'uses: [^@ ]+@[0-9a-f]{40} # v[0-9]' || true)"
assert_eq 'runners are ubuntu-24.04' "$(count_lines "$text" 'runs-on:')" "$(count_lines "$text" 'runs-on: ubuntu-24.04')"
assert_not_contains 'no ubuntu-latest' "$text" 'ubuntu-latest'
for dockerfile in deploy/Dockerfile deploy/session/Dockerfile.session deploy/session/Dockerfile.mcp deploy/testsite/Dockerfile; do
  assert_contains "builds $dockerfile" "$text" "file: $dockerfile"
done
assert_eq 'four images tagged with the commit SHA' '4' "$(count_lines "$text" ':${{ github.sha }}')"
assert_eq 'four images are pushed' '4' "$(count_lines "$text" 'push: true')"
assert_contains 'writes the prod overlay' "$text" '--out deploy/k8s/overlays/prod/images/kustomization.yaml'
for image in hydra-gateway hydra-session hydra-mcp; do
  assert_contains "pins $image in the prod overlay" "$text" "--image \"$image="
done
assert_not_contains 'the test site is not in the prod overlay' "$text" '--image "hydra-testsite='
assert_contains 'commits to the default branch' "$text" 'git push origin "HEAD:$BASE_BRANCH"'
assert_not_contains 'opens no pull request' "$text" 'gh pr'
assert_not_contains 'no pull request rights' "$text" 'pull-requests: write'
assert_contains 'no default token rights' "$text" 'permissions: {}'
assert_contains 'the overlay job runs only for a tag or the default branch' "$text" \
  "if: github.ref_type == 'tag' || github.ref == format('refs/heads/{0}', github.event.repository.default_branch)"
assert_contains 'the source ref is passed by env' "$text" 'SOURCE_REF: ${{ github.ref }}'
assert_contains 'the commit message names the source ref' "$text" '(source ref $SOURCE_REF)'
assert_contains 'skips the commit when the overlay has no change' "$text" 'git diff --quiet'
assert_contains 'rebases when the default branch moved' "$text" 'git pull --rebase origin "$BASE_BRANCH"'
assert_contains 'the overlay job checks out the full history of the default branch' "$text" 'fetch-depth: 0'
assert_contains 'the overlay job refuses a commit that is not on the default branch' "$text" \
  'git merge-base --is-ancestor "$COMMIT" HEAD'
assert_contains 'the refusal is an error' "$text" '::error::Commit $COMMIT is not on the default branch'
assert_contains 'the overlay job refuses a commit older than the release in the overlay' "$text" \
  'git merge-base --is-ancestor "$COMMIT" "$released"'
overlay_job="$(sed -n '/^  overlay:/,$p' "$file")"
check_line="$(printf '%s\n' "$overlay_job" | grep -n 'merge-base --is-ancestor "$COMMIT" HEAD' | cut -d: -f1)"
write_line="$(printf '%s\n' "$overlay_job" | grep -n 'write-overlay-component.sh' | head -1 | cut -d: -f1)"
assert_eq 'the check comes before the overlay is written' 'yes' \
  "$([[ -n "$check_line" && -n "$write_line" ]] && ((check_line < write_line)) && echo yes)"
older_line="$(printf '%s\n' "$overlay_job" | grep -n 'is-ancestor "$COMMIT" "$released"' | cut -d: -f1)"
assert_eq 'the older-commit check comes before the overlay is written' 'yes' \
  "$([[ -n "$older_line" && -n "$write_line" ]] && ((older_line < write_line)) && echo yes)"
finish_tests
