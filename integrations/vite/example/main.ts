/** The page script. VERIFIED: the repository's scripts/e2e.mjs opens the page in Chromium and sees 2 + 3 = 5. */
// #region vite-client
// registers the dev server's RPC endpoint as the default
import "virtual:defuss-rpc";
import { getRpcClient } from "defuss-rpc/client";
import type { RpcApi } from "./api.ts";

// no baseUrl: the virtual module set it
const rpc = await getRpcClient<RpcApi>();
const sum = await rpc.MathApi.add(2, 3);
document.querySelector("#sum")!.textContent = String(sum);
// #endregion vite-client
