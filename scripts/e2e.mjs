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
 * 6. examples/browser.ts, bundled by Bun from the consumer, uploads and downloads two files in Chromium and WebKit
 *    against every server; the browser's SHA-256 equals the server's and the downloaded bytes' hash.
 * 7. The website (static: no RPC server behind it) in Chromium and WebKit: every code block equals its example region
 *    and is highlighted, the four sequence diagrams draw their wires, the client/server diffs move their divider, tabs,
 *    anchors, the npm badges' version, theme toggle, a copy button inside a diff, the footer portrait,
 *    mobile layout. Console errors, failed requests and HTTP errors fail the run.
 * Evidence: output/e2e/report.json, screenshots and process logs in output/e2e/.
 * VERIFIED: Node.js cannot import bunway 1.1.0 (its files import each other without extensions), so step 2 loads the
 * bunway entry point with Bun.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
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
/** A 2×2 PNG, the small file of the browser example's round trip. */
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
			writeFileSync(join(OUTPUT, "logs", `${name}.log`), log);
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
		// ASTRO_DISABLE_UPDATE_CHECK: outside CI, a fresh project asks npm for the latest Astro and records the time in
		// .astro/settings.json; the file watcher took that write for a config change and restarted the dev server while
		// the page loaded (empty response). VERIFIED: astro 7.4.4 dist/core/dev/update-check.js and restart.js, log of
		// the failing run (2026-11-01).
		const astroPort = await freePort();
		const astro = await start("astro", "bun", ["--bun", "node_modules/astro/bin/astro.mjs", "dev", "--ignore-lock", "--root", "integrations/astro/example", "--host", "127.0.0.1", "--port", String(astroPort)], {
			env: { ASTRO_TELEMETRY_DISABLED: "1", ASTRO_DISABLE_UPDATE_CHECK: "true" },
			ready: /Local\s+(http:\/\/127\.0\.0\.1:\d+\/)/,
		});
		await page.goto(astro.match[1]);
		await page.locator("#sum").filter({ hasText: "5" }).waitFor();
		const astroEndpoint = await page.locator("#endpoint").textContent();
		assert.equal(astroEndpoint, DEFAULT_RPC, "Astro.locals.rpcEndpoint is the RPC server on the default port");
		check(`Astro dev server on Bun ${astro.match[1]}: locals.rpcEndpoint=${astroEndpoint}, client call answered`);
		await page.close();
		await stopped(astro.child);

		// 6. the browser example against every server, 7. the website (static: no server behind it) ----------------
		const harness = await buildBrowserHarness();
		const site = await serveSite({ overrides: harness });
		try {
			for (const path of ["/../package.json", "/%2e%2e/package.json", "/missing.html"]) {
				assert.ok([403, 404].includes((await fetch(site.url + path)).status), `site server refuses ${path}`);
			}
			for (const [browserName, browser] of Object.entries(browsers)) {
				for (const [server, { url }] of Object.entries(servers)) {
					await runBrowserExample(browser, `${site.url}/browser-example.html?rpc=${encodeURIComponent(url)}`, `${browserName}/${server}`);
					check(`examples/browser.ts in ${browserName} against ${server}: upload, download, SHA-256 equal`);
				}
			}
			const html = await readFile(join(ROOT, "docs/index.html"), "utf8");
			const sources = [...html.matchAll(/data-src="([^"#]+)(?:#([\w-]+))?"/g)].map(([, file, name]) => ({
				src: name ? `${file}#${name}` : file,
				text: region(file, name),
			}));
			for (const [browserName, browser] of Object.entries(browsers)) {
				const drawn = await driveSite({ browserName, browser, siteUrl: site.url, sources });
				check(`website in ${browserName}: ${sources.length} code blocks equal examples, all highlighted, ${drawn} sequence diagrams drawn, anchors, layout`);
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
	// Wait for the exits: each one writes its process log to output/e2e/logs, also when a failure ends the run.
	// SIGKILL after 5 s, as `make stop` does, so a server that ignores SIGTERM cannot hang the run.
	const running = processes.filter((child) => child.exitCode === null && child.signalCode === null);
	await Promise.all(
		running.map((child) => new Promise((resolve) => {
			child.once("exit", resolve);
			child.kill("SIGTERM");
			setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
		})),
	);
}

/**
 * A page that runs examples/browser.ts from the consumer, bundled by Bun with the installed client: a small PNG and
 * a 3 MiB file with a name outside Latin-1 go up and come back. Returns the site server's overrides for it.
 */
async function buildBrowserHarness() {
	const entry = join(CONSUMER, "browser-example.ts");
	await writeFile(
		entry,
		`import { fetchFile, sendFile, sha256Hex } from "./examples/browser.ts";
		const rpc = new URLSearchParams(location.search).get("rpc")!;
		const png = Uint8Array.from(atob(${JSON.stringify(PNG.toString("base64"))}), (c) => c.charCodeAt(0));
		async function roundTrip(file: File) {
			const percent: Record<string, number> = {};
			const done = await sendFile(file, rpc, (phase, value) => (percent[phase] = Math.max(percent[phase] ?? 0, value)));
			const back = await fetchFile(done.result.id, rpc);
			return { name: file.name, size: back.blob.size, filename: back.filename, percent, server: done.result.sha256, local: await sha256Hex(file), back: await sha256Hex(back.blob) };
		}
		(window as unknown as { done: Promise<unknown> }).done = (async () => [
			await roundTrip(new File([png], "pixel.png", { type: "image/png" })),
			await roundTrip(new File([new Uint8Array(3 * 1024 * 1024).fill(7)], "Übersicht 2026.bin")),
		])();`,
	);
	const out = join(WORK, "harness");
	run("bun", ["build", entry, "--target=browser", "--format=esm", "--outdir", out], CONSUMER);
	const page = join(out, "browser-example.html");
	await writeFile(page, `<!doctype html><meta charset="utf-8"><title>browser example</title><script type="module" src="/browser-example.js"></script>`);
	return { "/browser-example.html": page, "/browser-example.js": join(out, "browser-example.js") };
}

/** Runs the browser example page against one server and checks both round trips. */
async function runBrowserExample(browser, url, where) {
	const page = await browser.newPage();
	const { assertClean } = watch(page);
	await page.goto(url);
	const results = await page.evaluate(() => window.done);
	for (const result of results) {
		assert.equal(result.local, result.server, `${where} ${result.name}: the server's SHA-256 equals the browser's`);
		assert.equal(result.back, result.local, `${where} ${result.name}: the downloaded bytes are the uploaded ones`);
		assert.equal(result.filename, result.name, `${where}: the file name survives the round trip`);
		assert.equal(result.percent.sending, 100, `${where} ${result.name}: sending reaches 100%`);
	}
	assertClean(where);
	await page.close();
}

/** Tracks page errors, console errors, failed requests and HTTP errors; `assertClean()` fails on any. */
function watch(page) {
	const errors = [];
	// The diagrams of defuss-shadcn redraw their wires from a ResizeObserver; when that changes layout, browsers deliver
	// the remaining notifications a frame later and report this message as an error event (Resize Observer spec, "loop
	// completed with undelivered notifications"); nothing is lost. VERIFIED: WebKit reported it once while the website
	// test resized the viewport to 390 px (2026-11-01); any other page error still counts.
	page.on("pageerror", (error) => error.message !== "ResizeObserver loop completed with undelivered notifications." && errors.push(`pageerror: ${error.message}`));
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

/** Drives the website and returns how many sequence diagrams it drew. */
async function driveSite({ browserName, browser, siteUrl, sources }) {
	const context = await browser.newContext();
	if (browserName === "chromium") await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: siteUrl });
	const page = await context.newPage();
	const { assertClean } = watch(page);
	await page.goto(siteUrl);
	const where = browserName;
	await page.screenshot({ path: join(OUTPUT, `site-${browserName}-top.png`) });

	// code blocks are the example regions, unchanged, and every block on the page is highlighted (shell ones too)
	const shown = await page.locator("pre[data-src]").evaluateAll((pres) =>
		pres.map((pre) => ({ src: pre.dataset.src, text: [...pre.querySelectorAll("code > span")].map((l) => l.textContent).join("\n") })),
	);
	assert.deepEqual(shown, sources.map(({ src, text }) => ({ src, text: text.replace(/\t/g, "  ") })), `${where}: code blocks equal their example files`);
	const plain = await page.locator("pre").evaluateAll((pres) => pres.filter((pre) => !pre.querySelector("code > span > span[style*='color']")).map((pre) => pre.outerHTML.slice(0, 80)));
	assert.deepEqual(plain, [], `${where}: every code block is highlighted`);

	// the sequence diagrams: diagram.js (in defuss-shadcn's all.min.js) draws the wires of every figure
	const figures = await page.locator("figure.diagram[data-type='sequence']").count();
	assert.equal(figures, 4, `${where}: four sequence diagrams`);
	await page.waitForFunction(() => [...document.querySelectorAll("figure.diagram")].every((f) => (f.querySelector(".diagram-wires")?.childElementCount ?? 0) > 0));
	await page.locator("#protocol").scrollIntoViewIfNeeded();
	await page.screenshot({ path: join(OUTPUT, `site-${browserName}-protocol.png`) });

	// the client/server diffs: the keyboard moves the divider (diff.js of defuss-shadcn sets --diff-pos)
	const diffs = page.locator("figure.diff");
	assert.equal(await diffs.count(), 6, `${where}: six client/server diffs`);
	const filesDiff = page.locator("#files figure.diff");
	await filesDiff.locator(".diff-range").focus();
	for (let i = 0; i < 3; i++) await page.keyboard.press("Shift+ArrowLeft");
	assert.equal(await filesDiff.evaluate((figure) => figure.style.getPropertyValue("--diff-pos")), "20%", `${where}: the divider moves`);
	await filesDiff.locator(".diff-range").fill("50");

	// copy button inside a diff, on the server side (Chromium grants clipboard access to tests)
	if (browserName === "chromium") {
		const block = page.locator("#files .diff-item-2 .mk-code-block");
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

	// the footer's consulting panel: its portrait (lazy, so scrolled into view first) is served and decoded
	const portrait = page.locator(".rp-ad img");
	await portrait.scrollIntoViewIfNeeded();
	await page.waitForFunction(() => {
		const img = document.querySelector(".rp-ad img");
		return img.complete && img.naturalWidth > 0;
	});
	assert.equal(await portrait.evaluate((img) => img.naturalWidth), 400, `${where}: footer portrait`);

	// the npm badges (hero, header, menu sheet) name the version this page documents: package.json's
	const { version } = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
	const versions = await page.locator('[data-fact="version"]').allTextContents();
	assert.deepEqual(versions, [`v${version}`, `v${version}`, `v${version}`], `${where}: npm badges`);

	// theme toggle
	const dark = await page.evaluate(() => document.documentElement.classList.contains("dark"));
	await page.locator(".swap").first().click();
	assert.equal(await page.evaluate(() => document.documentElement.classList.contains("dark")), !dark, `${where}: theme toggle`);

	// phone width: no horizontal scrolling (the diagrams scroll inside their figure)
	await page.setViewportSize({ width: 390, height: 844 });
	assert.ok(await page.evaluate(() => document.scrollingElement.scrollWidth <= window.innerWidth + 1), `${where}: no horizontal scroll at 390px`);
	await page.setViewportSize({ width: 1280, height: 900 });
	await page.screenshot({ path: join(OUTPUT, `site-${browserName}-full.png`), fullPage: true });
	assertClean(where);
	await context.close();
	return figures;
}
