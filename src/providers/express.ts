/**
 * Express provider: `new ExpressRpcServer({ provider: expressProvider() })` runs the RPC server on Express 5.
 *
 * Why choose it: Express is plain JavaScript on `node:http`, so it runs wherever `node:http` does (Node.js and Bun),
 * and an existing Express application can add its own routes and middleware through `server.getApp()`.
 * VERIFIED: the server test suites pass with this provider on Node.js and on Bun (`make test`).
 *
 * Install `express` (5.x) next to defuss-rpc, and `@types/express` for typed `getApp()` routes.
 */
import { createServer } from "node:http";
import express, { type Express } from "express";
import { nodeMiddleware } from "../node-bridge.js";
import type { RpcListener, RpcServerProvider } from "../provider.js";

/** Creates the Express provider; each `ExpressRpcServer` gets its own Express app. */
export function expressProvider(): RpcServerProvider<Express> {
	return {
		name: "express",
		createApp: () => express(),
		use: (app, rpc) => void app.use(nodeMiddleware(rpc)),
		listen,
	};
}

/**
 * Serves `app` on `host:port` and resolves once the port is bound; rejects when it cannot be.
 *
 * Why not `app.listen()`: Express 5 passes a taken port to the listen callback instead of failing, and closing its
 * server leaves open connections alone, which a running stream or an idle keep-alive socket holds forever.
 * VERIFIED: express/lib/application.js (5.3.0); src/express-server.test.ts checks EADDRINUSE and that `stop()` ends a
 * running stream.
 */
function listen(app: Express, port: number, host: string): Promise<RpcListener> {
	return new Promise((resolve, reject) => {
		const server = createServer(app);
		server.once("error", reject);
		server.listen(port, host, () => {
			server.off("error", reject);
			const address = server.address();
			resolve({
				port: typeof address === "object" && address ? address.port : port,
				close: () =>
					new Promise<void>((done) => {
						server.close(() => done());
						server.closeAllConnections();
					}),
			});
		});
	});
}
