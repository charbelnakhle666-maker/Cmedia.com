import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const supabaseTable = "microsoft_calendar_credentials";
const supabaseStateTable = "microsoft_calendar_oauth_states";
const graphBaseUrl = "https://graph.microsoft.com/v1.0";

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    },
    body: JSON.stringify(body)
  };
}

function htmlResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
    },
    body
  };
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  })[character]);
}

function getSupabaseConfig() {
  const url = process.env.SUPABASE_URL?.replace(/\/+$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("Supabase server configuration is missing.");
  }
  return { url, key };
}

async function supabaseRequest(path, options = {}) {
  const { url, key } = getSupabaseConfig();
  const response = await fetch(`${url}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers
    }
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Supabase request failed (${response.status}).`);
  }
  return body ? JSON.parse(body) : null;
}

function getMicrosoftConfig() {
  const clientId = process.env.MICROSOFT_CLIENT_ID;
  const clientSecret = process.env.MICROSOFT_CLIENT_SECRET;
  const redirectUri = process.env.MICROSOFT_REDIRECT_URI;
  const loginEmail = process.env.MICROSOFT_LOGIN_EMAIL;
  if (!clientId || !clientSecret || !redirectUri || !loginEmail) {
    throw new Error("Microsoft calendar settings are missing.");
  }
  return { clientId, clientSecret, redirectUri, loginEmail };
}

function getRequestBody(event) {
  const body = event.isBase64Encoded
    ? Buffer.from(event.body || "", "base64").toString("utf8")
    : event.body || "";
  return body;
}

function getQueryParams(event) {
  if (event.rawUrl) {
    return new URL(event.rawUrl).searchParams;
  }
  return new URLSearchParams(event.queryStringParameters || {});
}

function matchesSecret(provided, expected) {
  if (typeof provided !== "string" || typeof expected !== "string") return false;
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  return providedBuffer.length === expectedBuffer.length
    && timingSafeEqual(providedBuffer, expectedBuffer);
}

function authorizationUrl(state) {
  const { clientId, redirectUri, loginEmail } = getMicrosoftConfig();
  const url = new URL("https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
  url.search = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    response_mode: "query",
    scope: "openid profile email offline_access User.Read Calendars.ReadWrite",
    state,
    login_hint: loginEmail
  }).toString();
  return url.toString();
}

function page(title, message) {
  return htmlResponse(200, `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<main style="max-width:36rem;margin:4rem auto;padding:1rem;font:16px/1.5 system-ui,sans-serif">
<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(message)}</p>
</main>
</html>`);
}

async function startConnection(event) {
  if (event.httpMethod === "GET") {
    return htmlResponse(200, `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect Microsoft Calendar</title>
<main style="max-width:36rem;margin:4rem auto;padding:1rem;font:16px/1.5 system-ui,sans-serif">
<h1>Connect Microsoft Calendar</h1>
<p>Enter the calendar connection passphrase configured for this site. Microsoft will then ask you to authorize calendar access.</p>
<form method="post" action="?action=connect">
<label for="secret">Connection passphrase</label><br>
<input id="secret" name="secret" type="password" autocomplete="current-password" required style="box-sizing:border-box;width:100%;padding:.7rem;margin:.5rem 0 1rem">
<button type="submit" style="padding:.7rem 1rem">Continue to Microsoft</button>
</form>
</main>
</html>`);
  }

  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { error: "Method not allowed." });
  }

  const expectedSecret = process.env.CALENDAR_CONNECT_SECRET;
  if (!expectedSecret) {
    console.error("Microsoft calendar connection passphrase is not configured.");
    return page("Connection unavailable", "Calendar connection has not been configured for this site.");
  }

  const contentType = event.headers?.["content-type"] || event.headers?.["Content-Type"] || "";
  let providedSecret;
  if (contentType.includes("application/x-www-form-urlencoded")) {
    providedSecret = new URLSearchParams(getRequestBody(event)).get("secret");
  } else if (contentType.includes("application/json")) {
    try {
      providedSecret = JSON.parse(getRequestBody(event)).secret;
    } catch {
      return jsonResponse(400, { error: "Request body must be valid JSON." });
    }
  }
  if (!matchesSecret(providedSecret, expectedSecret)) {
    return page("Connection not authorized", "The connection passphrase was not accepted.");
  }

  try {
    getMicrosoftConfig();
    const state = randomBytes(32).toString("hex");
    const stateHash = createHash("sha256").update(state).digest("hex");
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const expiredStates = new URLSearchParams({
      expires_at: `lt.${new Date().toISOString()}`
    });
    await supabaseRequest(`${supabaseStateTable}?${expiredStates}`, { method: "DELETE" });
    await supabaseRequest(supabaseStateTable, {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ state_hash: stateHash, expires_at: expiresAt })
    });
    return {
      statusCode: 302,
      headers: {
        Location: authorizationUrl(state),
        "Cache-Control": "no-store"
      },
      body: ""
    };
  } catch (error) {
    console.error("Microsoft calendar authorization could not start:", error.message);
    return page("Connection unavailable", "Calendar authorization could not start. Check the site's Microsoft and database settings.");
  }
}

async function exchangeAuthorizationCode(code) {
  const { clientId, clientSecret, redirectUri } = getMicrosoftConfig();
  const response = await fetch("https://login.microsoftonline.com/common/oauth2/v2.0/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      scope: "openid profile email offline_access User.Read Calendars.ReadWrite"
    })
  });
  const tokens = await response.json();
  if (!response.ok || !tokens.access_token || !tokens.refresh_token) {
    throw new Error(`Microsoft authorization code exchange failed (${response.status}).`);
  }
  return tokens;
}

async function refreshAccessToken(credentials) {
  const { clientId, clientSecret, redirectUri } = getMicrosoftConfig();
  const response = await fetch("https://login.microsoftonline.com/common/oauth2/v2.0/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
      refresh_token: credentials.refresh_token,
      redirect_uri: redirectUri,
      scope: "openid profile email offline_access User.Read Calendars.ReadWrite"
    })
  });
  const tokens = await response.json();
  if (!response.ok || !tokens.access_token) {
    throw new Error(`Microsoft access-token refresh failed (${response.status}).`);
  }
  const updatedCredentials = {
    ...credentials,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token || credentials.refresh_token,
    expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString()
  };
  await supabaseRequest(`${supabaseTable}?id=eq.1`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      access_token: updatedCredentials.access_token,
      refresh_token: updatedCredentials.refresh_token,
      expires_at: updatedCredentials.expires_at
    })
  });
  return updatedCredentials;
}

async function getAccessToken() {
  const credentials = await supabaseRequest(
    `${supabaseTable}?id=eq.1&select=access_token,refresh_token,expires_at`
  );
  if (!credentials?.length) {
    throw new Error("Microsoft calendar has not been connected.");
  }
  const stored = credentials[0];
  if (Date.parse(stored.expires_at) > Date.now() + 60_000) {
    return stored.access_token;
  }
  return (await refreshAccessToken(stored)).access_token;
}

function eventTransactionId(inquiryId) {
  const bytes = createHash("sha256")
    .update(`c-media-appointment:${inquiryId}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function createCalendarEvent(inquiry) {
  const accessToken = await getAccessToken();
  const start = new Date(`${inquiry.appointment_date}T00:00:00.000Z`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  const dateLabel = start.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC"
  });
  const response = await fetch(`${graphBaseUrl}/me/events`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Prefer: 'outlook.timezone="UTC"'
    },
    body: JSON.stringify({
      subject: `C Media appointment - ${inquiry.full_name}`,
      body: {
        contentType: "text",
        content: [
          "Confirmed C Media appointment (time to be arranged)",
          `Preferred date: ${dateLabel}`,
          `Name: ${inquiry.full_name}`,
          `Email: ${inquiry.email}`,
          `Business type: ${inquiry.business_type}`
        ].join("\n")
      },
      start: { dateTime: start.toISOString(), timeZone: "UTC" },
      end: { dateTime: end.toISOString(), timeZone: "UTC" },
      isAllDay: true,
      showAs: "busy",
      transactionId: eventTransactionId(inquiry.id)
    })
  });
  if (!response.ok) {
    console.error("Microsoft calendar event creation failed:", response.status);
    throw new Error(`Microsoft calendar event creation failed (${response.status}).`);
  }
  return response.json();
}

function webhookIsAuthorized(event) {
  const expectedSecret = process.env.CALENDAR_WEBHOOK_SECRET;
  const providedSecret = event.headers?.["x-calendar-webhook-secret"]
    || event.headers?.["X-Calendar-Webhook-Secret"];
  return matchesSecret(providedSecret, expectedSecret);
}

async function syncConfirmedInquiry(inquiryId) {
  const query = new URLSearchParams({
    id: `eq.${inquiryId}`,
    status: "eq.confirmed",
    select: "id,full_name,email,business_type,appointment_date,calendar_event_id"
  });
  const inquiries = await supabaseRequest(`appointment_inquiries?${query}`);
  if (!inquiries?.length) {
    return { found: false };
  }

  const inquiry = inquiries[0];
  if (inquiry.calendar_event_id) {
    return { found: true, synced: true, duplicate: true };
  }

  const calendarEvent = await createCalendarEvent(inquiry);
  await supabaseRequest(`appointment_inquiries?id=eq.${inquiry.id}&status=eq.confirmed`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      calendar_event_id: calendarEvent.id,
      calendar_synced_at: new Date().toISOString()
    })
  });
  return { found: true, synced: true };
}

async function handleConfirmationWebhook(event) {
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { error: "Method not allowed." });
  }
  if (!webhookIsAuthorized(event)) {
    return jsonResponse(401, { error: "Not authorized." });
  }

  let payload;
  try {
    payload = JSON.parse(getRequestBody(event));
  } catch {
    return jsonResponse(400, { error: "Request body must be valid JSON." });
  }

  const record = payload?.record;
  if (payload?.table !== "appointment_inquiries"
    || payload?.schema !== "public"
    || payload?.type !== "UPDATE"
    || record?.status !== "confirmed"
    || payload?.old_record?.status === "confirmed"
    || !Number.isSafeInteger(record.id)) {
    return jsonResponse(200, { ignored: true });
  }

  try {
    const result = await syncConfirmedInquiry(record.id);
    if (!result.found) {
      return jsonResponse(200, { ignored: true });
    }
    return jsonResponse(200, result);
  } catch (error) {
    console.error("Confirmed appointment could not be added to Microsoft Calendar:", error.message);
    return jsonResponse(503, { error: "Calendar synchronization failed. Review the function logs and retry the confirmed inquiry." });
  }
}

async function handleSyncRetry(event) {
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { error: "Method not allowed." });
  }
  const expectedSecret = process.env.CALENDAR_CONNECT_SECRET;
  const authorization = event.headers?.authorization || event.headers?.Authorization || "";
  const providedSecret = authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : "";
  if (!matchesSecret(providedSecret, expectedSecret)) {
    return jsonResponse(401, { error: "Not authorized." });
  }

  let body;
  try {
    body = JSON.parse(getRequestBody(event));
  } catch {
    return jsonResponse(400, { error: "Request body must be valid JSON." });
  }
  const inquiryId = String(body?.inquiryId ?? "");
  if (!/^\d+$/.test(inquiryId) || inquiryId === "0") {
    return jsonResponse(400, { error: "A valid inquiryId is required." });
  }

  try {
    const result = await syncConfirmedInquiry(inquiryId);
    if (!result.found) {
      return jsonResponse(404, { error: "No confirmed inquiry was found for that ID." });
    }
    return jsonResponse(200, result);
  } catch (error) {
    console.error("Confirmed appointment calendar retry failed:", error.message);
    return jsonResponse(503, { error: "Calendar synchronization failed. Review the function logs and try again." });
  }
}

async function handleCallback(event) {
  const params = getQueryParams(event);
  const state = params.get("state");
  const code = params.get("code");
  if (!state) {
    return page("Connection failed", "The Microsoft authorization response did not include the required security state. Start the connection again.");
  }

  try {
    const stateHash = createHash("sha256").update(state).digest("hex");
    const query = new URLSearchParams({
      state_hash: `eq.${stateHash}`,
      expires_at: `gt.${new Date().toISOString()}`,
      select: "state_hash"
    });
    const usedStates = await supabaseRequest(`${supabaseStateTable}?${query}`, {
      method: "DELETE",
      headers: { Prefer: "return=representation" }
    });
    if (!usedStates?.length) {
      return page("Connection expired", "This Microsoft authorization link is invalid or expired. Start the connection again.");
    }

    if (!code) {
      return page("Connection cancelled", "Microsoft Calendar access was not granted. You can close this page.");
    }

    const tokens = await exchangeAuthorizationCode(code);
    const profileResponse = await fetch(`${graphBaseUrl}/me?$select=displayName,mail,userPrincipalName`, {
      headers: { Authorization: `Bearer ${tokens.access_token}` }
    });
    const profile = await profileResponse.json();
    if (!profileResponse.ok) {
      throw new Error(`Microsoft account lookup failed (${profileResponse.status}).`);
    }
    const microsoftEmail = profile.mail || profile.userPrincipalName || "";
    const credentials = {
      id: 1,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
      microsoft_user_email: microsoftEmail,
      microsoft_display_name: profile.displayName || ""
    };
    await supabaseRequest(`${supabaseTable}?on_conflict=id`, {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(credentials)
    });

    const { loginEmail } = getMicrosoftConfig();
    const identityMessage = microsoftEmail.toLowerCase() === loginEmail.toLowerCase()
      ? `Microsoft Calendar is connected for ${microsoftEmail}.`
      : `Microsoft Calendar is connected for ${microsoftEmail || profile.displayName}. The requested sign-in address was ${loginEmail}; verify this is the intended account.`;
    return page("Calendar connected", `${identityMessage} Confirmed bookings will now be added as all-day events.`);
  } catch (error) {
    console.error("Microsoft calendar authorization failed:", error.message);
    return page("Connection failed", "Microsoft Calendar could not be connected. Check the site's function logs and try again.");
  }
}

export async function handler(event) {
  const params = getQueryParams(event);
  const action = params.get("action");
  if (action === "connect") {
    return startConnection(event);
  }
  if (action === "confirmed") {
    return handleConfirmationWebhook(event);
  }
  if (action === "retry") {
    return handleSyncRetry(event);
  }
  if ((action === "callback" || !action) && event.httpMethod === "GET") {
    return handleCallback(event);
  }
  return jsonResponse(404, { error: "Not found." });
}
