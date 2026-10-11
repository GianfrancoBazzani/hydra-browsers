# shellcheck shell=bash
# Assertion helpers for the deploy tests. Source this file. Works with bash 3.2 (macOS).
# shellcheck disable=SC2034 # used by the test files that source this file
HYDRA_REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TEST_FAILURES=0

pass() { printf 'ok   %s\n' "$1"; }
fail() {
  printf 'FAIL %s\n' "$1" >&2
  TEST_FAILURES=$((TEST_FAILURES + 1))
}

# assert_eq NAME EXPECTED ACTUAL
assert_eq() {
  if [[ "$2" == "$3" ]]; then
    pass "$1"
  else
    fail "$1"
    printf '  expected: %s\n  actual:   %s\n' "$2" "$3" >&2
  fi
}

# assert_contains NAME TEXT NEEDLE
assert_contains() {
  if [[ "$2" == *"$3"* ]]; then pass "$1"; else fail "$1 (missing: $3)"; fi
}

# assert_not_contains NAME TEXT NEEDLE
assert_not_contains() {
  if [[ "$2" != *"$3"* ]]; then pass "$1"; else fail "$1 (unexpected: $3)"; fi
}

# assert_fails NAME COMMAND... : the command must exit with a non-zero status
assert_fails() {
  local name="$1"
  shift
  if "$@" >/dev/null 2>&1; then fail "$name (command succeeded)"; else pass "$name"; fi
}

# count_lines TEXT NEEDLE : number of lines of TEXT that contain NEEDLE
count_lines() {
  printf '%s\n' "$1" | grep -cF -- "$2" || true
}

# k8s_doc TEXT KIND NAME : prints the document with this kind and metadata.name from a
# `kubectl kustomize` output (kustomize writes keys in sorted order, two-space indent).
k8s_doc() {
  printf '%s\n' "$1" | awk -v kind="$2" -v name="$3" '
    function flush() {
      if (k && n) printf "%s", doc
      doc = ""; k = 0; n = 0; meta = 0
    }
    /^---$/ { flush(); next }
    { doc = doc $0 "\n" }
    /^[^ ]/ { meta = ($0 == "metadata:") }
    $0 == "kind: " kind { k = 1 }
    meta && $0 == "  name: " name { n = 1 }
    END { flush() }
  '
}

finish_tests() {
  if ((TEST_FAILURES > 0)); then
    printf '%d test(s) failed\n' "$TEST_FAILURES" >&2
    exit 1
  fi
  echo "all tests passed"
}
