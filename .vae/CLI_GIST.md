# CLI gist

<!-- Commands future agents need that the Makefile verbs do not cover (setup, env, data, deploy):
- VERIFIED[purpose] `cmd`: only after an observed success
- UNKNOWN[purpose] BC gap
Budget 2 KiB (`vae.py doctor --repo .`); entries are injected at session start. -->
- VERIFIED[one Vitest file] `bunx vitest run --project node src/<name>.test.ts` (or `--project chromium|webkit` for *.browser.test.ts)
- VERIFIED[demo by hand] `make build && bun examples/server-bun.ts` (no provider, port 63920; server-express.ts also on node); then `bun examples/client.ts`
- VERIFIED[integration tests] `make build && cd integrations/vite && bun run test` (or `test:bun`; same in integrations/astro after its build)
- VERIFIED[one provider on Bun] `bunx --bun vitest run --project node src/express-server.test.ts -t bunway`
- VERIFIED[bench subset] `make build && BENCH_DURATION=2 BENCH_ONLY="express on Bun,bunway on Bun" node scripts/bench.mjs`
- VERIFIED[website] `make start` → http://127.0.0.1:4173/ (static, `SITE_PORT` overrides); `make docs` after editing examples/ or docs/src/
