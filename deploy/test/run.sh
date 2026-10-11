#!/usr/bin/env bash
# Runs all deploy tests: bash deploy/test/run.sh
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
status=0
for test_file in ./*.test.sh; do
  echo "== ${test_file#./}"
  bash "$test_file" || status=1
done
exit "$status"
