/**
 * Stub for @cloudflare/sandbox used by vitest-pool-workers.
 * The real module imports @cloudflare/containers (a workerd built-in)
 * which isn't available in the test environment.
 */

export class Sandbox {
	constructor() {
		throw new Error("Sandbox is not available in tests");
	}
}

export function getSandbox(_ns: unknown, _id: string): never {
	throw new Error("getSandbox is not available in tests");
}
