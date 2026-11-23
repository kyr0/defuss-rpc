/**
 * The deprecated global server keeps code written before 4.0 working after one rename (`createRpcServer(ns)` →
 * `registerGlobalRpcApi(ns)`): the module functions, `rpcRoute` and `ExpressRpcServer` without `rpc` serve it.
 */
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { DSON } from "defuss-dson";
import { download, uploadComplete } from "./client.js";
import { ExpressRpcServer } from "./express-server.js";
import { expressProvider } from "./providers/express.js";
import {
	addDownloadHandler,
	addHook,
	addUploadHandler,
	clearRpcServer,
	createRpcServer,
	getUploadDir,
	registerGlobalRpcApi,
	rpcRoute,
	setUploadDir,
} from "./server.js";
import { TestMathModule } from "./test/api.js";
import { callRoute } from "./test/server.js";

const call = (className: string, methodName: string, args: unknown[]) =>
	rpcRoute({
		request: new Request("http://localhost/rpc", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: DSON.stringify({ className, methodName, args }),
		}),
	});
const value = async (response: Response) => DSON.parse(await response.text());

describe("the deprecated global server", () => {
	afterEach(() => clearRpcServer());

	it("serves what the module functions register through rpcRoute and ExpressRpcServer without rpc", async () => {
		const dir = await mkdtemp(join(tmpdir(), "defuss-rpc-global-"));
		setUploadDir(dir);
		expect(getUploadDir()).toBe(dir);
		registerGlobalRpcApi({ TestMathModule });
		const methods: string[] = [];
		addHook({ phase: "result", fn: (_ns, method) => void methods.push(method) });
		addUploadHandler("size", (data) => data.byteLength);
		addDownloadHandler("bytes", () => new Uint8Array([1, 2, 3]));
		expect(await value(await call("TestMathModule", "add", [1, 2]))).toBe(3);

		const server = new ExpressRpcServer({ provider: expressProvider(), host: "127.0.0.1", port: 0 });
		const { url } = await server.start();
		try {
			const response = await fetch(`${url}/rpc`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: DSON.stringify({ className: "TestMathModule", methodName: "add", args: [2, 3] }),
			});
			expect(await value(response)).toBe(5);
			expect((await uploadComplete("size", new Uint8Array(7), { baseUrl: url })).result).toBe(7);
			expect((await download("bytes", url)).data).toEqual(new Uint8Array([1, 2, 3]));
		} finally {
			await server.stop();
		}
		expect(methods, "result hooks see calls and uploads (by handler name)").toEqual(["add", "add", "size"]);
		expect(await readdir(dir), "the upload went through the directory set with setUploadDir").toEqual([]);
	});

	it("keeps the first registration, says so in a WARN line, and resets with {}", async () => {
		// The log line, read from the stderr of a process of its own: Bun runs the source as it is.
		const script = `import { registerGlobalRpcApi } from "./server.ts";
			registerGlobalRpcApi({ First: { f: () => 1 } });
			registerGlobalRpcApi({ Second: { f: () => 2 } });`;
		const child = spawnSync("bun", ["-e", script], { cwd: fileURLToPath(new URL(".", import.meta.url)), encoding: "utf8" });
		expect(child.status).toBe(0);
		expect(child.stderr.trim().split("\n")).toEqual([
			expect.stringMatching(/^\S+Z WARN defuss-rpc registerGlobalRpcApi ignored: .* namespaces=Second$/),
		]);

		registerGlobalRpcApi({ First: TestMathModule });
		registerGlobalRpcApi({ Second: TestMathModule });
		expect((await call("Second", "add", [1, 2])).status).toBe(404);
		registerGlobalRpcApi({});
		registerGlobalRpcApi({ Second: TestMathModule });
		expect(await value(await call("Second", "add", [1, 2]))).toBe(3);
		expect((await call("First", "add", [1, 2])).status).toBe(404);
	});

	it("is neither read nor written by servers from createRpcServer", async () => {
		registerGlobalRpcApi({ Global: TestMathModule });
		addHook({ phase: "guard", fn: () => false });
		const rpc = createRpcServer({ Local: TestMathModule });
		try {
			expect(await value(await callRoute(rpc, "Local", "add", [1, 2])), "the global guard does not apply").toBe(3);
			expect((await callRoute(rpc, "Global", "add", [1, 2])).status).toBe(404);
			expect((await call("Global", "add", [1, 2])).status, "the global guard applies to the global server").toBe(403);
		} finally {
			await rpc.close();
		}
		expect((await call("Global", "add", [1, 2])).status, "closing a server leaves the global one as it was").toBe(403);
	});
});
