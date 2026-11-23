import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DSON } from "defuss-dson";
import { createRpcServer, describeInstance } from "./server.js";
import type { RpcServer } from "./types.d.js";
import { TestMathModule, TestStreamModule, TestTypesModule, TestUserApi } from "./test/api.js";
import { callRoute, frames } from "./test/server.js";

const schemaRequest = (rpc: RpcServer, path = "/rpc/schema", method = "POST") =>
	rpc.fetch(new Request(`http://localhost${path}`, { method }));

describe("rpc.fetch", () => {
	let rpc: RpcServer;
	beforeEach(() => {
		rpc = createRpcServer({ TestUserApi, TestMathModule, TestTypesModule, TestStreamModule });
	});
	afterEach(() => rpc.close());

	describe("schema", () => {
		it("describes classes and modules with async and generator flags", async () => {
			const schema = await (await schemaRequest(rpc)).json();
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
				const response = await schemaRequest(rpc, path, method);
				expect(response.status).toBe(200);
				expect(await response.json()).toHaveLength(4);
			}
		});
	});

	describe("calls", () => {
		it("calls class methods on a fresh instance and module functions", async () => {
			expect(DSON.parse(await (await callRoute(rpc, "TestUserApi", "getUser", ["7"])).text())).toEqual({
				id: "7",
				name: "User 7",
				email: "user7@example.com",
				age: 70,
			});
			expect(DSON.parse(await (await callRoute(rpc, "TestMathModule", "add", [2, 3])).text())).toBe(5);
			expect(DSON.parse(await (await callRoute(rpc, "TestMathModule", "pi")).text())).toBe(Math.PI);
			expect(DSON.parse(await (await callRoute(rpc, "TestUserApi", "getUserCount")).text())).toBe(42);
		});

		it("round-trips DSON types as arguments and as top-level results", async () => {
			const value = { when: new Date(0), tags: new Set(["a"]), map: new Map([["k", 1n]]), bytes: new Uint8Array([1, 2]) };
			expect(DSON.parse(await (await callRoute(rpc, "TestTypesModule", "echo", [value])).text())).toEqual(value);
			// Iterable results (typed arrays, Map, Set) are values, not streams: only generator functions stream.
			const bytes = await callRoute(rpc, "TestTypesModule", "bytes", [3]);
			expect(bytes.headers.get("content-type")).toBe("application/json");
			expect(DSON.parse(await bytes.text())).toEqual(new Uint8Array([0, 1, 2]));
			expect(DSON.parse(await (await callRoute(rpc, "TestTypesModule", "map")).text())).toEqual(new Map([["a", 1], ["b", 2]]));
			expect(DSON.parse(await (await callRoute(rpc, "TestTypesModule", "set")).text())).toEqual(new Set(["x", "y"]));
			expect(DSON.parse(await (await callRoute(rpc, "TestTypesModule", "big")).text())).toBe(2n ** 64n);
		});

		it("accepts the plain-JSON call body of older clients", async () => {
			const body = JSON.stringify({ className: "TestMathModule", methodName: "multiply", args: [6, 7] });
			expect(DSON.parse(await (await callRoute(rpc, "", "", [], "/rpc", body)).text())).toBe(42);
		});

		it("answers 400 for a body that is not a call", async () => {
			for (const body of ["", "not json", "{}", JSON.stringify({ className: "TestMathModule", methodName: "add" })]) {
				const response = await callRoute(rpc, "", "", [], "/rpc", body);
				expect(response.status, body).toBe(400);
				expect((await response.json()).error).toMatch(/Invalid RPC call/);
			}
		});

		// The server decodes untrusted bodies with defuss-dson, whose 1.2.0 "Security" fixes these cases. VERIFIED: with
		// 1.1.2 the first body answered 200, so the method ran with a Function built from the request (2026-11-02).
		it("refuses DSON records that name a global or take a length from the body, and keeps __proto__ an own key", async () => {
			const echo = DSON.stringify({ className: "TestTypesModule", methodName: "echo", args: ["MARK"] });
			for (const record of ['["Function","return 1"]', '["Float64Array",5e7]']) {
				expect((await callRoute(rpc, "", "", [], "/rpc", echo.replace('[0,"MARK"]', record))).status, record).toBe(400);
			}
			const shape = await callRoute(rpc, "TestTypesModule", "shape", [JSON.parse('{"__proto__":{"admin":true}}')]);
			expect(DSON.parse(await shape.text())).toEqual({ keys: ["__proto__"], plainPrototype: true });
		});

		it("answers 404 for unknown namespaces and methods", async () => {
			const cases: [string, string, string][] = [
				["Nope", "x", "Namespace Nope not found"],
				["TestUserApi", "nope", "Method nope not found on class TestUserApi"],
				["TestMathModule", "nope", "Function nope not found on module TestMathModule"],
			];
			for (const [ns, method, error] of cases) {
				const response = await callRoute(rpc, ns, method);
				expect(response.status).toBe(404);
				expect((await response.json()).error).toBe(error);
			}
		});

		it("never dispatches constructor, __proto__ or Object.prototype members", async () => {
			for (const ns of ["TestUserApi", "TestMathModule"]) {
				for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf", "__defineGetter__"]) {
					expect((await callRoute(rpc, ns, name, ["x"])).status, `${ns}.${name}`).toBe(404);
				}
			}
		});

		it("answers 500 with the thrown message", async () => {
			const method = await callRoute(rpc, "TestUserApi", "throwError");
			expect(method.status).toBe(500);
			expect((await method.json()).error).toBe("Error calling method throwError: This is a test error");
			const fn = await callRoute(rpc, "TestMathModule", "divide", [1, 0]);
			expect(fn.status).toBe(500);
			expect((await fn.json()).error).toBe("Error calling function divide: Division by zero");
		});
	});

	describe("hooks", () => {
		it("runs guards in order; only an explicit false rejects with 403", async () => {
			const seen: string[] = [];
			rpc.addHook({ phase: "guard", fn: (ns, method) => void seen.push(`first:${ns}.${method}`) });
			rpc.addHook({ phase: "guard", fn: (_ns, method) => (seen.push("second"), method !== "multiply") });
			expect((await callRoute(rpc, "TestMathModule", "add", [1, 1])).status).toBe(200);
			const blocked = await callRoute(rpc, "TestMathModule", "multiply", [2, 2]);
			expect(blocked.status).toBe(403);
			expect(await blocked.json()).toEqual({ error: "Forbidden by hook" });
			expect(seen).toEqual(["first:TestMathModule.add", "second", "first:TestMathModule.multiply", "second"]);
		});

		it("passes args and the request to guards and the result to result hooks", async () => {
			const calls: unknown[] = [];
			rpc.addHook({
				phase: "guard",
				fn: (_ns, _m, args, request) => {
					calls.push(["guard", args, request.headers.get("content-type")]);
					return true;
				},
			});
			rpc.addHook({ phase: "result", fn: (ns, m, args, _r, result) => void calls.push(["result", ns, m, args, result]) });
			await callRoute(rpc, "TestMathModule", "add", [2, 5]);
			expect(calls).toEqual([
				["guard", [2, 5], "application/json"],
				["result", "TestMathModule", "add", [2, 5], 7],
			]);
		});

		it("does not run result hooks for generator methods or failed calls", async () => {
			const results: unknown[] = [];
			rpc.addHook({ phase: "result", fn: (...args) => void results.push(args[1]) });
			await (await callRoute(rpc, "TestStreamModule", "countUp", [2])).text();
			await callRoute(rpc, "TestMathModule", "divide", [1, 0]);
			expect(results).toEqual([]);
		});
	});

	describe("generators", () => {
		it("streams yield frames and the return value as NDJSON", async () => {
			const response = await callRoute(rpc, "TestStreamModule", "countUp", [3]);
			expect(response.headers.get("content-type")).toBe("application/x-ndjson");
			expect(await frames(response)).toEqual([
				{ type: "yield", value: 0 },
				{ type: "yield", value: 1 },
				{ type: "yield", value: 2 },
				{ type: "return", value: 3 },
			]);
		});

		it("streams synchronous generators", async () => {
			expect(await frames(await callRoute(rpc, "TestStreamModule", "syncCount", [2]))).toEqual([
				{ type: "yield", value: 0 },
				{ type: "yield", value: 10 },
				{ type: "return", value: "done" },
			]);
		});

		it("ends with an error frame when the generator throws", async () => {
			const result = await frames(await callRoute(rpc, "TestStreamModule", "throwMidStream"));
			expect(result.slice(0, 2)).toEqual([
				{ type: "yield", value: "a" },
				{ type: "yield", value: "b" },
			]);
			expect(result[2]).toMatchObject({ type: "error", error: { message: "mid-stream error" } });
			expect(result).toHaveLength(3);
		});

		it("stops the generator (its finally runs) when the consumer cancels the stream", async () => {
			const response = await callRoute(rpc, "TestStreamModule", "endless");
			const reader = response.body!.getReader();
			await reader.read();
			await reader.cancel();
			expect(DSON.parse(await (await callRoute(rpc, "TestStreamModule", "wasFinalized")).text())).toBe(true);
		});
	});

	describe("createRpcServer", () => {
		it("returns a new server on every call, which neither replaces nor extends the first", async () => {
			const other = createRpcServer({ Other: TestMathModule });
			expect((await callRoute(rpc, "Other", "add", [1, 2])).status).toBe(404);
			expect(DSON.parse(await (await callRoute(other, "Other", "add", [1, 2])).text())).toBe(3);
			expect((await callRoute(other, "TestMathModule", "add", [1, 2])).status).toBe(404);
			await other.close();
		});
	});
});

describe("the exposure rule and documented schemas", () => {
	class Base {
		inherited() {
			return "base";
		}
	}
	class Accounts extends Base {
		field = () => "field";
		/** listed */
		async open(name: string) {
			return `opened ${name}`;
		}
		get label() {
			return "getter";
		}
	}
	const Tools = Object.assign(Object.create({ hidden: () => "proto" }), { visible: () => "visible" });
	let rpc: RpcServer;
	afterEach(() => rpc.close());

	it("calls exactly what the schema lists: no inherited method, instance field, getter or prototype function", async () => {
		rpc = createRpcServer({ Accounts, Tools });
		const schema = await (await schemaRequest(rpc)).json();
		expect(Object.keys(schema[0].methods)).toEqual(["open"]);
		expect(Object.keys(schema[1].methods)).toEqual(["visible"]);
		expect(DSON.parse(await (await callRoute(rpc, "Accounts", "open", ["a"])).text())).toBe("opened a");
		expect(DSON.parse(await (await callRoute(rpc, "Tools", "visible")).text())).toBe("visible");
		for (const [ns, method] of [["Accounts", "inherited"], ["Accounts", "field"], ["Accounts", "label"], ["Accounts", "toString"], ["Tools", "hidden"], ["Tools", "hasOwnProperty"]])
			expect((await callRoute(rpc, ns, method)).status, `${ns}.${method}`).toBe(404);
	});

	it("merges the docs into /rpc/schema by name and keeps the runtime's async and generator flags", async () => {
		rpc = createRpcServer(
			{ Accounts, Tools },
			{
				docs: [
					{
						kind: "class",
						className: "Accounts",
						description: "Customer accounts.",
						properties: {},
						methods: {
							open: {
								async: false,
								generator: true,
								description: "Opens an account.",
								params: [{ name: "name", type: "string", schema: { type: "string" }, description: "Its holder." }],
								returns: { type: "string", schema: { type: "string" } },
							},
							inherited: { async: false, generator: false, description: "not exposed" },
						},
					},
					{ kind: "module", moduleName: "Missing", methods: {} },
				],
			},
		);
		const [accounts, tools] = await (await schemaRequest(rpc)).json();
		expect(accounts.description).toBe("Customer accounts.");
		expect(accounts.methods).toEqual({
			open: {
				async: true,
				generator: false,
				description: "Opens an account.",
				params: [{ name: "name", type: "string", schema: { type: "string" }, description: "Its holder." }],
				returns: { type: "string", schema: { type: "string" } },
			},
		});
		expect(tools).toEqual({ kind: "module", moduleName: "Tools", methods: { visible: { async: false, generator: false } } });
		const bare = createRpcServer({ Accounts });
		expect((await (await schemaRequest(bare)).json())[0].description, "docs belong to the server given them").toBeUndefined();
		await bare.close();
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
