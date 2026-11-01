/** Upload and download handlers of the demo: a file goes up, is kept in memory, and comes back by its ID. */
// #region files
import { addDownloadHandler, addUploadHandler } from "defuss-rpc/server";

interface StoredFile {
	data: Uint8Array;
	name: string;
}

/** The last 20 files; a demo server must not grow without bound. */
const files = new Map<string, StoredFile>();

addUploadHandler("file", (data, meta) => {
	files.set(meta.uploadId, { data, name: meta.originalFilename || `${meta.uploadId}.bin` });
	if (files.size > 20) files.delete(files.keys().next().value!);
	return { id: meta.uploadId, size: data.byteLength, sha256: meta.sha256 };
});

addDownloadHandler("file", ({ downloadId }) => {
	const file = files.get(downloadId);
	if (!file) throw new Error(`Unknown file ${downloadId}`);
	return {
		data: file.data,
		fileMeta: { size: file.data.byteLength, contentType: "application/octet-stream", filename: file.name },
	};
});
// #endregion files
