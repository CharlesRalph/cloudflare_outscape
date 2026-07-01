import { Hono } from "hono";
import { RezdyClient, RezdyError } from "../rezdy-client";
import type { Env } from "../types";
import { toStatusCode } from "../types";

const extras = new Hono<{ Bindings: Env }>();

/**
 * GET /api/extras/:productCode
 *
 * Returns the extras array from the product response.
 * Each extra includes: id, name, description, price, extraPriceType, image.
 *
 * extraPriceType determines qty behaviour in the UI:
 *   PER_PERSON   — qty capped to total guest count
 *   PER_BOOKING  — qty is always 1
 *   ANY — free qty input
 *
 * Note: extras are included in GET /api/product as well.
 * Use this dedicated route only if you need a lean extras-only response
 * (e.g. lazy-loading step 4 without re-fetching the full product).
 */
extras.get("/:productCode", async (c) => {
  const productCode = c.req.param("productCode");

  if (!/^[A-Z0-9_-]{3,50}$/i.test(productCode)) {
    return c.json({ error: "Invalid product code format." }, 400);
  }

  try {
    const client = new RezdyClient(c.env);

    // Extras live inside the product response — pluck them out
    const data = await client.get<{
      product?: {
        extras?: Array<{
          id: number;
          name: string;
          description?: string;
          price?: number;
          extraPriceType?: string;
          image?: { itemUrl?: string; thumbnailUrl?: string };
        }>;
      };
    }>(`/products/${productCode}`);

    const extrasData = data?.product?.extras ?? [];

    return c.json({ extras: extrasData });
  } catch (err) {
    if (err instanceof RezdyError) {
      return c.json(
        { error: "Failed to fetch extras.", detail: err.body },
        toStatusCode(err.status)
      );
    }
    throw err;
  }
});

export default extras;
