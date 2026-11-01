/**
 * Upload sessions: the server-side state of an upload between its first byte and the handler's result.
 *
 * Why a temp file per upload instead of collecting chunks in memory: an upload can be larger than the server's RAM,
 * a resumed upload must continue where the bytes on disk end (the `HEAD` offset is the file size, not a counter the
 * client could fake), and the handler runs only after the whole body has arrived and its SHA-256 is known.
 * Sessions live in process memory, so a restart forgets them; the files stay in the upload directory until a
 * successful handler run (or {@link clearAllSessions}) removes them.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir, open, rm, stat } from "node:fs/promises";
import type { UploadProgressEvent } from "./types.d.js";

/** One upload in progress, complete or failed. */
export interface UploadSession {
	uploadId: string;
	handlerName: string;
	/** Total size the client announced in `X-Original-Size`. */
	originalSize: number;
	/** Bytes written to the temp file so far (after decompression). */
	bytesReceived: number;
	tempFilePath: string;
	status: "uploading" | "complete" | "error";
	createdAt: number;
}

/** Sessions, listeners and the upload directory, shared by every copy of this module (see server.ts). */
const shared = ((globalThis as Record<symbol, unknown>)[Symbol.for("defuss-rpc.upload-state")] ??= {
	sessions: new Map(),
	listeners: new Map(),
	uploadDir: join(tmpdir(), "defuss-uploads"),
}) as {
	sessions: Map<string, UploadSession>;
	listeners: Map<string, Set<(event: UploadEvent) => void>>;
	uploadDir: string;
};
const { sessions } = shared;

/** Chunk size for replaying a temp file to a streaming handler and for hashing it. */
export const FILE_CHUNK_BYTES = 256 * 1024;

/** Returns the directory that holds the temp files of running uploads. */
export function getUploadDir(): string {
	return shared.uploadDir;
}

/**
 * Sets the directory for upload temp files (default: `<os tmpdir>/defuss-uploads`).
 *
 * Point it at a volume with room for the largest expected upload: the whole body is written there before the
 * handler runs. Sessions that already started keep their old path.
 */
export function setUploadDir(dir: string): void {
	shared.uploadDir = dir;
}

/** Creates the upload directory if it does not exist yet. */
export async function ensureUploadDir(): Promise<void> {
	await mkdir(shared.uploadDir, { recursive: true });
}

/**
 * Creates (or replaces) the session for `uploadId`; its temp file is `{uploadDir}/{uploadId}.part`.
 * The caller sanitizes `uploadId`, so it cannot leave the upload directory.
 */
export function createSession(uploadId: string, handlerName: string, originalSize: number): UploadSession {
	const session: UploadSession = {
		uploadId,
		handlerName,
		originalSize,
		bytesReceived: 0,
		tempFilePath: join(shared.uploadDir, `${uploadId}.part`),
		status: "uploading",
		createdAt: Date.now(),
	};
	sessions.set(uploadId, session);
	return session;
}

/** The session for `uploadId`, or `undefined` when none exists (never started, cleaned up or forgotten on restart). */
export function getSession(uploadId: string): UploadSession | undefined {
	return sessions.get(uploadId);
}

/** Updates the byte count and/or status of an existing session; unknown IDs are ignored. */
export function updateSession(
	uploadId: string,
	updates: Partial<Pick<UploadSession, "bytesReceived" | "status">>,
): void {
	const session = sessions.get(uploadId);
	if (!session) return;
	if (updates.bytesReceived !== undefined) session.bytesReceived = updates.bytesReceived;
	if (updates.status !== undefined) session.status = updates.status;
}

/** What the progress stream reports about one upload. */
export type UploadEvent =
	| ({ type: "progress" } & UploadProgressEvent)
	| ({ type: "complete" } & UploadProgressEvent)
	| { type: "error"; error: string };

/**
 * Listeners by upload ID, separate from the sessions.
 * Why separate: a client opens the progress stream before it sends the upload, so a listener must be able to
 * subscribe to an ID whose session does not exist yet, and it must still get the final event after a successful
 * upload removed the session.
 */
const { listeners } = shared;

/** Subscribes to the events of one upload (it need not have started yet); returns the unsubscribe function. */
export function addUploadListener(uploadId: string, listener: (event: UploadEvent) => void): () => void {
	let set = listeners.get(uploadId);
	if (!set) listeners.set(uploadId, (set = new Set()));
	set.add(listener);
	return () => {
		set.delete(listener);
		if (set.size === 0 && listeners.get(uploadId) === set) listeners.delete(uploadId);
	};
}

/**
 * Sends an event to every listener of the upload. A listener that throws is removed, because the only listeners
 * are progress streams and a throwing one belongs to a closed connection.
 */
export function emitUploadEvent(uploadId: string, event: UploadEvent): void {
	for (const listener of listeners.get(uploadId) ?? []) {
		try {
			listener(event);
		} catch {
			listeners.get(uploadId)?.delete(listener);
		}
	}
}

/** Deletes the temp file of a session and forgets the session; safe when either is already gone. */
export async function cleanupSession(uploadId: string): Promise<void> {
	const session = sessions.get(uploadId);
	if (!session) return;
	sessions.delete(uploadId);
	await rm(session.tempFilePath, { force: true });
}

/** Forgets every session and deletes every temp file. For test isolation and dev-server restarts. */
export async function clearAllSessions(): Promise<void> {
	const paths = [...sessions.values()].map((session) => session.tempFilePath);
	sessions.clear();
	listeners.clear();
	await Promise.all(paths.map((path) => rm(path, { force: true })));
}

/**
 * The size of the session's temp file on disk, 0 when the session or the file is missing.
 *
 * Why the file and not `session.bytesReceived`: the resume offset must match the bytes that are really stored,
 * also after a request died between receiving a chunk and writing it.
 */
export async function getTempFileSize(uploadId: string): Promise<number> {
	const session = sessions.get(uploadId);
	if (!session) return 0;
	try {
		return (await stat(session.tempFilePath)).size;
	} catch {
		return 0;
	}
}

/**
 * Reads a file as a stream of chunks of at most `chunkSize` bytes.
 *
 * Why not `readFile`: a streaming upload handler exists for files too large to buffer, so replaying the temp file
 * must hold one chunk at a time; the next chunk is read only when the consumer pulls.
 */
export function fileChunks(path: string, chunkSize = FILE_CHUNK_BYTES): ReadableStream<Uint8Array> {
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			handle ??= await open(path, "r");
			const buffer = new Uint8Array(chunkSize);
			const { bytesRead } = await handle.read(buffer, 0, chunkSize, null);
			if (bytesRead === 0) {
				await handle.close();
				handle = undefined;
				controller.close();
				return;
			}
			controller.enqueue(buffer.subarray(0, bytesRead));
		},
		async cancel() {
			await handle?.close();
			handle = undefined;
		},
	});
}
