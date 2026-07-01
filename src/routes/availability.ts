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
