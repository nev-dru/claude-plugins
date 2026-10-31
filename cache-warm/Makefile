# cache-warm is a Claude Code mod: a TypeScript hooks module the engine loads.
#   build  validates the manifest and module the way the engine reads them, and
#          type-checks against the engine's API
#   lint   complexity, maintainability (function length, nesting, parameters)
#          and dead code, with oxlint (.oxlintrc.json), plus tsc's unused checks
#   test   runs tests/ under the engine's own test kit
#
# Type-checking needs the engine's types in .claude-plugin/types/, which the
# engine writes when it loads the mod from this folder: run
# `claude --plugin-dir .` once.

OXLINT := npx --yes oxlint@1.88.0
ENGINE_TYPES := .claude-plugin/types/tsconfig.json

.PHONY: build lint test types

build: types
	claude plugin validate .
	tsc -p .

lint:
	$(OXLINT) --deny-warnings -c .oxlintrc.json hooks tests
	@$(MAKE) --no-print-directory types
	tsc -p . --noUnusedLocals

test:
	claude plugin test .

types:
	@test -f $(ENGINE_TYPES) || { echo "no engine types in $(ENGINE_TYPES): run 'claude --plugin-dir .' once so the engine writes them"; exit 1; }
