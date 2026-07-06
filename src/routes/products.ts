import {Hono} from "hono";
import {RezdyClient, RezdyError} from "../rezdy-client";
import type {Env} from "../types";
import {toStatusCode} from "../types";

const products = new Hono<{ Bindings: Env }>();

type RezdyProduct = {
    productCode?: string;
    code?: string;
    name?: string;
    [key: string]: unknown;
}

type ProductsResponse = {
    products?: RezdyProduct[];
    [key: string]: unknown
}

function getProductName(product: RezdyProduct): string {
    return typeof product.name === "string" ? product.name : "";
}

function getProductDays(productName: string): 4 | 5 | null {
    if (/^4-Day\b/i.test(productName)) return 4;
    if (/^5-Day\b/i.test(productName)) return 5;
    return null;
}

function getProductRoom(productName: string): "premium" | "superior" | null {
    if (/\|\s*Premium Room\s*\|/i.test(productName)) return "premium";
    if (/\|\s*Superior Room\s*\|/i.test(productName)) return "superior";
    return null;
}

function getProductFlight(productName: string): "melbourne" | "tasmania" | null {
    if (/\|\s*Melbourne Flights\s*$/i.test(productName)) return "melbourne";
    if (/\|\s*Tasmania Flights\s*$/i.test(productName)) return "tasmania";
    return null;
}

products.get("/filter", async (c) => {
    const {days, flight, room} = c.req.query();

    if (days && !["4", "5"].includes(days)) {
        return c.json({error: 'days must be either "4" or "5".'}, 400);
    }

    if (flight && !["melbourne", "tasmania"].includes(flight.toLowerCase())) {
        return c.json(
            {error: 'flight must be either "melbourne" or "tasmania".'},
            400
        );
    }

    if (room && !["premium", "superior"].includes(room.toLowerCase())) {
        return c.json(
            {error: 'room must be either "premium" or "superior".'},
            400
        );
    }

    try {
        const client = new RezdyClient(c.env);
        const data = await client.get<ProductsResponse>("/products");

        const allProducts = Array.isArray(data.products) ? data.products : [];

        const normalizedProducts = allProducts
            .map((product) => {
                const productName = getProductName(product);
                const productDays = getProductDays(productName);
                const productRoom = getProductRoom(productName);
                const productFlight = getProductFlight(productName);

                return {
                    ...product,
                    filters: {
                        days: productDays,
                        room: productRoom,
                        flight: productFlight,
                    },
                };
            })
            .filter((product) => {
                if (!product.filters.days || !product.filters.room || !product.filters.flight) {
                    return false;
                }

                if (days && product.filters.days !== Number(days)) {
                    return false;
                }

                if (flight && product.filters.flight !== flight.toLowerCase()) {
                    return false;
                }

                if (room && product.filters.room !== room.toLowerCase()) {
                    return false;
                }

                return true;
            });

        return c.json({
            filters: {
                days: days ? Number(days) : null,
                flight: flight ? flight.toLowerCase() : null,
                room: room ? room.toLowerCase() : null,
            },
            grouped: {
                fourDay: normalizedProducts.filter((product) => product.filters.days === 4),
                fiveDay: normalizedProducts.filter((product) => product.filters.days === 5),
            },
            products: normalizedProducts,
        });
    } catch (err) {
        if (err instanceof RezdyError) {
            return c.json(
                {error: "Failed to fetch filtered products.", detail: err.body},
                toStatusCode(err.status)
            );
        }

        throw err;
    }
});

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
        return c.json({error: "Invalid product code format."}, 400);
    }

    try {
        const client = new RezdyClient(c.env);
        const data = await client.get(`/products/${productCode}`);
        return c.json(data);
    } catch (err) {
        if (err instanceof RezdyError) {
            return c.json(
                {error: "Failed to fetch product.", detail: err.body},
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
                {error: "Failed to fetch products.", detail: err.body},
                toStatusCode(err.status)
            );
        }
        throw err;
    }

});

export default products;
