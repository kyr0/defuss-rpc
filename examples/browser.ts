/**
 * Browser code of the website's live demo: the page imports these functions, so what the site shows is what runs.
 */
// #region browser-upload
import { downloadAsBlob, upload } from "defuss-rpc/client";

export interface StoredFile {
	id: string;
	size: number;
	sha256: string;
}

/** Uploads a File and reports progress: "sending" from the browser, "receiving" from the server's SSE stream. */
export async function sendFile(file: File, baseUrl: string, onProgress: (phase: string, percent: number) => void) {
	for await (const event of upload<StoredFile>("file", file, { baseUrl, originalFilename: file.name })) {
		if (event.type === "complete") return event;
		onProgress(event.type, event.percent);
	}
	throw new Error("upload ended without a result");
}

/** Fetches the file back as a Blob, ready for an object URL, a canvas or a save link. */
export async function fetchFile(id: string, baseUrl: string) {
	const { blob, result } = await downloadAsBlob("file", baseUrl, { downloadId: id });
	return { blob, filename: result.filename ?? `${id}.bin` };
}
// #endregion browser-upload

// #region browser-sha256
/** SHA-256 of a Blob with Web Crypto, to compare with the digest the server computed. */
export async function sha256Hex(blob: Blob): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()));
	return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
// #endregion browser-sha256
