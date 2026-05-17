# DMA Brevo Integration — Stripe App

Automatically adds every new DMA member to your Brevo newsletter list the moment they complete a Stripe checkout. No manual imports, no copy-pasting spreadsheets — just set it up once and it runs itself.

---

## What this does

1. A student buys a DMA membership through your Stripe Checkout link.
2. Stripe triggers a webhook to a small Cloudflare Worker (the "backend").
3. The Worker pulls the buyer's email and name, then calls Brevo to add them to your members list.
4. Brevo handles the rest — welcome emails, newsletters, event invites — through your existing automations.

Nothing else sends email. This app only adds the contact to the list; Brevo does the rest.

---

## Requirements

- A **Stripe account** with the Stripe CLI installed on your laptop.
- A **Brevo account** with an API key and a list ready for members.
- **Node.js 18+** — [nodejs.org](https://nodejs.org)
- **Wrangler CLI** (Cloudflare Workers) — install once: `npm install -g wrangler`

---

## One-time setup (takes about 20 minutes)

### 1 — Clone and install

```bash
git clone https://github.com/your-org/DMA-Brevo-Integration.git
cd DMA-Brevo-Integration

# Install the Stripe App frontend dependencies
npm install

# Install the backend dependencies
cd backend && npm install && cd ..
```

### 2 — Deploy the Cloudflare Worker

The Worker is the small server that Stripe will send purchase notifications to.

```bash
cd backend

# Log in to Cloudflare (one-time, opens a browser)
npx wrangler login

# Deploy the Worker
npm run deploy
```

Wrangler will print a URL that looks like:
```
https://dma-brevo-integration.<your-subdomain>.workers.dev
```
**Copy this URL — you'll need it in step 4.**

### 3 — Add secrets to the Worker

Run each of these commands and paste in the value when prompted. None of these values are stored in any file — they live only inside Cloudflare's encrypted secret store.

```bash
# Your Stripe webhook signing secret (you'll get this in step 4)
npx wrangler secret put STRIPE_WEBHOOK_SECRET

# Your Stripe secret key (starts with sk_live_ or sk_test_)
npx wrangler secret put STRIPE_SECRET_KEY

# Your Brevo API key — find it under Brevo → Settings → API Keys
npx wrangler secret put BREVO_API_KEY

# The numeric ID of your Brevo list — find it under Contacts → Lists
npx wrangler secret put BREVO_LIST_ID

# The Stripe Price ID for the membership (starts with price_)
# Find it in Stripe Dashboard → Products → your membership product → Pricing
npx wrangler secret put MEMBERSHIP_PRICE_ID
```

### 4 — Register the webhook in Stripe

1. Go to **Stripe Dashboard → Developers → Webhooks**.
2. Click **Add endpoint**.
3. Paste your Worker URL with `/webhook` appended:
   ```
   https://dma-brevo-integration.<your-subdomain>.workers.dev/webhook
   ```
4. Under **Events to send**, select: `checkout.session.completed`
5. Click **Add endpoint**.
6. On the next screen, click **Reveal signing secret** and copy it.
7. Run `npx wrangler secret put STRIPE_WEBHOOK_SECRET` again and paste the signing secret.

### 5 — Install the Stripe App and configure settings

```bash
# From the repo root
stripe apps upload
```

Then open your Stripe Dashboard, find the app under **Apps**, and open its settings page. You'll see a form where you can:

- Paste your Brevo API key
- Enter your Brevo list ID
- Select the membership product/price

Click **Test connection** to make sure Brevo responds, then **Save settings**.

> These settings are stored in the Stripe Secret Store — they're separate from the Worker secrets above, and used by the settings UI itself. Both sets need to be filled in for everything to work end-to-end.

---

## Test a purchase locally

```bash
# Terminal 1 — start the Stripe App UI
npm run start

# Terminal 2 — forward test webhooks to your local machine
stripe listen --forward-to https://dma-brevo-integration.<your-subdomain>.workers.dev/webhook

# Terminal 3 — fire a test checkout.session.completed event
stripe trigger checkout.session.completed
```

Watch the output in Terminal 2. You should see `200 OK` and a log line like:
```
Brevo contact synced: { email: 'test@example.com', sessionId: 'cs_test_...' }
```

Then check your Brevo contacts list — the test contact should appear within a few seconds.

---

## Local development (without deploying)

```bash
cd backend
npm run dev   # starts a local Worker at http://localhost:8787

# In another terminal
stripe listen --forward-to localhost:8787/webhook
stripe trigger checkout.session.completed
```

---

## Troubleshooting

| Problem | What to check |
|---|---|
| Webhook shows `400 Webhook signature error` | The `STRIPE_WEBHOOK_SECRET` doesn't match the endpoint's signing secret — re-run `wrangler secret put STRIPE_WEBHOOK_SECRET` with the right value |
| Contact not appearing in Brevo | Check Worker logs in the Cloudflare Dashboard → Workers → your worker → Logs. Look for `Brevo API error` messages |
| "No active one-time prices found" in settings | Your Stripe products may use recurring prices — paste the Price ID manually |
| Test connection says "Couldn't reach Brevo" | Verify the API key in Brevo under Settings → API Keys; make sure it has "Full access" permissions |

---

## File structure

```
/
├── stripe-app.json          # Stripe App manifest — declares permissions and UI extensions
├── package.json
├── tsconfig.json
├── src/
│   └── views/
│       └── AppSettings.tsx  # Settings page shown inside the Stripe Dashboard
└── backend/
    ├── wrangler.toml        # Cloudflare Worker config
    ├── package.json
    ├── tsconfig.json
    └── src/
        ├── index.ts         # Worker entry point — routes requests
        ├── webhook.ts       # Stripe webhook verification and dispatch
        └── brevo.ts         # Brevo API calls
```

---

## Updating the app

To push changes to the settings UI:
```bash
stripe apps upload
```

To push changes to the backend:
```bash
cd backend && npm run deploy
```

---

Made with care for the DeGroote Marketing Association. Come as you are. Leave ready for what's next.
