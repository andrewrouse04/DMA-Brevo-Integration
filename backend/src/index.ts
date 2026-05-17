/**
 * index.ts — Cloudflare Worker entry point
 *
 * Routes incoming requests:
 *   POST /webhook  → Stripe webhook handler
 *   GET  /health   → Simple liveness check
 *   *              → 404
 *
 * Secrets are injected by Cloudflare at runtime via `wrangler secret put`.
 * See wrangler.toml for the full list of required secrets.
 */

import { handleWebhook, type WebhookEnv } from "./webhook.js";

export default {
  async fetch(request: Request, env: WebhookEnv): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return new Response("OK", { status: 200 });
    }

    if (request.method === "POST" && url.pathname === "/webhook") {
      return handleWebhook(request, env);
    }

    return new Response("Not found", { status: 404 });
  },
};
