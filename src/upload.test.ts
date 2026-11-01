import { readdir } from "node:fs/promises";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	addHook,
	addStreamingUploadHandler,
	addUploadHandler,
	clearRpcServer,
	getUploadDir,
	rpcRoute,
} from "./server.js";
import { testBytes } from "./test/api.js";
import { frames, isolateUploads, sha256 } from "./test/server.js";

interface PostOptions {
	handler?: string;
	uploadId?: string;
	offset?: number;
	originalSize?: number;
	encoding?: "gzip" | "deflate";
	filename?: string;
}

function post(body: BodyInit | ReadableStream<Uint8Array> | null, options: PostOptions = {}) {
	const headers: Record<string, string> = {
		"Content-Type": "application/octet-stream",
		"X-Upload-Handler": options.handler ?? "buffered",
		"X-Upload-Offset": String(options.offset ?? 0),
	};
	if (options.uploadId) headers["X-Upload-Id"] = options.uploadId;
	if (options.originalSize !== undefined) headers["X-Original-Size"] = String(options.originalSize);
	if (options.encoding) headers["Content-Encoding"] = options.encoding;
	if (options.filename) headers["X-Original-Filename"] = options.filename;
	const request = new Request("http://localhost/rpc/upload", {
		method: "POST",
		headers,
		body,
		// @ts-expect-error undici needs duplex for a streamed body
		duplex: "half",
	});
	return rpcRoute({ request });
}

const head = (uploadId: string) =>
	rpcRoute({ request: new Request(`http://localhost/rpc/upload/${uploadId}`, { method: "HEAD" }) });

async function compress(data: Uint8Array, format: "gzip" | "deflate") {
	const stream = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream(format));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** A body that delivers `part` and then fails, like a connection that drops mid-upload. */
const droppingBody = (part: Uint8Array) => {
	let sent = false;
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			// error() discards queued chunks, so the part goes out in one pull and the failure in the next.
			if (sent) controller.error(new Error("connection dropped"));
			else controller.enqueue(part);
			sent = true;
		},
	});
};

/** Reads Server-Sent Events until `complete` or `error`. */
async function readEvents(response: Response): Promise<any[]> {
	const events: any[] = [];
	const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
	let buffer = "";
	while (true) {
		const { done, value } = await reader.read();
		if (done) return events;
		buffer += value;
		const parts = buffer.split("\n\n");
		buffer = parts.pop()!;
		for (const part of parts) {
			const event = JSON.parse(part.replace(/^data: /, ""));
			events.push(event);
			if (event.type === "complete" || event.type === "error") {
				await reader.cancel();
				return events;
			}
		}
	}
}

let received: { data?: Uint8Array; meta?: any; chunks?: number[] } = {};

describe("uploads via rpcRoute", () => {
	beforeAll(isolateUploads);
	beforeEach(() => {
		received = {};
		addUploadHandler("buffered", (data, meta) => {
			received = { data, meta };
			return { size: data.byteLength, name: meta.originalFilename };
		});
		addStreamingUploadHandler("streaming", async (stream, meta) => {
			const chunks: number[] = [];
			const parts: Uint8Array[] = [];
			for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
				chunks.push(chunk.byteLength);
				parts.push(chunk);
			}
			received = { chunks, meta, data: new Uint8Array(await new Blob(parts as Uint8Array<ArrayBuffer>[]).arrayBuffer()) };
			return { chunks: chunks.length };
		});
		addUploadHandler("failing", () => {
			throw new Error("Intentional handler error");
		});
	});
	afterEach(() => clearRpcServer());

	it("hands a buffered handler the bytes and answers received + result frames with SHA-256", async () => {
		const data = testBytes(300_000);
		const response = await post(data, { uploadId: "u-1", originalSize: data.byteLength, filename: "a b.bin" });
		expect(response.status).toBe(201);
		const [receivedFrame, resultFrame] = await frames(response);
		expect(receivedFrame).toMatchObject({ type: "received", uploadId: "u-1", bytesReceived: 300_000, sha256: await sha256(data) });
		expect(resultFrame).toEqual({ type: "result", value: { size: 300_000, name: "a b.bin" } });
		expect(received.data).toEqual(data);
		expect(received.meta).toMatchObject({ handlerName: "buffered", originalSize: 300_000, offset: 0, contentEncoding: "identity" });
		// A successful upload leaves no temp file behind.
		expect(await readdir(getUploadDir())).toEqual([]);
	});

	it("streams the stored upload to a streaming handler in bounded chunks", async () => {
		const data = testBytes(1024 * 1024 + 5);
		const [, resultFrame] = await frames(await post(data, { handler: "streaming", originalSize: data.byteLength }));
		expect(resultFrame.value.chunks).toBeGreaterThanOrEqual(5);
		expect(Math.max(...received.chunks!)).toBeLessThanOrEqual(256 * 1024);
		expect(received.data).toEqual(data);
	});

	it("inflates gzip and deflate bodies and hashes the original bytes", async () => {
		const data = testBytes(50_000, 99);
		for (const encoding of ["gzip", "deflate"] as const) {
			const [receivedFrame] = await frames(await post(await compress(data, encoding), { encoding, originalSize: data.byteLength }));
			expect(receivedFrame.bytesReceived).toBe(data.byteLength);
			expect(receivedFrame.sha256).toBe(await sha256(data));
			expect(received.meta.contentEncoding).toBe(encoding);
		}
	});

	it("accepts an empty upload", async () => {
		const [receivedFrame] = await frames(await post(null, { originalSize: 0 }));
		expect(receivedFrame).toMatchObject({ bytesReceived: 0, sha256: await sha256(new Uint8Array(0)) });
	});

	it("answers 404 for an unknown handler and 403 when a guard rejects", async () => {
		expect((await post(new Uint8Array(1), { handler: "nope" })).status).toBe(404);
		const seen: unknown[] = [];
		addHook({ phase: "guard", fn: (ns, method, args) => (seen.push([ns, method, args]), false) });
		expect((await post(new Uint8Array(3), { originalSize: 3 })).status).toBe(403);
		expect(seen).toEqual([["__upload__", "buffered", [3]]]);
	});

	it("reports a throwing handler as an error frame and keeps the temp file for a retry", async () => {
		const response = await post(testBytes(10), { handler: "failing", uploadId: "u-fail", originalSize: 10 });
		expect(response.status).toBe(200);
		const [receivedFrame, errorFrame] = await frames(response);
		expect(receivedFrame).toMatchObject({ type: "received", bytesReceived: 10 });
		expect(errorFrame).toMatchObject({ type: "error", error: { message: "Intentional handler error" } });
		const status = await head("u-fail");
		expect(status.headers.get("x-upload-status")).toBe("error");
		expect(status.headers.get("x-upload-offset")).toBe("10");
	});

	it("runs result hooks after a successful and after a failed handler", async () => {
		const results: unknown[] = [];
		addHook({ phase: "result", fn: (ns, method, _args, _request, result) => void results.push([ns, method, result]) });
		await (await post(testBytes(4), { originalSize: 4 })).text();
		await (await post(testBytes(4), { handler: "failing", originalSize: 4 })).text();
		expect(results).toEqual([
			["__upload__", "buffered", { size: 4, name: "" }],
			["__upload__", "failing", undefined],
		]);
	});

	it("resumes after a dropped connection: HEAD offset, append, hash of the whole file", async () => {
		const data = testBytes(400_000, 7);
		const half = data.subarray(0, 150_000);
		const dropped = await post(droppingBody(half), { uploadId: "u-resume", originalSize: data.byteLength });
		expect(dropped.status).toBe(500);

		const status = await head("u-resume");
		expect(status.status).toBe(200);
		const offset = Number(status.headers.get("x-upload-offset"));
		expect(offset).toBe(150_000);
		expect(status.headers.get("x-upload-handler")).toBe("buffered");

		const mismatch = await post(data.subarray(offset + 1), { uploadId: "u-resume", offset: offset + 1, originalSize: data.byteLength });
		expect(mismatch.status).toBe(409);

		const resumed = await post(data.subarray(offset), { uploadId: "u-resume", offset, originalSize: data.byteLength });
		expect(resumed.status).toBe(201);
		const [receivedFrame] = await frames(resumed);
		expect(receivedFrame).toMatchObject({ bytesReceived: 400_000, sha256: await sha256(data) });
		expect(received.data).toEqual(data);
		expect(received.meta.offset).toBe(150_000);
	});

	it("answers 404 for a resume without a session and creates none", async () => {
		const response = await post(testBytes(5), { uploadId: "u-ghost", offset: 100 });
		expect(response.status).toBe(404);
		expect((await head("u-ghost")).status).toBe(404);
	});

	it("sanitizes upload IDs into file names inside the upload directory", async () => {
		const [receivedFrame] = await frames(await post(testBytes(3), { uploadId: "../../etc/passwd", originalSize: 3 }));
		expect(receivedFrame.uploadId).toBe(".._.._etc_passwd");
	});

	it("streams progress over SSE to a client that subscribed before the POST", async () => {
		const progress = rpcRoute({ request: new Request("http://localhost/rpc/upload/progress/u-sse") });
		const data = testBytes(2 * 1024 * 1024);
		const [events, upload] = await Promise.all([
			progress.then(readEvents),
			post(data, { uploadId: "u-sse", originalSize: data.byteLength }),
		]);
		expect(upload.status).toBe(201);
		const updates = events.filter((e) => e.type === "progress");
		expect(updates.length).toBeGreaterThan(0);
		expect(updates.every((e) => e.totalBytes === data.byteLength && e.percent >= 0 && e.percent <= 100)).toBe(true);
		expect(events.at(-1)).toMatchObject({ type: "complete", percent: 100 });
	});

	it("rejects invalid handler names at registration", () => {
		for (const name of ["", "a b", "x/y", "z".repeat(129)]) {
			expect(() => addUploadHandler(name, () => null)).toThrow(/Invalid upload handler name/);
		}
	});
});
