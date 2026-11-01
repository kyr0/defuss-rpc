/**
 * Benchmark server: one server per process, started by `scripts/bench.mjs` as
 * `PROVIDER=<name> node|bun scripts/bench-server.ts`. It imports the built package (`make build`), like a user.
 *
 * PROVIDER is a provider name (`express`, `bunway`), `default` (ExpressRpcServer without a provider: Bun.serve) or
 * `bun.serve`: `rpcRoute` in a bare `Bun.serve`, the baseline that shows what the server's HTTP layer costs.
 * The API is minimal on purpose: the numbers measure transport, not application code.
 * VERIFIED: it starts with every PROVIDER listed below on the runtimes scripts/bench.mjs uses (`make bench`).
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addDownloadHandler, addStreamingUploadHandler, createRpcServer, rpcRoute, setUploadDir } from "defuss-rpc/server";
import { ExpressRpcServer, type RpcServerProvider } from "defuss-rpc/express-server";

/** Each provider is imported only when selected: bunway does not load on Node.js. */
const PROVIDERS: Record<string, () => Promise<RpcServerProvider<unknown>>> = {
	express: async () => (await import("defuss-rpc/providers/express")).expressProvider() as RpcServerProvider<unknown>,
	bunway: async () => (await import("defuss-rpc/providers/bunway")).bunwayProvider() as RpcServerProvider<unknown>,
};

export const BenchApi = {
	async add(a: number, b: number) {
		return a + b;
	},
	async *frames(count: number) {
		for (let i = 0; i < count; i++) yield i;
		return count;
	},
};

/** The download: 8 MiB from memory, so the disk does not limit it. */
const FILE = new Uint8Array(8 * 1024 * 1024).fill(7);

createRpcServer({ BenchApi });
setUploadDir(await mkdtemp(join(tmpdir(), "defuss-rpc-bench-")));
addStreamingUploadHandler("count", async (stream) => {
	let bytes = 0;
	for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) bytes += chunk.byteLength;
	return bytes;
});
addDownloadHandler("file", () => FILE);

const name = process.env.PROVIDER ?? "";
let stop: () => Promise<unknown>;
if (name === "bun.serve") {
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => rpcRoute({ request }) });
	console.info(`${new Date().toISOString()} INFO defuss-rpc rpc server listening url=${server.url.origin} provider=bun.serve`);
	stop = () => server.stop(true);
} else {
	const provider = name === "default" ? undefined : PROVIDERS[name];
	if (!provider && name !== "default") throw new Error(`PROVIDER=${JSON.stringify(name)}: use one of ${[...Object.keys(PROVIDERS), "default", "bun.serve"].join(", ")}`);
	const server = new ExpressRpcServer({ provider: await provider?.(), host: "127.0.0.1", port: 0, compression: false });
	await server.start();
	stop = () => server.stop();
}
process.once("SIGTERM", () => void stop().then(() => process.exit(0)));
