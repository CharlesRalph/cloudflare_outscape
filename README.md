# rezdy-proxy

Cloudflare Worker (Hono) — secure API proxy for the Outscape booking flow.
Sits between the Webflow React component and the Rezdy API.
The Rezdy API key never touches the browser.

All field names match the Rezdy OpenAPI specification exactly.

---

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Set secrets

Never commit these. Set them via the Wrangler CLI:

```bash
# Your Rezdy supplier API key
wrangler secret put REZDY_API_KEY

# Exact origin of your Webflow site
# e.g. https://outscape.webflow.io  or  https://outscape.com
wrangler secret put ALLOWED_ORIGIN
```

For local dev, create a `.dev.vars` file (git-ignored):

```env
REZDY_API_KEY=your_key_here
ALLOWED_ORIGIN=http://localhost:3000
```

### 3. Run locally

```bash
npm run dev
# Worker available at http://localhost:8787
```

### 4. Deploy

```bash
npm run deploy -- --env staging
npm run deploy -- --env production
```

---

## API reference

All routes are prefixed `/api/`. Rate limited to 60 requests/IP/minute.

---

### GET /api/product/:productCode

Fetch product details — priceOptions, bookingFields, extras.
Call once on booking flow init and cache in React state.

```
GET /api/product/PYYHYR
```

---

### GET /api/availability

Fetch available sessions for a date window.

Spec-correct param names:
- `startTimeLocal` / `endTimeLocal` — format: `yyyy-MM-dd HH:mm:ss` (preferred)
- `minAvailability` — total guests filter (NOT "qty")

```
GET /api/availability
  ?productCode=PYYHYR
  &startTimeLocal=2026-07-01 00:00:00
  &endTimeLocal=2026-07-31 23:59:59
  &minAvailability=2
```

---

### GET /api/extras/:productCode

Returns the extras list for a product.
Also available inside the GET /api/product response — use this only
if you need lazy-loading step 4 without a full product re-fetch.

```
GET /api/extras/PYYHYR
```

---

### POST /api/booking

Two modes via the `status` field:

**PROCESSING** — creates a reservation hold (60 min). Use this first to lock
the session. Do NOT include creditCard.

**CONFIRMED** — confirms the booking with payment. Include `creditCard.cardToken`
generated client-side via Stripe.js. Rezdy charges the card via RezdyPay.

Key field names from the OpenAPI spec:
- `quantities[].optionLabel` — must exactly match the priceOption label (e.g. "twin share")
- `quantities[].value` — number of that option booked
- `extras[].id` — extra ID (NOT "extraId")
- `startTimeLocal` — format `yyyy-MM-dd HH:mm:ss` (preferred over ISO startTime)
- `fields[]` — per-booking BookingField entries from product.bookingFields
- `items[].participants[]` — per-participant fields (when requiredPerParticipant: true)

```json
POST /api/booking
Content-Type: application/json

{
  "status": "PROCESSING",
  "customer": {
    "firstName": "Jane",
    "lastName": "Smith",
    "email": "jane@example.com",
    "phone": "+61412345678"
  },
  "items": [{
    "productCode": "PYYHYR",
    "startTimeLocal": "2026-07-15 09:00:00",
    "endTimeLocal":   "2026-07-19 17:00:00",
    "quantities": [
      { "optionLabel": "twin share", "value": 1 }
    ],
    "extras": [
      { "id": 123, "quantity": 1 }
    ],
    "participants": []
  }],
  "fields": [
    { "label": "Dietary requirements", "value": "Gluten free" }
  ],
  "comments": "Anniversary trip"
}
```

PROCESSING response:

```json
{
  "orderNumber": "R-12345678",
  "status": "PROCESSING",
  "totalAmount": 4700,
  "totalCurrency": "AUD",
  "totalDue": 4700
}
```

Then to confirm with payment:

```json
POST /api/booking

{
  "status": "CONFIRMED",
  "customer": { ... },
  "items": [ ... same as above ... ],
  "fields": [ ... ],
  "creditCard": {
    "cardToken": "tok_stripe_generated_client_side",
    "cardName": "Jane Smith"
  }
}
```

Raw card numbers (`cardNumber`, `cardSecurityNumber`) are explicitly
rejected by this proxy. Always use `cardToken` from Stripe.js.

---

## Field name corrections from original scaffold

These were wrong in the original Worker and are now fixed:

| Route | Was | Now (spec-correct) |
|---|---|---|
| availability | `qty` | `minAvailability` |
| availability | `startTime` (ISO) | `startTimeLocal` (yyyy-MM-dd HH:mm:ss) |
| booking quantities | `label` | `optionLabel` |
| booking extras | `extraId` | `id` |
| booking | `totalAmount` top-level | lives inside `booking` response object |

---

## Environment variables

| Variable | Where set | Purpose |
|---|---|---|
| `REZDY_API_KEY` | `wrangler secret` | Rezdy API key |
| `ALLOWED_ORIGIN` | `wrangler secret` | CORS origin whitelist |
| `REZDY_BASE_URL` | `wrangler.toml` | Rezdy base URL per environment |
| `RATE_LIMIT_WINDOW_MS` | `wrangler.toml` | Rate limit window ms (default: 60000) |
| `RATE_LIMIT_MAX_REQUESTS` | `wrangler.toml` | Max requests per window per IP (default: 60) |

---

## Calling from the React component

```ts
// Availability — note minAvailability and startTimeLocal
const res = await fetch(
  `https://rezdy-proxy.your-account.workers.dev/api/availability` +
  `?productCode=PYYHYR` +
  `&startTimeLocal=2026-07-01 00:00:00` +
  `&endTimeLocal=2026-07-31 23:59:59` +
  `&minAvailability=2`
);

// PROCESSING hold
const res = await fetch("https://rezdy-proxy.../api/booking", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    status: "PROCESSING",
    customer: { firstName, lastName, email },
    items: [{ productCode, startTimeLocal, endTimeLocal, quantities }],
  }),
});
const { orderNumber } = await res.json();

// CONFIRMED with Stripe token
const stripe = Stripe("pk_live_...");
const { token } = await stripe.createToken(cardElement, { name: cardName });

const res2 = await fetch("https://rezdy-proxy.../api/booking", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    status: "CONFIRMED",
    customer: { firstName, lastName, email },
    items: [ ... ],
    creditCard: { cardToken: token.id, cardName },
  }),
});
```
