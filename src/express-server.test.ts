import { deflateSync, gunzipSync, gzipSync } from "node:zlib";
import { Agent, request as httpRequest } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { DSON } from "defuss-dson";
import { createExpressRpcServer, DEFAULT_PORT, ExpressRpcServer, parseByteSize, type BunServeApp, type ExpressRpcServerOptions } from "./express-server.js";
import type { RpcServerProvider } from "./provider.js";
import { expressProvider } from "./providers/express.js";
import { addUploadHandler, clearRpcServer, createRpcServer } from "./server.js";
import { TestMathModule, TestStreamModule, TestUserApi } from "./test/api.js";
import { isolateUploads, PROVIDERS, startServer } from "./test/server.js";

const API = { TestUserApi, TestMathModule, TestStreamModule };
const onBun = Boolean(process.versions.bun);
let stop: (() => Promise<void>) | undefined;

const callBody = (className: string, methodName: string, args: unknown[] = []) =>
	DSON.stringify({ className, methodName, args });

/**
 * Raw HTTP, because fetch() inflates gzip on its own and hides Content-Encoding from a test that checks it.
 */
function raw(
	url: string,
	init: { method?: string; headers?: Record<string, string>; body?: string | Buffer; agent?: Agent; timeout?: number } = {},
) {
	return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }>((resolve, reject) => {
		const req = httpRequest(url, { method: init.method ?? "GET", headers: init.headers, agent: init.agent, timeout: init.timeout }, (res) => {
			const chunks: Buffer[] = [];
			res.on("data", (chunk) => chunks.push(chunk));
			res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }));
		});
		req.on("error", reject);
		req.on("timeout", () => req.destroy(new Error(`no answer within ${init.timeout} ms`)));
		req.end(init.body);
	});
}

const json = (body: string) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body });

describe("ExpressRpcServer options", () => {
	it.skipIf(onBun)("without a provider throws on Node.js and names the Express entry point", () => {
		expect(() => new ExpressRpcServer()).toThrow(/Bun\.serve.*defuss-rpc\/providers\/express/);
	});

	it.runIf(onBun)("without a provider runs on Bun.serve", async () => {
		createRpcServer(API);
		const { server, url } = await createExpressRpcServer({ port: 0, host: "127.0.0.1" });
		try {
			expect(typeof server.getApp().fetch).toBe("function");
			expect(DSON.parse(await (await fetch(`${url}/rpc`, json(callBody("TestMathModule", "add", [2, 3])))).text())).toBe(5);
		} finally {
			await server.stop();
		}
	});

	it("listens on port 63920 unless given another one", () => {
		expect(DEFAULT_PORT).toBe(63920);
		expect(new ExpressRpcServer({ provider: expressProvider() }).getPort()).toBe(63920);
		expect(new ExpressRpcServer({ provider: expressProvider(), port: 0 }).getPort()).toBe(0);
	});

	it("parses jsonSizeLimit like Express and rejects a malformed one at construction", () => {
		expect(parseByteSize("100b")).toBe(100);
		expect(parseByteSize("512kb")).toBe(512 * 1024);
		expect(parseByteSize("1.5MB")).toBe(1.5 * 1024 * 1024);
		expect(parseByteSize("1gb")).toBe(1024 ** 3);
		expect(parseByteSize(2048)).toBe(2048);
		expect(() => new ExpressRpcServer({ provider: expressProvider(), jsonSizeLimit: "1 megabyte" })).toThrow(/jsonSizeLimit/);
	});
});

describe.for(PROVIDERS)("ExpressRpcServer on $name", (provider: RpcServerProvider<unknown>) => {
	async function serve(options: Omit<ExpressRpcServerOptions, "provider"> = {}) {
		const started = await startServer(provider, API, options);
		stop = started.stop;
		return started.url;
	}

	afterEach(async () => {
		await stop?.();
		stop = undefined;
		await clearRpcServer();
	});

	it("binds a free port for port 0 and reports it", async () => {
		createRpcServer(API);
		const { server, port, url } = await createExpressRpcServer({ provider, host: "127.0.0.1", port: 0 });
		stop = () => server.stop();
		expect(port).toBeGreaterThan(0);
		expect(url).toBe(`http://127.0.0.1:${port}`);
		expect(server.getPort()).toBe(port);
		expect(server.getUrl()).toBe(url);
		expect((await fetch(`${url}/health`)).status).toBe(200);
	});

	it("rejects start() when the port is taken", async () => {
		const url = await serve({ host: "127.0.0.1" });
		const second = new ExpressRpcServer({ provider, host: "127.0.0.1", port: Number(new URL(url).port) });
		// The code, not the message: Bun words it "Failed to start server. Is port … in use?".
		await expect(second.start()).rejects.toMatchObject({ code: "EADDRINUSE" });
	});

	it("answers /health, calls, the schema and errors", async () => {
		const url = await serve();
		expect(await (await fetch(`${url}/health`, { method: "POST" })).json()).toMatchObject({ status: "ok" });
		const sum = await fetch(`${url}/rpc`, { method: "POST", headers: { "Content-Type": "application/json" }, body: callBody("TestMathModule", "add", [2, 3]) });
		expect(DSON.parse(await sum.text())).toBe(5);
		expect(await (await fetch(`${url}/rpc/schema`, { method: "POST" })).json()).toHaveLength(3);
		const missing = await fetch(`${url}/rpc`, { method: "POST", headers: { "Content-Type": "application/json" }, body: callBody("Nope", "x") });
		expect(missing.status).toBe(404);
		const malformed = await fetch(`${url}/rpc`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" });
		expect(malformed.status).toBe(400);
	});

	it("mounts every route under basePath", async () => {
		const url = await serve({ basePath: "/api/v1" });
		expect(url).toMatch(/\/api\/v1$/);
		expect((await fetch(`${url}/health`)).status).toBe(200);
		const response = await fetch(`${url}/rpc`, { method: "POST", headers: { "Content-Type": "application/json" }, body: callBody("TestUserApi", "getUserCount") });
		expect(DSON.parse(await response.text())).toBe(42);
	});

	it("rejects call bodies above jsonSizeLimit with 413, counting decompressed bytes", async () => {
		const url = await serve({ jsonSizeLimit: "1kb" });
		const big = callBody("TestMathModule", "add", ["x".repeat(4096), 1]);
		expect((await fetch(`${url}/rpc`, json(big))).status).toBe(413);
		// 4 KiB that gzip to a few dozen bytes: the limit applies to what the server would have to hold.
		const bomb = await raw(`${url}/rpc`, { method: "POST", headers: { "Content-Type": "application/json", "Content-Encoding": "gzip" }, body: gzipSync(big) });
		expect(bomb.status).toBe(413);
		expect((await fetch(`${url}/rpc`, json(callBody("TestMathModule", "add", [1, 1])))).status).toBe(200);
	});

	it("runs calls only with Content-Type: application/json, which cross-origin pages cannot send without a preflight", async () => {
		const url = await serve();
		const plain = await fetch(`${url}/rpc`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: callBody("TestMathModule", "add", [1, 1]) });
		expect(plain.status).toBe(400);
		const charset = await fetch(`${url}/rpc`, { method: "POST", headers: { "Content-Type": "application/json; charset=utf-8" }, body: callBody("TestMathModule", "add", [1, 1]) });
		expect(DSON.parse(await charset.text())).toBe(2);
	});

	it("answers 415 for an unknown Content-Encoding and 400 for a corrupt gzip body", async () => {
		const url = await serve();
		const headers = (encoding: string) => ({ "Content-Type": "application/json", "Content-Encoding": encoding });
		expect((await raw(`${url}/rpc`, { method: "POST", headers: headers("br"), body: "x" })).status).toBe(415);
		expect((await raw(`${url}/rpc`, { method: "POST", headers: headers("gzip"), body: "not gzip" })).status).toBe(400);
	});

	it("answers and keeps serving after bodies it rejects unread or reads only in part", async () => {
		// VERIFIED regression: an unread 300 KB upload body (404) left Express waiting, and the client never got its
		// answer.
		const url = await serve({ jsonSizeLimit: "1kb" });
		const add = () => fetch(`${url}/rpc`, json(callBody("TestMathModule", "add", [1, 2])));
		const rejected = [
			() => fetch(`${url}/rpc/upload`, { method: "POST", headers: { "X-Upload-Handler": "nope" }, body: new Uint8Array(300_000) }),
			() => fetch(`${url}/rpc`, json("x".repeat(2_000_000))),
			() => fetch(`${url}/rpc`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "y".repeat(300_000) }),
		];
		for (const [send, status] of [[rejected[0], 404], [rejected[1], 413], [rejected[2], 400]] as const) {
			const response = await send();
			await response.arrayBuffer();
			expect(response.status).toBe(status);
			expect(DSON.parse(await (await add()).text())).toBe(3);
		}
	}, 20_000);

	it("serves sequential 1 MiB uploads on one keep-alive connection", async () => {
		// VERIFIED: a removed provider (defuss-express 0.3.5) stalled about a third of such uploads; any provider must not.
		await isolateUploads();
		const url = await serve({ host: "127.0.0.1" });
		addUploadHandler("size", (data) => data.byteLength);
		const agent = new Agent({ keepAlive: true, maxSockets: 1 });
		try {
			for (let i = 0; i < 12; i++) {
				const response = await raw(`${url}/rpc/upload`, {
					method: "POST",
					headers: { "Content-Type": "application/octet-stream", "X-Upload-Handler": "size", "X-Original-Size": String(2 ** 20) },
					body: Buffer.alloc(2 ** 20, i),
					agent,
					timeout: 3000,
				});
				expect(response.status).toBe(201);
			}
		} finally {
			agent.destroy();
		}
	}, 30_000);

	it("passes other paths on to the framework", async () => {
		const url = await serve();
		expect((await fetch(`${url}/rpc/unknown`)).status).toBe(404);
		expect((await fetch(`${url}/elsewhere`)).status).toBe(404);
	});

	it("stop() closes connections that still stream", async () => {
		const url = await serve({ host: "127.0.0.1" });
		const response = await fetch(`${url}/rpc`, json(callBody("TestStreamModule", "endless")));
		const reader = response.body!.getReader();
		await reader.read();
		await stop?.();
		stop = undefined;
		await expect(reader.read().then(async function drain(r): Promise<unknown> {
			return r.done ? r : drain(await reader.read());
		})).rejects.toThrow();
	});

	describe("CORS", () => {
		it("allows any origin by default and exposes the upload and download headers", async () => {
			const url = await serve();
			const response = await fetch(`${url}/health`, { headers: { Origin: "https://a.example" } });
			expect(response.headers.get("access-control-allow-origin")).toBe("*");
			expect(response.headers.get("access-control-expose-headers")).toContain("Content-Disposition");
			expect(response.headers.get("access-control-expose-headers")).toContain("X-Upload-Offset");
		});

		it("echoes an origin from the allow list and omits the header for others", async () => {
			const url = await serve({ corsOrigin: ["https://a.example", "https://b.example"] });
			const allowed = await fetch(`${url}/health`, { headers: { Origin: "https://b.example" } });
			expect(allowed.headers.get("access-control-allow-origin")).toBe("https://b.example");
			expect(allowed.headers.get("vary")).toContain("Origin");
			const denied = await fetch(`${url}/health`, { headers: { Origin: "https://evil.example" } });
			expect(denied.headers.get("access-control-allow-origin")).toBeNull();
		});

		it("answers preflights and echoes the requested headers", async () => {
			const url = await serve({ corsOrigin: "https://app.example" });
			const response = await fetch(`${url}/rpc`, {
				method: "OPTIONS",
				headers: { Origin: "https://app.example", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type, x-api-key" },
			});
			expect(response.status).toBe(200);
			expect(response.headers.get("access-control-allow-origin")).toBe("https://app.example");
			expect(response.headers.get("access-control-allow-headers")).toBe("content-type, x-api-key");
		});
	});

	describe("compression", () => {
		it("gzips NDJSON streams frame by frame when the client accepts gzip", async () => {
			const url = await serve();
			const response = await raw(`${url}/rpc`, {
				method: "POST",
				headers: { "Content-Type": "application/json", "Accept-Encoding": "gzip" },
				body: callBody("TestStreamModule", "countUp", [3]),
			});
			expect(response.headers["content-encoding"]).toBe("gzip");
			const lines = gunzipSync(response.body).toString().split("\n").filter(Boolean).map((l) => DSON.parse(l));
			expect(lines.at(-1)).toEqual({ type: "return", value: 3 });
		});

		it("sends identity NDJSON without Accept-Encoding: gzip or with compression disabled", async () => {
			for (const [options, accept] of [[{}, "identity"], [{ compression: false }, "gzip"]] as const) {
				const url = await serve(options);
				const response = await raw(`${url}/rpc`, {
					method: "POST",
					headers: { "Content-Type": "application/json", "Accept-Encoding": accept },
					body: callBody("TestStreamModule", "countUp", [2]),
				});
				expect(response.headers["content-encoding"]).toBeUndefined();
				expect(response.body.toString().split("\n").filter(Boolean)).toHaveLength(3);
				await stop?.();
			}
			stop = undefined;
		});

		it("gzips buffered responses above 1 KiB only", async () => {
			const url = await serve();
			const big = await raw(`${url}/rpc`, {
				method: "POST",
				headers: { "Content-Type": "application/json", "Accept-Encoding": "gzip" },
				body: callBody("TestMathModule", "add", ["x".repeat(2000), 1]),
			});
			expect(big.headers["content-encoding"]).toBe("gzip");
			expect(DSON.parse(gunzipSync(big.body).toString())).toBe(`${"x".repeat(2000)}1`);
			const small = await raw(`${url}/rpc`, {
				method: "POST",
				headers: { "Content-Type": "application/json", "Accept-Encoding": "gzip" },
				body: callBody("TestMathModule", "add", [1, 1]),
			});
			expect(small.headers["content-encoding"]).toBeUndefined();
			expect(DSON.parse(small.body.toString())).toBe(2);
		});

		it("accepts gzip- and deflate-compressed call bodies", async () => {
			const url = await serve();
			for (const [encoding, compress] of [["gzip", gzipSync], ["deflate", deflateSync]] as const) {
				const response = await raw(`${url}/rpc`, {
					method: "POST",
					headers: { "Content-Type": "application/json", "Content-Encoding": encoding },
					body: compress(callBody("TestMathModule", "multiply", [6, 7])),
				});
				expect(response.status).toBe(200);
				expect(DSON.parse(response.body.toString())).toBe(42);
			}
		});
	});

	it("forwards upload, HEAD and progress routes to rpcRoute", async () => {
		await isolateUploads();
		const url = await serve();
		addUploadHandler("echo", (data) => data.byteLength);
		const upload = await fetch(`${url}/rpc/upload`, {
			method: "POST",
			headers: { "Content-Type": "application/octet-stream", "X-Upload-Handler": "echo", "X-Upload-Id": "x1", "X-Original-Size": "4" },
			body: new Uint8Array([1, 2, 3, 4]),
		});
		expect(upload.status).toBe(201);
		expect((await upload.text()).split("\n").filter(Boolean).map((l) => DSON.parse(l))[1]).toEqual({ type: "result", value: 4 });
		expect((await fetch(`${url}/rpc/upload/x1`, { method: "HEAD" })).status).toBe(404);
		const progress = await fetch(`${url}/rpc/upload/progress/x2`);
		expect(progress.headers.get("content-type")).toBe("text/event-stream");
		await progress.body?.cancel();
	});

	it("serves routes added with getApp() before start()", async () => {
		createRpcServer(API);
		const server = new ExpressRpcServer({ provider, port: 0 });
		// Express and bunway share app.get(); the default provider takes one fetch handler. A typed provider gives
		// getApp() the framework's type.
		if (provider.name === "bun") {
			(server.getApp() as BunServeApp).fetch = (request) =>
				new URL(request.url).pathname === "/custom" ? Response.json({ custom: true }) : new Response(null, { status: 404 });
		} else {
			const app = server.getApp() as { get(path: string, handler: (req: unknown, res: { json(body: unknown): void }) => void): void };
			app.get("/custom", (_req, res) => res.json({ custom: true }));
		}
		const { url } = await server.start();
		stop = () => server.stop();
		expect(await (await fetch(`${url}/custom`)).json()).toEqual({ custom: true });
	});
});
