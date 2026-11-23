/**
 * Upload and download handlers of the demo: a file goes up, is kept in memory, and comes back by its ID.
 * VERIFIED: scripts/e2e.mjs uploads and downloads through these handlers on every demo server, from examples/client.ts
 * on Node.js and Bun and from examples/browser.ts in Chromium and WebKit, and compares the SHA-256 digests.
 */
// #region files
import type { RpcServer } from "defuss-rpc/server";

interface StoredFile {
	data: Uint8Array;
	name: string;
}

/** The demo's upload and download handlers, named "file". */
export function addFileHandlers(rpc: RpcServer) {
	/** The last 20 files: a demo must not grow without bound. */
	const files = new Map<string, StoredFile>();

	rpc.addUploadHandler("file", (data, meta) => {
		const { uploadId: id, originalFilename, sha256 } = meta;
		const name = originalFilename || `${id}.bin`;
		files.set(id, { data, name });
		const oldest = files.keys().next().value!;
		if (files.size > 20) files.delete(oldest);
		return { id, size: data.byteLength, sha256 };
	});

	rpc.addDownloadHandler("file", ({ downloadId }) => {
		const file = files.get(downloadId);
		if (!file) throw new Error(`Unknown file ${downloadId}`);
		return {
			data: file.data,
			fileMeta: {
				size: file.data.byteLength,
				contentType: "application/octet-stream",
				filename: file.name,
			},
		};
	});
}
// #endregion files
