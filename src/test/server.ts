/** Node.js test helpers: real servers on ephemeral ports and direct `rpc.fetch` calls. */
import { DSON } from "defuss-dson";
import { ExpressRpcServer, type ExpressRpcServerOptions } from "../express-server.js";
import type { RpcServerProvider } from "../provider.js";
import { expressProvider } from "../providers/express.js";
import { createRpcServer } from "../server.js";
import type { ApiNamespace, RpcServer } from "../types.d.js";

const onBun = Boolean(process.versions.bun);

/**
 * Every provider this runtime can load, for `describe.for(PROVIDERS)`: Express on Node.js; Express, bunway and the
 * default (`Bun.serve`, name "bun") on Bun. bunway is imported only on Bun, because Node.js cannot load it.
 */
export const PROVIDERS: RpcServerProvider<unknown>[] = [
	expressProvider(),
	...(onBun ? [(await import("../providers/bunway.js")).bunwayProvider(), (await import("../providers/bun.js")).bunServeProvider()] : []),
] as RpcServerProvider<unknown>[];

/**
 * Starts an `ExpressRpcServer` on `provider` and a free port for `rpc`, or for a new server of `api`. `stop()` stops
 * the listener, and closes the RPC server when this function created it.
 */
export async function startServer(
	provider: RpcServerProvider<unknown>,
	api: ApiNamespace | RpcServer,
	options: Omit<ExpressRpcServerOptions, "provider" | "rpc"> = {},
) {
	const given = typeof (api as RpcServer).fetch === "function";
	const rpc = given ? (api as RpcServer) : createRpcServer(api as ApiNamespace);
	const server = new ExpressRpcServer({ port: 0, ...options, provider, rpc });
	const { url, port } = await server.start();
	const stop = async () => {
		await server.stop();
		if (!given) await rpc.close();
	};
	return { rpc, server, url, port, stop };
}

/** Sends one RPC call straight to `rpc.fetch` (no HTTP server). */
export function callRoute(rpc: RpcServer, className: string, methodName: string, args: unknown[] = [], path = "/rpc", body?: string) {
	const request = new Request(`http://localhost${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: body ?? DSON.stringify({ className, methodName, args }),
	});
	return rpc.fetch(request);
}

/** Parses an NDJSON body into DSON frames. */
export async function frames(response: Response): Promise<any[]> {
	return (await response.text())
		.split("\n")
		.filter(Boolean)
		.map((line) => DSON.parse(line));
}

/** SHA-256 hex digest with node:crypto, independent of the code under test. */
export async function sha256(data: Uint8Array): Promise<string> {
	const { createHash } = await import("node:crypto");
	return createHash("sha256").update(data).digest("hex");
}
