import { describe, expect, it } from "vitest";
import { Project } from "ts-morph";
import { analyzeRpcApi } from "./analyze.js";

/** Runs the analysis over in-memory sources; the first file is the one searched for registrations. */
function analyze(files: Record<string, string>, entries = Object.keys(files).slice(0, 1)) {
	const project = new Project({ useInMemoryFileSystem: true, compilerOptions: { strict: true, target: 99, module: 199 } });
	for (const [path, text] of Object.entries(files)) project.createSourceFile(path, text);
	return analyzeRpcApi(project, entries.map((path) => project.getSourceFileOrThrow(path)));
}

const API = `
import type { Tag } from "./types";

/** Users of the workspace. */
export class UsersApi {
	/**
	 * Finds a user by id.
	 * @param id - The user's id.
	 * @param options - What to include.
	 * @returns The user, or null when there is none.
	 * @throws NotFound when the id is unknown
	 * @example
	 * await rpc.UsersApi.find("u1")
	 */
	async find(id: string, options?: { withTags: boolean }): Promise<User | null> {
		return null;
	}
	/** @deprecated use find */
	lookup(id: string) {
		return this.find(id);
	}
	private secret() {}
	#hidden() {}
	static create() {}
	field = () => 1;
	get label() {
		return "x";
	}
}

/** One user. */
export interface User {
	/** The id. */
	id: string;
	name?: string;
	tags: Tag[];
	joined: Date;
	scores: Map<string, number>;
	avatar: Uint8Array;
	kind: "admin" | "member";
	parent?: User;
}

/** Streams numbers. */
export const Counter = {
	/**
	 * Counts up.
	 * @param to - Where to stop.
	 * @yields Each number.
	 * @returns How many were sent.
	 */
	async *count(to: number, ...steps: number[]): AsyncGenerator<number, number> {
		yield to;
		return 1;
	},
	ping: () => "pong",
	version: "1.0",
	named,
};

/** A function declared elsewhere in the module. */
function named(flag = false): void {}

export function unrelated() {}
export const NotRegistered = { nope() {} };
export default { UsersApi, Counter };
`;

describe("analyzeRpcApi", () => {
	it("follows createRpcServer through a default import to the classes and objects it registers", () => {
		const { schema, diagnostics } = analyze({
			"/server.ts": `import { createRpcServer as start } from "defuss-rpc/server";\nimport Api from "./api";\nstart(Api);`,
			"/api.ts": API,
			"/types.ts": `export type Tag = { label: string };`,
		});
		expect(schema.map((e) => (e.kind === "class" ? e.className : e.moduleName))).toEqual(["UsersApi", "Counter"]);
		const [users, counter] = schema as any[];
		expect(users.description).toBe("Users of the workspace.");
		// the exposure rule: own prototype methods only - a TypeScript private method is one of them, with a warning
		expect(Object.keys(users.methods)).toEqual(["find", "lookup", "secret"]);
		expect(diagnostics).toEqual([
			{
				level: "warning",
				file: "api.ts",
				line: 22,
				message: "UsersApi.secret is private in TypeScript but callable over RPC - name it #secret to hide it",
			},
		]);
		expect(users.methods.find).toMatchObject({
			async: true,
			generator: false,
			description: "Finds a user by id.",
			params: [
				{ name: "id", type: "string", schema: { type: "string" }, description: "The user's id." },
				{
					name: "options",
					type: "{ withTags: boolean; } | undefined",
					optional: true,
					description: "What to include.",
					schema: { type: "object", properties: { withTags: { type: "boolean" } }, required: ["withTags"] },
				},
			],
			returns: { type: "User | null", description: "The user, or null when there is none." },
			throws: ["NotFound when the id is unknown"],
			examples: ['await rpc.UsersApi.find("u1")'],
		});
		const user = users.methods.find.returns.schema.anyOf[0];
		expect(user.properties.id).toEqual({ type: "string", description: "The id." });
		expect(user.required).toEqual(["id", "tags", "joined", "scores", "avatar", "kind"]);
		expect(user.properties.tags).toEqual({ type: "array", items: { type: "object", properties: { label: { type: "string" } }, required: ["label"] } });
		expect(user.properties.joined).toEqual({ type: "string", format: "date-time", "x-dson": "date" });
		expect(user.properties.scores).toEqual({ type: "object", "x-dson": "map", additionalProperties: { type: "number" } });
		expect(user.properties.avatar).toEqual({ type: "string", contentEncoding: "base64", "x-dson": "binary" });
		expect(user.properties.kind).toEqual({ enum: ["admin", "member"] });
		expect(user.properties.parent).toEqual({ $comment: "recursive: User" });
		expect(users.methods.find.returns.schema.anyOf[1]).toEqual({ type: "null" });
		expect(users.methods.lookup).toMatchObject({ async: false, deprecated: "use find" });

		expect(counter.description).toBe("Streams numbers.");
		expect(Object.keys(counter.methods)).toEqual(["count", "ping", "named"]);
		expect(counter.methods.count).toMatchObject({
			async: true,
			generator: true,
			params: [
				{ name: "to", description: "Where to stop." },
				{ name: "steps", rest: true, optional: true, schema: { type: "array", items: { type: "number" } } },
			],
			yields: { type: "number", description: "Each number." },
			returns: { type: "number", description: "How many were sent." },
		});
		expect(counter.methods.ping).toMatchObject({ async: false, generator: false, returns: { type: "string" } });
		expect(counter.methods.named).toMatchObject({
			description: "A function declared elsewhere in the module.",
			params: [{ name: "flag", optional: true, schema: { type: "boolean" } }],
		});
		expect(counter.methods.named.returns).toBeUndefined();
	});

	it("reads an object literal, a spread, a re-export and a namespace import; files without defuss-rpc are skipped", () => {
		const { schema } = analyze(
			{
				"/main.ts": `import * as rpc from "defuss-rpc/server.js";\nimport { Math } from "./barrel";\nconst extra = { Echo: { say: (s: string) => s } };\nrpc.createRpcServer({ Math, ...extra });`,
				"/barrel.ts": `export { MathApi as Math } from "./math";`,
				"/math.ts": `export const MathApi = { add(a: number, b: number) { return a + b; } };`,
				"/other.ts": `import { createRpcServer } from "./local";\ncreateRpcServer({ Nope: { x() {} } });`,
				"/local.ts": `export function createRpcServer(x: unknown) {}`,
			},
			["/main.ts", "/other.ts"],
		);
		expect(schema.map((e) => (e.kind === "class" ? e.className : e.moduleName))).toEqual(["Math", "Echo"]);
		expect((schema[0] as any).methods.add.returns).toEqual({ type: "number", schema: { type: "number" } });
	});

	it("reads a server assigned to a variable and the deprecated global registration", () => {
		const { schema } = analyze({
			"/server.ts": `import { createRpcServer, registerGlobalRpcApi } from "defuss-rpc/server";\nexport const rpc = createRpcServer({ A: { a: () => 1 } });\nregisterGlobalRpcApi({ B: { b: () => "b" } });`,
		});
		expect(schema.map((e) => [e.kind === "class" ? e.className : e.moduleName, Object.keys(e.methods)])).toEqual([
			["A", ["a"]],
			["B", ["b"]],
		]);
	});

	it("reads the api option of the Vite and Astro integrations", () => {
		const { schema } = analyze({
			"/vite.config.ts": `import defussRpc from "defuss-rpc-vite";\nimport { Api } from "./api";\nexport default { plugins: [defussRpc({ api: Api })] };`,
			"/api.ts": `export const Api = { Health: { ok: async () => true } };`,
		});
		expect(schema).toEqual([
			{ kind: "module", moduleName: "Health", methods: { ok: { async: true, generator: false, returns: { type: "boolean", schema: { type: "boolean" } } } } },
		]);
	});

	it("reports what it cannot follow instead of guessing", () => {
		const { schema, diagnostics } = analyze({
			"/server.ts": `import { createRpcServer } from "defuss-rpc/server";\nimport { build } from "./build";\ncreateRpcServer({ Built: build(), [String("x")]: {} });\ncreateRpcServer(build());`,
			"/build.ts": `export function build(): any { return {}; }`,
		});
		expect(schema).toEqual([]);
		expect(diagnostics.map((d) => [d.level, d.line, d.message])).toEqual([
			["warning", 3, "a computed namespace name is left out"],
			["error", 3, "namespace Built: not a class or an object literal the analysis can follow"],
			["error", 4, "the registered API is not an object literal the analysis can follow"],
		]);
	});
});
