import { createMiddleware } from "hono/factory";
import type { Env } from "../types";

export const corsMiddleware = createMiddleware<{ Bindings: Env }>(
  async (c, next) => {
    const origin = c.env.ALLOWED_ORIGIN ?? "*";

    // Handle preflight
    if (c.req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": origin,
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, X-CSRF-Token",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    await next();

    c.res.headers.set("Access-Control-Allow-Origin", origin);
    c.res.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    c.res.headers.set(
      "Access-Control-Allow-Headers",
      "Content-Type, X-CSRF-Token"
    );
    return;
  }
);
