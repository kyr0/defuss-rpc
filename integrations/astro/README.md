# defuss-rpc-astro

The Astro integration of [defuss-rpc](../../README.md): in `astro dev` it starts the RPC server through the Vite plugin of [defuss-rpc-vite](../vite/README.md), and a middleware puts the endpoint into `Astro.locals.rpcEndpoint` for server-rendered code.

It is a package of its own so that defuss-rpc depends on no framework: only Astro projects install it and Astro.

## Install

```bash
bun add defuss-rpc defuss-rpc-vite defuss-rpc-astro
# On Node.js the RPC server needs a provider, e.g. Express:
bun add express
```

## Use it

<!-- example: integrations/astro/example/astro.config.ts#astro-config -->
```ts
import { defineConfig } from "astro/config";
import { defussRpc } from "defuss-rpc-astro";
import RpcApi from "./api.ts";

export default defineConfig({
  // No provider: the RPC server runs on Bun.serve, port 63920.
  // On Node.js add `provider: expressProvider()`.
  integrations: [
    defussRpc({
      api: RpcApi,
      host: "127.0.0.1",
      watch: ["api.ts"],
    }),
  ],
});
```
<!-- /example -->

Server-rendered code reads the endpoint from `locals`:

<!-- example: integrations/astro/example/src/pages/index.astro#astro-page -->
```ts
// Server side: the middleware put the RPC server's endpoint into locals.
const endpoint = Astro.locals.rpcEndpoint;
```
<!-- /example -->

Scripts in the page import the virtual module of the Vite plugin, as in a Vite app:

<!-- example: integrations/astro/example/src/pages/index.astro#astro-client -->
```ts
import "virtual:defuss-rpc";
import { getRpcClient } from "defuss-rpc/client";
import type { RpcApi } from "../../api.ts";

const rpc = await getRpcClient<RpcApi>();
const sum = await rpc.MathApi.add(2, 3);
document.querySelector("#sum")!.textContent = String(sum);
```
<!-- /example -->

`bunx --bun astro dev --root example` in this folder runs the example in [`example/`](example/).

The options are those of the Vite plugin; see [defuss-rpc-vite](../vite/README.md#options). Declare the local's type in `src/env.d.ts` when your project does not see this package's global declaration:

```text
declare namespace App {
  interface Locals { rpcEndpoint: string }
}
```

## Development

This folder is a Bun project of its own, inside the defuss-rpc repository. `make setup` in the repository root installs it and links `node_modules/defuss-rpc` and `node_modules/defuss-rpc-vite` to the repository's folders, and `make test` runs its tests on Node.js and Bun.

[ARCH.md](ARCH.md) explains the design.
