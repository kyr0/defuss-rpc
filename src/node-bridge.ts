/**
 * Connects the Fetch API core of `ExpressRpcServer` to `node:http` frameworks such as Express: converts the incoming
 * message into a `Request` and writes the `Response` back.
 *
 * Why a bridge and not a second implementation in `node:http` terms: CORS, limits and gzip live once, in
 * `http-core.ts`, for these frameworks and for bunway alike. What the bridge adds is what `node:http` needs: draining
 * request bodies nobody read, backpressure, and cancelling a response whose client disconnected.
 */
import { Readable } from "node:stream";
import type { RpcHttpCore, RpcHttpRequest, RpcHttpResponse, RpcMiddleware } from "./provider.js";

/** Response headers that describe the connection, which `node:http` manages itself. */
const HOP_HEADERS = new Set(["transfer-encoding", "connection", "keep-alive"]);

/** `node:http` headers as Fetch headers; repeated headers are joined, as HTTP allows for list-valued fields. */
function toHeaders(raw: RpcHttpRequest["headers"]): Headers {
	const headers = new Headers();
	for (const [key, value] of Object.entries(raw)) {
		if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
	}
	return headers;
}

/**
 * Discards what is left of a request body once the response is decided, so the connection can serve the next
 * request. Without it, a body nobody reads (a 400 or 404 answer) or reads only in part (413) stays paused mid-body:
 * VERIFIED: with Express the client never got the 404 for an unread 300 KB upload and timed out.
 * Removing the web stream's `data` listener before resuming drops the bytes instead of queueing them.
 */
function discardRest(req: RpcHttpRequest): void {
	if (req.readableEnded) return;
	req.removeAllListeners("data");
	req.resume();
}

/** Waits until `res` can take more data, or until the client is gone. */
function drained(res: RpcHttpResponse): Promise<void> {
	return new Promise((resolve) => {
		const done = () => {
			res.off("drain", done);
			res.off("close", done);
			resolve();
		};
		res.once("drain", done);
		res.once("close", done);
	});
}

/**
 * Copies a response body chunk by chunk and returns `false` when the client disconnected first.
 *
 * Why it watches the connection: the body of a generator method is produced on demand, so a stream whose client
 * is gone must be cancelled, or an endless generator would keep running for nobody; `node:http` reports the
 * disconnect with a `close` event before the response finished. VERIFIED: src/client.test.ts ("break stops the
 * server generator") on Node.js and Bun. Why it waits for `drain`: a large download to a slow client would otherwise
 * pile up in memory.
 */
async function pipe(body: ReadableStream<Uint8Array>, res: RpcHttpResponse): Promise<boolean> {
	const reader = body.getReader();
	let gone = false;
	const onClose = () => {
		if (res.writableFinished) return;
		gone = true;
		void reader.cancel().catch(() => {});
	};
	res.once("close", onClose);
	try {
		while (!gone) {
			const { done, value } = await reader.read();
			if (done) return !gone;
			if (!res.write(value) && !gone) await drained(res);
		}
		return false;
	} finally {
		res.off("close", onClose);
	}
}

/** Writes a Fetch `Response` with the `node:http` response API, which every `node:http` framework shares. */
async function writeResponse(response: Response, res: RpcHttpResponse, isStream: boolean): Promise<void> {
	res.statusCode = response.status;
	for (const [key, value] of response.headers) {
		if (key !== "set-cookie" && !HOP_HEADERS.has(key)) res.setHeader(key, value);
	}
	const cookies = response.headers.getSetCookie();
	if (cookies.length > 0) res.setHeader("Set-Cookie", cookies);
	if (!response.body) {
		res.end();
		return;
	}
	// Send the headers now: an SSE or NDJSON client waits for them before the first event arrives.
	if (isStream) res.flushHeaders?.();
	if (await pipe(response.body, res)) res.end();
}

/**
 * The middleware a `node:http` provider mounts: answers what `rpc.match()` accepts, adds CORS headers to everything
 * else and passes it on with `next()`, so the framework's own routes keep working.
 *
 * @example A provider for a `node:http` framework
 * ```ts
 * use: (app, rpc) => app.use(nodeMiddleware(rpc)),
 * ```
 */
export function nodeMiddleware(rpc: RpcHttpCore): RpcMiddleware {
	return (req, res, next) => {
		const target = req.originalUrl ?? req.url ?? "/";
		const method = req.method ?? "GET";
		const query = target.indexOf("?");
		const pathname = query === -1 ? target : target.slice(0, query);
		if (!rpc.match(method, pathname)) {
			const requested = req.headers["access-control-request-headers"];
			for (const [key, value] of rpc.corsHeaders(req.headers.origin, Array.isArray(requested) ? requested.join(", ") : requested)) {
				res.setHeader(key, value);
			}
			next();
			return;
		}
		const hasBody = method !== "GET" && method !== "HEAD";
		const request = new Request(`http://${req.headers.host || "localhost"}${target}`, {
			method,
			headers: toHeaders(req.headers),
			body: hasBody ? (Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>) : undefined,
			// @ts-expect-error duplex is required by undici for a streamed body and missing from lib.dom
			duplex: "half",
		});
		rpc
			.handle(request)
			.then((response) => {
				// rpcRoute reads an upload body before it answers, so what is unread now is never read.
				if (hasBody) discardRest(req);
				return writeResponse(response, res, rpc.isStream(response));
			})
			.catch(next);
	};
}
