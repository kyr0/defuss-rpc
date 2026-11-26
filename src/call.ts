/**
 * VERIFIED: src/call.test.ts builds calls with `rpcCalls`, encodes them and runs them on real servers; the client's
 * `sendCall` and the server's dispatch go through `encodeRpcCall` and `parseRpcCall`, so the whole test suite covers
 * the wire. One owner of the call format: a call as data (`RpcCall`), the typed builder that makes one from the
 * server's API type, and the only functions that turn it into the wire body and back.
 *
 * Why a stored form apart from the wire: a scheduler, a queue or a log keeps calls for months, longer than the code
 * and the defuss-rpc version that wrote them. `v` versions that stored form. `parseRpcCall` accepts every `v` it ever
 * produced and the flat `{ className, methodName, args }` form without `v`; `encodeRpcCall` always writes the current
 * wire. A wire change therefore edits this module and leaves stored calls working. Why not store the encoded body: it
 * is DSON's compact encoding, unreadable in a stored schedule, and storing it would freeze the wire into data.
 */
import { DSON } from "defuss-dson";
import type { RpcFetch } from "./client.js";

/** The call path on the server, relative to the client's `baseUrl`. */
const CALL_PATH = "/rpc" as const;

/** A call as data: what a scheduler, a queue or a log keeps. Plain JSON when its arguments are JSON. `A` is the
 * method's parameter list when `rpcCalls` built the call, so a store that takes only JSON rejects, at compile time, a
 * call whose arguments JSON would change. */
export interface RpcCall<A extends unknown[] = unknown[]> {
	/** The stored form's version. */
	v: 1;
	/** The registered namespace: a class name or a module name. */
	className: string;
	/** The method or function to call on it. */
	methodName: string;
	/** Positional arguments. */
	args: A;
}

type Fn = (...args: any[]) => unknown;
/** A method's builder: its arguments are checked against the method's parameters, and the call keeps the types of
 * the arguments given, so an omitted optional parameter adds no `undefined`. A generator streams NDJSON frames, which a
 * stored call has no single answer for, so it is never. */
type CallBuilder<F> = F extends (...args: infer A) => infer R
	? R extends AsyncGenerator | Generator
		? never
		: <P extends A>(...args: P) => RpcCall<P>
	: never;
type Methods<O> = { [K in keyof O as O[K] extends Fn ? K : never]: CallBuilder<O[K]> };

/**
 * The typed builder over a server's namespace object (`typeof RpcApi`): a module namespace is used as
 * `calls.Mod.fn(a)`, a class namespace as `new calls.Cls().method(a)`, the same shapes as the client. Each call returns
 * an `RpcCall` instead of sending anything; a wrong argument, an unknown name or a generator method fails to compile.
 */
export type RpcCalls<T> = {
	[N in keyof T]: T[N] extends abstract new (...args: any[]) => infer I ? new () => Methods<I> : Methods<T[N]>;
};

/** Names a Proxy is asked for by `await`, `JSON.stringify` and the like, which are never RPC methods. */
const NOT_CALLS = new Set(["then", "toJSON"]);

/** Builds calls from the server's API type without sending them: `rpcCalls<typeof RpcApi>().Math.add(1, 2)`. */
export function rpcCalls<T extends Record<string, unknown>>(): RpcCalls<T> {
	const methods = (className: string) =>
		new Proxy(
			{},
			{
				get: (_target, methodName) =>
					typeof methodName !== "string" || NOT_CALLS.has(methodName)
						? undefined
						: (...args: unknown[]): RpcCall => ({ v: 1, className, methodName, args }),
			},
		);
	return new Proxy(
		{},
		{
			get: (_target, className) => {
				if (typeof className !== "string" || NOT_CALLS.has(className)) return undefined;
				// A class namespace is constructed first, as with the client; a module namespace is used directly. The
				// server creates its own instance per call, so nothing of the construction is kept.
				return new Proxy(function namespace() {}, {
					construct: () => methods(className),
					get: (_fn, methodName) => (methods(className) as Record<string | symbol, unknown>)[methodName],
				});
			},
		},
	) as RpcCalls<T>;
}

/**
 * The call in a value: an `RpcCall`, the flat form without `v`, or the DSON or JSON text of either, the forms a server
 * receives. Returns `null` for anything else, including a `v` this version does not know.
 */
export function parseRpcCall(value: unknown): RpcCall | null {
	let call = value;
	if (typeof value === "string") {
		try {
			call = DSON.parse(value);
		} catch {
			try {
				call = JSON.parse(value);
			} catch {
				return null;
			}
		}
	}
	const c = call as { v?: unknown; className?: unknown; methodName?: unknown; args?: unknown } | null;
	if (!c || typeof c !== "object" || typeof c.className !== "string" || typeof c.methodName !== "string" || !Array.isArray(c.args)) {
		return null;
	}
	if (c.v !== undefined && c.v !== 1) return null;
	return { v: 1, className: c.className, methodName: c.methodName, args: c.args };
}

/** The HTTP request that runs a call: POST to `path` under the server's base URL, with these headers and body. */
export function encodeRpcCall(call: RpcCall): { method: "POST"; path: typeof CALL_PATH; headers: Record<string, string>; body: string } {
	return {
		method: "POST",
		path: CALL_PATH,
		headers: { "Content-Type": "application/json" },
		body: DSON.stringify({ className: call.className, methodName: call.methodName, args: call.args }),
	};
}

/**
 * Sends a call to the server at `baseUrl` (the same base URL as the client's, without `/rpc`) and returns the
 * response. It does not throw for a non-2xx answer, because a scheduler or a queue judges the status itself; decode a
 * 200 body with `DSON.parse`.
 */
export function sendRpcCall(baseUrl: string, call: RpcCall, init: { headers?: HeadersInit; fetch?: RpcFetch; signal?: AbortSignal } = {}) {
	const request = encodeRpcCall(call);
	const headers = new Headers(request.headers);
	for (const [name, value] of new Headers(init.headers)) headers.set(name, value);
	return (init.fetch ?? fetch)(baseUrl + request.path, {
		method: request.method,
		headers: Object.fromEntries(headers),
		body: request.body,
		signal: init.signal,
	});
}
