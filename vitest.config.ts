import { defineConfig } from "vitest/config";
import { playwright } from "@vitest/browser-playwright";

/**
 * Three projects over one source tree:
 * - `node`: everything that runs server-side: rpcRoute, uploads, downloads, ExpressRpcServer on every provider, and
 *   the client against real servers on ephemeral ports (the Vite and Astro packages in integrations/ run their own
 *   Vitest). `bun run test:bun`
 *   runs this project on Bun (`bunx --bun vitest`), where `src/test/server.ts` adds bunway.
 *   VERIFIED: the project passes on both runtimes (`make test`).
 * - `chromium` and `webkit`: the client in real browsers (buffered upload bodies, EventSource progress, Blob
 *   downloads, CORS), against one ExpressRpcServer per provider that the global setup starts in Node.js.
 *
 * Why no happy-dom: a DOM shim in Node.js made the client take its browser code path while running Node's fetch,
 * a combination no user has. Coverage merges `node` and `chromium` (v8 coverage needs a Chromium engine).
 */
const browserProject = (name: "chromium" | "webkit") => ({
	test: {
		name,
		include: ["src/**/*.browser.test.ts"],
		globalSetup: ["src/test/browser-server.ts"],
		testTimeout: 60_000,
		hookTimeout: 30_000,
		browser: {
			enabled: true,
			headless: true,
			provider: playwright(),
			instances: [{ browser: name }],
		},
	},
});

export default defineConfig({
	test: {
		coverage: {
			provider: "v8",
			include: ["src/**/*.ts"],
			// test/: helpers and fixtures; types.d.ts and provider.ts declare types only.
			exclude: ["src/**/*.test.ts", "src/test/**", "src/types.d.ts", "src/provider.ts"],
			reporter: ["text-summary", "text", "lcov"],
		},
		projects: [
			{
				test: {
					name: "node",
					environment: "node",
					include: ["src/**/*.test.ts"],
					exclude: ["src/**/*.browser.test.ts"],
					testTimeout: 30_000,
				},
			},
			browserProject("chromium"),
			browserProject("webkit"),
		],
	},
});
