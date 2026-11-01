/**
 * The RPC server core: a namespace registry and one Fetch API handler, {@link rpcRoute}, for every endpoint.
 *
 * Why one `Request → Response` function instead of a framework middleware: the same handler then runs unchanged in
 * Astro API routes, `Bun.serve`, `ExpressRpcServer` (on any provider) and tests, and an adapter only has to
 * translate requests. The registries are module state, because an RPC server is one per process and handlers
 * are registered from side-effect imports long before a request arrives.
 * VERIFIED: scripts/e2e.mjs serves the same demo API through `Bun.serve` and `ExpressRpcServer` on both providers.
 */
import { DSON } from "defuss-dson";
import type {
	ApiNamespace,
	DownloadFileMeta,
	DownloadHandlerEntry,
	DownloadHandlerFn,
	DownloadMeta,
	DownloadStreamHandlerFn,
	DsonStreamFrame,
	RpcApiClass,
	RpcApiEntry,
	RpcApiModule,
	RpcCallDescriptor,
	RpcMethodDescriptor,
	RpcRoute,
	RpcSchemaEntry,
	ServerHook,
	UploadHandlerEntry,
	UploadHandlerFn,
	UploadMeta,
	UploadStreamFrame,
	UploadStreamHandlerFn,
} from "./types.d.js";
import {
	addUploadListener,
	cleanupSession,
	clearAllSessions,
	createSession,
	emitUploadEvent,
	ensureUploadDir,
	fileChunks,
	getSession,
	getTempFileSize,
	updateSession,
	type UploadEvent,
} from "./upload-state.js";
import { errorMessage, log } from "./log.js";

// re-export for type / code safety
export * from "./types.d.js";
export { getUploadDir, setUploadDir } from "./upload-state.js";

/** Base path of the RPC dispatch endpoint. */
export const RPC_PATH = "/rpc" as const;

/** Base path of the RPC schema-discovery endpoint. */
export const RPC_SCHEMA_PATH = "/rpc/schema" as const;

/** Base path of the upload endpoint. */
export const RPC_UPLOAD_PATH = "/rpc/upload" as const;

/** Prefix for SSE upload-progress endpoint: `/rpc/upload/progress/{uploadId}`. */
export const RPC_UPLOAD_PROGRESS_PATH = "/rpc/upload/progress/" as const;

/** Base path of the download endpoint. */
export const RPC_DOWNLOAD_PATH = "/rpc/download" as const;

/** How long the progress stream waits for an upload whose POST has not arrived yet. */
const SESSION_WAIT_MS = 10_000;

/**
 * The registries: namespaces, upload and download handlers, hooks. They live on `globalThis` under a registry
 * symbol because one process can load this module more than once (the ESM and CommonJS builds, a bundler's copy
 * in an SSR build), and a handler registered through one copy must be served by every other.
 */
const registry = ((globalThis as Record<symbol, unknown>)[Symbol.for("defuss-rpc.server")] ??= {
	entries: new Map(),
	uploadHandlers: new Map(),
	downloadHandlers: new Map(),
	hooks: [],
}) as {
	entries: Map<string, RpcApiEntry>;
	uploadHandlers: Map<string, UploadHandlerEntry>;
	downloadHandlers: Map<string, DownloadHandlerEntry>;
	hooks: ServerHook[];
};
const { entries: rpcApiEntries, uploadHandlers, downloadHandlers, hooks } = registry;

/**
 * Names that are never RPC methods even though every object has them.
 * Why: without this list a client could call `constructor`, `__proto__` or `Object.prototype` helpers such as
 * `hasOwnProperty` on any namespace, none of which the API author exposed.
 */
const RESERVED_NAMES = new Set(["constructor", "__proto__", "prototype"]);

const json = (status: number, body: unknown): Response =>
	new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const percentOf = (bytes: number, total: number): number =>
	total > 0 ? Math.min(100, Math.round((bytes / total) * 100)) : 0;

/**
 * Parses an RPC call body. DSON first (the current client), plain JSON second, so clients older than the DSON
 * transport still reach this server. Returns `null` for anything that is not `{ className, methodName, args[] }`.
 */
function parseRpcCallDescriptor(serialized: string): RpcCallDescriptor | null {
	let value: unknown;
	try {
		value = DSON.parse(serialized);
	} catch {
		try {
			value = JSON.parse(serialized);
		} catch {
			return null;
		}
	}
	const call = value as Partial<RpcCallDescriptor> | null;
	if (!call || typeof call.className !== "string" || typeof call.methodName !== "string" || !Array.isArray(call.args)) {
		return null;
	}
	return call as RpcCallDescriptor;
}

/** True when the entry is a class constructor (instantiated per call), false for a plain-object module. */
function isRpcClass(entry: RpcApiEntry): entry is RpcApiClass {
	return typeof entry === "function" && !!entry.prototype;
}

/**
 * Classifies a function by its constructor name: `AsyncFunction`, `GeneratorFunction` or `AsyncGeneratorFunction`.
 * The schema and the dispatcher both use it, so a method streams exactly when the client expects a stream.
 */
function describeFn(fn: Function): RpcMethodDescriptor {
	const ctorName = fn.constructor?.name ?? "";
	return {
		async: ctorName === "AsyncFunction" || ctorName === "AsyncGeneratorFunction",
		generator: ctorName === "GeneratorFunction" || ctorName === "AsyncGeneratorFunction",
	};
}

/** True when `name` may be called on an object whose property `name` holds `fn`. */
function isCallableMember(name: string, fn: unknown): fn is Function {
	return (
		typeof fn === "function" &&
		!RESERVED_NAMES.has(name) &&
		fn !== (Object.prototype as unknown as Record<string, unknown>)[name]
	);
}

/**
 * Streams a generator as NDJSON: one DSON frame per `yield`, then a `return` frame, or an `error` frame when the
 * generator throws.
 *
 * Why `pull` with manual `next()` calls instead of `for await`: `for await` drops the generator's return value, and
 * pulling produces a frame only when the consumer reads, so a slow client slows the generator instead of filling
 * memory. `cancel` calls `return()`, so the generator's `finally` blocks run when the client stops reading.
 */
function streamGeneratorResponse(iter: AsyncIterator<unknown> | Iterator<unknown>): Response {
	const encoder = new TextEncoder();
	const send = (controller: ReadableStreamDefaultController<Uint8Array>, frame: DsonStreamFrame) =>
		controller.enqueue(encoder.encode(`${DSON.stringify(frame)}\n`));
	const stream = new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const { done, value } = await iter.next();
				if (done) {
					send(controller, { type: "return", value: value ?? null });
					controller.close();
				} else {
					send(controller, { type: "yield", value });
				}
			} catch (error: unknown) {
				send(controller, {
					type: "error",
					error: { message: errorMessage(error), stack: error instanceof Error ? error.stack : undefined },
				});
				controller.close();
			}
		},
		async cancel() {
			await iter.return?.();
		},
	});

	return new Response(stream, { headers: { "Content-Type": "application/x-ndjson" } });
}

/**
 * Restricts client-chosen IDs to `[a-zA-Z0-9._-]{1,128}`. The upload ID becomes a file name in the upload
 * directory, so this is the path-traversal guard.
 */
function sanitizeUploadId(raw: string): string {
	const sanitized = raw.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 128);
	return sanitized || "invalid";
}

/**
 * The `Content-Disposition` value for a download: an ASCII `filename` for old clients plus the RFC 6266
 * `filename*` with the UTF-8 name.
 * Why both: a header value must be ASCII-safe (a non-Latin-1 name throws in `new Headers()`), and `"`, `\`, CR or LF
 * in a plain `filename="…"` would break or inject header syntax.
 */
function contentDisposition(filename: string): string {
	const ascii = filename.replace(/[^\x20-\x7e]|["\\]/g, "_");
	return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/** Decodes a percent-encoded header value; a value that is not valid percent-encoding (an older client) stays as is. */
function decodeHeader(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

async function runGuards(className: string, methodName: string, args: unknown[], request: Request) {
	for (const hook of hooks) {
		// Only an explicit `false` blocks; `void`/`undefined` lets the call through.
		if (hook.phase === "guard" && (await hook.fn(className, methodName, args, request)) === false) return false;
	}
	return true;
}

async function runResultHooks(className: string, methodName: string, args: unknown[], request: Request, result: unknown) {
	for (const hook of hooks) {
		if (hook.phase === "result") await hook.fn(className, methodName, args, request, result);
	}
}

/**
 * Handles `POST /rpc/upload`.
 *
 * The body is written chunk by chunk to the session's temp file (appended on resume) while SHA-256 is computed
 * and progress is published to the SSE stream. Only after the body is complete does the handler run: a buffered
 * handler gets the bytes, a streaming handler a chunked stream read from the temp file, so its memory stays at one
 * chunk regardless of the upload size. The response is NDJSON: a `received` frame with size and hash, then a
 * `result` frame (status 201) or an `error` frame when the handler threw (status 200, temp file kept for a retry).
 */
async function handleUploadPost(request: Request): Promise<Response> {
	const { createHash } = await import("node:crypto");
	const { open, readFile } = await import("node:fs/promises");
	const startedAt = performance.now();

	const handlerName = request.headers.get("x-upload-handler") || "";
	const uploadId = sanitizeUploadId(request.headers.get("x-upload-id") || crypto.randomUUID());
	const originalSize = Number.parseInt(request.headers.get("x-original-size") || "0", 10) || 0;
	const offset = Number.parseInt(request.headers.get("x-upload-offset") || "0", 10) || 0;
	const contentEncoding = request.headers.get("content-encoding") || "identity";
	const originalFilename = decodeHeader(request.headers.get("x-original-filename") || "");

	const handlerEntry = uploadHandlers.get(handlerName);
	if (!handlerEntry) return json(404, { error: `Upload handler "${handlerName}" not found` });
	if (!(await runGuards("__upload__", handlerName, [originalSize], request))) {
		return json(403, { error: "Forbidden by hook" });
	}

	// A resume needs a session whose file holds exactly `offset` bytes; anything else would corrupt the file.
	const isResume = offset > 0;
	if (isResume) {
		if (!getSession(uploadId)) return json(404, { error: `No session found for uploadId "${uploadId}" to resume` });
		const fileSize = await getTempFileSize(uploadId);
		if (fileSize !== offset) {
			return json(409, { error: `Offset mismatch: client claims ${offset}, server has ${fileSize} bytes` });
		}
		updateSession(uploadId, { status: "uploading" });
	}
	await ensureUploadDir();
	const session = isResume ? getSession(uploadId)! : createSession(uploadId, handlerName, originalSize);

	let body: ReadableStream<Uint8Array> = request.body ?? new ReadableStream({ start: (c) => c.close() });
	if (contentEncoding === "gzip" || contentEncoding === "deflate") {
		body = body.pipeThrough(
			new DecompressionStream(contentEncoding) as unknown as ReadableWritablePair<Uint8Array, Uint8Array>,
		);
	}

	let bytesReceived = offset;
	let sha256Hex: string;
	try {
		// An awaited FileHandle write per chunk: a disk error rejects here instead of surfacing as an unhandled
		// stream 'error' event, and the next chunk is read only after the previous one is on disk (backpressure).
		const file = await open(session.tempFilePath, isResume ? "a" : "w");
		const hash = createHash("sha256");
		try {
			for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
				for (let written = 0; written < chunk.byteLength; ) {
					written += (await file.write(chunk, written)).bytesWritten;
				}
				if (!isResume) hash.update(chunk);
				bytesReceived += chunk.byteLength;
				updateSession(uploadId, { bytesReceived });
				emitUploadEvent(uploadId, {
					type: "progress",
					bytesReceived,
					totalBytes: originalSize,
					percent: percentOf(bytesReceived, originalSize),
				});
			}
		} finally {
			await file.close();
		}
		if (isResume) {
			// The hash covers the whole file, so the bytes stored by the earlier requests are read back.
			for await (const chunk of fileChunks(session.tempFilePath) as unknown as AsyncIterable<Uint8Array>) {
				hash.update(chunk);
			}
		}
		sha256Hex = hash.digest("hex");
	} catch (error: unknown) {
		updateSession(uploadId, { status: "error" });
		emitUploadEvent(uploadId, { type: "error", error: errorMessage(error) });
		log("ERROR", "upload failed", { handler: handlerName, uploadId, error: errorMessage(error) });
		return json(500, { error: errorMessage(error) || "Unknown upload failure" });
	}

	const durationMs = Math.round((performance.now() - startedAt) * 100) / 100;
	const meta: UploadMeta = {
		uploadId,
		handlerName,
		originalSize,
		bytesReceived,
		sha256: sha256Hex,
		durationMs,
		contentEncoding,
		offset,
		originalFilename,
	};
	const receivedFrame: UploadStreamFrame = { type: "received", uploadId, bytesReceived, sha256: sha256Hex, durationMs };

	let handlerResult: unknown;
	try {
		if (handlerEntry.mode === "buffered") {
			const data = await readFile(session.tempFilePath);
			handlerResult = await (handlerEntry.fn as UploadHandlerFn<unknown>)(
				new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
				meta,
			);
		} else {
			handlerResult = await (handlerEntry.fn as UploadStreamHandlerFn<unknown>)(fileChunks(session.tempFilePath), meta);
		}
	} catch (handlerError: unknown) {
		updateSession(uploadId, { status: "error" });
		emitUploadEvent(uploadId, { type: "error", error: errorMessage(handlerError) });
		log("ERROR", "upload handler threw", { handler: handlerName, uploadId, error: errorMessage(handlerError) });
		// Result hooks run on handler errors too (with `undefined`), so an audit hook sees every finished upload.
		await runResultHooks("__upload__", handlerName, [originalSize], request, undefined);
		const errorFrame: UploadStreamFrame = {
			type: "error",
			error: {
				message: errorMessage(handlerError),
				stack: handlerError instanceof Error ? handlerError.stack : undefined,
			},
		};
		return new Response(`${DSON.stringify(receivedFrame)}\n${DSON.stringify(errorFrame)}\n`, {
			status: 200,
			headers: { "Content-Type": "application/x-ndjson" },
		});
	}

	updateSession(uploadId, { bytesReceived, status: "complete" });
	emitUploadEvent(uploadId, { type: "complete", bytesReceived, totalBytes: originalSize, percent: 100 });
	await runResultHooks("__upload__", handlerName, [originalSize], request, handlerResult);
	const resultFrame: UploadStreamFrame = { type: "result", value: handlerResult };
	await cleanupSession(uploadId);
	return new Response(`${DSON.stringify(receivedFrame)}\n${DSON.stringify(resultFrame)}\n`, {
		status: 201,
		headers: { "Content-Type": "application/x-ndjson" },
	});
}

/**
 * Handles `GET /rpc/upload/progress/{uploadId}`: Server-Sent Events with `progress`, then `complete` or `error`.
 *
 * Why it subscribes before the session exists: a client opens this stream before it sends the upload, so the
 * request usually arrives before the POST created the session, and a small upload can finish in less time than any
 * polling interval. The listener therefore receives every event the POST emits from its first chunk on. A stream
 * that saw neither a session nor an event within {@link SESSION_WAIT_MS} reports `Unknown upload`.
 */
function handleUploadProgress(uploadId: string): Response {
	const encoder = new TextEncoder();
	let unsubscribe = () => {};
	let timer: ReturnType<typeof setTimeout> | undefined;
	const stop = () => {
		clearTimeout(timer);
		unsubscribe();
	};

	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			const send = (event: UploadEvent) => {
				controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
				if (event.type !== "progress") {
					stop();
					controller.close();
				}
			};
			const session = getSession(uploadId);
			if (session?.status === "complete") {
				return send({ type: "complete", bytesReceived: session.bytesReceived, totalBytes: session.originalSize, percent: 100 });
			}
			if (session?.status === "error") return send({ type: "error", error: "Upload failed" });
			unsubscribe = addUploadListener(uploadId, (event) => {
				clearTimeout(timer);
				send(event);
			});
			if (session && session.bytesReceived > 0) {
				send({
					type: "progress",
					bytesReceived: session.bytesReceived,
					totalBytes: session.originalSize,
					percent: percentOf(session.bytesReceived, session.originalSize),
				});
			}
			if (!session) {
				timer = setTimeout(() => {
					if (!getSession(uploadId)) send({ type: "error", error: "Unknown upload" });
				}, SESSION_WAIT_MS);
			}
		},
		cancel: stop,
	});

	return new Response(stream, {
		headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
	});
}

/**
 * Handles `GET /rpc/download?handler=…&downloadId=…`. The handler's `fileMeta` becomes `Content-Type`,
 * `Content-Length`, `Content-Disposition`, `Last-Modified` and `X-File-Sha256`; a `Range: bytes=a-b` header is
 * parsed into `rangeStart`/`rangeEnd` and left to the handler to honor.
 */
async function handleDownload(url: URL, request: Request): Promise<Response> {
	const handlerName = url.searchParams.get("handler") || "";
	const downloadId = url.searchParams.get("downloadId") || crypto.randomUUID();
	const handlerEntry = downloadHandlers.get(handlerName);
	if (!handlerEntry) return json(404, { error: `Download handler "${handlerName}" not found` });
	if (!(await runGuards("__download__", handlerName, [downloadId], request))) {
		return json(403, { error: "Forbidden by hook" });
	}

	const range = request.headers.get("range")?.match(/bytes=(\d+)-(\d*)/);
	const downloadMeta: DownloadMeta = {
		downloadId,
		handlerName,
		rangeStart: range ? Number.parseInt(range[1], 10) : 0,
		rangeEnd: range?.[2] ? Number.parseInt(range[2], 10) : undefined,
	};

	try {
		let stream: ReadableStream<Uint8Array>;
		let fileMeta: DownloadFileMeta;
		if (handlerEntry.mode === "buffered") {
			const result = await (handlerEntry.fn as DownloadHandlerFn<unknown>)(downloadMeta);
			const data = result instanceof Uint8Array ? result : result.data;
			fileMeta = result instanceof Uint8Array
				? { size: data.byteLength, contentType: "application/octet-stream" }
				: result.fileMeta;
			stream = new ReadableStream({
				start(controller) {
					controller.enqueue(data);
					controller.close();
				},
			});
		} else {
			({ stream, fileMeta } = await (handlerEntry.fn as DownloadStreamHandlerFn<unknown>)(downloadMeta));
		}

		const headers: Record<string, string> = {
			"Content-Type": fileMeta.contentType || "application/octet-stream",
			"Content-Length": String(fileMeta.size),
			"X-Download-Id": downloadId,
			"X-File-Size": String(fileMeta.size),
		};
		if (fileMeta.sha256) headers["X-File-Sha256"] = fileMeta.sha256;
		if (fileMeta.filename) headers["Content-Disposition"] = contentDisposition(fileMeta.filename);
		if (fileMeta.lastModified) headers["Last-Modified"] = new Date(fileMeta.lastModified).toUTCString();
		return new Response(stream, { status: 200, headers });
	} catch (error: unknown) {
		log("ERROR", "download handler threw", { handler: handlerName, downloadId, error: errorMessage(error) });
		return json(500, { error: errorMessage(error) || "Download failed" });
	}
}

/**
 * Adds a server hook. Guards run before every call, upload and download, in the order they were added; the first
 * one that returns `false` rejects with HTTP 403. Result hooks run after a successful call, before the response is
 * written; they do not run for generator methods, whose values are streamed, and they run with `undefined` after an
 * upload handler threw.
 *
 * For uploads `className` is `"__upload__"` and `args` is `[originalSize]`; for downloads `"__download__"` and
 * `[downloadId]`.
 */
export function addHook(hook: ServerHook) {
	hooks.push(hook);
}

/** Characters allowed in upload and download handler names; they appear in headers and query strings. */
const HANDLER_NAME_RE = /^[a-zA-Z0-9._-]{1,128}$/;

function assertHandlerName(kind: "upload" | "download", name: string) {
	if (!HANDLER_NAME_RE.test(name)) {
		throw new Error(`Invalid ${kind} handler name "${name}": must match ${HANDLER_NAME_RE}`);
	}
}

/**
 * Registers a **buffered** upload handler: it receives the complete upload as one `Uint8Array`.
 *
 * Use it when the handler needs all bytes at once (parsing an archive, an image) and uploads fit in memory; for
 * anything larger use {@link addStreamingUploadHandler}. Registering a name again replaces the handler.
 *
 * @param name    - Handler name the client passes to `upload()`: letters, digits, `.`, `_`, `-`; max 128 chars.
 * @param handler - Called with `(data, meta)` after the body was received and hashed; its return value is
 *                  DSON-serialized into the `result` frame.
 *
 * @example
 * ```ts
 * addUploadHandler("avatar", async (data, meta) => {
 *   await writeFile(`avatars/${meta.uploadId}.png`, data);
 *   return { bytes: data.byteLength, sha256: meta.sha256 };
 * });
 * ```
 */
export function addUploadHandler<T = unknown>(name: string, handler: UploadHandlerFn<T>): void {
	assertHandlerName("upload", name);
	uploadHandlers.set(name, { fn: handler as UploadHandlerFn<unknown>, mode: "buffered" });
}

/**
 * Registers a **streaming** upload handler: it receives a `ReadableStream<Uint8Array>` of the upload.
 *
 * The stream reads the verified temp file in 256 KiB chunks, so the handler's memory stays bounded however large
 * the upload is. It starts after the last byte arrived (`meta.sha256` is final) and always begins at byte 0, also
 * for resumed uploads.
 *
 * @param name    - Handler name, same rules as {@link addUploadHandler}.
 * @param handler - Called with `(stream, meta)`; its return value becomes the `result` frame.
 *
 * @example
 * ```ts
 * addStreamingUploadHandler("ingest", async (stream, meta) => {
 *   let bytes = 0;
 *   for await (const chunk of stream) bytes += chunk.byteLength;
 *   return { bytes };
 * });
 * ```
 */
export function addStreamingUploadHandler<T = unknown>(name: string, handler: UploadStreamHandlerFn<T>): void {
	assertHandlerName("upload", name);
	uploadHandlers.set(name, { fn: handler as UploadStreamHandlerFn<unknown>, mode: "streaming" });
}

/** Removes every upload handler. For test isolation. */
export function clearUploadHandlers(): void {
	uploadHandlers.clear();
}

/**
 * Registers a **buffered** download handler: it returns the whole file as a `Uint8Array`, or `{ data, fileMeta }`
 * to set the content type, file name, hash and modification time.
 *
 * @param name    - Handler name the client passes to `download()`; same rules as upload handlers.
 * @param handler - Called with `(meta)` per request; `meta.downloadId` is the client's ID (e.g. a file ID).
 *
 * @example
 * ```ts
 * addDownloadHandler("report", async ({ downloadId }) => {
 *   const data = new TextEncoder().encode(`report ${downloadId}`);
 *   return { data, fileMeta: { size: data.byteLength, contentType: "text/plain", filename: "report.txt" } };
 * });
 * ```
 */
export function addDownloadHandler<T = unknown>(name: string, handler: DownloadHandlerFn<T>): void {
	assertHandlerName("download", name);
	downloadHandlers.set(name, { fn: handler as DownloadHandlerFn<unknown>, mode: "buffered" });
}

/**
 * Registers a **streaming** download handler: it returns `{ stream, fileMeta }`, and the stream is piped to the
 * client as it is read, so a large file is never held in memory. `fileMeta.size` becomes `Content-Length` and must
 * be exact.
 *
 * @example
 * ```ts
 * addStreamingDownloadHandler("video", async () => {
 *   const file = await openAsBlob("video.mp4"); // node:fs
 *   return { stream: file.stream(), fileMeta: { size: file.size, contentType: "video/mp4", filename: "video.mp4" } };
 * });
 * ```
 */
export function addStreamingDownloadHandler<T = unknown>(name: string, handler: DownloadStreamHandlerFn<T>): void {
	assertHandlerName("download", name);
	downloadHandlers.set(name, { fn: handler as DownloadStreamHandlerFn<unknown>, mode: "streaming" });
}

/** Removes every download handler. For test isolation. */
export function clearDownloadHandlers(): void {
	downloadHandlers.clear();
}

/**
 * Registers the API namespaces: each key becomes the name the client calls (`rpc.<key>`), each value is a class
 * (a fresh instance per call) or a plain object of functions (shared).
 *
 * **First registration wins**: while the registry holds entries, further calls are ignored. Why: module code that
 * registers the API may run again (hot reload, a second import path of the same file), and silently mixing two
 * versions of an API would be worse than keeping the first. Pass `{}` to empty the registry, then register again;
 * {@link clearRpcServer} also removes hooks and handlers.
 *
 * @param ns - Map of namespace name => class constructor or plain-object module.
 *
 * @example
 * createRpcServer({ UserApi, OrderApi, MathUtils });
 */
export function createRpcServer(ns: ApiNamespace) {
	if (Object.keys(ns).length === 0) {
		rpcApiEntries.clear();
		return;
	}
	if (rpcApiEntries.size > 0) return;
	for (const [name, entry] of Object.entries(ns)) {
		rpcApiEntries.set(name, entry);
	}
}

/**
 * Empties the namespace registry, the hooks, the upload and download handlers, and deletes the temp files of all
 * upload sessions. For test isolation: every test starts from an empty server.
 */
export async function clearRpcServer() {
	rpcApiEntries.clear();
	hooks.length = 0;
	uploadHandlers.clear();
	downloadHandlers.clear();
	await clearAllSessions();
}

/** The `/rpc/schema` body: one descriptor per registered namespace. */
function buildSchema(): RpcSchemaEntry[] {
	const schemaEntries: RpcSchemaEntry[] = [];
	for (const [name, entry] of rpcApiEntries) {
		if (isRpcClass(entry)) {
			const desc = describeInstance(entry.prototype) as {
				methods: Record<string, RpcMethodDescriptor>;
				properties: Record<string, unknown>;
			};
			schemaEntries.push({ kind: "class", className: name, methods: desc.methods, properties: desc.properties });
		} else {
			schemaEntries.push(describeModule(name, entry));
		}
	}
	return schemaEntries;
}

/** Dispatches one RPC call body to its namespace entry. */
async function handleCall(request: Request): Promise<Response> {
	const call = parseRpcCallDescriptor(await request.text());
	if (!call) {
		return json(400, { error: "Invalid RPC call: expected { className, methodName, args: [] } as DSON or JSON" });
	}
	const { className, methodName, args } = call;

	if (!(await runGuards(className, methodName, args, request))) return json(403, { error: "Forbidden by hook" });

	const entry = rpcApiEntries.get(className);
	if (!entry) return json(404, { error: `Namespace ${className} not found` });

	const isClass = isRpcClass(entry);
	const target = isClass ? (new entry() as Record<string, unknown>) : (entry as Record<string, unknown>);
	const fn = target[methodName];
	if (!isCallableMember(methodName, fn)) {
		return json(404, {
			error: isClass
				? `Method ${methodName} not found on class ${className}`
				: `Function ${methodName} not found on module ${className}`,
		});
	}

	let result: unknown;
	try {
		result = fn.apply(target, args);
		if (describeFn(fn).generator) {
			const iterable = result as AsyncIterable<unknown> & Iterable<unknown>;
			return streamGeneratorResponse(
				typeof iterable[Symbol.asyncIterator] === "function"
					? iterable[Symbol.asyncIterator]()
					: iterable[Symbol.iterator](),
			);
		}
		result = await result;
	} catch (error: unknown) {
		const what = isClass ? "method" : "function";
		log("ERROR", `rpc ${what} threw`, { namespace: className, method: methodName, error: errorMessage(error) });
		return json(500, { error: `Error calling ${what} ${methodName}: ${errorMessage(error)}` });
	}

	await runResultHooks(className, methodName, args, request, result);
	return new Response(DSON.stringify(result), { headers: { "Content-Type": "application/json" } });
}

/**
 * The defuss-rpc request handler: a Fetch API function `({ request }) => Promise<Response>`.
 *
 * Mount it where your runtime hands you a `Request`: an Astro route (`export const ALL = rpcRoute` in
 * `src/pages/rpc/[...all].ts`), `Bun.serve({ fetch: (request) => rpcRoute({ request }) })`, or `ExpressRpcServer`,
 * which adds CORS, limits and gzip on the framework of its provider. Routing looks at the end of the path, so any
 * prefix (`/api/v1/rpc`) works.
 *
 * | Method | Path                          | Response                                                    |
 * |--------|-------------------------------|-------------------------------------------------------------|
 * | any    | `…/rpc/schema`                | JSON schema of all registered namespaces                    |
 * | POST   | `…/rpc`                       | DSON result, or NDJSON frames for generator methods         |
 * | POST   | `…/rpc/upload`                | NDJSON `received` + `result`/`error` frames                 |
 * | HEAD   | `…/rpc/upload/{uploadId}`     | `X-Upload-Offset` etc. for resuming                         |
 * | GET    | `…/rpc/upload/progress/{id}`  | Server-Sent Events with upload progress                     |
 * | GET    | `…/rpc/download?handler=&downloadId=` | the file, with metadata headers                     |
 *
 * **Call body** (`POST /rpc`): DSON (or plain JSON) `{ className, methodName, args }`.
 *
 * **Status codes**: `400` malformed call body, `403` a guard returned `false`, `404` unknown namespace, method or
 * handler, `409` resume offset mismatch, `500` the method or handler threw (the message is in `error`).
 */
export const rpcRoute: RpcRoute = async ({ request }) => {
	const url = new URL(request.url);
	// Normalize trailing slashes so "/rpc/schema/" and "/rpc/schema" resolve identically.
	const pathname = url.pathname.replace(/\/+$/, "");

	if (pathname.endsWith(RPC_SCHEMA_PATH)) return json(200, buildSchema());

	if (request.method === "GET" && pathname.includes(RPC_UPLOAD_PROGRESS_PATH)) {
		const start = pathname.lastIndexOf(RPC_UPLOAD_PROGRESS_PATH) + RPC_UPLOAD_PROGRESS_PATH.length;
		return handleUploadProgress(sanitizeUploadId(pathname.slice(start)));
	}

	if (request.method === "HEAD" && pathname.includes(`${RPC_UPLOAD_PATH}/`)) {
		const start = pathname.lastIndexOf(`${RPC_UPLOAD_PATH}/`) + RPC_UPLOAD_PATH.length + 1;
		const uploadId = sanitizeUploadId(pathname.slice(start));
		const session = getSession(uploadId);
		if (!session) return new Response(null, { status: 404 });
		return new Response(null, {
			status: 200,
			headers: {
				"X-Upload-Offset": String(await getTempFileSize(uploadId)),
				"X-Upload-Handler": session.handlerName,
				"X-Original-Size": String(session.originalSize),
				"X-Upload-Status": session.status,
			},
		});
	}

	if (request.method === "POST" && pathname.endsWith(RPC_UPLOAD_PATH)) return handleUploadPost(request);

	if (request.method === "GET" && pathname.endsWith(RPC_DOWNLOAD_PATH)) return handleDownload(url, request);

	return handleCall(request);
};

/** Describes a plain-object module's own enumerable functions for the schema. */
export function describeModule(name: string, obj: RpcApiModule): RpcSchemaEntry {
	const methods: Record<string, RpcMethodDescriptor> = {};
	for (const key of Object.keys(obj)) {
		if (typeof obj[key] === "function") methods[key] = describeFn(obj[key] as Function);
	}
	return { kind: "module", moduleName: name, methods };
}

/**
 * Describes a prototype: its class name, its own methods (without `constructor`) and its enumerable properties.
 *
 * Only the prototype's own methods are listed, not inherited ones; the client still calls an unlisted method as a
 * single-response call, so inherited non-generator methods work, while an inherited generator needs to be
 * redeclared on the subclass to stream.
 *
 * @param proto - The prototype to inspect (pass `MyClass.prototype`).
 * @param seen  - Visited objects; a cycle is reported as the string `"[Circular]"` instead of recursing forever.
 */
export function describeInstance(proto: unknown, seen = new WeakSet()): unknown {
	if (proto === null || typeof proto !== "object") return null;
	if (seen.has(proto)) return "[Circular]";
	seen.add(proto);

	const record = proto as Record<string, unknown>;
	const cls = (record.constructor as { name?: string } | undefined)?.name || "Object";
	const methods: Record<string, RpcMethodDescriptor> = {};
	for (const name of Object.getOwnPropertyNames(proto)) {
		if (name !== "constructor" && typeof record[name] === "function") methods[name] = describeFn(record[name] as Function);
	}
	const properties: Record<string, unknown> = {};
	for (const key of Object.keys(proto)) {
		const val = record[key];
		properties[key] = typeof val === "object" && val !== null ? describeInstance(val, seen) : typeof val;
	}
	return { className: cls, methods, properties };
}
