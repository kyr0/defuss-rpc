/**
 * The demo API of the README, the website and the e2e test. It runs unchanged on Node.js and Bun; the website shows
 * the regions `chat` and `types` beside the client code that calls them. VERIFIED: scripts/e2e.mjs serves it from
 * every demo server and compares examples/client.ts's output with its comments.
 */
// #region api
/** A module: plain functions on one shared object. */
export const MathApi = {
	async add(a: number, b: number) {
		return a + b;
	},
	async multiply(a: number, b: number) {
		return a * b;
	},
};

/**
 * A class: the server creates a fresh instance for every call, so
 * fields never leak between requests.
 */
export class GreeterApi {
	async greet(name: string) {
		return `Hello, ${name}!`;
	}
}

// #region chat
/**
 * An async generator streams: the client receives every `yield`
 * as it happens.
 */
export const ChatApi = {
	async *reply(prompt: string) {
		for (const word of `You said: ${prompt}`.split(" ")) {
			await new Promise((resolve) => setTimeout(resolve, 40));
			yield word;
		}
		return "done";
	},
};
// #endregion chat

// #region types
/**
 * DSON keeps the types JSON loses: Date, Set, Map, BigInt and
 * typed arrays.
 */
export const TypesApi = {
	async sample() {
		return {
			when: new Date("2026-11-01T12:00:00.000Z"),
			tags: new Set(["rpc", "dson"]),
			scores: new Map([["ada", 1815]]),
			big: 2n ** 64n,
			bytes: new Uint8Array([222, 173, 190, 239]),
		};
	},
};
// #endregion types

/** Which runtime answers: the same API runs on Node.js and Bun. */
export const ServerInfo = {
	async runtime() {
		const { bun, node } = process.versions;
		return bun ? `Bun ${bun}` : `Node.js ${node}`;
	},
};

const RpcApi = { MathApi, GreeterApi, ChatApi, TypesApi, ServerInfo };
export default RpcApi;
export type RpcApi = typeof RpcApi;
// #endregion api
