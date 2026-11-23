/**
 * An RPC server in your own `Bun.serve`: `bun examples/server-route.ts`. `rpc.fetch` is a Fetch handler, so a server
 * you already run can mount it next to its other routes; the CORS headers below are part of what ExpressRpcServer
 * would add.
 * PORT picks the port (default 63920, 0 = any). VERIFIED: scripts/e2e.mjs runs this file from the packed package on
 * Bun, and both clients and the website use it.
 */
// #region server-route
import { createRpcServer } from "defuss-rpc/server";
import RpcApi from "./api.ts";
import { addFileHandlers } from "./files.ts";
import { addUploadLimit } from "./hooks.ts";

const rpc = createRpcServer(RpcApi);
addFileHandlers(rpc);
addUploadLimit(rpc);

// rpc.fetch answers RPC requests; CORS for browser pages on other
// origins is the host's job.
const cors = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Expose-Headers":
		"Content-Disposition, X-File-Sha256, X-Upload-Offset",
};

const server = Bun.serve({
	hostname: "127.0.0.1",
	port: Number(process.env.PORT ?? 63920),
	// seconds: streams and upload progress keep a request open
	// longer than Bun's default of 10
	idleTimeout: 120,
	async fetch(request) {
		if (request.method === "OPTIONS") {
			const allowHeaders =
				request.headers.get("Access-Control-Request-Headers") ??
				"Content-Type";
			return new Response(null, {
				headers: { ...cors, "Access-Control-Allow-Headers": allowHeaders },
			});
		}
		if (!rpc.matches(request)) {
			return new Response("Not Found", { status: 404 });
		}
		const response = await rpc.fetch(request);
		for (const [name, value] of Object.entries(cors)) {
			response.headers.set(name, value);
		}
		return response;
	},
});
// #endregion server-route

console.info(`${new Date().toISOString()} INFO defuss-rpc rpc server listening url=${server.url.origin}`);
process.once("SIGTERM", () => void server.stop().then(() => rpc.close()).then(() => process.exit(0)));
