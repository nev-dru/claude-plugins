#!/usr/bin/env bash
set -euo pipefail
git clone -q "${RUFALOW_DIR:-$HOME/dev/rufalow}" . && git checkout -q "$(cat "$(dirname "$0")/../anchor.sha")"
rm -f CLAUDE.md AGENTS.md docs/ctx/INDEX.md   # baseline arm: no L1, no index
