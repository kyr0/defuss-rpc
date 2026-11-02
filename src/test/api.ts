/** Fixture APIs for the tests: one class, plain-object modules, generators and DSON types. */

export class TestUserApi {
	async getUser(id: string) {
		return { id, name: `User ${id}`, email: `user${id}@example.com`, age: Number.parseInt(id, 10) * 10 };
	}

	async createUser(userData: { name: string; email: string; age: number }) {
		return { id: "new-user-id", ...userData };
	}

	async deleteUser(id: string) {
		return { success: true, deletedId: id };
	}

	/** Synchronous on purpose: the schema reports `async: false`. */
	getUserCount() {
		return 42;
	}

	async throwError(): Promise<never> {
		throw new Error("This is a test error");
	}
}

export const TestMathModule = {
	add: async (a: number, b: number): Promise<number> => a + b,
	multiply: async (a: number, b: number): Promise<number> => a * b,
	divide: async (a: number, b: number): Promise<number> => {
		if (b === 0) throw new Error("Division by zero");
		return a / b;
	},
	/** Synchronous on purpose. */
	pi: () => Math.PI,
};

/** Values plain JSON loses; DSON must restore each one, also as a top-level return value. */
export const TestTypesModule = {
	echo: async (value: unknown) => value,
	bytes: async (length: number) => Uint8Array.from({ length }, (_, i) => i % 256),
	map: async () => new Map<string, number>([["a", 1], ["b", 2]]),
	set: async () => new Set(["x", "y"]),
	date: async () => new Date("2026-11-01T12:00:00.000Z"),
	big: async () => 2n ** 64n,
	nothing: async () => undefined,
	/** What the server received: own keys and whether the prototype is Object.prototype (a decoded `__proto__` key). */
	shape: async (value: object) => ({ keys: Object.keys(value), plainPrototype: Object.getPrototypeOf(value) === Object.prototype }),
};

/** Set when the server-side generator's `finally` ran, so tests can see that a cancelled stream stopped it. */
export const streamState = { finalized: false };

export const TestStreamModule = {
	async *countUp(n: number) {
		for (let i = 0; i < n; i++) yield i;
		return n;
	},
	*syncCount(n: number) {
		for (let i = 0; i < n; i++) yield i * 10;
		return "done";
	},
	async *throwMidStream() {
		yield "a";
		yield "b";
		throw new Error("mid-stream error");
	},
	async *endless() {
		streamState.finalized = false;
		try {
			for (let i = 0; ; i++) {
				yield i;
				await new Promise((resolve) => setTimeout(resolve, 5));
			}
		} finally {
			streamState.finalized = true;
		}
	},
	async wasFinalized() {
		return streamState.finalized;
	},
	async ping() {
		return "pong";
	},
};

/** Deterministic bytes; `seed` varies the pattern so two payloads differ. */
export function testBytes(size: number, seed = 13): Uint8Array<ArrayBuffer> {
	const data = new Uint8Array(new ArrayBuffer(size));
	for (let i = 0; i < size; i++) data[i] = (i * 7 + seed) & 0xff;
	return data;
}
