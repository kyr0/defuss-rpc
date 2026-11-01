#!/usr/bin/env bun
/**
 * Builds the documentation from the examples: `bun scripts/docs.ts` writes, `--check` only compares.
 *
 * Why generated: every code block of README.md and docs/index.html is a region of a file in examples/, and the e2e
 * test runs those files against the packed package on Node.js, Bun and in browsers. A hand-copied snippet would
 * drift from the tested code; a generated one cannot, and `--check` (part of `make lint`) fails when a page is
 * stale or when a code block appears that no example backs.
 *
 * - docs/index.html: `<pre data-lang="ts" data-src="examples/api.ts#api"><code>` is filled with the region,
 *   highlighted by shiki at build time (no highlighter in the visitor's browser).
 * - README.md and integrations/<name>/README.md: the fence between `<!-- example: examples/api.ts#api -->` and
 *   `<!-- /example -->` is rewritten; paths are relative to the repository root.
 *   VERIFIED: `make lint` (`--check`) reports README.md, both integration READMEs, the website and its script in sync.
 * - docs/assets/site.js: docs/src/site.ts bundled with the defuss-rpc client from dist/ (run `bun run build` first).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHighlighter } from "shiki";

// fileURLToPath, not import.meta.dir: scripts/e2e.mjs imports region() on Node.js.
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PAGE = "docs/index.html";
/** Every README whose code blocks come from examples: the library's and each integration package's. */
const READMES = ["README.md", "integrations/vite/README.md", "integrations/astro/README.md"];
const BUNDLE = "docs/assets/site.js";
const THEME = "github-dark-default";
const LANGS = ["ts", "json", "sh"] as const;
/** Fence languages that are commands or output, not program code; every other fence must come from an example. */
const FREE_FENCES = new Set(["bash", "sh", "text", ""]);

/** The lines of `file` between `#region name` and the next `#endregion`, common indentation removed. */
export function region(file: string, name?: string): string {
	let lines = readFileSync(join(ROOT, file), "utf8").replace(/\n$/, "").split("\n");
	if (name) {
		const start = lines.findIndex((line) => new RegExp(`(?://|<!--) #region ${name}\\b`).test(line));
		const end = lines.findIndex((line, i) => i > start && /(?:\/\/|<!--) #endregion\b/.test(line));
		if (start < 0 || end < 0) throw new Error(`docs: no "#region ${name}" … "#endregion" in ${file}`);
		lines = lines.slice(start + 1, end);
	}
	const indent = Math.min(...lines.filter((line) => line.trim()).map((line) => /^[\t ]*/.exec(line)![0].length));
	return lines.map((line) => line.slice(Number.isFinite(indent) ? indent : 0).replace(/\t/g, "  ")).join("\n");
}

const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const PRE = /(<pre\b[^>]*\bdata-lang="([^"]*)"[^>]*\bdata-src="([^"#]+)(?:#([\w-]+))?"[^>]*><code>)[\s\S]*?(<\/code><\/pre>)/g;

/** docs/index.html with every `data-src` block filled and highlighted; throws for a code block without a source. */
export async function renderPage(html: string): Promise<string> {
	for (const [tag] of html.matchAll(/<pre\b[^>]*>/g)) {
		const lang = /data-lang="([^"]*)"/.exec(tag)?.[1] ?? "";
		if (!/data-src=/.test(tag) && lang !== "sh") throw new Error(`docs: ${PAGE} has a code block without data-src: ${tag}`);
	}
	const highlighter = await createHighlighter({ themes: [THEME], langs: [...LANGS] });
	return html.replace(PRE, (_all, open: string, lang: string, file: string, name: string | undefined, close: string) => {
		const { tokens } = highlighter.codeToTokens(region(file, name), { lang: lang as (typeof LANGS)[number], theme: THEME });
		const lines = tokens.map(
			(line) => `<span>${line.map((token) => `<span style="color:${token.color}">${escape(token.content)}</span>`).join("")}</span>`,
		);
		return `${open}${lines.join("")}${close}`;
	});
}

const EXAMPLE = /(<!-- example: ([^#\s]+)(?:#([\w-]+))? -->\n```(\w+)\n)[\s\S]*?(```\n<!-- \/example -->)/g;

/** A README with every example fence rewritten; throws for a program-code fence outside an example marker. */
export function renderReadme(markdown: string, name = "README.md"): string {
	const outside = markdown.replace(EXAMPLE, "");
	for (const [, lang] of outside.matchAll(/^```(\w*)$/gm)) {
		if (!FREE_FENCES.has(lang)) throw new Error(`docs: ${name} has a \`\`\`${lang} block outside <!-- example: … --> markers`);
	}
	return markdown.replace(EXAMPLE, (_all, open: string, file: string, name: string | undefined, _lang: string, close: string) =>
		`${open}${region(file, name)}\n${close}`,
	);
}

/** The bundled site script: docs/src/site.ts with the client from dist/. */
export async function buildBundle(entry = join(ROOT, "docs/src/site.ts")): Promise<Uint8Array> {
	const result = await Bun.build({ entrypoints: [entry], target: "browser", format: "esm", minify: true });
	if (!result.success) throw new AggregateError(result.logs, "docs: bundling the site script failed");
	return new Uint8Array(await result.outputs[0].arrayBuffer());
}

if (import.meta.main) {
	const check = process.argv.includes("--check");
	const outputs: [string, string | Uint8Array][] = [
		[PAGE, await renderPage(readFileSync(join(ROOT, PAGE), "utf8"))],
		...READMES.map((path): [string, string] => [path, renderReadme(readFileSync(join(ROOT, path), "utf8"), path)]),
		[BUNDLE, await buildBundle()],
	];
	const stale = outputs.filter(([path, content]) => {
		const current = existsSync(join(ROOT, path)) ? readFileSync(join(ROOT, path)) : Buffer.alloc(0);
		return Buffer.compare(current, Buffer.from(content)) !== 0;
	});
	if (check) {
		if (stale.length) {
			console.error(`docs: stale ${stale.map(([path]) => path).join(", ")}; run \`make docs\` and commit the result`);
			process.exit(1);
		}
		console.log(`docs: ${outputs.length} files match examples/ and dist/`);
	} else {
		for (const [path, content] of stale) writeFileSync(join(ROOT, path), content);
		console.log(`docs: wrote ${stale.map(([path]) => path).join(", ") || "nothing (up to date)"}`);
	}
}
