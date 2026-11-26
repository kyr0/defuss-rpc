/**
 * The RPC server core: {@link createRpcServer} returns one endpoint, an {@link RpcServer} whose `fetch` answers every
 * RPC route from its own namespaces, hooks, handlers and upload sessions.
 *
 * Why one `Request → Response` function instead of a framework middleware: the same handler then runs unchanged in
 * Astro API routes, `Bun.serve`, `ExpressRpcServer` (on any provider), defuss-serve and tests, and an adapter only has
 * to translate requests. Why a state object per server instead of module state: two servers in one process (two
 * APIs, a test beside a dev server) must not see each other's namespaces, hooks or uploads, and a server passed as a
 * value reaches every module copy (ESM and CommonJS builds, a bundler's SSR copy) without a process-wide registry.
 * Every handler below takes its server's {@link ServerState}; the deprecated module functions (`rpcRoute`, `addHook`,
 * …) are the one exception and act on a global server kept for code written before 4.0.
 * VERIFIED: src/instances.test.ts runs two servers with overlapping namespaces, hooks and upload IDs in one process.
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
	RpcMethodDescriptor,
	RpcApiSchema,
	RpcRoute,
	RpcSchemaEntry,
	RpcServer,
	RpcServerOptions,
	ServerHook,
	UploadHandlerEntry,
	UploadHandlerFn,
	UploadMeta,
	UploadStreamFrame,
	UploadStreamHandlerFn,
} from "./types.d.js";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUploadState, fileChunks, openFileChunks, type UploadEvent, type UploadState } from "./upload-state.js";
import { errorMessage, log } from "./log.js";
import { parseRpcCall } from "./call.js";

// re-export for type / code safety
export * from "./types.d.js";

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

/** Everything one server owns; every handler in this module reads and writes only the state it is given. */
interface ServerState {
	entries: Map<string, RpcApiEntry>;
	docs: Map<string, RpcSchemaEntry>;
	hooks: ServerHook[];
	uploadHandlers: Map<string, UploadHandlerEntry>;
	downloadHandlers: Map<string, DownloadHandlerEntry>;
	uploads: UploadState;
	/** Enders of the responses still streaming (generators, upload progress), called by `close()`. */
	streams: Set<() => void>;
	closed: boolean;
}

function createState(uploadDir: string): ServerState {
	return {
		entries: new Map(),
		docs: new Map(),
		hooks: [],
		uploadHandlers: new Map(),
		downloadHandlers: new Map(),
		uploads: createUploadState(uploadDir),
		streams: new Set(),
		closed: false,
	};
}

/** What a closed server answers, and the message its open streams end with. */
const CLOSED_MESSAGE = "RPC server closed";

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

/**
 * The exposure rule: the methods a namespace exposes, by name. A class exposes the functions its own prototype
 * declares, a module its own enumerable function properties - nothing inherited, no getter, no reserved name.
 *
 * Why one function for the schema and the dispatcher: before 3.0 the schema listed own prototype methods while a call
 * reached any callable member, inherited ones and instance fields included, so `/rpc/schema` (and a schema
 * generated from the source) could not say what a client may call. Now both read this list.
 */
function exposedMethods(entry: RpcApiEntry): Map<string, Function> {
	const methods = new Map<string, Function>();
	const own = isRpcClass(entry) ? (entry.prototype as object) : entry;
	const names = isRpcClass(entry) ? Object.getOwnPropertyNames(own) : Object.keys(own);
	for (const name of names) {
		if (RESERVED_NAMES.has(name)) continue;
		const value = Object.getOwnPropertyDescriptor(own, name)?.value;
		if (typeof value === "function") methods.set(name, value);
	}
	return methods;
}

/**
 * Streams a generator as NDJSON: one DSON frame per `yield`, then a `return` frame, or an `error` frame when the
 * generator throws.
 *
 * Why `pull` with manual `next()` calls instead of `for await`: `for await` drops the generator's return value, and
 * pulling produces a frame only when the consumer reads, so a slow client slows the generator instead of filling
 * memory. `cancel` calls `return()`, so the generator's `finally` blocks run when the client stops reading.
 */
function streamGeneratorResponse(state: ServerState, iter: AsyncIterator<unknown> | Iterator<unknown>): Response {
	const encoder = new TextEncoder();
	let ended = false;
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	// Sends a frame unless the stream has ended; the last frame (return or error) ends it.
	const send = (frame: DsonStreamFrame, last = false) => {
		if (ended) return;
		controller.enqueue(encoder.encode(`${DSON.stringify(frame)}\n`));
		if (!last) return;
		ended = true;
		state.streams.delete(end);
		controller.close();
	};
	// close() of the server: an error frame tells the client why the stream stopped, and return() runs `finally`.
	const end = () => {
		send({ type: "error", error: { message: CLOSED_MESSAGE } }, true);
		void Promise.resolve(iter.return?.()).catch(() => {});
	};
	state.streams.add(end);
	const stream = new ReadableStream<Uint8Array>({
		start(c) {
			controller = c;
		},
		async pull() {
			try {
				const { done, value } = await iter.next();
				send(done ? { type: "return", value: value ?? null } : { type: "yield", value }, !!done);
			} catch (error: unknown) {
				send({ type: "error", error: { message: errorMessage(error), stack: error instanceof Error ? error.stack : undefined } }, true);
			}
		},
		async cancel() {
			ended = true;
			state.streams.delete(end);
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

async function runGuards(state: ServerState, className: string, methodName: string, args: unknown[], request: Request) {
	for (const hook of state.hooks) {
		// Only an explicit `false` blocks; `void`/`undefined` lets the call through.
		if (hook.phase === "guard" && (await hook.fn(className, methodName, args, request)) === false) return false;
	}
	return true;
}

async function runResultHooks(
	state: ServerState,
	className: string,
	methodName: string,
	args: unknown[],
	request: Request,
	result: unknown,
) {
	for (const hook of state.hooks) {
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
async function handleUploadPost(state: ServerState, request: Request): Promise<Response> {
	const { uploads } = state;
	const { createHash } = await import("node:crypto");
	const { open, readFile } = await import("node:fs/promises");
	const startedAt = performance.now();

	const handlerName = request.headers.get("x-upload-handler") || "";
	const uploadId = sanitizeUploadId(request.headers.get("x-upload-id") || crypto.randomUUID());
	const originalSize = Number.parseInt(request.headers.get("x-original-size") || "0", 10) || 0;
	const offset = Number.parseInt(request.headers.get("x-upload-offset") || "0", 10) || 0;
	const contentEncoding = request.headers.get("content-encoding") || "identity";
	const originalFilename = decodeHeader(request.headers.get("x-original-filename") || "");

	const handlerEntry = state.uploadHandlers.get(handlerName);
	if (!handlerEntry) return json(404, { error: `Upload handler "${handlerName}" not found` });
	if (!(await runGuards(state, "__upload__", handlerName, [originalSize], request))) {
		return json(403, { error: "Forbidden by hook" });
	}

	// A resume needs a session whose file holds exactly `offset` bytes; anything else would corrupt the file.
	const isResume = offset > 0;
	if (isResume) {
		if (!uploads.getSession(uploadId)) return json(404, { error: `No session found for uploadId "${uploadId}" to resume` });
		const fileSize = await uploads.getTempFileSize(uploadId);
		if (fileSize !== offset) {
			return json(409, { error: `Offset mismatch: client claims ${offset}, server has ${fileSize} bytes` });
		}
		uploads.updateSession(uploadId, { status: "uploading" });
	}
	await uploads.ensureUploadDir();
	const session = isResume ? uploads.getSession(uploadId)! : uploads.createSession(uploadId, handlerName, originalSize);

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
				uploads.updateSession(uploadId, { bytesReceived });
				uploads.emitUploadEvent(uploadId, {
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
		uploads.updateSession(uploadId, { status: "error" });
		uploads.emitUploadEvent(uploadId, { type: "error", error: errorMessage(error) });
		log("ERROR", "upload failed", { handler: handlerName, uploadId, error: errorMessage(error) });
		return json(500, { error: errorMessage(error) || "Unknown upload failure" });
	}

	// close() ran while the body arrived: it deleted the session, and the handler must not run on a closed server.
	if (state.closed) {
		await rm(session.tempFilePath, { force: true });
		return json(503, { error: CLOSED_MESSAGE });
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
			// The file closes when the handler settles, also when it threw without reading or still holds a reader.
			const chunks = openFileChunks(session.tempFilePath);
			try {
				handlerResult = await (handlerEntry.fn as UploadStreamHandlerFn<unknown>)(chunks.stream, meta);
			} finally {
				await chunks.close();
			}
		}
	} catch (handlerError: unknown) {
		uploads.updateSession(uploadId, { status: "error" });
		uploads.emitUploadEvent(uploadId, { type: "error", error: errorMessage(handlerError) });
		log("ERROR", "upload handler threw", { handler: handlerName, uploadId, error: errorMessage(handlerError) });
		// Result hooks run on handler errors too (with `undefined`), so an audit hook sees every finished upload.
		await runResultHooks(state, "__upload__", handlerName, [originalSize], request, undefined);
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

	uploads.updateSession(uploadId, { bytesReceived, status: "complete" });
	uploads.emitUploadEvent(uploadId, { type: "complete", bytesReceived, totalBytes: originalSize, percent: 100 });
	await runResultHooks(state, "__upload__", handlerName, [originalSize], request, handlerResult);
	const resultFrame: UploadStreamFrame = { type: "result", value: handlerResult };
	await uploads.cleanupSession(uploadId);
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
function handleUploadProgress(state: ServerState, uploadId: string): Response {
	const { uploads } = state;
	const encoder = new TextEncoder();
	let unsubscribe = () => {};
	let timer: ReturnType<typeof setTimeout> | undefined;
	let end = () => {};
	const stop = () => {
		clearTimeout(timer);
		unsubscribe();
		state.streams.delete(end);
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
			const session = uploads.getSession(uploadId);
			if (session?.status === "complete") {
				return send({ type: "complete", bytesReceived: session.bytesReceived, totalBytes: session.originalSize, percent: 100 });
			}
			if (session?.status === "error") return send({ type: "error", error: "Upload failed" });
			unsubscribe = uploads.addUploadListener(uploadId, (event) => {
				clearTimeout(timer);
				send(event);
			});
			// close() of the server ends the stream with an error event; the client stops waiting.
			end = () => send({ type: "error", error: CLOSED_MESSAGE });
			state.streams.add(end);
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
					if (!uploads.getSession(uploadId)) send({ type: "error", error: "Unknown upload" });
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
async function handleDownload(state: ServerState, url: URL, request: Request): Promise<Response> {
	const handlerName = url.searchParams.get("handler") || "";
	const downloadId = url.searchParams.get("downloadId") || crypto.randomUUID();
	const handlerEntry = state.downloadHandlers.get(handlerName);
	if (!handlerEntry) return json(404, { error: `Download handler "${handlerName}" not found` });
	if (!(await runGuards(state, "__download__", handlerName, [downloadId], request))) {
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

/** Characters allowed in upload and download handler names; they appear in headers and query strings. */
const HANDLER_NAME_RE = /^[a-zA-Z0-9._-]{1,128}$/;

function assertHandlerName(kind: "upload" | "download", name: string) {
	if (!HANDLER_NAME_RE.test(name)) {
		throw new Error(`Invalid ${kind} handler name "${name}": must match ${HANDLER_NAME_RE}`);
	}
}

/** The registration methods of a server; documented on {@link RpcServer}. */
function registrars(state: ServerState) {
	return {
		addHook(hook: ServerHook): void {
			state.hooks.push(hook);
		},
		addUploadHandler<T = unknown>(name: string, handler: UploadHandlerFn<T>): void {
			assertHandlerName("upload", name);
			state.uploadHandlers.set(name, { fn: handler as UploadHandlerFn<unknown>, mode: "buffered" });
		},
		addStreamingUploadHandler<T = unknown>(name: string, handler: UploadStreamHandlerFn<T>): void {
			assertHandlerName("upload", name);
			state.uploadHandlers.set(name, { fn: handler as UploadStreamHandlerFn<unknown>, mode: "streaming" });
		},
		addDownloadHandler<T = unknown>(name: string, handler: DownloadHandlerFn<T>): void {
			assertHandlerName("download", name);
			state.downloadHandlers.set(name, { fn: handler as DownloadHandlerFn<unknown>, mode: "buffered" });
		},
		addStreamingDownloadHandler<T = unknown>(name: string, handler: DownloadStreamHandlerFn<T>): void {
			assertHandlerName("download", name);
			state.downloadHandlers.set(name, { fn: handler as DownloadStreamHandlerFn<unknown>, mode: "streaming" });
		},
	};
}

/** Puts the namespaces and their docs into the state; docs that name no namespace or no exposed method are logged. */
function register(state: ServerState, ns: ApiNamespace, docs: RpcApiSchema = []) {
	for (const [name, entry] of Object.entries(ns)) state.entries.set(name, entry);
	for (const doc of docs) {
		const name = doc.kind === "class" ? doc.className : doc.moduleName;
		const entry = state.entries.get(name);
		if (!entry) {
			log("WARN", "rpc docs name a namespace the server does not have", { namespace: name });
			continue;
		}
		const exposed = exposedMethods(entry);
		const unknown = Object.keys(doc.methods ?? {}).filter((method) => !exposed.has(method));
		if (unknown.length) log("WARN", "rpc docs name methods the server does not expose", { namespace: name, methods: unknown.join(",") });
		state.docs.set(name, doc);
	}
}

/**
 * True for the paths and methods {@link dispatch} answers; see {@link RpcServer.matches}. It reads the end of the
 * path, as `dispatch` does, so the two agree under any prefix.
 */
function isRpcRequest(method: string, pathname: string): boolean {
	// A preflight is the host's to answer: `dispatch` would read it as a call and answer 400.
	if (method === "OPTIONS") return false;
	const path = pathname.replace(/\/+$/, "");
	if (path.endsWith(RPC_SCHEMA_PATH)) return true;
	if (method === "POST") return path.endsWith(RPC_PATH) || path.endsWith(RPC_UPLOAD_PATH);
	if (method === "HEAD") return /\/rpc\/upload\/[^/]+$/.test(path);
	if (method === "GET") return path.endsWith(RPC_DOWNLOAD_PATH) || /\/rpc\/upload\/progress\/[^/]+$/.test(path);
	return false;
}

/**
 * Closes a server: later requests get 503, open streams end, and the temp files of its sessions are deleted, with
 * the upload directory when the server created it.
 */
async function close(state: ServerState, ownsUploadDir: boolean) {
	if (state.closed) return;
	state.closed = true;
	// Each ender deletes itself from the set, which a Set iteration allows. One that throws (a stream its consumer
	// already gave up) must not keep the temp files below from being deleted.
	for (const end of state.streams) {
		try {
			end();
		} catch {
			// the stream is gone either way
		}
	}
	state.streams.clear();
	await state.uploads.clearAllSessions();
	if (ownsUploadDir) await rm(state.uploads.getUploadDir(), { recursive: true, force: true });
}

/**
 * Creates an RPC server: an endpoint for `ns`, with its own hooks, upload and download handlers and upload sessions.
 * Every call returns a new server that shares nothing with any other; mount its `fetch` on any host.
 *
 * @param ns      - Map of namespace name => class constructor (a fresh instance per call) or plain-object module
 *                  (shared). Each key becomes the name the client calls (`rpc.<key>`).
 * @param options - `docs` from `defuss-rpc schema`, the `uploadDir` for temp files, the server's `name`.
 *
 * @example
 * ```ts
 * const rpc = createRpcServer({ UserApi, OrderApi, MathUtils });
 * rpc.addUploadHandler("avatar", (data) => ({ bytes: data.byteLength }));
 * Bun.serve({ fetch: rpc.fetch });
 * ```
 */
export function createRpcServer(ns: ApiNamespace, options: RpcServerOptions = {}): RpcServer {
	const state = createState(options.uploadDir ?? join(tmpdir(), "defuss-uploads", crypto.randomUUID()));
	register(state, ns, options.docs);
	return {
		name: options.name ?? "defuss-rpc",
		get uploadDir() {
			return state.uploads.getUploadDir();
		},
		matches: (request) => isRpcRequest(request.method, new URL(request.url).pathname),
		fetch: (request) => (state.closed ? Promise.resolve(json(503, { error: CLOSED_MESSAGE })) : dispatch(state, request)),
		...registrars(state),
		close: () => close(state, !options.uploadDir),
	};
}

/** The documentation fields of a documented method, merged over the runtime descriptor (which keeps async / generator). */
function documented(runtime: Record<string, RpcMethodDescriptor>, doc: RpcSchemaEntry | undefined) {
	if (!doc?.methods) return runtime;
	const methods: Record<string, RpcMethodDescriptor> = {};
	for (const [name, descriptor] of Object.entries(runtime)) {
		const { async: _async, generator: _generator, ...fields } = doc.methods[name] ?? ({} as RpcMethodDescriptor);
		methods[name] = { ...descriptor, ...fields };
	}
	return methods;
}

/** The `/rpc/schema` body: one descriptor per registered namespace. */
function buildSchema(state: ServerState): RpcSchemaEntry[] {
	const schemaEntries: RpcSchemaEntry[] = [];
	for (const [name, entry] of state.entries) {
		const doc = state.docs.get(name);
		const description = doc?.description ? { description: doc.description } : {};
		if (isRpcClass(entry)) {
			const desc = describeInstance(entry.prototype) as {
				methods: Record<string, RpcMethodDescriptor>;
				properties: Record<string, unknown>;
			};
			schemaEntries.push({
				kind: "class",
				className: name,
				...description,
				methods: documented(desc.methods, doc),
				properties: desc.properties,
			});
		} else {
			const desc = describeModule(name, entry);
			schemaEntries.push({ ...desc, ...description, methods: documented(desc.methods, doc) });
		}
	}
	return schemaEntries;
}

/** Dispatches one RPC call body to its namespace entry. */
async function handleCall(state: ServerState, request: Request): Promise<Response> {
	// DSON first (the current client), plain JSON second, so clients older than the DSON transport still reach this server.
	const call = parseRpcCall(await request.text());
	if (!call) {
		return json(400, { error: "Invalid RPC call: expected { className, methodName, args: [] } as DSON or JSON" });
	}
	const { className, methodName, args } = call;

	if (!(await runGuards(state, className, methodName, args, request))) return json(403, { error: "Forbidden by hook" });

	const entry = state.entries.get(className);
	if (!entry) return json(404, { error: `Namespace ${className} not found` });

	const isClass = isRpcClass(entry);
	const fn = exposedMethods(entry).get(methodName);
	if (!fn) {
		return json(404, {
			error: isClass
				? `Method ${methodName} not found on class ${className}`
				: `Function ${methodName} not found on module ${className}`,
		});
	}

	const target = isClass ? (new entry() as Record<string, unknown>) : (entry as Record<string, unknown>);
	let result: unknown;
	try {
		result = fn.apply(target, args);
		if (describeFn(fn).generator) {
			const iterable = result as AsyncIterable<unknown> & Iterable<unknown>;
			return streamGeneratorResponse(
				state,
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

	await runResultHooks(state, className, methodName, args, request, result);
	return new Response(DSON.stringify(result), { headers: { "Content-Type": "application/json" } });
}

/** Answers one request from `state`; the routes are listed on {@link RpcServer.fetch}. */
async function dispatch(state: ServerState, request: Request): Promise<Response> {
	const url = new URL(request.url);
	// Normalize trailing slashes so "/rpc/schema/" and "/rpc/schema" resolve identically.
	const pathname = url.pathname.replace(/\/+$/, "");

	if (pathname.endsWith(RPC_SCHEMA_PATH)) return json(200, buildSchema(state));

	if (request.method === "GET" && pathname.includes(RPC_UPLOAD_PROGRESS_PATH)) {
		const start = pathname.lastIndexOf(RPC_UPLOAD_PROGRESS_PATH) + RPC_UPLOAD_PROGRESS_PATH.length;
		return handleUploadProgress(state, sanitizeUploadId(pathname.slice(start)));
	}

	if (request.method === "HEAD" && pathname.includes(`${RPC_UPLOAD_PATH}/`)) {
		const start = pathname.lastIndexOf(`${RPC_UPLOAD_PATH}/`) + RPC_UPLOAD_PATH.length + 1;
		const uploadId = sanitizeUploadId(pathname.slice(start));
		const session = state.uploads.getSession(uploadId);
		// Nothing stored for this ID is an answer, not an error: 200 with offset 0 and status "none". Why not 404: the
		// client asks this before every upload with an `uploadId`, and browsers log each 404 as a failed request.
		if (!session) return new Response(null, { status: 200, headers: { "X-Upload-Offset": "0", "X-Upload-Status": "none" } });
		return new Response(null, {
			status: 200,
			headers: {
				"X-Upload-Offset": String(await state.uploads.getTempFileSize(uploadId)),
				"X-Upload-Handler": session.handlerName,
				"X-Original-Size": String(session.originalSize),
				"X-Upload-Status": session.status,
			},
		});
	}

	if (request.method === "POST" && pathname.endsWith(RPC_UPLOAD_PATH)) return handleUploadPost(state, request);

	if (request.method === "GET" && pathname.endsWith(RPC_DOWNLOAD_PATH)) return handleDownload(state, url, request);

	return handleCall(state, request);
}

/*
 * The deprecated global server: the module functions below act on one server per process, as every function of this
 * module did before 4.0. It lives on `globalThis` under a registry symbol because one process can load this module
 * more than once (the ESM and CommonJS builds, a bundler's copy in an SSR build), and a handler registered through
 * one copy must be served by every other. `createRpcServer()` never reads or writes it.
 */
const globalState = ((globalThis as Record<symbol, unknown>)[Symbol.for("defuss-rpc.global-server")] ??= createState(
	join(tmpdir(), "defuss-uploads"),
)) as ServerState;
const globalRegistrars = registrars(globalState);

/**
 * Registers namespaces on the deprecated global server, which `rpcRoute`, the module functions `addHook`,
 * `addUploadHandler`, … and `ExpressRpcServer` without `rpc` serve. This is what `createRpcServer(ns)` did before 4.0.
 *
 * The first registration wins: while the global server holds namespaces, a further call is ignored with a WARN log
 * line. Pass `{}` to empty it, then register again; {@link clearRpcServer} also removes hooks and handlers.
 *
 * @deprecated Use `const rpc = createRpcServer(ns)` and pass `rpc` where the global server was implied: `rpc.fetch`
 * for `rpcRoute`, `rpc.addHook()` for `addHook()`, `new ExpressRpcServer({ rpc })`. README.md, section "Migrating to
 * 4.0", lists every replacement.
 */
export function registerGlobalRpcApi(ns: ApiNamespace, options: Pick<RpcServerOptions, "docs"> = {}): void {
	if (Object.keys(ns).length === 0) {
		globalState.entries.clear();
		globalState.docs.clear();
		return;
	}
	if (globalState.entries.size > 0) {
		log("WARN", "registerGlobalRpcApi ignored: the global server already has namespaces; pass {} first or use createRpcServer()", {
			namespaces: Object.keys(ns).join(","),
		});
		return;
	}
	register(globalState, ns, options.docs);
}

/**
 * Answers a request from the deprecated global server; same routes as {@link RpcServer.fetch}.
 * @deprecated Use `rpc.fetch(request)` of a server from `createRpcServer()`; in an Astro route
 * `export const ALL: APIRoute = ({ request }) => rpc.fetch(request)`.
 */
export const rpcRoute: RpcRoute = ({ request }) => dispatch(globalState, request);

/** @deprecated Use `rpc.addHook()` of a server from `createRpcServer()`. */
export function addHook(hook: ServerHook): void {
	globalRegistrars.addHook(hook);
}

/** @deprecated Use `rpc.addUploadHandler()` of a server from `createRpcServer()`. */
export function addUploadHandler<T = unknown>(name: string, handler: UploadHandlerFn<T>): void {
	globalRegistrars.addUploadHandler(name, handler);
}

/** @deprecated Use `rpc.addStreamingUploadHandler()` of a server from `createRpcServer()`. */
export function addStreamingUploadHandler<T = unknown>(name: string, handler: UploadStreamHandlerFn<T>): void {
	globalRegistrars.addStreamingUploadHandler(name, handler);
}

/** @deprecated Use `rpc.addDownloadHandler()` of a server from `createRpcServer()`. */
export function addDownloadHandler<T = unknown>(name: string, handler: DownloadHandlerFn<T>): void {
	globalRegistrars.addDownloadHandler(name, handler);
}

/** @deprecated Use `rpc.addStreamingDownloadHandler()` of a server from `createRpcServer()`. */
export function addStreamingDownloadHandler<T = unknown>(name: string, handler: DownloadStreamHandlerFn<T>): void {
	globalRegistrars.addStreamingDownloadHandler(name, handler);
}

/** Removes every upload handler of the global server. @deprecated A server from `createRpcServer()` starts empty. */
export function clearUploadHandlers(): void {
	globalState.uploadHandlers.clear();
}

/** Removes every download handler of the global server. @deprecated A server from `createRpcServer()` starts empty. */
export function clearDownloadHandlers(): void {
	globalState.downloadHandlers.clear();
}

/**
 * Empties the global server: namespaces, hooks, upload and download handlers, and the temp files of its sessions.
 * @deprecated Use `await rpc.close()` on a server from `createRpcServer()`, and a new server for a fresh start.
 */
export async function clearRpcServer(): Promise<void> {
	globalState.entries.clear();
	globalState.docs.clear();
	globalState.hooks.length = 0;
	globalState.uploadHandlers.clear();
	globalState.downloadHandlers.clear();
	await globalState.uploads.clearAllSessions();
}

/**
 * The global server's directory for upload temp files (default `<os tmpdir>/defuss-uploads`).
 * @deprecated Use `rpc.uploadDir` of a server from `createRpcServer()`.
 */
export function getUploadDir(): string {
	return globalState.uploads.getUploadDir();
}

/**
 * Sets the global server's directory for upload temp files; sessions that already started keep their old path.
 * @deprecated Use `createRpcServer(ns, { uploadDir })`.
 */
export function setUploadDir(dir: string): void {
	globalState.uploads.setUploadDir(dir);
}

/** Describes a plain-object module's own enumerable functions for the schema. */
export function describeModule(name: string, obj: RpcApiModule): RpcSchemaEntry {
	const methods: Record<string, RpcMethodDescriptor> = {};
	for (const [key, fn] of exposedMethods(obj)) methods[key] = describeFn(fn);
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
		const value = Object.getOwnPropertyDescriptor(proto, name)?.value;
		if (!RESERVED_NAMES.has(name) && typeof value === "function") methods[name] = describeFn(value);
	}
	const properties: Record<string, unknown> = {};
	for (const key of Object.keys(proto)) {
		const val = record[key];
		properties[key] = typeof val === "object" && val !== null ? describeInstance(val, seen) : typeof val;
	}
	return { className: cls, methods, properties };
}
