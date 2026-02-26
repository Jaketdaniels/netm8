import type { MiddlewareHandler } from "hono";

type Env = {
	Variables: { requestId: string };
};

export const requestLogger = (): MiddlewareHandler<Env> => {
	return async (c, next) => {
		const requestId = crypto.randomUUID();
		const start = Date.now();

		c.set("requestId", requestId);
		c.header("x-request-id", requestId);

		await next();

		const durationMs = Date.now() - start;
		console.log(
			JSON.stringify({
				requestId,
				method: c.req.method,
				path: c.req.path,
				status: c.res.status,
				durationMs,
			}),
		);
	};
};
