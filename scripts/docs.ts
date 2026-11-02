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
 * - docs/assets/site.js: docs/src/site.ts bundled (theme toggle, copy buttons; no dependencies).
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
/**
 * The version the npm badges show: package.json's, the version this page documents, so a version bump updates the page
 * with `make docs` and `--check` fails while it shows another. Why not npm's latest, looked up by the page: between a
 * version bump and its publish npm holds the previous major, whose API differs from the one documented here.
 */
const VERSION: string = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
const THEME = "github-dark-default";
const LANGS = ["ts", "json", "sh"] as const;
/** Fence languages that are commands or output, not program code; every other fence must come from an example. */
const FREE_FENCES = new Set(["bash", "sh", "text", "mermaid", ""]);

/** A `#region` or `#endregion` marker line; markers of nested regions never show in a code block. */
const MARKER = /(?:\/\/|<!--) #(?:end)?region\b/;

/**
 * The lines of `file` between `#region name` and `#endregion name`, common indentation removed. Regions may nest (the
 * website shows `chat` of examples/api.ts beside the client, the README the whole `api` around it), so the end marker
 * names its region and the markers inside are dropped.
 */
export function region(file: string, name?: string): string {
	let lines = readFileSync(join(ROOT, file), "utf8").replace(/\n$/, "").split("\n");
	if (name) {
		const start = lines.findIndex((line) => new RegExp(`(?://|<!--) #region ${name}\\b`).test(line));
		const end = lines.findIndex((line, i) => i > start && new RegExp(`(?://|<!--) #endregion ${name}\\b`).test(line));
		if (start < 0 || end < 0) throw new Error(`docs: no "#region ${name}" … "#endregion ${name}" in ${file}`);
		lines = lines.slice(start + 1, end).filter((line) => !MARKER.test(line));
	}
	const indent = Math.min(...lines.filter((line) => line.trim()).map((line) => /^[\t ]*/.exec(line)![0].length));
	return lines.map((line) => line.slice(Number.isFinite(indent) ? indent : 0).replace(/\t/g, "  ")).join("\n");
}

/**
 * The longest line a code block may show. Why a limit and not wrapping: the website shows client and server code side
 * by side, each block in half of the section, and a wrapped line splits an expression where the reader cannot see it;
 * a short line also reads better in a README. VERIFIED: in Chromium at 1280 and 1440 px a block in a diff fits 68
 * characters, and no line of the Files diff wraps (Playwright measurement of docs/, 2026-11-02).
 */
const WIDTH = { diff: 64, block: 80 } as const;

/** The region, after checking that no line is longer than `limit`. */
function shown(file: string, name: string | undefined, limit: number): string {
	const code = region(file, name);
	const long = code.split("\n").find((line) => line.length > limit);
	if (long !== undefined) {
		throw new Error(`docs: ${file}${name ? `#${name}` : ""} has a line over ${limit} characters (${long.length}): ${long.trim()}`);
	}
	return code;
}

/** Whether the code block at `offset` sits in a client/server diff: after a diff's start, before its divider input. */
function inDiff(html: string, offset: number): boolean {
	const before = html.slice(0, offset);
	const start = before.lastIndexOf('<figure class="diff');
	return start >= 0 && !before.slice(start).includes('class="diff-range"');
}

const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const PRE = /(<pre\b[^>]*\bdata-lang="([^"]*)"[^>]*\bdata-src="([^"#]+)(?:#([\w-]+))?"[^>]*><code>)[\s\S]*?(<\/code><\/pre>)/g;

/**
 * Highlighted lines as the page holds them: one `<span>` per line, one colored `<span>` per token. Why at build time
 * and not a highlighter script in the page: the page ships no highlighter, shows colors without JavaScript, and the
 * copy button reads the plain text back from the line spans. VERIFIED: scripts/e2e.mjs fails when a `pre` on the
 * page has no colored token, in Chromium and WebKit.
 */
function highlightLines(highlighter: Awaited<ReturnType<typeof createHighlighter>>, code: string, lang: string): string {
	const { tokens } = highlighter.codeToTokens(code, { lang: lang as (typeof LANGS)[number], theme: THEME });
	return tokens
		.map((line) => `<span>${line.map((token) => `<span style="color:${token.color}">${escape(token.content)}</span>`).join("")}</span>`)
		.join("");
}

/**
 * The text of a code block's HTML: highlighted (one `<span>` per line) or plain lines. Inverse of highlightLines, so
 * `make docs` can highlight the page's own shell blocks again on every run without nesting spans.
 */
function codeText(inner: string): string {
	const decode = (text: string) =>
		text.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
	return inner.startsWith("<span>") ? inner.split("<span>").slice(1).map(decode).join("\n") : decode(inner).trim();
}

/** Shell commands written in the page itself (no `data-src`): commands, not program code, so no example backs them. */
const SHELL = /(<pre\b(?![^>]*\bdata-src=)[^>]*\bdata-lang="sh"[^>]*><code>)([\s\S]*?)(<\/code><\/pre>)/g;

/**
 * docs/index.html with every `data-src` block filled and every block highlighted, shell commands included, and the
 * npm badges at VERSION; throws for a program-code block without a source and for a line longer than WIDTH allows.
 */
export async function renderPage(html: string): Promise<string> {
	for (const [tag] of html.matchAll(/<pre\b[^>]*>/g)) {
		const lang = /data-lang="([^"]*)"/.exec(tag)?.[1] ?? "";
		if (!/data-src=/.test(tag) && lang !== "sh") throw new Error(`docs: ${PAGE} has a code block without data-src: ${tag}`);
	}
	const highlighter = await createHighlighter({ themes: [THEME], langs: [...LANGS] });
	return html
		.replace(PRE, (_all, open: string, lang: string, file: string, name: string | undefined, close: string, offset: number) => {
			const code = shown(file, name, inDiff(html, offset) ? WIDTH.diff : WIDTH.block);
			return `${open}${highlightLines(highlighter, code, lang)}${close}`;
		})
		.replace(SHELL, (_all, open: string, inner: string, close: string) => `${open}${highlightLines(highlighter, codeText(inner), "sh")}${close}`)
		.replace(/(<span data-fact="version">)[^<]*(<\/span>)/g, `$1v${VERSION}$2`);
}

const EXAMPLE = /(<!-- example: ([^#\s]+)(?:#([\w-]+))? -->\n```(\w+)\n)[\s\S]*?(```\n<!-- \/example -->)/g;

/** A README with every example fence rewritten; throws for a program-code fence outside an example marker. */
export function renderReadme(markdown: string, name = "README.md"): string {
	const outside = markdown.replace(EXAMPLE, "");
	for (const [, lang] of outside.matchAll(/^```(\w*)$/gm)) {
		if (!FREE_FENCES.has(lang)) throw new Error(`docs: ${name} has a \`\`\`${lang} block outside <!-- example: … --> markers`);
	}
	return markdown.replace(EXAMPLE, (_all, open: string, file: string, name: string | undefined, _lang: string, close: string) =>
		`${open}${shown(file, name, WIDTH.block)}\n${close}`,
	);
}

/** The bundled site script: docs/src/site.ts. */
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
