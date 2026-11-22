#!/usr/bin/env node
/**
 * `defuss-rpc schema <files | globs ...>`: writes the documented `/rpc/schema` of an API from its TypeScript source
 * (src/analyze.ts), optionally checked against a running server (`--endpoint`).
 *
 * Why a CLI and not a build plugin: the schema is a file to commit, review and hand to `createRpcServer(api, { docs })`
 * or to an API documentation page; `--check` turns it into a CI step that fails when the source moved on.
 */
import { glob, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Project, ts } from "ts-morph";
import { analyzeRpcApi, reconcileWithServer, type RpcDiagnostic } from "./analyze.js";
import type { RpcApiSchema } from "./types.d.js";

const USAGE = `Usage: defuss-rpc schema <files | globs ...> [options]

Reads every createRpcServer(...) call (and the api option of defuss-rpc-vite / defuss-rpc-astro) in the given
files, follows the registered API to its classes and objects, and prints the schema /rpc/schema serves, with
each method's JSDoc, parameters, return type and JSON Schema. Files that import nothing from defuss-rpc are skipped.

Options:
  --project <tsconfig.json>  the TypeScript project (default: the nearest tsconfig.json)
  --out <file>               write the schema there instead of printing it
  --check                    compare with --out and exit 1 when it is stale (CI)
  --endpoint <url>           check against a running server's /rpc/schema: keep what it serves, warn on differences
  --help                     this text

Exit code 1 when the analysis reports an error, a check finds the file stale or the endpoint does not answer.`;

/** Where the CLI writes: the schema to `out`, diagnostics and summaries to `err`. */
export interface CliOutput {
	out: { write(text: string): unknown };
	err: { write(text: string): unknown };
}

/** Runs the CLI with the given arguments; returns the exit code. */
export async function main(argv: string[], io: CliOutput = { out: process.stdout, err: process.stderr }): Promise<number> {
	const { values, positionals } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: {
			project: { type: "string" },
			out: { type: "string" },
			check: { type: "boolean" },
			endpoint: { type: "string" },
			help: { type: "boolean" },
		},
	});
	const patterns = positionals[0] === "schema" ? positionals.slice(1) : positionals;
	if (values.help || !patterns.length) {
		io.out.write(USAGE + "\n");
		return values.help ? 0 : 1;
	}
	if (values.check && !values.out) {
		io.err.write("--check needs --out <file>\n");
		return 1;
	}

	const files = new Set<string>();
	for (const pattern of patterns) {
		if (!/[*?[{]/.test(pattern)) files.add(resolve(pattern));
		else for await (const file of glob(pattern)) files.add(resolve(file));
	}
	const config = values.project ? resolve(values.project) : ts.findConfigFile(process.cwd(), ts.sys.fileExists);
	const project = config
		? new Project({ tsConfigFilePath: config, skipAddingFilesFromTsConfig: true })
		: new Project({ compilerOptions: { strict: true, allowJs: true, target: ts.ScriptTarget.ES2022 } });
	const sources = [...files].map((file) => project.addSourceFileAtPath(file));
	project.resolveSourceFileDependencies();

	let { schema, diagnostics } = analyzeRpcApi(project, sources);
	if (values.endpoint) {
		const url = values.endpoint.replace(/\/+$/, "");
		const schemaUrl = url.endsWith("/rpc/schema") ? url : `${url}/rpc/schema`;
		let served: RpcApiSchema;
		try {
			const response = await fetch(schemaUrl, { method: "POST" });
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			served = (await response.json()) as RpcApiSchema;
		} catch (error) {
			io.err.write(`${schemaUrl}: no schema (${error instanceof Error ? error.message : String(error)})\n`);
			return 1;
		}
		const reconciled = reconcileWithServer(schema, served, schemaUrl);
		schema = reconciled.schema;
		diagnostics = [...diagnostics, ...reconciled.diagnostics];
	}
	for (const d of diagnostics) io.err.write(format(d) + "\n");
	const text = JSON.stringify(schema, null, 2) + "\n";
	const failed = diagnostics.some((d) => d.level === "error");

	if (values.check) {
		const current = await readFile(values.out!, "utf8").catch(() => "");
		if (current !== text) {
			io.err.write(`${values.out} is stale - run defuss-rpc schema without --check\n`);
			return 1;
		}
		return failed ? 1 : 0;
	}
	if (values.out) {
		const out = resolve(values.out);
		await mkdir(dirname(out), { recursive: true });
		const tmp = `${out}.${process.pid}.tmp`;
		try {
			await writeFile(tmp, text);
			await rename(tmp, out);
		} finally {
			await rm(tmp, { force: true });
		}
		io.err.write(`${values.out}: ${schema.length} namespace(s), ${schema.reduce((n, e) => n + Object.keys(e.methods).length, 0)} method(s)\n`);
	} else io.out.write(text);
	return failed ? 1 : 0;
}

const format = (d: RpcDiagnostic) => `${d.line ? `${d.file}:${d.line}` : d.file}: ${d.level}: ${d.message}`;

// run as a program, not when a test imports main()
if (process.argv[1] && /(^|[/\\])(cli\.(m?js|ts)|defuss-rpc)$/.test(process.argv[1]))
	main(process.argv.slice(2)).then((code) => process.exit(code));
