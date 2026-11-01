/**
 * `defuss-rpc-vite/rpc-state`: process-wide state shared by the Vite plugin, the Astro integration
 * (defuss-rpc-astro) and its middleware.
 *
 * Why module state: Astro loads the integration, the Vite plugin and the middleware as separate modules, and they
 * agree on one server only through a module all of them import. Server code may read the endpoint here
 * (`getRpcEndpoint()`), e.g. to call its own API from Node.js or Bun.
 */
import { DEFAULT_PORT, type ExpressRpcServer, type ExpressRpcServerOptions, type RpcServerProvider } from "defuss-rpc/express-server";
import type { ApiNamespace } from "defuss-rpc/server";

/** Options of the Vite plugin and the Astro integration. */
export interface RpcPluginOptions {
	/** Map of namespace name => class constructor or plain-object module to expose over RPC. */
	api: ApiNamespace;
	/**
	 * HTTP framework of the RPC server. Default on Bun: `Bun.serve` without a framework; on Node.js select one:
	 * `expressProvider()` (`defuss-rpc/providers/express`). See `ExpressRpcServerOptions.provider`.
	 */
	provider?: RpcServerProvider<unknown>;
	/**
	 * Port of the RPC server. `0` lets the OS pick a free port, which the virtual module then reports; pick it when
	 * two dev servers run at once.
	 * @default 63920 (`DEFAULT_PORT`)
	 */
	port?: number;
	/**
	 * Protocol written into the endpoint URL. It does not enable TLS; terminate HTTPS in a reverse proxy.
	 * @default `"http"`
	 */
	protocol?: "http" | "https";
	/**
	 * Host/IP the RPC server binds to: `"localhost"` (default) for this machine only, `"0.0.0.0"` for every interface
	 * (Docker, LAN).
	 */
	host?: string;
	/**
	 * URL path prefix of every route (`/rpc`, `/rpc/schema`, `/health`, …).
	 * @example `"/api/v1"` => endpoints become `/api/v1/rpc`, `/api/v1/health`, etc.
	 * @default `""`
	 */
	basePath?: string;
	/**
	 * Maximum size of an RPC call body (bytes or `"512kb"`, `"1mb"`, `"10mb"`); larger calls get HTTP 413.
	 * The limit keeps a single call from exhausting memory; send files with `upload()`, which streams to disk and
	 * has no size limit.
	 * @default `"1mb"`
	 */
	jsonSizeLimit?: string | number;
	/**
	 * Allowed origin(s) for CORS: one origin, `"*"` (default), or a list, in which case the server answers with the
	 * request's `Origin` when it is on the list.
	 */
	corsOrigin?: string | string[];
	/**
	 * Transport compression of the RPC server, see `ExpressRpcServerOptions.compression`.
	 * @default true
	 */
	compression?: ExpressRpcServerOptions["compression"];
	/**
	 * Glob patterns of API files; a change to a matching file reloads the page so the client fetches the schema
	 * again.
	 * @default `["src/**\/*.ts"]`
	 */
	watch?: string | string[];
	/**
	 * Endpoint URL the **client** uses, written into `virtual:defuss-rpc`. Set it when the browser reaches the
	 * server under another address than the one it binds to (a proxy, a production domain).
	 * When omitted: the running dev server's URL in `vite dev`, `VITE_DEFUSS_RPC_URL` or `""` in `vite build`.
	 * @example `"https://api.example.com"`
	 */
	endpoint?: string;

	/** @deprecated Use `endpoint` instead. */
	productionUrl?: string;
}

/**
 * Builds an endpoint URL from its parts; `endpoint` (then `productionUrl`) wins when set. The port is omitted when
 * it is the protocol's default (80 for http, 443 for https).
 *
 * @param resolvedPort - The port a started server actually bound, which replaces `options.port` (`0` = any).
 */
export function buildEndpoint(
	options: Pick<RpcPluginOptions, "endpoint" | "productionUrl" | "protocol" | "host" | "port" | "basePath">,
	resolvedPort?: number,
): string {
	if (options.endpoint) return options.endpoint;
	if (options.productionUrl) return options.productionUrl;

	const protocol = options.protocol ?? "http";
	const host = options.host ?? "localhost";
	const port = resolvedPort ?? options.port ?? DEFAULT_PORT;
	const basePath = options.basePath ?? "";
	const isDefaultPort = (protocol === "http" && port === 80) || (protocol === "https" && port === 443);
	return `${protocol}://${host}${isDefaultPort ? "" : `:${port}`}${basePath}`;
}

/**
 * The shared state, kept on `globalThis` under a registry symbol.
 * Why not module variables: one process can hold several copies of this module (Astro bundles packages that peer on
 * astro into its SSR build, and the ESM and CommonJS builds are separate modules), and a value set by the Vite
 * plugin in one copy must be visible to the middleware in another. VERIFIED: with module variables,
 * `Astro.locals.rpcEndpoint` stayed empty in `astro dev` (the repository's scripts/e2e.mjs).
 */
const shared = ((globalThis as Record<symbol, unknown>)[Symbol.for("defuss-rpc.rpc-state")] ??= {
	config: null,
	endpoint: "",
	server: null,
}) as { config: RpcPluginOptions | null; endpoint: string; server: ExpressRpcServer<unknown> | null };

/** This module copy's view of the state, kept for compatibility; read the getters, which see every copy. */
export let rpcConfig: RpcPluginOptions | null = shared.config;
export let rpcEndpoint = shared.endpoint;
export let rpcServer: ExpressRpcServer<unknown> | null = shared.server;

/** Saves the plugin options (the Astro middleware reads them to start a server in production). */
export function setRpcConfig(config: RpcPluginOptions): void {
	shared.config = rpcConfig = config;
}

/** The options saved by the plugin or integration, `null` when neither was created in this process. */
export function getRpcConfig(): RpcPluginOptions | null {
	return shared.config;
}

/** Records the endpoint clients should use. */
export function setRpcEndpoint(url: string): void {
	shared.endpoint = rpcEndpoint = url;
}

/** The endpoint of the running RPC server, `""` before one started. */
export function getRpcEndpoint(): string {
	return shared.endpoint;
}

/** @deprecated Use `getRpcEndpoint()` instead. */
export const getRpcBaseUrl = getRpcEndpoint;
/** @deprecated Use `setRpcEndpoint()` instead. */
export const setRpcBaseUrl = setRpcEndpoint;

/** Records the running server, so it can be found (and stopped) from other modules. */
export function setRpcServer(server: ExpressRpcServer<unknown>): void {
	shared.server = rpcServer = server;
}

/** The running server started by the plugin or the middleware, `null` before one started. */
export function getRpcServer(): ExpressRpcServer<unknown> | null {
	return shared.server;
}
