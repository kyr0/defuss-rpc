/**
 * `rpcRoute` in your own `Bun.serve`: `bun examples/server-route.ts`. `rpcRoute` is a Fetch handler, so a server you
 * already run can mount it next to its other routes; the CORS headers below are the part ExpressRpcServer would add.
 * PORT picks the port (default 63920, 0 = any). VERIFIED: scripts/e2e.mjs runs this file from the packed package on
 * Bun, and both clients and the website use it.
 */
// #region server-route
import { createRpcServer, rpcRoute } from "defuss-rpc/server";
import RpcApi from "./api.ts";
import "./files.ts";
import "./hooks.ts";

createRpcServer(RpcApi);

// rpcRoute answers requests; CORS for browser pages on other
// origins is the server's job.
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
		const response = await rpcRoute({ request });
		for (const [name, value] of Object.entries(cors)) {
			response.headers.set(name, value);
		}
		return response;
	},
});
// #endregion server-route

console.info(`${new Date().toISOString()} INFO defuss-rpc rpc server listening url=${server.url.origin}`);
process.once("SIGTERM", () => void server.stop().then(() => process.exit(0)));
