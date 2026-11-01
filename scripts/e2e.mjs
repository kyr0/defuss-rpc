/**
 * End-to-end test of the publishable artifact: `node scripts/e2e.mjs` (or `make e2e`).
 *
 * Why the tarballs and not the source tree: users install the packed packages, so this run packs defuss-rpc and the
 * integration packages (integrations/vite, integrations/astro), installs them into a clean consumer project and runs
 * everything the documentation shows from there. A broken exports map, a
 * file missing from `files`, a CommonJS build that does not load, or a README snippet that no longer works fails
 * here, even when every unit test passes.
 *
 * Steps, each one asserted:
 * 1. Pack all three; each tarball holds only package.json, README.md, LICENSE and dist/ files, and every export target.
 * 2. Every entry point loads with `import`, and with `require` where it has a CommonJS build, with and without the
 *    `.js` suffix; on Node.js, except the bunway provider, which loads on Bun only.
 * 3. The demo servers of examples/ start: ExpressRpcServer without a provider (Bun.serve, Bun), on Express (Node.js
 *    and Bun) and on bunway (Bun), and `rpcRoute` in a hand-written Bun.serve (Bun).
 * 4. examples/client.ts runs on Node.js and Bun against every server and prints what its comments say; the raw
 *    stream matches examples/wire.ndjson; the Express example's own route answers next to the RPC routes.
 * 5. The Vite and Astro examples start their dev servers on Bun, whose RPC servers take the default provider and
 *    port 63920; Chromium sees the RPC result in the page.
 * 6. The website, with its script bundled from the installed package, is driven in Chromium and WebKit against
 *    every server: every demo, every code block (equal to its example region), anchors, theme, mobile layout,
 *    the offline state. Console errors, failed requests and HTTP errors fail the run.
 * Evidence: output/e2e/report.json, screenshots and process logs in output/e2e/.
 * VERIFIED: Node.js cannot import bunway 1.1.0 (its files import each other without extensions), so step 2 loads the
 * bunway entry point with Bun.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, webkit } from "playwright";
import { serveSite } from "./serve.mjs";
import { region } from "./docs.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const WORK = join(ROOT, "tmp/e2e");
const CONSUMER = join(WORK, "consumer");
const OUTPUT = join(ROOT, "output/e2e");
const pkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
const checks = [];
const processes = [];
/** A 2×2 PNG, so the demo's image preview draws something. */
const PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP4z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==",
	"base64",
);


const check = (name) => {
	checks.push(name);
	console.info(`${new Date().toISOString()} INFO e2e pass ${name}`);
};
const run = (command, args, cwd, env = {}) =>
	execFileSync(command, args, { cwd, env: { ...process.env, ...env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** Terminal color codes, which dev servers print around their URLs. */
const ANSI_COLOR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

/** Starts a long-running process, logs its output to output/e2e/logs and resolves with the first `ready` match. */
function start(name, command, args, { cwd = CONSUMER, env = {}, ready }) {
	const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
	processes.push(child);
	let log = "";
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`${name}: not ready after 60 s\n${log}`)), 60_000);
		const onData = (chunk) => {
			log += chunk;
			const match = ready.exec(log.replace(ANSI_COLOR, ""));
			if (match) {
				clearTimeout(timer);
				resolve({ child, match, log: () => log });
			}
		};
		child.stdout.on("data", onData);
		child.stderr.on("data", onData);
		child.on("exit", (code) => {
			clearTimeout(timer);
			void writeFile(join(OUTPUT, "logs", `${name}.log`), log);
			reject(new Error(`${name} exited with ${code} before it was ready\n${log}`));
		});
	});
}

const freePort = () =>
	new Promise((resolve) => {
		const server = createServer().listen(0, "127.0.0.1", () => {
			const { port } = server.address();
			server.close(() => resolve(port));
		});
	});

/** Expected output of a script: the comment after each `console.log(…); //` line, in order. */
const expectedOutput = (source) => [...source.matchAll(/^\s*console\.log\(.*\); \/\/ (.*)$/gm)].map((m) => m[1]);

try {
	await rm(WORK, { recursive: true, force: true });
	await rm(OUTPUT, { recursive: true, force: true });
	await mkdir(CONSUMER, { recursive: true });
	await mkdir(join(OUTPUT, "logs"), { recursive: true });

	// 1. pack -----------------------------------------------------------------
	/** package name → manifest, for defuss-rpc and the integration packages. */
	const manifests = {};
	const tarballs = [];
	for (const dir of [".", "integrations/vite", "integrations/astro"]) {
		const cwd = join(ROOT, dir);
		const manifest = JSON.parse(await readFile(join(cwd, "package.json"), "utf8"));
		run("bun", ["run", "build"], cwd);
		const tarball = join(WORK, basename(run("bun", ["pm", "pack", "--destination", WORK, "--quiet"], cwd).trim().split("\n").at(-1)));
		const files = run("tar", ["-tzf", tarball], WORK).split("\n").filter(Boolean).map((f) => f.replace(/^package\//, ""));
		const shipped = (f) => ["package.json", "README.md", "LICENSE"].includes(f) || /^dist\/(?:providers\/)?[\w-]+\.(?:mjs|cjs|d\.mts|d\.cts)$/.test(f);
		assert.deepEqual(files.filter((f) => !shipped(f)), [], `${manifest.name}: tarball holds only package.json, README.md, LICENSE and dist/ builds`);
		const targets = [...new Set(JSON.stringify(manifest.exports).match(/\.\/dist\/[^"]+/g).map((t) => t.slice(2)))];
		assert.deepEqual(targets.filter((t) => !files.includes(t)), [], `${manifest.name}: every export target is in the tarball`);
		check(`tarball ${basename(tarball)}: ${files.length} files, ${targets.length} export targets`);
		manifests[manifest.name] = manifest;
		tarballs.push(tarball);
	}

	// 2. clean consumer, entry points ----------------------------------------------
	await writeFile(join(CONSUMER, "package.json"), JSON.stringify({ name: "consumer", private: true, type: "module" }, null, 2));
	// The frameworks at the versions this repository tests: the providers' from defuss-rpc, Vite's and Astro's from
	// the integration packages, which own those dependencies.
	const versions = { ...pkg.devDependencies, ...manifests["defuss-rpc-vite"].devDependencies, ...manifests["defuss-rpc-astro"].devDependencies };
	const frameworks = ["express", "bunway", "vite", "astro"].map((name) => `${name}@${versions[name]}`);
	run("bun", ["add", ...tarballs, ...frameworks], CONSUMER);
	// The tsconfig files map imports to this repository's sources for type checks; the consumer uses the packages.
	const copy = (from) => cp(join(ROOT, from), join(CONSUMER, from), { recursive: true, filter: (src) => !/tsconfig\.json$|(^|\/)(node_modules|\.astro)(\/|$)/.test(src) });
	await copy("examples");
	await copy("integrations/vite/example");
	await copy("integrations/astro/example");
	await cp(join(ROOT, "docs/src"), join(CONSUMER, "docs/src"), { recursive: true });
	// bunway 1.1.0 imports its own files without extensions, which only Bun resolves.
	const bunOnly = (key) => key.startsWith("./providers/bunway");
	const exported = Object.entries(manifests).flatMap(([name, manifest]) =>
		Object.entries(manifest.exports).filter(([k]) => k !== "./package.json" && !bunOnly(k)).map(([k, target]) => [`${name}${k.slice(1)}`, target]),
	);
	const entries = exported.map(([id]) => id);
	// The bunway provider is ESM only; every other entry point has a CommonJS build too.
	const commonjs = exported.filter(([, target]) => target.require).map(([id]) => id);
	await writeFile(
		join(CONSUMER, "entries.mjs"),
		`import { createRequire } from "node:module";
		const require = createRequire(import.meta.url);
		const commonjs = new Set(${JSON.stringify(commonjs)});
		for (const id of ${JSON.stringify(entries)}) {
			const esm = await import(id);
			if (Object.keys(esm).length === 0) throw new Error(id);
			if (commonjs.has(id) && Object.keys(esm).sort().join() !== Object.keys(require(id)).sort().join()) throw new Error(id);
		}
		const { getRpcClient } = await import("defuss-rpc/client");
		const { rpcRoute } = require("defuss-rpc/server");
		if (typeof getRpcClient !== "function" || typeof rpcRoute !== "function") throw new Error("api");
		console.log("ok");`,
	);
	assert.equal(run("node", ["entries.mjs"], CONSUMER).trim(), "ok");
	const bunEntries = Object.keys(pkg.exports).filter(bunOnly).map((k) => `defuss-rpc${k.slice(1)}`);
	const loaded = `for (const id of ${JSON.stringify(bunEntries)}) if (typeof (await import(id)).bunwayProvider !== "function") throw new Error(id); console.log("ok");`;
	assert.equal(run("bun", ["-e", loaded], CONSUMER).trim(), "ok");
	check(`${entries.length} entry points of ${Object.keys(manifests).join(", ")} load on Node.js as ESM, ${commonjs.length} of them as CommonJS too; ${bunEntries.length} on Bun`);

	// 3. servers ------------------------------------------------------------------
	const listening = /rpc server listening url=(\S+)/;
	const demos = [
		["Express on Node.js", "node", "examples/server-express.ts"],
		["Express on Bun", "bun", "examples/server-express.ts"],
		["bunway on Bun", "bun", "examples/server-bunway.ts"],
		["no provider (Bun.serve) on Bun", "bun", "examples/server-bun.ts"],
		["rpcRoute in Bun.serve on Bun", "bun", "examples/server-route.ts"],
	];
	/** label → { url, runtime }; runtime is what the website's status badge shows. */
	const servers = {};
	for (const [label, runtime, file] of demos) {
		const name = label.replace(/\W+/g, "-").toLowerCase();
		const { match } = await start(name, runtime, [file], { env: { PORT: "0" }, ready: listening });
		servers[label] = { url: match[1], runtime: runtime === "bun" ? "Bun" : "Node.js" };
	}
	check(`demo servers: ${Object.entries(servers).map(([label, { url }]) => `${label} ${url}`).join(", ")}`);

	// 4. client script on both runtimes against both servers --------------------------------
	const clientSource = await readFile(join(ROOT, "examples/client.ts"), "utf8");
	const expected = expectedOutput(clientSource);
	assert.ok(expected.length >= 8, "examples/client.ts states its output");
	const wire = await readFile(join(ROOT, "examples/wire.ndjson"), "utf8");
	for (const [server, { url }] of Object.entries(servers)) {
		for (const runtime of ["node", "bun"]) {
			const printed = run(runtime, ["examples/client.ts"], CONSUMER, { RPC_URL: url }).trimEnd().split("\n");
			assert.deepEqual(printed, expected, `${runtime} examples/client.ts against the ${server} server`);
			check(`examples/client.ts on ${runtime} against ${server}: ${printed.length} lines as documented`);
		}
		const raw = await fetch(`${url}/rpc`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ className: "ChatApi", methodName: "reply", args: ["hi there"] }),
		});
		assert.equal(raw.headers.get("content-type"), "application/x-ndjson");
		assert.equal(await raw.text(), wire, `examples/wire.ndjson is the ${server} server's stream`);
		check(`${server} stream equals examples/wire.ndjson`);
	}
	for (const label of ["Express on Node.js", "Express on Bun", "no provider (Bun.serve) on Bun"]) {
		assert.deepEqual(await (await fetch(`${servers[label].url}/version`)).json(), { version: 1 }, `${label}: getApp() route`);
	}
	check("examples/server-express.ts and server-bun.ts: their own /version route answers next to the RPC routes");

	const browsers = { chromium: await chromium.launch(), webkit: await webkit.launch() };
	try {
		// 5. Vite and Astro dev servers ---------------------------------------------------
		// Both examples use the default port; a server left running there (`make start`) would answer instead.
		const DEFAULT_RPC = "http://127.0.0.1:63920";
		await assert.rejects(fetch(`${DEFAULT_RPC}/health`), `port 63920 is taken; stop what runs there (make stop) before make e2e`);
		const stopped = (child) => new Promise((resolve) => (child.once("exit", resolve), child.kill("SIGTERM")));
		const page = await browsers.chromium.newPage();
		const vitePort = await freePort();
		const vite = await start("vite", "bun", ["--bun", "node_modules/vite/bin/vite.js", "integrations/vite/example", "--host", "127.0.0.1", "--port", String(vitePort), "--strictPort"], {
			ready: /Local:\s+(http:\/\/127\.0\.0\.1:\d+\/)/,
		});
		assert.match(vite.log(), /rpc server listening url=http:\/\/127\.0\.0\.1:63920 provider=bun/, "Vite: default provider and port");
		await page.goto(vite.match[1]);
		await page.locator("#sum").filter({ hasText: "5" }).waitFor();
		check(`Vite dev server on Bun ${vite.match[1]}: RPC server on Bun.serve at ${DEFAULT_RPC}, page called MathApi.add`);
		await stopped(vite.child);

		// --ignore-lock: Astro 7 moves `astro dev` into a detached background process when it detects a coding agent.
		const astroPort = await freePort();
		const astro = await start("astro", "bun", ["--bun", "node_modules/astro/bin/astro.mjs", "dev", "--ignore-lock", "--root", "integrations/astro/example", "--host", "127.0.0.1", "--port", String(astroPort)], {
			env: { ASTRO_TELEMETRY_DISABLED: "1" },
			ready: /Local\s+(http:\/\/127\.0\.0\.1:\d+\/)/,
		});
		await page.goto(astro.match[1]);
		await page.locator("#sum").filter({ hasText: "5" }).waitFor();
		const astroEndpoint = await page.locator("#endpoint").textContent();
		assert.equal(astroEndpoint, DEFAULT_RPC, "Astro.locals.rpcEndpoint is the RPC server on the default port");
		check(`Astro dev server on Bun ${astro.match[1]}: locals.rpcEndpoint=${astroEndpoint}, client call answered`);
		await page.close();
		await stopped(astro.child);

		// 6. website -----------------------------------------------------------------------
		const bundle = await Bun_build(join(CONSUMER, "docs/src/site.ts"));
		const siteScript = join(WORK, "site.js");
		await writeFile(siteScript, bundle);
		const site = await serveSite({ overrides: { "/assets/site.js": siteScript } });
		try {
			for (const path of ["/../package.json", "/%2e%2e/package.json", "/missing.html"]) {
				assert.ok([403, 404].includes((await fetch(site.url + path)).status), `site server refuses ${path}`);
			}
			const html = await readFile(join(ROOT, "docs/index.html"), "utf8");
			const sources = [...html.matchAll(/data-src="([^"#]+)(?:#([\w-]+))?"/g)].map(([, file, name]) => ({
				src: name ? `${file}#${name}` : file,
				text: region(file, name),
			}));
			for (const [browserName, browser] of Object.entries(browsers)) {
				for (const [server, { url, runtime }] of Object.entries(servers)) {
					await driveSite({ browserName, browser, siteUrl: site.url, server, runtime, rpcUrl: url, sources });
					check(`website in ${browserName} against the ${server} server: demos, ${sources.length} code blocks, anchors, layout`);
				}
				await offlineState(browser, site.url);
				check(`website in ${browserName}: offline state without a server`);
			}
		} finally {
			site.server.close();
		}
	} finally {
		for (const browser of Object.values(browsers)) await browser.close();
	}

	const report = {
		finishedAt: new Date().toISOString(),
		tarballs: await Promise.all(tarballs.map(async (file) => ({ file: basename(file), bytes: (await stat(file)).size }))),
		node: process.version,
		bun: run("bun", ["--version"], ROOT).trim(),
		checks,
	};
	await writeFile(join(OUTPUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
	console.info(`${new Date().toISOString()} INFO e2e PASS checks=${checks.length} report=output/e2e/report.json`);
} finally {
	for (const child of processes) child.kill("SIGTERM");
}

/** Bundles the site script with Bun from the consumer, so the page runs the installed package's client. */
async function Bun_build(entry) {
	const out = join(WORK, "bundle");
	run("bun", ["build", entry, "--target=browser", "--format=esm", "--minify", "--outdir", out], CONSUMER);
	return readFile(join(out, "site.js"));
}

/** Tracks page errors, console errors, failed requests and HTTP errors; `assertClean()` fails on any. */
function watch(page) {
	const errors = [];
	page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
	page.on("console", (message) => message.type() === "error" && errors.push(`console: ${message.text()}`));
	page.on("requestfailed", (request) => {
		const reason = request.failure()?.errorText ?? "";
		// The client closes its upload-progress EventSource once the upload POST answers (src/client.ts); a stream the
		// server has not ended yet is then cancelled by the page itself. VERIFIED: WebKit reported it as "cancelled"
		// once against Bun.serve (2026-11-01) after the upload demo had passed; any other failure still counts.
		if (request.url().includes("/rpc/upload/progress/") && /^(?:cancelled|net::ERR_ABORTED)$/.test(reason)) return;
		errors.push(`failed: ${request.url()} ${reason}`);
	});
	page.on("response", (response) => response.status() >= 400 && errors.push(`HTTP ${response.status()}: ${response.url()}`));
	return { assertClean: (where) => assert.deepEqual(errors, [], where) };
}

async function driveSite({ browserName, browser, siteUrl, server, runtime, rpcUrl, sources }) {
	const context = await browser.newContext();
	if (browserName === "chromium") await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: siteUrl });
	const page = await context.newPage();
	const { assertClean } = watch(page);
	await page.goto(`${siteUrl}/?rpc=${encodeURIComponent(rpcUrl)}`);
	const where = `${browserName}/${server}`;
	const shot = `site-${browserName}-${server.replace(/\W/g, "")}`;

	// connection and runtime badge
	await page.locator("#server-status").filter({ hasText: `connected · ${runtime}` }).waitFor();
	await page.screenshot({ path: join(OUTPUT, `${shot}-top.png`) });

	// calls
	await page.locator("#add-a").fill("40");
	await page.locator("#add-b").fill("2");
	await page.locator("#add-form button").click();
	await page.locator("#add-result").filter({ hasText: "= 42" }).waitFor();
	await page.locator("#greet-name").fill("Grace");
	await page.locator("#greet-form button").click();
	await page.locator("#greet-result").filter({ hasText: "Hello, Grace!" }).waitFor();

	// streaming: every word is its own frame, then the return value
	await page.locator("#stream-prompt").fill("one two three");
	await page.locator("#stream-form button").click();
	await page.locator("#stream-meta[data-frames='5']").waitFor();
	assert.equal((await page.locator("#stream-output").textContent())?.trim(), "You said: one two three", where);
	assert.match((await page.locator("#stream-meta").textContent()) ?? "", /return value "done"/, where);

	// DSON types arrive as instances
	await page.locator("#types-run").click();
	await page.locator("#types-table").waitFor();
	const types = await page.locator("#types-table tbody tr").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-type")));
	assert.deepEqual(types, ["Date", "Set", "Map", "bigint", "Uint8Array"], where);

	await page.locator("#demo").scrollIntoViewIfNeeded();
	await page.screenshot({ path: join(OUTPUT, `${shot}-demo.png`) });

	// file round trip: upload with progress, SHA-256 compared, download, preview
	await page.locator("#file-input").setInputFiles({ name: "pixel.png", mimeType: "image/png", buffer: PNG });
	await page.locator("#file-match").filter({ hasText: "match" }).waitFor();
	await page.locator("#file-preview[data-drawn='true']").waitFor();
	assert.match((await page.locator("#file-download").getAttribute("href")) ?? "", /^blob:/, where);
	assert.equal(await page.locator("#file-download").getAttribute("download"), "pixel.png", where);
	const large = Buffer.alloc(3 * 1024 * 1024, 7);
	await page.locator("#file-input").setInputFiles({ name: "Übersicht 2026.bin", mimeType: "application/octet-stream", buffer: large });
	await page.locator("#file-download").filter({ hasText: "Übersicht 2026.bin (3,145,728 bytes)" }).waitFor();
	assert.equal(await page.locator("#file-match").textContent(), "match", where);
	assert.equal(await page.locator("#recv-progress").evaluate((el) => el.value), 100, where);

	// code blocks are the example regions, unchanged
	const shown = await page.locator("pre[data-src]").evaluateAll((pres) =>
		pres.map((pre) => ({ src: pre.dataset.src, text: [...pre.querySelectorAll("code > span")].map((l) => l.textContent).join("\n") })),
	);
	assert.deepEqual(shown, sources.map(({ src, text }) => ({ src, text: text.replace(/\t/g, "  ") })), `${where}: code blocks equal examples/`);

	// copy button (Chromium grants clipboard access to tests)
	if (browserName === "chromium") {
		const block = page.locator("#src-files .mk-code-block");
		await block.locator(".mk-code-block-copy").click();
		await block.locator(".mk-code-block-status").filter({ hasText: "Copied" }).waitFor();
		assert.equal(await page.evaluate(() => navigator.clipboard.readText()), sources.find((s) => s.src === "examples/files.ts#files").text, where);
	}

	// tabs switch panels
	await page.locator("#srv-tab-route").click();
	await page.locator("#srv-route").waitFor({ state: "visible" });

	// every in-page link has a target
	const missing = await page.evaluate(() =>
		[...document.querySelectorAll('a[href^="#"]')].map((a) => a.getAttribute("href").slice(1)).filter((id) => id && !document.getElementById(id)),
	);
	assert.deepEqual(missing, [], `${where}: anchors`);

	// theme toggle
	const dark = await page.evaluate(() => document.documentElement.classList.contains("dark"));
	await page.locator(".swap").first().click();
	assert.equal(await page.evaluate(() => document.documentElement.classList.contains("dark")), !dark, `${where}: theme toggle`);

	// phone width: no horizontal scrolling
	await page.setViewportSize({ width: 390, height: 844 });
	assert.ok(await page.evaluate(() => document.scrollingElement.scrollWidth <= window.innerWidth + 1), `${where}: no horizontal scroll at 390px`);
	await page.setViewportSize({ width: 1280, height: 900 });
	await page.screenshot({ path: join(OUTPUT, `${shot}-full.png`), fullPage: true });
	assertClean(where);
	await context.close();
}

/** Without a server the demo says how to start one and disables its controls. */
async function offlineState(browser, siteUrl) {
	const page = await browser.newPage();
	await page.goto(`${siteUrl}/?rpc=${encodeURIComponent("http://127.0.0.1:9")}`);
	await page.locator("#offline").waitFor({ state: "visible" });
	assert.equal(await page.locator("#server-status").textContent(), "offline");
	assert.ok(await page.locator("#add-form button").isDisabled());
	await page.close();
}
