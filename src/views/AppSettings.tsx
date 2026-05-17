/**
 * AppSettings.tsx
 *
 * Settings page rendered inside the Stripe Dashboard. A DMA exec can:
 *   1. Paste their Brevo API key (stored in Stripe Secret Store — never leaves Stripe's infra).
 *   2. Enter the Brevo list ID that new members should be added to.
 *   3. Pick which Stripe Price(s) count as a "membership" purchase.
 *   4. Test the Brevo connection with a single button click.
 *
 * The backend Cloudflare Worker reads these secrets at webhook-handling time,
 * so the exec only needs to configure this once.
 */

import {
  Box,
  Button,
  Divider,
  FormFieldGroup,
  Icon,
  Inline,
  Link,
  Select,
  Spinner,
  TextField,
  ContextView,
} from "@stripe/ui-extension-sdk/ui";
import type { ExtensionContextValue } from "@stripe/ui-extension-sdk/context";
import { createHttpClient, STRIPE_API_KEY } from "@stripe/ui-extension-sdk/http_client";
import Stripe from "stripe";
import { useState, useEffect, useCallback } from "react";
import { useSecretStore } from "@stripe/ui-extension-sdk/secrets";

// Secret keys used in the Stripe Secret Store
const SECRET_BREVO_API_KEY = "brevo_api_key";
const SECRET_BREVO_LIST_ID = "brevo_list_id";
const SECRET_MEMBERSHIP_PRICE_ID = "membership_price_id";

const stripe = new Stripe(STRIPE_API_KEY, {
  httpClient: createHttpClient(),
  apiVersion: "2023-10-16",
});

// Shape of a price option shown in the selector
interface PriceOption {
  value: string; // Stripe Price ID
  label: string; // e.g. "DMA Membership — $20.00"
}

export default function AppSettings({ userContext }: ExtensionContextValue) {
  // ── Secret Store hooks ────────────────────────────────────────────────────
  const { getSecret, setSecret } = useSecretStore();

  // ── Local state ───────────────────────────────────────────────────────────
  const [brevoApiKey, setBrevoApiKey] = useState("");
  const [brevoListId, setBrevoListId] = useState("");
  const [membershipPriceId, setMembershipPriceId] = useState("");
  const [priceOptions, setPriceOptions] = useState<PriceOption[]>([]);

  // UI state
  const [loadingSecrets, setLoadingSecrets] = useState(true);
  const [loadingPrices, setLoadingPrices] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saved" | "error">("idle");
  const [testStatus, setTestStatus] = useState<"idle" | "ok" | "fail">("idle");
  const [testMessage, setTestMessage] = useState("");

  // ── Load saved secrets on mount ───────────────────────────────────────────
  useEffect(() => {
    async function loadSecrets() {
      const [key, listId, priceId] = await Promise.all([
        getSecret(SECRET_BREVO_API_KEY),
        getSecret(SECRET_BREVO_LIST_ID),
        getSecret(SECRET_MEMBERSHIP_PRICE_ID),
      ]);
      // Mask the API key — show placeholder stars if one is already saved
      if (key) setBrevoApiKey("••••••••••••••••");
      if (listId) setBrevoListId(listId);
      if (priceId) setMembershipPriceId(priceId);
      setLoadingSecrets(false);
    }
    loadSecrets();
  }, [getSecret]);

  // ── Load Stripe prices on mount ───────────────────────────────────────────
  useEffect(() => {
    async function loadPrices() {
      try {
        // Fetch active one-time prices and expand the product for a readable label
        const prices = await stripe.prices.list({
          type: "one_time",
          active: true,
          expand: ["data.product"],
          limit: 100,
        });

        const options: PriceOption[] = prices.data.map((price) => {
          const product =
            typeof price.product === "object" && price.product !== null
              ? (price.product as Stripe.Product)
              : null;
          const productName = product?.name ?? "Unknown product";
          const amount =
            price.unit_amount !== null && price.unit_amount !== undefined
              ? new Intl.NumberFormat("en-CA", {
                  style: "currency",
                  currency: price.currency.toUpperCase(),
                }).format(price.unit_amount / 100)
              : "";
          return {
            value: price.id,
            label: amount ? `${productName} — ${amount}` : productName,
          };
        });

        setPriceOptions(options);
      } catch (_err) {
        // Non-fatal — exec can still type the price ID manually
        setPriceOptions([]);
      } finally {
        setLoadingPrices(false);
      }
    }
    loadPrices();
  }, []);

  // ── Save handler ──────────────────────────────────────────────────────────
  const handleSave = useCallback(async () => {
    setSaving(true);
    setSaveStatus("idle");
    try {
      const saves: Promise<void>[] = [];

      // Only update the API key if the exec typed something new (not the mask placeholder)
      if (brevoApiKey && !brevoApiKey.includes("•")) {
        saves.push(setSecret(SECRET_BREVO_API_KEY, brevoApiKey));
      }
      if (brevoListId) saves.push(setSecret(SECRET_BREVO_LIST_ID, brevoListId));
      if (membershipPriceId) saves.push(setSecret(SECRET_MEMBERSHIP_PRICE_ID, membershipPriceId));

      await Promise.all(saves);
      setSaveStatus("saved");
    } catch (_err) {
      setSaveStatus("error");
    } finally {
      setSaving(false);
    }
  }, [brevoApiKey, brevoListId, membershipPriceId, setSecret]);

  // ── Test connection handler ───────────────────────────────────────────────
  const handleTest = useCallback(async () => {
    setTesting(true);
    setTestStatus("idle");
    setTestMessage("");

    try {
      // Retrieve the actual saved key (not the masked display value) to test with
      const savedKey = await getSecret(SECRET_BREVO_API_KEY);
      if (!savedKey) {
        setTestStatus("fail");
        setTestMessage("No API key saved yet — save your settings first.");
        return;
      }

      // Brevo GET /v3/account verifies the key is valid
      const res = await fetch("https://api.brevo.com/v3/account", {
        headers: {
          accept: "application/json",
          "api-key": savedKey,
        },
      });

      if (res.ok) {
        const data = (await res.json()) as { email?: string; companyName?: string };
        setTestStatus("ok");
        setTestMessage(
          `Connected! Brevo account: ${data.companyName ?? data.email ?? "verified"}`
        );
      } else {
        setTestStatus("fail");
        setTestMessage(`Brevo returned ${res.status} — double-check your API key.`);
      }
    } catch (_err) {
      setTestStatus("fail");
      setTestMessage("Couldn't reach Brevo. Check your network or try again.");
    } finally {
      setTesting(false);
    }
  }, [getSecret]);

  // ── Render ────────────────────────────────────────────────────────────────
  if (loadingSecrets) {
    return (
      <ContextView title="DMA Brevo Integration">
        <Box css={{ stack: "x", alignX: "center", padding: "large" }}>
          <Spinner />
        </Box>
      </ContextView>
    );
  }

  return (
    <ContextView
      title="DMA Brevo Integration"
      description="You're almost set — drop in your Brevo API key and we'll start welcoming new members for you."
    >
      {/* ── Brevo credentials ── */}
      <FormFieldGroup
        legend="Brevo connection"
        description="Your API key is stored securely in Stripe — we never see it in plain text after you save."
      >
        <TextField
          label="Brevo API key"
          placeholder="xkeysib-…"
          type="password"
          value={brevoApiKey}
          onChange={(e) => {
            setBrevoApiKey(e.target.value);
            setSaveStatus("idle");
            setTestStatus("idle");
          }}
          description="Find this under Settings → API Keys in your Brevo account."
        />

        <TextField
          label="Brevo list ID"
          placeholder="e.g. 3"
          value={brevoListId}
          onChange={(e) => {
            setBrevoListId(e.target.value);
            setSaveStatus("idle");
          }}
          description="The numeric ID of the Brevo list where new members should land. Find it under Contacts → Lists."
        />

        {/* Test connection button */}
        <Inline css={{ marginTop: "small", gap: "small", alignY: "center" }}>
          <Button
            type="secondary"
            onPress={handleTest}
            disabled={testing}
          >
            {testing ? <Spinner size="small" /> : "Test connection"}
          </Button>
          {testStatus === "ok" && (
            <Inline css={{ color: "success", gap: "xsmall", alignY: "center" }}>
              <Icon name="checkmark" size="small" />
              {testMessage}
            </Inline>
          )}
          {testStatus === "fail" && (
            <Inline css={{ color: "critical", gap: "xsmall", alignY: "center" }}>
              <Icon name="warning" size="small" />
              {testMessage}
            </Inline>
          )}
        </Inline>
      </FormFieldGroup>

      <Divider />

      {/* ── Membership product ── */}
      <FormFieldGroup
        legend="Membership purchase"
        description="Choose which Stripe price triggers the Brevo sync. Only one-time prices are shown."
      >
        {loadingPrices ? (
          <Spinner size="small" />
        ) : priceOptions.length > 0 ? (
          <Select
            label="Membership price"
            value={membershipPriceId}
            onChange={(e) => {
              setMembershipPriceId(e.target.value);
              setSaveStatus("idle");
            }}
          >
            <option value="">— pick a price —</option>
            {priceOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </Select>
        ) : (
          <TextField
            label="Membership price ID"
            placeholder="price_…"
            value={membershipPriceId}
            onChange={(e) => {
              setMembershipPriceId(e.target.value);
              setSaveStatus("idle");
            }}
            description="No active one-time prices found — paste the Price ID from your Stripe Dashboard."
          />
        )}
      </FormFieldGroup>

      <Divider />

      {/* ── Save button + status ── */}
      <Inline css={{ gap: "small", alignY: "center" }}>
        <Button type="primary" onPress={handleSave} disabled={saving}>
          {saving ? <Spinner size="small" /> : "Save settings"}
        </Button>
        {saveStatus === "saved" && (
          <Inline css={{ color: "success", gap: "xsmall", alignY: "center" }}>
            <Icon name="checkmark" size="small" />
            Settings saved — you're all set!
          </Inline>
        )}
        {saveStatus === "error" && (
          <Inline css={{ color: "critical", gap: "xsmall", alignY: "center" }}>
            <Icon name="warning" size="small" />
            Couldn't save — try again or contact your Stripe admin.
          </Inline>
        )}
      </Inline>

      <Box css={{ marginTop: "large" }}>
        <Link
          href="https://app.brevo.com"
          target="_blank"
          type="secondary"
        >
          Open Brevo dashboard ↗
        </Link>
      </Box>
    </ContextView>
  );
}
