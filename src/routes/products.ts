import {Hono} from "hono";
import {RezdyClient, RezdyError} from "../rezdy-client";
import type {Env} from "../types";
import {toStatusCode} from "../types";
import {PRODUCTS} from "./availability";
import {cachedJson} from "../cache";

const products = new Hono<{ Bindings: Env }>();

type RezdyProduct = {
    productCode?: string;
    code?: string;
    name?: string;
    priceOptions?: Array<{
        price?: number;
        label?: string;
        [key: string]: unknown;
    }>;
    [key: string]: unknown;
}

type ProductsResponse = {
    products?: RezdyProduct[];
    [key: string]: unknown
}

type CatalogueProduct = {
    productCode: string;
    name: string;
    displayName: string;
    duration: "4day" | "5day";
    departure: "launceston" | "essendon";
    roomGrade: "superior" | "premium";
    basePricePerGuest: number;
    productPricePerGuest: number;
    essendonFlightSurchargePerGuest: number;
};

type LauncestonRoomPrice = {
    room: string;
    premium: number | null;
    superior: number | null;
};

type LauncestonRoomPricesByDuration = {
    duration: "4day" | "5day";
    label: string;
    rooms: LauncestonRoomPrice[];
};

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

function getProductFlight(productName: string): "launceston" | "essendon" | null {
    if (/\|\s*Launceston\s*\(Tas\)\s*Flights\s*$/i.test(productName)) {
        return "launceston";
    }

    if (/\|\s*Essendon\s*\(Vic\)\s*Flights\s*$/i.test(productName)) {
        return "essendon";
    }

    return null;
}

function getProductCode(product: RezdyProduct): string {
    if (typeof product.productCode === "string") return product.productCode;
    if (typeof product.code === "string") return product.code;
    return "";
}

function getConfiguredProduct(productCode: string) {
    return PRODUCTS.find((product) => product.productCode === productCode) ?? null;
}

function getProductDisplayNameFromDuration(duration: "4day" | "5day"): string {
    return duration === "4day"
        ? "The essential experience"
        : "The immersive experience";
}

function getBasePricePerGuest(product: RezdyProduct): number | null {
    const prices = product.priceOptions
        ?.map((priceOption) => priceOption.price)
        .filter((price): price is number => typeof price === "number" && Number.isFinite(price));

    return prices && prices.length > 0 ? Math.min(...prices) : null;
}

function normalizeRoomOptionLabel(label: string): string {
    return label.trim();
}

function getLauncestonRoomPricesForDuration(
    products: RezdyProduct[],
    duration: "4day" | "5day"
): LauncestonRoomPricesByDuration {
    const roomsByLabel = new Map<string, LauncestonRoomPrice>();

    products
        .filter((product) => {
            const name = getProductName(product);
            const days = getProductDays(name);
            const roomGrade = getProductRoom(name);
            const departure = getProductFlight(name);

            return (
                departure === "launceston" &&
                roomGrade !== null &&
                ((duration === "4day" && days === 4) || (duration === "5day" && days === 5))
            );
        })
        .forEach((product) => {
            const roomGrade = getProductRoom(getProductName(product));

            product.priceOptions
                ?.filter((priceOption) => {
                    return (
                        typeof priceOption.label === "string" &&
                        typeof priceOption.price === "number" &&
                        Number.isFinite(priceOption.price)
                    );
                })
                .forEach((priceOption) => {
                    const room = normalizeRoomOptionLabel(String(priceOption.label));
                    const existing = roomsByLabel.get(room) ?? {
                        room,
                        premium: null,
                        superior: null,
                    };

                    if (roomGrade === "premium") {
                        existing.premium = priceOption.price ?? null;
                    }

                    if (roomGrade === "superior") {
                        existing.superior = priceOption.price ?? null;
                    }

                    roomsByLabel.set(room, existing);
                });
        });

    return {
        duration,
        label: duration === "4day" ? "4-day hosted experience" : "5-day hosted experience",
        rooms: Array.from(roomsByLabel.values()),
    };
}

type CatalogueProductDraft = Omit<
    CatalogueProduct,
    "basePricePerGuest" | "essendonFlightSurchargePerGuest"
>;

function toCatalogueProductDraft(product: RezdyProduct): CatalogueProductDraft | null {
    const productCode = getProductCode(product);
    const configuredProduct = getConfiguredProduct(productCode);
    const name = getProductName(product);
    const productPricePerGuest = getBasePricePerGuest(product);

    if (!productCode || !configuredProduct || productPricePerGuest === null) {
        return null;
    }

    return {
        productCode,
        name,
        displayName: getProductDisplayNameFromDuration(configuredProduct.duration),
        duration: configuredProduct.duration,
        departure: configuredProduct.departure,
        roomGrade: configuredProduct.roomGrade,
        productPricePerGuest,
    };
}

function getDurationPricing(
    products: CatalogueProductDraft[],
    duration: "4day" | "5day"
): { basePricePerGuest: number; essendonFlightSurchargePerGuest: number } | null {
    const durationProducts = products.filter((product) => product.duration === duration);

    const launcestonBasePrice = Math.min(
        ...durationProducts
            .filter((product) => product.departure === "launceston")
            .map((product) => product.productPricePerGuest)
    );

    const essendonBasePrice = Math.min(
        ...durationProducts
            .filter((product) => product.departure === "essendon")
            .map((product) => product.productPricePerGuest)
    );

    if (!Number.isFinite(launcestonBasePrice)) {
        return null;
    }

    return {
        basePricePerGuest: launcestonBasePrice,
        essendonFlightSurchargePerGuest: Number.isFinite(essendonBasePrice)
            ? Math.max(essendonBasePrice - launcestonBasePrice, 0)
            : 0,
    };
}

function applyDurationPricing(products: CatalogueProductDraft[]): CatalogueProduct[] {
    const fourDayPricing = getDurationPricing(products, "4day");
    const fiveDayPricing = getDurationPricing(products, "5day");

    return products
        .map((product) => {
            const pricing = product.duration === "4day" ? fourDayPricing : fiveDayPricing;

            if (!pricing) {
                return null;
            }

            return {
                ...product,
                basePricePerGuest: pricing.basePricePerGuest,
                essendonFlightSurchargePerGuest: pricing.essendonFlightSurchargePerGuest,
            };
        })
        .filter((product): product is CatalogueProduct => product !== null);
}

products.get("/filter", async (c) => {
    const {days, flight, room} = c.req.query();

    if (days && !["4", "5"].includes(days)) {
        return c.json({error: 'days must be either "4" or "5".'}, 400);
    }

    if (flight && !["launceston", "essendon"].includes(flight.toLowerCase())) {
        return c.json(
            {error: 'flight must be either "launceston" or "essendon".'},
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
                const productCode = getProductCode(product);
                const configuredProduct = getConfiguredProduct(productCode);

                if (!configuredProduct) {
                    return null;
                }

                return {
                    ...product,
                    filters: {
                        days: configuredProduct.duration === "4day" ? 4 : 5,
                        room: configuredProduct.roomGrade,
                        flight: configuredProduct.departure,
                    },
                };
            })
            .filter((product): product is RezdyProduct & {
                filters: {
                    days: 4 | 5;
                    room: "premium" | "superior";
                    flight: "launceston" | "essendon";
                };
            } => product !== null)
            .filter((product) => {
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
products.get("/catalogue", async (c) => {
    const {days} = c.req.query();

    if (days && !["4", "5"].includes(days)) {
        return c.json({error: 'days must be either "4" or "5".'}, 400);
    }

    try {
        const client = new RezdyClient(c.env);
        const data = await client.get<ProductsResponse>("/products");

        const allProducts = Array.isArray(data.products) ? data.products : [];

        console.log("allProducts", allProducts);

        const durationFilter = days === "4" ? "4day" : days === "5" ? "5day" : null;

        const catalogueProducts = applyDurationPricing(
            allProducts
                .map(toCatalogueProductDraft)
                .filter((product): product is CatalogueProductDraft => product !== null)
        ).filter((product) => {
            return !durationFilter || product.duration === durationFilter;
        });

        const basePrice =
            catalogueProducts.length > 0
                ? Math.min(...catalogueProducts.map((product) => product.basePricePerGuest))
                : null;

        console.log("catalogueProducts", catalogueProducts);

        return c.json({
            filters: {
                days: days ? Number(days) : null,
            },
            basePrice,
            products: catalogueProducts,
        });
    } catch (err) {
        if (err instanceof RezdyError) {
            return c.json(
                {error: "Failed to fetch catalogue products.", detail: err.body},
                toStatusCode(err.status)
            );
        }

        throw err;
    }
});
products.get("/starting-prices", async (c) => {

    const {days} = c.req.query();
    if (days && !["4", "5"].includes(days)) {
        return c.json({error: 'days must be either "4" or "5".'}, 400);
    }

    try {
        return cachedJson(
            c, {
                ttlSeconds: 60 * 30,
                cacheKey: `/api/products/starting-prices:v2?days=${days ?? "all"}`,
            },
            async () => {

                const client = new RezdyClient(c.env);
                const data = await client.get<ProductsResponse>("/products");

                const allProducts = Array.isArray(data.products) ? data.products : [];

                const fourDayPrices = getLauncestonRoomPricesForDuration(allProducts, "4day");
                const fiveDayPrices = getLauncestonRoomPricesForDuration(allProducts, "5day");

                const durations = [fourDayPrices, fiveDayPrices].filter((durationPrices) => {
                    if (days === "4") return durationPrices.duration === "4day";
                    if (days === "5") return durationPrices.duration === "5day";
                    return true;
                });

                return {
                    filters: {
                        days: days ? Number(days) : null,
                    },
                    durations,
                    grouped: {
                        fourDay: fourDayPrices,
                        fiveDay: fiveDayPrices,
                    },
                };
            }
        )
    } catch (err) {
        if (err instanceof RezdyError) {
            return c.json(
                {error: "Failed to fetch starting prices.", detail: err.body},
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
