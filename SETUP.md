# Appointment inquiries setup

The website uses serverless functions and Supabase so appointment inquiries
are stored centrally. The functions run on Netlify and Vercel. Multiple
inquiries can be made for the same date while it is still pending; confirming
one inquiry reserves that date and the database prevents a second confirmed
appointment on that date. When Microsoft Calendar is connected, confirming an
inquiry adds an all-day event for its preferred date. Pending inquiries are not
added to the calendar.

## 1. Set up Supabase

1. Create a Supabase project.
2. In the Supabase SQL Editor, run [`supabase-schema.sql`](./supabase-schema.sql).
   If the `appointment_inquiries` table already exists, run the schema again to
   add the phone-number column used by new booking inquiries.
3. In the Supabase project settings, copy the project URL and service-role key.
   Keep the service-role key private; configure it only as a serverless
   deployment environment variable, never in the website HTML.

## 2. Set up notifications and Microsoft Calendar

Configure these environment variables for the deployment platform (Netlify or
Vercel):

| Variable | Purpose |
| --- | --- |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Private Supabase service-role key |
| `RESEND_API_KEY` | Resend API key for email notifications |
| `RESEND_FROM_EMAIL` | Verified sender address in Resend |
| `APPOINTMENT_NOTIFICATION_EMAIL` | Email address that receives inquiries |
| `WHATSAPP_ACCESS_TOKEN` | Meta WhatsApp Cloud API access token |
| `WHATSAPP_PHONE_NUMBER_ID` | Meta WhatsApp Business phone-number ID |
| `WHATSAPP_NOTIFICATION_NUMBER` | Recipient number in international format, digits only (for example `96176007280`) |
| `WHATSAPP_TEMPLATE_NAME` | Approved WhatsApp template name |
| `WHATSAPP_TEMPLATE_LANGUAGE` | Template language code, such as `en` |
| `WHATSAPP_GRAPH_API_VERSION` | Optional Graph API version; defaults to `v23.0` |
| `MICROSOFT_CLIENT_ID` | Application (client) ID from the Microsoft Entra app registration |
| `MICROSOFT_CLIENT_SECRET` | Private client secret from that registration; store only in the platform's environment settings |
| `MICROSOFT_REDIRECT_URI` | Exact deployed callback URL, ending in `/.netlify/functions/microsoft-calendar` |
| `MICROSOFT_LOGIN_EMAIL` | `Sales.charbelnakhle@gmail.com`; used to pre-fill Microsoft sign-in |
| `CALENDAR_CONNECT_SECRET` | A long, private passphrase protecting the calendar connection page |
| `CALENDAR_WEBHOOK_SECRET` | A separate long, private secret used to authenticate the Supabase webhook |

The approved WhatsApp template must have four body placeholders in this order:
customer name, customer email, business type, and preferred date. Meta requires
an approved template to initiate a WhatsApp notification outside an existing
customer-initiated conversation.

### Microsoft app registration and connection

1. Deploy the site and choose its public HTTPS URL. Microsoft cannot return an
   authorization response to a local `file://` page.
2. In the Microsoft Entra admin center, register an application that supports
   **accounts in any organizational directory and personal Microsoft accounts**.
   Add a **Web** redirect URI that exactly matches the deployed
   `MICROSOFT_REDIRECT_URI` (without a query string). Create a client secret and
   configure the delegated Microsoft Graph permissions `User.Read` and
   `Calendars.ReadWrite`. Do not put the client secret in site files or send it
   in chat.
3. Run [`supabase-schema.sql`](./supabase-schema.sql) in the Supabase SQL Editor.
   The calendar credential and OAuth-state tables are restricted to the
   server-side service role; keep that key private.
4. Set the Microsoft and calendar environment variables above in your
   deployment platform, then redeploy. Generate separate, high-entropy values
   for the two calendar secrets.
5. While signed into the deployed site, open
   `https://YOUR_SITE/.netlify/functions/microsoft-calendar?action=connect`.
   Enter `CALENDAR_CONNECT_SECRET`, then sign in to Microsoft and grant the
   requested calendar access. The completion page shows the Microsoft account
   returned by Microsoft; verify it is the intended calendar. The login hint
   for `Sales.charbelnakhle@gmail.com` does not itself guarantee which account
   Microsoft authorizes.
6. In Supabase, create a Database Webhook for **UPDATE** on
   `public.appointment_inquiries`. Set its URL to
   `https://YOUR_SITE/.netlify/functions/microsoft-calendar?action=confirmed`
   and add the HTTP header `x-calendar-webhook-secret` with the value of
   `CALENDAR_WEBHOOK_SECRET`. The webhook payload must include `record` and
   `old_record`. It only synchronizes a transition to `confirmed`; other
   updates and pending inquiries are ignored.

The preferred date is currently the only booking time the form collects, so the
calendar entry is an all-day event marked busy, with the customer and business
details in its body. The appointment time still needs to be arranged separately.
The calendar event ID and sync time are stored with the inquiry. Function logs
report a failed calendar sync. After correcting the configuration, retry a
confirmed inquiry by sending its ID to the protected retry endpoint. Set the
same `CALENDAR_CONNECT_SECRET` in your local PowerShell session without
including it in the command text or sharing it:

```powershell
$headers = @{ Authorization = "Bearer $env:CALENDAR_CONNECT_SECRET" }
$body = '{"inquiryId":"123"}'
Invoke-RestMethod -Method Post `
  -Uri "https://YOUR_SITE/.netlify/functions/microsoft-calendar?action=retry" `
  -Headers $headers -ContentType "application/json" -Body $body
```

## 3. Deploy

### Vercel

The Vercel API handlers in [`api/`](./api/) adapt the existing functions under
[`netlify/functions/`](./netlify/functions/) so the same backend logic runs on
either platform. [`vercel.json`](./vercel.json) maps the existing function URLs
to the Vercel handlers, so the website and Microsoft callback paths stay
consistent.

1. In Vercel, import the GitHub repository `charbelnakhle666-maker/Cmedia.com`
   or open the existing project and connect that repository under **Settings >
   Git**.
2. Use the repository root as the Root Directory. No build command or output
   directory is needed for this static HTML site.
3. Add all environment variables from section 2 to the Vercel project settings
   for every environment that will serve the site, then redeploy.
4. Set `MICROSOFT_REDIRECT_URI` to
   `https://YOUR_VERCEL_DOMAIN/.netlify/functions/microsoft-calendar` and
   register that exact URL as a **Web** redirect URI in Microsoft Entra.
5. Update the Supabase Database Webhook URL to
   `https://YOUR_VERCEL_DOMAIN/.netlify/functions/microsoft-calendar?action=confirmed`.

### Netlify

Connect the project to Netlify through Git, or use the Netlify CLI from this
folder (`netlify login`, then `netlify init` for a new site). Add the environment
variables in the Netlify site settings, then deploy the site so Netlify publishes
both the HTML and the functions. A static drag-and-drop deployment or the local
PowerShell file server does not run serverless functions. Use Netlify Dev for
local end-to-end testing.

## 4. Confirm an appointment

Review inquiries in the Supabase `appointment_inquiries` table. To confirm an
inquiry, update its status to `confirmed` in the Supabase table editor. Only one
inquiry for each date can be confirmed; the unique database index rejects any
second confirmation for that date. Pending inquiries do not block other
inquiries for the same date. If configured, the Supabase Database Webhook adds
the confirmed appointment to the connected Microsoft Calendar.
