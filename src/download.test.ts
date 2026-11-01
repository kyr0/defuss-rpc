import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	addDownloadHandler,
	addHook,
	addStreamingDownloadHandler,
	clearRpcServer,
	rpcRoute,
	type DownloadMeta,
} from "./server.js";
import { download, downloadAsBlob, parseContentDisposition } from "./client.js";
import { testBytes } from "./test/api.js";
import type { RpcServerProvider } from "./provider.js";
import { PROVIDERS, serveRegistry, sha256 } from "./test/server.js";

const FILE = testBytes(70_000, 3);
let lastMeta: DownloadMeta | undefined;
let server: Awaited<ReturnType<typeof serveRegistry>>;

const get = (query: string, headers: Record<string, string> = {}) =>
	rpcRoute({ request: new Request(`http://localhost/rpc/download?${query}`, { headers }) });

describe("downloads", () => {
	beforeAll(async () => {
		await clearRpcServer();
		addDownloadHandler("raw", () => FILE);
		addDownloadHandler("report", async (meta) => {
			lastMeta = meta;
			return {
				data: FILE,
				fileMeta: {
					size: FILE.byteLength,
					contentType: "text/plain",
					filename: `Bericht März 名前 "${meta.downloadId}".txt`,
					sha256: await sha256(FILE),
					lastModified: Date.UTC(2026, 10, 1),
				},
			};
		});
		addStreamingDownloadHandler("stream", () => ({
			stream: new Blob([FILE]).stream(),
			fileMeta: { size: FILE.byteLength, contentType: "application/octet-stream", filename: "data.bin" },
		}));
		addDownloadHandler("broken", () => {
			throw new Error("disk on fire");
		});
		addHook({ phase: "guard", fn: (ns, _m, _args, request) => ns !== "__download__" || request.headers.get("authorization") !== "Bearer bad" });
	});
	afterAll(async () => {
		await clearRpcServer();
	});

	describe("rpcRoute", () => {
		it("sends a raw Uint8Array as application/octet-stream", async () => {
			const response = await get("handler=raw&downloadId=d1");
			expect(response.status).toBe(200);
			expect(response.headers.get("content-type")).toBe("application/octet-stream");
			expect(response.headers.get("content-length")).toBe(String(FILE.byteLength));
			expect(response.headers.get("x-download-id")).toBe("d1");
			expect(new Uint8Array(await response.arrayBuffer())).toEqual(FILE);
		});

		it("turns fileMeta into headers; a non-ASCII or quoted name is carried by filename*", async () => {
			const response = await get("handler=report&downloadId=42", { Range: "bytes=10-99" });
			expect(response.headers.get("content-type")).toBe("text/plain");
			expect(response.headers.get("x-file-sha256")).toBe(await sha256(FILE));
			expect(response.headers.get("last-modified")).toBe("Sun, 01 Nov 2026 00:00:00 GMT");
			const disposition = response.headers.get("content-disposition")!;
			expect(disposition).toMatch(/^attachment; filename="Bericht M_rz __ _42_.txt"; filename\*=UTF-8''/);
			expect(parseContentDisposition(disposition)).toBe('Bericht März 名前 "42".txt');
			expect(lastMeta).toEqual({ downloadId: "42", handlerName: "report", rangeStart: 10, rangeEnd: 99 });
			await response.arrayBuffer();
		});

		it("answers 404, 403 and 500 with a JSON error", async () => {
			expect((await get("handler=nope")).status).toBe(404);
			expect((await get("handler=raw", { Authorization: "Bearer bad" })).status).toBe(403);
			const broken = await get("handler=broken");
			expect(broken.status).toBe(500);
			expect(await broken.json()).toEqual({ error: "disk on fire" });
		});
	});

	describe.for(PROVIDERS)("client over ExpressRpcServer on $name", (provider: RpcServerProvider<unknown>) => {
		beforeAll(async () => {
			server = await serveRegistry(provider);
		});
		afterAll(async () => {
			await server.stop();
		});

		it("download() returns the bytes and the server's metadata", async () => {
			const result = await download("report", server.url, { downloadId: "7", headers: { Authorization: "Bearer ok" } });
			expect(result.data).toEqual(FILE);
			expect(result).toMatchObject({
				downloadId: "7",
				bytesDownloaded: FILE.byteLength,
				sha256: await sha256(FILE),
				filename: 'Bericht März 名前 "7".txt',
				contentType: "text/plain",
			});
		});

		it("streams a streaming handler's file", async () => {
			const result = await download("stream", server.url);
			expect(result.data).toEqual(FILE);
			expect(result.filename).toBe("data.bin");
		});

		it("downloadAsBlob() returns a Blob and the downloadId it sent", async () => {
			const { blob, result } = await downloadAsBlob("raw", server.url, { downloadId: "blob-1" });
			expect(new Uint8Array(await blob.arrayBuffer())).toEqual(FILE);
			expect(result.downloadId).toBe("blob-1");
			expect(result.bytesDownloaded).toBe(FILE.byteLength);
		});

		it("throws with status and body for failed downloads", async () => {
			await expect(download("nope", server.url)).rejects.toMatchObject({ status: 404, handler: "nope" });
			await expect(download("raw", server.url, { headers: { Authorization: "Bearer bad" } })).rejects.toMatchObject({ status: 403 });
			await expect(downloadAsBlob("broken", server.url)).rejects.toThrow(/Download failed: 500/);
		});
	});

	it("parseContentDisposition falls back to filename and handles absent headers", () => {
		expect(parseContentDisposition(null)).toBeNull();
		expect(parseContentDisposition('attachment; filename="a.txt"')).toBe("a.txt");
		expect(parseContentDisposition("attachment; filename=b.txt")).toBe("b.txt");
		expect(parseContentDisposition("attachment; filename=\"x\"; filename*=UTF-8''%E2%9C%93.txt")).toBe("✓.txt");
		expect(parseContentDisposition("attachment; filename=\"fallback\"; filename*=UTF-8''%E2%28")).toBe("fallback");
	});
});
