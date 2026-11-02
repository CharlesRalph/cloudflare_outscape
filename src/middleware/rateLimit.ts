import {createMiddleware} from "hono/factory";
import type {Env} from "../types";

// In-memory store per Worker isolated.
// For stricter limiting across all edge nodes, swap this for
// a Cloudflare KV or Durable Object store.
const requestCounts = new Map<string, { count: number; resetAt: number }>();

export const rateLimitMiddleware = createMiddleware<{ Bindings: Env }>(
    async (c, next) => {
        const windowMs = parseInt(c.env.RATE_LIMIT_WINDOW_MS ?? "60000", 10);
        const maxRequests = parseInt(c.env.RATE_LIMIT_MAX_REQUESTS ?? "60", 10);

        // Key by IP — Cloudflare provides this header automatically
        const ip =
            c.req.header("CF-Connecting-IP") ??
            c.req.header("X-Forwarded-For") ??
            "unknown";

        const now = Date.now();
        const entry = requestCounts.get(ip);

        if (!entry || now > entry.resetAt) {
            requestCounts.set(ip, {count: 1, resetAt: now + windowMs});
            await next();
            return;
        }

        entry.count++;

        if (entry.count > maxRequests) {
            return c.json(
                {error: "Too many requests. Please wait before trying again."},
                429
            );
        }

        await next();
        return;
    }
);
