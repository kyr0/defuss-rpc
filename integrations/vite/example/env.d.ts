/** Types of `virtual:defuss-rpc` for TypeScript. VERIFIED: the example's typecheck (`tsc -p example/tsconfig.json`) compiles it. */
// #region virtual-types
declare module "virtual:defuss-rpc" {
	/** Endpoint the client uses, e.g. "http://127.0.0.1:63920" in vite dev. */
	export const rpcEndpoint: string;
}
// #endregion virtual-types
