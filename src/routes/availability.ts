import {Hono} from "hono";
import {RezdyClient, RezdyError} from "../rezdy-client";
import type {Env} from "../types";
import {toStatusCode} from "../types";

const availability = new Hono<{ Bindings: Env }>();

/**
 * GET /api/availability
 *
 * Spec-correct query params:
 *   productCode * — Rezdy product code (e.g. PYYHYR)
 *   startTimeLocal * — yyyy-MM-dd HH:mm:ss (preferred over ISO startTime)
 *   endTimeLocal * — yyyy-MM-dd HH:mm:ss
 *   minAvailability — integer, total guests (spec param name, not "qty")
 *
 * Returns sessions with seatsAvailable and priceOptions.
 * Called when the user lands on step 2 after confirming guest count in step 1.
 */

const productCodeFmt = /^[A-Z0-9_-]{3,50}$/i;

// const localTimeFmt = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

function pad2(value: number): string {
    return String(value).padStart(2, "0");
}

function formatDateTimeLocal(date: Date, endOfDay = false): string {
    const year = date.getFullYear();
    const month = pad2(date.getMonth() + 1);
    const day = pad2(date.getDate());
    const time = endOfDay ? "23:59:59" : "00:00:00";

    return `${year}-${month}-${day} ${time}`;
}

function getAvailabilityWindow(month?: string): { startTimeLocal: string; endTimeLocal: string } | { error: string } {
    if (month) {
        if (!/^\d{4}-\d{2}$/.test(month)) {
            return {error: 'month must be in format "yyyy-MM".'};
        }

        const [yearRaw, monthRaw] = month.split("-");
        const year = Number(yearRaw);
        const monthNumber = Number(monthRaw);

        if (monthNumber < 1 || monthNumber > 12) {
            return {error: "month must be between 01 and 12."};
        }

        const start = new Date(year, monthNumber - 1, 1);
        const end = new Date(year, monthNumber, 0);

        return {
            startTimeLocal: formatDateTimeLocal(start),
            endTimeLocal: formatDateTimeLocal(end, true),
        };
    }

    const start = new Date();
    const end = new Date(start);
    end.setMonth(end.getMonth() + 1);

    return {
        startTimeLocal: formatDateTimeLocal(start),
        endTimeLocal: formatDateTimeLocal(end, true),
    };
}

availability.get("/products", async (c) => {
    const {
        productsCode,
        month,
        minAvailability,
    } = c.req.query();

    if (!productsCode) {
        return c.json({error: "Missing required param: productsCode."}, 400);
    }

    const productCodes = productsCode
        .split(",")
        .map((productCode) => productCode.trim())
        .filter(Boolean);

    if (productCodes.length < 2) {
        return c.json(
            {error: "productsCode must contain at least two product codes."},
            400
        );
    }

    if (productCodes.some((productCode) => !productCodeFmt.test(productCode))) {
        return c.json({error: "Invalid product code format."}, 400);
    }

    const window = getAvailabilityWindow(month);
    if ("error" in window) {
        return c.json({error: window.error}, 400);
    }

    const baseParams: Record<string, string> = {
        startTimeLocal: window.startTimeLocal,
        endTimeLocal: window.endTimeLocal,
    };

    if (minAvailability) {
        const qty = parseInt(minAvailability, 10);
        if (isNaN(qty) || qty < 1 || qty > 50) {
            return c.json(
                {error: "minAvailability must be a number between 1 and 50."},
                400
            );
        }
        baseParams.minAvailability = String(qty);
    }

    try {
        const client = new RezdyClient(c.env);

        const products = await Promise.all(
            productCodes.map(async (productCode) => {
                try {
                    const data = await client.get("/availability", {
                        ...baseParams,
                        productCode,
                    });

                    return {
                        productCode,
                        availability: data,
                    };
                } catch (err) {
                    if (err instanceof RezdyError && err.status === 422) {
                        return {
                            productCode,
                            availability: {sessions: []},
                        };
                    }

                    throw err;
                }
            })
        );

        return c.json({
            startTimeLocal: window.startTimeLocal,
            endTimeLocal: window.endTimeLocal,
            products,
        });
    } catch (err) {
        if (err instanceof RezdyError) {
            return c.json(
                {error: "Failed to fetch availability.", detail: err.body},
                toStatusCode(err.status)
            );
        }

        throw err;
    }
});

availability.get("/", async (c) => {
    const {
        productCode,
        startTimeLocal,
        endTimeLocal,
        minAvailability,
    } = c.req.query();

    // Validate required params
    const missing: string[] = [];
    if (!productCode) missing.push("productCode");
    if (!startTimeLocal) missing.push("startTimeLocal");
    if (!endTimeLocal) missing.push("endTimeLocal");

    if (missing.length) {
        return c.json(
            {error: `Missing required params: ${missing.join(", ")}.`},
            400
        );
    }

    if (!/^[A-Z0-9_-]{3,50}$/i.test(productCode)) {
        return c.json({error: "Invalid product code format."}, 400);
    }

    // Validate local time format: yyyy-MM-dd HH:mm:ss
    const localTimeFmt = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
    if (!localTimeFmt.test(startTimeLocal) || !localTimeFmt.test(endTimeLocal)) {
        return c.json(
            {
                error:
                    'startTimeLocal and endTimeLocal must be in format "yyyy-MM-dd HH:mm:ss".',
            },
            400
        );
    }

    // minAvailability is optional but if provided must be a sane number
    const params: Record<string, string> = {
        productCode,
        startTimeLocal,
        endTimeLocal,
    };

    if (minAvailability) {
        const qty = parseInt(minAvailability, 10);
        if (isNaN(qty) || qty < 1 || qty > 50) {
            return c.json(
                {error: "minAvailability must be a number between 1 and 50."},
                400
            );
        }
        params.minAvailability = String(qty);
    }

    try {
        const client = new RezdyClient(c.env);
        const data = await client.get("/availability", params);
        return c.json(data);
    } catch (err) {
        if (err instanceof RezdyError) {
            if (err.status === 422) {
                return c.json(
                    {error: "No availability for the selected dates.", sessions: []},
                    200
                );
            }
            return c.json(
                {error: "Failed to fetch availability.", detail: err.body},
                toStatusCode(err.status)
            );
        }
        throw err;
    }
});

export default availability;
