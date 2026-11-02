/** `bunx --bun astro dev --root example` (from integrations/astro): the integration starts the RPC server and fills
 * Astro.locals.rpcEndpoint. VERIFIED: the repository's scripts/e2e.mjs runs it from the packed packages on Bun and
 * reads the endpoint in the page.
 */
// #region astro-config
import { defineConfig } from "astro/config";
import { defussRpc } from "defuss-rpc-astro";
import RpcApi from "./api.ts";

export default defineConfig({
	// No provider: the RPC server runs on Bun.serve, port 63920.
	// On Node.js add `provider: expressProvider()`.
	integrations: [
		defussRpc({
			api: RpcApi,
			host: "127.0.0.1",
			watch: ["api.ts"],
		}),
	],
});
// #endregion astro-config
