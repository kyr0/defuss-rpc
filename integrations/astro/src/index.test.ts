import { afterEach, describe, expect, it, vi } from "vitest";
import { getRpcClient } from "defuss-rpc/client";
import { expressProvider } from "defuss-rpc/providers/express";
import { clearRpcServer } from "defuss-rpc/server";
import { getRpcServer, setRpcConfig, setRpcEndpoint } from "defuss-rpc-vite/rpc-state";
import { defussRpc } from "./index.js";
import { onRequest } from "./middleware.js";

const TestMathModule = {
	async add(a: number, b: number) {
		return a + b;
	},
};
const provider = expressProvider();

describe("defussRpc Astro integration", () => {
	afterEach(async () => {
		await getRpcServer()?.stop();
		setRpcEndpoint("");
		await clearRpcServer();
	});

	it("adds the Vite plugin and a pre middleware that this package exports", async () => {
		const integration = defussRpc({ api: { TestMathModule }, provider });
		const updates: any[] = [];
		const middlewares: any[] = [];
		const setup = integration.hooks["astro:config:setup"] as Function;
		setup({ updateConfig: (config: unknown) => updates.push(config), addMiddleware: (m: unknown) => middlewares.push(m) });
		expect(integration.name).toBe("defuss-rpc");
		expect(updates[0].vite.plugins.map((p: { name: string }) => p.name)).toEqual(["vite:defuss-rpc"]);
		expect(middlewares).toEqual([{ order: "pre", entrypoint: "defuss-rpc-astro/middleware" }]);
		const { exports } = (await import("../package.json", { with: { type: "json" } })).default;
		expect(exports).toHaveProperty("./middleware");
	});

	it("a second copy of the modules sees the endpoint and registrations of the first", async () => {
		// Astro bundles packages that peer on astro into its SSR build, so the middleware runs in another module copy
		// than the integration; resetModules() gives this test such a fresh copy.
		setRpcEndpoint("http://127.0.0.1:1234");
		const { addUploadHandler } = await import("defuss-rpc/server");
		addUploadHandler("shared-handler", () => 1);
		vi.resetModules();
		const copy = await import("defuss-rpc-vite/rpc-state");
		const middleware = await import("./middleware.js");
		expect(copy.getRpcEndpoint()).toBe("http://127.0.0.1:1234");
		const context = { locals: {} as Record<string, unknown> };
		await (middleware.onRequest as Function)(context, async () => new Response());
		expect(context.locals.rpcEndpoint).toBe("http://127.0.0.1:1234");
		const { rpcRoute } = await import("defuss-rpc/server");
		const response = await rpcRoute({
			request: new Request("http://localhost/rpc/upload", { method: "POST", headers: { "X-Upload-Handler": "shared-handler" }, body: "x" }),
		});
		expect(response.status).toBe(201);
	});

	it("middleware passes the running endpoint through locals", async () => {
		setRpcEndpoint("http://localhost:4321");
		const context = { locals: {} as Record<string, unknown> };
		const response = await (onRequest as Function)(context, async () => new Response("page"));
		expect(context.locals.rpcEndpoint).toBe("http://localhost:4321");
		expect(await response.text()).toBe("page");
	});

	it("starts one server for concurrent first requests when none runs yet", async () => {
		setRpcConfig({ api: { TestMathModule }, provider, host: "127.0.0.1", port: 0, compression: false });
		const contexts = [{ locals: {} as Record<string, unknown> }, { locals: {} as Record<string, unknown> }];
		await Promise.all(contexts.map((context) => (onRequest as Function)(context, async () => new Response("ok"))));
		const endpoint = contexts[0].locals.rpcEndpoint as string;
		expect(endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
		expect(contexts[1].locals.rpcEndpoint).toBe(endpoint);
		expect(getRpcServer()?.getUrl()).toBe(endpoint);
		const rpc = await getRpcClient<{ TestMathModule: typeof TestMathModule }>({ baseUrl: endpoint });
		expect(await rpc.TestMathModule.add(1, 2)).toBe(3);
	});
});
