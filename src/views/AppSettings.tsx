/**
 * AppSettings.tsx
 *
 * Settings page rendered inside the Stripe Dashboard. A DMA exec can:
 *   1. Paste their Brevo API key (stored in Stripe Secret Store — never leaves Stripe's infra).
 *   2. Enter the Brevo list ID that new members should be added to.
 *   3. Pick which Stripe Products trigger the Brevo sync — all prices under a
 *      ticked product are included automatically, so adding a new annual
 *      membership product next year is just one checkbox, no code needed.
 *   4. Test the Brevo connection with a single button click.
 *
 * The backend Cloudflare Worker reads these secrets at webhook-handling time,
 * so the exec only needs to configure this once (and re-visit when adding products).
 */

import {
  Box,
  Button,
  Checkbox,
  Divider,
  FormFieldGroup,
  Icon,
  Inline,
  Link,
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
// Comma-separated Stripe Product IDs whose purchases trigger a Brevo sync,
// e.g. "prod_abc,prod_def". Stored at the product level so every price under
// a ticked product is included — no code change needed when adding new products.
const SECRET_MEMBERSHIP_PRODUCT_IDS = "membership_product_ids";

const stripe = new Stripe(STRIPE_API_KEY, {
  httpClient: createHttpClient(),
  apiVersion: "2023-10-16",
});

interface ProductOption {
  value: string; // Stripe Product ID
  label: string; // e.g. "DMA Membership 2025"
}

export default function AppSettings({ userContext }: ExtensionContextValue) {
  // ── Secret Store hooks ────────────────────────────────────────────────────
  const { getSecret, setSecret } = useSecretStore();

  // ── Local state ───────────────────────────────────────────────────────────
  const [brevoApiKey, setBrevoApiKey] = useState("");
  const [brevoListId, setBrevoListId] = useState("");
  // Set of Product IDs the exec has ticked — stored as a comma-separated secret
  const [selectedProductIds, setSelectedProductIds] = useState<Set<string>>(new Set());
  const [productOptions, setProductOptions] = useState<ProductOption[]>([]);

  // UI state
  const [loadingSecrets, setLoadingSecrets] = useState(true);
  const [loadingProducts, setLoadingProducts] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saved" | "error">("idle");
  const [testStatus, setTestStatus] = useState<"idle" | "ok" | "fail">("idle");
  const [testMessage, setTestMessage] = useState("");

  // ── Load saved secrets on mount ───────────────────────────────────────────
  useEffect(() => {
    async function loadSecrets() {
      const [key, listId, productIds] = await Promise.all([
        getSecret(SECRET_BREVO_API_KEY),
        getSecret(SECRET_BREVO_LIST_ID),
        getSecret(SECRET_MEMBERSHIP_PRODUCT_IDS),
      ]);
      // Mask the API key — show placeholder stars if one is already saved
      if (key) setBrevoApiKey("••••••••••••••••");
      if (listId) setBrevoListId(listId);
      if (productIds) {
        setSelectedProductIds(
          new Set(productIds.split(",").map((id) => id.trim()).filter(Boolean))
        );
      }
      setLoadingSecrets(false);
    }
    loadSecrets();
  }, [getSecret]);

  // ── Load Stripe products on mount ─────────────────────────────────────────
  useEffect(() => {
    async function loadProducts() {
      try {
        // Only show active products — archived ones won't accept new purchases
        const products = await stripe.products.list({ active: true, limit: 100 });

        const options: ProductOption[] = products.data.map((product) => ({
          value: product.id,
          label: product.name,
        }));

        // Sort alphabetically so the list is easy to scan
        options.sort((a, b) => a.label.localeCompare(b.label));
        setProductOptions(options);
      } catch (_err) {
        // Non-fatal — exec can paste the product ID manually
        setProductOptions([]);
      } finally {
        setLoadingProducts(false);
      }
    }
    loadProducts();
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
      if (selectedProductIds.size > 0) {
        saves.push(
          setSecret(SECRET_MEMBERSHIP_PRODUCT_IDS, [...selectedProductIds].join(","))
        );
      }

      await Promise.all(saves);
      setSaveStatus("saved");
    } catch (_err) {
      setSaveStatus("error");
    } finally {
      setSaving(false);
    }
  }, [brevoApiKey, brevoListId, selectedProductIds, setSecret]);

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
          <Button type="secondary" onPress={handleTest} disabled={testing}>
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

      {/* ── Membership products ── */}
      <FormFieldGroup
        legend="Membership products"
        description="Tick every Stripe product whose purchase should add someone to your Brevo list. All prices under a ticked product are included — so when you create next year's membership product, just come back here and tick it."
      >
        {loadingProducts ? (
          <Spinner size="small" />
        ) : productOptions.length > 0 ? (
          <Box css={{ stack: "y", gap: "small" }}>
            {productOptions.map((opt) => (
              <Checkbox
                key={opt.value}
                label={opt.label}
                checked={selectedProductIds.has(opt.value)}
                onChange={(e) => {
                  setSelectedProductIds((prev) => {
                    const next = new Set(prev);
                    if (e.target.checked) {
                      next.add(opt.value);
                    } else {
                      next.delete(opt.value);
                    }
                    return next;
                  });
                  setSaveStatus("idle");
                }}
              />
            ))}
          </Box>
        ) : (
          <TextField
            label="Product IDs (comma-separated)"
            placeholder="prod_abc, prod_def"
            value={[...selectedProductIds].join(", ")}
            onChange={(e) => {
              const ids = e.target.value
                .split(",")
                .map((id) => id.trim())
                .filter(Boolean);
              setSelectedProductIds(new Set(ids));
              setSaveStatus("idle");
            }}
            description="No active products found — paste one or more Product IDs from your Stripe Dashboard, separated by commas."
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
        <Link href="https://app.brevo.com" target="_blank" type="secondary">
          Open Brevo dashboard ↗
        </Link>
      </Box>
    </ContextView>
  );
}
