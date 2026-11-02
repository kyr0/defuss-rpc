/**
 * Server hooks of the demo: a guard that limits uploads before a byte is stored.
 * VERIFIED: src/upload.test.ts shows that an upload guard sees the namespace "__upload__" and the announced size as
 * args[0], and that false answers 403; every demo server imports this file, and the e2e uploads pass the guard.
 * UNKNOWN: no test uploads more than the 50 MiB limit.
 */
// #region hooks
import { addHook } from "defuss-rpc/server";

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

// Guards run before every call, upload and download; returning
// false answers HTTP 403. For uploads the namespace is
// "__upload__" and args[0] is the size the client announced.
addHook({
	phase: "guard",
	fn: (namespace, _method, args) => {
		if (namespace !== "__upload__") return true;
		return Number(args[0]) <= MAX_UPLOAD_BYTES;
	},
});
// #endregion hooks
