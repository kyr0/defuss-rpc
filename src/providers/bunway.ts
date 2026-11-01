/**
 * bunway provider (Bun only): `new ExpressRpcServer({ provider: bunwayProvider() })` runs the RPC server on
 * [bunway](https://bunway.jointops.dev), an Express-style framework on `Bun.serve`.
 *
 * Why choose it: bunway keeps the Express API (`app.get(path, (req, res) => …)`) while requests travel as Fetch
 * `Request`s through `Bun.serve`, without a `node:http` compatibility layer. The RPC core takes bunway's original
 * `Request` and returns a `Response`, whose body stream bunway hands to Bun unchanged. VERIFIED: the server suites
 * pass with this provider on Bun (`make test`); Node.js cannot import bunway 1.1.0.
 *
 * Why this provider calls `Bun.serve` itself instead of `app.listen()`: Bun closes a connection after 10 s without
 * traffic, and a generator stream or an upload progress stream can be quiet longer; the provider lifts that limit
 * for streaming responses only (`server.timeout(request, 0)`). bunway's WebSocket routes need its own `listen()`
 * and are not served through this provider.
 */
import { bunway, type BunRequest, type BunResponse, type BunWayApp } from "bunway";
import type { RpcHttpCore, RpcServerProvider } from "../provider.js";

/** Creates the bunway provider; each `ExpressRpcServer` gets its own bunway app. */
export function bunwayProvider(): RpcServerProvider<BunWayApp> {
	// One provider may serve several servers (apps), so each app keeps its own core.
	const cores = new WeakMap<BunWayApp, RpcHttpCore>();
	return {
		name: "bunway",
		createApp: () => bunway(),
		use: (app, rpc) => {
			cores.set(app, rpc);
			app.use(async (req: BunRequest, res: BunResponse, next: (error?: unknown) => void) => {
				const request = req.original;
				if (!rpc.match(request.method, req.path)) {
					for (const [key, value] of rpc.corsHeaders(request.headers.get("origin"), request.headers.get("access-control-request-headers"))) {
						res.set(key, value);
					}
					next();
					return;
				}
				const response = await rpc.handle(request);
				res.status(response.status);
				for (const [key, value] of response.headers) {
					if (key !== "set-cookie") res.set(key, value);
				}
				for (const cookie of response.headers.getSetCookie()) res.append("Set-Cookie", cookie);
				// end() keeps any body as it is, and bunway turns it into `new Response(body)`: the stream stays a stream.
				res.end((response.body ?? undefined) as unknown as Uint8Array);
			});
		},
		listen: (app, port, host) =>
			new Promise((resolve, reject) => {
				try {
					// Bun.serve binds synchronously and throws EADDRINUSE.
					const server = Bun.serve({
						port,
						hostname: host,
						fetch: async (request, bun) => {
							const response = await app.handle(request, bun);
							if (cores.get(app)?.isStream(response)) bun.timeout(request, 0);
							return response;
						},
					});
					resolve({ port: server.port ?? port, close: () => server.stop(true) });
				} catch (error) {
					reject(error);
				}
			}),
	};
}
