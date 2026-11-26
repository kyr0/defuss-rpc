# Episodes

<!-- Newest last. The gate appends FAIL|DONE|FINDING; past 100 entries it trims only its own oldest DONE|FAIL|learned
FINDING (git keeps them). Leads (LESSON, FINDING learn=none) stay until wrap settles them; doctor fails above 30.
Agents append `<UTC ISO> s=<session> LESSON <VAE-DIALECT>` only for a falsified HYPOTHESIS, a dead end, or a root cause.
Session start injects the 3 newest open entries: LESSON, FINDING learn=none, FAIL without a later DONE.
Wrap: EVERY lead becomes a test | .vae/VERIFY.py rule | one MEMORY line with BC, then delete; OR delete BC evidence. -->

2026-11-01T15:21:58Z s=be7f2ca9 FINDING src/types.d.ts:ClientHookPhase learn=none: prose accuracy against behavior is not mechanically checkable; the behavior itself is pinned by tests
2026-11-01T16:28:40Z s=be7f2ca9 FINDING scripts/bench.mjs:upload metric learn=none: bench output: upload rows now equal req/s x 1 MiB; no generic test applies to a measurement script
2026-11-01T16:28:40Z s=be7f2ca9 FINDING README.md/ARCH.md/src/server.ts: Service Worker claim learn=none: removal of an unverified claim; no behavior changed
2026-11-01T18:48:06Z s=be7f2ca9 FINDING README.md:440 B05 (Runtimes table), docs/index.html Runtimes table learn=none: one table cell; no rule kind can check a prose claim against a test's provider choice
2026-11-01T18:48:06Z s=be7f2ca9 FINDING ARCH.md:60 B05 and CHANGELOG.md:10 B05 learn=none: numbers are copied from one run's results; no mechanical check compares prose to output/bench
2026-11-01T18:48:06Z s=be7f2ca9 FINDING ARCH.md:59 P09 learn=none: covered by the PROSE review each gate run
2026-11-01T18:48:06Z s=be7f2ca9 FINDING src/server.ts:8 B01 learn=none: a count in a comment; grep for stale counts was run over src, scripts and pages
2026-11-01T18:48:06Z s=be7f2ca9 FINDING Makefile:start,stop learn=none: needs a real port conflict to reproduce; the Makefile comment states the reason
2026-11-01T19:22:54Z s=be7f2ca9 FINDING scripts/serve.mjs:47 and Makefile:start learn=none: SITE_PORT is in .env.example, which the gate checks
2026-11-01T19:22:54Z s=be7f2ca9 FINDING scripts/bench.mjs:only and .env.example:RPC_URL learn=none: a value-specific config issue; the comment at the read site explains it
2026-11-01T19:22:54Z s=be7f2ca9 FINDING src/providers/bun.ts:4 B01/S learn=none: one-off edit error
2026-11-01T19:22:54Z s=be7f2ca9 FINDING README.md:Benchmark B03/B09 learn=none: the bench script records load average in every report
2026-11-01T19:22:54Z s=be7f2ca9 FINDING src/astro-integration.ts:@example learn=none: doc example; the e2e runs the real config
2026-11-01T20:13:37Z s=be7f2ca9 FINDING integrations/vite/example/env.d.ts:3 learn=none: comment text; generated into the README, which the docs check keeps in sync
2026-11-01T20:47:07Z s=be7f2ca9 FINDING scripts/e2e.mjs:finally (process cleanup) learn=none: diagnostic behavior of the test harness; no rule kind checks log presence after a failure
2026-11-01T20:47:07Z s=be7f2ca9 FINDING scripts/serve.mjs:19 learn=none: comment drift; not mechanically checkable
2026-11-01T20:47:07Z s=be7f2ca9 FINDING scripts/docs.ts:highlightLines, codeText learn=none: documentation quality; the gate's docs stage reviews it
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
2026-11-02T05:17:47Z s=472a9d74 DONE fp=4c60536d785f cov=90.8% paths=ARCH.md,README.md,docs/index.html,src/providers/bun.ts
2026-11-02T05:17:47Z s=472a9d74 FINDING README.md:522 B01 learn=none: one-off edit error; benchmark prose is copied from a run's results and no rule kind compares prose to output/bench
2026-11-02T05:24:59Z s=472a9d74 DONE fp=dded8b2c7cc0 cov=90.8% paths=ARCH.md,README.md,docs/index.html,src/providers/bun.ts
2026-11-02T05:24:59Z s=472a9d74 FINDING ARCH.md:60 L03 learn=none: one-off wording error caught in review; no rule kind checks cross-page consistency of prose
2026-11-02T05:34:55Z s=472a9d74 DONE fp=d07b8bc74cf1 cov=90.8% paths=ARCH.md,README.md,docs/index.html,src/providers/bun.ts
2026-11-02T05:34:55Z s=472a9d74 FINDING docs/index.html:282 A01 learn=none: human instruction about page content; no rule kind compares prose with output/bench
2026-11-23T20:18:34Z s=472a9d74 FAIL lint,tests.e2e.1,tests.no-mocks
2026-11-23T20:21:35Z s=472a9d74 FAIL lint,tests.e2e.1
2026-11-23T20:32:28Z s=472a9d74 DONE fp=f2f814faf92c cov=92.3% paths=AGENTS.md,ARCH.md,CHANGELOG.md,README.md(+48)
2026-11-23T20:32:28Z s=472a9d74 FINDING src/server.ts:close learn=none: no deterministic way found to make enqueue throw after cancel() removed the ender; defensive fix of the cleanup guarantee
2026-11-23T20:32:28Z s=472a9d74 FINDING src/server.ts:isRpcRequest learn=test: src/instances.test.ts 'match only the RPC routes' asserts OPTIONS /rpc and GET /rpc are false
2026-11-23T20:32:28Z s=472a9d74 FINDING src/global.test.ts:70 learn=verifier: .vae/VERIFY.py tests.no-mocks already encodes it
2026-11-23T20:32:28Z s=472a9d74 FINDING scripts/e2e.mjs:interop learn=test: the e2e step itself fails when the program does not end with ok
2026-11-23T20:32:28Z s=472a9d74 FINDING examples/files.ts#files T/width learn=verifier: scripts/docs.ts --check in make lint enforces the width
2026-11-23T20:32:28Z s=472a9d74 FINDING README.md:528,746 B01 learn=verifier: the gate's prose check enforces it
2026-11-23T20:32:28Z s=472a9d74 FINDING tmp/bench-compare run4-old, run5-old learn=memory: .vae/MEMORY.md line: run make bench in the foreground, since ending a turn starts the gate
2026-11-24T22:39:12Z s=dcdb118f DONE fp=ac6c6b0a8dc2 cov=92.4% paths=CHANGELOG.md,README.md,bun.lock,docs/index.html(+3)
2026-11-24T22:39:12Z s=dcdb118f FINDING src/client.ts:getSchema learn=test: VERIFIED: src/client.test.ts 'headers for a server that guards its schema' runs a real HTTP listener that rejects requests without the token.
2026-11-24T22:39:12Z s=dcdb118f FINDING src/client.ts:sendCall and upload (customHeaders spread) learn=test: VERIFIED: the setHeaders test passes a Headers instance and pairs against the guarded listener.
2026-11-24T22:39:12Z s=dcdb118f FINDING src/client.ts:RpcClientOptions.headers learn=test: VERIFIED: covered by the two-listener test.
2026-11-24T22:39:12Z s=dcdb118f FINDING src/client.test.ts:299 learn=none: VERIFIED: tsc in make lint catches it.
2026-11-24T23:45:16Z s=472a9d74 FAIL tests.e2e.1
2026-11-24T23:54:28Z s=472a9d74 DONE fp=46c2cc193a64 cov=92.4% paths=AGENTS.md,ARCH.md,CHANGELOG.md,README.md(+48)
2026-11-24T23:54:28Z s=472a9d74 FINDING src/client.ts:mergeHeaders (was record) learn=test: src/client.test.ts 'a client's headers win' failed (401) before the fix, passes after
2026-11-24T23:54:28Z s=472a9d74 FINDING src/client.ts:upload resume HEAD learn=test: the same test asserts the HEAD arrives with 'Bearer a'; it failed with '/rpc/upload/u1 -' before the fix
2026-11-24T23:54:28Z s=472a9d74 FINDING README.md:headers paragraph learn=none: platform limit of EventSource, no code defect to test
2026-11-25T00:45:06Z s=dcdb118f DONE fp=9ec50d2bce18 cov=92.4% paths=ARCH.md,CHANGELOG.md,README.md,bun.lock(+5)
2026-11-25T00:45:06Z s=dcdb118f FINDING src/client.ts:ClientState and the module state learn=test: VERIFIED: src/client.test.ts 'client contexts' (3 tests) covers isolation of hooks, headers, schema caches, uploads and the context endpoint.
2026-11-25T00:45:06Z s=dcdb118f FINDING src/client.ts:fetchSchema learn=test: VERIFIED: covered by 'a failed schema request carries status and body'.
2026-11-25T00:45:06Z s=dcdb118f FINDING src/client.ts:getSchema/getRpcClient/upload/uploadComplete signatures learn=none: VERIFIED: type check and the unchanged tests prove the public signatures.
2026-11-25T00:45:06Z s=dcdb118f FINDING examples/client.ts#client-context and README.md:467 learn=test: VERIFIED: e2e compares every printed line with its comment.
2026-11-25T02:13:25Z s=dcdb118f DONE fp=4fa97d92ef0c cov=92.4% paths=ARCH.md,CHANGELOG.md,README.md,bun.lock(+5)
2026-11-25T02:13:25Z s=dcdb118f FINDING src/client.ts:send and RpcContextOptions.fetch learn=test: VERIFIED: src/client.test.ts records all five requests through a context fetch and shows a fetch refusing redirects keeps a redirected schema request from the o
2026-11-25T02:13:25Z s=dcdb118f FINDING src/client.ts:clientOf schema option learn=test: VERIFIED: the schema test counts one schema request for getSchema plus a client.
2026-11-25T02:13:25Z s=dcdb118f FINDING src/client.ts:RpcFetch learn=none: VERIFIED: make lint type-checks the example's wrapper.
2026-11-25T02:13:25Z s=dcdb118f FINDING src/client.ts:download/downloadAsBlob learn=test: VERIFIED: e2e covers module downloads in three browsers and two runtimes.
2026-11-25T02:22:17Z s=d5834857 DONE fp=7caa2ec1645b cov=92.6% paths=ARCH.md,CHANGELOG.md,README.md,docs/index.html(+5)
2026-11-25T02:22:17Z s=d5834857 FINDING src/client.ts:send learn=test: src/client.browser.test.ts 'an upload closes its progress stream when the context's fetch throws instead of rejecting' uses the real browser EventSource and fai
2026-11-25T02:22:17Z s=d5834857 FINDING README.md:465 P07 learn=none: Prose accuracy against behavior is not mechanically checkable; the behavior is documented in RpcContextOptions.fetch.
2026-11-25T02:22:17Z s=d5834857 FINDING README.md:465 A10 learn=none: Paragraph structure is a reading judgment, not a mechanical rule.
2026-11-25T02:22:17Z s=d5834857 FINDING ARCH.md:124 P07 learn=none: Prose accuracy against behavior is not mechanically checkable.
2026-11-25T05:30:10Z s=dcdb118f DONE fp=6b3ce498d4cc cov=92.9% paths=ARCH.md,CHANGELOG.md,README.md,bun.lock(+9)
2026-11-25T05:30:10Z s=dcdb118f FINDING src/server.ts:streaming upload handler call; src/upload-state.ts:fileChunks learn=test: VERIFIED: src/upload.test.ts lists the process's open paths (lsof on macOS, /proc on Linux) after unread, cancelled and locked handlers; without the fix u-unrea
2026-11-25T05:30:10Z s=dcdb118f FINDING src/client.ts (4.3.0, committed c2951b6 and 6b88664) learn=none: VERIFIED: verify log.
2026-11-25T05:30:10Z s=dcdb118f FINDING package.json, CHANGELOG.md, ARCH.md learn=none: VERIFIED: prose check passes.
2026-11-25T06:53:07Z s=dcdb118f DONE fp=71388a3faff6 cov=92.9% paths=ARCH.md,CHANGELOG.md,README.md,bun.lock(+11)
2026-11-25T06:53:07Z s=dcdb118f FINDING src/server.ts:HEAD /rpc/upload/{id} learn=test: VERIFIED: upload.test.ts and express-server.test.ts failed with 404 before and pass; make verify exit 0 (all vitest projects and e2e).
2026-11-25T06:53:07Z s=dcdb118f FINDING src/client.ts resume comment learn=none: VERIFIED: comment only.
2026-11-25T06:53:07Z s=dcdb118f FINDING 4.3.1 (committed bab7008): src/upload-state.ts, src/server.ts learn=test: VERIFIED: the regression test failed without the fix and passes.
2026-11-25T06:53:07Z s=dcdb118f FINDING 4.3.0 (committed): src/client.ts, client tests, examples/client.ts, ARCH.md learn=test: VERIFIED: client.test.ts and client.browser.test.ts pass; the backplane uses it with redirect: error.
2026-11-25T06:53:07Z s=dcdb118f FINDING package.json 4.4.0 + CHANGELOG + docs/index.html learn=none: VERIFIED: grep finds v4.4.0 three times in docs/index.html.
2026-11-26T10:47:50Z s=dcdb118f DONE fp=4529c5c5a7ba cov=93.1% paths=ARCH.md,CHANGELOG.md,README.md,bun.lock(+16)
2026-11-26T10:47:50Z s=dcdb118f FINDING src/call.ts learn=test: VERIFIED: src/call.test.ts 7 pass (module and class calls as plain data with structuredClone and JSON round trips; runs on createRpcServer with Date and bigint 
2026-11-26T10:47:50Z s=dcdb118f FINDING src/client.ts:sendCall, src/server.ts:handleCall, src/types.d.ts:RpcCallDescriptor learn=test: VERIFIED: the gate's make verify passed: lint, Vitest on Node.js, Chromium and WebKit, the server suites on Bun, coverage and the packed e2e. The existing clien
2026-11-26T10:47:50Z s=dcdb118f FINDING examples/client.ts#calls, README.md:Calls as data, docs/index.html, scripts/e2e.mjs learn=test: VERIFIED: make docs wrote README.md and docs/index.html after the region lines fit 80 characters; the gate's e2e passed with both.
2026-11-26T10:47:50Z s=dcdb118f FINDING ARCH.md, CHANGELOG.md, package.json learn=none: VERIFIED: vae.py prose passed in the gate; the claims restate the tests above.
2026-11-26T10:47:50Z s=dcdb118f FINDING plans/2026-11-26_08-19_typed-call-descriptors.md learn=none: VERIFIED: the milestones' proofs are the tests and the e2e above.
2026-11-26T10:47:50Z s=dcdb118f FINDING src/client.browser.test.ts, src/client.test.ts, src/express-server.test.ts, src/upload-state.ts, src/upload.test.ts, bun.lock learn=none: VERIFIED: git status --short lists none of them, and git log names 17650b1 and bab7008 as their last commits.
2026-11-26T10:52:46Z s=dcdb118f DONE fp=cb47e33f8b91 cov=92.9% paths=ARCH.md,CHANGELOG.md,README.md,bun.lock(+16)
2026-11-26T10:52:46Z s=dcdb118f FINDING src/call.ts:RpcCall, src/call.ts:CallBuilder, src/call.test.ts learn=test: VERIFIED: tsc passes with the new @ts-expect-error for a Date parameter, and a JSON-typed assignment of an add call and of a call that omits an optional paramet
2026-11-26T10:52:46Z s=dcdb118f FINDING src/client.browser.test.ts, src/client.test.ts, src/express-server.test.ts, src/upload-state.ts, src/upload.test.ts, bun.lock, src/call.test.ts learn=none: VERIFIED: git status --short lists none of them, and git log names 17650b1 and bab7008 as their last commits.
