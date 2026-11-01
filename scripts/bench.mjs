/**
 * Benchmark of the server providers: `node scripts/bench.mjs` (or `make bench`, which builds first).
 *
 * Every server runs `scripts/bench-server.ts` in its own process, and autocannon (in this process, with worker
 * threads) loads it with four scenarios, each answer checked once before it is measured:
 * - call: `BenchApi.add(1, 2)`, a small request and a small DSON answer: requests per second and latency.
 * - stream: `BenchApi.frames(100)`, a generator answered as 100 NDJSON frames.
 * - upload: 1 MiB to a streaming upload handler (written to a temp file, hashed, read back).
 * - download: 8 MiB from memory.
 * The servers: ExpressRpcServer without a provider (Bun.serve), on Express (Node.js and Bun) and on bunway (Bun),
 * and `rpcRoute` in a bare `Bun.serve`, the baseline for what a provider and the HTTP layer cost. Compression is off on
 * both sides, so the numbers measure transport, not zlib.
 *
 * Why autocannon in a separate process from the servers: a load generator in the server's process competes for its
 * event loop and flatters nobody. Both still share this machine, so compare rows of one run, not runs of different
 * machines. VERIFIED: rows of different runs vary: Express on Node.js answered 25,653 and 38,915 calls/s in two runs
 * on one machine. Settings: BENCH_DURATION (seconds per scenario, default 5), BENCH_CONNECTIONS (default 64; uploads and
 * downloads use a quarter), BENCH_WORKERS (autocannon threads, default 4), BENCH_ONLY (comma-separated server labels).
 * Results: output/bench/results.json and output/bench/results.md.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { arch, cpus, loadavg, platform, totalmem } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import autocannon from "autocannon";
import { DSON } from "defuss-dson";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const OUTPUT = join(ROOT, "output/bench");
const DURATION = Number(process.env.BENCH_DURATION ?? 5);
const CONNECTIONS = Number(process.env.BENCH_CONNECTIONS ?? 64);
const WORKERS = Number(process.env.BENCH_WORKERS ?? 4);
const MiB = 1024 * 1024;

const SERVERS = [
	["express", "node", "express"],
	["express", "bun", "express"],
	["bunway", "bun", "bunway"],
	["no provider (Bun.serve)", "bun", "default"],
	["bare rpcRoute in Bun.serve", "bun", "bun.serve"],
].map(([provider, runtime, env]) => ({ label: `${provider} on ${runtime === "bun" ? "Bun" : "Node.js"}`, provider, runtime, env }));

const call = (methodName, args) => ({
	method: "POST",
	path: "/rpc",
	headers: { "Content-Type": "application/json" },
	body: DSON.stringify({ className: "BenchApi", methodName, args }),
});

/** Each scenario: the request, its connection count, and a check of one answer before the measurement. */
const SCENARIOS = {
	call: {
		request: call("add", [1, 2]),
		connections: CONNECTIONS,
		check: async (response) => assert.equal(DSON.parse(await response.text()), 3),
	},
	stream: {
		request: call("frames", [100]),
		connections: CONNECTIONS,
		check: async (response) => {
			const frames = (await response.text()).trim().split("\n");
			assert.equal(frames.length, 101);
			assert.deepEqual(DSON.parse(frames.at(-1)), { type: "return", value: 100 });
		},
	},
	upload: {
		request: {
			method: "POST",
			path: "/rpc/upload",
			headers: { "Content-Type": "application/octet-stream", "X-Upload-Handler": "count", "X-Original-Size": String(MiB) },
			// A string: autocannon's worker threads receive a Buffer as a plain Uint8Array, which they reject.
			body: "u".repeat(MiB),
		},
		connections: Math.max(1, CONNECTIONS / 4),
		// autocannon's throughput counts response bytes; an upload's rate is its request bodies.
		sentMiB: 1,
		check: async (response) => {
			assert.equal(response.status, 201);
			assert.deepEqual(DSON.parse((await response.text()).trim().split("\n").at(-1)), { type: "result", value: MiB });
		},
	},
	download: {
		request: { method: "GET", path: "/rpc/download?handler=file" },
		connections: Math.max(1, CONNECTIONS / 4),
		check: async (response) => assert.equal((await response.arrayBuffer()).byteLength, 8 * MiB),
	},
};

const log = (message) => console.info(`${new Date().toISOString()} INFO bench ${message}`);

/** Starts one bench server and resolves with its URL and process. */
function startServer({ runtime, env, label }) {
	const child = spawn(runtime, ["scripts/bench-server.ts"], { cwd: ROOT, env: { ...process.env, PROVIDER: env }, stdio: ["ignore", "pipe", "pipe"] });
	let output = "";
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`${label}: not listening after 20 s\n${output}`)), 20_000);
		const onData = (chunk) => {
			output += chunk;
			const match = /rpc server listening url=(\S+)/.exec(output);
			if (match) {
				clearTimeout(timer);
				resolve({ child, url: match[1] });
			}
		};
		child.stdout.on("data", onData);
		child.stderr.on("data", onData);
		child.on("exit", (code) => reject(new Error(`${label} exited with ${code}\n${output}`)));
	});
}

const stopServer = (child) =>
	new Promise((resolve) => {
		child.once("exit", resolve);
		child.kill("SIGTERM");
		setTimeout(() => child.kill("SIGKILL"), 5000).unref();
	});

/** One autocannon run; the warm-up run's numbers are discarded. */
const load = (url, scenario, duration) =>
	autocannon({ url: url + scenario.request.path, ...scenario.request, connections: scenario.connections, duration, workers: WORKERS });

const version = (command) => {
	try {
		return execFileSync(command, ["--version"], { encoding: "utf8" }).trim();
	} catch {
		return "absent";
	}
};

/** Load before the run: other processes on the machine skew every row alike, but the reader should know. */
const loadBefore = loadavg()[0].toFixed(1);
// Empty counts as unset: the Makefile exports every key of .env, including BENCH_ONLY= from .env.example.
const only = process.env.BENCH_ONLY ? process.env.BENCH_ONLY.split(",").map((s) => s.trim()) : undefined;
const servers = only ? SERVERS.filter((s) => only.includes(s.label)) : SERVERS;
const rows = [];
await mkdir(OUTPUT, { recursive: true });
for (const server of servers) {
	const { child, url } = await startServer(server);
	try {
		const row = { server: server.label, provider: server.provider, runtime: server.runtime };
		for (const [name, scenario] of Object.entries(SCENARIOS)) {
			const { method, headers, body, path } = scenario.request;
			await scenario.check(await fetch(url + path, { method, headers, body }));
			await load(url, scenario, 1);
			const result = await load(url, scenario, DURATION);
			const failures = result.errors + result.timeouts + result.non2xx;
			assert.equal(failures, 0, `${server.label} ${name}: ${result.errors} errors, ${result.timeouts} timeouts, ${result.non2xx} non-2xx`);
			row[name] = {
				requestsPerSecond: Math.round(result.requests.average),
				latencyP50Ms: result.latency.p50,
				latencyP99Ms: result.latency.p99,
				mebibytesPerSecond: Math.round((scenario.sentMiB ? result.requests.average * scenario.sentMiB : result.throughput.average / MiB) * 10) / 10,
				requests: result.requests.total,
			};
			log(`${server.label} ${name}: ${row[name].requestsPerSecond} req/s p50=${row[name].latencyP50Ms}ms p99=${row[name].latencyP99Ms}ms ${row[name].mebibytesPerSecond} MiB/s`);
		}
		rows.push(row);
	} finally {
		await stopServer(child);
	}
}

const environment = {
	finishedAt: new Date().toISOString(),
	machine: `${cpus()[0]?.model ?? "unknown CPU"}, ${cpus().length} cores, ${Math.round(totalmem() / 1024 ** 3)} GiB, ${platform()} ${arch()}`,
	node: process.version,
	bun: version("bun"),
	loadAverageBefore: Number(loadBefore),
	settings: { durationSeconds: DURATION, connections: CONNECTIONS, transferConnections: Math.max(1, CONNECTIONS / 4), workers: WORKERS },
};
const table = [
	"| Server | call req/s | call p50 / p99 ms | stream (100 frames) req/s | upload (1 MiB each) | download (8 MiB each) |",
	"| --- | ---: | ---: | ---: | ---: | ---: |",
	...rows.map((r) =>
		`| ${r.server} | ${r.call.requestsPerSecond.toLocaleString("en-US")} | ${r.call.latencyP50Ms} / ${r.call.latencyP99Ms} | ${r.stream.requestsPerSecond.toLocaleString("en-US")} | ${r.upload.mebibytesPerSecond} MiB/s | ${r.download.mebibytesPerSecond} MiB/s |`,
	),
].join("\n");
const notes = `Measured ${environment.finishedAt} on ${environment.machine}; Node.js ${environment.node}, Bun ${environment.bun}; ${DURATION} s per scenario after 1 s warm-up, ${CONNECTIONS} connections (uploads and downloads ${environment.settings.transferConnections}), autocannon with ${WORKERS} worker threads on the same machine (load average ${loadBefore} before the run).`;
await writeFile(join(OUTPUT, "results.json"), `${JSON.stringify({ environment, rows }, null, 2)}\n`);
await writeFile(join(OUTPUT, "results.md"), `${table}\n\n${notes}\n`);
console.info(`\n${table}\n\n${notes}`);
log(`PASS servers=${rows.length} report=output/bench/results.json`);
