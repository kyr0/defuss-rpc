/**
 * The HTTP layer of `ExpressRpcServer` in Fetch API terms: CORS, preflights, `/health`, the call body limit, gzip and
 * the hand-over to {@link rpcRoute}. Providers connect it to their framework: `node:http` frameworks through
 * `nodeMiddleware()` (`node-bridge.ts`), Fetch frameworks such as bunway by passing their `Request` directly.
 *
 * Why Fetch terms and not `node:http`: bunway (on `Bun.serve`) has no `node:http` request or response, while every
 * `node:http` request converts to a `Request`; one implementation in Fetch terms serves both kinds, so CORS, limits
 * and compression cannot drift between providers.
 * VERIFIED: src/express-server.test.ts runs the same limit, encoding, CORS and gzip cases on every provider; a 4 KiB
 * body gzipped to a few dozen bytes gets 413 under a 1 KiB limit, and a `text/plain` call gets 400.
 *
 * @internal
 */
import { createGzip, gzipSync, constants as zlibConstants } from "node:zlib";
import { rpcRoute } from "./server.js";
import { errorMessage, log } from "./log.js";
import type { RpcHttpCore } from "./provider.js";

/** Settings of the core, resolved from `ExpressRpcServerOptions` once at construction. */
export interface RpcHttpCoreOptions {
	basePath: string;
	/** Maximum call body after decompression, in bytes. */
	jsonSizeLimit: number;
	corsOrigin: string | string[];
	/** `level` is ignored when `enabled` is false. */
	compression: { enabled: boolean; level: number };
}

/** Headers a browser client may send; preflights for other headers echo what the browser asks for. */
const ALLOWED_HEADERS =
	"Origin, X-Requested-With, Content-Type, Accept, Authorization, Content-Encoding, X-Upload-Handler, X-Upload-Id, X-Original-Size, X-Upload-Offset, X-Original-Filename";

/** Response headers a cross-origin `fetch()` may read: resume state and download metadata. */
const EXPOSED_HEADERS =
	"X-Upload-Offset, X-Upload-Handler, X-Original-Size, X-Upload-Status, Content-Disposition, Content-Length, X-Download-Id, X-File-Size, X-File-Sha256";

/** Content types whose bodies are produced over time and must reach the client chunk by chunk. */
const STREAM_TYPES = new Set(["application/x-ndjson", "text/event-stream"]);

/**
 * Parses a body size: a byte count or a string such as `"100b"`, `"512kb"`, `"1mb"`, `"1gb"` (1024-based, the
 * units Express' body parsers accept).
 * @throws when the string is not a size, so a typo fails at startup instead of on the first large call.
 */
export function parseByteSize(size: string | number): number {
	if (typeof size === "number" && Number.isFinite(size) && size >= 0) return Math.floor(size);
	const match = typeof size === "string" ? /^\s*(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?\s*$/i.exec(size) : null;
	if (!match) throw new Error(`jsonSizeLimit: ${JSON.stringify(size)} is not a size such as "1mb" or 1048576`);
	const unit = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 }[(match[2] ?? "b").toLowerCase() as "b"];
	return Math.floor(Number(match[1]) * unit);
}

/** An HTTP error while reading a request body: 400 unreadable, 413 too large, 415 unknown encoding. */
class BodyError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

/**
 * Reads a call body as UTF-8 text, inflating `gzip` and `deflate`, and stops at `limit` decompressed bytes.
 *
 * Why the server reads bodies itself instead of a framework body parser: each framework brings its own parser with
 * its own size syntax, inflation and errors, and reading here gives every provider the same behavior. Why the limit counts decompressed bytes: a small gzip body can inflate to gigabytes. On 413 the reader is
 * released, not cancelled: cancelling a `node:http` body stream destroys the request and its socket before the 413
 * is written; the bridge discards the rest after answering instead.
 */
async function readText(request: Request, limit: number): Promise<string> {
	if (!request.body) return "";
	const encoding = (request.headers.get("content-encoding") ?? "identity").toLowerCase();
	let body: ReadableStream<Uint8Array> = request.body;
	// The cast: lib.dom types DecompressionStream's input as BufferSource, which Uint8Array streams satisfy at runtime.
	const inflate = (format: "gzip" | "deflate") => new DecompressionStream(format) as unknown as ReadableWritablePair<Uint8Array, Uint8Array>;
	if (encoding === "gzip" || encoding === "x-gzip") body = body.pipeThrough(inflate("gzip"));
	else if (encoding === "deflate") body = body.pipeThrough(inflate("deflate"));
	else if (encoding !== "identity") throw new BodyError(415, `unsupported content encoding "${encoding}"`);

	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > limit) {
				reader.releaseLock();
				throw new BodyError(413, `request body exceeds jsonSizeLimit (${limit} bytes)`);
			}
			chunks.push(value);
		}
	} catch (error) {
		if (error instanceof BodyError) throw error;
		throw new BodyError(400, `unreadable request body: ${errorMessage(error)}`);
	}
	return Buffer.concat(chunks).toString("utf8");
}

/**
 * Gzips a stream with a sync flush after every chunk, so every NDJSON frame is decodable on arrival.
 *
 * Why not `CompressionStream`: it emits output only when its internal buffer fills, so frames of a slow generator
 * would wait. Pull-based like the source: the next frame is read only when the client reads, and cancelling the
 * result cancels the source, which stops its generator.
 */
function gzipFrames(source: ReadableStream<Uint8Array>, level: number): ReadableStream<Uint8Array> {
	const gzip = createGzip({ level });
	const reader = source.getReader();
	let ended: Promise<void> | null = null;
	return new ReadableStream<Uint8Array>({
		start(controller) {
			gzip.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
			gzip.on("error", (error) => controller.error(error));
		},
		async pull(controller) {
			if (ended) return ended;
			const { done, value } = await reader.read();
			if (done) {
				ended = new Promise<void>((resolve) => gzip.once("end", resolve)).then(() => controller.close());
				gzip.end();
				return ended;
			}
			gzip.write(value);
			await new Promise<void>((resolve) => gzip.flush(zlibConstants.Z_SYNC_FLUSH, () => resolve()));
		},
		cancel(reason) {
			gzip.destroy();
			return reader.cancel(reason);
		},
	});
}

/** True for the routes {@link rpcRoute} serves, relative to `basePath`. */
function isRpcRoute(method: string, rest: string): boolean {
	if (rest === "/rpc" || rest === "/rpc/schema") return true;
	if (method === "POST") return rest === "/rpc/upload";
	if (method === "HEAD") return /^\/rpc\/upload\/[^/]+$/.test(rest);
	if (method === "GET") return rest === "/rpc/download" || /^\/rpc\/upload\/progress\/[^/]+$/.test(rest);
	return false;
}

/** A JSON answer with its length, for health checks and errors. */
function jsonResponse(status: number, body: unknown, headers: Headers): Response {
	const text = JSON.stringify(body);
	headers.set("Content-Type", "application/json");
	headers.set("Content-Length", String(Buffer.byteLength(text)));
	return new Response(text, { status, headers });
}

/** Creates the core for one server; `ExpressRpcServer` hands it to its provider. */
export function createRpcHttpCore(options: RpcHttpCoreOptions): RpcHttpCore {
	const { basePath, jsonSizeLimit, corsOrigin, compression } = options;

	const corsHeaders = (origin: string | null | undefined, requestedHeaders?: string | null): [string, string][] => {
		const headers: [string, string][] = [];
		const allowed = !Array.isArray(corsOrigin) ? corsOrigin : origin && corsOrigin.includes(origin) ? origin : null;
		if (allowed) headers.push(["Access-Control-Allow-Origin", allowed]);
		if (Array.isArray(corsOrigin)) headers.push(["Vary", "Origin"]);
		headers.push(
			["Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS, HEAD"],
			["Access-Control-Allow-Headers", requestedHeaders || ALLOWED_HEADERS],
			["Access-Control-Expose-Headers", EXPOSED_HEADERS],
		);
		return headers;
	};

	const match = (method: string, pathname: string): boolean => {
		if (method === "OPTIONS") return true;
		const path = pathname.replace(/(.)\/+$/, "$1");
		if (!path.startsWith(basePath)) return false;
		const rest = path.slice(basePath.length);
		return (rest === "/health" && (method === "GET" || method === "POST")) || isRpcRoute(method, rest);
	};

	/** The request rpcRoute sees: uploads as they are, calls with their body read (or dropped), see `handle`. */
	const forward = async (request: Request, rest: string): Promise<Request> => {
		if (request.method === "POST" && rest === "/rpc/upload") return request;
		const headers = new Headers(request.headers);
		let body: string | undefined;
		const type = headers.get("content-type")?.split(";")[0].trim().toLowerCase();
		if (request.method !== "GET" && request.method !== "HEAD" && type === "application/json") {
			body = (await readText(request, jsonSizeLimit)) || undefined;
		}
		// The body was inflated here (or dropped), so its original encoding and length must not reach rpcRoute.
		headers.delete("content-encoding");
		headers.delete("content-length");
		return new Request(request.url, { method: request.method, headers, body });
	};

	/** Compresses what is worth it: NDJSON streams frame by frame, buffered JSON above 1 KiB. */
	const encode = async (response: Response, request: Request, headers: Headers): Promise<Response> => {
		const type = response.headers.get("content-type") || "application/json";
		const gzip = compression.enabled && (request.headers.get("accept-encoding") ?? "").includes("gzip");
		if (!response.body || request.method === "HEAD") return new Response(null, { status: response.status, headers });
		if (STREAM_TYPES.has(type) || !type.startsWith("application/json")) {
			if (!gzip || type !== "application/x-ndjson") return new Response(response.body, { status: response.status, headers });
			headers.set("Content-Encoding", "gzip");
			headers.append("Vary", "Accept-Encoding");
			return new Response(gzipFrames(response.body, compression.level), { status: response.status, headers });
		}
		const text = await response.text();
		if (gzip && text.length > 1024) {
			const compressed = gzipSync(text, { level: compression.level });
			headers.set("Content-Encoding", "gzip");
			headers.append("Vary", "Accept-Encoding");
			headers.set("Content-Length", String(compressed.byteLength));
			return new Response(compressed, { status: response.status, headers });
		}
		headers.set("Content-Length", String(Buffer.byteLength(text)));
		return new Response(text, { status: response.status, headers });
	};

	/**
	 * Answers a request that {@link match} accepted.
	 *
	 * Calls run only with `Content-Type: application/json`; other bodies are dropped and rpcRoute answers 400. Why:
	 * a cross-origin page can send `text/plain` or form bodies without a CORS preflight, so a call the server runs
	 * must carry a content type that requires one.
	 */
	const handle = async (request: Request): Promise<Response> => {
		const headers = new Headers(corsHeaders(request.headers.get("origin"), request.headers.get("access-control-request-headers")));
		if (request.method === "OPTIONS") return new Response(null, { status: 200, headers });
		const url = new URL(request.url);
		const rest = url.pathname.replace(/(.)\/+$/, "$1").slice(basePath.length);
		if (rest === "/health") return jsonResponse(200, { status: "ok", timestamp: new Date().toISOString() }, headers);
		try {
			const response = await rpcRoute({ request: await forward(request, rest) });
			for (const [key, value] of response.headers) {
				if (key !== "content-length" || !response.headers.get("content-type")?.startsWith("application/json")) headers.append(key, value);
			}
			return await encode(response, request, headers);
		} catch (error) {
			if (error instanceof BodyError) return jsonResponse(error.status, { error: error.message }, headers);
			log("ERROR", "request failed", { method: request.method, url: url.pathname, error: errorMessage(error) });
			return jsonResponse(500, { error: "Internal server error", message: errorMessage(error) }, headers);
		}
	};

	return { match, handle, corsHeaders, isStream: (response) => STREAM_TYPES.has(response.headers.get("content-type") ?? "") };
}
