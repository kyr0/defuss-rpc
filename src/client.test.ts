import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
	_setDefaultEndpoint,
	addHook,
	clearHooks,
	clearSchemaCache,
	createRpcClient,
	getRpcClient,
	getSchema,
	setHeaders,
	upload,
	uploadComplete,
	type UploadEvent,
} from "./client.js";
import { createRpcServer } from "./server.js";
import { TestMathModule, TestStreamModule, TestTypesModule, TestUserApi, testBytes } from "./test/api.js";
import { PROVIDERS, sha256, startServer } from "./test/server.js";
import type { RpcServerProvider } from "./provider.js";

const API = { TestUserApi, TestMathModule, TestTypesModule, TestStreamModule };
type Api = typeof API;

let server: Awaited<ReturnType<typeof startServer>>;
let url: string;
const serverSaw: { authorization?: string | null } = {};

describe.for(PROVIDERS)("RPC client against ExpressRpcServer on $name", (provider: RpcServerProvider<unknown>) => {
	beforeAll(async () => {
		server = await startServer(provider, API);
		url = server.url;
	});
	afterAll(() => server.stop());
	beforeEach(() => {
		clearSchemaCache();
		clearHooks();
		_setDefaultEndpoint("");
	});

	it("getSchema() describes the API; the default endpoint applies when no baseUrl is passed", async () => {
		_setDefaultEndpoint(url);
		const schema = await getSchema();
		expect(schema.map((entry) => entry.kind)).toEqual(["class", "module", "module", "module"]);
		await expect(getSchema(`${url}/missing`)).rejects.toThrow(/Failed to fetch schema: 404/);
	});

	it("calls class methods and module functions with types from typeof API", async () => {
		const rpc = await getRpcClient<Api>({ baseUrl: url });
		const user = await new rpc.TestUserApi().getUser("3");
		expect(user.name).toBe("User 3");
		expect(await new rpc.TestUserApi().getUserCount()).toBe(42);
		expect(await rpc.TestMathModule.add(2, 3)).toBe(5);
		expect(await rpc.TestMathModule.pi()).toBe(Math.PI);
		expect(createRpcClient).toBe(getRpcClient);
	});

	it("restores DSON types", async () => {
		const rpc = await getRpcClient<Api>({ baseUrl: url });
		expect(await rpc.TestTypesModule.bytes(4)).toEqual(new Uint8Array([0, 1, 2, 3]));
		expect(await rpc.TestTypesModule.map()).toEqual(new Map([["a", 1], ["b", 2]]));
		expect(await rpc.TestTypesModule.date()).toEqual(new Date("2026-11-01T12:00:00.000Z"));
		expect(await rpc.TestTypesModule.big()).toBe(2n ** 64n);
		// defuss-dson 1.2.0 keeps what JSON turns into null: undefined, NaN, ±Infinity and -0, as results and arguments.
		expect(await rpc.TestTypesModule.nothing()).toBeUndefined();
		const special = { gone: undefined, numbers: [NaN, Infinity, -Infinity, -0] };
		expect(await rpc.TestTypesModule.echo(special)).toStrictEqual(special);
	});

	it("throws with status and body for failed calls", async () => {
		const rpc = await getRpcClient<Api>({ baseUrl: url });
		await expect(rpc.TestMathModule.divide(1, 0)).rejects.toMatchObject({
			status: 500,
			namespace: "TestMathModule",
			method: "divide",
			body: JSON.stringify({ error: "Error calling function divide: Division by zero" }),
		});
		// Unknown names still reach the server, whose 404 explains the typo.
		await expect((rpc.TestMathModule as any).ad(1, 2)).rejects.toMatchObject({ status: 404 });
	});

	it("namespaces are not thenables, so they survive await and async returns", async () => {
		const rpc = await getRpcClient<Api>({ baseUrl: url });
		const module = await Promise.resolve(rpc.TestMathModule);
		expect(await module.add(1, 1)).toBe(2);
		const instance = await (async () => new rpc.TestUserApi())();
		expect(await instance.getUserCount()).toBe(42);
	});

	it("caches the schema per endpoint", async () => {
		const first = await getRpcClient<Api>({ baseUrl: url });
		expect(Object.keys(first)).toContain("TestUserApi");
		// A second server in this process with another API: its client must see that API, not the cached one.
		const other = await startServer(provider, createRpcServer({ OtherApi: TestMathModule }));
		try {
			expect(Object.keys(await getRpcClient({ baseUrl: other.url }))).toEqual(["OtherApi"]);
			expect(Object.keys(await getRpcClient({ baseUrl: url }))).toContain("TestUserApi");
		} finally {
			await other.stop();
			await other.rpc.close();
		}
	});

	describe("generators", () => {
		it("yields each frame and returns the server's return value", async () => {
			const rpc = await getRpcClient<Api>({ baseUrl: url });
			const values: number[] = [];
			for await (const value of rpc.TestStreamModule.countUp(4)) values.push(value);
			expect(values).toEqual([0, 1, 2, 3]);
			const iterator = rpc.TestStreamModule.syncCount(1);
			expect(await iterator.next()).toEqual({ done: false, value: 0 });
			expect(await iterator.next()).toEqual({ done: true, value: "done" });
		});

		it("throws the server generator's error after the frames before it", async () => {
			const rpc = await getRpcClient<Api>({ baseUrl: url });
			const seen: string[] = [];
			await expect(async () => {
				for await (const value of rpc.TestStreamModule.throwMidStream()) seen.push(value);
			}).rejects.toThrow("mid-stream error");
			expect(seen).toEqual(["a", "b"]);
		});

		it("break stops the server generator", async () => {
			const rpc = await getRpcClient<Api>({ baseUrl: url });
			for await (const value of rpc.TestStreamModule.endless()) {
				if (value >= 2) break;
			}
			await expect.poll(() => rpc.TestStreamModule.wasFinalized(), { timeout: 5000 }).toBe(true);
		});
	});

	describe("hooks and headers", () => {
		it("runs guard, response and result hooks in order and sends setHeaders()", async () => {
			const order: string[] = [];
			server.rpc.addHook({ phase: "guard", fn: (_ns, _m, _a, request) => void (serverSaw.authorization = request.headers.get("authorization")) });
			setHeaders({ Authorization: "Bearer t0k3n" });
			addHook({ phase: "guard", fn: (ns, method, args) => (order.push(`guard ${ns}.${method}(${args})`), true) });
			addHook({ phase: "response", fn: (_ns, _m, _a, _r, response) => void order.push(`response ${response?.status}`) });
			addHook({ phase: "result", fn: (_ns, _m, _a, _r, _response, data) => void order.push(`result ${data}`) });
			const rpc = await getRpcClient<Api>({ baseUrl: url });
			expect(await rpc.TestMathModule.multiply(3, 4)).toBe(12);
			expect(order).toEqual(["guard TestMathModule.multiply(3,4)", "response 200", "result 12"]);
			expect(serverSaw.authorization).toBe("Bearer t0k3n");
		});

		it("a guard that does not return true blocks the call before it is sent", async () => {
			addHook({ phase: "guard", fn: () => undefined });
			const rpc = await getRpcClient<Api>({ baseUrl: url });
			await expect(rpc.TestMathModule.add(1, 2)).rejects.toThrow("RPC call to TestMathModule.add was blocked by a guard");
			await expect(new rpc.TestUserApi().getUser("1")).rejects.toThrow(/blocked by a guard/);
		});
	});

	describe("uploads from Node.js", () => {
		beforeAll(() => {
			server.rpc.addUploadHandler("store", async (data, meta) => ({ size: data.byteLength, sha256: meta.sha256, name: meta.originalFilename, encoding: meta.contentEncoding }));
			server.rpc.addStreamingUploadHandler("count", async (stream) => {
				let bytes = 0;
				for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) bytes += chunk.byteLength;
				return bytes;
			});
			server.rpc.addUploadHandler("fail", () => {
				throw new Error("handler said no");
			});
		});

		it("upload() streams the body in chunks and ends with complete", async () => {
			const data = testBytes(1024 * 1024);
			const events: UploadEvent<{ size: number; sha256: string; name: string; encoding: string }>[] = [];
			for await (const event of upload<{ size: number; sha256: string; name: string; encoding: string }>("store", data, {
				baseUrl: url,
				chunkSize: 128 * 1024,
				originalFilename: "data.bin",
			})) {
				events.push(event);
			}
			const sending = events.filter((e) => e.type === "sending");
			expect(sending).toHaveLength(8);
			expect(sending.at(-1)).toMatchObject({ bytesSent: data.byteLength, totalBytes: data.byteLength, percent: 100 });
			const complete = events.at(-1)!;
			expect(complete.type).toBe("complete");
			if (complete.type !== "complete") return;
			expect(complete.sha256).toBe(await sha256(data));
			expect(complete.result).toEqual({ size: data.byteLength, sha256: complete.sha256, name: "data.bin", encoding: "gzip" });
		});

		it("uploadComplete() resolves with the result; compression none sends identity", async () => {
			const data = testBytes(10_000);
			const result = await uploadComplete<{ encoding: string; size: number }>("store", new Blob([data]), { baseUrl: url, compression: "none" });
			expect(result.result).toMatchObject({ encoding: "identity", size: 10_000 });
			expect(result.bytesReceived).toBe(10_000);
			expect(await uploadComplete("count", data.buffer, { baseUrl: url })).toMatchObject({ result: 10_000 });
			// A name outside Latin-1 is not a valid header value; the client percent-encodes it.
			const named = await uploadComplete<{ name: string }>("store", data, { baseUrl: url, originalFilename: "名前 100%.txt" });
			expect(named.result.name).toBe("名前 100%.txt");
		});

		it("upload() with a known uploadId resumes from the server's offset", async () => {
			const data = testBytes(300_000, 21);
			// A first attempt that dies after 100 000 bytes, sent straight to rpc.fetch like a dropped connection.
			let sent = false;
			const body = new ReadableStream<Uint8Array>({
				pull(controller) {
					if (sent) controller.error(new Error("dropped"));
					else controller.enqueue(data.subarray(0, 100_000));
					sent = true;
				},
			});
			const first = await server.rpc.fetch(
				new Request("http://localhost/rpc/upload", {
					method: "POST",
					headers: { "X-Upload-Handler": "store", "X-Upload-Id": "resume-me", "X-Original-Size": String(data.byteLength) },
					body,
					// @ts-expect-error undici needs duplex for a streamed body
					duplex: "half",
				}),
			);
			expect(first.status).toBe(500);
			const sending: number[] = [];
			let final: UploadEvent<{ size: number }> | undefined;
			for await (const event of upload<{ size: number }>("store", data, { baseUrl: url, uploadId: "resume-me", compression: "none" })) {
				if (event.type === "sending") sending.push(event.bytesSent);
				final = event;
			}
			expect(sending[0]).toBeGreaterThan(100_000);
			expect(final).toMatchObject({ type: "complete", bytesReceived: 300_000, sha256: await sha256(data), result: { size: 300_000 } });
		});

		it("throws for unknown handlers, handler errors and blocking guards", async () => {
			await expect(uploadComplete("nope", new Uint8Array(1), { baseUrl: url })).rejects.toMatchObject({ status: 404, handler: "nope" });
			await expect(uploadComplete("fail", new Uint8Array(1), { baseUrl: url })).rejects.toThrow("handler said no");
			addHook({ phase: "guard", fn: (ns) => ns !== "__upload__" });
			await expect(uploadComplete("store", new Uint8Array(1), { baseUrl: url })).rejects.toThrow('Upload to "store" was blocked by a guard');
		});
	});
});

/**
 * A real HTTP listener that answers 401 unless the request carries `Bearer <token>`, as a host does that guards the
 * whole `/rpc` path. It records which paths arrived with which Authorization header.
 */
async function guardedListener(token: string) {
	const rpc = createRpcServer({ Math: { add: (a: number, b: number) => a + b, token: () => token } });
	const seen: string[] = [];
	const listener: Server = createServer(async (req, res) => {
		seen.push(`${req.url} ${req.headers.authorization ?? "-"}`);
		if (req.headers.authorization !== `Bearer ${token}`) return void res.writeHead(401).end();
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(chunk as Buffer);
		const answer = await rpc.fetch(
			new Request(`http://127.0.0.1${req.url}`, {
				method: req.method,
				headers: req.headers as Record<string, string>,
				body: chunks.length ? Buffer.concat(chunks) : undefined,
			}),
		);
		res.writeHead(answer.status, Object.fromEntries(answer.headers)).end(Buffer.from(await answer.arrayBuffer()));
	});
	await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
	const url = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
	return {
		url,
		seen,
		stop: async () => {
			await new Promise((resolve) => listener.close(resolve));
			await rpc.close();
		},
	};
}

describe("headers for a server that guards its schema", () => {
	type Guarded = { Math: { add(a: number, b: number): Promise<number>; token(): Promise<string> } };
	beforeEach(() => {
		clearSchemaCache();
		clearHooks();
	});

	it("a client's own headers reach its schema request and calls, and two clients keep their credentials apart", async () => {
		const [a, b] = await Promise.all([guardedListener("a"), guardedListener("b")]);
		try {
			await expect(getRpcClient<Guarded>({ baseUrl: a.url })).rejects.toThrow("Failed to fetch schema: 401");
			const [rpcA, rpcB] = await Promise.all([
				getRpcClient<Guarded>({ baseUrl: a.url, headers: { Authorization: "Bearer a" } }),
				getRpcClient<Guarded>({ baseUrl: b.url, headers: new Headers({ Authorization: "Bearer b" }) }),
			]);
			expect([await rpcA.Math.token(), await rpcB.Math.token(), await rpcA.Math.add(2, 3)]).toEqual(["a", "b", 5]);
			expect(a.seen).toEqual(["/rpc/schema -", "/rpc/schema Bearer a", "/rpc Bearer a", "/rpc Bearer a"]);
			expect(b.seen).toEqual(["/rpc/schema Bearer b", "/rpc Bearer b"]);
		} finally {
			await Promise.all([a.stop(), b.stop()]);
		}
	});

	it("setHeaders() reaches the schema request and accepts a Headers instance or pairs; a client's headers win", async () => {
		const a = await guardedListener("a");
		try {
			setHeaders(new Headers({ Authorization: "Bearer a" }));
			expect((await getSchema(a.url)).map((entry) => (entry.kind === "module" ? entry.moduleName : entry.className))).toEqual(["Math"]);
			setHeaders([["Authorization", "Bearer a"]]);
			expect(await (await getRpcClient<Guarded>({ baseUrl: a.url })).Math.add(1, 1)).toBe(2);
			setHeaders({ Authorization: "Bearer wrong" });
			clearSchemaCache();
			const rpc = await getRpcClient<Guarded>({ baseUrl: a.url, headers: { Authorization: "Bearer a" } });
			expect(await rpc.Math.token()).toBe("a");
			// A Headers instance names its headers in lower case; the client's Authorization must still replace it.
			setHeaders(new Headers({ Authorization: "Bearer wrong" }));
			clearSchemaCache();
			const cased = await getRpcClient<Guarded>({ baseUrl: a.url, headers: { Authorization: "Bearer a" } });
			expect(await cased.Math.token()).toBe("a");
			const headers = { Authorization: "Bearer a" };
			const options = { baseUrl: a.url, progress: false, headers, uploadId: "u1" };
			await expect(uploadComplete("none", new Uint8Array([1]), options)).rejects.toThrow();
			expect(a.seen.slice(-2)).toEqual(["/rpc/upload/u1 Bearer a", "/rpc/upload Bearer a"]);
		} finally {
			await a.stop();
		}
	});
});
