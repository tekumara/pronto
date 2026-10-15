SHELL := /bin/bash
.SHELLFLAGS := -o pipefail -c
# Prefer mise's real Node binary: its shim starts mise inside nono, where
# config tracking needs extra permissions. Fall back to PATH if mise can't resolve it.
NODE_BIN := $(shell mise which node --tool=node 2>/dev/null || command -v node)
PORT ?= 43221

.PHONY: nono-serve
nono-serve:
	nono run --profile pronto --allow-cwd --listen-port $(PORT) -- "$(NODE_BIN)" \
		--experimental-strip-types audit.ts serve --apply --approve --port $(PORT) \
		2>&1 | tee -a /tmp/pronto-serve.log
