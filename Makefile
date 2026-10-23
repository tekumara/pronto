SHELL := /bin/bash
.SHELLFLAGS := -o pipefail -c
# Prefer mise's real Node binary: its shim starts mise inside nono, where
# config tracking needs extra permissions. Fall back to PATH if mise can't resolve it.
NODE_BIN := $(shell mise which node --tool=node 2>/dev/null || command -v node)
PORT ?= 43221
S3_PORT ?= 9000
S3_DATA_DIR ?= $(HOME)/.local/state/pronto-rustfs
S3_ACCESS_KEY ?= pronto-local
S3_SECRET_KEY ?= pronto-local-secret

# Run one or more explicit PR URLs with Pronto's usual review/apply flags:
#   make audit PRS="https://github.com/owner/repo/pull/42 https://github.com/owner/repo/pull/43"
.PHONY: audit nono-serve s3

audit:
	@test -n "$(strip $(PRS))" || { \
		echo 'Usage: make audit PRS="https://github.com/owner/repo/pull/42 [https://github.com/owner/repo/pull/43 ...]"' >&2; \
		exit 2; \
	}
	npm run audit -- $(foreach pr,$(PRS),--pr '$(pr)') --approve --apply --skip human-review

# Resolve gh auth outside nono so the sandbox doesn't need Keychain access.
nono-serve:
	GITHUB_TOKEN="$$(gh auth token)" nono run --profile pronto --allow-cwd --listen-port $(PORT) -- "$(NODE_BIN)" --experimental-strip-types audit.ts serve --apply --approve --port $(PORT) 2>&1 | tee -a /tmp/pronto-serve.log

# Start local-only RustFS for S3-compatible replication tests. Override S3_* as needed.
s3:
	@mkdir -p "$(S3_DATA_DIR)"
	@echo "Starting RustFS at http://127.0.0.1:$(S3_PORT) (data: $(S3_DATA_DIR))"
	RUSTFS_ACCESS_KEY="$(S3_ACCESS_KEY)" RUSTFS_SECRET_KEY="$(S3_SECRET_KEY)" \
		mise exec -- rustfs server --address "127.0.0.1:$(S3_PORT)" "$(S3_DATA_DIR)"
