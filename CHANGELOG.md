# Changelog

## 4.2.0

Client contexts: the client gets state of its own, as the server did in 4.0.0.

### New

- `createRpcContext({ baseUrl, headers })` returns `getRpcClient`, `getSchema`, `addHook`, `setHeaders`, `clearHooks`, `clearSchemaCache`, `upload`, `uploadComplete`, `download` and `downloadAsBlob` with hooks, headers and a schema cache of their own. The module functions keep one process-wide context. A library that calls its own server uses a context, so the application's hooks and headers do not reach those calls, and the library's do not reach the application's.
- A failed schema request throws with `status` and `body`, as a failed call does.

## 4.1.0

Credentials for servers that guard their schema.

### New

- `getRpcClient({ baseUrl, headers })` takes headers for one client. Its schema request and every call it makes send them after the `setHeaders()` set, so one process can call two servers with two credentials.
- `getSchema(baseUrl, headers)` takes the headers of the schema request.

### Fixed

- The schema request sends the `setHeaders()` set. A host that answered 401 to `/rpc/schema` without credentials could not be used with `getRpcClient()` before.
- `setHeaders()` with a `Headers` instance or an array of pairs sends those headers. Object spread had copied nothing from them, so calls and uploads went out without them.
- A header in two sets is sent once, with the later value, whatever the case of its name: `setHeaders(new Headers({ Authorization: "Bearer a" }))` and a client's `{ Authorization: "Bearer b" }` had sent `Bearer a, Bearer b`. The `RequestInit` a client hook sees therefore names its headers in lower case.
- The resume check of `upload()` with an `uploadId` (`HEAD /rpc/upload/{id}`) sends the `setHeaders()` set and the upload's `headers`. Behind a host that answered 401 without them, a resumed upload had started from byte 0.

## 4.0.0

Servers of their own: `createRpcServer()` returns an RPC server instead of registering on one per process. defuss-rpc-vite and defuss-rpc-astro move to 4.0.0 with it (peer range ^4.0.0) and take the server as `rpc`.

### Breaking

- `createRpcServer(api, options)` returns an `RpcServer`: `fetch(request)` (bound), `matches(request)`, `name`, `uploadDir`, `close()`, and `addHook()`, `addUploadHandler()`, `addStreamingUploadHandler()`, `addDownloadHandler()`, `addStreamingDownloadHandler()` that register on this server only. It no longer registers on the process-wide server, so `rpcRoute`, the module functions and `ExpressRpcServer` without `rpc` do not see what it holds. Every call returns a new server; none ignores or replaces another.
- Code written for 3.x keeps working after one rename, from `createRpcServer(api)` to `registerGlobalRpcApi(api)`. README.md, section "Migrating to 4.0", lists the replacement of every deprecated function.

### New

- `new ExpressRpcServer({ rpc })` and `createExpressRpcServer({ rpc })` serve a given RPC server; `stop()` stops the listener and leaves the RPC server open.
- `rpc.close()` ends one server: later requests get 503, running generator streams end with an `error` frame and run their `finally`, progress streams end with an `error` event, and its temp files are deleted.
- Upload sessions, progress listeners and temp files are per server; each server has a temp directory of its own (`<os tmpdir>/defuss-uploads/<random UUID>`, or the `uploadDir` option), so two servers may receive uploads with the same ID at the same time.
- defuss-rpc-vite and defuss-rpc-astro: the `rpc` option takes the server to run; `api` is deprecated and registers on the global server, as before.
- `defuss-rpc schema` also reads `registerGlobalRpcApi(...)` calls and a server assigned to a variable.

### Deprecated

- `registerGlobalRpcApi()`, `rpcRoute`, `addHook()`, `addUploadHandler()`, `addStreamingUploadHandler()`, `addDownloadHandler()`, `addStreamingDownloadHandler()`, `clearUploadHandlers()`, `clearDownloadHandlers()`, `clearRpcServer()`, `setUploadDir()` and `getUploadDir()`: they act on the global server. A repeated `registerGlobalRpcApi()` is still ignored while the global server holds namespaces, now with a `WARN` log line.

## 3.0.0

API documentation from the source, and one rule for what a client may call. The major version is for that rule; defuss-rpc-vite and defuss-rpc-astro move to 3.0.0 with it (unchanged, their peer range is ^3.0.0).

### Breaking

- One exposure rule for `/rpc/schema` and calls: a class exposes the methods its own prototype declares, a module its own enumerable function properties. A call to an inherited method, an instance field holding a function or a getter now answers 404, as a method the schema never listed; redeclare an inherited method on the subclass to expose it.

### New

- `defuss-rpc schema <files | globs>` (the package's `bin`): reads the TypeScript source with ts-morph, follows every `createRpcServer(...)` and `defussRpc({ api })` registration to its classes and objects and writes the documented schema - JSDoc, parameters, return and yield types, a JSON Schema each (`x-dson` for Date, BigInt, binary, Map, Set). `--out`, `--check` for CI, `--project`, and `--endpoint <url>` to keep exactly what a running server serves and warn on every difference.
- Optional documentation fields in the schema format: a method's `description`, `params`, `returns`, `yields`, `deprecated`, `throws`, `examples`; a namespace's `description` (`RpcParamDoc`, `RpcValueDoc`, `RpcJsonSchema`).
- `createRpcServer(api, { docs })` merges a generated schema into `/rpc/schema` by namespace and method name; a name the server does not expose is left out and logged.
- Dependency: ts-morph 28 (the CLI only; the client and server entries do not import it).

## 2.0.0

Standalone repository with verification gates, a project website, server providers, a benchmark, and fixes found by testing every documented example end to end. The major version is for the breaking changes below: the server runs on `Bun.serve` unless given a provider, Node.js needs one, and the default port is 63920.

### Breaking

- `ExpressRpcServer`, `createExpressRpcServer()`, `defussRpc()` (Vite) and `defussRpc()` (Astro) no longer import defuss-express. Without a `provider` they run on `Bun.serve` (Bun only); on Node.js, add `provider: expressProvider()` from `defuss-rpc/providers/express` for the same routes, or the constructor throws and names it.
- The default port is 63920 (`DEFAULT_PORT`) instead of `0`, for the server, the Vite plugin and the Astro integration; pass `port: 0` for any free port.
- The Vite plugin and the Astro integration moved into packages of their own, so defuss-rpc depends on neither Vite nor Astro: `defuss-rpc/vite-plugin` is now `defuss-rpc-vite`, `defuss-rpc/rpc-state` is `defuss-rpc-vite/rpc-state`, `defuss-rpc/astro` is `defuss-rpc-astro`, and `defuss-rpc/astro-middleware` is `defuss-rpc-astro/middleware`. Install them next to defuss-rpc; their options are unchanged. `RpcPluginOptions` is exported by defuss-rpc-vite, no longer by `defuss-rpc/client` and `defuss-rpc/server`.
- defuss-express (uWebSockets.js) is no longer supported: it showed no clear gain over Express on Node.js in `make bench`, it does not load on Bun, and it stalled keep-alive connections after large uploads (see ARCH.md, section Providers).
- `ExpressRpcServer.getApp()` returns the provider's app type (`ExpressRpcServer<App>`); without a provider, a `BunServeApp` whose `fetch` answers requests outside the RPC routes.
- RPC calls with a body other than `Content-Type: application/json` get 400 instead of running with an empty body; unknown `Content-Encoding` gets 415.
- defuss-dson 1.2.0: a method that returns `undefined` gives the client `undefined` instead of `null`, and `NaN`, `Infinity`, `-Infinity` and `-0` arrive as themselves instead of `null` or `0`. A client with defuss-dson below 1.2.0 cannot read those four numbers in an answer.

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
- Security: call bodies are decoded by defuss-dson 1.2.0, which refuses records that build a global named in the body (with 1.1.2, `["Function","return 1"]` reached the method as a function) or take an allocation size from it, and keeps a `__proto__` key as an own property.

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
