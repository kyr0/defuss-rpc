/**
 * The defuss-rpc client: a typed proxy over the server's schema, plus binary upload and download.
 *
 * Why a runtime schema instead of generated stubs: the client learns at startup which namespaces are classes or
 * modules and which methods are generators, so no code generation step can go stale, while `getRpcClient<RpcApi>()`
 * still types every call from the server's own `typeof` export. It runs wherever `fetch` exists: browsers, Bun,
 * Node.js, Deno and workers.
 */
import { DSON } from "defuss-dson";
import type { ClientHook, DsonStreamFrame, RpcApiClass, RpcApiSchema } from "./types.d.js";
import { log } from "./log.js";

// re-export for type / code safety
export * from "./types.d.js";

/** Client-side endpoint paths; they mirror the server's `RPC_*` constants, which the client must not import. */
const RPC_PATH = "/rpc" as const;
const RPC_SCHEMA_PATH = "/rpc/schema" as const;
const RPC_UPLOAD_PATH = "/rpc/upload" as const;
const RPC_DOWNLOAD_PATH = "/rpc/download" as const;

/**
 * Default RPC endpoint, set when the `virtual:defuss-rpc` module of defuss-rpc-vite (also used by defuss-rpc-astro) is
 * imported. Empty means "same origin as the page". Kept on `globalThis`, so a second copy of this module (another
 * bundle chunk, the CommonJS build) sees the endpoint the virtual module registered.
 */
const endpointState = ((globalThis as Record<symbol, unknown>)[Symbol.for("defuss-rpc.client")] ??= { endpoint: "" }) as {
	endpoint: string;
};

/**
 * Registers the default RPC endpoint for every call that passes no `baseUrl`.
 *
 * The `virtual:defuss-rpc` module calls this for you; call it yourself to configure one endpoint for the whole app
 * without defuss-rpc-vite (e.g. in a Node.js or Bun script).
 *
 * @param url - Endpoint base URL without the `/rpc` suffix, e.g. `"http://localhost:63920"`.
 */
export function _setDefaultEndpoint(url: string): void {
	endpointState.endpoint = url;
}

/**
 * What one client context owns: its hooks, its {@link setHeaders} set, its schema cache and an optional default
 * endpoint. The module functions use one process-wide state; {@link createRpcContext} makes another. Why: a library
 * that calls its own server through defuss-rpc must neither run the application's hooks nor send its headers, and the
 * application must not see the library's. VERIFIED: a client guard added with `addHook()` blocked a defuss-backplane
 * call made through the process-wide client.
 */
interface ClientState {
	hooks: ClientHook[];
	headers: HeadersInit | null;
	schemas: Map<string, Promise<RpcApiSchema>>;
	baseUrl?: string;
}

/** The state of the module functions. */
const globalState: ClientState = { hooks: [], headers: null, schemas: new Map() };

/** A call's endpoint: its own `baseUrl`, then the context's, then the registered one, then `""` (the page's origin). */
const endpointOf = (state: ClientState, baseUrl?: string) => baseUrl ?? state.baseUrl ?? endpointState.endpoint;

/** Options of {@link getRpcClient}. */
export interface RpcClientOptions {
	/**
	 * Base URL of the RPC server (e.g. `"http://localhost:63920"`), without the `/rpc` suffix.
	 *
	 * Resolution order: this option, then the endpoint registered by `virtual:defuss-rpc` or `_setDefaultEndpoint()`,
	 * then `""` (the page's own origin).
	 */
	baseUrl?: string;
	/**
	 * Headers of this client only, e.g. `{ Authorization: "Bearer …" }`. They go with its schema request and every
	 * call it makes, after the {@link setHeaders} set, so a name in both takes this value. Why per client: a process
	 * that calls two servers with two credentials cannot share one global set.
	 */
	headers?: HeadersInit;
}

/**
 * Fetches the API schema from `{baseUrl}/rpc/schema`. {@link getRpcClient} calls it once per endpoint and caches
 * the result; call this directly only to inspect the API.
 *
 * Uses `POST` because the server answers the schema on any method and some hosts strip or cache `GET` requests.
 * Sends the {@link setHeaders} set and `headers`, because a host that guards `/rpc` usually guards the schema too.
 *
 * @param baseUrl - Endpoint base URL; defaults to the registered endpoint, else the page's origin.
 * @param headers - Headers of this request, after the {@link setHeaders} set.
 * @returns The `RpcApiSchema` array: one descriptor per namespace.
 * @throws when the server answers with a non-2xx status.
 */
export function getSchema(baseUrl?: string, headers?: HeadersInit): Promise<RpcApiSchema> {
	return fetchSchema(globalState, baseUrl, headers);
}

/**
 * The schema request of one state. A failure carries `status` and `body`, as a failed call does, so a caller can tell
 * a missing credential (401) from a missing endpoint (404) or an unavailable server (503).
 */
async function fetchSchema(state: ClientState, baseUrl: string | undefined, headers?: HeadersInit): Promise<RpcApiSchema> {
	const response = await fetch(`${endpointOf(state, baseUrl)}${RPC_SCHEMA_PATH}`, {
		method: "POST",
		headers: mergeHeaders(state.headers, headers),
	});
	if (!response.ok) {
		throw Object.assign(new Error(`Failed to fetch schema: ${response.status} ${response.statusText}`), {
			status: response.status,
			body: await response.text(),
		});
	}
	return response.json();
}

/**
 * Forgets every cached schema of the module functions; the next {@link getRpcClient} call fetches it again (e.g.
 * after a server reload). Why the cache is per endpoint: two clients for two servers must not share one method list.
 */
export function clearSchemaCache() {
	globalState.schemas.clear();
}

/** Removes every client hook and the headers set by {@link setHeaders}. For test isolation and logout flows. */
export function clearHooks() {
	resetState(globalState);
}

function resetState(state: ClientState) {
	state.hooks.length = 0;
	state.headers = null;
}

/**
 * Adds a client hook. Guards run before the request is sent and abort the call when they return a falsy value
 * (including `undefined`: a client guard must return `true` explicitly); response hooks see the raw `Response`
 * before its body is read; result hooks see the decoded value. Hooks run for RPC calls and uploads (namespace
 * `"__upload__"`), in the order they were added.
 */
export function addHook(hook: ClientHook) {
	globalState.hooks.push(hook);
}

/**
 * Header sets merged into one record, later sets replacing a name of earlier ones. Why through `Headers`: spreading a
 * `Headers` instance or an array of pairs copies nothing usable, and spreading records keeps `authorization` and
 * `Authorization` as two names, which fetch() sends as one header with both values joined. VERIFIED: src/client.test.ts
 * ("a client's headers win") was answered 401 with `Bearer wrong, Bearer a` before this merge.
 */
function mergeHeaders(...sets: (HeadersInit | null | undefined)[]): Record<string, string> {
	const merged = new Headers();
	for (const set of sets) if (set) new Headers(set).forEach((value, name) => merged.set(name, value));
	return Object.fromEntries(merged);
}

/**
 * Sets headers sent with every schema request, RPC call and upload, e.g. `{ Authorization: "Bearer …" }`. Replaces
 * the previous set. Downloads take their headers per call (`download(…, { headers })`), because a download URL is
 * often handed to a different context. {@link RpcClientOptions.headers} sets headers for one client.
 */
export function setHeaders(headers: HeadersInit) {
	globalState.headers = headers;
}

/** Runs the guard hooks; throws when one returns a falsy value. */
async function runClientGuards(
	hooks: readonly ClientHook[],
	namespace: string,
	method: string,
	args: unknown[],
	request: RequestInit,
	what: string,
) {
	for (const hook of hooks) {
		if (hook.phase === "guard" && !(await hook.fn(namespace, method, args, request))) {
			throw new Error(`${what} was blocked by a guard`);
		}
	}
}

async function runClientHooks(
	hooks: readonly ClientHook[],
	phase: "response" | "result",
	namespace: string,
	method: string,
	args: unknown[],
	request: RequestInit,
	response: Response,
	data?: unknown,
) {
	for (const hook of hooks) {
		if (hook.phase === phase) await hook.fn(namespace, method, args, request, response, data);
	}
}

/**
 * Sends one call (guards, fetch, response hooks) and throws for non-2xx answers. The thrown error carries
 * `status`, `body`, `namespace` and `method`, so callers can branch on the server's error JSON.
 */
async function sendCall(
	state: ClientState,
	namespaceName: string,
	methodName: string,
	args: unknown[],
	baseUrl: string,
	headers: Record<string, string>,
) {
	const request: RequestInit = {
		method: "POST",
		headers: mergeHeaders({ "Content-Type": "application/json" }, state.headers, headers),
		body: DSON.stringify({ className: namespaceName, methodName, args }),
	};
	await runClientGuards(state.hooks, namespaceName, methodName, args, request, `RPC call to ${namespaceName}.${methodName}`);
	const response = await fetch(`${baseUrl}${RPC_PATH}`, request);
	await runClientHooks(state.hooks, "response", namespaceName, methodName, args, request, response);
	if (!response.ok) {
		throw Object.assign(new Error(`RPC call failed: ${response.status} ${response.statusText}`), {
			status: response.status,
			body: await response.text(),
			namespace: namespaceName,
			method: methodName,
		});
	}
	return { request, response };
}

/**
 * Returns the caller for a single-response method: POST the call, DSON-decode the body (which restores `Date`,
 * `Map`, `Set`, `BigInt` and typed arrays), run the result hooks, resolve with the value.
 */
function createRpcMethod(
	state: ClientState,
	namespaceName: string,
	methodName: string,
	baseUrl: string,
	headers: Record<string, string>,
) {
	return async (...args: unknown[]) => {
		const { request, response } = await sendCall(state, namespaceName, methodName, args, baseUrl, headers);
		const data = DSON.parse(await response.text());
		await runClientHooks(state.hooks, "result", namespaceName, methodName, args, request, response, data);
		return data;
	};
}

/**
 * Returns the caller for a generator method: an async generator that yields each `yield` frame of the server's
 * NDJSON stream as it arrives, returns the server generator's return value and throws its `error` frame.
 * Breaking out of `for await` cancels the response body, which stops the server generator.
 */
function createRpcGeneratorMethod(
	state: ClientState,
	namespaceName: string,
	methodName: string,
	baseUrl: string,
	headers: Record<string, string>,
) {
	return async function* (...args: unknown[]) {
		const { request, response } = await sendCall(state, namespaceName, methodName, args, baseUrl, headers);
		const reader = response.body!.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		let returnValue: unknown;
		const toFrame = (line: string) => DSON.parse(line) as DsonStreamFrame;
		try {
			while (true) {
				const { done, value } = await reader.read();
				buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				// The last element is an incomplete line, or "" after a newline; it waits for the next chunk.
				buffer = done ? "" : lines.pop()!;
				for (const line of lines) {
					if (!line) continue;
					const frame = toFrame(line);
					if (frame.type === "yield") yield frame.value;
					else if (frame.type === "return") returnValue = frame.value;
					else throw new Error(frame.error.message);
				}
				if (done) break;
			}
		} finally {
			await reader.cancel().catch(() => {});
		}
		await runClientHooks(state.hooks, "result", namespaceName, methodName, args, request, response, returnValue);
		return returnValue;
	};
}

/**
 * Property names a proxy answers with `undefined` instead of an RPC caller.
 * Why: `await`, `Promise.resolve()` and returning a proxy from an `async` function look up `then`; a caller there
 * would turn every namespace into a thenable that fires a bogus RPC call and never settles.
 */
const NOT_RPC = new Set(["then", "toJSON"]);

/** One endpoint's client object, built from its schema; every caller sends `headers` after the global set. */
function buildClient(
	state: ClientState,
	schema: RpcApiSchema,
	baseUrl: string,
	headers: Record<string, string>,
): Record<string, unknown> {
	const client: Record<string, unknown> = {};
	for (const entry of schema) {
		if (entry.kind === "module") {
			const moduleName = entry.moduleName;
			const methods: Record<string, unknown> = {};
			for (const [methodName, desc] of Object.entries(entry.methods)) {
				methods[methodName] = desc.generator
					? createRpcGeneratorMethod(state, moduleName, methodName, baseUrl, headers)
					: createRpcMethod(state, moduleName, methodName, baseUrl, headers);
			}
			client[moduleName] = new Proxy(methods, {
				get: (target, prop) => {
					if (typeof prop !== "string" || NOT_RPC.has(prop)) return undefined;
					// Unknown names still become callers, so the server's 404 explains the typo.
					return target[prop] ?? createRpcMethod(state, moduleName, prop, baseUrl, headers);
				},
			});
		} else {
			const className = entry.className;
			// A constructor stand-in: `new rpc.UserApi()` returns a proxy whose properties are RPC callers. The server
			// creates its own instance per call, so constructor arguments are not sent.
			const Constructor = function () {} as unknown as RpcApiClass;
			client[className] = new Proxy(Constructor, {
				construct: () =>
					new Proxy(
						{},
						{
							get: (_target, methodName) => {
								if (typeof methodName !== "string" || NOT_RPC.has(methodName)) return undefined;
								return entry.methods[methodName]?.generator
									? createRpcGeneratorMethod(state, className, methodName, baseUrl, headers)
									: createRpcMethod(state, className, methodName, baseUrl, headers);
							},
						},
					),
			});
		}
	}
	return client;
}

/**
 * Creates the typed RPC client for an endpoint.
 *
 * - Class namespaces: `const user = await new rpc.UserApi().getUser("1")`
 * - Module namespaces: `const sum = await rpc.MathUtils.add(1, 2)`
 * - Generator methods: `for await (const chunk of rpc.ChatApi.stream("hi")) …`
 *
 * The schema is fetched once per endpoint and cached for the lifetime of the page or process; a failed fetch is
 * not cached, so a request without the right credentials leaves no schema behind. Call {@link clearSchemaCache}
 * after the server's API changed.
 *
 * @typeParam T - `typeof` the server's namespace object (export `type RpcApi = typeof RpcApi` on the server).
 * @param options - `baseUrl` of the RPC server and this client's `headers`; see {@link RpcClientOptions}.
 */
export function getRpcClient<T extends Record<string, unknown>>(options?: RpcClientOptions): Promise<T> {
	return clientOf<T>(globalState, options);
}

async function clientOf<T>(state: ClientState, options?: RpcClientOptions): Promise<T> {
	const baseUrl = endpointOf(state, options?.baseUrl);
	const headers = mergeHeaders(options?.headers);
	let schema = state.schemas.get(baseUrl);
	if (!schema) {
		schema = fetchSchema(state, baseUrl, headers);
		state.schemas.set(baseUrl, schema);
		schema.catch(() => state.schemas.delete(baseUrl));
	}
	return buildClient(state, await schema, baseUrl, headers) as T;
}

/** Alias for {@link getRpcClient} */
export const createRpcClient = getRpcClient;

// -- Upload API ---------------------------------------------------------------

/** Accepted binary source types for `upload()`. */
export type BinarySource = Uint8Array | ArrayBuffer | ArrayBufferView | Blob;

/** Compression preference for upload transfers. */
export type UploadCompression = "auto" | "gzip" | "none";

/** Options for the `upload()` function. */
export interface UploadOptions {
	/** Base URL for the RPC server. Defaults to the auto-registered endpoint. */
	baseUrl?: string;
	/**
	 * `"auto"` (default) and `"gzip"` compress with `CompressionStream` where it exists (browsers, Node.js, Bun) and
	 * the server inflates the body; `"none"` sends raw bytes, the better choice for data that is already compressed
	 * (images, video, archives), since gzip then costs CPU without saving bytes.
	 */
	compression?: UploadCompression;
	/**
	 * Chunk size for the streamed request body outside browsers (default 256 KiB); it is also the granularity of the
	 * `sending` events there. Browsers send one buffered body instead, see {@link upload}.
	 */
	chunkSize?: number;
	/**
	 * Upload ID (`[a-zA-Z0-9._-]`, max 128 chars; other characters become `_`). Passing one makes the client ask the
	 * server (`HEAD`) how many bytes it already has and send only the rest, so reusing the ID of an interrupted
	 * upload resumes it. A random UUID is used when omitted.
	 */
	uploadId?: string;
	/** AbortSignal to cancel the upload. */
	signal?: AbortSignal;
	/** Extra headers merged into the fetch request. */
	headers?: Record<string, string>;
	/**
	 * Open an SSE sideband for server-confirmed progress events (`"receiving"` events).
	 * @default true
	 */
	progress?: boolean;
	/**
	 * File name for the handler's `meta.originalFilename`, sent percent-encoded in `X-Original-Filename`, so any
	 * Unicode name survives.
	 */
	originalFilename?: string;
}

/**
 * Events yielded by the `upload()` async generator.
 *
 * - `sending`   - client-tracked bytes handed to the network stack.
 * - `receiving` - server-confirmed bytes (via SSE sideband).
 * - `complete`  - upload finished; contains handler result, hashes, and stats.
 */
export type UploadEvent<T = unknown> =
	| { type: "sending"; bytesSent: number; totalBytes: number; percent: number }
	| { type: "receiving"; bytesReceived: number; totalBytes: number; percent: number }
	| {
		type: "complete";
		result: T;
		uploadId: string;
		bytesReceived: number;
		sha256: string;
		durationMs: number;
	};

/**
 * The final result returned by `uploadComplete()`.
 */
export interface UploadResult<T = unknown> {
	result: T;
	uploadId: string;
	bytesReceived: number;
	sha256: string;
	durationMs: number;
}

// -- Binary helpers -----------------------------------------------------------

type ArrayBufferBackedBytes = Uint8Array<ArrayBuffer>;

function toArrayBufferBackedBytes(
	source: ArrayBuffer | ArrayBufferView,
): ArrayBufferBackedBytes {
	if (source instanceof ArrayBuffer) {
		return new Uint8Array(source);
	}

	const view = new Uint8Array(
		source.buffer,
		source.byteOffset,
		source.byteLength,
	);
	const normalized = new Uint8Array(new ArrayBuffer(view.byteLength));
	normalized.set(view);
	return normalized;
}

function normalizeBinarySource(
	source: BinarySource,
): Blob | ArrayBufferBackedBytes {
	if (source instanceof Blob) return source;
	if (source instanceof ArrayBuffer) {
		return new Uint8Array(source);
	}
	return toArrayBufferBackedBytes(source);
}

function getSourceSize(source: Blob | ArrayBufferBackedBytes): number {
	return source instanceof Blob ? source.size : source.byteLength;
}

function sliceBinarySource(
	source: Blob | ArrayBufferBackedBytes,
	offset = 0,
): Blob | ArrayBufferBackedBytes {
	if (source instanceof Blob) {
		return offset > 0 ? source.slice(offset) : source;
	}

	return offset > 0 ? toArrayBufferBackedBytes(source.subarray(offset)) : source;
}

function toReadableStream(
	source: Blob | ArrayBufferBackedBytes,
	chunkSize: number,
): ReadableStream<Uint8Array> {
	if (source instanceof Blob) {
		return source.stream() as ReadableStream<Uint8Array>;
	}

	let pos = 0;
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			if (pos >= source.byteLength) {
				controller.close();
				return;
			}
			const end = Math.min(pos + chunkSize, source.byteLength);
			controller.enqueue(source.subarray(pos, end));
			pos = end;
		},
	});
}

async function createBufferedUploadBody(
	source: Blob | ArrayBufferBackedBytes,
	preference: UploadCompression,
): Promise<{
	body: Blob | ArrayBufferBackedBytes;
	usedCompression: "gzip" | "none";
}> {
	if (preference === "none") {
		return { body: source, usedCompression: "none" };
	}

	if (typeof CompressionStream === "function") {
		const blobSource = source instanceof Blob ? source : new Blob([source]);
		const compressedStream = blobSource
			.stream()
			.pipeThrough(
				new CompressionStream("gzip") as unknown as ReadableWritablePair<
					Uint8Array,
					Uint8Array
				>,
			);

		return {
			body: await new Response(compressedStream).blob(),
			usedCompression: "gzip",
		};
	}

	if (preference === "gzip") {
		log("WARN", "CompressionStream unavailable; uploading uncompressed");
	}

	return { body: source, usedCompression: "none" };
}

/**
 * True in a browser page. Why browsers get a buffered body: a streamed request body needs `duplex: "half"`, which
 * Safari and Firefox do not support and Chromium allows only over HTTP/2, while Node.js and Bun stream it fine.
 */
function shouldUseBufferedBrowserUpload(): boolean {
	return typeof window !== "undefined" && typeof document !== "undefined";
}

function applyCompression(
	stream: ReadableStream<Uint8Array>,
	preference: UploadCompression,
): { stream: ReadableStream<Uint8Array>; usedCompression: "gzip" | "none" } {
	if (preference === "none") {
		return { stream, usedCompression: "none" };
	}
	if (typeof CompressionStream === "function") {
		return {
			stream: stream.pipeThrough(new CompressionStream("gzip") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>) as ReadableStream<Uint8Array>,
			usedCompression: "gzip",
		};
	}
	if (preference === "gzip") {
		log("WARN", "CompressionStream unavailable; uploading uncompressed");
	}
	return { stream, usedCompression: "none" };
}

function sanitizeUploadId(value: string): string {
	const sanitized = value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 128);
	return sanitized || crypto.randomUUID();
}

// -- upload() - async generator with progress ---------------------------------

/**
 * Uploads binary data to a named server-side handler and reports progress as it goes.
 *
 * Returns an async generator that yields:
 * - `{ type: "sending", ... }`   - bytes handed to the network. Outside browsers one event per chunk; in a browser
 *   one event after the request finished, because a buffered `fetch` body reports no progress.
 * - `{ type: "receiving", ... }` - bytes the server has written, from the Server-Sent Events stream at
 *   `/rpc/upload/progress/{uploadId}` (where `EventSource` exists and `progress` is not `false`).
 * - `{ type: "complete", ... }`  - the handler's return value with the server's SHA-256 of the received content.
 *
 * Why a generator instead of callbacks: progress, completion and errors arrive in one `for await` loop, a
 * `break` stops listening, and an error (HTTP status, error frame of a throwing handler) is thrown where the
 * loop runs. VERIFIED: src/client.browser.test.ts sees `sending` up to 100% and `receiving` events in Chromium and
 * WebKit; src/client.test.ts sees one `sending` event per chunk on Node.js and Bun.
 *
 * **Resumable**: with `options.uploadId` the client asks the server (`HEAD`) how many bytes it holds for that ID
 * and sends only the rest; the server hashes the whole file.
 *
 * @typeParam T - The return type of the server-side upload handler.
 * @param handlerName - The name passed to `rpc.addUploadHandler()` on the server.
 * @param data        - Binary payload (Uint8Array, ArrayBuffer, Blob, or any ArrayBufferView).
 * @param options     - Upload options (baseUrl, compression, resume, abort, etc.).
 *
 * @example
 * ```ts
 * for await (const event of upload<MyResult>("vfs-upload", buffer)) {
 *   if (event.type === "sending")   sent.value = event.percent;     // bytes on the wire
 *   if (event.type === "receiving") stored.value = event.percent;   // bytes the server stored
 *   if (event.type === "complete")  show(event.result);
 * }
 * ```
 */
export function upload<T = unknown>(
	handlerName: string,
	data: BinarySource,
	options: UploadOptions = {},
): AsyncGenerator<UploadEvent<T>, void, undefined> {
	return uploadOf<T>(globalState, handlerName, data, options);
}

async function* uploadOf<T>(
	state: ClientState,
	handlerName: string,
	data: BinarySource,
	options: UploadOptions,
): AsyncGenerator<UploadEvent<T>, void, undefined> {
	const baseUrl = endpointOf(state, options.baseUrl);
	const compression = options.compression ?? "auto";
	const chunkSize = options.chunkSize ?? 256 * 1024;
	const enableSSE = options.progress !== false;
	const uploadId = sanitizeUploadId(options.uploadId || crypto.randomUUID());

	const normalized = normalizeBinarySource(data);
	const totalBytes = getSourceSize(normalized);

	// -- Resume check -------------------------------------------------
	let offset = 0;
	if (options.uploadId) {
		try {
			const headRes = await fetch(
				`${baseUrl}${RPC_UPLOAD_PATH}/${uploadId}`,
				{ method: "HEAD", headers: mergeHeaders(state.headers, options.headers), signal: options.signal },
			);
			if (headRes.ok) {
				offset = Number.parseInt(
					headRes.headers.get("x-upload-offset") || "0",
					10,
				);
			}
			// 404 => no session to resume, start fresh (offset = 0)
		} catch {
			// Network error on HEAD - start fresh
		}
	}

	// -- SSE sideband for server progress -----------------------------
	const serverProgressQueue: UploadEvent<T>[] = [];
	let eventSource: EventSource | null = null;

	if (enableSSE && typeof EventSource !== "undefined") {
		try {
			eventSource = new EventSource(
				`${baseUrl}${RPC_UPLOAD_PATH}/progress/${uploadId}`,
			);
			eventSource.onmessage = (ev) => {
				try {
					const data = JSON.parse(ev.data);
					if (data.type === "progress") {
						serverProgressQueue.push({
							type: "receiving",
							bytesReceived: data.bytesReceived,
							totalBytes: data.totalBytes,
							percent: data.percent,
						} as UploadEvent<T>);
					}
					// "complete" and "error" from SSE are informational;
					// the definitive result comes from the POST response.
				} catch { /* ignore parse errors */ }
			};
			eventSource.onerror = () => {
				// SSE failed - progress events stop but upload continues
			};
		} catch {
			// EventSource construction failed - continue without SSE
		}
	}

	// -- Build upload stream with progress tracking -------------------
	const clientProgressQueue: UploadEvent<T>[] = [];
	let bytesSent = offset;
	const sourceToUpload = sliceBinarySource(normalized, offset);
	const useBufferedBrowserUpload = shouldUseBufferedBrowserUpload();

	let requestBody: Blob | ArrayBufferBackedBytes | ReadableStream<Uint8Array>;
	let usedCompression: "gzip" | "none";

	if (useBufferedBrowserUpload) {
		const bufferedUpload = await createBufferedUploadBody(
			sourceToUpload,
			compression,
		);
		requestBody = bufferedUpload.body;
		usedCompression = bufferedUpload.usedCompression;
	} else {
		const rawStream = toReadableStream(sourceToUpload, chunkSize);
		const trackingStream = new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				controller.enqueue(chunk);
				bytesSent += chunk.byteLength;
				const percent =
					totalBytes > 0
						? Math.min(100, Math.round((bytesSent / totalBytes) * 100))
						: 0;
				clientProgressQueue.push({
					type: "sending",
					bytesSent,
					totalBytes,
					percent,
				} as UploadEvent<T>);
			},
		});

		const bodyStream = rawStream.pipeThrough(trackingStream);
		const compressedUpload = applyCompression(bodyStream, compression);
		requestBody = compressedUpload.stream;
		usedCompression = compressedUpload.usedCompression;
	}

	// -- Guard hooks --------------------------------------------------
	const reqInit: RequestInit & { duplex?: string } = {
		method: "POST",
		headers: mergeHeaders(
			{
				"Content-Type": "application/octet-stream",
				"X-Upload-Handler": handlerName,
				"X-Upload-Id": uploadId,
				"X-Original-Size": String(totalBytes),
				"X-Upload-Offset": String(offset),
				// Percent-encoded: header values are bytes, and a name outside Latin-1 makes fetch() throw.
				...(options.originalFilename ? { "X-Original-Filename": encodeURIComponent(options.originalFilename) } : {}),
				...(usedCompression === "gzip" ? { "Content-Encoding": "gzip" } : {}),
			},
			state.headers,
			options.headers,
		),
		body: requestBody as BodyInit,
		signal: options.signal,
	};

	if (!useBufferedBrowserUpload) {
		reqInit.duplex = "half";
	}

	try {
		await runClientGuards(state.hooks, "__upload__", handlerName, [totalBytes], reqInit, `Upload to "${handlerName}"`);
	} catch (error) {
		eventSource?.close();
		throw error;
	}

	// -- Dispatch fetch + yield progress ------------------------------
	let fetchDone = false;
	let fetchResponse: Response | undefined;
	let fetchError: Error | undefined;

	const fetchPromise = fetch(`${baseUrl}${RPC_UPLOAD_PATH}`, reqInit)
		.then((res) => {
			fetchResponse = res;
		})
		.catch((err) => {
			fetchError = err;
		})
		.finally(() => {
			fetchDone = true;
		});

	// Yield progress events while the upload is in flight.
	while (!fetchDone) {
		// Drain queued progress events
		while (clientProgressQueue.length > 0) {
			yield clientProgressQueue.shift()!;
		}
		while (serverProgressQueue.length > 0) {
			yield serverProgressQueue.shift()!;
		}

		// Small sleep to avoid busy-waiting, then race with the fetch.
		await Promise.race([
			fetchPromise,
			new Promise<void>((r) => setTimeout(r, 50)),
		]);
	}

	// Drain remaining events after fetch completes
	while (clientProgressQueue.length > 0) {
		yield clientProgressQueue.shift()!;
	}
	while (serverProgressQueue.length > 0) {
		yield serverProgressQueue.shift()!;
	}

	// Close SSE
	eventSource?.close();

	if (fetchError) {
		throw fetchError;
	}

	if (!fetchResponse) {
		throw new Error("Upload fetch returned no response");
	}

	if (useBufferedBrowserUpload) {
		yield {
			type: "sending",
			bytesSent: totalBytes,
			totalBytes,
			percent: totalBytes > 0 ? 100 : 0,
		} as UploadEvent<T>;
	}

	// -- Response hooks -----------------------------------------------
	await runClientHooks(state.hooks, "response", "__upload__", handlerName, [totalBytes], reqInit, fetchResponse);

	if (!fetchResponse.ok) {
		const body = await fetchResponse.text();
		throw Object.assign(
			new Error(
				`Upload failed: ${fetchResponse.status} ${fetchResponse.statusText}`,
			),
			{
				status: fetchResponse.status,
				body,
				handler: handlerName,
			},
		);
	}

	// -- Parse NDJSON response ----------------------------------------
	const responseText = await fetchResponse.text();
	const lines = responseText.split("\n").filter(Boolean);

	let receivedFrame: any = null;
	let resultFrame: any = null;

	for (const line of lines) {
		const frame = DSON.parse(line);
		if (frame.type === "received") {
			receivedFrame = frame;
		} else if (frame.type === "result") {
			resultFrame = frame;
		} else if (frame.type === "error") {
			throw new Error(frame.error?.message || "Upload handler error");
		}
	}

	if (!receivedFrame) {
		throw new Error("Upload response missing 'received' frame");
	}

	// -- Result hooks -------------------------------------------------
	const resultValue = resultFrame?.value as T;

	await runClientHooks(state.hooks, "result", "__upload__", handlerName, [totalBytes], reqInit, fetchResponse, resultValue);

	// yield final complete event
	yield {
		type: "complete",
		result: resultValue,
		uploadId: receivedFrame.uploadId,
		bytesReceived: receivedFrame.bytesReceived,
		sha256: receivedFrame.sha256,
		durationMs: receivedFrame.durationMs,
	} as UploadEvent<T>;
}


/**
 * Uploads binary data and resolves with the final result only: {@link upload} without progress events and without
 * the SSE connection.
 *
 * @typeParam T - The return type of the server-side upload handler.
 * @param handlerName - The name passed to `rpc.addUploadHandler()` on the server.
 * @param data        - Binary payload.
 * @param options     - Upload options.
 * @returns The handler's return value along with hashes and upload stats.
 *
 * @example
 * ```ts
 * const { sha256, result } = await uploadComplete<{ files: string[] }>("vfs-upload", buffer);
 * // sha256: hex digest of the bytes the server stored; result.files: what the handler returned
 * ```
 */
export function uploadComplete<T = unknown>(
	handlerName: string,
	data: BinarySource,
	options: UploadOptions = {},
): Promise<UploadResult<T>> {
	return uploadCompleteOf<T>(globalState, handlerName, data, options);
}

async function uploadCompleteOf<T>(
	state: ClientState,
	handlerName: string,
	data: BinarySource,
	options: UploadOptions,
): Promise<UploadResult<T>> {
	let result: UploadResult<T> | undefined;
	for await (const event of uploadOf<T>(state, handlerName, data, {
		...options,
		progress: false, // skip SSE for one-shot
	})) {
		if (event.type === "complete") {
			result = {
				result: event.result,
				uploadId: event.uploadId,
				bytesReceived: event.bytesReceived,
				sha256: event.sha256,
				durationMs: event.durationMs,
			};
		}
	}
	if (!result) {
		throw new Error("Upload completed without a result event");
	}
	return result;
}

// -- Download API ---------------------------------------------------------------

/** Options of {@link download} and {@link downloadAsBlob}. */
export interface DownloadOptions {
	/** Headers of the download request, e.g. `{ Authorization: "Bearer …" }`; {@link setHeaders} does not apply. */
	headers?: Record<string, string>;
	/**
	 * ID passed to the handler as `meta.downloadId`, typically the ID of the file to send (e.g. the `uploadId` of an
	 * earlier upload). A random UUID when omitted.
	 */
	downloadId?: string;
	/** AbortSignal to cancel the download. */
	signal?: AbortSignal;
}

/** Result of {@link download}. */
export interface DownloadResult<T = unknown> {
	/** The downloaded bytes. */
	data: Uint8Array;
	/** Always `null`: kept for compatibility; a download handler returns bytes, not a value. */
	result: T;
	/** The ID sent as `downloadId`. */
	downloadId: string;
	/** Number of bytes received. */
	bytesDownloaded: number;
	/** The handler's `fileMeta.sha256` from `X-File-Sha256`, or `null`; compare it with your own digest of `data`. */
	sha256: string | null;
	/** Always `null`: downloads carry no server timing. */
	durationMs: number | null;
	/** File name from `Content-Disposition` (`filename*` preferred over `filename`), or `null`. */
	filename: string | null;
	/** `Content-Type` of the response. */
	contentType: string;
}

/** The URL of a download; relative when the endpoint is (the page's origin). */
function downloadUrl(handlerName: string, baseUrl: string, downloadId: string): string {
	const query = new URLSearchParams({ handler: handlerName, downloadId });
	return `${baseUrl}${RPC_DOWNLOAD_PATH}?${query}`;
}

/** Fetches a download and throws with the server's error body for non-2xx answers. */
async function fetchDownload(handlerName: string, baseUrl: string, options: DownloadOptions) {
	const downloadId = options.downloadId || crypto.randomUUID();
	const response = await fetch(downloadUrl(handlerName, baseUrl, downloadId), {
		method: "GET",
		headers: options.headers,
		signal: options.signal,
	});
	if (!response.ok) {
		const body = await response.text();
		throw Object.assign(new Error(`Download failed: ${response.status} ${response.statusText} - ${body}`), {
			status: response.status,
			body,
			handler: handlerName,
		});
	}
	return { downloadId, response };
}

/**
 * The file name of a `Content-Disposition` header. Prefers the RFC 6266 `filename*=UTF-8''…` form, which carries
 * non-ASCII names, over the plain `filename="…"` fallback.
 */
export function parseContentDisposition(header: string | null): string | null {
	if (!header) return null;
	const extended = header.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
	if (extended) {
		try {
			return decodeURIComponent(extended[1].trim());
		} catch {
			// malformed percent-encoding: fall back to the plain parameter
		}
	}
	return header.match(/filename\s*=\s*"?([^";]+)"?/i)?.[1] ?? null;
}

/**
 * Downloads a file from a named server-side handler into memory.
 *
 * @param handlerName - Name passed to `rpc.addDownloadHandler()` or `rpc.addStreamingDownloadHandler()` on the server.
 * @param baseUrl     - Endpoint base URL; defaults to the registered endpoint, else the page's origin.
 * @param options     - `downloadId`, request `headers` (auth) and `signal`.
 * @returns The bytes with the server's metadata.
 * @throws with `status` and `body` when the server answers non-2xx (unknown handler 404, guard 403, handler 500).
 *
 * @example
 * ```ts
 * const { data, filename, sha256 } = await download("report", undefined, { downloadId: "42" });
 * ```
 */
export async function download<T = unknown>(
	handlerName: string,
	baseUrl: string = endpointState.endpoint,
	options: DownloadOptions = {},
): Promise<DownloadResult<T>> {
	const { downloadId, response } = await fetchDownload(handlerName, baseUrl, options);
	const data = new Uint8Array(await response.arrayBuffer());
	return {
		data,
		result: null as T,
		downloadId,
		bytesDownloaded: data.byteLength,
		sha256: response.headers.get("X-File-Sha256"),
		durationMs: null,
		filename: parseContentDisposition(response.headers.get("Content-Disposition")),
		contentType: response.headers.get("Content-Type") || "application/octet-stream",
	};
}

/**
 * Downloads a file as a `Blob`, for `URL.createObjectURL()`, an `<img>` or a save dialog in the browser. Same
 * arguments and errors as {@link download}; `result.data` is empty because the bytes live in the `Blob`.
 *
 * Note for cross-origin servers: the browser exposes `Content-Disposition` and `X-File-Sha256` only when the server
 * lists them in `Access-Control-Expose-Headers` (`ExpressRpcServer` does).
 */
export async function downloadAsBlob(
	handlerName: string,
	baseUrl: string = endpointState.endpoint,
	options: DownloadOptions = {},
): Promise<{ blob: Blob; result: DownloadResult }> {
	const { downloadId, response } = await fetchDownload(handlerName, baseUrl, options);
	const blob = await response.blob();
	return {
		blob,
		result: {
			data: new Uint8Array(0),
			result: null,
			downloadId,
			bytesDownloaded: blob.size,
			sha256: response.headers.get("X-File-Sha256"),
			durationMs: null,
			filename: parseContentDisposition(response.headers.get("Content-Disposition")),
			contentType: response.headers.get("Content-Type") || blob.type || "application/octet-stream",
		},
	};
}

// -- Client contexts ------------------------------------------------------------

/** Options of {@link createRpcContext}. */
export interface RpcContextOptions {
	/** Default endpoint of the context's calls, uploads and downloads; a call's own `baseUrl` still wins. */
	baseUrl?: string;
	/** The context's first {@link RpcClientContext.setHeaders} set, e.g. its credential. */
	headers?: HeadersInit;
}

/**
 * A client of its own: the module functions of this file with hooks, headers and a schema cache that no other context
 * and not the module functions share. Headers apply as with the module functions: to schema requests, calls and
 * uploads, not to downloads.
 */
export interface RpcClientContext {
	getRpcClient<T extends Record<string, unknown>>(options?: RpcClientOptions): Promise<T>;
	getSchema(baseUrl?: string, headers?: HeadersInit): Promise<RpcApiSchema>;
	addHook(hook: ClientHook): void;
	setHeaders(headers: HeadersInit): void;
	clearHooks(): void;
	clearSchemaCache(): void;
	upload<T = unknown>(
		handlerName: string,
		data: BinarySource,
		options?: UploadOptions,
	): AsyncGenerator<UploadEvent<T>, void, undefined>;
	uploadComplete<T = unknown>(handlerName: string, data: BinarySource, options?: UploadOptions): Promise<UploadResult<T>>;
	download<T = unknown>(handlerName: string, baseUrl?: string, options?: DownloadOptions): Promise<DownloadResult<T>>;
	downloadAsBlob(
		handlerName: string,
		baseUrl?: string,
		options?: DownloadOptions,
	): Promise<{ blob: Blob; result: DownloadResult }>;
}

/**
 * Creates a client context: hooks, headers and a schema cache of its own, as `createRpcServer()` gives a server its
 * own state. Use one in a library that calls its own server, so the application's `addHook()` and `setHeaders()` do
 * not reach those calls and the library's do not reach the application's.
 *
 * @example
 * ```ts
 * const backplane = createRpcContext({ baseUrl: "http://127.0.0.1:43127", headers: { Authorization: "Bearer …" } });
 * const rpc = await backplane.getRpcClient<BackplaneApi>();
 * ```
 */
export function createRpcContext(options: RpcContextOptions = {}): RpcClientContext {
	const state: ClientState = { hooks: [], headers: options.headers ?? null, schemas: new Map(), baseUrl: options.baseUrl };
	return {
		getRpcClient: (clientOptions) => clientOf(state, clientOptions),
		getSchema: (baseUrl, headers) => fetchSchema(state, baseUrl, headers),
		addHook: (hook) => void state.hooks.push(hook),
		setHeaders: (headers) => void (state.headers = headers),
		clearHooks: () => resetState(state),
		clearSchemaCache: () => state.schemas.clear(),
		upload: (handlerName, data, uploadOptions = {}) => uploadOf(state, handlerName, data, uploadOptions),
		uploadComplete: (handlerName, data, uploadOptions = {}) => uploadCompleteOf(state, handlerName, data, uploadOptions),
		download: (handlerName, baseUrl, downloadOptions) => download(handlerName, endpointOf(state, baseUrl), downloadOptions),
		downloadAsBlob: (handlerName, baseUrl, downloadOptions) =>
			downloadAsBlob(handlerName, endpointOf(state, baseUrl), downloadOptions),
	};
}
