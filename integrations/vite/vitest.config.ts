/** Node.js project; `bun run test:bun` runs it on Bun (`bunx --bun vitest`). VERIFIED: both runs pass in `make test`. */
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: { environment: "node", include: ["src/**/*.test.ts"], testTimeout: 30_000 },
});
