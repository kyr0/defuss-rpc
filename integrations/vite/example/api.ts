/** The example API: one module, enough for the page to show a call that went through the RPC server.
 * VERIFIED: the repository's scripts/e2e.mjs sees the page show MathApi.add(2, 3) = 5. */
// #region api
export const MathApi = {
	async add(a: number, b: number) {
		return a + b;
	},
};

const RpcApi = { MathApi };
export default RpcApi;
export type RpcApi = typeof RpcApi;
// #endregion api
