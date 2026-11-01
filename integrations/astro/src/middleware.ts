/**
 * Astro middleware injected by the `defussRpc()` integration: it puts the RPC endpoint into
 * `Astro.locals.rpcEndpoint` for every page and API route.
 *
 * Why middleware and not the virtual module alone: server-rendered code (frontmatter, API routes) runs in Node.js,
 * where it may need the endpoint for its own calls or to hand it to the page, and Astro passes per-request values
 * through `locals`.
 * VERIFIED: src/index.test.ts starts one server for concurrent first requests. UNKNOWN: whether the saved options
 * reach this middleware behind an SSR adapter; no test runs one.
 */
import { defineMiddleware } from "astro/middleware";
import { getRpcConfig, getRpcEndpoint, setRpcEndpoint, setRpcServer } from "defuss-rpc-vite/rpc-state";
import { createRpcServer } from "defuss-rpc/server";
import { ExpressRpcServer } from "defuss-rpc/express-server";

declare global {
	namespace App {
		interface Locals {
			rpcEndpoint: string;
		}
	}
}

/** The one production start; concurrent first requests share it instead of each starting a server. */
let starting: Promise<string> | null = null;

/**
 * Starts the RPC server from the integration's saved options. In `astro dev` the Vite plugin has already started it
 * and set the endpoint, so this runs only in a production server (`astro build` + an SSR adapter).
 */
function startFromConfig(): Promise<string> {
	starting ??= (async () => {
		const config = getRpcConfig();
		if (!config) return "";
		createRpcServer(config.api);
		const server = new ExpressRpcServer({
			provider: config.provider,
			port: config.port,
			protocol: config.protocol,
			host: config.host,
			basePath: config.basePath,
			jsonSizeLimit: config.jsonSizeLimit,
			corsOrigin: config.corsOrigin,
			compression: config.compression,
		});
		const { url } = await server.start();
		const endpoint = config.endpoint ?? config.productionUrl ?? url;
		setRpcEndpoint(endpoint);
		setRpcServer(server);
		return endpoint;
	})();
	return starting;
}

/**
 * Sets `context.locals.rpcEndpoint`: the dev server's endpoint, or, on the first production request, the endpoint
 * of the server it starts. Without a saved config (the integration was not added) it is `""`.
 */
export const onRequest = defineMiddleware(async (context, next) => {
	context.locals.rpcEndpoint = getRpcEndpoint() || (await startFromConfig());
	return next();
});
