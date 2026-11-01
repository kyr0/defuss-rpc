/** `bunx --bun vite example` (from integrations/vite) starts the dev server and, through the plugin, the RPC server
 * beside it. VERIFIED: the repository's scripts/e2e.mjs starts it from the packed packages on Bun, and Chromium sees
 * the RPC result in the page.
 */
// #region vite-config
import { defineConfig } from "vite";
import { defussRpc } from "defuss-rpc-vite";
import RpcApi from "./api.ts";

// No provider: the RPC server runs on Bun.serve, port 63920. On Node.js add `provider: expressProvider()`.
export default defineConfig({
	plugins: [defussRpc({ api: RpcApi, host: "127.0.0.1", watch: ["api.ts"] })],
});
// #endregion vite-config
