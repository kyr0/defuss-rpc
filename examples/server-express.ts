/**
 * The demo server on Express 5, on Node.js or Bun: `node examples/server-express.ts` | `bun examples/server-express.ts`.
 * PORT picks the port (default 63920, 0 = any free port); SIGTERM stops it.
 * VERIFIED: scripts/e2e.mjs runs this file from the packed package on Node.js and on Bun; both clients and the website use it.
 */
// #region server-express
import { createRpcServer } from "defuss-rpc/server";
import { ExpressRpcServer } from "defuss-rpc/express-server";
import { expressProvider } from "defuss-rpc/providers/express";
import RpcApi from "./api.ts";
import "./files.ts";
import "./hooks.ts";

createRpcServer(RpcApi);

const server = new ExpressRpcServer({
	provider: expressProvider(), // Express 5 on node:http: Node.js and Bun
	host: "127.0.0.1",
	port: Number(process.env.PORT ?? 63920),
});
// Your own Express routes and middleware live on the same app;
// add them before start().
server.getApp().get("/version", (_req, res) => void res.json({ version: 1 }));
await server.start(); // listening at http://127.0.0.1:63920
// #endregion server-express

process.once("SIGTERM", () => void server.stop().then(() => process.exit(0)));
