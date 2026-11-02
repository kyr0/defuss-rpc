/**
 * The default provider: `Bun.serve` without a framework, which `ExpressRpcServer` uses when no `provider` is given.
 *
 * Why it is the default: it needs no framework package, and it answered the most small calls of every
 * `ExpressRpcServer` setup. VERIFIED: two `make bench` runs on 2026-11-02 (README.md, section Benchmark), 63,926 and
 * 64,195 calls per second against bunway's 53,315 and 52,784. Why there is no Node.js default:
 * the alternative, Express, would have to be imported, so the server would load a framework the application never
 * chose, and what runs would depend on what happens to be installed; on Node.js the constructor throws instead and
 * names `expressProvider()`.
 *
 * Why it calls `Bun.serve` with one `fetch` handler instead of Bun's `routes`: the HTTP core answers preflights for
 * every path and adds CORS headers to every response, which per-route handlers would bypass. Requests the RPC
 * server does not match go to `getApp().fetch` (404 by default), with CORS headers added.
 *
 * @internal
 */
import type { RpcHttpCore, RpcListener, RpcServerProvider } from "../provider.js";

/** The app of the default provider: answers what the RPC server does not, for your own routes. */
export interface BunServeApp {
	/** Handler for requests outside the RPC routes; replace it before `start()`. Default: 404. */
	fetch(request: Request): Response | Promise<Response>;
}

const cores = new WeakMap<BunServeApp, RpcHttpCore>();

/** Copies a response with the CORS headers for `request` added; a fetched `Response` has immutable headers. */
function withCors(response: Response, request: Request, rpc: RpcHttpCore): Response {
	const headers = new Headers(response.headers);
	for (const [key, value] of rpc.corsHeaders(request.headers.get("origin"), request.headers.get("access-control-request-headers"))) {
		headers.set(key, value);
	}
	return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/** The path of an absolute request URL, without parsing the whole URL. */
function pathOf(url: string): string {
	const start = url.indexOf("/", url.indexOf("//") + 2);
	if (start === -1) return "/";
	const query = url.indexOf("?", start);
	return query === -1 ? url.slice(start) : url.slice(start, query);
}

/** Creates the default provider; `ExpressRpcServer` calls it when its options have no `provider`. */
export function bunServeProvider(): RpcServerProvider<BunServeApp> {
	return {
		name: "bun",
		createApp: () => ({ fetch: () => new Response("Not Found", { status: 404 }) }),
		use: (app, rpc) => void cores.set(app, rpc),
		listen: (app, port, host) =>
			new Promise<RpcListener>((resolve, reject) => {
				const rpc = cores.get(app);
				if (!rpc) throw new Error("bunServeProvider: listen() before use()");
				try {
					// Bun.serve binds synchronously and throws EADDRINUSE.
					const server = Bun.serve({
						port,
						hostname: host,
						fetch: async (request, bun) => {
							if (!rpc.match(request.method, pathOf(request.url))) return withCors(await app.fetch(request), request, rpc);
							const response = await rpc.handle(request);
							// Bun closes a connection after 10 s without traffic; a stream may be quiet longer.
							if (rpc.isStream(response)) bun.timeout(request, 0);
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
