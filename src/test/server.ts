/** Node.js test helpers: real servers on ephemeral ports and direct `rpcRoute` calls. */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DSON } from "defuss-dson";
import { ExpressRpcServer, type ExpressRpcServerOptions } from "../express-server.js";
import type { RpcServerProvider } from "../provider.js";
import { expressProvider } from "../providers/express.js";
import { clearRpcServer, createRpcServer, rpcRoute, setUploadDir } from "../server.js";
import type { ApiNamespace } from "../types.d.js";

const onBun = Boolean(process.versions.bun);

/**
 * Every provider this runtime can load, for `describe.for(PROVIDERS)`: Express on Node.js; Express, bunway and the
 * default (`Bun.serve`, name "bun") on Bun. bunway is imported only on Bun, because Node.js cannot load it.
 */
export const PROVIDERS: RpcServerProvider<unknown>[] = [
	expressProvider(),
	...(onBun ? [(await import("../providers/bunway.js")).bunwayProvider(), (await import("../providers/bun.js")).bunServeProvider()] : []),
] as RpcServerProvider<unknown>[];

/** Points uploads at a fresh temp directory, so test files never share temp files. */
export async function isolateUploads(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "defuss-rpc-test-"));
	setUploadDir(dir);
	return dir;
}

/** Registers `api` on an empty server and starts an `ExpressRpcServer` on `provider` and a free port. */
export async function startServer(
	provider: RpcServerProvider<unknown>,
	api: ApiNamespace,
	options: Omit<ExpressRpcServerOptions, "provider"> = {},
) {
	await clearRpcServer();
	createRpcServer(api);
	return serveRegistry(provider, options);
}

/** Starts an `ExpressRpcServer` on `provider` for what is registered now (namespaces, handlers, hooks). */
export async function serveRegistry(provider: RpcServerProvider<unknown>, options: Omit<ExpressRpcServerOptions, "provider"> = {}) {
	const server = new ExpressRpcServer({ port: 0, ...options, provider });
	const { url, port } = await server.start();
	return { server, url, port, stop: () => server.stop() };
}

/** Sends one RPC call straight to `rpcRoute` (no HTTP server). */
export function callRoute(className: string, methodName: string, args: unknown[] = [], path = "/rpc", body?: string) {
	const request = new Request(`http://localhost${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: body ?? DSON.stringify({ className, methodName, args }),
	});
	return rpcRoute({ request });
}

/** Parses an NDJSON body into DSON frames. */
export async function frames(response: Response): Promise<any[]> {
	return (await response.text())
		.split("\n")
		.filter(Boolean)
		.map((line) => DSON.parse(line));
}

/** SHA-256 hex digest with node:crypto, independent of the code under test. */
export async function sha256(data: Uint8Array): Promise<string> {
	const { createHash } = await import("node:crypto");
	return createHash("sha256").update(data).digest("hex");
}
