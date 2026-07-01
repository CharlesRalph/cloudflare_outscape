import { Hono } from "hono";
import { RezdyClient, RezdyError } from "../rezdy-client";
import type { Env } from "../types";
import { toStatusCode } from "../types";

const products = new Hono<{ Bindings: Env }>();

/**
 * GET /api/products/:productCode
 * GET /api/products
 * Returns product details including priceOptions, bookingFields, and extras.
 * Call once on booking flow init and cache the result in React state.
 */
products.get("/:productCode", async (c) => {
  const productCode = c.req.param("productCode");

  // Basic sanity check — Rezdy product codes are alphanumeric
  if (!/^[A-Z0-9_-]{3,50}$/i.test(productCode)) {
    return c.json({ error: "Invalid product code format." }, 400);
  }

  try {
    const client = new RezdyClient(c.env);
    const data = await client.get(`/products/${productCode}`);
    return c.json(data);
  } catch (err) {
    if (err instanceof RezdyError) {
      return c.json(
        { error: "Failed to fetch product.", detail: err.body },
        toStatusCode(err.status)
      );
    }
    throw err;
  }
});

products.get("/", async (c) => {
  try {
    const client = new RezdyClient(c.env)
    const data = await client.get("/products");
    return c.json(data);
  } catch (err) {
    if (err instanceof RezdyError) {
      return c.json(
        { error: "Failed to fetch products.", detail: err.body },
        toStatusCode(err.status)
      );
    }
    throw err;
  }

});

export default products;
