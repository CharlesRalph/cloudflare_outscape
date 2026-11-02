import {Hono} from "hono";
import {RezdyClient, RezdyError} from "../rezdy-client";
import type {Env} from "../types";
import {toStatusCode} from "../types";
import {cachedJson} from "../cache";

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

type RezdyExtra = {
    id: number;
    name: string;
    description?: string;
    price?: number;
    extraPriceType?: string;
    image?: { thumbnailUrl?: string };
    [key: string]: unknown;
};

const EXTRA_THUMBNAILS_BY_ID: Record<number, string> = {
    279802: "https://images.pexels.com/photos/6560289/pexels-photo-6560289.jpeg",
    280429: "https://cdn.prod.website-files.com/6a21416bb27a91bb1e0370ba/6a34b6cca49eba40de513429_AdamGibson_Outscape_0Z3A2752.avif",
    280430: "https://images.pexels.com/photos/18941997/pexels-photo-18941997.jpeg",
    280428: "https://cdn.prod.website-files.com/6a21416bb27a91bb1e0370ba/6a34b755a8be885a9411d9fd_AdamGibson_Outscape_0Z3A9852.avif",
};

function addManualThumbnailsToExtras(extrasData: RezdyExtra[]): RezdyExtra[] {
    return extrasData.map((extra) => ({
        ...extra,
        ...(EXTRA_THUMBNAILS_BY_ID[extra.id] && {
            image: {
                thumbnailUrl: EXTRA_THUMBNAILS_BY_ID[extra.id],
            },
        }),
    }));
}


extras.get("/", async (c) => {
    try {
        return cachedJson(
            c, {
                ttlSeconds: 60 * 60,
                cacheKey: "api/extras",
            },
            async () => {
                const client = new RezdyClient(c.env);
                const data = await client.get<{
                    extras?: RezdyExtra[];
                    [key: string]: unknown;
                }>("/extra");

                return {
                    ...data,
                    extras: addManualThumbnailsToExtras(data.extras ?? []),
                };
            }
        )
    } catch (err) {
        if (err instanceof RezdyError) {
            return c.json(
                {error: "Failed to fetch extras.", detail: err.body},
                toStatusCode(err.status)
            );
        }
        throw err;
    }
});

extras.get("/:productCode", async (c) => {
    const productCode = c.req.param("productCode");

    if (!/^[A-Z0-9_-]{3,50}$/i.test(productCode)) {
        return c.json({error: "Invalid product code format."}, 400);
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

        return c.json({extras: extrasData});
    } catch (err) {
        if (err instanceof RezdyError) {
            return c.json(
                {error: "Failed to fetch extras.", detail: err.body},
                toStatusCode(err.status)
            );
        }
        throw err;
    }
});

export default extras;
