require("dotenv").config();

const express = require("express");
const cors = require("cors");
const Stripe = require("stripe");
const pool = require("./db/pool");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const app = express();

app.use(
  cors({
    origin: process.env.CLIENT_URL || "http://localhost:5173",
  }),
);

const PRODUCT = Object.freeze({
  name: "Stripe Payment MVP",
  amountCents: 1999,
  currency: "usd",
});

// added before express.json() middleware to handle raw body for Stripe webhook signature verification
app.post(
  "/api/webhooks/stripe",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const signature = req.headers["stripe-signature"];

    // Validate the Stripe signature to ensure the webhook is from Stripe
    if (!signature) {
      return res.status(400).json({
        error: "Missing Stripe signature.",
      });
    }

    let event;
    // Verify the webhook signature using the Stripe library
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        signature,
        process.env.STRIPE_WEBHOOK_SECRET,
      );
    } catch (error) {
      console.error(
        "Stripe webhook signature verification failed:",
        error.message,
      );

      return res.status(400).json({
        error: "Invalid webhook signature.",
      });
    }
    // Handle the webhook event based on its type
    if (event.type !== "checkout.session.completed") {
      return res.status(200).json({
        received: true,
        ignored: true,
      });
    }
    // Retrieve the Checkout Session to confirm payment status
    try {
      const checkoutSession = await stripe.checkout.sessions.retrieve(
        event.data.object.id,
      );

      if (checkoutSession.payment_status !== "paid") {
        console.log(
          `Checkout Session ${checkoutSession.id} is not paid yet: ${checkoutSession.payment_status}`,
        );

        return res.status(200).json({
          received: true,
          paymentConfirmed: false,
        });
      }

      // Use a database transaction to ensure atomicity of operations
      const client = await pool.connect();

      try {
        // Start a transaction
        await client.query("BEGIN");

        const eventResult = await client.query(
          `INSERT INTO processed_webhook_events (stripe_event_id, event_type)
     VALUES ($1, $2)
     ON CONFLICT (stripe_event_id) DO NOTHING
     RETURNING stripe_event_id`,
          [event.id, event.type],
        );
        // If the event has already been processed, return early to avoid duplicate processing
        if (eventResult.rowCount === 0) {
          await client.query("COMMIT");

          return res.status(200).json({
            received: true,
            duplicate: true,
          });
        }

        const orderResult = await client.query(
          `SELECT id, payment_status
     FROM orders
     WHERE id = $1
       AND stripe_checkout_session_id = $2
     FOR UPDATE`,
          [checkoutSession.metadata.order_id, checkoutSession.id],
        );

        if (orderResult.rowCount !== 1) {
          throw new Error("No matching order found for the Checkout Session.");
        }

        const order = orderResult.rows[0];

        if (order.payment_status === "pending") {
          await client.query(
            `UPDATE orders
       SET payment_status = 'paid', updated_at = NOW()
       WHERE id = $1`,
            [order.id],
          );
        } else if (order.payment_status !== "paid") {
          throw new Error(
            `Cannot mark an order with status "${order.payment_status}" as paid.`,
          );
        }

        await client.query("COMMIT");

        console.log(
          `Marked order ${order.id} as paid from Stripe event ${event.id}.`,
        );

        return res.status(200).json({
          received: true,
          paymentConfirmed: true,
        });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      console.error("Webhook processing failed:", error.message);

      return res.status(500).json({
        error: "Webhook processing failed.",
      });
    }
  },
);

app.use(express.json());

app.get("/api/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    service: "stripe-payment-api",
  });
});

app.post("/api/orders", async (req, res) => {
  try {
    const result = await pool.query(
      `INSERT INTO orders (product_name, amount_cents, currency)
       VALUES ($1, $2, $3)
       RETURNING id, product_name, amount_cents, currency, payment_status, created_at`,
      [PRODUCT.name, PRODUCT.amountCents, PRODUCT.currency],
    );

    res.status(201).json({
      order: result.rows[0],
    });
  } catch (error) {
    console.error("Failed to create pending order:", error);
    res.status(500).json({
      error: "Unable to create the order.",
    });
  }
});

app.post("/api/checkout", async (req, res) => {
  const checkoutIdempotencyKey = req.get("Idempotency-Key");
  // Validate the Idempotency-Key header
  if (!checkoutIdempotencyKey || checkoutIdempotencyKey.length > 255) {
    return res.status(400).json({
      error: "A valid Idempotency-Key header is required.",
    });
  }

  try {
    const orderResult = await pool.query(
      `INSERT INTO orders (
        product_name,
        amount_cents,
        currency,
        checkout_idempotency_key
      )
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (checkout_idempotency_key)
      DO UPDATE SET checkout_idempotency_key = EXCLUDED.checkout_idempotency_key
      RETURNING id, stripe_checkout_session_id`,
      [
        PRODUCT.name,
        PRODUCT.amountCents,
        PRODUCT.currency,
        checkoutIdempotencyKey,
      ],
    );

    const order = orderResult.rows[0];

    // If the order already has a Stripe Checkout Session ID, retrieve the existing session
    if (order.stripe_checkout_session_id) {
      const existingSession = await stripe.checkout.sessions.retrieve(
        order.stripe_checkout_session_id,
      );

      return res.status(200).json({
        checkoutUrl: existingSession.url,
      });
    }
    // Create a new Stripe Checkout Session
    const session = await stripe.checkout.sessions.create(
      {
        mode: "payment",
        line_items: [
          {
            price_data: {
              currency: PRODUCT.currency,
              product_data: {
                name: PRODUCT.name,
              },
              unit_amount: PRODUCT.amountCents,
            },
            quantity: 1,
          },
        ],
        metadata: {
          order_id: order.id,
        },
        success_url: `${process.env.CLIENT_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.CLIENT_URL}/cancel?order_id=${order.id}`,
      },
      {
        idempotencyKey: `checkout:${checkoutIdempotencyKey}`,
      },
    );

    const updateResult = await pool.query(
      `UPDATE orders
       SET stripe_checkout_session_id = $1, updated_at = NOW()
       WHERE id = $2
         AND stripe_checkout_session_id IS NULL
       RETURNING stripe_checkout_session_id`,
      [session.id, order.id],
    );
    // If the update did not affect any rows, it means another request has already set the stripe_checkout_session_id for this order. In that case, retrieve the existing session and return its URL.
    if (updateResult.rowCount === 0) {
      const savedOrder = await pool.query(
        `SELECT stripe_checkout_session_id
         FROM orders
         WHERE id = $1`,
        [order.id],
      );

      const savedSession = await stripe.checkout.sessions.retrieve(
        savedOrder.rows[0].stripe_checkout_session_id,
      );

      return res.status(200).json({
        checkoutUrl: savedSession.url,
      });
    }

    res.status(201).json({
      checkoutUrl: session.url,
    });
  } catch (error) {
    console.error("Failed to create Checkout Session:", error.message);

    res.status(500).json({
      error: "Unable to start checkout.",
    });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`API running on port ${PORT}`);
});

