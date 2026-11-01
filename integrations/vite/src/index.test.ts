import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import { getRpcClient, uploadComplete } from "defuss-rpc/client";
import type { RpcServerProvider } from "defuss-rpc/express-server";
import { expressProvider } from "defuss-rpc/providers/express";
import { addUploadHandler, clearRpcServer, setUploadDir } from "defuss-rpc/server";
import { defussRpc } from "./index.js";
import { buildEndpoint, getRpcEndpoint, getRpcServer, setRpcEndpoint } from "./rpc-state.js";

const TestMathModule = {
	async add(a: number, b: number) {
		return a + b;
	},
};

/** Express on both runtimes; on Bun also no provider, the default (Bun.serve). */
const PROVIDERS: { name: string; provider?: RpcServerProvider<unknown> }[] = [
	{ name: "Express", provider: expressProvider() as RpcServerProvider<unknown> },
	...(process.versions.bun ? [{ name: "Bun.serve (no provider)", provider: undefined }] : []),
];

/** Points uploads at a fresh temp directory, so test runs never share temp files. */
async function isolateUploads() {
	setUploadDir(await mkdtemp(join(tmpdir(), "defuss-rpc-vite-test-")));
}

let vite: ViteDevServer | undefined;

async function startVite(options: Partial<Parameters<typeof defussRpc>[0]> = {}) {
	const root = await mkdtemp(join(tmpdir(), "defuss-rpc-vite-"));
	await mkdir(join(root, "src/api"), { recursive: true });
	await writeFile(join(root, "src/api/math.ts"), "export const x = 1;\n");
	vite = await createServer({
		root,
		configFile: false,
		logLevel: "silent",
		server: { port: 0, host: "127.0.0.1" },
		plugins: [defussRpc({ api: { TestMathModule }, provider: PROVIDERS[0].provider, host: "127.0.0.1", port: 0, ...options })],
	});
	await vite.listen();
	return root;
}

/** A port that was free a moment ago, for tests that need a fixed one. */
function freePort(): Promise<number> {
	return new Promise((resolve) => {
		const server = createNetServer().listen(0, "127.0.0.1", () => {
			const { port } = server.address() as { port: number };
			server.close(() => resolve(port));
		});
	});
}

async function virtualModuleCode(server: ViteDevServer) {
	const resolved = await server.pluginContainer.resolveId("virtual:defuss-rpc");
	const loaded = await server.pluginContainer.load(resolved!.id);
	return typeof loaded === "string" ? loaded : loaded!.code;
}

/** `TestMathModule.add(20, 22)` through the client against `endpoint`. */
const call = async (endpoint: string) =>
	(await getRpcClient<{ TestMathModule: typeof TestMathModule }>({ baseUrl: endpoint })).TestMathModule.add(20, 22);

describe("defussRpc Vite plugin", () => {
	afterEach(async () => {
		await vite?.close();
		vite = undefined;
		setRpcEndpoint("");
		await clearRpcServer();
	});

	it.for(PROVIDERS)("starts an RPC server on $name with vite dev and exports its URL from virtual:defuss-rpc", async ({ provider }) => {
		await startVite({ provider });
		const endpoint = getRpcEndpoint();
		expect(endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
		expect(await call(endpoint)).toBe(42);
		const code = await virtualModuleCode(vite!);
		expect(code).toContain(`export const rpcEndpoint = ${JSON.stringify(endpoint)};`);
		expect(code).toContain(`import { _setDefaultEndpoint } from "defuss-rpc/client";`);
		expect(code).toContain("_setDefaultEndpoint(rpcEndpoint);");
	});

	it("restarts on a fixed port: the restarted dev server's RPC server takes over the port", async () => {
		// VERIFIED regression: Vite creates the restarted server before it closes the old one, so the new RPC server
		// found its port taken and the restart failed (silently, with logLevel "silent").
		const port = await freePort();
		await startVite({ port });
		const before = getRpcServer();
		expect(getRpcEndpoint()).toBe(`http://127.0.0.1:${port}`);
		await vite!.restart();
		expect(getRpcServer()).not.toBe(before);
		expect(getRpcEndpoint()).toBe(`http://127.0.0.1:${port}`);
		expect(await call(getRpcEndpoint())).toBe(42);
	});

	it("an explicit endpoint replaces the dev server URL in the virtual module", async () => {
		await startVite({ endpoint: "https://api.example.com" });
		expect(await virtualModuleCode(vite!)).toContain('export const rpcEndpoint = "https://api.example.com";');
	});

	it("keeps upload handlers when an API file changes, and stops the RPC server with Vite", async () => {
		await isolateUploads();
		const root = await startVite({ watch: ["src/api/**/*.ts"] });
		addUploadHandler("survives", (data) => data.byteLength);
		const endpoint = getRpcEndpoint();
		const file = join(root, "src/api/math.ts");
		await writeFile(file, "export const x = 2;\n");
		vite!.watcher.emit("change", file);
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect((await uploadComplete("survives", new Uint8Array(5), { baseUrl: endpoint })).result).toBe(5);
		expect(getRpcServer()?.getUrl()).toBe(endpoint);
		await vite!.close();
		vite = undefined;
		await expect(call(endpoint)).rejects.toThrow();
	});

	it("in vite build the virtual module reads endpoint, else VITE_DEFUSS_RPC_URL", async () => {
		for (const [options, expected] of [
			[{}, 'export const rpcEndpoint = import.meta.env.VITE_DEFUSS_RPC_URL || "";'],
			[{ endpoint: "https://rpc.example.com" }, 'export const rpcEndpoint = "https://rpc.example.com";'],
		] as const) {
			const plugin = defussRpc({ api: {}, provider: PROVIDERS[0].provider, ...options });
			const config = (plugin.config as Function)({}, { command: "build", mode: "production" });
			expect(config).toEqual({ optimizeDeps: { exclude: ["defuss-rpc"] } });
			expect((plugin.resolveId as Function)("virtual:defuss-rpc")).toBe("\0virtual:defuss-rpc");
			expect((plugin.resolveId as Function)("other")).toBeNull();
			expect((plugin.load as Function)("\0virtual:defuss-rpc")).toContain(expected);
			expect((plugin.load as Function)("other")).toBeNull();
		}
	});
});

describe("buildEndpoint", () => {
	it("prefers endpoint, then productionUrl, else builds the URL and drops default ports", () => {
		expect(buildEndpoint({ endpoint: "https://a.example", productionUrl: "https://b.example" })).toBe("https://a.example");
		expect(buildEndpoint({ productionUrl: "https://b.example" })).toBe("https://b.example");
		expect(buildEndpoint({}, 3210)).toBe("http://localhost:3210");
		expect(buildEndpoint({})).toBe("http://localhost:63920");
		expect(buildEndpoint({ protocol: "https", host: "api.example", port: 443, basePath: "/v1" })).toBe("https://api.example/v1");
		expect(buildEndpoint({ protocol: "http", port: 80 })).toBe("http://localhost");
	});
});
