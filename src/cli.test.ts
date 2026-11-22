import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./cli.js";
import { clearRpcServer } from "./server.js";
import { expressProvider } from "./providers/express.js";
import { startServer } from "./test/server.js";

/** Runs the CLI with captured output. */
async function run(args: string[]) {
	let out = "";
	let err = "";
	const code = await main(args, {
		out: { write: (s: string) => (out += s) },
		err: { write: (s: string) => (err += s) },
	});
	return { code, out, err };
}

let dir: string;
beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "defuss-rpc-cli-"));
	await writeFile(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, target: "ES2022", module: "NodeNext" } }));
	await writeFile(
		join(dir, "api.ts"),
		`/** Notes. */
export const Notes = {
	/**
	 * Adds a note.
	 * @param text - What it says.
	 */
	async add(text: string) {
		return { id: 1, text };
	},
	async remove(id: number) {
		return true;
	},
};
export default { Notes };
`,
	);
	await writeFile(join(dir, "server.ts"), `import { createRpcServer } from "defuss-rpc/server";\nimport api from "./api.js";\ncreateRpcServer(api);\n`);
	await writeFile(join(dir, "helper.ts"), `export const unrelated = 1;\n`);
});
afterAll(async () => {
	await clearRpcServer();
	await rm(dir, { recursive: true, force: true });
});

describe("defuss-rpc schema", () => {
	it("prints the documented schema of the files a glob names, skipping files without defuss-rpc", async () => {
		const { code, out, err } = await run(["schema", join(dir, "*.ts"), "--project", join(dir, "tsconfig.json")]);
		expect(err).toBe("");
		expect(code).toBe(0);
		const [notes] = JSON.parse(out);
		expect(notes).toMatchObject({ kind: "module", moduleName: "Notes", description: "Notes." });
		expect(notes.methods.add).toMatchObject({
			async: true,
			description: "Adds a note.",
			params: [{ name: "text", type: "string", description: "What it says." }],
			returns: { type: "{ id: number; text: string; }" },
		});
	});

	it("--out writes the file, --check passes while it is current and fails once the source moved on", async () => {
		const out = join(dir, "rpc.docs.json");
		const base = ["schema", join(dir, "server.ts"), "--project", join(dir, "tsconfig.json"), "--out", out];
		expect((await run(base)).code).toBe(0);
		expect(JSON.parse(await readFile(out, "utf8"))[0].moduleName).toBe("Notes");
		expect((await run([...base, "--check"])).code).toBe(0);
		const api = await readFile(join(dir, "api.ts"), "utf8");
		await writeFile(join(dir, "api.ts"), api.replace("What it says.", "Its text."));
		const stale = await run([...base, "--check"]);
		expect(stale.code).toBe(1);
		expect(stale.err).toContain("rpc.docs.json is stale");
		await writeFile(join(dir, "api.ts"), api);
	});

	it("--endpoint keeps what the running server serves and names every difference", async () => {
		// the running server: remove() is gone, archive() is new, add() streams
		const server = await startServer(expressProvider(), {
			Notes: {
				async *add(text: string) {
					yield text;
				},
				async archive() {},
			},
			Extra: { ping: () => "pong" },
		});
		try {
			const { code, out, err } = await run(["schema", join(dir, "server.ts"), "--project", join(dir, "tsconfig.json"), "--endpoint", server.url]);
			expect(code).toBe(0);
			const [notes, extra] = JSON.parse(out);
			expect(Object.keys(notes.methods)).toEqual(["add", "archive"]);
			expect(notes.methods.add).toMatchObject({ async: true, generator: true, description: "Adds a note." });
			expect(notes.methods.archive).toEqual({ async: true, generator: false });
			expect(extra).toEqual({ kind: "module", moduleName: "Extra", methods: { ping: { async: false, generator: false } } });
			const lines = err.trim().split("\n").map((l) => l.replace(/^.*?: warning: /, ""));
			expect(lines).toEqual([
				"Notes.add: the source says async=true generator=false, the server true / true - the server's flags are kept",
				"Notes.archive is served but not found in the source - kept without documentation",
				"Notes.remove is in the source but not served - left out",
				"namespace Extra is served but not found in the source - kept without documentation",
			]);
		} finally {
			await server.stop();
		}
	});

	it("an endpoint that does not answer, an error in the analysis and a missing argument exit 1", async () => {
		const offline = await run(["schema", join(dir, "server.ts"), "--endpoint", "http://127.0.0.1:9"]);
		expect(offline.code).toBe(1);
		expect(offline.err).toMatch(/127\.0\.0\.1:9\/rpc\/schema: no schema/);
		await writeFile(join(dir, "broken.ts"), `import { createRpcServer } from "defuss-rpc/server";\ndeclare const make: () => any;\ncreateRpcServer(make());\n`);
		const broken = await run(["schema", join(dir, "broken.ts"), "--project", join(dir, "tsconfig.json")]);
		expect(broken.code).toBe(1);
		expect(broken.err).toMatch(/broken\.ts:3: error: the registered API is not an object literal/);
		expect((await run([])).code).toBe(1);
		expect((await run(["--help"])).out).toContain("Usage: defuss-rpc schema");
		expect((await run(["x.ts", "--check"])).err).toContain("--check needs --out");
	});
});
