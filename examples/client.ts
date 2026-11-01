/**
 * The client in a Node.js or Bun script: `RPC_URL=http://127.0.0.1:63920 bun examples/client.ts`.
 * VERIFIED: scripts/e2e.mjs runs it on Node.js and Bun against every demo server and compares every line it prints
 * with the comment at the end of its console.log line.
 */
// #region client
import { addHook, download, getRpcClient, setHeaders, uploadComplete } from "defuss-rpc/client";
import type { RpcApi } from "./api.ts";

const baseUrl = process.env.RPC_URL ?? "http://127.0.0.1:63920";
const rpc = await getRpcClient<RpcApi>({ baseUrl });

console.log(await rpc.MathApi.add(2, 3)); // 5
console.log(await new rpc.GreeterApi().greet("Ada")); // Hello, Ada!
// #endregion client

// #region stream
const words: string[] = [];
for await (const word of rpc.ChatApi.reply("hi there")) words.push(word);
console.log(words.join(" ")); // You said: hi there
// #endregion stream

// #region types
const sample = await rpc.TypesApi.sample();
console.log(sample.when.toISOString(), sample.tags.has("dson"), sample.scores.get("ada"), sample.big); // 2026-11-01T12:00:00.000Z true 1815 18446744073709551616n
console.log(sample.bytes instanceof Uint8Array, sample.bytes.length); // true 4
// #endregion types

// #region upload
const bytes = new TextEncoder().encode("hello, file");
const uploaded = await uploadComplete<{ id: string; size: number }>("file", bytes, { baseUrl, originalFilename: "hello.txt" });
console.log(uploaded.result.size, uploaded.sha256.length); // 11 64

const file = await download("file", baseUrl, { downloadId: uploaded.result.id });
console.log(new TextDecoder().decode(file.data), file.filename); // hello, file hello.txt
// #endregion upload

// #region errors
try {
	await download("file", baseUrl, { downloadId: "does-not-exist" });
} catch (error) {
	// Failed calls, uploads and downloads throw with the HTTP status and the server's error body.
	console.log((error as { status: number }).status); // 500
}
// #endregion errors

// #region client-hooks
setHeaders({ Authorization: "Bearer demo-token" }); // sent with every later call and upload
let answered = 0;
addHook({ phase: "result", fn: () => void answered++ }); // runs after each decoded result
await rpc.MathApi.multiply(6, 7);
console.log(answered); // 1
// #endregion client-hooks
