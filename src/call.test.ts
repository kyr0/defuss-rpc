import { readFile } from "node:fs/promises";
import { DSON } from "defuss-dson";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encodeRpcCall, parseRpcCall, type RpcCall, rpcCalls, sendRpcCall } from "./call.js";
import { createRpcServer } from "./server.js";
import { TestMathModule, TestStreamModule, TestTypesModule, TestUserApi } from "./test/api.js";
import { PROVIDERS, startServer } from "./test/server.js";
import type { RpcServerProvider } from "./provider.js";

const API = { TestUserApi, TestMathModule, TestTypesModule, TestStreamModule };
type Api = typeof API;
const calls = rpcCalls<Api>();

/** Runs a call on a server without HTTP, through the request `encodeRpcCall` describes. */
async function run(call: RpcCall) {
	const rpc = createRpcServer(API);
	try {
		const { method, path, headers, body } = encodeRpcCall(call);
		const response = await rpc.fetch(new Request("http://localhost" + path, { method, headers, body }));
		return { status: response.status, value: response.status === 200 ? DSON.parse(await response.text()) : null };
	} finally {
		await rpc.close();
	}
}

describe("rpcCalls", () => {
	it("records a module call and a class call as plain data", () => {
		const add = calls.TestMathModule.add(2, 3);
		const user = new calls.TestUserApi().getUser("7");
		expect(add).toEqual({ v: 1, className: "TestMathModule", methodName: "add", args: [2, 3] });
		expect(user).toEqual({ v: 1, className: "TestUserApi", methodName: "getUser", args: ["7"] });
		// No Proxy survives: the call clones and stringifies like any object.
		expect(structuredClone(add)).toEqual(add);
		expect(JSON.parse(JSON.stringify(user))).toEqual(user);
	});

	it("rejects wrong arguments, unknown names and generator methods at compile time", () => {
		// The checks are the @ts-expect-error lines, which `make lint` compiles; at runtime the builder records anything.
		// @ts-expect-error a string where add takes a number
		calls.TestMathModule.add("2", 3);
		// @ts-expect-error no such method
		calls.TestMathModule.subtract(2, 3);
		// @ts-expect-error a generator streams frames, which a stored call has no single answer for
		calls.TestStreamModule.countUp(3);
		// @ts-expect-error a class namespace is constructed first, as with the client
		calls.TestUserApi.getUser("7");
		expect(calls.TestMathModule.multiply(2, 4).args).toEqual([2, 4]);
	});

	it("runs on a real server through encodeRpcCall, DSON values included", async () => {
		expect(await run(calls.TestMathModule.add(2, 3))).toEqual({ status: 200, value: 5 });
		expect(await run(new calls.TestUserApi().getUser("7"))).toEqual({
			status: 200,
			value: { id: "7", name: "User 7", email: "user7@example.com", age: 70 },
		});
		const at = new Date("2026-11-26T08:00:00.000Z");
		expect(await run(calls.TestTypesModule.echo({ at, big: 2n ** 70n }))).toEqual({ status: 200, value: { at, big: 2n ** 70n } });
		expect((await run({ v: 1, className: "Nope", methodName: "x", args: [] })).status).toBe(404);
	});
});

describe("parseRpcCall", () => {
	it("reads the stored form, the flat form and the DSON and JSON text a server receives", () => {
		const call: RpcCall = { v: 1, className: "TestMathModule", methodName: "add", args: [2, 3] };
		const flat = { className: "TestMathModule", methodName: "add", args: [2, 3] };
		expect(parseRpcCall(call)).toEqual(call);
		expect(parseRpcCall(flat)).toEqual(call);
		expect(parseRpcCall(encodeRpcCall(call).body)).toEqual(call);
		expect(parseRpcCall(JSON.stringify(flat))).toEqual(call);
	});

	it("rejects anything that is no call, and a version it does not know", () => {
		for (const value of [
			null,
			"not json",
			[],
			{ methodName: "add", args: [] },
			{ className: "M", args: [] },
			{ className: "M", methodName: "add", args: "2,3" },
			{ v: 2, className: "M", methodName: "add", args: [] },
		])
			expect(parseRpcCall(value)).toBeNull();
	});

	it("keeps reading the first stored version: a v1 call written to disk still runs", async () => {
		const stored = JSON.parse(await readFile(new URL("./test/fixtures/call-v1.json", import.meta.url), "utf8"));
		const call = parseRpcCall(stored);
		expect(call).not.toBeNull();
		expect(await run(call!)).toEqual({ status: 200, value: 5 });
	});
});

describe.for(PROVIDERS)("sendRpcCall on $name", (provider: RpcServerProvider<unknown>) => {
	let server: Awaited<ReturnType<typeof startServer>>;
	beforeAll(async () => {
		const rpc = createRpcServer(API);
		// A guard that wants a header shows that the caller's headers reach the server.
		rpc.addHook({ phase: "guard", fn: (_ns, _method, _args, request) => request?.headers.get("x-caller") !== "blocked" });
		server = await startServer(provider, rpc);
	});
	afterAll(async () => {
		await server.stop();
		await server.rpc.close();
	});

	it("returns the response, 200 with the result, and does not throw for a refusal", async () => {
		const ok = await sendRpcCall(server.url, calls.TestMathModule.add(4, 5));
		expect([ok.status, DSON.parse(await ok.text())]).toEqual([200, 9]);
		const missing = await sendRpcCall(server.url, { v: 1, className: "Nope", methodName: "x", args: [] });
		expect(missing.status).toBe(404);
		const blocked = await sendRpcCall(server.url, calls.TestMathModule.add(1, 1), { headers: { "x-caller": "blocked" } });
		expect(blocked.status).toBe(403);
	});
});
