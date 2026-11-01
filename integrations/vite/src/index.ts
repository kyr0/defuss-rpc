/**
 * defuss-rpc-vite: a Vite plugin that runs a defuss-rpc server beside `vite dev` and tells the client where it is.
 *
 * Why a separate server instead of Vite middleware: the RPC server must be the same `ExpressRpcServer` on the same
 * provider in development and production, with the same streaming, upload and CORS behavior, so `vite dev` is no
 * special case.
 * The client learns the server's URL from the `virtual:defuss-rpc` module, which registers it as the default
 * endpoint, so app code calls `getRpcClient()` without options in every environment.
 * Why a package of its own: defuss-rpc itself depends on no build tool, and only applications that use Vite install
 * this plugin and Vite.
 * VERIFIED: src/index.test.ts starts Vite with the plugin on Express and, on Bun, without a provider; handlers
 * survive an API file change, and a restart keeps a fixed port.
 */
import type { Plugin, ViteDevServer } from "vite";
import { createFilter } from "vite";
import { createRpcServer } from "defuss-rpc/server";
import { ExpressRpcServer } from "defuss-rpc/express-server";
import { getRpcEndpoint, getRpcServer, setRpcConfig, setRpcEndpoint, setRpcServer, type RpcPluginOptions } from "./rpc-state.js";

const VIRTUAL_MODULE_ID = "virtual:defuss-rpc";
const RESOLVED_VIRTUAL_MODULE_ID = `\0${VIRTUAL_MODULE_ID}`;

/** The source of `virtual:defuss-rpc`: the endpoint as a constant, registered with the client on import. */
function virtualModule(endpointExpression: string): string {
	return [
		`import { _setDefaultEndpoint } from "defuss-rpc/client";`,
		`export const rpcEndpoint = ${endpointExpression};`,
		`/** @deprecated Use rpcEndpoint instead. */`,
		`export const rpcBaseUrl = rpcEndpoint;`,
		`_setDefaultEndpoint(rpcEndpoint);`,
	].join("\n");
}

/**
 * Creates the Vite plugin.
 *
 * - `vite dev`: registers `options.api`, starts an `ExpressRpcServer` (on `Bun.serve` unless `options.provider` names
 *   one; port 63920 unless `options.port` does) and stops it with Vite. `virtual:defuss-rpc` exports the running server's URL, or `options.endpoint` when set.
 * - `vite build`: starts nothing; `virtual:defuss-rpc` exports `options.endpoint`, else
 *   `import.meta.env.VITE_DEFUSS_RPC_URL`, else `""` (same origin as the page).
 * - A change to a file matching `watch` reloads the page, so it fetches the schema again. The API itself is
 *   re-registered when Vite restarts after a change to `vite.config.ts` or a file it imports.
 *
 * @example
 * ```ts
 * // vite.config.ts
 * import { defineConfig } from "vite";
 * import { defussRpc } from "defuss-rpc-vite";
 * import RpcApi from "./src/rpc.js";
 *
 * // `bunx --bun vite`: Bun.serve on port 63920. On Node.js add `provider: expressProvider()`.
 * export default defineConfig({ plugins: [defussRpc({ api: RpcApi })] });
 * ```
 */
export function defussRpc(options: RpcPluginOptions): Plugin {
	const watchPatterns = options.watch
		? Array.isArray(options.watch)
			? options.watch
			: [options.watch]
		: ["src/**/*.ts"];
	const watchFilter = createFilter(watchPatterns);
	let isBuild = false;

	setRpcConfig(options);

	return {
		name: "vite:defuss-rpc",
		enforce: "pre",

		config(_config, { command }) {
			isBuild = command === "build";
			// Pre-bundling could give `defuss-rpc/client` and `defuss-rpc/client.js` separate copies of the module, and
			// the endpoint registered by the virtual module would then be invisible to app code importing the other.
			return { optimizeDeps: { exclude: ["defuss-rpc"] } };
		},

		async configureServer(viteServer: ViteDevServer) {
			// Replace, not merge: a restarted dev server (after a config change) must serve the new API object, while
			// createRpcServer() alone would keep the first registration.
			createRpcServer({});
			createRpcServer(options.api);
			// Vite starts the restarted dev server before it closes the old one, and both want the same fixed port.
			// VERIFIED: restartServer() in vite 8.3.5 (dist/node/chunks/node.js) runs configureServer, then _closeServer.
			await getRpcServer()?.stop();

			const server = new ExpressRpcServer({
				provider: options.provider,
				port: options.port,
				protocol: options.protocol,
				host: options.host,
				basePath: options.basePath,
				jsonSizeLimit: options.jsonSizeLimit,
				corsOrigin: options.corsOrigin,
				compression: options.compression,
			});
			const { url } = await server.start();
			setRpcEndpoint(options.endpoint ?? options.productionUrl ?? url);
			setRpcServer(server);

			viteServer.httpServer?.on("close", () => server.stop());
			// Without an HTTP server (middleware mode) Vite emits no "close"; its own close() still stops the RPC server.
			const close = viteServer.close.bind(viteServer);
			viteServer.close = async () => {
				await server.stop();
				return close();
			};

			viteServer.watcher.add(watchPatterns);
		},

		handleHotUpdate({ file, server }) {
			if (!watchFilter(file)) return;
			// Vite's logger, not the console: the line appears with Vite's own output and respects its logLevel.
			server.config.logger.info(`defuss-rpc: ${file} changed, reloading the page`, { timestamp: true });
			const mod = server.moduleGraph.getModuleById(RESOLVED_VIRTUAL_MODULE_ID);
			if (mod) server.moduleGraph.invalidateModule(mod);
			server.ws.send({ type: "full-reload" });
			return [];
		},

		resolveId(id) {
			return id === VIRTUAL_MODULE_ID ? RESOLVED_VIRTUAL_MODULE_ID : null;
		},

		load(id) {
			if (id !== RESOLVED_VIRTUAL_MODULE_ID) return null;
			if (!isBuild) return virtualModule(JSON.stringify(getRpcEndpoint()));
			const explicit = options.endpoint ?? options.productionUrl;
			return virtualModule(explicit ? JSON.stringify(explicit) : `import.meta.env.VITE_DEFUSS_RPC_URL || ""`);
		},
	};
}

export type { RpcPluginOptions };
