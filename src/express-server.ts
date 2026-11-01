/**
 * `ExpressRpcServer`: a standalone HTTP server for `rpcRoute`, on `Bun.serve` by default or on a framework that the
 * caller selects with a provider (`defuss-rpc/providers/*`).
 *
 * Why an adapter around the Fetch handler instead of framework-native routes: the RPC logic stays in one
 * runtime-neutral function, and the server adds what a standalone deployment needs: CORS, a health route, a body
 * size limit, gzip and disconnect handling (`http-core.ts`, in Fetch API terms). Why it imports no framework: the
 * provider brings it, so an application installs and loads only the framework it chose, and bunway, which Node.js
 * cannot import, stays out of Node.js processes. The contract is in `provider.ts`; `node-bridge.ts` connects
 * `node:http` frameworks. VERIFIED: the server suites pass on the default and on both providers (`make test`), and
 * on Node.js the constructor throws without a provider.
 */
import { log } from "./log.js";
import { createRpcHttpCore, parseByteSize } from "./http-core.js";
import type { RpcListener, RpcServerProvider } from "./provider.js";
import { bunServeProvider, type BunServeApp } from "./providers/bun.js";

export type {
	RpcHttpCore,
	RpcHttpRequest,
	RpcHttpResponse,
	RpcListener,
	RpcMiddleware,
	RpcServerProvider,
} from "./provider.js";
export { nodeMiddleware } from "./node-bridge.js";
export { parseByteSize } from "./http-core.js";
export type { BunServeApp } from "./providers/bun.js";

/**
 * The port of every defuss-rpc server that is not given one: the server, the Vite plugin, the Astro integration and
 * the demo servers. Why one fixed port instead of `0` (any free port): a client in another process finds the server
 * without being told its port. 63920 is in the dynamic range (49152 to 65535), which IANA never assigns to a service.
 */
export const DEFAULT_PORT = 63920;

export interface ExpressRpcServerOptions<App = BunServeApp> {
	/**
	 * The HTTP framework. Default on Bun: `Bun.serve` without a framework, the fastest option (README.md, section
	 * Benchmark); `getApp().fetch` answers requests outside the RPC routes. Elsewhere, import one:
	 * - `expressProvider()` (`defuss-rpc/providers/express`): Express 5, Node.js and Bun
	 * - `bunwayProvider()` (`defuss-rpc/providers/bunway`): bunway, Bun only
	 *
	 * Why there is no default on Node.js: it would have to import a framework the application did not choose; the
	 * constructor throws instead and names `expressProvider()`.
	 */
	provider?: RpcServerProvider<App>;
	/** Port to listen on. `0` lets the OS pick a free one, which `start()` returns. @default {@link DEFAULT_PORT} (63920) */
	port?: number;
	/**
	 * Protocol of the URL returned by `start()` and `getUrl()`. It does not enable TLS; terminate HTTPS in a
	 * reverse proxy.
	 * @default `"http"`
	 */
	protocol?: "http" | "https";
	/**
	 * Host/IP to bind: `"localhost"` (default) for this machine only, `"0.0.0.0"` for every interface (Docker, LAN),
	 * or any IPv4/IPv6 address.
	 */
	host?: string;
	/** Path prefix of every route, e.g. `"/api"` → `/api/rpc`, `/api/health`. */
	basePath?: string;
	/**
	 * Maximum RPC call body after decompression, as bytes or a size string (`"512kb"`, `"1mb"`, 1024-based like
	 * Express); larger calls get HTTP 413. Uploads are streamed to disk and not limited.
	 * @default `"1mb"`
	 */
	jsonSizeLimit?: string | number;
	/**
	 * Allowed CORS origin(s):
	 * - `"*"` (default): any origin, suitable for development and public APIs without cookies.
	 * - One origin: `"https://app.example.com"`.
	 * - A list: the request's `Origin` is echoed when it is on the list (with `Vary: Origin`), else the header is
	 *   omitted and the browser blocks the response. Why echo: `Access-Control-Allow-Origin` accepts one origin or
	 *   `*`, never a list.
	 */
	corsOrigin?: string | string[];
	/**
	 * Transport-level gzip for responses, when the client sends `Accept-Encoding: gzip`:
	 * - `true` (default): level 1 (`Z_BEST_SPEED`), because RPC answers are latency-bound, not size-bound.
	 * - `false`: never compress.
	 * - `{ level: 1-9 }`: a custom zlib level.
	 *
	 * Streaming (NDJSON) responses are flushed with `Z_SYNC_FLUSH` after every frame, so each frame reaches the client
	 * at once; buffered responses are compressed only above 1 KiB, where gzip saves more than its header costs.
	 * Server-Sent Events are never compressed. Compressed request bodies (`Content-Encoding: gzip | deflate`) are
	 * always accepted.
	 */
	compression?: boolean | { level?: number };
}

const MISSING_PROVIDER =
	"ExpressRpcServer without a provider runs on Bun.serve, which this runtime does not have. On Node.js select one: " +
	'`import { expressProvider } from "defuss-rpc/providers/express"` and ' +
	"`new ExpressRpcServer({ provider: expressProvider() })`; see README.md, section Serve it.";

/** True on Bun, where the default provider runs. */
const onBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

/**
 * HTTP server for `rpcRoute` on the framework of its provider.
 *
 * Routes (under `basePath`): `GET|POST /health`, `ANY /rpc`, `ANY /rpc/schema`, `POST /rpc/upload`,
 * `HEAD /rpc/upload/:uploadId`, `GET /rpc/upload/progress/:uploadId` and `GET /rpc/download`. CORS headers are added
 * to every response and preflights are answered for every path. Add your own routes with {@link getApp} before
 * calling {@link start}.
 *
 * @typeParam App - The provider's application type (`BunServeApp` by default, `Express`, bunway's app), returned
 * by `getApp()`.
 */
export class ExpressRpcServer<App = BunServeApp> {
	private readonly provider: RpcServerProvider<App>;
	private readonly app: App;
	private listener: RpcListener | null = null;
	private port: number;
	private readonly protocol: "http" | "https";
	private readonly host: string;
	private readonly basePath: string;

	/** @throws when `provider` is missing outside Bun, or `jsonSizeLimit` is not a size. */
	constructor(options: ExpressRpcServerOptions<App> = {}) {
		if (!options.provider && !onBun) throw new TypeError(MISSING_PROVIDER);
		this.provider = options.provider ?? (bunServeProvider() as unknown as RpcServerProvider<App>);
		this.port = options.port ?? DEFAULT_PORT;
		this.protocol = options.protocol || "http";
		this.host = options.host || "localhost";
		this.basePath = (options.basePath || "").replace(/\/+$/, "");
		const comp = options.compression ?? true;
		const core = createRpcHttpCore({
			basePath: this.basePath,
			jsonSizeLimit: parseByteSize(options.jsonSizeLimit ?? "1mb"),
			corsOrigin: options.corsOrigin ?? "*",
			compression: comp === false ? { enabled: false, level: 0 } : { enabled: true, level: comp === true ? 1 : (comp.level ?? 1) },
		});
		this.app = this.provider.createApp();
		this.provider.use(this.app, core);
	}

	/**
	 * Starts listening.
	 *
	 * @returns `{ port, url }` with the port actually bound (the OS picks one for port `0`).
	 * @throws (rejects) with `code: "EADDRINUSE"` when the port is in use, on every provider and runtime.
	 */
	async start(): Promise<{ port: number; url: string }> {
		this.listener = await this.provider.listen(this.app, this.port, this.host);
		this.port = this.listener.port;
		const url = this.getUrl();
		log("INFO", "rpc server listening", { url, provider: this.provider.name });
		return { port: this.port, url };
	}

	/** Stops listening and closes open connections, including running streams. */
	async stop(): Promise<void> {
		if (!this.listener) return;
		const listener = this.listener;
		this.listener = null;
		await listener.close();
		log("INFO", "rpc server stopped", { url: this.getUrl() });
	}

	/** The provider's app (`BunServeApp`, Express, bunway), for custom routes or middleware; add them before `start()`. */
	getApp(): App {
		return this.app;
	}

	/** The bound port after `start()`, else the configured one (0 for "any"). */
	getPort(): number {
		return this.port;
	}

	/** The server's base URL, e.g. `"http://localhost:63920"`; clients pass it as `baseUrl`. */
	getUrl(): string {
		return `${this.protocol}://${this.host}:${this.port}${this.basePath}`;
	}
}

/**
 * Creates and starts an {@link ExpressRpcServer}; register your API with `createRpcServer()` first.
 *
 * @example
 * ```ts
 * import { createRpcServer } from "defuss-rpc/server";
 * import { createExpressRpcServer } from "defuss-rpc/express-server";
 *
 * createRpcServer({ UserApi });
 * const { server, url } = await createExpressRpcServer(); // Bun.serve on port 63920
 * ```
 *
 * @returns `{ server, port, url }`
 */
export async function createExpressRpcServer<App = BunServeApp>(options: ExpressRpcServerOptions<App> = {}) {
	const server = new ExpressRpcServer(options);
	const info = await server.start();
	return { server, ...info };
}
