/**
 * Vitest global setup of the browser projects: a real ExpressRpcServer per provider in Node.js, with the fixture API
 * and upload and download handlers. The browser tests reach it cross-origin (the page comes from Vitest's server), so they
 * also exercise CORS.
 */
import type { TestProject } from "vitest/node";
import { ExpressRpcServer } from "../express-server.js";
import {
	addDownloadHandler,
	addStreamingUploadHandler,
	addUploadHandler,
	clearRpcServer,
	createRpcServer,
} from "../server.js";
import { TestMathModule, TestStreamModule, TestTypesModule, TestUserApi } from "./api.js";
import { isolateUploads, PROVIDERS } from "./server.js";

let servers: ExpressRpcServer<unknown>[] = [];
const stored = new Map<string, { data: Uint8Array; name: string }>();

export async function setup(project: TestProject) {
	// VERIFIED: Vite's module runner maps stack traces of globalSetup code and crashes on a native frame
	// ("code.charCodeAt is not a function") whenever a handler throws, which takes the server process down.
	(Error as { prepareStackTrace?: unknown }).prepareStackTrace = undefined;
	await isolateUploads();
	createRpcServer({ TestUserApi, TestMathModule, TestTypesModule, TestStreamModule });
	addUploadHandler("store", (data, meta) => {
		stored.set(meta.uploadId, { data, name: meta.originalFilename });
		return { size: data.byteLength, sha256: meta.sha256, encoding: meta.contentEncoding, name: meta.originalFilename };
	});
	addStreamingUploadHandler("count", async (stream) => {
		let bytes = 0;
		for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) bytes += chunk.byteLength;
		return bytes;
	});
	addUploadHandler("fail", () => {
		throw new Error("Intentional handler error");
	});
	addDownloadHandler("stored", ({ downloadId }) => {
		const file = stored.get(downloadId);
		if (!file) throw new Error(`no upload ${downloadId}`);
		return { data: file.data, fileMeta: { size: file.data.byteLength, contentType: "application/octet-stream", filename: file.name } };
	});
	const urls: Record<string, string> = {};
	for (const provider of PROVIDERS) {
		const server = new ExpressRpcServer({ provider, port: 0, host: "127.0.0.1" });
		urls[provider.name] = (await server.start()).url;
		servers.push(server);
	}
	project.provide("rpcUrls", urls);
}

export async function teardown() {
	await Promise.all(servers.map((server) => server.stop()));
	servers = [];
	await clearRpcServer();
}

declare module "vitest" {
	export interface ProvidedContext {
		/** Server URL per provider name. */
		rpcUrls: Record<string, string>;
	}
}
