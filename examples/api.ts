/**
 * The demo API of the README, the website and the e2e test. It runs unchanged on Node.js and Bun; the website's live
 * demo calls it from the browser.
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

/** A class: the server creates a fresh instance for every call, so fields never leak between requests. */
export class GreeterApi {
	async greet(name: string) {
		return `Hello, ${name}!`;
	}
}

/** An async generator streams: the client receives every `yield` as it happens. */
export const ChatApi = {
	async *reply(prompt: string) {
		for (const word of `You said: ${prompt}`.split(" ")) {
			await new Promise((resolve) => setTimeout(resolve, 40));
			yield word;
		}
		return "done";
	},
};

/** DSON keeps the types JSON loses: Date, Set, Map, BigInt, typed arrays. */
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

/** Which runtime answers: the same API runs on Node.js and Bun. */
export const ServerInfo = {
	async runtime() {
		return process.versions.bun ? `Bun ${process.versions.bun}` : `Node.js ${process.versions.node}`;
	},
};

const RpcApi = { MathApi, GreeterApi, ChatApi, TypesApi, ServerInfo };
export default RpcApi;
export type RpcApi = typeof RpcApi;
// #endregion api
