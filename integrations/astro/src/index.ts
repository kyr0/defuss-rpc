/**
 * defuss-rpc-astro: the Astro integration of defuss-rpc, `integrations: [defussRpc({ api })]` in `astro.config.ts`.
 *
 * Why an integration on top of the Vite plugin: Astro runs Vite, so the plugin starts the RPC server and serves
 * `virtual:defuss-rpc` in `astro dev`; the integration adds the one thing Vite cannot, a middleware that writes the
 * endpoint into `Astro.locals.rpcEndpoint` for server-rendered code. Why a package of its own: defuss-rpc depends on
 * no framework, and only Astro projects install this package and Astro.
 * VERIFIED: the repository's scripts/e2e.mjs reads `Astro.locals.rpcEndpoint` (http://127.0.0.1:63920) from
 * `astro dev` on Bun and calls the server.
 */
import type { AstroIntegration } from "astro";
import { defussRpc as defussRpcVitePlugin, type RpcPluginOptions } from "defuss-rpc-vite";
import { setRpcConfig } from "defuss-rpc-vite/rpc-state";

/**
 * Creates the Astro integration.
 *
 * @param options - The Vite plugin's options (`api`, `provider`, `port`, `host`, `watch`, `endpoint`, …).
 *
 * @example
 * ```ts
 * // astro.config.ts
 * import { defineConfig } from "astro/config";
 * import { defussRpc } from "defuss-rpc-astro";
 * import RpcApi from "./src/rpc.js";
 *
 * // `bunx --bun astro dev`: Bun.serve on port 63920. On Node.js add `provider: expressProvider()`.
 * export default defineConfig({ integrations: [defussRpc({ api: RpcApi })] });
 * ```
 *
 * Declare the local's type in `src/env.d.ts` when your project does not see this package's global declaration:
 * ```ts
 * declare namespace App {
 *   interface Locals { rpcEndpoint: string }
 * }
 * ```
 */
export function defussRpc(options: RpcPluginOptions): AstroIntegration {
	return {
		name: "defuss-rpc",
		hooks: {
			"astro:config:setup": ({ updateConfig, addMiddleware }) => {
				setRpcConfig(options);
				updateConfig({ vite: { plugins: [defussRpcVitePlugin(options)] } });
				// "pre": the endpoint is in `locals` before any user middleware runs.
				addMiddleware({ order: "pre", entrypoint: "defuss-rpc-astro/middleware" });
			},
		},
	};
}

export type { RpcPluginOptions };
