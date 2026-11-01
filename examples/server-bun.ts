/**
 * The demo server with no provider: `bun examples/server-bun.ts`. Without a provider, ExpressRpcServer runs on
 * `Bun.serve`, the default on Bun, and listens on port 63920. PORT picks another port (0 = any free port); SIGTERM
 * stops it. VERIFIED: scripts/e2e.mjs runs this file from the packed package on Bun; both clients and the website use
 * it.
 */
// #region server-bun
import { createRpcServer } from "defuss-rpc/server";
import { ExpressRpcServer } from "defuss-rpc/express-server";
import RpcApi from "./api.ts";
import "./files.ts";
import "./hooks.ts";

createRpcServer(RpcApi);

// No provider: Bun.serve, without a framework. On Node.js, select one (server-express.ts).
const server = new ExpressRpcServer({
	host: "127.0.0.1",
	port: process.env.PORT ? Number(process.env.PORT) : undefined, // undefined: 63920
});
// Requests outside the RPC routes go to one fetch handler (default: 404); add your own before start().
server.getApp().fetch = (request) =>
	new URL(request.url).pathname === "/version" ? Response.json({ version: 1 }) : new Response("Not Found", { status: 404 });
await server.start(); // logs: … INFO defuss-rpc rpc server listening url=http://127.0.0.1:63920 provider=bun
// #endregion server-bun

process.once("SIGTERM", () => void server.stop().then(() => process.exit(0)));
