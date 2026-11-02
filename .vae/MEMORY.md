# Agent memory

<!-- One tagged line per durable fact NOT derivable from code, git or docs:
- VERIFIED[scope] fact BC evidence
- HYPOTHESIS[scope] claim BC observation; falsifier=`cmd`
- UNKNOWN[scope] gap BC missing evidence
[scope] = the narrowest path|module|command|condition the evidence covers, not a topic: the entry decides nothing
outside it, and recurrence inside one subsystem never widens it.
Every line carries its BC and stays within 240 chars. Replace stale lines instead of appending.
Mechanizable lessons belong in tests or .vae/VERIFY.py.
Budget 4 KiB (`vae.py doctor --repo .`); entries are injected at session start. -->
- VERIFIED[astro 7.4.4 `astro dev`] detaches into a background process when it detects a coding agent; `--ignore-lock` keeps it in the foreground BC integrations/astro/node_modules/astro/dist/cli/dev/index.js + e2e run
- VERIFIED[astro dev + defuss-rpc] the SSR build bundles packages that peer on astro, giving a second module copy; shared state must live on globalThis symbols BC empty Astro.locals.rpcEndpoint in e2e before the fix
- VERIFIED[vitest 5 globalSetup] Vite's module runner crashes mapping stack traces of thrown errors ("code.charCodeAt is not a function"); src/test/browser-server.ts unsets Error.prepareStackTrace BC browser run 2026-11-01
- VERIFIED[DSON wire] NDJSON lines are DSON's compact table encoding, not readable JSON BC curl of ChatApi.reply → examples/wire.ndjson
- VERIFIED[make e2e] needs network: bun add in the consumer and defuss-shadcn 0.9.11 from jsDelivr for docs/ BC failed requests fail scripts/e2e.mjs
- VERIFIED[astro 7.4.4 `astro dev` outside CI] a fresh project's npm update check writes .astro/settings.json, which restarts the dev server mid-request; tests set ASTRO_DISABLE_UPDATE_CHECK=true BC output/e2e/logs/astro.log "Configuration file updated" + dist/core/dev/update-check.js
