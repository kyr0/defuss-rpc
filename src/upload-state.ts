/**
 * Upload sessions: the server-side state of an upload between its first byte and the handler's result.
 *
 * Why a temp file per upload instead of collecting chunks in memory: an upload can be larger than the server's RAM,
 * a resumed upload must continue where the bytes on disk end (the `HEAD` offset is the file size, not a counter the
 * client could fake), and the handler runs only after the whole body has arrived and its SHA-256 is known.
 * Sessions live in the memory of their server, so a restart forgets them; the files stay in the upload directory until
 * a successful handler run or the server's `close()` removes them.
 */
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

/** Chunk size for replaying a temp file to a streaming handler and for hashing it. */
export const FILE_CHUNK_BYTES = 256 * 1024;

/** What the progress stream reports about one upload. */
export type UploadEvent =
	| ({ type: "progress" } & UploadProgressEvent)
	| ({ type: "complete" } & UploadProgressEvent)
	| { type: "error"; error: string };

/** The upload sessions, progress listeners and temp-file directory of one RPC server. */
export interface UploadState {
	/** The directory that holds the temp files of running uploads. */
	getUploadDir(): string;
	/** Sets the directory for temp files; sessions that already started keep their old path. */
	setUploadDir(dir: string): void;
	/** Creates the upload directory if it does not exist yet. */
	ensureUploadDir(): Promise<void>;
	/**
	 * Creates (or replaces) the session for `uploadId`; its temp file is `{uploadDir}/{uploadId}.part`.
	 * The caller sanitizes `uploadId`, so it cannot leave the upload directory.
	 */
	createSession(uploadId: string, handlerName: string, originalSize: number): UploadSession;
	/** The session for `uploadId`, or `undefined` when none exists (never started, cleaned up or forgotten on restart). */
	getSession(uploadId: string): UploadSession | undefined;
	/** Updates the byte count and/or status of an existing session; unknown IDs are ignored. */
	updateSession(uploadId: string, updates: Partial<Pick<UploadSession, "bytesReceived" | "status">>): void;
	/** Subscribes to the events of one upload (it need not have started yet); returns the unsubscribe function. */
	addUploadListener(uploadId: string, listener: (event: UploadEvent) => void): () => void;
	/**
	 * Sends an event to every listener of the upload. A listener that throws is removed, because the only listeners
	 * are progress streams and a throwing one belongs to a closed connection.
	 */
	emitUploadEvent(uploadId: string, event: UploadEvent): void;
	/** Deletes the temp file of a session and forgets the session; safe when either is already gone. */
	cleanupSession(uploadId: string): Promise<void>;
	/** Forgets every session and listener and deletes every temp file. */
	clearAllSessions(): Promise<void>;
	/**
	 * The size of the session's temp file on disk, 0 when the session or the file is missing.
	 *
	 * Why the file and not `session.bytesReceived`: the resume offset must match the bytes that are really stored,
	 * also after a request died between receiving a chunk and writing it.
	 */
	getTempFileSize(uploadId: string): Promise<number>;
}

/**
 * Creates the upload state of one RPC server, with its temp files in `uploadDir`.
 *
 * Why one state per server instead of one per process: two servers in one process may receive uploads with the
 * same ID, and each must see only its own session, file and progress events.
 * VERIFIED: src/instances.test.ts uploads with one ID to two servers at once and checks each server's bytes, hash
 * and progress stream.
 *
 * Listeners are kept apart from the sessions: a client opens the progress stream before it sends the upload, so a
 * listener must be able to subscribe to an ID whose session does not exist yet, and it must still get the final
 * event after a successful upload removed the session.
 */
export function createUploadState(uploadDir: string): UploadState {
	const sessions = new Map<string, UploadSession>();
	const listeners = new Map<string, Set<(event: UploadEvent) => void>>();
	return {
		getUploadDir: () => uploadDir,
		setUploadDir: (dir) => void (uploadDir = dir),
		ensureUploadDir: async () => void (await mkdir(uploadDir, { recursive: true })),
		createSession(uploadId, handlerName, originalSize) {
			const session: UploadSession = {
				uploadId,
				handlerName,
				originalSize,
				bytesReceived: 0,
				tempFilePath: join(uploadDir, `${uploadId}.part`),
				status: "uploading",
				createdAt: Date.now(),
			};
			sessions.set(uploadId, session);
			return session;
		},
		getSession: (uploadId) => sessions.get(uploadId),
		updateSession(uploadId, updates) {
			const session = sessions.get(uploadId);
			if (!session) return;
			if (updates.bytesReceived !== undefined) session.bytesReceived = updates.bytesReceived;
			if (updates.status !== undefined) session.status = updates.status;
		},
		addUploadListener(uploadId, listener) {
			let set = listeners.get(uploadId);
			if (!set) listeners.set(uploadId, (set = new Set()));
			set.add(listener);
			return () => {
				set.delete(listener);
				if (set.size === 0 && listeners.get(uploadId) === set) listeners.delete(uploadId);
			};
		},
		emitUploadEvent(uploadId, event) {
			for (const listener of listeners.get(uploadId) ?? []) {
				try {
					listener(event);
				} catch {
					listeners.get(uploadId)?.delete(listener);
				}
			}
		},
		async cleanupSession(uploadId) {
			const session = sessions.get(uploadId);
			if (!session) return;
			sessions.delete(uploadId);
			await rm(session.tempFilePath, { force: true });
		},
		async clearAllSessions() {
			const paths = [...sessions.values()].map((session) => session.tempFilePath);
			sessions.clear();
			listeners.clear();
			await Promise.all(paths.map((path) => rm(path, { force: true })));
		},
		async getTempFileSize(uploadId) {
			const session = sessions.get(uploadId);
			if (!session) return 0;
			try {
				return (await stat(session.tempFilePath)).size;
			} catch {
				return 0;
			}
		},
	};
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
