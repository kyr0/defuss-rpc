/**
 * The client in real browsers (Chromium and WebKit) against an ExpressRpcServer per provider on another origin:
 * calls, DSON types, generator streaming, buffered uploads with Server-Sent Events progress, and downloads as Blob.
 */
import { beforeEach, describe, expect, inject, it } from "vitest";
import {
	addHook,
	clearHooks,
	download,
	downloadAsBlob,
	getRpcClient,
	upload,
	uploadComplete,
	type UploadEvent,
} from "./client.js";
import type { TestMathModule, TestStreamModule, TestTypesModule, TestUserApi } from "./test/api.js";

type Api = {
	TestUserApi: typeof TestUserApi;
	TestMathModule: typeof TestMathModule;
	TestTypesModule: typeof TestTypesModule;
	TestStreamModule: typeof TestStreamModule;
};

type Stored = { size: number; sha256: string; encoding: string; name: string };

function bytes(size: number, seed = 13): Uint8Array<ArrayBuffer> {
	const data = new Uint8Array(new ArrayBuffer(size));
	for (let i = 0; i < size; i++) data[i] = (i * 7 + seed) & 0xff;
	return data;
}

async function sha256Hex(data: BufferSource): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
	return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

describe.for(Object.entries(inject("rpcUrls")))("defuss-rpc client in the browser against %s", ([, url]) => {
	beforeEach(() => clearHooks());

	it("calls classes and modules cross-origin and restores DSON types", async () => {
		const rpc = await getRpcClient<Api>({ baseUrl: url });
		expect((await new rpc.TestUserApi().getUser("5")).email).toBe("user5@example.com");
		expect(await rpc.TestMathModule.add(40, 2)).toBe(42);
		expect(await rpc.TestTypesModule.bytes(3)).toEqual(new Uint8Array([0, 1, 2]));
		expect(await rpc.TestTypesModule.set()).toEqual(new Set(["x", "y"]));
		expect(await rpc.TestTypesModule.big()).toBe(2n ** 64n);
		const sent = { at: new Date(1), tags: new Map([["k", [1, 2]]]) };
		expect(await rpc.TestTypesModule.echo(sent)).toEqual(sent);
	});

	it("streams generator frames into for await", async () => {
		const rpc = await getRpcClient<Api>({ baseUrl: url });
		const values: number[] = [];
		for await (const value of rpc.TestStreamModule.countUp(5)) values.push(value);
		expect(values).toEqual([0, 1, 2, 3, 4]);
		await expect(async () => {
			for await (const _ of rpc.TestStreamModule.throwMidStream()) {
				// consume
			}
		}).rejects.toThrow("mid-stream error");
	});

	it("upload() sends a buffered gzip body, reports server progress and the server's SHA-256", async () => {
		const data = bytes(3 * 1024 * 1024);
		const events: UploadEvent<Stored>[] = [];
		for await (const event of upload<Stored>("store", data, { baseUrl: url, originalFilename: "big.bin" })) events.push(event);
		const receiving = events.filter((e) => e.type === "receiving");
		expect(receiving.length).toBeGreaterThan(0);
		expect(events.filter((e) => e.type === "sending").at(-1)).toMatchObject({ bytesSent: data.byteLength, percent: 100 });
		const complete = events.at(-1)!;
		if (complete.type !== "complete") throw new Error(`last event: ${complete.type}`);
		expect(complete.sha256).toBe(await sha256Hex(data));
		expect(complete.result).toEqual({ size: data.byteLength, sha256: complete.sha256, encoding: "gzip", name: "big.bin" });
	});

	it("uploads File and Blob sources uncompressed and to streaming handlers", async () => {
		const file = new File([bytes(20_000, 5)], "photo.raw");
		const result = await uploadComplete<Stored>("store", file, { baseUrl: url, compression: "none", originalFilename: file.name });
		expect(result.result).toMatchObject({ size: 20_000, encoding: "identity", name: "photo.raw" });
		expect((await uploadComplete<number>("count", new Blob([bytes(70_000)]), { baseUrl: url })).result).toBe(70_000);
		expect((await uploadComplete<Stored>("store", new Uint8Array(0), { baseUrl: url })).bytesReceived).toBe(0);
	});

	it("round-trips an upload through a download handler as bytes and as Blob", async () => {
		const data = bytes(150_000, 77);
		const { uploadId } = await uploadComplete<Stored>("store", data, { baseUrl: url, originalFilename: "Übersicht 2026.bin" });
		const downloaded = await download("stored", url, { downloadId: uploadId });
		expect(downloaded.data).toEqual(data);
		expect(downloaded.filename).toBe("Übersicht 2026.bin");
		const { blob, result } = await downloadAsBlob("stored", url, { downloadId: uploadId });
		expect(await sha256Hex(await blob.arrayBuffer())).toBe(await sha256Hex(data));
		expect(result).toMatchObject({ downloadId: uploadId, bytesDownloaded: data.byteLength, filename: "Übersicht 2026.bin" });
	});

	it("surfaces handler errors, unknown handlers and client guards", async () => {
		await expect(uploadComplete("fail", bytes(10), { baseUrl: url })).rejects.toThrow("Intentional handler error");
		await expect(uploadComplete("nope", bytes(10), { baseUrl: url })).rejects.toMatchObject({ status: 404 });
		await expect(download("stored", url, { downloadId: "missing" })).rejects.toMatchObject({ status: 500 });
		addHook({ phase: "guard", fn: (_ns, method) => method !== "multiply" });
		const rpc = await getRpcClient<Api>({ baseUrl: url });
		expect(await rpc.TestMathModule.add(1, 1)).toBe(2);
		await expect(rpc.TestMathModule.multiply(2, 2)).rejects.toThrow(/blocked by a guard/);
	});
});
