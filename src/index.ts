import { Hono } from "hono";
import { logger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";
import { corsMiddleware } from "./middleware/cors";
import { rateLimitMiddleware } from "./middleware/rateLimit";
import products from "./routes/products";
import availability from "./routes/availability";
import extras from "./routes/extras";
import booking from "./routes/booking";
import type { Env } from "./types";

const app = new Hono<{ Bindings: Env }>();

// -- Global middleware --
app.use("*", logger());
app.use("*", secureHeaders());
app.use("*", corsMiddleware);
app.use("/api/*", rateLimitMiddleware);

//Health check
app.get("/", (c) =>
  c.json({ status: "ok", service: "rezdy-proxy", version: "1.0.0" })
);

//Routes
app.route("/api/products", products);
app.route("/api/availability", availability);
app.route("/api/extras", extras);
app.route("/api/booking", booking);

//404 fallthrough
app.notFound((c) => c.json({ error: "Route not found." }, 404));

//Unhandled error boundary
app.onError((err, c) => {
  console.error("Unhandled error:", err);
  return c.json({ error: "An unexpected error occurred." }, 500);
});

export default app;
