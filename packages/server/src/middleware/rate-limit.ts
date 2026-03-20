import type { Context, Next } from "hono";

interface RateLimitEntry {
  count: number;
  resetTime: number;
}

export function rateLimiter(maxRequests = 10, windowMs = 60_000) {
  const clients = new Map<string, RateLimitEntry>();

  // Periodically clean up expired entries
  setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of clients) {
      if (now >= entry.resetTime) {
        clients.delete(ip);
      }
    }
  }, windowMs).unref();

  return async (c: Context, next: Next) => {
    const ip =
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
      c.req.header("x-real-ip") ??
      "unknown";

    const now = Date.now();
    const entry = clients.get(ip);

    if (!entry || now >= entry.resetTime) {
      clients.set(ip, { count: 1, resetTime: now + windowMs });
      return next();
    }

    entry.count++;
    if (entry.count > maxRequests) {
      return c.json({ error: "rate_limit_exceeded" }, 429);
    }

    return next();
  };
}
