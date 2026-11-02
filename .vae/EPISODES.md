# Episodes

<!-- Newest last. The gate appends FAIL|DONE|FINDING; past 100 entries it trims only its own oldest DONE|FAIL|learned
FINDING (git keeps them). Leads (LESSON, FINDING learn=none) stay until wrap settles them; doctor fails above 30.
Agents append `<UTC ISO> s=<session> LESSON <VAE-DIALECT>` only for a falsified HYPOTHESIS, a dead end, or a root cause.
Session start injects the 3 newest open entries: LESSON, FINDING learn=none, FAIL without a later DONE.
Wrap: EVERY lead becomes a test | .vae/VERIFY.py rule | one MEMORY line with BC, then delete; OR delete BC evidence. -->

2026-11-01T15:21:58Z s=be7f2ca9 DONE fp=76a1751af892 cov=95.6% paths=docs/assets/site.js
2026-11-01T15:21:58Z s=be7f2ca9 FINDING src/types.d.ts:ClientHookPhase learn=none: prose accuracy against behavior is not mechanically checkable; the behavior itself is pinned by tests
2026-11-01T15:21:58Z s=be7f2ca9 FINDING docs/assets/site.js learn=verifier: already caught by scripts/docs.ts --check in make lint
2026-11-01T16:15:07Z s=be7f2ca9 FAIL prose,env.example,lint,tests.e2e.1
2026-11-01T16:28:40Z s=be7f2ca9 DONE fp=fd41069bd6ce cov=93.7% paths=AGENTS.md,ARCH.md,CHANGELOG.md,Makefile(+39)
2026-11-01T16:28:40Z s=be7f2ca9 FINDING src/providers/defuss-express.ts:use learn=test: src/express-server.test.ts 'serves sequential 1 MiB uploads on one keep-alive connection' fails without the read-ahead (mutation run) and passes with it
2026-11-01T16:28:40Z s=be7f2ca9 FINDING src/node-bridge.ts:discardRest learn=test: src/express-server.test.ts 'answers and keeps serving after bodies it rejects unread or reads only in part' on every provider
2026-11-01T16:28:40Z s=be7f2ca9 FINDING src/node-bridge.ts:bodyStream (removed) learn=test: covered by the sequential-upload and client upload suites on all providers
2026-11-01T16:28:40Z s=be7f2ca9 FINDING src/providers/bunway.ts:listen learn=test: Bun run of src/client.test.ts ('break stops the server generator') and express-server suites on bunway; idle-stream probe 12 s complete on Bun
2026-11-01T16:28:40Z s=be7f2ca9 FINDING src/express-server.test.ts:start EADDRINUSE learn=test: test asserts { code: 'EADDRINUSE' }; start() doc states the code contract
2026-11-01T16:28:40Z s=be7f2ca9 FINDING scripts/bench.mjs:upload metric learn=none: bench output: upload rows now equal req/s x 1 MiB; no generic test applies to a measurement script
2026-11-01T16:28:40Z s=be7f2ca9 FINDING README.md/ARCH.md/src/server.ts: Service Worker claim learn=none: removal of an unverified claim; no behavior changed
2026-11-01T18:48:06Z s=be7f2ca9 DONE fp=47c25edf4cb2 cov=93.3% paths=.github/workflows/verify.yml,AGENTS.md,ARCH.md,CHANGELOG.md(+35)
2026-11-01T18:48:06Z s=be7f2ca9 FINDING README.md:440 B05 (Runtimes table), docs/index.html Runtimes table learn=none: one table cell; no rule kind can check a prose claim against a test's provider choice
2026-11-01T18:48:06Z s=be7f2ca9 FINDING ARCH.md:60 B05 and CHANGELOG.md:10 B05 learn=none: numbers are copied from one run's results; no mechanical check compares prose to output/bench
2026-11-01T18:48:06Z s=be7f2ca9 FINDING ARCH.md:59 P09 learn=none: covered by the PROSE review each gate run
2026-11-01T18:48:06Z s=be7f2ca9 FINDING src/server.ts:8 B01 learn=none: a count in a comment; grep for stale counts was run over src, scripts and pages
2026-11-01T18:48:06Z s=be7f2ca9 FINDING scripts/e2e.mjs:watch learn=test: the filter lives in the e2e harness itself and keeps every other failed request fatal
2026-11-01T18:48:06Z s=be7f2ca9 FINDING Makefile:start,stop learn=none: needs a real port conflict to reproduce; the Makefile comment states the reason
2026-11-01T19:08:42Z s=be7f2ca9 FAIL env.example,src.log-through-helper
2026-11-01T19:22:54Z s=be7f2ca9 DONE fp=810ea2347f25 cov=91.1% paths=.github/workflows/verify.yml,AGENTS.md,ARCH.md,CHANGELOG.md(+40)
2026-11-01T19:22:54Z s=be7f2ca9 FINDING src/vite-plugin.ts:configureServer learn=test: src/vite-plugin.test.ts restart test on a fixed free port
2026-11-01T19:22:54Z s=be7f2ca9 FINDING scripts/serve.mjs:47 and Makefile:start learn=none: SITE_PORT is in .env.example, which the gate checks
2026-11-01T19:22:54Z s=be7f2ca9 FINDING scripts/bench.mjs:only and .env.example:RPC_URL learn=none: a value-specific config issue; the comment at the read site explains it
2026-11-01T19:22:54Z s=be7f2ca9 FINDING src/client.ts:525,798 (src.log-through-helper) learn=verifier: .vae/VERIFY.py src.log-through-helper already encodes it
2026-11-01T19:22:54Z s=be7f2ca9 FINDING src/providers/bun.ts:4 B01/S learn=none: one-off edit error
2026-11-01T19:22:54Z s=be7f2ca9 FINDING README.md:Benchmark B03/B09 learn=none: the bench script records load average in every report
2026-11-01T19:22:54Z s=be7f2ca9 FINDING src/astro-integration.ts:@example learn=none: doc example; the e2e runs the real config
2026-11-01T19:22:54Z s=be7f2ca9 FINDING examples/client.ts:3 B01 learn=verifier: the docs gate requires the prefix
2026-11-01T19:57:41Z s=be7f2ca9 FAIL prose,package
2026-11-01T20:08:44Z s=be7f2ca9 FAIL tests.e2e.1
2026-11-01T20:13:37Z s=be7f2ca9 DONE fp=09a7ab6b6a6e cov=90.9% paths=.github/workflows/verify.yml,AGENTS.md,ARCH.md,CHANGELOG.md(+62)
2026-11-01T20:13:37Z s=be7f2ca9 FINDING scripts/e2e.mjs:copy filter learn=test: the e2e itself asserts the Astro page result, so a dropped page fails it
2026-11-01T20:13:37Z s=be7f2ca9 FINDING scripts/docs.ts:12 learn=verifier: make lint (oxlint) catches it
2026-11-01T20:13:37Z s=be7f2ca9 FINDING integrations/astro/ARCH.md:20 B01 learn=verifier: the gate's prose check enforces it
2026-11-01T20:13:37Z s=be7f2ca9 FINDING integrations/*/package.json:devDependencies learn=verifier: the gate's package check enforces it
2026-11-01T20:13:37Z s=be7f2ca9 FINDING integrations/vite/example/env.d.ts:3 learn=none: comment text; generated into the README, which the docs check keeps in sync
2026-11-01T20:13:37Z s=be7f2ca9 FINDING Makefile:setup, integrations/*/package.json peerDependenciesMeta learn=verifier: .vae/checks/policy.py check_integrations keeps vite/astro out of the core and requires each package's lockfile, README, ARCH and example
2026-11-01T20:38:46Z s=be7f2ca9 FAIL prose,tests.e2e.1
2026-11-01T20:47:07Z s=be7f2ca9 DONE fp=2ef49e230a8c cov=90.9% paths=ARCH.md,Makefile,README.md,docs/assets/site.css(+7)
2026-11-01T20:47:07Z s=be7f2ca9 FINDING scripts/e2e.mjs:start astro (ASTRO_DISABLE_UPDATE_CHECK) learn=memory: .vae/MEMORY.md line; the e2e itself fails if the restart returns
2026-11-01T20:47:07Z s=be7f2ca9 FINDING scripts/e2e.mjs:finally (process cleanup) learn=none: diagnostic behavior of the test harness; no rule kind checks log presence after a failure
2026-11-01T20:47:07Z s=be7f2ca9 FINDING scripts/e2e.mjs:watch pageerror learn=test: every other page error still fails the e2e
2026-11-01T20:47:07Z s=be7f2ca9 FINDING scripts/serve.mjs:19 learn=none: comment drift; not mechanically checkable
2026-11-01T20:47:07Z s=be7f2ca9 FINDING docs/index.html:387,390 T06; README.md Protocol table T06 learn=verifier: the gate's prose check enforces it
2026-11-01T20:47:07Z s=be7f2ca9 FINDING scripts/docs.ts:highlightLines, codeText learn=none: documentation quality; the gate's docs stage reviews it
2026-11-01T21:12:03Z s=be7f2ca9 DONE fp=f6165d566e06 cov=90.9% paths=ARCH.md,Makefile,README.md,docs/assets/site.css(+8)
2026-11-01T21:12:03Z s=be7f2ca9 FINDING README.md:9, docs/index.html hero, package.json description learn=none: marketing claim accuracy; no rule kind can check it
2026-11-01T21:19:52Z s=be7f2ca9 DONE fp=a2a45653de90 cov=90.9% paths=ARCH.md,Makefile,README.md,docs/assets/site.css(+9)
2026-11-01T21:19:52Z s=be7f2ca9 FINDING scripts/bench.mjs:rssMiB, sampleRss, table learn=none: benchmark measurement; numbers vary per machine load, so no test may pin them
2026-11-01T23:10:33Z s=be7f2ca9 DONE fp=9dd0a47e54ec cov=90.8% paths=ARCH.md,Makefile,README.md,docs/assets/site.css(+10)
2026-11-01T23:10:33Z s=be7f2ca9 FINDING docs/src/site.ts copy buttons inside .diff learn=test: the e2e copy check fails if the fix is removed: the click would not reach the button
2026-11-01T23:10:33Z s=be7f2ca9 FINDING scripts/docs.ts:region (nested regions) learn=verifier: make lint (docs --check) fails when README or the website drift from the regions
2026-11-01T23:10:33Z s=be7f2ca9 FINDING examples/api.ts header learn=none: comment drift
2026-11-01T23:10:33Z s=be7f2ca9 FINDING README.md Install/Serve it/Benchmark, docs/index.html hero/Serve it/#performance, ARCH.md:46 learn=none: benchmark numbers vary per run; no test may pin them
2026-11-02T01:05:04Z s=be7f2ca9 FAIL prose
2026-11-02T01:09:30Z s=be7f2ca9 DONE fp=501b49b812b8 cov=90.8% paths=ARCH.md,Makefile,README.md,docs/assets/site.css(+23)
2026-11-02T01:09:30Z s=be7f2ca9 FINDING docs/index.html:761 T02 (runtimes table) learn=verifier: the gate's prose check (T02) already catches it; cells now read n/a
2026-11-02T01:09:30Z s=be7f2ca9 FINDING docs/assets/site.css .rp-muted learn=none: dead CSS is not mechanically checked; one-off cleanup
2026-11-02T01:09:30Z s=be7f2ca9 FINDING docs/index.html tables (performance, protocol, files, runtimes) learn=none: visual quality is reviewed by screenshot, not encodable as a rule
2026-11-02T01:09:30Z s=be7f2ca9 FINDING examples/*.ts, integrations/*/example (long lines) learn=verifier: scripts/docs.ts shown() fails make lint for a line over 64 characters in a diff or 80 elsewhere
2026-11-02T01:13:50Z s=be7f2ca9 DONE fp=2e463bc20847 cov=90.8% paths=ARCH.md,Makefile,README.md,docs/assets/site.css(+23)
2026-11-02T01:24:48Z s=be7f2ca9 FAIL prose
2026-11-02T01:29:12Z s=be7f2ca9 DONE fp=57df251bc4ba cov=90.8% paths=ARCH.md,CHANGELOG.md,Makefile,README.md(+28)
2026-11-02T01:29:12Z s=be7f2ca9 FINDING src/client.test.ts:66 (restores DSON types) learn=test: the test now asserts the 1.2.0 contract: undefined, NaN, ±Infinity and -0 round-trip as results and arguments
2026-11-02T01:29:12Z s=be7f2ca9 FINDING src/server.ts parseRpcCallDescriptor (trust boundary) learn=test: src/server.test.ts 'refuses DSON records that name a global…' fails below 1.2.0, so a downgrade cannot pass make test
2026-11-02T01:29:12Z s=be7f2ca9 FINDING docs/assets/site.css .rp-hero-pill > a.badge learn=none: contrast is reviewed by light and dark screenshots; no rule kind expresses it
2026-11-02T01:30:28Z s=be7f2ca9 DONE fp=5643493ec271 cov=90.8% paths=ARCH.md,CHANGELOG.md,Makefile,README.md(+28)
2026-11-02T01:39:01Z s=be7f2ca9 DONE fp=d321ef9ecc00 cov=90.8% paths=ARCH.md,CHANGELOG.md,Makefile,README.md(+28)
