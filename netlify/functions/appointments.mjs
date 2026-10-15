const responseHeaders = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store"
};

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: responseHeaders,
    body: JSON.stringify(body)
  };
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
    const error = new Error(`Supabase request failed (${response.status}).`);
    error.status = response.status;
    throw error;
  }

  return body ? JSON.parse(body) : null;
}

function isValidDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime())
    && parsed.toISOString().slice(0, 10) === value;
}

function getBusinessDate() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Beirut",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function formatDate(value) {
  return new Date(`${value}T00:00:00.000Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC"
  });
}

function validateInquiry(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return "Please provide the inquiry details.";
  }

  const { fullName, email, phoneNumber, businessType, appointmentDate } = body;
  if (typeof fullName !== "string" || fullName.trim().length < 2 || fullName.trim().length > 100) {
    return "Enter a full name between 2 and 100 characters.";
  }
  if (typeof email !== "string" || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    return "Enter a valid email address.";
  }
  if (typeof phoneNumber !== "string" || !/^\+[1-9]\d{6,14}$/.test(phoneNumber.trim())) {
    return "Enter a valid phone number with its country calling code.";
  }
  if (typeof businessType !== "string" || businessType.trim().length < 2 || businessType.trim().length > 100) {
    return "Enter a business type between 2 and 100 characters.";
  }
  if (!isValidDate(appointmentDate)) {
    return "Choose a valid appointment date.";
  }
  if (appointmentDate < getBusinessDate()) {
    return "Choose today or a future date.";
  }
  return null;
}

async function isDateConfirmed(appointmentDate) {
  const query = new URLSearchParams({
    select: "id",
    appointment_date: `eq.${appointmentDate}`,
    status: "eq.confirmed",
    limit: "1"
  });
  const records = await supabaseRequest(`appointment_inquiries?${query}`);
  return records.length > 0;
}

async function sendEmailNotification(inquiry) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL;
  const to = process.env.APPOINTMENT_NOTIFICATION_EMAIL;
  if (!apiKey || !from || !to) {
    throw new Error("Email notification settings are missing.");
  }

  const date = formatDate(inquiry.appointment_date);
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject: `Appointment inquiry: ${inquiry.full_name} - ${date}`,
      text: [
        "New C Media appointment inquiry",
        `Name: ${inquiry.full_name}`,
        `Email: ${inquiry.email}`,
        `Phone: ${inquiry.phone_number}`,
        `Business type: ${inquiry.business_type}`,
        `Preferred date: ${date}`,
        "",
        "This is a pending inquiry, not a confirmed appointment."
      ].join("\n"),
      reply_to: inquiry.email
    })
  });

  if (!response.ok) {
    throw new Error(`Email provider rejected the notification (${response.status}).`);
  }
}

async function sendWhatsAppNotification(inquiry) {
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const recipient = process.env.WHATSAPP_NOTIFICATION_NUMBER;
  const templateName = process.env.WHATSAPP_TEMPLATE_NAME;
  const language = process.env.WHATSAPP_TEMPLATE_LANGUAGE || "en";
  const apiVersion = process.env.WHATSAPP_GRAPH_API_VERSION || "v23.0";
  if (!accessToken || !phoneNumberId || !recipient || !templateName) {
    throw new Error("WhatsApp notification settings are missing.");
  }

  const response = await fetch(`https://graph.facebook.com/${apiVersion}/${encodeURIComponent(phoneNumberId)}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: recipient,
      type: "template",
      template: {
        name: templateName,
        language: { code: language },
        components: [{
          type: "body",
          parameters: [
            { type: "text", text: inquiry.full_name },
            { type: "text", text: inquiry.email },
            { type: "text", text: inquiry.business_type },
            { type: "text", text: formatDate(inquiry.appointment_date) }
          ]
        }]
      }
    })
  });

  if (!response.ok) {
    throw new Error(`WhatsApp provider rejected the notification (${response.status}).`);
  }
}

export async function handler(event) {
  if (event.httpMethod === "OPTIONS") {
    return jsonResponse(204, {});
  }

  if (event.httpMethod === "GET") {
    const from = new URL(event.rawUrl).searchParams.get("from");
    if (!isValidDate(from)) {
      return jsonResponse(400, { error: "A valid start date is required." });
    }

    try {
      const query = new URLSearchParams({
        select: "appointment_date",
        status: "eq.confirmed",
        appointment_date: `gte.${from}`,
        order: "appointment_date.asc"
      });
      const records = await supabaseRequest(`appointment_inquiries?${query}`);
      return jsonResponse(200, {
        confirmedDates: records.map(({ appointment_date }) => appointment_date)
      });
    } catch (error) {
      console.error("Appointment availability lookup failed:", error.message);
      return jsonResponse(503, { error: "Appointment availability is temporarily unavailable." });
    }
  }

  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { error: "Method not allowed." });
  }

  let body;
  try {
    body = JSON.parse(event.body || "");
  } catch {
    return jsonResponse(400, { error: "Request body must be valid JSON." });
  }

  const validationError = validateInquiry(body);
  if (validationError) {
    return jsonResponse(400, { error: validationError });
  }

  const inquiry = {
    full_name: body.fullName.trim(),
    email: body.email.trim(),
    phone_number: body.phoneNumber.trim(),
    business_type: body.businessType.trim(),
    appointment_date: body.appointmentDate
  };

  try {
    if (await isDateConfirmed(inquiry.appointment_date)) {
      return jsonResponse(409, { error: "That date has already been confirmed. Please choose another date." });
    }

    const records = await supabaseRequest("appointment_inquiries", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify(inquiry)
    });
    const savedInquiry = records[0];

    const [emailResult, whatsappResult] = await Promise.allSettled([
      sendEmailNotification(savedInquiry),
      sendWhatsAppNotification(savedInquiry)
    ]);
    const notifications = {
      email: emailResult.status === "fulfilled",
      whatsapp: whatsappResult.status === "fulfilled"
    };

    for (const result of [emailResult, whatsappResult]) {
      if (result.status === "rejected") {
        console.error("Appointment notification failed:", result.reason.message);
      }
    }

    return jsonResponse(201, {
      inquiryId: savedInquiry.id,
      notifications
    });
  } catch (error) {
    console.error("Appointment inquiry could not be saved:", error.message);
    return jsonResponse(503, { error: "Your inquiry could not be saved. Please try again later." });
  }
}
