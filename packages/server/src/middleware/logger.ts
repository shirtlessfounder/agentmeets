import type { MiddlewareHandler } from "hono";

export function requestLogger(): MiddlewareHandler {
  return async (c, next) => {
    const start = Date.now();
    const method = c.req.method;
    const path = new URL(c.req.url).pathname;

    await next();

    const duration = Date.now() - start;
    const status = c.res.status;
    console.log(`${method} ${path} ${status} ${duration}ms`);
  };
}
