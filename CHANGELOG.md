# Changelog

## 2.0.0

Standalone repository with verification gates, a project website, server providers, a benchmark, and fixes found by testing every documented example end to end. The major version is for the breaking changes below: the server runs on `Bun.serve` unless given a provider, Node.js needs one, and the default port is 63920.

### Breaking

- `ExpressRpcServer`, `createExpressRpcServer()`, `defussRpc()` (Vite) and `defussRpc()` (Astro) no longer import defuss-express. Without a `provider` they run on `Bun.serve` (Bun only); on Node.js, add `provider: expressProvider()` from `defuss-rpc/providers/express` for the same routes, or the constructor throws and names it.
- The default port is 63920 (`DEFAULT_PORT`) instead of `0`, for the server, the Vite plugin and the Astro integration; pass `port: 0` for any free port.
- The Vite plugin and the Astro integration moved into packages of their own, so defuss-rpc depends on neither Vite nor Astro: `defuss-rpc/vite-plugin` is now `defuss-rpc-vite`, `defuss-rpc/rpc-state` is `defuss-rpc-vite/rpc-state`, `defuss-rpc/astro` is `defuss-rpc-astro`, and `defuss-rpc/astro-middleware` is `defuss-rpc-astro/middleware`. Install them next to defuss-rpc; their options are unchanged. `RpcPluginOptions` is exported by defuss-rpc-vite, no longer by `defuss-rpc/client` and `defuss-rpc/server`.
- defuss-express (uWebSockets.js) is no longer supported: it showed no clear gain over Express on Node.js in `make bench`, it does not load on Bun, and it stalled keep-alive connections after large uploads (see ARCH.md, section Providers).
- `ExpressRpcServer.getApp()` returns the provider's app type (`ExpressRpcServer<App>`); without a provider, a `BunServeApp` whose `fetch` answers requests outside the RPC routes.
- RPC calls with a body other than `Content-Type: application/json` get 400 instead of running with an empty body; unknown `Content-Encoding` gets 415.

### Providers

- No provider: `Bun.serve` without a framework, the default on Bun.
- `expressProvider()` (`defuss-rpc/providers/express`): Express 5, Node.js and Bun.
- `bunwayProvider()` (`defuss-rpc/providers/bunway`): bunway on `Bun.serve`, Bun only.
- `nodeMiddleware()` and the `RpcServerProvider` contract (`defuss-rpc/express-server`) for providers of other frameworks.
- `make bench`: calls, NDJSON streams, uploads and downloads per provider and runtime, with `rpcRoute` on bare `Bun.serve` as the baseline.

### Fixed

- Methods returning a `Uint8Array`, `Map` or `Set` were streamed as NDJSON and failed on the client; only generator functions stream now.
- `download()` read the file and returned no bytes; it now returns them in `data`, accepts a relative endpoint and defaults to the registered one. `downloadAsBlob()` returned a random `downloadId` instead of the requested one.
- `ExpressRpcServer.start()` reported port `undefined` in 1.x; it reports the bound port and rejects when the port is taken.
- Streaming upload handlers buffered the whole upload in memory (twice); they now read the stored file in 256 KiB chunks.
- Upload progress (SSE) missed every event of an upload that finished within its 200 ms poll; it is event-driven and subscribes before the upload starts.
- A file name outside Latin-1 made `upload()` throw in browsers, and Latin-1 names lost characters; names travel percent-encoded, and downloads use RFC 6266 `filename*`.
- Generators kept running after the client disconnected from `ExpressRpcServer` or broke out of `for await`.
- `Astro.locals.rpcEndpoint` was empty in `astro dev`, because Astro's SSR build loads a second copy of the package; shared state now lives on `globalThis`.
- A file change in Vite's watch list deleted every upload handler, download handler and hook.
- `corsOrigin: [...]` sent an invalid comma-joined header; listed origins are now echoed with `Vary: Origin`.
- Malformed call bodies answered 500 instead of 400; `constructor` and `Object.prototype` members were callable.
- Namespace proxies were thenables, so `await`ing a namespace sent a bogus `then` call.
- The schema cache was shared across endpoints; it is now per `baseUrl`.
- A failed resume left an orphan session; concurrent first requests in the Astro middleware could start two servers.

### Added

- Entry points without `.js` (`defuss-rpc/client` and the others) next to the existing ones.
- `rpcRoute` has its own `RpcRoute` type, so server types no longer need Astro installed.
- `setUploadDir()` / `getUploadDir()`, `parseContentDisposition()`.
- Bun support for servers: `Bun.serve` + `rpcRoute`, and `ExpressRpcServer` on Express or bunway, tested end to end.

### Changed

- Logs are single lines with ISO-8601 timestamp and level; per-request logging and logging of arguments and requests were removed.
- `engines.node` is `>=22.0.0`, the oldest Node.js version CI tests.
- `jsonSizeLimit` accepts bytes or `"512kb"`-style sizes, counts decompressed bytes, and a malformed value throws at construction.
- Large downloads wait for the client (`drain`) instead of piling up in memory.
