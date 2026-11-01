# defuss-rpc-vite

The Vite plugin of [defuss-rpc](../../README.md): `vite dev` starts the RPC server beside the dev server, and `virtual:defuss-rpc` tells the client where it runs, so `getRpcClient()` needs no options.

It is a package of its own so that defuss-rpc depends on no build tool: only applications that use Vite install this plugin and Vite.

## Install

```bash
bun add defuss-rpc defuss-rpc-vite
bun add -d vite
# On Node.js the RPC server needs a provider, e.g. Express:
bun add express
```

## Use it

<!-- example: integrations/vite/example/vite.config.ts#vite-config -->
```ts
import { defineConfig } from "vite";
import { defussRpc } from "defuss-rpc-vite";
import RpcApi from "./api.ts";

// No provider: the RPC server runs on Bun.serve, port 63920. On Node.js add `provider: expressProvider()`.
export default defineConfig({
  plugins: [defussRpc({ api: RpcApi, host: "127.0.0.1", watch: ["api.ts"] })],
});
```
<!-- /example -->

The page imports the virtual module once; after that, every client call goes to the dev server's RPC server:

<!-- example: integrations/vite/example/main.ts#vite-client -->
```ts
import "virtual:defuss-rpc"; // registers the dev server's RPC endpoint as the default
import { getRpcClient } from "defuss-rpc/client";
import type { RpcApi } from "./api.ts";

const rpc = await getRpcClient<RpcApi>(); // no baseUrl: the virtual module set it
document.querySelector("#sum")!.textContent = String(await rpc.MathApi.add(2, 3));
```
<!-- /example -->

To import `rpcEndpoint` from the virtual module in TypeScript, declare it once, e.g. in `env.d.ts`:

<!-- example: integrations/vite/example/env.d.ts#virtual-types -->
```ts
declare module "virtual:defuss-rpc" {
  /** Endpoint the client uses, e.g. "http://127.0.0.1:63920" in vite dev. */
  export const rpcEndpoint: string;
}
```
<!-- /example -->

`bunx --bun vite example` in this folder runs the example in [`example/`](example/).

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `api` | required | namespace object, as for `createRpcServer()` |
| `provider` | `Bun.serve` (Bun only) | the server framework; on Node.js `expressProvider()` from `defuss-rpc/providers/express` |
| `port` | `63920` | RPC server port; `0` picks a free one, for two dev servers at once |
| `host` | `"localhost"` | bind address; `"0.0.0.0"` for Docker or LAN |
| `protocol` | `"http"` | protocol written into the endpoint URL (TLS belongs in a reverse proxy) |
| `basePath` | `""` | prefix of every route, e.g. `"/api"` |
| `jsonSizeLimit` | `"1mb"` | largest RPC call body after decompression, bytes or `"512kb"`; larger calls get 413 (files go through `upload()`) |
| `corsOrigin` | `"*"` | one origin, `"*"`, or a list (the request's `Origin` is echoed when listed) |
| `compression` | `true` | gzip level 1 for responses; `false` or `{ level }` |
| `watch` | `["src/**/*.ts"]` | files whose change reloads the page so it fetches the schema again |
| `endpoint` | dev server URL | the URL the browser uses; in `vite build` else `VITE_DEFUSS_RPC_URL`, else `""` |

What happens when:
- `vite dev` registers `api`, starts the server and stops it with Vite. A restart after a change to `vite.config.ts` or a file it imports registers the API again and starts a new server on the same port.
- `vite build` starts nothing; `virtual:defuss-rpc` then holds `endpoint`, else `import.meta.env.VITE_DEFUSS_RPC_URL`, else `""` (the page's own origin).
- A change to a file matching `watch` reloads the page.

`defuss-rpc-vite/rpc-state` exposes the running server to server code: `getRpcEndpoint()`, `getRpcServer()` and `getRpcConfig()`.

## Development

This folder is a Bun project of its own, inside the defuss-rpc repository. `make setup` in the repository root installs it and links `node_modules/defuss-rpc` to the repository, and `make test` runs its tests on Node.js and Bun.

[ARCH.md](ARCH.md) explains the design.
