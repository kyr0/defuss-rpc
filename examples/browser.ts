/**
 * Upload and download in a browser page: progress for a progress bar, the file back as a Blob, and a Web Crypto hash
 * to compare with the server's. VERIFIED: scripts/e2e.mjs runs these functions in Chromium and WebKit against every
 * demo server and compares the hashes.
 */
// #region browser-upload
import { downloadAsBlob, upload } from "defuss-rpc/client";

export interface StoredFile {
	id: string;
	size: number;
	sha256: string;
}

/**
 * Uploads a File and reports progress: "sending" from the browser,
 * "receiving" from the server's SSE stream.
 */
export async function sendFile(
	file: File,
	baseUrl: string,
	onProgress: (phase: string, percent: number) => void,
) {
	const options = { baseUrl, originalFilename: file.name };
	for await (const event of upload<StoredFile>("file", file, options)) {
		if (event.type === "complete") return event;
		onProgress(event.type, event.percent);
	}
	throw new Error("upload ended without a result");
}

/** Fetches the file back as a Blob, for an object URL or a save link. */
export async function fetchFile(id: string, baseUrl: string) {
	const { blob, result } = await downloadAsBlob("file", baseUrl, {
		downloadId: id,
	});
	return { blob, filename: result.filename ?? `${id}.bin` };
}
// #endregion browser-upload

// #region browser-sha256
/** SHA-256 of a Blob with Web Crypto, to compare with the server's. */
export async function sha256Hex(blob: Blob): Promise<string> {
	const buffer = await blob.arrayBuffer();
	const digest = await crypto.subtle.digest("SHA-256", buffer);
	const hex = (byte: number) => byte.toString(16).padStart(2, "0");
	return Array.from(new Uint8Array(digest), hex).join("");
}
// #endregion browser-sha256
