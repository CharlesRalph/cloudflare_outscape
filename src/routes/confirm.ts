import {Hono} from "hono";
import Stripe from "stripe";
import {RezdyClient, RezdyError} from "../rezdy-client";
import type {
    Env,
    Customer,
    BookingItemCreate,
    BookingField,
    RezdyPayment,
} from "../types";
import {toStatusCode} from "../types";
import {
    validateCustomer,
    validateQuantities,
    validateExtras,
    validateParticipants,
    validateBookingFields,
} from "./booking";

const confirm = new Hono<{ Bindings: Env }>();

/**
 * POST /api/booking/confirm
 *
 * 1. Retrieves the Stripe PaymentIntent server-side and verifies:
 *    - status === "succeeded"
 *    - metadata.orderNumber matches the provided orderNumber (tamper protection)
 * 2. Sends POST /bookings to Rezdy with status: "CONFIRMED" and a payments[]
 *    record reflecting what Stripe actually charged (deposit or full).
 * 3. Returns success or a descriptive error.
 *
 * Request body:
 * {
 *   paymentIntentId: string   — from stripe.confirmPayment() on the frontend
 *   orderNumber: string       — Rezdy order reference from POST /api/booking
 *   customer: Customer
 *   items: BookingItemCreate[]
 *   fields?: BookingField[]
 *   comments?: string
 * }
 */
confirm.post("/", async (c) => {
    let body: {
        paymentIntentId?: unknown;
        orderNumber?: unknown;
        customer?: unknown;
        items?: unknown;
        fields?: unknown;
        comments?: unknown;
    };

    try {
        body = await c.req.json();
    } catch {
        return c.json({error: "Invalid JSON body."}, 400);
    }

    const {paymentIntentId, orderNumber, customer, items, fields, comments} = body;

    // ── Validate required identity fields ──
    if (typeof paymentIntentId !== "string" || !paymentIntentId.trim()) {
        return c.json({error: "paymentIntentId is required."}, 400);
    }

    if (typeof orderNumber !== "string" || !orderNumber.trim()) {
        return c.json({error: "orderNumber is required."}, 400);
    }

    // ── Validate booking fields (same rules as the hold) ──
    if (!validateCustomer(customer)) {
        return c.json(
            {error: "customer must include valid firstName, lastName, and email."},
            400
        );
    }

    if (!Array.isArray(items) || items.length === 0) {
        return c.json({error: "items must be a non-empty array."}, 400);
    }

    const localTimeFmt = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

    for (const [i, item] of (items as Record<string, unknown>[]).entries()) {
        if (!item.productCode || !/^[A-Z0-9_-]{3,50}$/i.test(item.productCode as string)) {
            return c.json({error: `items[${i}].productCode is missing or invalid.`}, 400);
        }

        const hasLocalTimes = item.startTimeLocal && item.endTimeLocal;
        const hasIsoTimes = item.startTime && item.endTime;
        if (!hasLocalTimes && !hasIsoTimes) {
            return c.json(
                {error: `items[${i}] must include startTimeLocal+endTimeLocal or startTime+endTime.`},
                400
            );
        }

        if (item.startTimeLocal && !localTimeFmt.test(item.startTimeLocal as string)) {
            return c.json(
                {error: `items[${i}].startTimeLocal must be in format "yyyy-MM-dd HH:mm:ss".`},
                400
            );
        }

        if (!validateQuantities(item.quantities)) {
            return c.json(
                {error: `items[${i}].quantities must be a non-empty array of { optionLabel, value } objects.`},
                400
            );
        }

        if (item.extras !== undefined && !validateExtras(item.extras)) {
            return c.json(
                {error: `items[${i}].extras must be an array of { id, quantity } objects.`},
                400
            );
        }

        if (item.participants !== undefined && !validateParticipants(item.participants)) {
            return c.json(
                {error: `items[${i}].participants must be an array of { fields: [] } objects.`},
                400
            );
        }
    }

    if (fields !== undefined && !validateBookingFields(fields)) {
        return c.json(
            {error: "fields must be an array of { label, value } objects."},
            400
        );
    }

    // ── Step 1: Verify PaymentIntent server-side with Stripe ──
    const stripe = new Stripe(c.env.STRIPE_SECRET_KEY, {
        httpClient: Stripe.createFetchHttpClient(),
    });

    let paymentIntent: Stripe.PaymentIntent;

    try {
        paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId.trim());
    } catch (err) {
        if (err instanceof Stripe.errors.StripeError) {
            return c.json(
                {error: "Could not retrieve payment details.", detail: err.message},
                400
            );
        }
        throw err;
    }

    // ── Step 2: Verify payment succeeded ──
    if (paymentIntent.status !== "succeeded") {
        return c.json(
            {
                error: "Payment has not been completed.",
                detail: `PaymentIntent status is "${paymentIntent.status}".`,
            },
            400
        );
    }

    // ── Step 3: Verify orderNumber matches metadata (tamper protection) ──
    if (paymentIntent.metadata?.orderNumber !== orderNumber.trim()) {
        console.error(
            `orderNumber mismatch — metadata: ${paymentIntent.metadata?.orderNumber}, request: ${orderNumber}`
        );
        return c.json(
            {error: "Payment reference does not match the booking. Please contact support."},
            400
        );
    }

    // ── Step 4: Extract charge details from metadata ──
    const chargeAmountDollars = parseFloat(paymentIntent.metadata?.chargeAmount ?? "0");
    const paymentType = paymentIntent.metadata?.paymentType ?? "full";
    const currency = paymentIntent.currency.toUpperCase(); // Stripe stores lowercase

    if (!chargeAmountDollars || chargeAmountDollars <= 0) {
        return c.json(
            {error: "Could not determine charge amount from payment record."},
            500
        );
    }

    // ── Step 5: Build Rezdy payments[] record ──
    const paymentLabel =
        paymentType === "deposit"
            ? "Deposit paid via Outscape Website"
            : "Full payment via Outscape Website";

    const rezdyPayment: RezdyPayment = {
        amount: chargeAmountDollars,  // dollars — Rezdy does not use cents
        type: "CREDITCARD",
        label: paymentLabel,
        currency,
    };

    // ── Step 6: Send CONFIRMED booking to Rezdy ──
    const typedCustomer = customer as Customer;
    const typedItems = items as BookingItemCreate[];
    const typedFields = (fields ?? []) as BookingField[];
    const typedComments = typeof comments === "string" ? comments.trim() : "";

    const rezdyPayload = {
        status: "CONFIRMED" as const,
        resellerReference: `outscape-${orderNumber.trim()}`,
        customer: {
            firstName: typedCustomer.firstName.trim(),
            lastName: typedCustomer.lastName.trim(),
            email: typedCustomer.email.trim().toLowerCase(),
            phone: typedCustomer.phone?.trim(),
        },
        items: typedItems.map((item) => ({
            productCode: item.productCode,
            startTimeLocal: item.startTimeLocal,
            endTimeLocal: item.endTimeLocal,
            startTime: item.startTime,
            endTime: item.endTime,
            quantities: item.quantities.map((q) => ({
                optionLabel: q.optionLabel,
                value: q.value,
                ...(q.optionPrice !== undefined && {optionPrice: q.optionPrice}),
            })),
            extras: (item.extras ?? []).map((e) => ({id: e.id, quantity: e.quantity})),
            participants: item.participants ?? [],
        })),
        fields: typedFields,
        comments: typedComments,
        payments: [rezdyPayment],
        sendNotifications: true, // triggers Rezdy confirmation email to customer
    };

    try {
        const client = new RezdyClient(c.env);
        const data = await client.post<{
            requestStatus?: { success: boolean; error?: string; errorMessage?: string };
            booking?: {
                orderNumber: string;
                status: string;
                totalAmount: number;
                totalCurrency: string;
                totalDue: number;
            };
        }>("/bookings", rezdyPayload);

        if (!data?.requestStatus?.success) {
            const detail =
                data?.requestStatus?.errorMessage ??
                data?.requestStatus?.error ??
                "Unknown error";
            return c.json(
                {error: "Booking confirmation failed. Payment was taken — please contact support.", detail},
                502
            );
        }

        const b = data.booking;
        if (!b?.orderNumber) {
            return c.json(
                {error: "Booking confirmed by Rezdy but no order number returned."},
                500
            );
        }

        return c.json({
            success: true,
            orderNumber: b.orderNumber,
            status: b.status,
            totalAmount: b.totalAmount,
            totalCurrency: b.totalCurrency,
            totalDue: b.totalDue,
            chargeAmount: chargeAmountDollars,
            paymentType,
        });
    } catch (err) {
        if (err instanceof RezdyError) {
            return c.json(
                {
                    error: "Booking confirmation failed. Payment was taken — please contact support.",
                    detail: err.body,
                },
                toStatusCode(err.status)
            );
        }
        throw err;
    }
});

export default confirm;