/** The page script. VERIFIED: the repository's scripts/e2e.mjs opens the page in Chromium and sees 2 + 3 = 5. */
// #region vite-client
import "virtual:defuss-rpc"; // registers the dev server's RPC endpoint as the default
import { getRpcClient } from "defuss-rpc/client";
import type { RpcApi } from "./api.ts";

const rpc = await getRpcClient<RpcApi>(); // no baseUrl: the virtual module set it
document.querySelector("#sum")!.textContent = String(await rpc.MathApi.add(2, 3));
// #endregion vite-client
