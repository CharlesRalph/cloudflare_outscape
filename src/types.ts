export type Env = {
    // Secrets — set via: wrangler secret put <KEY>
    REZDY_API_KEY: string;
    ALLOWED_ORIGIN: string;
    WEBFLOW_API_TOKEN: string;

    // Vars — set in wrangler.toml per environment
    REZDY_BASE_URL: string;
    RATE_LIMIT_WINDOW_MS: string;
    RATE_LIMIT_MAX_REQUESTS: string;
    WEBFLOW_ROOMS_COLLECTION_ID: string;
    WEBFLOW_ROOM_FEATURES_COLLECTION_ID: string;
    STRIPE_PUBLISHABLE_KEY: string;
    STRIPE_SECRET_KEY: string

};

// Safely cast a runtime number to an Hono-compatible status code.
// Falls back to 502 for any code not in our handled set.
export function toStatusCode(
    n: number
): 400 | 401 | 403 | 404 | 422 | 429 | 500 | 502 {
    const allowed = [400, 401, 403, 404, 422, 429, 500, 502] as const;
    return (allowed as readonly number[]).includes(n)
        ? (n as 400 | 401 | 403 | 404 | 422 | 429 | 500 | 502)
        : 502;
}

export type PaymentSchedule = {
    depositAvailable: boolean;
    requiredPaymentType: "deposit_or_full" | "full";
    depositAmount: number;
    balanceAmount: number;
    balanceDueDate: string;
    balanceDueDaysBeforeDeparture: number;
};


// Rezdy domain types (sourced from OpenAPI spec)

/**
 * Quantity — maps to a product priceOption.
 * optionLabel must exactly match the label string returned in product.priceOptions.
 * Spec field name: optionLabel (NOT "label")
 */
export type Quantity = {
    optionLabel: string;  // e.g. "twin share" — must match priceOption label exactly
    optionPrice?: number; // price per unit — optional, Rezdy recalculates server-side
    value: number;        // quantity booked (required)
};

/**
 * Extra — maps to product.extras[].
 * Spec field name: id (NOT "extraId")
 */
export type Extra = {
    id: number;           // extra ID from product.extras[].id
    name?: string;
    quantity: number;
    price?: number;       // Rezdy recalculates, but include for clarity
};

/**
 * BookingField — per-booking or per-participant custom field.
 * Sourced from product.bookingFields[].
 */
export type BookingField = {
    label: string;
    value: string;
    fieldType?: string;
};

/**
 * Participant — wraps per-participant booking fields.
 * Required when product has bookingFields with requiredPerParticipant: true.
 */
export type Participant = {
    fields: BookingField[];
};

/**
 * BookingItemCreate — the items[] entry in POST /bookings.
 * Uses startTimeLocal (yyyy-MM-dd HH:mm:ss) — preferred over ISO startTime
 * to avoid timezone conversion issues.
 */
export type BookingItemCreate = {
    productCode: string;
    startTimeLocal?: string;  // yyyy-MM-dd HH:mm:ss — preferred
    endTimeLocal?: string;
    startTime?: string;       // ISO 8601 fallback
    endTime?: string;
    quantities: Quantity[];
    extras?: Extra[];
    participants?: Participant[];
};

/**
 * Customer — all fields optional except email for our validation purposes.
 */
export type Customer = {
    firstName: string;
    lastName: string;
    email: string;
    phone?: string;
    mobile?: string;
    newsletter?: boolean;
};

/**
 * CreditCard — use cardToken only (from Stripe.js client-side).
 * Never accept raw card numbers through this proxy.
 */
export type CreditCard = {
    cardToken: string;   // Stripe token generated client-side via Stripe.js
    cardName?: string;
};

/**
 * BookingCreate — the full POST /bookings request body.
 * Matches the "Booking create" schema in the OpenAPI spec.
 */
export type BookingCreate = {
    status: "NEW" | "PROCESSING" | "CONFIRMED";
    customer: Customer;
    items: BookingItemCreate[];
    fields?: BookingField[];       // per-booking custom fields
    comments?: string;
    creditCard?: CreditCard;       // include it for on-site payment via RezdyPay/Stripe
    resellerReference?: string;
    sendNotifications?: boolean;
    paymentOption?: string;
};

/**
 * RezdyPayment — entry in the payments[] array for Own Gateway bookings.
 * Sent on the CONFIRMED booking to record what was charged externally via Stripe.
 */
export type RezdyPayment = {
    amount: number;      // in dollars (e.g. 470.00) — NOT cents
    type: "CREDITCARD";
    label: string;
    currency: string;
};