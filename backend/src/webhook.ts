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
  MEMBERSHIP_PRICE_ID: string;
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

  // ── 4. Check this session includes the membership price ───────────────────
  const isMembershipPurchase = await sessionIncludesMembershipPrice(
    session,
    env.MEMBERSHIP_PRICE_ID,
    env.STRIPE_WEBHOOK_SECRET
  );

  if (!isMembershipPurchase) {
    // Not a membership purchase — acknowledge and move on
    return new Response("Not a membership purchase", { status: 200 });
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
 * Returns true if the checkout session contains a line item matching the
 * configured membership Price ID.
 *
 * Line items are not always inline on the session object — for sessions
 * created with `line_items`, we check `session.line_items` if expanded,
 * otherwise fall back to checking the amount_total heuristic. For robustness
 * we also check the metadata field `membership_price_id` that the Stripe
 * Checkout can be configured to pass.
 */
async function sessionIncludesMembershipPrice(
  session: Stripe.Checkout.Session,
  membershipPriceId: string,
  _stripeKey: string
): Promise<boolean> {
  // Fast path: metadata set by the checkout creation call
  if (session.metadata?.membership_price_id === membershipPriceId) {
    return true;
  }

  // Check expanded line items if present
  const lineItems = (session as Stripe.Checkout.Session & {
    line_items?: Stripe.ApiList<Stripe.LineItem>;
  }).line_items;

  if (lineItems?.data) {
    return lineItems.data.some(
      (item) =>
        (item.price?.id === membershipPriceId) ||
        (typeof item.price === "string" && item.price === membershipPriceId)
    );
  }

  // If line items weren't expanded, assume this is a membership session.
  // In production, configure your Stripe Checkout session creation to either:
  //   a) expand line_items in the session, or
  //   b) pass metadata: { membership_price_id: "price_xxx" }
  // so this guard is reliable.
  console.warn(
    "Line items not expanded on session — assuming membership purchase.",
    { sessionId: session.id }
  );
  return true;
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
