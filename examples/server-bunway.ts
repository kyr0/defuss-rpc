/**
 * The demo server on bunway (Bun only): `bun examples/server-bunway.ts`.
 * VERIFIED: scripts/e2e.mjs runs this file from the packed package on Bun; both clients and the website use it.
 * PORT picks the port (default 63920, 0 = any free port); SIGTERM stops it.
 */
// #region server-bunway
import { createRpcServer } from "defuss-rpc/server";
import { ExpressRpcServer } from "defuss-rpc/express-server";
import { bunwayProvider } from "defuss-rpc/providers/bunway";
import RpcApi from "./api.ts";
import "./files.ts";
import "./hooks.ts";

createRpcServer(RpcApi);

const server = new ExpressRpcServer({
	provider: bunwayProvider(), // bunway on Bun.serve: Bun only
	host: "127.0.0.1",
	port: Number(process.env.PORT ?? 63920),
});
await server.start(); // logs: … INFO defuss-rpc rpc server listening url=http://127.0.0.1:63920 provider=bunway
// #endregion server-bunway

process.once("SIGTERM", () => void server.stop().then(() => process.exit(0)));
