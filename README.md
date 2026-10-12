# Stripe Payment MVP

A small portfolio project demonstrating a reliable Stripe Checkout payment flow using React, Express, PostgreSQL, and Stripe test mode.

## What it demonstrates

- Server-controlled product pricing
- Stripe Checkout Sessions
- Pending order creation in PostgreSQL
- Stripe API idempotency for safe checkout retries
- Raw-body webhook signature verification
- Payment-state verification before marking an order paid
- Transactional webhook processing
- Database-enforced duplicate webhook protection

## Tech stack

- React + Vite
- Node.js + Express
- PostgreSQL + `pg`
- Stripe Node SDK
- Stripe Checkout in test mode only

## Architecture

```text
React client
  │
  │ POST /api/checkout + Idempotency-Key
  ▼
Express API
  ├─ creates/reuses pending PostgreSQL order
  ├─ creates/reuses Stripe Checkout Session
  └─ returns hosted Checkout URL
  │
  ▼
Stripe Checkout
  │
  ├─ redirects browser to /success or /cancel
  └─ sends checkout.session.completed webhook
       │
       ▼
Express webhook endpoint
  ├─ verifies Stripe signature from raw request body
  ├─ retrieves Checkout Session
  ├─ confirms payment_status is paid
  ├─ records the Stripe event ID in a transaction
  └─ changes order status from pending to paid
```

## Project structure

```text
client/                 React + Vite frontend
server/
  src/
    db/
      pool.js           PostgreSQL connection pool
      schema.sql        Database schema
    index.js            Express API and Stripe webhook logic
```

## Prerequisites

- Node.js
- PostgreSQL
- A Stripe account in test mode
- Stripe CLI for local webhook forwarding

## Environment variables

Create `server/.env`:

```env
PORT=3000
CLIENT_URL=http://localhost:5173

DATABASE_URL=postgresql://postgres:YOUR_PASSWORD@localhost:5432/stripe_payment_mvp

STRIPE_SECRET_KEY=sk_test_your_test_secret_key
STRIPE_WEBHOOK_SECRET=whsec_your_local_webhook_secret
```

Create `client/.env`:

```env
VITE_API_BASE_URL=http://localhost:3000
```

Never commit `.env` files, Stripe secret keys, or webhook signing secrets.

## Database setup

Create a PostgreSQL database named:

```text
stripe_payment_mvp
```

Run `server/src/db/schema.sql` against it using pgAdmin Query Tool.

The schema creates:

- `orders`
- `processed_webhook_events`

If the database already existed before `checkout_idempotency_key` was added, run:

```sql
ALTER TABLE orders
ADD COLUMN checkout_idempotency_key TEXT UNIQUE;
```

## Install and run locally

Install dependencies:

```bash
cd server
npm install

cd ../client
npm install
```

Start Express:

```bash
cd server
npm run dev
```

Start React/Vite in another terminal:

```bash
cd client
npm run dev
```

Open:

```text
http://localhost:5173
```

## Configure Stripe CLI webhooks

Log in to Stripe CLI:

```bash
stripe login
```

Forward Checkout-completed events to local Express:

```bash
stripe listen \
  --events checkout.session.completed \
  --forward-to localhost:3000/api/webhooks/stripe
```

Stripe CLI prints a signing secret beginning with `whsec_`. Copy it into `server/.env` as `STRIPE_WEBHOOK_SECRET`, then restart the Express server.

## API routes

### `GET /api/health`

Confirms the Express API is running.

### `POST /api/orders`

Testing-only route that inserts one pending order.

### `POST /api/checkout`

The real checkout route.

Requires an `Idempotency-Key` header:

```text
Idempotency-Key: <unique UUID>
```

It:

1. Creates or reuses one pending order.
2. Creates or reuses one Stripe Checkout Session.
3. Saves the Stripe Checkout Session ID on the order.
4. Returns the Stripe-hosted Checkout URL.

### `POST /api/webhooks/stripe`

Stripe webhook receiver.

It:

1. Uses `express.raw()` before `express.json()`.
2. Verifies the `Stripe-Signature` header.
3. Handles `checkout.session.completed`.
4. Retrieves the current Checkout Session from Stripe.
5. Requires `payment_status === "paid"`.
6. Uses a PostgreSQL transaction to record the event and mark the order paid.

## Test payment flow

1. Open the React app.
2. Click **Checkout**.
3. On Stripe Checkout, use:

```text
Card number: 4242 4242 4242 4242
Expiry: any future date
CVC: any three digits
Postal code: any valid value
```

4. Complete payment.

Expected results:

- Browser redirects to `/success`.
- Stripe CLI reports a `200` delivery.
- Express logs that the order was marked paid.
- PostgreSQL order status becomes `paid`.
- `processed_webhook_events` contains one `checkout.session.completed` event.

## Test canceled checkout

1. Start a new Checkout flow.
2. Use Stripe Checkout’s own back/cancel control.

Expected results:

- Browser redirects to `/cancel`.
- The browser idempotency key is cleared.
- No payment is made.
- The order remains `pending`.

The browser cancel redirect is not used to update payment state because browser redirects are not trusted payment confirmation.

## Verify database state

Latest orders:

```sql
SELECT
  id,
  payment_status,
  stripe_checkout_session_id,
  checkout_idempotency_key,
  created_at,
  updated_at
FROM orders
ORDER BY created_at DESC
LIMIT 10;
```

Latest processed webhook events:

```sql
SELECT
  stripe_event_id,
  event_type,
  processed_at
FROM processed_webhook_events
ORDER BY processed_at DESC
LIMIT 10;
```

Paid orders must have a Stripe Checkout Session ID:

```sql
SELECT id, payment_status
FROM orders
WHERE payment_status = 'paid'
  AND stripe_checkout_session_id IS NULL;
```

Expected result: zero rows.

## Reliability design

### Checkout idempotency

React creates one UUID per checkout attempt and sends it in the `Idempotency-Key` header.

Express stores it in:

```text
orders.checkout_idempotency_key
```

The same key is also used for Stripe API idempotency.

This prevents accidental duplicate orders and duplicate Checkout Sessions during retries or repeated clicks.

### Webhook idempotency

Stripe may retry webhook delivery. The app stores Stripe event IDs in:

```text
processed_webhook_events.stripe_event_id
```

Because it is a primary key, the same Stripe event cannot be inserted twice.

The webhook transaction does this:

```text
BEGIN
  insert event ID
  find and lock matching order
  change pending → paid
COMMIT
```

If any part fails:

```text
ROLLBACK
```

This ensures an event is not considered processed unless the order update also succeeds.

## Troubleshooting

### Stripe signature verification fails

Check that:

- `STRIPE_WEBHOOK_SECRET` begins with `whsec_`.
- The secret came from the currently running `stripe listen` command.
- The webhook route uses `express.raw()` before `express.json()`.
- Express was restarted after changing `.env`.

### Stripe CLI reports `404`

Check the forwarding path exactly matches:

```text
http://localhost:3000/api/webhooks/stripe
```

### Stripe CLI reports `500`

Check Express logs and PostgreSQL availability. A `500` intentionally tells Stripe that processing failed, allowing a later retry.

### Order remains pending after payment

Check:

- Stripe CLI is still running.
- The listener forwarded `checkout.session.completed`.
- The webhook signature was valid.
- The Checkout Session has `payment_status: paid`.
- The order ID in Checkout Session metadata matches a local order.
- PostgreSQL is running.

## Interview talking points

- The client never decides the product price; Express controls price and currency.
- A success-page redirect is not payment confirmation.
- Stripe webhooks are verified with a raw body and webhook signing secret.
- Stripe API idempotency prevents duplicate Checkout Session creation.
- PostgreSQL event IDs and transactions protect against duplicate webhook processing.
- The database records local business state, while Stripe remains the payment provider.

## Stripe documentation

- [Stripe Checkout](https://docs.stripe.com/payments/checkout)
- [Create a Checkout Session](https://docs.stripe.com/api/checkout/sessions/create)
- [Fulfill orders with Checkout](https://docs.stripe.com/checkout/fulfillment)
- [Webhook signature verification](https://docs.stripe.com/webhooks/signature)
- [Stripe API idempotent requests](https://docs.stripe.com/api/idempotent_requests)
- [Stripe CLI](https://docs.stripe.com/stripe-cli)
- [Stripe test cards](https://docs.stripe.com/testing)

