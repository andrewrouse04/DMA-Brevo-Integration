/**
 * webhook.ts
 *
 * Handles the incoming `checkout.session.completed` Stripe webhook.
 *
 * Flow:
 *   1. Verify the Stripe signature so we reject forged requests.
 *   2. Check the event is for the configured membership Price ID.
 *   3. Extract email + name from the session.
 *   4. Call Brevo to create-or-update the contact.
 *   5. Return 2xx to Stripe immediately so it doesn't retry unnecessarily.
 *
 * Idempotency: Stripe may deliver the same event more than once. Because
 * Brevo's `updateEnabled: true` is a safe upsert, duplicate deliveries are
 * harmless — the contact is simply updated in place with the same data.
 */

import Stripe from "stripe";
import { upsertBrevoContact } from "./brevo.js";

export interface WebhookEnv {
  STRIPE_WEBHOOK_SECRET: string;
  BREVO_API_KEY: string;
  BREVO_LIST_ID: string;
  // Comma-separated Product IDs configured via the settings page,
  // e.g. "prod_abc,prod_def". Every price under a ticked product is included
  // automatically — add new annual membership products there, no code change needed.
  MEMBERSHIP_PRODUCT_IDS: string;
}

/**
 * Entry point called by the Worker for every POST to /webhook.
 * Returns a Response that should be forwarded directly to Stripe.
 */
export async function handleWebhook(
  request: Request,
  env: WebhookEnv
): Promise<Response> {
  // ── 1. Read raw body (needed for signature verification) ──────────────────
  const rawBody = await request.text();
  const signature = request.headers.get("stripe-signature");

  if (!signature) {
    return new Response("Missing stripe-signature header", { status: 400 });
  }

  // ── 2. Verify webhook signature ───────────────────────────────────────────
  let event: Stripe.Event;
  try {
    // Stripe's SDK uses the Web Crypto API when available (Workers runtime)
    const stripe = new Stripe(env.STRIPE_WEBHOOK_SECRET, {
      apiVersion: "2023-10-16",
    });
    event = await stripe.webhooks.constructEventAsync(
      rawBody,
      signature,
      env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Webhook signature verification failed:", message);
    return new Response(`Webhook signature error: ${message}`, { status: 400 });
  }

  // ── 3. Only handle checkout.session.completed ─────────────────────────────
  if (event.type !== "checkout.session.completed") {
    // Acknowledge events we don't handle — Stripe expects 2xx for all events
    return new Response("Event type not handled", { status: 200 });
  }

  const session = event.data.object as Stripe.Checkout.Session;

  // ── 4. Check this session includes a price from a configured product ─────
  // Parse the comma-separated list into a Set for O(1) lookups.
  const allowedProductIds = new Set(
    env.MEMBERSHIP_PRODUCT_IDS.split(",").map((id) => id.trim()).filter(Boolean)
  );

  const isSyncedPurchase = sessionIncludesAllowedProduct(session, allowedProductIds);

  if (!isSyncedPurchase) {
    // This checkout didn't include any price from our configured products — skip it.
    return new Response("Not a synced purchase", { status: 200 });
  }

  // ── 5. Extract buyer details ──────────────────────────────────────────────
  const email =
    session.customer_email ??
    session.customer_details?.email ??
    null;

  if (!email) {
    // Can't create a Brevo contact without an email — log and return 2xx so
    // Stripe doesn't keep retrying (this isn't a transient failure)
    console.error("checkout.session.completed missing email", { sessionId: session.id });
    return new Response("No email found in session", { status: 200 });
  }

  // Split the full name into first/last best-effort
  const fullName = session.customer_details?.name ?? null;
  const { firstName, lastName } = splitName(fullName);

  // ── 6. Sync to Brevo ──────────────────────────────────────────────────────
  const listId = parseInt(env.BREVO_LIST_ID, 10);
  if (isNaN(listId)) {
    console.error("BREVO_LIST_ID is not a valid number:", env.BREVO_LIST_ID);
    return new Response("Server configuration error", { status: 500 });
  }

  try {
    await upsertBrevoContact(env.BREVO_API_KEY, {
      email,
      firstName,
      lastName,
      listId,
    });
    console.log("Brevo contact synced:", { email, sessionId: session.id });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Log the error but still return 2xx — Stripe retrying won't help a Brevo
    // API error, and we don't want to get stuck in a retry loop.
    // A production setup would push this to an alerting channel.
    console.error("Failed to sync contact to Brevo:", message, { email, sessionId: session.id });
  }

  return new Response("OK", { status: 200 });
}

/**
 * Returns true if the checkout session contains at least one line item whose
 * price belongs to a product in `allowedProductIds`.
 *
 * Matching at the product level means all prices under a configured product
 * (e.g. different price points or currencies for the same membership) are
 * included automatically without any settings change.
 *
 * Requires line items to be expanded on the session object. Configure your
 * Stripe Checkout session creation with `expand: ["line_items"]` — without
 * expansion we skip the session rather than guess, which prevents event-ticket
 * buyers from landing on the members list.
 */
function sessionIncludesAllowedProduct(
  session: Stripe.Checkout.Session,
  allowedProductIds: Set<string>
): boolean {
  // Fast path: metadata explicitly set by the checkout creation call
  const metaProductId = session.metadata?.membership_product_id;
  if (metaProductId && allowedProductIds.has(metaProductId)) {
    return true;
  }

  const lineItems = (session as Stripe.Checkout.Session & {
    line_items?: Stripe.ApiList<Stripe.LineItem>;
  }).line_items;

  if (!lineItems?.data) {
    // Line items not expanded — skip rather than assume. Configure Stripe
    // Checkout to expand line_items or pass metadata.membership_product_id.
    console.warn(
      "Line items not expanded on session — skipping Brevo sync to avoid false positives.",
      { sessionId: session.id }
    );
    return false;
  }

  return lineItems.data.some((item) => {
    // price.product is always a string ID when line_items are expanded but
    // price.product is not further expanded — which is the expected case.
    const productId =
      typeof item.price?.product === "string"
        ? item.price.product
        : item.price?.product?.id;
    return productId !== undefined && allowedProductIds.has(productId);
  });
}

/**
 * Splits a full name string into first and last name.
 * Best-effort: treats everything before the last space as the first name.
 */
function splitName(fullName: string | null): {
  firstName: string | null;
  lastName: string | null;
} {
  if (!fullName || fullName.trim() === "") {
    return { firstName: null, lastName: null };
  }
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 1) {
    return { firstName: parts[0], lastName: null };
  }
  const lastName = parts[parts.length - 1];
  const firstName = parts.slice(0, -1).join(" ");
  return { firstName, lastName };
}
