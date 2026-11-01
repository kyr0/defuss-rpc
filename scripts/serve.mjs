import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const TYPES = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript",
	".css": "text/css",
	".json": "application/json",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
};

/**
 * Serves the website (docs/) as GitHub Pages would: static files, `index.html` for directories, 404 otherwise.
 * `overrides` maps a URL path to a file served instead of docs/, which the e2e test uses to serve the site script
 * built from the installed package. VERIFIED: paths outside docs/ answer 403/404 (asserted in scripts/e2e.mjs).
 */
export async function serveSite({ port = 0, host = "127.0.0.1", overrides = {} } = {}) {
	const base = resolve(ROOT, "docs");
	const server = createServer(async (request, response) => {
		try {
			const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
			const path = overrides[pathname] ?? resolve(base, `.${pathname}${pathname.endsWith("/") ? "index.html" : ""}`);
			if (!overrides[pathname] && !path.startsWith(base + sep)) {
				response.writeHead(403).end();
				return;
			}
			const body = await readFile(path);
			response.writeHead(200, { "Content-Type": TYPES[extname(path)] ?? "application/octet-stream" }).end(body);
		} catch {
			response.writeHead(404).end();
		}
	});
	await new Promise((done, fail) => {
		server.once("error", fail);
		server.listen(port, host, done);
	});
	const address = server.address();
	return { server, url: `http://${host}:${typeof address === "object" && address ? address.port : port}` };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const { server, url } = await serveSite({ port: Number(process.env.SITE_PORT ?? 4173) });
	console.info(`${new Date().toISOString()} INFO site listening url=${url}/`);
	process.once("SIGTERM", () => server.close(() => process.exit(0)));
}
