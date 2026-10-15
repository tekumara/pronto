SHELL := /bin/bash
.SHELLFLAGS := -o pipefail -c
# Prefer mise's real Node binary: its shim starts mise inside nono, where
# config tracking needs extra permissions. Fall back to PATH if mise can't resolve it.
NODE_BIN := $(shell mise which node --tool=node 2>/dev/null || command -v node)
PORT ?= 43221

# Run one or more explicit PR URLs with Pronto's usual review/apply flags:
#   make audit PRS="https://github.com/owner/repo/pull/42 https://github.com/owner/repo/pull/43"
.PHONY: audit nono-serve

audit:
	@test -n "$(strip $(PRS))" || { \
		echo 'Usage: make audit PRS="https://github.com/owner/repo/pull/42 [https://github.com/owner/repo/pull/43 ...]"' >&2; \
		exit 2; \
	}
	npm run audit -- $(foreach pr,$(PRS),--pr '$(pr)') --approve --apply --skip human-review

nono-serve:
	nono run --profile pronto --allow-cwd --listen-port $(PORT) -- "$(NODE_BIN)" \
		--experimental-strip-types audit.ts serve --apply --approve --port $(PORT) \
		2>&1 | tee -a /tmp/pronto-serve.log
