import { useEffect, useState } from "react";
import "./App.css";

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3000";
const checkoutKeyStorageName = "stripe-mvp-checkout-idempotency-key";

function App() {
  const [apiStatus, setApiStatus] = useState("Checking API connection…");
  const [checkoutState, setCheckoutState] = useState("idle");
  const [checkoutError, setCheckoutError] = useState("");
  const currentPath = window.location.pathname;

  // Check the API health on component mount
  useEffect(() => {
    async function checkApi() {
      try {
        const response = await fetch(`${apiBaseUrl}/api/health`);

        if (!response.ok) throw new Error("Health check failed");

        const data = await response.json();
        setApiStatus(`API connected: ${data.service}`);
      } catch {
        setApiStatus(
          "API unavailable. Start the Express server and try again.",
        );
      }
    }

    checkApi();
  }, []);
  // Clear the idempotency key from sessionStorage when navigating to /success or /cancel
  useEffect(() => {
    if (currentPath === "/success" || currentPath === "/cancel") {
      sessionStorage.removeItem(checkoutKeyStorageName);
    }
  }, [currentPath]);

  async function handleCheckout() {
    if (checkoutState === "loading") return;

    setCheckoutState("loading");
    setCheckoutError("");

    const existingKey = sessionStorage.getItem(checkoutKeyStorageName);
    const idempotencyKey = existingKey ?? crypto.randomUUID();

    sessionStorage.setItem(checkoutKeyStorageName, idempotencyKey);

    try {
      const response = await fetch(`${apiBaseUrl}/api/checkout`, {
        method: "POST",
        headers: {
          "Idempotency-Key": idempotencyKey,
        },
      });

      const data = await response.json();

      if (!response.ok || !data.checkoutUrl) {
        throw new Error(data.error ?? "Unable to start checkout.");
      }

      window.location.assign(data.checkoutUrl);
    } catch (error) {
      setCheckoutState("idle");
      setCheckoutError(error.message);
    }
  }

  if (currentPath === "/success") {
    return (
      <main className="app-shell">
        <section className="return-card">
          <p className="eyebrow">Checkout complete</p>
          <h1>Thanks for your purchase.</h1>
          <p className="intro">
            Your payment is being confirmed securely. This page does not mark
            the order as paid; the verified Stripe webhook will do that.
          </p>
          <a className="return-link" href="/">
            Return to product
          </a>
        </section>
      </main>
    );
  }

  if (currentPath === "/cancel") {
    return (
      <main className="app-shell">
        <section className="return-card">
          <p className="eyebrow">Checkout canceled</p>
          <h1>No payment was made.</h1>
          <p className="intro">
            Your checkout was canceled. You can return and start a new attempt
            whenever you are ready.
          </p>
          <a className="return-link" href="/">
            Return to product
          </a>
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <p className="eyebrow">Stripe payment portfolio MVP</p>
      <h1>Fixed-price checkout, built reliably.</h1>

      <section className="product-card" aria-labelledby="product-name">
        <p className="product-label">One-time purchase</p>
        <h2 id="product-name">Stripe Payment MVP</h2>
        <p className="product-description">
          A fixed-price demo product using Stripe Checkout in test mode.
        </p>
        <p className="price">$19.99 USD</p>

        <button
          className="checkout-button"
          type="button"
          onClick={handleCheckout}
          disabled={checkoutState === "loading"}
        >
          {checkoutState === "loading"
            ? "Redirecting to Checkout..."
            : "Checkout"}
        </button>

        {checkoutError && (
          <p className="checkout-error" role="alert">
            {checkoutError}
          </p>
        )}
      </section>

      <p className="api-status" role="status">
        {apiStatus}
      </p>
    </main>
  );
}

export default App;

