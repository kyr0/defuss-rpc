/**
 * One-line, machine-readable log events for the few things defuss-rpc reports on its own.
 *
 * Why a helper instead of plain `console.*` calls: every line starts with an ISO-8601 UTC timestamp and a level,
 * followed by `key=value` fields, so a log collector can parse it and an operator can grep it. The library logs
 * only what the caller cannot see otherwise (a server that started or stopped, a method or handler that threw);
 * client errors such as 403 or 404 travel in the HTTP response and are not logged, and neither are arguments,
 * request headers or return values, because they may carry secrets.
 *
 * @internal
 */

/** Severity of a log event. */
export type LogLevel = "INFO" | "WARN" | "ERROR";

/** Values a log field may hold; they are written with `JSON.stringify` when they contain whitespace. */
export type LogFields = Record<string, string | number | boolean | null | undefined>;

/**
 * Formats one log line: `2026-11-01T12:00:00.000Z ERROR defuss-rpc message key=value`.
 *
 * Kept separate from {@link log} so tests can assert the exact format without capturing the console.
 */
export function formatLogLine(level: LogLevel, message: string, fields: LogFields = {}, now = new Date()): string {
	const pairs = Object.entries(fields)
		.filter(([, value]) => value !== undefined)
		.map(([key, value]) => {
			const text = String(value);
			return `${key}=${/[\s"=]/.test(text) || text === "" ? JSON.stringify(text) : text}`;
		});
	return [now.toISOString(), level, "defuss-rpc", message, ...pairs].join(" ");
}

/** Writes one formatted log line to the console method that matches its level. */
export function log(level: LogLevel, message: string, fields?: LogFields): void {
	// The one place that writes to the console; .vae/VERIFY.py rejects console calls anywhere else in src/.
	const sink = { INFO: console.info, WARN: console.warn, ERROR: console.error }[level];
	sink(formatLogLine(level, message, fields));
}

/** The message of an unknown thrown value; non-Error throws are stringified. */
export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
