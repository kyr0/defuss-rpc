/** Server hooks of the demo: a guard that limits uploads before a byte is stored. */
// #region hooks
import { addHook } from "defuss-rpc/server";

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

// Guards run before every call, upload and download; returning false answers HTTP 403.
// For uploads the namespace is "__upload__" and args[0] is the size the client announced.
addHook({
	phase: "guard",
	fn: (namespace, _method, args) => namespace !== "__upload__" || Number(args[0]) <= MAX_UPLOAD_BYTES,
});
// #endregion hooks
