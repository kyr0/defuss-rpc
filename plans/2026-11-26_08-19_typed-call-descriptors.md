# Typed call descriptors: build, encode and send an RPC call as data

Goal: callers that store or forward a call, such as a defuss-backplane `_rpc` schedule, build it from the server's typed API, and defuss-rpc alone turns it into the wire format. Today they write `{ className: "ReportApi", methodName: "nightly", args: [...] }` by hand and copy the body encoding. A wire change, a renamed method or a wrong argument then breaks them silently.

Milestones tick `- [x]` when their proof passes; then run `verify` on that milestone's scope.

## Evidence

- VERIFIED: the client builds the body in one place, `src/client.ts:sendCall` (line 229): `POST ${baseUrl}/rpc`, `Content-Type: application/json`, body `DSON.stringify({ className, methodName, args })`.
- VERIFIED: the server parses it in `src/server.ts:parseRpcCallDescriptor` (line 112, not exported). It tries DSON, then plain JSON, and requires string `className`, string `methodName` and an `args` array.
- VERIFIED: `RpcCallDescriptor` in `src/types.d.ts` (line 277) is exported and documented as the wire format. It also has the unused `id` and `ts` fields. Its `args` comment still says JSON, but the client sends DSON.
- VERIFIED: three copies of the wire format live outside defuss-rpc.
  - defuss-backplane `src/callbacks.ts:99` builds the same DSON body for each scheduled callback.
  - defuss-mcp `dist/rpc.mjs:88` (`exposeRpc`) builds it for each tool call.
  - Apps write the descriptor fields into schedule payloads, for example defuss-backplane `README.md` under "RPC callbacks", and `examples/linear-clone/src/server/jobs.ts:upsertSchedules`.
- VERIFIED: a class namespace is called as `new rpc.UserApi().getUser("1")`, and constructor arguments are not sent (`src/client.ts:340`). A module namespace is called as `rpc.Mod.fn()`.
- VERIFIED: defuss-backplane `src/callbacks.ts:callback` rejects any payload key other than `url`, `className`, `methodName` and `args`. Scheduler payloads are JSON (defuss-backplane README, "Scheduling"). A stored schedule outlives the code and the defuss-rpc version that wrote it.

## Decision

defuss-rpc owns one module, `src/call.ts`, exported from `defuss-rpc/client` because it is isomorphic, with no Node.js-only imports. It defines the stored form of a call and the only functions that convert it to and from the wire. The client's `sendCall` and the server's dispatch both go through it, so the client, the server, the backplane, defuss-mcp and apps cannot drift apart.

```ts
/** A call as data: what a scheduler, a queue or a log keeps. JSON when its args are JSON. */
export interface RpcCall { v: 1; className: string; methodName: string; args: unknown[] }
/** Typed builder over `typeof RpcApi`: `calls.Mod.fn(a)` and `new calls.Cls().method(a)` return an RpcCall. */
export function rpcCalls<T extends Record<string, unknown>>(): RpcCalls<T>;
export function parseRpcCall(value: unknown): RpcCall | null;   // v1, and the flat legacy form without `v`
export function encodeRpcCall(call: RpcCall): { method: "POST"; path: "/rpc"; headers: Record<string, string>; body: string };
export function sendRpcCall(baseUrl: string, call: RpcCall, init?: { headers?: HeadersInit; fetch?: RpcFetch; signal?: AbortSignal }): Promise<Response>;
```

`RpcCalls<T>` maps each function of `T` to `(...args: Parameters<F>) => RpcCall`. Generator methods map to `never`, because a stored call expects one answer and a generator streams NDJSON. Wrong argument types or unknown names fail to compile.

Versioning: `v` versions the stored form, not the wire. `parseRpcCall` accepts every `v` it ever produced and the flat form without `v`. `encodeRpcCall` always writes the current wire. A wire change edits `encodeRpcCall` and the server parser together, and stored calls keep working. A new `v` appears only when the stored fields change. Why not store the encoded body: the body is DSON's compact encoding, which an agent cannot read in a schedule, and storing it would freeze the wire format into persisted data.

| Alternative | Why not |
| --- | --- |
| Keep the flat fields and document them as stable | Hand-written names still compile when wrong, and every adopter keeps its own copy of the body encoding. |
| Store `DSON.stringify(body)` in payloads | It is opaque to agents and pins today's wire format into data that lives for months. |
| Check each call against the server's `/rpc/schema` when a schedule is created | It needs the app online when the schedule is created. YAGNI: the typed builder catches the same mistakes at compile time. |

## Milestones (defuss-rpc 4.5.0, additive)

- [ ] R1 `src/call.ts`: `RpcCall`, `parseRpcCall` (moved from `src/server.ts:parseRpcCallDescriptor`, plus `v` and the object input), and `encodeRpcCall`. `src/server.ts` dispatch and `src/client.ts:sendCall` call them. Fix the `RpcCallDescriptor.args` comment. Proof: the existing `make test` suites stay green, so the wire is unchanged. A new `src/call.test.ts` passes `parseRpcCall` the v1 object, the flat legacy object, DSON and JSON text, and rejects a missing name, non-array `args` and an unknown `v`. Its golden fixture, `src/test/fixtures/call-v1.json`, must parse forever.
- [ ] R2 `rpcCalls<T>()`: a Proxy that records the namespace and method of module calls (`get`, `get`) and of class calls (`construct`, then `get`). The output is plain data with no Proxy left, so `structuredClone` and `JSON.stringify` work. Proof: `src/call.test.ts` round-trips a module call and a class call built with `rpcCalls<typeof Api>()`, through `encodeRpcCall` and a real `createRpcServer(Api).fetch(new Request(...))`, and gets the function's result. Type checks under `make lint` use `// @ts-expect-error` for a wrong argument type, an unknown method and a generator method.
- [ ] R3 `sendRpcCall`: `fetch(baseUrl + path, encodeRpcCall(call))` with the caller's headers and fetch. It returns the `Response` and does not throw on non-2xx, because a scheduler judges the status itself. Proof: `src/call.test.ts` against a real server: 200 with the result, 404 for an unknown namespace, and 403 from a guard hook that sees the header.
- [ ] R4 Docs and release: a README section "Calls as data" with the backplane schedule as the example, ARCH.md naming `src/call.ts` as the owner of the wire format, and a CHANGELOG entry. Proof: `make e2e` with a consumer step that packs the tarball, builds a call with `rpcCalls`, sends it to a Node.js and a Bun server, and checks the result. The human publishes 4.5.0, because `npm publish` needs 2FA (`.vae/MEMORY.md`).

## Adoption after 4.5.0 is published

- [ ] B1 defuss-backplane `src/callbacks.ts:callback`: allow the key `v` and delegate the call fields to `parseRpcCall`. `url` stays a backplane field and keeps its loopback and origin checks. `call()` sends with `encodeRpcCall` instead of its own `DSON.stringify` body. Stored payloads without `v` keep running. Proof: `tests/scheduler.test.ts` delivers one flat payload and one built with `rpcCalls`. The deep suite's `_rpc` step (`scripts/deep/scheduler.ts`) builds its payload with `rpcCalls`, and `make e2e` passes.
- [ ] B2 defuss-backplane README "RPC callbacks": the example becomes `payload: { url, ...new calls.ReportApi().nightly({ days: 1 }) }`, with `const calls = rpcCalls<typeof ReportApiNamespace>()`. Proof: `make e2e` type-checks the consumer scripts that use it. Docs gate.
- [ ] L1 linear-clone `src/server/jobs.ts:upsertSchedules`: `payload = { url: rpcUrl, ...rpcCalls<Api>().Jobs[methodName]() }`. The first start after the change updates each live schedule once, because `v` is new in the payload. Proof: `tests/jobs.test.ts` (restart, successor and delivery) and the deep suite's jobs steps.
- [ ] M1 defuss-mcp `exposeRpc`: build its request with `encodeRpcCall`. Proof: defuss-mcp's own tests. This is a separate repository and release.

## Open points

- UNKNOWN: whether the backplane rejects or silently changes a non-JSON argument, such as a `Date`, in a `_rpc` payload. The scheduler stores JSON. Probe: create a schedule whose `args` holds a `Date` over RPC, then read it back. If the payload changes, `rpcCalls` adopters need a note or a check, `isJsonCall(call)`, before B2.
- HYPOTHESIS: `RpcCalls<T>` can reuse the method-extraction types the client typing already has in `src/types.d.ts`. Falsifier: a `tsc` error in R2 that forces separate mapped types.
