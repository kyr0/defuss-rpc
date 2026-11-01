/**
 * The contract between `ExpressRpcServer` and the HTTP framework that runs it: a provider creates the
 * framework's app, connects the server's HTTP layer to it and makes it listen.
 *
 * Why providers instead of one built-in framework: the framework decides where the server runs. Express is plain
 * JavaScript on `node:http` and runs on Node.js and Bun; bunway runs on `Bun.serve` only and answers small calls
 * faster there (README.md, section Benchmark). With the framework behind this interface, the RPC server imports
 * neither, and an application installs only the one it selects. Why the contract is one handler and not a set
 * of routes: route syntax, body parsers and listen signatures differ between frameworks, while every one of them can
 * pass all requests to a single middleware; the server does its own routing, body reading and compression in
 * Fetch API terms ({@link RpcHttpCore}), which `node:http` requests convert to and `Bun.serve` speaks natively.
 * VERIFIED: Node.js cannot import bunway 1.1.0, so its provider has an entry point of its own that only Bun loads.
 *
 * Import a provider from its own entry point:
 * - `expressProvider()` from `defuss-rpc/providers/express`: Node.js and Bun
 * - `bunwayProvider()` from `defuss-rpc/providers/bunway`: Bun only
 *
 * @module
 */
import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * The request as the server reads it: the `node:http` incoming message, which Express extends. `originalUrl` is set
 * by Express-style routers; the server falls back to `url`.
 */
export type RpcHttpRequest = IncomingMessage & { originalUrl?: string };

/** The response as the server writes it: the `node:http` response API. */
export type RpcHttpResponse = ServerResponse;

/** A Node.js-style middleware: handles the request or calls `next()` to pass it on to the framework. */
export type RpcMiddleware = (req: RpcHttpRequest, res: RpcHttpResponse, next: (error?: unknown) => void) => void;

/**
 * What `ExpressRpcServer` hands to {@link RpcServerProvider.use}: its HTTP layer in Fetch API terms.
 *
 * A `node:http` framework mounts `nodeMiddleware(rpc)` from `defuss-rpc/express-server`; a Fetch framework calls
 * `match()` and `handle()` with its `Request` and adds `corsHeaders()` to the responses of its own routes.
 */
export interface RpcHttpCore {
	/** True for the requests the server answers: preflights, `/health` and the RPC routes under `basePath`. */
	match(method: string, pathname: string): boolean;
	/** Answers a request that `match()` accepted, CORS headers included. Never rejects; errors become 4xx/5xx. */
	handle(request: Request): Promise<Response>;
	/** The CORS headers for a response to a request with this `Origin` and `Access-Control-Request-Headers`. */
	corsHeaders(origin: string | null | undefined, requestedHeaders?: string | null): [string, string][];
	/** True when the response is produced over time (NDJSON, Server-Sent Events) and must not time out while idle. */
	isStream(response: Response): boolean;
}

/** A listening server, as returned by {@link RpcServerProvider.listen}. */
export interface RpcListener {
	/** The port actually bound; the OS picks one when `0` was requested. */
	port: number;
	/** Stops accepting connections and closes open ones, including streams that are still running. */
	close(): Promise<void>;
}

/**
 * An HTTP framework for `ExpressRpcServer`.
 *
 * @typeParam App - The framework's application type, which `ExpressRpcServer.getApp()` returns for custom routes.
 */
export interface RpcServerProvider<App = unknown> {
	/** Name of the framework, written to the server's log lines. */
	readonly name: string;
	/** Creates a new application. Called once per `ExpressRpcServer`. */
	createApp(): App;
	/** Connects `rpc` to the app for every method and path, before any route added later through `getApp()`. */
	use(app: App, rpc: RpcHttpCore): void;
	/**
	 * Starts listening on `host:port` (`0` = any free port).
	 * @throws (rejects) with `code: "EADDRINUSE"` when the port is taken.
	 */
	listen(app: App, port: number, host: string): Promise<RpcListener>;
}
