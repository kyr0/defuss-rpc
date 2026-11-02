# defuss-rpc: the defuss-vae verbs for humans, agents and CI (`make` lists them).
# Recipes delegate to package.json scripts and scripts/, so each step has one source of truth.
# Toolchain: Node.js and Bun run the tests and servers, bun installs and bundles; versions pinned in mise.toml.
-include .env
ENV_KEYS := $(shell sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p' .env 2>/dev/null)
ifneq ($(ENV_KEYS),)
export $(ENV_KEYS)
endif
# Installer default dirs as a fallback; tools already on PATH (CI's setup actions) keep precedence.
export PATH := $(PATH):$(HOME)/.local/bin:$(HOME)/.bun/bin:$(HOME)/.local/share/mise/shims

# The integration packages: Bun projects of their own (own bun.lock), linked to this repository by symlinks.
INTEGRATIONS = integrations/vite integrations/astro
in_integrations = for d in $(INTEGRATIONS); do (cd $$d && $(1)) || exit 1; done

.DEFAULT_GOAL := help
.PHONY: help setup build docs lint policy test coverage e2e verify start stop restart status log metrics bench clean

help: ## list the verbs with their usage (default goal)
	@awk -F':.*## ' '/^[a-zA-Z0-9_ -]+:.*## /{printf "  %-10s %s\n", $$1, $$2}' $(firstword $(MAKEFILE_LIST))

# Outside CI, mise installs the pinned Node.js and bun; CI pins them with its setup actions (Node.js as a matrix).
# The git hook path makes .githooks/commit-msg active in this clone.
setup: ## install pinned tools, exactly the locked dependencies, Chromium + WebKit, and the git hooks
	@if [ -z "$$CI" ]; then command -v mise >/dev/null 2>&1 || curl -fsSL https://mise.run | sh; mise install; fi
	bun install --frozen-lockfile
	@$(call in_integrations,bun install --frozen-lockfile)
	@# Relative symlinks instead of file: (copies the repo with its devDependencies) or link: (global registry).
	ln -sfn ../../.. integrations/vite/node_modules/defuss-rpc
	ln -sfn ../../.. integrations/astro/node_modules/defuss-rpc
	ln -sfn ../../vite integrations/astro/node_modules/defuss-rpc-vite
	bunx playwright install $(if $(CI),--with-deps) chromium webkit
	@if [ -d .git ]; then git config core.hooksPath .githooks; fi

build: ## ESM + CommonJS + declarations into dist/ (pkgroll), then the integration packages
	bun run build
	@$(call in_integrations,bun run build)

docs: build ## regenerate README.md and docs/ code blocks from examples/ and bundle docs/assets/site.js
	bun scripts/docs.ts

lint: build policy ## oxlint (warnings fail), strict tsc for src/ and examples/, docs in sync with examples/
	bun run lint
	bun run typecheck
	@$(call in_integrations,bun run lint && bun run typecheck)
	bun scripts/docs.ts --check

policy: ## repository invariants: exports, runtimes claims, commit trailers (.vae/checks)
	python3 .vae/checks/policy.py

# The server suites run twice: on Node.js with Express, and on Bun with Express and bunway.
test: ## Vitest: Node.js, Chromium and WebKit projects against real servers, then the server suites on Bun
	bun run test
	bun run test:bun
	@$(call in_integrations,bun run test && bun run test:bun)

coverage: ## merged v8 coverage of the Node.js and Chromium projects (prints the All files table)
	bun run coverage

e2e: ## pack → clean consumer → Node.js and Bun servers and clients, Vite, Astro, browser example + website in Chromium + WebKit → output/e2e/
	bun run e2e

verify: lint test coverage e2e ## what CI runs: every gate verb, cheapest first

# The website (docs/, static: no RPC server behind it) on Bun, port 4173. `make docs` after editing examples/ or
# docs/src/ regenerates what it serves.
SITE_PORT ?= 4173
export SITE_PORT
LOG = var/log/site
PID = tmp/site.pid
ALIVE = [ -f $(PID) ] && kill -0 "$$(cat $(PID))" 2>/dev/null
RUN = exec bun scripts/serve.mjs

start: ## website http://127.0.0.1:4173/ (SITE_PORT), detached
	@mkdir -p var/log tmp
	@if $(ALIVE); then echo "running pid=$$(cat $(PID))"; exit 0; fi; \
	if command -v setsid >/dev/null 2>&1; then nohup setsid sh -c '$(RUN)' >>$(LOG).stdout 2>>$(LOG).stderr </dev/null & \
	else set -m; nohup sh -c '$(RUN)' >>$(LOG).stdout 2>>$(LOG).stderr </dev/null & set +m; fi; \
	echo $$! >$(PID); \
	for i in $$(seq 50); do curl -sf -o /dev/null http://127.0.0.1:$(SITE_PORT)/ && break; sleep 0.1; done; \
	if $(ALIVE); then echo "running pid=$$(cat $(PID)) site=http://127.0.0.1:$(SITE_PORT)/"; \
	else kill -s TERM -- -$$(cat $(PID)) 2>/dev/null; rm -f $(PID); echo "dead; see: make log"; exit 1; fi

# The whole process group, not only its leader, so no child of the service outlives it.
stop: ## SIGTERM the service group, SIGKILL after 5 s
	@if [ -f $(PID) ]; then p=$$(cat $(PID)); kill -s TERM -- -$$p 2>/dev/null || kill -s TERM $$p 2>/dev/null; \
	i=0; while kill -0 -- -$$p 2>/dev/null && [ $$i -lt 50 ]; do sleep 0.1; i=$$((i+1)); done; \
	kill -s KILL -- -$$p 2>/dev/null || true; fi; rm -f $(PID); echo stopped

restart: stop start ## stop, then start

status: ## running | dead (stale pid) | stopped, as LSB exit codes
	@if $(ALIVE); then echo "running pid=$$(cat $(PID))"; \
	elif [ -f $(PID) ]; then echo "dead pid=$$(cat $(PID)); see: make log"; exit 1; \
	else echo stopped; exit 3; fi

log: ## last 40 lines of the service logs
	@tail -n 40 $(LOG).stdout $(LOG).stderr 2>/dev/null || echo "∅ no logs yet (make start)"

metrics: build ## bytes and gzip bytes of the built ESM entries
	@for f in dist/*.mjs; do printf "%-28s %7s B %6s B gzip\n" $$f $$(wc -c <$$f) $$(gzip -c $$f | wc -c); done

bench: build ## providers compared: calls, streams, uploads, downloads per server (autocannon) → output/bench/
	bun run bench

clean: ## remove dist/, coverage/, caches, tmp/ and output/
	bun run clean
	rm -rf tmp/* output/* .vitest
