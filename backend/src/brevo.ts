/**
 * brevo.ts
 *
 * Thin wrapper around the Brevo REST API v3.
 * Only sends the fields we actually need: email, first/last name, list membership.
 * No Brevo SDK — just native fetch.
 */

export interface BrevoContactPayload {
  email: string;
  firstName: string | null;
  lastName: string | null;
  listId: number;
}

/**
 * Creates a new Brevo contact or updates an existing one and adds them to
 * the target list. `updateEnabled: true` makes this idempotent — safe to
 * call multiple times for the same email.
 */
export async function upsertBrevoContact(
  apiKey: string,
  payload: BrevoContactPayload
): Promise<void> {
  const attributes: Record<string, string> = {};
  if (payload.firstName) attributes["FIRSTNAME"] = payload.firstName;
  if (payload.lastName) attributes["LASTNAME"] = payload.lastName;

  const body = {
    email: payload.email,
    attributes,
    listIds: [payload.listId],
    // updateEnabled merges the contact into the list if they already exist
    updateEnabled: true,
  };

  const res = await fetch("https://api.brevo.com/v3/contacts", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "api-key": apiKey,
    },
    body: JSON.stringify(body),
  });

  // 201 = created, 204 = updated (no body) — both are success
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Brevo API error ${res.status}: ${text}`);
  }
}
