import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DSON } from "defuss-dson";
import { addHook, clearRpcServer, createRpcServer, describeInstance, rpcRoute } from "./server.js";
import { TestMathModule, TestStreamModule, TestTypesModule, TestUserApi } from "./test/api.js";
import { callRoute, frames } from "./test/server.js";

const schemaRequest = (path = "/rpc/schema", method = "POST") =>
	rpcRoute({ request: new Request(`http://localhost${path}`, { method }) });

describe("rpcRoute", () => {
	beforeEach(async () => {
		await clearRpcServer();
		createRpcServer({ TestUserApi, TestMathModule, TestTypesModule, TestStreamModule });
	});
	afterEach(() => clearRpcServer());

	describe("schema", () => {
		it("describes classes and modules with async and generator flags", async () => {
			const schema = await (await schemaRequest()).json();
			expect(schema.map((e: any) => e.className ?? e.moduleName)).toEqual([
				"TestUserApi",
				"TestMathModule",
				"TestTypesModule",
				"TestStreamModule",
			]);
			const user = schema.find((e: any) => e.className === "TestUserApi");
			expect(user.kind).toBe("class");
			expect(user.methods.getUser).toEqual({ async: true, generator: false });
			expect(user.methods.getUserCount).toEqual({ async: false, generator: false });
			expect(user.methods).not.toHaveProperty("constructor");
			const stream = schema.find((e: any) => e.moduleName === "TestStreamModule");
			expect(stream.kind).toBe("module");
			expect(stream.methods.countUp).toEqual({ async: true, generator: true });
			expect(stream.methods.syncCount).toEqual({ async: false, generator: true });
			expect(stream.methods.ping).toEqual({ async: true, generator: false });
		});

		it("answers on any method, with a trailing slash and under a path prefix", async () => {
			for (const [path, method] of [["/rpc/schema/", "GET"], ["/api/v1/rpc/schema", "POST"]]) {
				const response = await schemaRequest(path, method);
				expect(response.status).toBe(200);
				expect(await response.json()).toHaveLength(4);
			}
		});
	});

	describe("calls", () => {
		it("calls class methods on a fresh instance and module functions", async () => {
			expect(DSON.parse(await (await callRoute("TestUserApi", "getUser", ["7"])).text())).toEqual({
				id: "7",
				name: "User 7",
				email: "user7@example.com",
				age: 70,
			});
			expect(DSON.parse(await (await callRoute("TestMathModule", "add", [2, 3])).text())).toBe(5);
			expect(DSON.parse(await (await callRoute("TestMathModule", "pi")).text())).toBe(Math.PI);
			expect(DSON.parse(await (await callRoute("TestUserApi", "getUserCount")).text())).toBe(42);
		});

		it("round-trips DSON types as arguments and as top-level results", async () => {
			const value = { when: new Date(0), tags: new Set(["a"]), map: new Map([["k", 1n]]), bytes: new Uint8Array([1, 2]) };
			expect(DSON.parse(await (await callRoute("TestTypesModule", "echo", [value])).text())).toEqual(value);
			// Iterable results (typed arrays, Map, Set) are values, not streams: only generator functions stream.
			const bytes = await callRoute("TestTypesModule", "bytes", [3]);
			expect(bytes.headers.get("content-type")).toBe("application/json");
			expect(DSON.parse(await bytes.text())).toEqual(new Uint8Array([0, 1, 2]));
			expect(DSON.parse(await (await callRoute("TestTypesModule", "map")).text())).toEqual(new Map([["a", 1], ["b", 2]]));
			expect(DSON.parse(await (await callRoute("TestTypesModule", "set")).text())).toEqual(new Set(["x", "y"]));
			expect(DSON.parse(await (await callRoute("TestTypesModule", "big")).text())).toBe(2n ** 64n);
		});

		it("accepts the plain-JSON call body of older clients", async () => {
			const body = JSON.stringify({ className: "TestMathModule", methodName: "multiply", args: [6, 7] });
			expect(DSON.parse(await (await callRoute("", "", [], "/rpc", body)).text())).toBe(42);
		});

		it("answers 400 for a body that is not a call", async () => {
			for (const body of ["", "not json", "{}", JSON.stringify({ className: "TestMathModule", methodName: "add" })]) {
				const response = await callRoute("", "", [], "/rpc", body);
				expect(response.status, body).toBe(400);
				expect((await response.json()).error).toMatch(/Invalid RPC call/);
			}
		});

		// The server decodes untrusted bodies with defuss-dson, whose 1.2.0 "Security" fixes these cases. VERIFIED: with
		// 1.1.2 the first body answered 200, so the method ran with a Function built from the request (2026-11-02).
		it("refuses DSON records that name a global or take a length from the body, and keeps __proto__ an own key", async () => {
			const echo = DSON.stringify({ className: "TestTypesModule", methodName: "echo", args: ["MARK"] });
			for (const record of ['["Function","return 1"]', '["Float64Array",5e7]']) {
				expect((await callRoute("", "", [], "/rpc", echo.replace('[0,"MARK"]', record))).status, record).toBe(400);
			}
			const shape = await callRoute("TestTypesModule", "shape", [JSON.parse('{"__proto__":{"admin":true}}')]);
			expect(DSON.parse(await shape.text())).toEqual({ keys: ["__proto__"], plainPrototype: true });
		});

		it("answers 404 for unknown namespaces and methods", async () => {
			const cases: [string, string, string][] = [
				["Nope", "x", "Namespace Nope not found"],
				["TestUserApi", "nope", "Method nope not found on class TestUserApi"],
				["TestMathModule", "nope", "Function nope not found on module TestMathModule"],
			];
			for (const [ns, method, error] of cases) {
				const response = await callRoute(ns, method);
				expect(response.status).toBe(404);
				expect((await response.json()).error).toBe(error);
			}
		});

		it("never dispatches constructor, __proto__ or Object.prototype members", async () => {
			for (const ns of ["TestUserApi", "TestMathModule"]) {
				for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf", "__defineGetter__"]) {
					expect((await callRoute(ns, name, ["x"])).status, `${ns}.${name}`).toBe(404);
				}
			}
		});

		it("answers 500 with the thrown message", async () => {
			const method = await callRoute("TestUserApi", "throwError");
			expect(method.status).toBe(500);
			expect((await method.json()).error).toBe("Error calling method throwError: This is a test error");
			const fn = await callRoute("TestMathModule", "divide", [1, 0]);
			expect(fn.status).toBe(500);
			expect((await fn.json()).error).toBe("Error calling function divide: Division by zero");
		});
	});

	describe("hooks", () => {
		it("runs guards in order; only an explicit false rejects with 403", async () => {
			const seen: string[] = [];
			addHook({ phase: "guard", fn: (ns, method) => void seen.push(`first:${ns}.${method}`) });
			addHook({ phase: "guard", fn: (_ns, method) => (seen.push("second"), method !== "multiply") });
			expect((await callRoute("TestMathModule", "add", [1, 1])).status).toBe(200);
			const blocked = await callRoute("TestMathModule", "multiply", [2, 2]);
			expect(blocked.status).toBe(403);
			expect(await blocked.json()).toEqual({ error: "Forbidden by hook" });
			expect(seen).toEqual(["first:TestMathModule.add", "second", "first:TestMathModule.multiply", "second"]);
		});

		it("passes args and the request to guards and the result to result hooks", async () => {
			const calls: unknown[] = [];
			addHook({
				phase: "guard",
				fn: (_ns, _m, args, request) => {
					calls.push(["guard", args, request.headers.get("content-type")]);
					return true;
				},
			});
			addHook({ phase: "result", fn: (ns, m, args, _r, result) => void calls.push(["result", ns, m, args, result]) });
			await callRoute("TestMathModule", "add", [2, 5]);
			expect(calls).toEqual([
				["guard", [2, 5], "application/json"],
				["result", "TestMathModule", "add", [2, 5], 7],
			]);
		});

		it("does not run result hooks for generator methods or failed calls", async () => {
			const results: unknown[] = [];
			addHook({ phase: "result", fn: (...args) => void results.push(args[1]) });
			await (await callRoute("TestStreamModule", "countUp", [2])).text();
			await callRoute("TestMathModule", "divide", [1, 0]);
			expect(results).toEqual([]);
		});
	});

	describe("generators", () => {
		it("streams yield frames and the return value as NDJSON", async () => {
			const response = await callRoute("TestStreamModule", "countUp", [3]);
			expect(response.headers.get("content-type")).toBe("application/x-ndjson");
			expect(await frames(response)).toEqual([
				{ type: "yield", value: 0 },
				{ type: "yield", value: 1 },
				{ type: "yield", value: 2 },
				{ type: "return", value: 3 },
			]);
		});

		it("streams synchronous generators", async () => {
			expect(await frames(await callRoute("TestStreamModule", "syncCount", [2]))).toEqual([
				{ type: "yield", value: 0 },
				{ type: "yield", value: 10 },
				{ type: "return", value: "done" },
			]);
		});

		it("ends with an error frame when the generator throws", async () => {
			const result = await frames(await callRoute("TestStreamModule", "throwMidStream"));
			expect(result.slice(0, 2)).toEqual([
				{ type: "yield", value: "a" },
				{ type: "yield", value: "b" },
			]);
			expect(result[2]).toMatchObject({ type: "error", error: { message: "mid-stream error" } });
			expect(result).toHaveLength(3);
		});

		it("stops the generator (its finally runs) when the consumer cancels the stream", async () => {
			const response = await callRoute("TestStreamModule", "endless");
			const reader = response.body!.getReader();
			await reader.read();
			await reader.cancel();
			expect(DSON.parse(await (await callRoute("TestStreamModule", "wasFinalized")).text())).toBe(true);
		});
	});

	describe("createRpcServer", () => {
		it("keeps the first registration and resets with {}", async () => {
			createRpcServer({ Other: TestMathModule });
			expect((await callRoute("Other", "add", [1, 2])).status).toBe(404);
			createRpcServer({});
			createRpcServer({ Other: TestMathModule });
			expect(DSON.parse(await (await callRoute("Other", "add", [1, 2])).text())).toBe(3);
			expect((await callRoute("TestMathModule", "add", [1, 2])).status).toBe(404);
		});
	});
});

describe("describeInstance", () => {
	it("lists own methods, enumerable properties and marks cycles", () => {
		class Base {
			inherited() {}
		}
		class Child extends Base {
			async own() {}
			*gen() {}
		}
		const proto = Child.prototype as any;
		proto.config = { depth: 1 };
		proto.config.self = proto.config;
		proto.label = "x";
		expect(describeInstance(proto)).toEqual({
			className: "Child",
			methods: { own: { async: true, generator: false }, gen: { async: false, generator: true } },
			properties: { config: { className: "Object", methods: {}, properties: { depth: "number", self: "[Circular]" } }, label: "string" },
		});
	});

	it("returns null for non-objects", () => {
		expect(describeInstance(null)).toBeNull();
		expect(describeInstance(42)).toBeNull();
	});
});
