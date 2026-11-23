/**
 * Two RPC servers in one process share nothing: namespaces, docs, hooks, upload sessions, temp files and progress
 * streams stay with the server that owns them, and closing one leaves the other serving. Real `Request`s, real temp
 * files and, for the listeners, real HTTP.
 */
import { mkdtemp, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DSON } from "defuss-dson";
import { ExpressRpcServer } from "./express-server.js";
import { createRpcServer, rpcRoute } from "./server.js";
import type { RpcServer, RpcServerOptions, ApiNamespace } from "./types.d.js";
import { testBytes } from "./test/api.js";
import { callRoute, frames, PROVIDERS, sha256 } from "./test/server.js";

const open: RpcServer[] = [];
/** A server that the test's `afterEach` closes. */
function make(ns: ApiNamespace = {}, options?: RpcServerOptions) {
	const rpc = createRpcServer(ns, options);
	open.push(rpc);
	return rpc;
}
afterEach(async () => {
	await Promise.all(open.splice(0).map((rpc) => rpc.close()));
});

const value = async (response: Response) => DSON.parse(await response.text());
const Adder = { add: (a: number, b: number) => a + b };

const schemaOf = async (rpc: RpcServer) =>
	((await (await rpc.fetch(new Request("http://localhost/rpc/schema", { method: "POST" }))).json()) as any[]).map((entry) => [
		entry.moduleName,
		Object.keys(entry.methods),
		entry.description,
	]);

function upload(rpc: RpcServer, uploadId: string, body: Uint8Array | ReadableStream<Uint8Array>, size: number) {
	return rpc.fetch(
		new Request("http://localhost/rpc/upload", {
			method: "POST",
			headers: { "X-Upload-Handler": "keep", "X-Upload-Id": uploadId, "X-Original-Size": String(size) },
			body: body as BodyInit,
			// @ts-expect-error undici needs duplex for a streamed body
			duplex: "half",
		}),
	);
}

const head = (rpc: RpcServer, uploadId: string) => rpc.fetch(new Request(`http://localhost/rpc/upload/${uploadId}`, { method: "HEAD" }));

/** A body that sends the first `split` bytes, then waits for `gate` before the rest, so two uploads overlap. */
function gated(data: Uint8Array, split: number, gate: Promise<void>): ReadableStream<Uint8Array> {
	let step = 0;
	return new ReadableStream({
		async pull(controller) {
			if (step++ === 0) return controller.enqueue(data.subarray(0, split));
			await gate;
			controller.enqueue(data.subarray(split));
			controller.close();
		},
	});
}

/** A body that sends `first` bytes and then fails, like a dropped connection: the server keeps the session. */
function dropped(data: Uint8Array): ReadableStream<Uint8Array> {
	let sent = false;
	return new ReadableStream({
		pull(controller) {
			if (sent) return controller.error(new Error("dropped"));
			sent = true;
			controller.enqueue(data);
		},
	});
}

/** Polls `check` every 10 ms until it holds, failing after 2 s. */
async function until(check: () => Promise<boolean>) {
	for (let i = 0; i < 200; i++) {
		if (await check()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("condition not reached within 2 s");
}

/** Reads a Server-Sent Events body to its end. */
async function events(response: Response): Promise<any[]> {
	const text = await response.text();
	return text
		.split("\n\n")
		.filter((block) => block.startsWith("data: "))
		.map((block) => JSON.parse(block.slice(6)));
}

describe("two RPC servers in one process", () => {
	it("serve overlapping namespace names from their own implementations, schemas and docs", async () => {
		const a = make({ Math: Adder }, { docs: [{ kind: "module", moduleName: "Math", description: "Adds.", methods: {} }] });
		const b = make({ Math: { add: (x: number, y: number) => x * y, square: (x: number) => x * x }, Extra: { ping: () => "pong" } });
		expect(await value(await callRoute(a, "Math", "add", [3, 4]))).toBe(7);
		expect(await value(await callRoute(b, "Math", "add", [3, 4]))).toBe(12);
		expect((await callRoute(a, "Math", "square", [3])).status).toBe(404);
		expect((await callRoute(a, "Extra", "ping")).status).toBe(404);
		expect(await schemaOf(a)).toEqual([["Math", ["add"], "Adds."]]);
		expect(await schemaOf(b)).toEqual([
			["Math", ["add", "square"], undefined],
			["Extra", ["ping"], undefined],
		]);
	});

	it("run only their own hooks", async () => {
		const a = make({ Math: Adder });
		const b = make({ Math: Adder });
		const results: string[] = [];
		a.addHook({ phase: "guard", fn: () => false });
		a.addHook({ phase: "result", fn: () => void results.push("a") });
		b.addHook({ phase: "result", fn: (_ns, _method, _args, _request, result) => void results.push(`b=${result}`) });
		expect((await callRoute(a, "Math", "add", [1, 2])).status).toBe(403);
		expect(await value(await callRoute(b, "Math", "add", [1, 2]))).toBe(3);
		expect(results).toEqual(["b=3"]);
	});

	it("keep concurrent uploads with the same upload ID apart: sessions, temp files, bytes and hashes", async () => {
		const a = make();
		const b = make();
		const received: Record<string, Uint8Array> = {};
		a.addUploadHandler("keep", (data) => ((received.a = data), "a"));
		b.addUploadHandler("keep", (data) => ((received.b = data), "b"));
		expect(a.uploadDir).not.toBe(b.uploadDir);

		const dataA = testBytes(600_000, 1);
		const dataB = testBytes(400_000, 2);
		let release!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		const pendingA = upload(a, "same", gated(dataA, 100_000, gate), dataA.byteLength);
		const pendingB = upload(b, "same", gated(dataB, 50_000, gate), dataB.byteLength);
		// Both sessions hold their first part on disk before either upload ends.
		const offset = async (rpc: RpcServer) => (await head(rpc, "same")).headers.get("x-upload-offset");
		await until(async () => (await offset(a)) === "100000" && (await offset(b)) === "50000");
		release();

		const [answerA, answerB] = await Promise.all([pendingA, pendingB]);
		expect([answerA.status, answerB.status]).toEqual([201, 201]);
		expect(await frames(answerA)).toEqual([
			expect.objectContaining({ type: "received", uploadId: "same", bytesReceived: 600_000, sha256: await sha256(dataA) }),
			{ type: "result", value: "a" },
		]);
		expect(await frames(answerB)).toEqual([
			expect.objectContaining({ type: "received", uploadId: "same", bytesReceived: 400_000, sha256: await sha256(dataB) }),
			{ type: "result", value: "b" },
		]);
		expect(received.a).toEqual(dataA);
		expect(received.b).toEqual(dataB);
	});

	it("send upload progress only to the progress streams of their own server", async () => {
		const a = make();
		const b = make();
		a.addUploadHandler("keep", (data) => data.byteLength);
		b.addUploadHandler("keep", (data) => data.byteLength);
		const progressA = a.fetch(new Request("http://localhost/rpc/upload/progress/same"));
		const eventsB = b.fetch(new Request("http://localhost/rpc/upload/progress/same")).then(events);

		const big = testBytes(2 * 1024 * 1024);
		expect((await upload(b, "same", big, big.byteLength)).status).toBe(201);
		expect((await eventsB).at(-1)).toMatchObject({ type: "complete", bytesReceived: big.byteLength });

		// a's stream saw nothing of b's upload: it is still open, and a's own upload completes it.
		const eventsA = progressA.then(events);
		const small = testBytes(1000);
		expect((await upload(a, "same", small, small.byteLength)).status).toBe(201);
		const seenA = await eventsA;
		expect(seenA.at(-1)).toMatchObject({ type: "complete", bytesReceived: 1000 });
		expect(seenA.every((event) => event.bytesReceived === undefined || event.bytesReceived <= 1000)).toBe(true);
	});

	it("close independently: 503, ended streams and deleted temp files on one, the other serves on", async () => {
		let finalized = false;
		const Stream = {
			async *endless() {
				try {
					for (let i = 0; ; i++) {
						yield i;
						await new Promise((resolve) => setTimeout(resolve, 5));
					}
				} finally {
					finalized = true;
				}
			},
		};
		const a = make({ Math: Adder, Stream });
		const b = make({ Math: Adder });
		for (const rpc of [a, b]) rpc.addUploadHandler("keep", (data) => data.byteLength);
		// On each: an upload that dropped after 1000 bytes, so its session and temp file stay for a resume.
		for (const rpc of [a, b]) expect((await upload(rpc, "half", dropped(testBytes(1000)), 5000)).status).toBe(500);
		expect(await readdir(a.uploadDir)).toEqual(["half.part"]);
		expect(await readdir(b.uploadDir)).toEqual(["half.part"]);
		// On a: a running generator stream and an open progress stream.
		const reader = (await callRoute(a, "Stream", "endless")).body!.getReader();
		await reader.read();
		const progress = a.fetch(new Request("http://localhost/rpc/upload/progress/waiting")).then(events);

		await a.close();
		let tail = "";
		for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) tail += new TextDecoder().decode(chunk.value);
		expect(DSON.parse(tail.trim().split("\n").at(-1)!)).toEqual({ type: "error", error: { message: "RPC server closed" } });
		await until(async () => finalized);
		expect(await progress).toEqual([{ type: "error", error: "RPC server closed" }]);
		expect((await callRoute(a, "Math", "add", [1, 2])).status).toBe(503);
		await expect(stat(a.uploadDir), "the server's own upload directory is gone").rejects.toThrow();
		await a.close();

		expect(await value(await callRoute(b, "Math", "add", [1, 2]))).toBe(3);
		expect((await head(b, "half")).headers.get("x-upload-offset")).toBe("1000");
		expect(await readdir(b.uploadDir)).toEqual(["half.part"]);
	});

	it("close() deletes its temp files but keeps an upload directory it was given", async () => {
		const dir = await mkdtemp(join(tmpdir(), "defuss-rpc-given-"));
		const rpc = make({}, { uploadDir: dir });
		rpc.addUploadHandler("keep", (data) => data.byteLength);
		expect((await upload(rpc, "kept", dropped(testBytes(10)), 100)).status).toBe(500);
		expect(await readdir(dir)).toEqual(["kept.part"]);
		await rpc.close();
		expect(await readdir(dir)).toEqual([]);
	});

	it("neither read nor write the deprecated global server", async () => {
		const rpc = make({ OnlyHere: Adder });
		const call = (className: string) =>
			rpcRoute({
				request: new Request("http://localhost/rpc", {
					method: "POST",
					body: DSON.stringify({ className, methodName: "add", args: [1, 2] }),
				}),
			});
		expect((await call("OnlyHere")).status).toBe(404);
		expect(await value(await callRoute(rpc, "OnlyHere", "add", [1, 2]))).toBe(3);
	});

	it("match only the RPC routes, and fetch is bound to its server", async () => {
		const rpc = make({ Math: Adder });
		const matches = (method: string, path: string) => rpc.matches(new Request(`http://localhost${path}`, { method }));
		for (const [method, path] of [
			["POST", "/rpc"],
			["POST", "/api/v1/rpc/"],
			["GET", "/rpc/schema"],
			["POST", "/rpc/upload"],
			["HEAD", "/rpc/upload/abc"],
			["GET", "/rpc/upload/progress/abc"],
			["GET", "/rpc/download?handler=file"],
		])
			expect(matches(method, path), `${method} ${path}`).toBe(true);
		for (const [method, path] of [
			["GET", "/"],
			["GET", "/index.html"],
			["GET", "/rpc"],
			["OPTIONS", "/rpc"],
			["GET", "/rpc/upload"],
			["POST", "/rpc/download"],
			["POST", "/xrpc"],
		])
			expect(matches(method, path), `${method} ${path}`).toBe(false);
		expect(rpc.name).toBe("defuss-rpc");
		expect(make({}, { name: "admin" }).name).toBe("admin");
		const { fetch } = rpc;
		expect((await fetch(new Request("http://localhost/rpc/schema"))).status).toBe(200);
	});

	it("serve their own API through two listeners in one process", async () => {
		const a = make({ Math: Adder });
		const b = make({ Math: { add: (x: number, y: number) => x * y } });
		const listeners = [a, b].map((rpc, i) => new ExpressRpcServer({ rpc, provider: PROVIDERS[i % PROVIDERS.length], host: "127.0.0.1", port: 0 }));
		const [urlA, urlB] = await Promise.all(listeners.map(async (listener) => (await listener.start()).url));
		const add = (url: string) =>
			fetch(`${url}/rpc`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: DSON.stringify({ className: "Math", methodName: "add", args: [3, 4] }),
			});
		try {
			expect([await value(await add(urlA)), await value(await add(urlB))]).toEqual([7, 12]);
			await a.close();
			expect((await add(urlA)).status).toBe(503);
			expect(await value(await add(urlB))).toBe(12);
		} finally {
			await Promise.all(listeners.map((listener) => listener.stop()));
		}
	});
});
