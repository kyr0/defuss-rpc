/**
 * The client in a Node.js or Bun script: `RPC_URL=http://127.0.0.1:63920 bun examples/client.ts`.
 * VERIFIED: scripts/e2e.mjs runs it on Node.js and Bun against every demo server and compares every line it prints
 * with the comment at the end of its console.log line.
 */
// #region client
import {
	addHook,
	download,
	getRpcClient,
	setHeaders,
	uploadComplete,
} from "defuss-rpc/client";
import type { RpcApi } from "./api.ts";

const baseUrl = process.env.RPC_URL ?? "http://127.0.0.1:63920";
const rpc = await getRpcClient<RpcApi>({ baseUrl });

console.log(await rpc.MathApi.add(2, 3)); // 5
console.log(await new rpc.GreeterApi().greet("Ada")); // Hello, Ada!
// #endregion client

// #region stream
const words: string[] = [];
for await (const word of rpc.ChatApi.reply("hi there")) {
	words.push(word);
}
console.log(words.join(" ")); // You said: hi there
// #endregion stream

// #region types
const { when, tags, scores, big, bytes } =
	await rpc.TypesApi.sample();
console.log(when.toISOString()); // 2026-11-01T12:00:00.000Z
console.log(tags.has("dson"), scores.get("ada")); // true 1815
console.log(big); // 18446744073709551616n
console.log(bytes instanceof Uint8Array); // true
// #endregion types

// #region upload
type StoredFile = { id: string; size: number };
const data = new TextEncoder().encode("hello, file");
const { result, sha256 } = await uploadComplete<StoredFile>(
	"file",
	data,
	{ baseUrl, originalFilename: "hello.txt" },
);
console.log(result.size, sha256.length); // 11 64

const file = await download("file", baseUrl, {
	downloadId: result.id,
});
const text = new TextDecoder().decode(file.data);
console.log(text, file.filename); // hello, file hello.txt
// #endregion upload

// #region errors
try {
	await download("file", baseUrl, { downloadId: "does-not-exist" });
} catch (error) {
	// Failed calls, uploads and downloads throw with the HTTP
	// status and the server's error body.
	console.log((error as { status: number }).status); // 500
}
// #endregion errors

// #region client-hooks
// sent with every later call and upload
setHeaders({ Authorization: "Bearer demo-token" });
let answered = 0;
// runs after each decoded result
addHook({ phase: "result", fn: () => void answered++ });
await rpc.MathApi.multiply(6, 7);
console.log(answered); // 1
// #endregion client-hooks
