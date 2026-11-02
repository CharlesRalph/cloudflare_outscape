import {Hono} from "hono";
import Stripe from "stripe";
import type {Env} from "../types";

const payment = new Hono<{ Bindings: Env }>();

const DEPOSIT_AMOUNT_DOLLARS_PER_GUEST = 1000;

/**
 * POST /api/payment/intent
 *
 * Creates a Stripe PaymentIntent for either a 10% deposit or full payment.
 * Amount calculation is always done server-side — never trust the frontend amount.
 *
 * Request body:
 * {
 *   orderNumber: string — Rezdy order reference from POST /api/booking
 *   paymentType: "deposit" | "full"
 *   totalAmount: number — full booking amount in dollars (e.g. 4700.00) from Rezdy
 *   currency: string — e.g. "AUD"
 *   customerEmail?: string — for Stripe receipt
 * }
 *
 * Response:
 * {
 *   clientSecret: string — passed to Stripe.js on the frontend
 *   chargeAmount: number — amount being charged in dollars (for display only)
 *   publishableKey: string — Stripe publishable key for Stripe.js initialisation
 * }
 */
payment.post("/intent", async (c) => {
    let body: {
        orderNumber?: unknown;
        paymentType?: unknown;
        totalAmount?: unknown;
        guestCount?: unknown;
        currency?: unknown;
        customerEmail?: unknown;
    };

    try {
        body = await c.req.json();
    } catch {
        return c.json({error: "Invalid JSON body."}, 400);
    }

    const {orderNumber, paymentType, totalAmount, guestCount, currency, customerEmail} = body;

    // Validate
    if (typeof orderNumber !== "string" || !orderNumber.trim()) {
        return c.json({error: "orderNumber is required."}, 400);
    }

    if (paymentType !== "deposit" && paymentType !== "full") {
        return c.json({error: 'paymentType must be "deposit" or "full".'}, 400);
    }

    if (typeof totalAmount !== "number" || totalAmount <= 0) {
        return c.json({error: "totalAmount must be a positive number (in dollars)."}, 400);
    }

    if (
        typeof guestCount !== "number" ||
        !Number.isInteger(guestCount) ||
        guestCount < 1 ||
        guestCount > 50
    ) {
        return c.json({error: "guestCount must be an integer between 1 and 50."}, 400);
    }

    if (typeof currency !== "string" || !currency.trim()) {
        return c.json({error: "currency is required (e.g. AUD)."}, 400);
    }

    // Calculate charge amount
    // Rezdy returns amounts in dollars. Stripe requires cents (the smallest unit).
    const depositAmountDollars = DEPOSIT_AMOUNT_DOLLARS_PER_GUEST * guestCount

    const chargeAmountDollars =
        paymentType === "deposit"
            ? Math.min(depositAmountDollars, totalAmount)
            : totalAmount;

    const chargeAmountCents = Math.round(chargeAmountDollars * 100);

    // Stripe minimum is 50 cents
    if (chargeAmountCents < 50) {
        return c.json(
            {error: "Charge amount is below the minimum allowed by Stripe (50 cents)."},
            400
        );
    }

    // Create PaymentIntent
    const stripe = new Stripe(c.env.STRIPE_SECRET_KEY, {
        httpClient: Stripe.createFetchHttpClient(),
    });

    try {
        const paymentIntent = await stripe.paymentIntents.create({
            amount: chargeAmountCents,
            currency: currency.trim().toLowerCase(),
            metadata: {
                orderNumber: orderNumber.trim(),
                paymentType,
                totalAmount: String(totalAmount),       // full booking value (dollars)
                chargeAmount: String(chargeAmountDollars), // what was actually charged (dollars)
            },
            ...(typeof customerEmail === "string" && customerEmail.trim()
                ? {receipt_email: customerEmail.trim().toLowerCase()}
                : {}),
        });

        if (!paymentIntent.client_secret) {
            return c.json({error: "Stripe did not return a client secret."}, 502);
        }

        return c.json({
            clientSecret: paymentIntent.client_secret,
            chargeAmount: chargeAmountDollars,
            publishableKey: c.env.STRIPE_PUBLISHABLE_KEY,
        });
    } catch (err) {
        if (err instanceof Stripe.errors.StripeError) {
            console.error("Stripe error:", err.message);
            return c.json(
                {error: "Failed to create payment intent.", detail: err.message},
                502
            );
        }
        throw err;
    }
});

export default payment;