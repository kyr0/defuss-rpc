import { describe, expect, it } from "vitest";
import { errorMessage, formatLogLine } from "./log.js";

describe("formatLogLine", () => {
	it("starts with the ISO-8601 UTC timestamp and level, then message and key=value fields", () => {
		const now = new Date("2026-11-01T12:00:00.123Z");
		expect(formatLogLine("ERROR", "rpc method threw", { namespace: "UserApi", error: 'bad "id"', skipped: undefined, n: 3 }, now)).toBe(
			'2026-11-01T12:00:00.123Z ERROR defuss-rpc rpc method threw namespace=UserApi error="bad \\"id\\"" n=3',
		);
		expect(formatLogLine("INFO", "listening", { url: "" }, now)).toBe('2026-11-01T12:00:00.123Z INFO defuss-rpc listening url=""');
	});

	it("errorMessage reads Error messages and stringifies other throws", () => {
		expect(errorMessage(new Error("x"))).toBe("x");
		expect(errorMessage("plain")).toBe("plain");
		expect(errorMessage(404)).toBe("404");
	});
});
